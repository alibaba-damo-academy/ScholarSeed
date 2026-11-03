"""Account refresh owns its real HTTP thread through cache reconciliation."""

from __future__ import annotations

import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

from service.identity.service.account import REVOCATION_REFRESH_S, AccountTrust
from service.platform.activity import Activities, ActivityDomain


class AccountDrainContract(unittest.TestCase):
    def setUp(self) -> None:
        self.activities = Activities()
        self.now = 1000.0
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        self.status = 200
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                fixture.calls += 1
                if fixture.calls > 1:
                    fixture.started.set()
                    if not fixture.release.wait(5):
                        raise TimeoutError("test did not release account HTTP response")
                data = json.dumps({"revocations": []}).encode()
                self.send_response(fixture.status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.client = httpx.Client(timeout=8, trust_env=False)
        self.trust = AccountTrust(
            f"http://127.0.0.1:{self.server.server_port}",
            activities=self.activities,
            client=self.client,
            clock=lambda: self.now,
        )
        self.assertFalse(self.trust._revoked("fixture-token"))
        self.assertEqual(self.calls, 1)
        self.now += REVOCATION_REFRESH_S

    def tearDown(self) -> None:
        self.release.set()
        self.wait_finished()
        self.client.close()
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(2)
        self.assertFalse(self.server_thread.is_alive())

    def wait_finished(self) -> None:
        deadline = time.monotonic() + 5
        while self.activities.snapshot().counts and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.activities.snapshot().counts, {})

    def test_real_refresh_blocks_seal_until_http_and_cache_finish(self) -> None:
        self.assertFalse(self.trust._revoked("fixture-token"))
        self.assertTrue(self.started.wait(3))
        generation = self.activities.begin()
        self.assertEqual(self.activities.snapshot().counts, {"credential": 1})
        self.assertFalse(self.activities.seal(generation))
        self.assertTrue(self.trust._revocations_inflight)
        self.assertFalse(self.trust._revoked("another-token"))
        self.assertEqual(self.calls, 2)
        self.release.set()
        self.wait_finished()
        self.assertFalse(self.trust._revocations_inflight)
        self.assertEqual(self.trust._revocations_fetched_at, self.now)
        self.assertTrue(self.activities.seal(generation))

    def test_maintenance_defers_refresh_even_with_live_parent_then_resumes(self) -> None:
        fetched_at = self.trust._revocations_fetched_at
        with self.activities.enter(ActivityDomain.CREDENTIAL):
            generation = self.activities.begin()
            self.assertFalse(self.trust._revoked("fixture-token"))
            self.assertFalse(self.trust._revocations_inflight)
            self.assertEqual(self.trust._revocations_fetched_at, fetched_at)
            self.assertEqual(self.calls, 1)
        self.assertTrue(self.activities.seal(generation))
        self.activities.resume(generation)
        self.assertFalse(self.trust._revoked("fixture-token"))
        self.assertTrue(self.started.wait(3))
        self.assertEqual(self.calls, 2)
        self.release.set()
        self.wait_finished()

    def test_start_failure_releases_single_flight_and_allows_retry(self) -> None:
        spawn = self.trust._spawn

        def failed(_target) -> None:
            raise RuntimeError("fixture thread creation failed")

        self.trust._spawn = failed
        with self.assertRaisesRegex(RuntimeError, "fixture thread creation failed"):
            self.trust._revoked("fixture-token")
        self.assertEqual(self.activities.snapshot().counts, {})
        self.assertFalse(self.trust._revocations_inflight)
        self.trust._spawn = spawn
        self.assertFalse(self.trust._revoked("fixture-token"))
        self.assertTrue(self.started.wait(3))
        self.release.set()
        self.wait_finished()

    def test_http_failure_finishes_without_leaking_refresh_ownership(self) -> None:
        self.status = 503
        self.assertFalse(self.trust._revoked("fixture-token"))
        self.assertTrue(self.started.wait(3))
        generation = self.activities.begin()
        self.assertFalse(self.activities.seal(generation))
        self.release.set()
        self.wait_finished()
        self.assertFalse(self.trust._revocations_inflight)
        self.assertTrue(self.activities.seal(generation))


if __name__ == "__main__":
    unittest.main()
