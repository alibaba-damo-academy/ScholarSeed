"""Long acquisition responses survive the ordinary bridge read timeout."""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import httpx

from service.chat.runtime.tools import execute_service_tool
from service.cli.bridge import BridgeResponseError, execute
from service.platform.bridge import (
    BRIDGE_SESSION_ENV,
    BRIDGE_SOCKET_ENV,
    BRIDGE_TOKEN_ENV,
    INTERNAL_BASE_URL_ENV,
)


@contextmanager
def slow_backend(status=200, payload=None):
    body = json.dumps(payload or {"ok": True, "completed": True}).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            time.sleep(0.3)
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except ConnectionError:
                pass  # The ordinary-operation test deliberately times out.

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with (
                patch.dict(
                    os.environ,
                    {
                        INTERNAL_BASE_URL_ENV: f"http://127.0.0.1:{server.server_port}",
                        BRIDGE_SESSION_ENV: "transport-test",
                        BRIDGE_TOKEN_ENV: "transport-test",
                        BRIDGE_SOCKET_ENV: "",
                    },
                ),
                patch("service.cli.bridge.BRIDGE_TIMEOUT_SECONDS", 0.1),
                patch("service.chat.runtime.tools.BRIDGE_TIMEOUT_SECONDS", 0.1),
            ):
                yield
        finally:
            server.shutdown()
            worker.join()


class BridgeTransportContract(unittest.TestCase):
    def test_outline_confirmation_waits_in_both_transports(self):
        request = {"workspace": "survey", "checkpoint": "outline"}
        with slow_backend():
            self.assertTrue(execute("literature", "review", json.dumps(request))["ok"])
            result = asyncio.run(
                execute_service_tool(
                    {"capability": "literature", "operation": "review", "request": request},
                    session_id="transport-test",
                    token="transport-test",
                    local_socket=None,
                )
            )
            self.assertTrue(result["ok"])

    def acquire(self):
        return execute(
            "literature",
            "acquire",
            json.dumps(
                {
                    "run": "run",
                    "papers": [
                        {
                            "paper_id": "1",
                            "identifier": "1706.03762",
                            "identifier_kind": "arxiv",
                        }
                    ],
                }
            ),
        )

    def service_tool(self, operation):
        request = {"run": "run"}
        if operation == "acquire":
            request["papers"] = [
                {"paper_id": "1", "identifier": "1706.03762", "identifier_kind": "arxiv"}
            ]
        return asyncio.run(
            execute_service_tool(
                {"capability": "literature", "operation": operation, "request": request},
                session_id="transport-test",
                token="transport-test",
                local_socket=None,
            )
        )

    def test_service_tool_acquisition_waits_for_completion(self):
        with slow_backend():
            self.assertEqual(self.service_tool("acquire"), {"ok": True, "completed": True})

    def test_service_tool_ordinary_receipt_keeps_timeout(self):
        with slow_backend():
            self.assertEqual(
                self.service_tool("receipt"), {"ok": False, "error": "bridge_transport_failed"}
            )

    def test_service_tool_preserves_backend_rejection(self):
        denial = {"ok": False, "error": "fulltext_authorization_required"}
        with slow_backend(400, denial):
            self.assertEqual(self.service_tool("acquire"), denial)

    def test_acquisition_waits_for_backend_completion(self):
        with slow_backend():
            self.assertEqual(self.acquire(), {"ok": True, "completed": True})

    def test_ordinary_receipt_keeps_read_timeout(self):
        with slow_backend():
            with self.assertRaises(httpx.ReadTimeout):
                execute("literature", "receipt", json.dumps({"run": "run"}))

    def test_acquisition_preserves_backend_rejection(self):
        denial = {"ok": False, "error": "fulltext_authorization_required"}
        with slow_backend(400, denial):
            with self.assertRaises(BridgeResponseError) as failure:
                self.acquire()
            self.assertEqual(failure.exception.payload, denial)


if __name__ == "__main__":
    unittest.main()
