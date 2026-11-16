"""Discriminate HTTP scheduling, worker waiting and event-loop stalls."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import anyio
import httpx
from starlette.responses import Response

from service.identity.api.routes import _request_identity
from service.platform.activity import Activities
from service.platform.http_activity import HttpActivityMiddleware, ServeApplication
from service.platform.latency import (
    DIAGNOSTIC_HEADER,
    LOGGER_NAME,
    LoopMonitor,
    RequestLatency,
    requestLatency,
)


class LatencyContract(unittest.IsolatedAsyncioTestCase):
    async def test_valid_correlations_retain_the_lifecycle_without_global_debug(self):
        scope = self.scope()
        scope["headers"].append((DIAGNOSTIC_HEADER, b"a" * 32))
        with self.assertLogs(LOGGER_NAME, level=logging.INFO) as records:
            with RequestLatency(scope) as observation:
                observation.headers(200)
        rows = [json.loads(record.getMessage()) for record in records.records]
        self.assertEqual([row["event"] for row in rows], ["received", "headers", "finished"])
        self.assertTrue(all(row["client_request_id"] == "a" * 32 for row in rows))
        self.assertTrue(all(record.levelno == logging.INFO for record in records.records))
        for secret in ("/private/secret-session", "private-token", "private-credential"):
            self.assertNotIn(secret, json.dumps(rows))

    async def test_invalid_correlations_do_not_enable_info_observation(self):
        scope = self.scope()
        scope["headers"].append((DIAGNOSTIC_HEADER, b"private-invalid-id"))
        with self.assertNoLogs(LOGGER_NAME, level=logging.INFO):
            with RequestLatency(scope) as observation:
                observation.headers(200)

    def scope(self):
        return {
            "type": "http",
            "method": "GET",
            "path": "/private/secret-session",
            "query_string": b"token=private-token",
            "headers": [(b"authorization", b"Bearer private-credential")],
            "route": SimpleNamespace(path="/private/{session_id}"),
        }

    async def test_middleware_records_safe_entry_and_response_without_changing_messages(self):
        scope = self.scope()
        sent = []
        expected = [
            {"type": "http.response.start", "status": 204, "headers": []},
            {"type": "http.response.body", "body": b""},
        ]

        async def endpoint(current, receive, send):
            self.assertIsNotNone(requestLatency(current))
            for message in expected:
                await send(message)

        async def receive():
            return {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)

        with self.assertLogs(LOGGER_NAME, level=logging.DEBUG) as records:
            await HttpActivityMiddleware(endpoint, activities=Activities())(scope, receive, send)
        rows = [json.loads(record.getMessage()) for record in records.records]
        self.assertEqual(sent, expected)
        self.assertEqual([row["event"] for row in rows], ["received", "headers", "finished"])
        self.assertEqual(rows[1]["route"], "/private/{session_id}")
        self.assertEqual(rows[1]["status"], 204)
        self.assertNotIn("secret-session", " ".join(records.output))
        self.assertNotIn("private-token", " ".join(records.output))
        self.assertNotIn("private-credential", " ".join(records.output))
        self.assertFalse(requestLatency(scope).active)

    async def test_worker_congestion_is_waiting_not_identity_execution_or_loop_stall(self):
        limiter = anyio.to_thread.current_default_thread_limiter()
        original = limiter.total_tokens
        limiter.total_tokens = 1
        occupied, release = asyncio.Event(), asyncio.Event()

        async def hold():
            async with limiter:
                occupied.set()
                await release.wait()

        holder = asyncio.create_task(hold())
        await occupied.wait()
        observation = RequestLatency(self.scope(), interval=0.005, loopThreshold=0.05)
        sampled = asyncio.Event()
        originalTick = observation._tick

        def tick():
            originalTick()
            sampled.set()

        def worker():
            observation.identityStarted()
            observation.identityFinished()

        try:
            with (
                patch.object(observation, "_tick", side_effect=tick),
                self.assertLogs(LOGGER_NAME, level=logging.DEBUG),
            ):
                with observation:
                    observation.identityQueued()
                    pending = asyncio.create_task(anyio.to_thread.run_sync(worker))
                    async with asyncio.timeout(5):
                        while limiter.statistics().tasks_waiting == 0:
                            await asyncio.sleep(0)
                    self.assertFalse(pending.done())
                    sampled.clear()
                    await asyncio.wait_for(sampled.wait(), timeout=5)
                    self.assertGreater(observation.threadWaitersPeak, 0)
                    release.set()
                    await pending
                    self.assertGreaterEqual(observation.identityWaitMs, 0)
                    self.assertGreaterEqual(observation.identityRunMs, 0)
                    self.assertLessEqual(observation.identityWaitMs, observation.identityFinishedMs)
                    self.assertEqual(limiter.statistics().tasks_waiting, 0)
        finally:
            release.set()
            await holder
            limiter.total_tokens = original

    async def test_event_loop_block_is_distinct_from_async_wait(self):
        clock = SimpleNamespace(now=10.0)
        observedTime = SimpleNamespace(perf_counter=lambda: clock.now, time=lambda: clock.now)
        with (
            patch("service.platform.latency.time", observedTime),
            self.assertLogs(LOGGER_NAME, level=logging.DEBUG) as records,
        ):
            with RequestLatency(self.scope(), interval=0.005, loopThreshold=0.02) as blocked:
                clock.now += 0.08
                blocked.headers(200)
            with RequestLatency(self.scope(), interval=0.005, loopThreshold=0.05) as waiting:
                for _ in range(16):
                    clock.now += 0.005
                    waiting.timer.cancel()
                    waiting._tick()
                waiting.headers(200)
        self.assertAlmostEqual(blocked.loopLagMs, 75)
        self.assertAlmostEqual(waiting.loopLagMs, 0)
        self.assertIsNone(blocked.identityWaitMs)
        self.assertTrue(
            any(
                json.loads(record.getMessage())["event"] == "loop_lag" for record in records.records
            )
        )

    async def test_identity_clock_separates_queue_and_execution(self):
        clock = SimpleNamespace(now=10.0)
        observedTime = SimpleNamespace(perf_counter=lambda: clock.now, time=lambda: clock.now)
        with (
            patch("service.platform.latency.time", observedTime),
            self.assertLogs(LOGGER_NAME, level=logging.DEBUG),
        ):
            with RequestLatency(self.scope()) as observation:
                observation.identityQueued()
                clock.now += 0.2
                observation.identityStarted()
                clock.now += 0.04
                observation.identityFinished()
                clock.now += 0.01
                observation.identityResumed()
        self.assertAlmostEqual(observation.identityWaitMs, 200)
        self.assertAlmostEqual(observation.identityRunMs, 40)
        self.assertAlmostEqual(observation.identityFinishedMs, 240)
        self.assertAlmostEqual(observation.identityResumedMs, 250)

    async def test_disabled_observation_never_arms_or_samples_an_expired_deadline(self):
        clock = SimpleNamespace(now=10.0)
        observedTime = SimpleNamespace(perf_counter=lambda: clock.now, time=lambda: clock.now)
        with (
            patch("service.platform.latency.time", observedTime),
            patch("service.platform.latency.uuid4") as identifier,
            patch("service.platform.latency.current_default_thread_limiter") as limiter,
            self.assertLogs(LOGGER_NAME, level=logging.ERROR) as records,
        ):
            with RequestLatency(self.scope()) as observation:
                self.assertIsNone(observation.timer)
                observation.identityQueued()
                observation.identityStarted()
                clock.now += 10
                observation.identityFinished()
                observation.identityResumed()
                observation.headers(200)
            self.assertEqual(observation.loopLagMs, 0)
            self.assertIsNone(observation.identityWaitMs)
            self.assertIsNone(observation.identityRunMs)
            identifier.assert_not_called()
            limiter.assert_not_called()
            logging.getLogger(LOGGER_NAME).error("disabled observation marker")
        self.assertEqual(len(records.records), 1)

    async def test_warning_logging_retains_slow_header_observation(self):
        clock = SimpleNamespace(now=10.0)
        observedTime = SimpleNamespace(perf_counter=lambda: clock.now, time=lambda: clock.now)
        with (
            patch("service.platform.latency.time", observedTime),
            self.assertLogs(LOGGER_NAME, level=logging.WARNING) as records,
        ):
            with RequestLatency(
                self.scope(), interval=0.005, loopThreshold=1, headersThreshold=0.02
            ) as observation:
                self.assertIsNotNone(observation.timer)
                clock.now += 0.04
                observation.headers(200)
        self.assertEqual(len(records.records), 1)
        row = json.loads(records.records[0].getMessage())
        self.assertEqual(row["event"], "headers")
        self.assertEqual(row["loop_sample_ms"], 5)
        self.assertEqual(row["loop_warning_ms"], 1000)
        self.assertEqual(row["headers_warning_ms"], 20)

    async def test_header_and_loop_warning_thresholds_are_independent(self):
        for loopThreshold, headersThreshold, headersLevel, hasLag in (
            (0.02, 0.1, logging.DEBUG, True),
            (0.1, 0.02, logging.WARNING, False),
        ):
            clock = SimpleNamespace(now=10.0)
            observedTime = SimpleNamespace(
                perf_counter=lambda current=clock: current.now,
                time=lambda current=clock: current.now,
            )
            with (
                patch("service.platform.latency.time", observedTime),
                self.assertLogs(LOGGER_NAME, level=logging.DEBUG) as records,
            ):
                with RequestLatency(
                    self.scope(),
                    interval=0.005,
                    loopThreshold=loopThreshold,
                    headersThreshold=headersThreshold,
                ) as observation:
                    clock.now += 0.06
                    observation.headers(200)
            rows = [(json.loads(record.getMessage()), record.levelno) for record in records.records]
            self.assertEqual(
                next(level for row, level in rows if row["event"] == "headers"), headersLevel
            )
            self.assertEqual(any(row["event"] == "loop_lag" for row, _level in rows), hasLag)

    async def test_real_router_distinguishes_pending_from_unmatched(self):
        app = ServeApplication(activities=Activities())

        @app.get("/private/{session_id}")
        async def endpoint(session_id: str):
            return Response(status_code=204)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            for path, route, status in (
                ("/private/secret-session", "/private/{session_id}", 204),
                ("/missing/secret-session", "unmatched", 404),
            ):
                with self.assertLogs(LOGGER_NAME, level=logging.DEBUG) as records:
                    response = await client.get(path)
                rows = [json.loads(record.getMessage()) for record in records.records]
                self.assertEqual(response.status_code, status)
                self.assertIsNone(rows[0]["route"])
                self.assertEqual(rows[-1]["route"], route)
                self.assertNotIn("secret-session", " ".join(records.output))

    async def test_real_identity_worker_records_execution_and_preserves_failure(self):
        class Identity:
            def identity(self, credential):
                time.sleep(0.02)
                raise ValueError("private identity detail")

        with self.assertLogs(LOGGER_NAME, level=logging.DEBUG):
            with RequestLatency(self.scope()) as observation:
                observation.identityQueued()
                with self.assertRaisesRegex(ValueError, "private identity detail"):
                    await anyio.to_thread.run_sync(
                        _request_identity,
                        Identity(),
                        "private credential",
                        Activities(),
                        observation,
                    )
        self.assertIsNotNone(observation.identityWaitMs)
        self.assertGreater(observation.identityRunMs, 15)

    async def test_failure_and_cancellation_stop_observation_and_preserve_exceptions(self):
        for failure in (ValueError("private error text"), asyncio.CancelledError()):
            scope = self.scope()

            async def endpoint(current, receive, send, currentFailure=failure):
                raise currentFailure

            with self.assertLogs(LOGGER_NAME, level=logging.DEBUG) as records:
                with self.assertRaises(type(failure)):
                    await HttpActivityMiddleware(endpoint, activities=Activities())(
                        scope, None, None
                    )
            self.assertFalse(requestLatency(scope).active)
            self.assertNotIn("private error text", " ".join(records.output))
            self.assertEqual(
                json.loads(records.records[-1].getMessage())["error_type"], type(failure).__name__
            )

    async def test_correlation_accepts_only_one_opaque_identifier(self):
        for values, expected in (
            ([b"a" * 32], "a" * 32),
            ([b"private-token"], None),
            ([b"a" * 32, b"b" * 32], None),
        ):
            scope = self.scope()
            scope["headers"].extend((DIAGNOSTIC_HEADER, value) for value in values)
            with self.assertLogs(LOGGER_NAME, level=logging.DEBUG) as records:
                with RequestLatency(scope):
                    pass
            rows = [json.loads(record.getMessage()) for record in records.records]
            self.assertTrue(all(row["client_request_id"] == expected for row in rows))
            self.assertNotIn("private-token", " ".join(records.output))

    async def test_timing_permission_requires_existing_cors_permission_and_diagnostic_id(self):
        for allowed, correlated in ((True, True), (True, False), (False, True)):
            scope = self.scope()
            origin = b"http://127.0.0.1:5173"
            scope["headers"].append((b"origin", origin))
            if correlated:
                scope["headers"].append((DIAGNOSTIC_HEADER, b"a" * 32))
            responseHeaders = [(b"access-control-allow-origin", origin)] if allowed else []
            sent = []

            async def endpoint(current, receive, send, currentHeaders=responseHeaders):
                await send(
                    {"type": "http.response.start", "status": 200, "headers": currentHeaders}
                )
                await send({"type": "http.response.body", "body": b"ok"})

            async def send(message, currentSent=sent):
                currentSent.append(message)

            await HttpActivityMiddleware(endpoint, activities=Activities())(scope, None, send)
            self.assertEqual(
                (b"timing-allow-origin", origin) in sent[0]["headers"], allowed and correlated
            )
            self.assertEqual(sent[1]["body"], b"ok")

    async def test_debug_monitor_observes_stall_without_an_active_request_and_stops(self):
        with self.assertLogs(LOGGER_NAME, level=logging.DEBUG) as records:
            monitor = LoopMonitor(interval=0.005, threshold=0.02)
            async with monitor:
                await asyncio.sleep(0.01)
                time.sleep(0.08)
                await asyncio.sleep(0.01)
                snapshot = monitor.snapshot()
                self.assertIsNotNone(snapshot["loop_stall_id"])
                self.assertGreater(snapshot["process_loop_lag_ms"], 50)
            self.assertFalse(monitor.thread.is_alive())
        rows = [json.loads(record.getMessage()) for record in records.records]
        stalled = next(row for row in rows if row["event"] == "loop_stall")
        self.assertTrue(stalled["stack"])
        self.assertNotIn("/Users/", json.dumps(stalled))
        self.assertTrue(any(row["event"] == "loop_recovered" for row in rows))

    async def test_monitor_is_disabled_without_debug_logging(self):
        with self.assertLogs(LOGGER_NAME, level=logging.WARNING) as records:
            monitor = LoopMonitor()
            async with monitor:
                self.assertIsNone(monitor.thread)
                logging.getLogger(LOGGER_NAME).warning("monitor disabled")
        self.assertEqual(len(records.records), 1)


if __name__ == "__main__":
    unittest.main()
