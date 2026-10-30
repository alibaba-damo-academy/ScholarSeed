"""Diagnostic exports and feedback threads outlive cancelled HTTP waiters."""

from __future__ import annotations

import asyncio
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

import httpx

from service.chat.api.diagnostics import mount_diagnostic_routes
from service.chat.api.feedback import mount_feedback_routes
from service.chat.service.diagnostics import DiagnosticService
from service.chat.service.feedback import FeedbackResult
from service.identity.service.skill_credentials import SKILL_API_KEY_ENV, SkillCredentialService
from service.platform.activity import Activities, MaintenanceActive
from service.platform.http_activity import ServeApplication


async def eventually(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0.005)


class DiagnosticDrainContract(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_credential_issuance_reconciles_before_releasing_lock(self):
        for revoked in (False, True):
            with self.subTest(revoked=revoked):
                gate = Activities()
                started, release = threading.Event(), threading.Event()

                def issue(request, started=started, release=release):
                    started.set()
                    release.wait(5)
                    return httpx.Response(200, json={"token": "ssk-contract"})

                with httpx.Client(transport=httpx.MockTransport(issue)) as client:
                    service = SkillCredentialService(
                        "http://account.test", activities=gate, client=client, environ={}
                    )
                    service.bind_identity(lambda _: {"user_id": "owner"}, lambda _: "credential")
                    pending = asyncio.create_task(service.environment("owner", "credential"))
                    await eventually(started.is_set)
                    generation = gate.begin()
                    try:
                        pending.cancel()
                        await asyncio.sleep(0.01)
                        self.assertFalse(pending.done())
                        self.assertTrue(service._lock.locked())
                        self.assertFalse(gate.seal(generation))
                        with self.assertRaises(MaintenanceActive):
                            await service.refresh("owner", "credential")
                        if revoked:
                            service.forget("owner")
                    finally:
                        release.set()
                        with self.assertRaises(asyncio.CancelledError):
                            await asyncio.wait_for(pending, 2)
                    self.assertFalse(service._lock.locked())
                    self.assertEqual(
                        service.cached_environment("owner"),
                        {} if revoked else {SKILL_API_KEY_ENV: "ssk-contract"},
                    )
                    self.assertTrue(gate.seal(generation))

    async def test_cancelled_feedback_waiter_retains_real_upload_thread(self):
        gate = Activities()
        app = ServeApplication(activities=gate)
        app.state.auth_enabled = False
        app.state.ownership_axis = "machine"
        started, release = threading.Event(), threading.Event()
        credentials_called = []

        async def credentials(owner, token):
            credentials_called.append(owner)
            return {}

        with tempfile.TemporaryDirectory(prefix="feedback-drain-") as home:
            receipt = Path(home) / "receipt.txt"

            def submit(submission):
                started.set()
                release.wait(5)
                receipt.write_text(submission.description, encoding="utf-8")
                return FeedbackResult(ok=True, feedback_id="contract")

            mount_feedback_routes(
                app,
                activities=gate,
                feedback=SimpleNamespace(submit=submit),
                catalog=SimpleNamespace(get=lambda _: None),
                credentials=SimpleNamespace(ensure=credentials),
            )
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://test"
            ) as client:
                pending = asyncio.create_task(
                    client.post("/api/serve/feedback", data={"description": "first request"})
                )
                await eventually(started.is_set)
                generation = gate.begin()
                try:
                    refused = await client.post(
                        "/api/serve/feedback", data={"description": "new request"}
                    )
                    self.assertEqual(refused.status_code, 503)
                    self.assertEqual(refused.json()["detail"], "update_maintenance")
                    self.assertEqual(len(credentials_called), 1)
                    pending.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await pending
                    self.assertFalse(gate.seal(generation))
                    self.assertFalse(receipt.exists())
                finally:
                    release.set()
                    await eventually(lambda: not gate.snapshot().counts)
                self.assertEqual(receipt.read_text(encoding="utf-8"), "first request")
                self.assertTrue(gate.seal(generation))

    async def test_cancelled_policy_read_retains_diagnostic_thread(self):
        gate = Activities()
        app = ServeApplication(activities=gate)
        app.state.auth_enabled = False
        app.state.ownership_axis = "machine"
        started, release = threading.Event(), threading.Event()

        def require(session, principal):
            started.set()
            release.wait(5)
            return SimpleNamespace(payload=lambda: {"mode": "metadata"})

        service = DiagnosticService(SimpleNamespace(require=require), activities=gate)
        mount_diagnostic_routes(app, service)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            pending = asyncio.create_task(
                client.get("/api/serve/sessions/session/diagnostic-policy")
            )
            await eventually(started.is_set)
            generation = gate.begin()
            try:
                refused = await client.get("/api/serve/sessions/session/diagnostics/preview")
                self.assertEqual(refused.status_code, 503)
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
                self.assertFalse(gate.seal(generation))
            finally:
                release.set()
                await eventually(lambda: not gate.snapshot().counts)
            self.assertTrue(gate.seal(generation))

    async def test_expiry_waits_for_resume_and_retains_cancelled_worker(self):
        gate = Activities()
        service = DiagnosticService(SimpleNamespace(), activities=gate)
        started, release = threading.Event(), threading.Event()

        def expire(active):
            started.set()
            release.wait(5)

        service.expire = expire
        generation = gate.begin()
        maintenance = asyncio.create_task(service.maintain(set))
        await asyncio.sleep(0.02)
        self.assertFalse(started.is_set())
        gate.resume(generation)
        await eventually(started.is_set)
        generation = gate.begin()
        try:
            maintenance.cancel()
            await asyncio.sleep(0.02)
            self.assertFalse(maintenance.done(), "maintenance abandoned its running worker")
            maintenance.cancel()
            await asyncio.sleep(0.02)
            self.assertFalse(maintenance.done(), "repeated cancellation abandoned the worker")
            self.assertFalse(gate.seal(generation))
        finally:
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await maintenance
            await eventually(lambda: not gate.snapshot().counts)
        self.assertTrue(gate.seal(generation))


if __name__ == "__main__":
    unittest.main()
