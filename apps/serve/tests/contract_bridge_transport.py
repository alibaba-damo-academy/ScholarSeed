"""Long acquisition responses survive the ordinary bridge read timeout."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import socketserver
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import httpx
from pydantic import ValidationError

from service.capabilities.domain import SkillAdmission
from service.chat.runtime.tools import execute_service_tool
from service.cli.bridge import execute
from service.platform import channel
from service.platform.bridge import (
    BRIDGE_CALLBACK_REQUEST_HEADER,
    BRIDGE_CALLBACK_TURN_HEADER,
    BRIDGE_REQUESTS,
)
from service.platform.channel import BridgeResponseError
from service.platform.vocabulary import (
    BRIDGE_SESSION_ENV,
    BRIDGE_SESSION_HEADER,
    BRIDGE_SOCKET_ENV,
    BRIDGE_TOKEN_ENV,
    BRIDGE_TOKEN_HEADER,
    INTERNAL_BASE_URL_ENV,
)


@contextmanager
def slow_backend(status=200, payload=None, received_requests=None):
    body = json.dumps(payload or {"ok": True, "completed": True}).encode()
    received_headers = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            received_headers.append(dict(self.headers))
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if received_requests is not None:
                received_requests.append(request)
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
                patch("service.platform.channel.BRIDGE_TIMEOUT_SECONDS", 0.1),
                patch("service.chat.runtime.tools.BRIDGE_TIMEOUT_SECONDS", 0.1),
            ):
                yield received_headers
        finally:
            server.shutdown()
            worker.join()


class BridgeTransportContract(unittest.TestCase):
    def test_existing_native_threads_keep_the_published_get_write_envelope(self):
        received = []
        write = {
            "operation": "create",
            "plan_id": "plan",
            "expected_revision": 0,
            "turn_id": "turn",
            "request_id": "request",
            "items": [{"id": "leaf", "content": "work", "status": "pending"}],
        }
        with (
            slow_backend(received_requests=received),
            patch("service.chat.runtime.tools.BRIDGE_TIMEOUT_SECONDS", 1),
        ):
            for operation, request in (("get", {}), ("write", write)):
                result = asyncio.run(
                    execute_service_tool(
                        {"operation": operation, "request": request},
                        session_id="transport-test",
                        token="transport-test",
                        local_socket=None,
                        tool_name="update_plan",
                    )
                )
                self.assertTrue(result["ok"], result)
                self.assertEqual(received[-1], request)

    def test_flat_plan_mutations_keep_explicit_identity_and_existing_transport_payload(self):
        metadata = {
            "plan_id": "review",
            "expected_revision": 1,
            "request_id": "request",
            "turn_id": "turn",
        }
        requests = []
        with (
            slow_backend(received_requests=requests),
            patch("service.chat.runtime.tools.BRIDGE_TIMEOUT_SECONDS", 1),
        ):
            for operation in (
                "create",
                "update",
                "revise",
                "release",
                "start",
                "finish",
                "pause",
                "block",
                "fail",
                "partial",
            ):
                execution = operation in ("start", "finish", "pause", "block", "fail", "partial")
                data = (
                    {"step_ids": ["leaf"]}
                    if execution
                    else {
                        "items": [{"id": "leaf", "content": "work"}],
                        "reason": "real structure change",
                    }
                )
                result = asyncio.run(
                    execute_service_tool(
                        {"operation": operation, **metadata, **data},
                        session_id="transport-test",
                        token="transport-test",
                        local_socket=None,
                        tool_name="update_plan",
                    )
                )
                self.assertTrue(result["ok"], result)
                expected = {**metadata, **data}
                expected["action" if execution else "operation"] = operation
                self.assertEqual(requests[-1], expected)

    def test_shared_channel_rejects_missing_context_and_insecure_addresses(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            self.assertRaisesRegex(ValueError, "context_unavailable"),
        ):
            channel.request("/test", {})
        for address in (
            "http://remote.example",
            "https://user:password@example.com",
            "https://example.com?secret=1",
            "https://example.com#fragment",
        ):
            with (
                self.subTest(address=address),
                patch.dict(
                    os.environ,
                    {
                        INTERNAL_BASE_URL_ENV: address,
                        BRIDGE_TOKEN_ENV: "token",
                        BRIDGE_SESSION_ENV: "session",
                        BRIDGE_SOCKET_ENV: "",
                    },
                    clear=True,
                ),
                patch.object(httpx, "Client") as client,
            ):
                with self.assertRaises(ValueError):
                    channel.request("/test", {})
                client.assert_not_called()

    def test_shared_channel_preserves_raw_limit_and_strict_request_validation(self):
        with self.assertRaisesRegex(ValueError, "request_too_large"):
            channel.decode("x" * (channel.BRIDGE_MAX_REQUEST_BYTES + 1), SkillAdmission)
        for payload in ({"path": 1}, {"path": ""}, {"path": "script.py", "caller": "other"}):
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                channel.decode(json.dumps(payload), SkillAdmission)

    def test_shared_channel_preserves_response_limits_json_and_error_payload(self):
        for body, status, error_type in (
            (b"[]", 200, ValueError),
            (b"not json", 200, ValueError),
            (b"x" * (channel.BRIDGE_MAX_RESPONSE_BYTES + 1), 200, ValueError),
            (b'{"ok":false,"error":"denied"}', 403, BridgeResponseError),
        ):
            with self.subTest(body_size=len(body), status=status):
                client = httpx.Client(
                    transport=httpx.MockTransport(
                        lambda request: httpx.Response(status, content=body)
                    )
                )
                with (
                    patch.dict(
                        os.environ,
                        {
                            INTERNAL_BASE_URL_ENV: "http://127.0.0.1",
                            BRIDGE_TOKEN_ENV: "token",
                            BRIDGE_SESSION_ENV: "session",
                            BRIDGE_SOCKET_ENV: "",
                        },
                        clear=True,
                    ),
                    patch.object(httpx, "Client", return_value=client) as create,
                ):
                    with self.assertRaises(error_type):
                        channel.request("/test", {})
                    self.assertFalse(create.call_args.kwargs["trust_env"])

    @unittest.skipUnless(
        hasattr(socket, "AF_UNIX") and os.name != "nt", "Unix domain sockets require POSIX"
    )
    def test_shared_channel_uses_real_unix_socket_and_scoped_headers(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append((self.path, dict(self.headers)))
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *_args):
                pass

        with tempfile.TemporaryDirectory() as directory:
            endpoint = str(Path(directory) / "bridge.sock")
            with socketserver.UnixStreamServer(endpoint, Handler) as server:
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                try:
                    with patch.dict(
                        os.environ,
                        {
                            INTERNAL_BASE_URL_ENV: "",
                            BRIDGE_TOKEN_ENV: "token",
                            BRIDGE_SESSION_ENV: "session",
                            BRIDGE_SOCKET_ENV: endpoint,
                        },
                        clear=True,
                    ):
                        self.assertTrue(channel.request("/test", {})["ok"])
                finally:
                    server.shutdown()
                    worker.join()
        self.assertEqual(requests[0][0], "/test")
        self.assertEqual(requests[0][1][BRIDGE_SESSION_HEADER], "session")
        self.assertEqual(requests[0][1][BRIDGE_TOKEN_HEADER], "token")

    def test_plan_alias_uses_the_same_authenticated_product_transport(self):
        requests = []
        with (
            slow_backend(received_requests=requests) as received,
            patch("service.chat.runtime.tools.BRIDGE_TIMEOUT_SECONDS", 1),
        ):
            result = asyncio.run(
                execute_service_tool(
                    {"operation": "get"},
                    session_id="transport-test",
                    token="transport-test",
                    local_socket=None,
                    callback_request_id="plan-call",
                    callback_turn_id="turn",
                    tool_name="update_plan",
                )
            )
        self.assertTrue(result["ok"], result)
        self.assertEqual(requests, [{}])
        self.assertEqual(received[0][BRIDGE_SESSION_HEADER], "transport-test")
        self.assertEqual(received[0][BRIDGE_TOKEN_HEADER], "transport-test")
        denied = asyncio.run(
            execute_service_tool(
                {"capability": "resource", "operation": "get", "request": {}},
                session_id="transport-test",
                token="transport-test",
                local_socket=None,
                tool_name="update_plan",
            )
        )
        self.assertFalse(denied["ok"])

    def test_skill_management_transport_always_sends_callback_identity(self):
        requests = {
            "search": {"query": "diagram"},
            "detail": {"slug": "diagram", "version": "1.0.0"},
            "list": {},
            "document": {"name": "diagram"},
            "install": {"slug": "diagram", "version": "1.0.0", "client_op_id": "install"},
            "enable": {"name": "diagram", "client_op_id": "enable"},
            "disable": {"name": "diagram", "client_op_id": "disable"},
            "update": {
                "name": "diagram",
                "version": "2.0.0",
                "expected_version": "1.0.0",
                "client_op_id": "update",
            },
            "delete": {"name": "diagram", "client_op_id": "delete"},
        }
        with (
            slow_backend() as received,
            patch("service.chat.runtime.tools.BRIDGE_TIMEOUT_SECONDS", 1),
        ):
            for operation, body in requests.items():
                result = asyncio.run(
                    execute_service_tool(
                        {"capability": "skill", "operation": operation, "request": body},
                        session_id="transport-test",
                        token="transport-test",
                        local_socket=None,
                        callback_request_id="skill-call",
                        callback_turn_id="native-turn",
                    )
                )
                self.assertTrue(result["ok"], result)
        self.assertEqual(len(received), len(requests))
        for headers in received:
            self.assertEqual(headers[BRIDGE_CALLBACK_REQUEST_HEADER], "skill-call")
            self.assertEqual(headers[BRIDGE_CALLBACK_TURN_HEADER], "native-turn")

    def test_mcp_stdio_json_arguments_reach_backend(self):
        received_requests = []
        request = {
            "expected_revision": 0,
            "mutation": {
                "operation": "upsert",
                "server": {
                    "id": "stdio-probe",
                    "transport": "stdio",
                    "command": "python",
                    "args": ["probe.py", "--label", "with spaces"],
                },
            },
            "intent": "Register local test service",
        }
        with (
            slow_backend(received_requests=received_requests),
            patch("service.chat.runtime.tools.BRIDGE_TIMEOUT_SECONDS", 1),
        ):
            result = asyncio.run(
                execute_service_tool(
                    {"capability": "mcp", "operation": "plan", "request": request},
                    session_id="transport-test",
                    token="transport-test",
                    local_socket=None,
                    callback_request_id="callback",
                    callback_turn_id="turn",
                )
            )
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(received_requests), 1)
        self.assertEqual(
            received_requests[0]["mutation"]["server"]["args"],
            request["mutation"]["server"]["args"],
        )

    def test_registered_context_policy_controls_callback_headers(self):
        operation = ("literature", "ingest")
        original = BRIDGE_REQUESTS[operation]
        for required in (False, True):
            with (
                self.subTest(required=required),
                patch.dict(
                    BRIDGE_REQUESTS,
                    {operation: replace(original, requires_turn_context=required)},
                ),
                slow_backend() as received,
            ):
                result = asyncio.run(
                    execute_service_tool(
                        {
                            "capability": "literature",
                            "operation": "ingest",
                            "request": {"run": "run"},
                        },
                        session_id="transport-test",
                        token="transport-test",
                        local_socket=None,
                        callback_request_id="callback",
                        callback_turn_id="turn",
                    )
                )
                self.assertTrue(result["ok"])
                self.assertEqual(len(received), 1)
                self.assertEqual(BRIDGE_CALLBACK_REQUEST_HEADER in received[0], required)
                self.assertEqual(BRIDGE_CALLBACK_TURN_HEADER in received[0], required)

    def test_ingest_waits_for_completion_in_both_transports(self):
        with slow_backend():
            self.assertTrue(execute("literature", "ingest", json.dumps({"run": "run"}))["ok"])
            self.assertTrue(self.service_tool("ingest")["ok"])

    def test_ingest_preserves_backend_rejection_in_both_transports(self):
        denial = {"ok": False, "error": "download_ingest_failed"}
        with slow_backend(400, denial):
            with self.assertRaises(BridgeResponseError) as failure:
                execute("literature", "ingest", json.dumps({"run": "run"}))
            self.assertEqual(failure.exception.payload, denial)
            self.assertEqual(self.service_tool("ingest"), denial)

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

    def test_fulltext_authorization_waits_for_decisions_in_both_transports(self):
        request = {
            "authorization_type": "precise_search_fulltext",
            "refs": ["literature:paper"],
        }
        for disposition in ("authorized", "rejected", "cancelled"):
            decision = {
                "ok": True,
                "disposition": disposition,
                "granted_refs": request["refs"] if disposition == "authorized" else [],
            }
            for transport in ("cli", "model"):
                with (
                    self.subTest(disposition=disposition, transport=transport),
                    slow_backend(payload=decision),
                ):
                    if transport == "cli":
                        result = execute("literature", "authorize", json.dumps(request))
                    else:
                        result = asyncio.run(
                            execute_service_tool(
                                {
                                    "capability": "literature",
                                    "operation": "authorize",
                                    "request": request,
                                },
                                session_id="transport-test",
                                token="transport-test",
                                local_socket=None,
                                callback_request_id="authorization-call",
                                callback_turn_id="turn",
                            )
                        )
                    self.assertEqual(result, decision)

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
