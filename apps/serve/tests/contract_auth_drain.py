"""Cancelled identity requests retain the real synchronous HTTP worker barrier."""

from __future__ import annotations

import asyncio
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
from fastapi import Depends

from service.identity.api.routes import _request_identity, register_auth
from service.identity.service.auth import AuthService
from service.platform.activity import Activities, ActivityDomain, MaintenanceActive
from service.platform.http_activity import ServeApplication, execution_admission


class AuthDrainContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.activities = Activities()
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        self.block_call = 1
        self.business_called = False
        self.inspection_rejected_business = False
        self.inspection_inherited_activity = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                fixture.calls += 1
                if fixture.calls == fixture.block_call:
                    fixture.started.set()
                    if not fixture.release.wait(6):
                        raise TimeoutError("test did not release identity response")
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.http = httpx.Client(timeout=8, trust_env=False)

        class Identity(AuthService):
            def identity(self, credential):
                fixture.http.get(f"http://127.0.0.1:{fixture.server.server_port}")
                if fixture.started.is_set():
                    try:
                        with fixture.activities.enter(ActivityDomain.IMPORT, root=True):
                            pass
                    except MaintenanceActive:
                        fixture.inspection_rejected_business = True
                    try:
                        with fixture.activities.enter(ActivityDomain.IMPORT):
                            fixture.inspection_inherited_activity = True
                    except MaintenanceActive:
                        pass
                return {"user_id": "fixture-user", "email": "fixture@example.test"}

            def logout(self, credential):
                return True

        self.identity = Identity(providers=())
        self.app = ServeApplication(activities=self.activities)

        @self.app.get(
            "/api/probe",
            dependencies=[Depends(execution_admission(self.activities, ActivityDomain.ACTION))],
        )
        async def probe():
            self.business_called = True
            return {"ok": True}

        register_auth(self.app, activities=self.activities, enabled=True, service=self.identity)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://fixture"
        )

    async def asyncTearDown(self) -> None:
        self.release.set()
        await self.wait_for(lambda: not self.activities.snapshot().counts)
        await self.client.aclose()
        self.http.close()
        await asyncio.to_thread(self.server.shutdown)
        self.server.server_close()
        self.server_thread.join(2)
        self.assertFalse(self.server_thread.is_alive())

    async def wait_for(self, predicate) -> None:
        async with asyncio.timeout(5):
            while not predicate():
                await asyncio.sleep(0.01)

    async def cancelled_inspection(self, method: str, path: str, block_call: int) -> None:
        self.block_call = block_call
        task = asyncio.create_task(
            self.client.request(method, path, headers={"Authorization": "Bearer fixture"})
        )
        try:
            await self.wait_for(self.started.is_set)
            generation = self.activities.begin()
            task.cancel()
            await asyncio.sleep(0.01)
            task.cancel()
            await asyncio.sleep(0.01)
            self.assertFalse(self.activities.seal(generation))
            self.assertGreaterEqual(self.activities.snapshot().counts.get("request", 0), 1)
        finally:
            self.release.set()
            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 5)
        await self.wait_for(lambda: not self.activities.snapshot().counts)
        self.assertTrue(self.inspection_rejected_business)
        self.assertEqual(self.inspection_inherited_activity, path == "/api/auth/logout")
        self.assertFalse(self.business_called)
        self.assertTrue(self.activities.seal(generation))

    async def test_middleware_cancellation_keeps_identity_worker_counted(self) -> None:
        await self.cancelled_inspection("GET", "/api/probe", 1)

    async def test_me_cancellation_keeps_endpoint_identity_worker_counted(self) -> None:
        await self.cancelled_inspection("GET", "/api/auth/me", 2)

    async def test_logout_cancellation_keeps_endpoint_identity_worker_counted(self) -> None:
        await self.cancelled_inspection("POST", "/api/auth/logout", 2)

    async def test_drain_allows_identity_but_rejects_new_business(self) -> None:
        generation = self.activities.begin()
        self.release.set()
        response = await self.client.get("/api/probe", headers={"Authorization": "Bearer fixture"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": "update_maintenance"})
        self.assertEqual(self.calls, 1)
        self.assertTrue(self.inspection_rejected_business)
        self.assertFalse(self.business_called)
        self.assertTrue(self.activities.seal(generation))

    async def test_worker_dispatched_after_seal_cannot_start_identity(self) -> None:
        generation = self.activities.begin()
        self.assertTrue(self.activities.seal(generation))
        with self.assertRaises(MaintenanceActive):
            await asyncio.to_thread(_request_identity, self.identity, "fixture", self.activities)
        self.assertEqual(self.calls, 0)


if __name__ == "__main__":
    unittest.main()
