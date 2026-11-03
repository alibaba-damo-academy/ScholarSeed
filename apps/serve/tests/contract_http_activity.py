"""HTTP transport barriers with real ASGI streaming and cleanup lifetimes."""

from __future__ import annotations

import asyncio
import unittest

from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse

from service.platform.activity import Activities, ActivityDomain, MaintenanceActive
from service.platform.http_activity import HttpActivityMiddleware, ServeApplication

HTTP_SCOPE = {"type": "http", "method": "GET", "path": "/stream", "asgi": {"spec_version": "2.4"}}


async def receive():
    await asyncio.Future()


class HttpActivityContract(unittest.IsolatedAsyncioTestCase):
    async def test_candidate_rejects_mutations_but_restores_readonly_navigation(self):
        ready = False
        gate = Activities(workbench_ready=lambda: ready)
        calls = []

        async def endpoint(scope, _receive, send):
            calls.append(scope["method"])
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"metadata"})

        app = HttpActivityMiddleware(endpoint, activities=gate)
        messages = []

        async def send(message):
            messages.append(message)

        for method in ("POST", "PATCH", "DELETE"):
            messages.clear()
            await app({**HTTP_SCOPE, "method": method}, receive, send)
            self.assertEqual(messages[0]["status"], 503)
        self.assertEqual(calls, [])
        await app(HTTP_SCOPE, receive, send)
        self.assertEqual(calls, ["GET"])
        ready = True
        await app({**HTTP_SCOPE, "method": "POST"}, receive, send)
        self.assertEqual(calls, ["GET", "POST"])

    async def test_framework_error_response_is_counted_until_sent(self) -> None:
        gate = Activities()
        app = ServeApplication(activities=gate)
        sending, release = asyncio.Event(), asyncio.Event()
        messages = []

        @app.get("/failure")
        async def failure():
            raise ValueError("endpoint failure")

        async def send(message):
            messages.append(message)
            if message["type"] == "http.response.body":
                sending.set()
                await release.wait()

        scope = {
            **HTTP_SCOPE,
            "path": "/failure",
            "query_string": b"",
            "headers": [],
            "scheme": "http",
            "server": ("localhost", 80),
        }
        task = asyncio.create_task(app(scope, receive, send))
        try:
            await asyncio.wait_for(sending.wait(), 2)
            generation = gate.begin()
            self.assertEqual(messages[0]["status"], 500)
            self.assertFalse(gate.seal(generation))
        finally:
            release.set()
            results = await asyncio.gather(task, return_exceptions=True)
        self.assertIsInstance(results[0], ValueError)
        self.assertTrue(gate.seal(generation))

    async def test_headers_last_body_and_background_cleanup_all_hold_the_barrier(self) -> None:
        gate = Activities()
        headers, final_body, cleanup = asyncio.Event(), asyncio.Event(), asyncio.Event()
        allow_body, allow_cleanup = asyncio.Event(), asyncio.Event()
        messages = []

        async def content():
            yield b"first"
            await allow_body.wait()
            yield b"last"

        async def finish():
            cleanup.set()
            await allow_cleanup.wait()

        response = StreamingResponse(content(), background=BackgroundTask(finish))

        async def send(message):
            messages.append(message)
            if message["type"] == "http.response.start":
                headers.set()
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                final_body.set()

        task = asyncio.create_task(
            HttpActivityMiddleware(response, activities=gate)(HTTP_SCOPE, receive, send)
        )
        try:
            await asyncio.wait_for(headers.wait(), 2)
            generation = gate.begin()
            self.assertEqual(gate.snapshot().counts, {"request": 1})
            self.assertFalse(gate.seal(generation))
            allow_body.set()
            await asyncio.wait_for(final_body.wait(), 2)
            await asyncio.wait_for(cleanup.wait(), 2)
            self.assertFalse(gate.seal(generation))
            allow_cleanup.set()
            await asyncio.wait_for(task, 2)
            self.assertTrue(gate.seal(generation))
            self.assertEqual(b"".join(m.get("body", b"") for m in messages), b"firstlast")
        finally:
            allow_body.set()
            allow_cleanup.set()
            await asyncio.gather(task, return_exceptions=True)

    async def test_blocked_send_keeps_request_active(self) -> None:
        gate = Activities()
        sending, release = asyncio.Event(), asyncio.Event()

        async def content():
            yield b"payload"

        async def send(message):
            if message["type"] == "http.response.body":
                sending.set()
                await release.wait()

        task = asyncio.create_task(
            HttpActivityMiddleware(StreamingResponse(content()), activities=gate)(
                HTTP_SCOPE, receive, send
            )
        )
        try:
            await asyncio.wait_for(sending.wait(), 2)
            generation = gate.begin()
            self.assertFalse(gate.seal(generation))
        finally:
            release.set()
            await asyncio.wait_for(task, 2)
        self.assertTrue(gate.seal(generation))

    async def test_cancellation_keeps_cleanup_active(self) -> None:
        gate = Activities()
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def app(scope, receive, send):
            try:
                entered.set()
                await asyncio.Future()
            finally:
                cleaning.set()
                await release.wait()

        async def send(message):
            pass

        task = asyncio.create_task(
            HttpActivityMiddleware(app, activities=gate)(HTTP_SCOPE, receive, send)
        )
        try:
            await asyncio.wait_for(entered.wait(), 2)
            generation = gate.begin()
            task.cancel()
            await asyncio.wait_for(cleaning.wait(), 2)
            self.assertFalse(gate.seal(generation))
        finally:
            release.set()
            await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(task.cancelled())
        self.assertTrue(gate.seal(generation))

    async def test_request_observation_does_not_authorize_new_work_during_drain(self) -> None:
        gate = Activities()
        parent = gate.enter(ActivityDomain.TURN)
        generation = gate.begin()
        with gate.observe_request():
            with self.assertRaises(MaintenanceActive):
                gate.enter(ActivityDomain.IMPORT)
            with gate.continue_from(parent, ActivityDomain.TURN):
                self.assertEqual(gate.snapshot().counts, {"request": 1, "turn": 2})
            parent.close()
            self.assertFalse(gate.seal(generation))
        self.assertTrue(gate.seal(generation))

    async def test_sealed_instance_rejects_request_without_dispatch(self) -> None:
        gate = Activities()
        generation = gate.begin()
        self.assertTrue(gate.seal(generation))
        messages = []

        async def app(scope, receive, send):
            self.fail("sealed request reached the application")

        async def send(message):
            messages.append(message)

        await HttpActivityMiddleware(app, activities=gate)(HTTP_SCOPE, receive, send)
        self.assertEqual(messages[0]["status"], 503)
        self.assertIn(b"update_maintenance", messages[1]["body"])
        self.assertEqual(gate.snapshot().counts, {})

    async def test_application_failure_is_not_replaced_with_second_response(self) -> None:
        gate = Activities()
        messages = []

        async def app(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            raise MaintenanceActive("operation admission failed")

        async def send(message):
            messages.append(message)

        with self.assertRaisesRegex(MaintenanceActive, "operation admission failed"):
            await HttpActivityMiddleware(app, activities=gate)(HTTP_SCOPE, receive, send)
        self.assertEqual(len(messages), 1)
        self.assertEqual(gate.snapshot().counts, {})

    async def test_non_http_scope_passes_through_without_request_activity(self) -> None:
        gate = Activities()
        generation = gate.begin()
        self.assertTrue(gate.seal(generation))
        calls = []

        async def app(scope, receive, send):
            calls.append(scope["type"])
            self.assertEqual(gate.snapshot().counts, {})

        async def send(message):
            pass

        await HttpActivityMiddleware(app, activities=gate)({"type": "lifespan"}, receive, send)
        self.assertEqual(calls, ["lifespan"])


if __name__ == "__main__":
    unittest.main()
