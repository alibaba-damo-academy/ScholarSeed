"""Managed Desktop host capability boundary."""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock, patch

from service.chat.service.browserhost import (
    AGENT_BROWSER_KEY_ENV,
    AGENT_BROWSER_PORT_ENV,
    BrowserHostClient,
)

SCOPE = dict(
    session_id="s",
    instance_id="instance",
    product_turn_id="product",
    turn_id="t",
    generation=1,
    interrupt_generation=0,
    lifecycle_epoch=1,
)


class BrowserHostTransportContracts(unittest.TestCase):
    def test_scope_drain_acknowledgement_can_arrive_after_execution_deadline(self) -> None:
        control_budget_seconds = 0.1
        delivery_delay_seconds = 0.03
        received: list[str] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append(payload["action"])
                ending = payload["action"] == "scope/end"
                if ending:
                    time.sleep(
                        max(0, payload["deadline"] / 1000 - time.time()) + delivery_delay_seconds
                    )
                self.send_response(408 if ending else 200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                try:
                    self.wfile.write(
                        json.dumps(
                            {"ok": False, "error": "scope_unsettled", "phase": "effects"}
                            if ending
                            else {"ok": True, "tabs": []}
                        ).encode()
                    )
                except BrokenPipeError:
                    pass

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for delivery_delay_seconds, confirmed in ((0.03, True), (0.2, False)):
                with self.subTest(confirmed=confirmed):
                    client = BrowserHostClient(server.server_port, "a" * 64)
                    with (
                        patch(
                            "service.chat.service.browserhost.AGENT_BROWSER_TIMEOUT_SECONDS",
                            control_budget_seconds,
                        ),
                        patch(
                            "service.chat.service.browserhost.AGENT_BROWSER_SCOPE_END_TIMEOUT_SECONDS",
                            2 * control_budget_seconds,
                        ),
                    ):
                        result = asyncio.run(client.end_scope(**SCOPE))
                    self.assertEqual(client.available, confirmed)
                    if confirmed:
                        self.assertEqual(
                            result, {"ok": False, "error": "scope_unsettled", "phase": "effects"}
                        )
                        self.assertTrue(
                            asyncio.run(client.list_tabs(**SCOPE, request_id="independent"))["ok"]
                        )
                    else:
                        self.assertEqual(result, {"ok": False, "error": "browser_unavailable"})
            self.assertEqual(received, ["scope/end", "list", "scope/end"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_unavailable_host_diagnostic_excludes_key_and_request_content(self) -> None:
        client = BrowserHostClient(None, "private-transport-key")
        with self.assertLogs("service.chat.service.browserhost", level="WARNING") as captured:
            result = asyncio.run(
                client.search(
                    **SCOPE, request_id="request", query="private-query", engine="bing", limit=1
                )
            )
        self.assertEqual(result, {"ok": False, "error": "browser_unavailable"})
        message = "\n".join(captured.output)
        self.assertIn("action=search", message)
        self.assertIn("configured=False", message)
        self.assertIn("faulted=False", message)
        self.assertNotIn("private-transport-key", message)
        self.assertNotIn("private-query", message)

    def test_end_failure_diagnostic_does_not_record_unknown_error_content(self) -> None:
        client = BrowserHostClient(12345, "a" * 64)
        with (
            patch.object(
                client,
                "_request",
                new=AsyncMock(return_value={"ok": False, "error": "private-error-value"}),
            ),
            self.assertLogs("service.chat.service.browserhost", level="WARNING") as captured,
        ):
            asyncio.run(client.end_scope(**SCOPE))
        self.assertFalse(client.available)
        message = "\n".join(captured.output)
        self.assertIn("browser_host_channel_faulted", message)
        self.assertNotIn("private-error-value", message)

    def test_observed_action_keeps_business_identity_separate_from_read_and_transport_ids(
        self,
    ) -> None:
        received: list[dict[str, object]] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                received.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(409)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":false,"error":"stale_ref"}')

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = BrowserHostClient(server.server_port, "a" * 64)
            result = asyncio.run(
                client.prepare_action(
                    **SCOPE,
                    request_id="original-action",
                    tab_id="tab",
                    snapshot_id="snapshot",
                    element_ref="element",
                    browser_action="click",
                    intent="Open result",
                    preparation_request_id="derived-reprepare",
                    read_request_id="fresh-read",
                    read_proof_id="fresh-proof",
                )
            )
            self.assertEqual(result, {"ok": False, "error": "stale_ref"})
            self.assertEqual(len(received), 1)
            self.assertEqual(received[0]["request_id"], "derived-reprepare")
            self.assertEqual(received[0]["action_request_id"], "original-action")
            self.assertEqual(received[0]["grant_request_id"], "fresh-read")
            self.assertEqual(received[0]["proof_id"], "fresh-proof")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_invalid_scope_drain_confirmation_remains_channel_failure(self) -> None:
        status = 408
        result: dict[str, object] = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for status, result in (
                (401, {"ok": False, "error": "unauthorized"}),
                (200, {"ok": False, "error": "scope_unsettled", "phase": "effects"}),
                (503, {"ok": False, "error": "scope_unsettled", "phase": "effects"}),
                (408, {"ok": False, "error": "scope_unsettled", "phase": "unknown"}),
                (408, {"ok": False, "error": "scope_unsettled"}),
                (408, {"ok": True, "error": "scope_unsettled", "phase": "effects"}),
            ):
                with self.subTest(status=status, result=result):
                    client = BrowserHostClient(server.server_port, "a" * 64)
                    self.assertFalse(asyncio.run(client.end_scope(**SCOPE))["ok"])
                    self.assertFalse(client.available)
            status = 408
            result = {"ok": False, "error": "scope_unsettled", "phase": "effects"}
            client = BrowserHostClient(server.server_port, "a" * 64)
            self.assertEqual(
                asyncio.run(client.list_tabs(**SCOPE, request_id="invalid-operation")),
                {"ok": False, "error": "browser_unavailable"},
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_confirmed_scope_drain_failure_preserves_independent_host_access(self) -> None:
        received: list[str] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append(payload["action"])
                ending = payload["action"] == "scope/end"
                self.send_response(408 if ending else 200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {"ok": False, "error": "scope_unsettled", "phase": payload["session_id"]}
                        if ending
                        else {"ok": True, "tabs": []}
                    ).encode()
                )

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for phase in ("requests", "effects", "leases"):
                with self.subTest(phase=phase):
                    client = BrowserHostClient(server.server_port, "a" * 64)
                    result = asyncio.run(client.end_scope(**{**SCOPE, "session_id": phase}))
                    self.assertEqual(
                        result, {"ok": False, "error": "scope_unsettled", "phase": phase}
                    )
                    self.assertTrue(client.available)
                    self.assertTrue(
                        asyncio.run(
                            client.list_tabs(
                                **{**SCOPE, "session_id": "independent"}, request_id="list"
                            )
                        )["ok"]
                    )
            self.assertEqual(received, ["scope/end", "list"] * 3)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_faulted_host_only_transports_owned_close_without_restoring_availability(self) -> None:
        received: list[str] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                authenticated = self.headers.get("X-ScholarSeed-Agent-Key") == "a" * 64
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append(payload["action"])
                result = (
                    {"ok": True, "tab_id": payload["tab_id"]}
                    if payload["action"] == "close" and authenticated
                    else {"ok": False, "error": "request_expired"}
                )
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = BrowserHostClient(server.server_port, "a" * 64)
            self.assertFalse(asyncio.run(client.end_scope(**SCOPE))["ok"])
            self.assertFalse(client.available)
            self.assertTrue(
                asyncio.run(client.close_tab(**SCOPE, request_id="close", tab_id="owned"))["ok"]
            )
            self.assertFalse(client.available)
            self.assertFalse(asyncio.run(client.list_tabs(**SCOPE, request_id="list"))["ok"])
            self.assertFalse(asyncio.run(client.open_tab(**SCOPE, request_id="open"))["ok"])
            for invalid in (
                BrowserHostClient(None, None),
                BrowserHostClient(server.server_port, "a" * 64, enabled=False),
            ):
                self.assertFalse(
                    asyncio.run(invalid.close_tab(**SCOPE, request_id="disabled", tab_id="owned"))[
                        "ok"
                    ]
                )
            self.assertEqual(received, ["scope/end", "close"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_prepare_action_validates_full_proof_without_returning_fill_value(self) -> None:
        client = BrowserHostClient(12345, "a" * 64)
        proof = {
            "prepared_id": "prepared",
            "proof_id": "proof",
            "request_id": "callback",
            "scope": {
                "sessionId": "s",
                "instanceId": "instance",
                "productTurnId": "product",
                "turnId": "t",
                "generation": 1,
                "interruptGeneration": 0,
                "lifecycleEpoch": 1,
            },
            "tab_id": "tab",
            "target_instance_id": "target",
            "target_generation": 1,
            "origin": "https://example.org",
            "snapshot_id": "snapshot",
            "element_ref": "ref",
            "backend_node_id": 1,
            "grant_id": "grant",
            "grant_request_id": "snapshot-callback",
            "grant_revision": 1,
            "revocation_epoch": 0,
            "browser_action": "fill",
            "intent": "Fill",
            "expires_at": int((time.time() + 30) * 1000),
            "element": {"role": "textbox", "name": "Search"},
        }
        with patch.object(client, "_request", new_callable=AsyncMock) as request:
            request.return_value = {"ok": True, "proof": proof}
            result = asyncio.run(
                client.prepare_action(
                    **SCOPE,
                    request_id="callback",
                    tab_id="tab",
                    snapshot_id="snapshot",
                    element_ref="ref",
                    browser_action="fill",
                    intent="Fill",
                    value="secret-value",
                )
            )
            self.assertTrue(result["ok"])
            self.assertNotIn("secret-value", str(result))
            self.assertEqual(request.call_args.kwargs["value"], "secret-value")
            for grant_request_id in ("snapshot-callback", "fresh-read"):
                request.return_value = {
                    "ok": True,
                    "proof": {**proof, "grant_request_id": grant_request_id},
                }
                observed = asyncio.run(
                    client.prepare_action(
                        **SCOPE,
                        request_id="callback",
                        tab_id="tab",
                        snapshot_id="snapshot",
                        element_ref="ref",
                        browser_action="fill",
                        intent="Fill",
                        value="secret-value",
                        preparation_request_id="derived-reprepare",
                        read_request_id="fresh-read",
                        read_proof_id="fresh-proof",
                    )
                )
                self.assertEqual(observed["ok"], grant_request_id == "fresh-read")
            request.return_value = {"ok": True, "proof": {**proof, "origin": "https://other.org"}}
            self.assertTrue(
                asyncio.run(
                    client.prepare_action(
                        **SCOPE,
                        request_id="callback",
                        tab_id="tab",
                        snapshot_id="snapshot",
                        element_ref="ref",
                        browser_action="fill",
                        intent="Fill",
                        value="secret-value",
                    )
                )["ok"]
            )
            request.return_value = {"ok": True, "proof": {**proof, "snapshot_id": "other"}}
            self.assertEqual(
                asyncio.run(
                    client.prepare_action(
                        **SCOPE,
                        request_id="callback",
                        tab_id="tab",
                        snapshot_id="snapshot",
                        element_ref="ref",
                        browser_action="fill",
                        intent="Fill",
                        value="secret-value",
                    )
                )["error"],
                "browser_unavailable",
            )

    def test_snapshot_read_and_cancel_use_authenticated_action_fields_and_deadlines(self) -> None:
        received: list[dict[str, object]] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append(payload)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                if payload["action"] == "snapshot":
                    result = {
                        "ok": True,
                        "snapshot": {
                            "snapshot_id": "snapshot-1",
                            "origin": "https://example.org",
                            "title": "Example",
                            "elements": [],
                        },
                    }
                elif payload["action"] == "read":
                    result = {
                        "ok": True,
                        "element": {"element_ref": "ref-1", "role": "link", "name": "Example"},
                    }
                else:
                    result = {"ok": True}
                self.wfile.write(json.dumps(result).encode())

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = BrowserHostClient(server.server_port, "a" * 64)
            snapshot = asyncio.run(
                client.snapshot(
                    **SCOPE,
                    request_id="dispatch-1",
                    grant_request_id="callback-1",
                    proof_id="main-proof",
                    tab_id="tab",
                )
            )
            read = asyncio.run(
                client.read(
                    **SCOPE,
                    request_id="dispatch-2",
                    tab_id="tab",
                    snapshot_id="snapshot-1",
                    element_ref="ref-1",
                )
            )
            cancelled = asyncio.run(
                client.cancel_read(
                    **SCOPE, request_id="cancel-1", grant_request_id="callback-1", tab_id="tab"
                )
            )
            self.assertEqual(snapshot["snapshot"]["snapshot_id"], "snapshot-1")
            self.assertEqual(read["element"]["element_ref"], "ref-1")
            self.assertTrue(cancelled["ok"])
            self.assertEqual(
                [item["action"] for item in received], ["snapshot", "read", "cancel-read"]
            )
            self.assertEqual(received[0]["grant_request_id"], "callback-1")
            self.assertEqual(received[0]["proof_id"], "main-proof")
            self.assertEqual(received[1]["snapshot_id"], "snapshot-1")
            self.assertEqual(received[1]["element_ref"], "ref-1")
            self.assertGreater(received[0]["deadline"], time.time() * 1000 + 20_000)
            self.assertGreater(received[1]["deadline"], time.time() * 1000 + 20_000)
            self.assertLess(received[2]["deadline"], time.time() * 1000 + 10_000)
        finally:
            server.shutdown()
            server.server_close()

    def test_prepare_read_rejects_malformed_or_mismatched_main_proof(self) -> None:
        client = BrowserHostClient(12345, "a" * 64)
        for proof in ({"proof_id": "only-id"}, {"proof_id": "main-proof", "request_id": "wrong"}):
            with (
                self.subTest(proof=proof),
                patch.object(
                    client, "_request", new=AsyncMock(return_value={"ok": True, "proof": proof})
                ),
            ):
                self.assertEqual(
                    asyncio.run(
                        client.prepare_read(
                            **SCOPE,
                            request_id="read-callback",
                            tab_id="tab",
                            intent="Read current page",
                        )
                    ),
                    {"ok": False, "error": "browser_unavailable"},
                )

    def test_prepare_navigate_validates_destination_source_and_full_scope(self) -> None:
        client = BrowserHostClient(12345, "a" * 64)
        proof = {
            "proof_id": "navigate-proof",
            "request_id": "navigate-callback",
            "scope": {
                "sessionId": "s",
                "instanceId": "instance",
                "productTurnId": "product",
                "turnId": "t",
                "generation": 1,
                "interruptGeneration": 0,
                "lifecycleEpoch": 1,
            },
            "tab_id": "tab",
            "target_instance_id": "tab-instance",
            "target_generation": 0,
            "source_origin": None,
            "destination_url": "https://example.org/path",
            "destination_origin": "https://example.org",
            "intent": "Open page",
            "expires_at": int((time.time() + 60) * 1000),
            "policy_revision": 3,
            "policy_decision": "ask",
        }
        with patch.object(
            client, "_request", new=AsyncMock(return_value={"ok": True, "proof": proof})
        ):
            accepted = asyncio.run(
                client.prepare_navigate(
                    **SCOPE,
                    request_id="navigate-callback",
                    tab_id="tab",
                    url="https://example.org/a/../path",
                    intent="Open page",
                )
            )
            self.assertTrue(accepted["ok"])
        for changed in (
            {"source_origin": "javascript:"},
            {"destination_url": "javascript:alert(1)"},
            {"destination_origin": "https://wrong.example"},
            {"scope": {**proof["scope"], "lifecycleEpoch": 2}},
            {"policy_revision": True},
        ):
            with (
                self.subTest(changed=changed),
                patch.object(
                    client,
                    "_request",
                    new=AsyncMock(return_value={"ok": True, "proof": {**proof, **changed}}),
                ),
            ):
                self.assertEqual(
                    asyncio.run(
                        client.prepare_navigate(
                            **SCOPE,
                            request_id="navigate-callback",
                            tab_id="tab",
                            url="https://example.org/path",
                            intent="Open page",
                        )
                    ),
                    {"ok": False, "error": "browser_unavailable"},
                )

    def test_execute_and_cancel_navigate_use_separate_fields_and_effect_deadline(self) -> None:
        received: list[dict[str, object]] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append(payload)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = BrowserHostClient(server.server_port, "a" * 64)
            self.assertTrue(
                asyncio.run(
                    client.execute_navigate(
                        **SCOPE,
                        request_id="dispatch",
                        grant_request_id="navigate-callback",
                        proof_id="navigate-proof",
                        tab_id="tab",
                    )
                )["ok"]
            )
            self.assertTrue(
                asyncio.run(
                    client.cancel_navigate(
                        **SCOPE,
                        request_id="cancel",
                        grant_request_id="navigate-callback",
                        tab_id="tab",
                    )
                )["ok"]
            )
            self.assertEqual(
                [item["action"] for item in received], ["execute-navigate", "cancel-navigate"]
            )
            self.assertEqual(received[0]["proof_id"], "navigate-proof")
            self.assertNotIn("proof_id", received[1])
            self.assertGreater(received[0]["deadline"], time.time() * 1000 + 20_000)
            self.assertLess(received[1]["deadline"], time.time() * 1000 + 10_000)
        finally:
            server.shutdown()
            server.server_close()

    def test_execute_navigate_unresolved_host_response_is_unknown_not_denied(self) -> None:
        client = BrowserHostClient(12345, "a" * 64)
        with patch.object(
            client,
            "_request",
            new=AsyncMock(return_value={"ok": False, "error": "browser_unavailable"}),
        ):
            result = asyncio.run(
                client.execute_navigate(
                    **SCOPE,
                    request_id="dispatch",
                    grant_request_id="navigate-callback",
                    proof_id="navigate-proof",
                    tab_id="tab",
                )
            )
        self.assertEqual(result, {"ok": False, "error": "request_unknown"})

    def test_unexpected_end_failure_faults_the_shared_host_client(self) -> None:
        client = BrowserHostClient(12345, "a" * 64)
        with patch.object(client, "_request", new=AsyncMock(side_effect=RuntimeError("unknown"))):
            self.assertEqual(
                asyncio.run(client.end_scope(**SCOPE)),
                {"ok": False, "error": "browser_unavailable"},
            )
        self.assertFalse(client.available)

    def test_cancelled_end_faults_the_shared_host_client(self) -> None:
        async def scenario() -> None:
            client = BrowserHostClient(12345, "a" * 64)
            entered = asyncio.Event()

            async def never_finish(**_kwargs):
                entered.set()
                await asyncio.Event().wait()

            with patch.object(client, "_request", new=never_finish):
                pending = asyncio.create_task(client.end_scope(**SCOPE))
                await entered.wait()
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
            self.assertFalse(client.available)

        asyncio.run(scenario())

    def test_stale_old_end_does_not_fault_a_new_active_scope(self) -> None:
        requests: list[dict[str, object]] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(payload)
                stale = payload["action"] == "scope/end" and payload["lifecycle_epoch"] == 1
                unknown = payload["action"] == "scope/end" and payload["lifecycle_epoch"] == 3
                invalid_stale = payload["action"] == "scope/end" and payload["lifecycle_epoch"] == 4
                self.send_response(409 if stale else 503 if unknown or invalid_stale else 200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    b'{"ok":false,"error":"stale_scope"}'
                    if stale or invalid_stale
                    else (
                        b'{"ok":false,"error":"browser_unavailable"}'
                        if unknown
                        else b'{"ok":true,"tabs":[]}'
                    )
                )

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = BrowserHostClient(server.server_port, "a" * 64)
            old = dict(SCOPE)
            successor = {**SCOPE, "instance_id": "successor", "lifecycle_epoch": 2}
            self.assertEqual(asyncio.run(client.end_scope(**old))["error"], "stale_scope")
            self.assertTrue(client.available)
            self.assertTrue(asyncio.run(client.list_tabs(**successor, request_id="new"))["ok"])
            uncertain = {**SCOPE, "instance_id": "uncertain", "lifecycle_epoch": 3}
            self.assertFalse(asyncio.run(client.end_scope(**uncertain))["ok"])
            self.assertFalse(client.available)
            self.assertFalse(asyncio.run(client.list_tabs(**successor, request_id="later"))["ok"])
            other = BrowserHostClient(server.server_port, "a" * 64)
            invalid = {**SCOPE, "instance_id": "invalid", "lifecycle_epoch": 4}
            self.assertFalse(asyncio.run(other.end_scope(**invalid))["ok"])
            self.assertFalse(other.available)
            self.assertEqual(
                [item["action"] for item in requests],
                ["scope/end", "list", "scope/end", "scope/end"],
            )
        finally:
            server.shutdown()
            server.server_close()

    def test_scope_lifecycle_uses_authenticated_host_transport(self) -> None:
        received: list[dict[str, object]] = []
        received_keys: list[str | None] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                received_keys.append(self.headers.get("X-ScholarSeed-Agent-Key"))
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append(payload)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                if payload["action"] == "prepare-read":
                    self.wfile.write(
                        json.dumps(
                            {
                                "ok": True,
                                "proof": {
                                    "proof_id": "main-proof",
                                    "request_id": payload["request_id"],
                                    "scope": {
                                        "sessionId": payload["session_id"],
                                        "instanceId": payload["instance_id"],
                                        "productTurnId": payload["product_turn_id"],
                                        "turnId": payload["turn_id"],
                                        "generation": payload["generation"],
                                        "interruptGeneration": payload["interrupt_generation"],
                                        "lifecycleEpoch": payload["lifecycle_epoch"],
                                    },
                                    "tab_id": payload["tab_id"],
                                    "target_instance_id": "tab-instance",
                                    "target_generation": 2,
                                    "origin": "https://example.org",
                                    "intent": payload["intent"],
                                    "expires_at": int((time.time() + 60) * 1000),
                                    "policy_revision": 1,
                                    "policy_decision": "ask",
                                },
                            }
                        ).encode()
                    )
                else:
                    self.wfile.write(b'{"ok":true,"tabs":[]}')

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        scope = dict(
            session_id="session",
            instance_id="instance",
            product_turn_id="product",
            turn_id="vendor",
            generation=1,
            interrupt_generation=0,
            lifecycle_epoch=7,
        )
        try:
            client = BrowserHostClient(server.server_port, "a" * 64)
            self.assertTrue(asyncio.run(client.start_scope(**scope))["ok"])
            self.assertTrue(asyncio.run(client.list_tabs(**scope, request_id="callback"))["ok"])
            self.assertTrue(
                asyncio.run(
                    client.prepare_read(
                        **scope,
                        request_id="read-callback",
                        tab_id="tab",
                        intent="Read current page",
                    )
                )["ok"]
            )
            self.assertTrue(asyncio.run(client.end_scope(**scope))["ok"])
            self.assertEqual(
                [item["action"] for item in received],
                ["scope/start", "list", "prepare-read", "scope/end"],
            )
            self.assertEqual(received[2]["tab_id"], "tab")
            self.assertEqual(received[2]["intent"], "Read current page")
            self.assertEqual([item["generation"] for item in received], [1] * 4)
            self.assertEqual([item["lifecycle_epoch"] for item in received], [7] * 4)
            self.assertEqual(received_keys, ["a" * 64] * 4)
        finally:
            server.shutdown()
            server.server_close()

    def test_standalone_is_unavailable(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            client = BrowserHostClient.from_environment(enabled=True)
        self.assertFalse(client.available)

    def test_managed_configuration_is_consumed_and_not_inherited(self) -> None:
        with patch.dict(
            os.environ,
            {AGENT_BROWSER_PORT_ENV: "12345", AGENT_BROWSER_KEY_ENV: "a" * 64},
        ):
            client = BrowserHostClient.from_environment(enabled=True)
            self.assertTrue(client.available)
            self.assertNotIn(AGENT_BROWSER_PORT_ENV, os.environ)
            self.assertNotIn(AGENT_BROWSER_KEY_ENV, os.environ)

    def test_partial_or_invalid_configuration_fails_closed(self) -> None:
        for settings in (
            {AGENT_BROWSER_PORT_ENV: "12345"},
            {AGENT_BROWSER_PORT_ENV: "0", AGENT_BROWSER_KEY_ENV: "a" * 64},
            {AGENT_BROWSER_PORT_ENV: "12345", AGENT_BROWSER_KEY_ENV: "short"},
        ):
            with self.subTest(settings=settings), patch.dict(os.environ, settings, clear=True):
                client = BrowserHostClient.from_environment(enabled=True)
                self.assertFalse(client.available)
                self.assertNotIn(AGENT_BROWSER_PORT_ENV, os.environ)
                self.assertNotIn(AGENT_BROWSER_KEY_ENV, os.environ)

    def test_streamed_response_stops_at_byte_limit(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                self.send_response(200)
                self.end_headers()
                try:
                    for _ in range(100):
                        self.wfile.write(b"x" * 1024)
                        self.wfile.flush()
                        time.sleep(0.02)
                except BrokenPipeError:
                    pass

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = BrowserHostClient(server.server_port, "a" * 64)
            with patch("service.chat.service.browserhost.AGENT_BROWSER_MAX_RESPONSE_BYTES", 2048):
                started = time.monotonic()
                result = asyncio.run(client.list_tabs(**SCOPE, request_id="r"))
                self.assertLess(time.monotonic() - started, 1.0)
            self.assertEqual(result, {"ok": False, "error": "browser_unavailable"})
        finally:
            server.shutdown()
            server.server_close()

    def test_drip_response_obeys_absolute_deadline(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                self.send_response(200)
                self.end_headers()
                try:
                    for _ in range(20):
                        self.wfile.write(b" ")
                        self.wfile.flush()
                        time.sleep(0.1)
                except BrokenPipeError:
                    pass

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = BrowserHostClient(server.server_port, "a" * 64)
            with patch("service.chat.service.browserhost.AGENT_BROWSER_TIMEOUT_SECONDS", 0.35):
                started = time.monotonic()
                result = asyncio.run(client.list_tabs(**SCOPE, request_id="r"))
                self.assertLess(time.monotonic() - started, 1.0)
            self.assertEqual(result, {"ok": False, "error": "browser_unavailable"})
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
