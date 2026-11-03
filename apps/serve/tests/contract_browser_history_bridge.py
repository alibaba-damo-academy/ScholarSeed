"""Agent browser-history search has a separate, request-bound approval boundary."""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from pydantic import ValidationError

from service.chat.api.browser import register_browser_routes
from service.chat.api.browserhistory import HistoryLeasedResponse, register_browser_history_routes
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.interaction import SessionInteractions
from service.chat.runtime.live import LiveSession
from service.chat.runtime.tools import execute_service_tool
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    BRIDGE_CALLBACK_REQUEST_HEADER,
    BRIDGE_CALLBACK_TURN_HEADER,
    BRIDGE_REQUESTS,
)
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    INTERNAL_BASE_URL_ENV,
)


class BrowserHistoryBridgeContracts(unittest.TestCase):
    def test_runtime_tool_forwards_history_callback_scope(self) -> None:
        seen = []
        original_client = httpx.AsyncClient

        def local_client(**kwargs):
            def reply(request):
                seen.append(request)
                return httpx.Response(200, json={"ok": False, "error": "browser_unavailable"})

            kwargs["transport"] = httpx.MockTransport(reply)
            return original_client(**kwargs)

        with (
            patch.dict(os.environ, {INTERNAL_BASE_URL_ENV: "http://127.0.0.1"}),
            patch("service.chat.runtime.tools.httpx.AsyncClient", side_effect=local_client),
        ):
            result = asyncio.run(
                execute_service_tool(
                    {
                        "capability": "browser-history",
                        "operation": "search",
                        "request": {
                            "search": "paper",
                            "intent": "Find prior paper",
                        },
                    },
                    session_id="history-session",
                    token="private-token",
                    local_socket=None,
                    callback_request_id="history-request",
                    callback_turn_id="turn",
                )
            )
        self.assertEqual(result["error"], "browser_unavailable")
        self.assertEqual(seen[0].url.path, "/api/internal/bridge/browser-history/search")
        self.assertEqual(seen[0].headers[BRIDGE_CALLBACK_REQUEST_HEADER], "history-request")
        self.assertEqual(seen[0].headers[BRIDGE_CALLBACK_TURN_HEADER], "turn")

    def test_history_lease_completes_only_after_asgi_body_send(self) -> None:
        async def scenario() -> None:
            calls = []

            async def complete():
                calls.append("complete")
                return {"ok": True}

            async def cancel():
                calls.append("cancel")
                return {"ok": True}

            async def after_release():
                calls.append("after")

            async def delivered():
                calls.append("delivered")

            async def aborted():
                calls.append("abort")

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            response = HistoryLeasedResponse(
                {"ok": True},
                complete=complete,
                cancel=cancel,
                after_release=after_release,
                ready=lambda: True,
                delivery_lock=asyncio.Lock(),
                on_delivery=delivered,
                on_abort=aborted,
            )

            async def send(message):
                if message["type"] == "http.response.body":
                    self.assertEqual(calls, [])
                    calls.append("body")

            await response({"type": "http", "method": "POST", "path": "/"}, receive, send)
            self.assertEqual(calls, ["body", "complete", "delivered", "after"])

            calls.clear()
            response = HistoryLeasedResponse(
                {"ok": True},
                complete=complete,
                cancel=cancel,
                after_release=after_release,
                ready=lambda: True,
                delivery_lock=asyncio.Lock(),
                on_delivery=delivered,
                on_abort=aborted,
            )

            async def abort(message):
                if message["type"] == "http.response.body":
                    raise ConnectionError("client disconnected")

            with self.assertRaises(ConnectionError):
                await response({"type": "http", "method": "POST", "path": "/"}, receive, abort)
            self.assertEqual(calls, ["cancel", "abort", "after"])

        asyncio.run(scenario())

    def test_history_response_revoked_before_deferred_send_never_emits_page(self) -> None:
        async def scenario() -> None:
            calls = []
            authorized = True

            async def complete():
                calls.append("complete")
                return {"ok": True}

            async def cancel():
                calls.append("cancel")
                return {"ok": True}

            async def after_release():
                calls.append("after")

            async def delivered():
                calls.append("delivered")

            async def aborted():
                calls.append("abort")

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            response = HistoryLeasedResponse(
                {"ok": True, "page": {"items": [{"url": "https://private.example"}]}},
                complete=complete,
                cancel=cancel,
                after_release=after_release,
                ready=lambda: authorized,
                delivery_lock=asyncio.Lock(),
                on_delivery=delivered,
                on_abort=aborted,
            )
            authorized = False
            sent = []

            async def send(message):
                sent.append(message)

            await response({"type": "http", "method": "POST", "path": "/"}, receive, send)
            body = b"".join(message.get("body", b"") for message in sent)
            self.assertNotIn(b"private.example", body)
            self.assertEqual(calls, ["cancel", "abort", "after"])

        asyncio.run(scenario())

    def test_history_response_disconnected_during_send_does_not_complete_lease(self) -> None:
        async def scenario() -> None:
            calls = []
            connected = True

            async def complete():
                calls.append("complete")
                return {"ok": True}

            async def cancel():
                calls.append("cancel")
                return {"ok": True}

            async def after_release():
                calls.append("after")

            async def delivered():
                calls.append("delivered")

            async def aborted():
                calls.append("abort")

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(message):
                nonlocal connected
                if message["type"] == "http.response.body":
                    connected = False

            response = HistoryLeasedResponse(
                {"ok": True},
                complete=complete,
                cancel=cancel,
                after_release=after_release,
                ready=lambda: connected,
                delivery_lock=asyncio.Lock(),
                on_delivery=delivered,
                on_abort=aborted,
            )
            await response({"type": "http", "method": "POST", "path": "/"}, receive, send)
            self.assertEqual(calls, ["cancel", "abort", "after"])

        asyncio.run(scenario())

    def test_scope_end_cannot_pass_history_delivery_audit(self) -> None:
        async def scenario() -> None:
            delivery_started = asyncio.Event()
            finish_delivery = asyncio.Event()
            scope_end_passed = asyncio.Event()
            delivery_lock = asyncio.Lock()

            async def complete():
                return {"ok": True}

            async def cancel():
                return {"ok": True}

            async def after_release():
                return None

            async def delivered():
                delivery_started.set()
                await finish_delivery.wait()

            async def aborted():
                return None

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(_message):
                return None

            response = HistoryLeasedResponse(
                {"ok": True},
                complete=complete,
                cancel=cancel,
                after_release=after_release,
                ready=lambda: True,
                delivery_lock=delivery_lock,
                on_delivery=delivered,
                on_abort=aborted,
            )
            delivery = asyncio.create_task(
                response({"type": "http", "method": "POST", "path": "/"}, receive, send)
            )
            await delivery_started.wait()

            async def end_scope():
                async with delivery_lock:
                    scope_end_passed.set()

            ending = asyncio.create_task(end_scope())
            await asyncio.sleep(0)
            self.assertFalse(scope_end_passed.is_set())
            finish_delivery.set()
            await delivery
            await ending
            self.assertTrue(scope_end_passed.is_set())

        asyncio.run(scenario())

    def test_history_scope_end_retry_runs_after_delivery_lock_releases(self) -> None:
        async def scenario() -> None:
            delivery_lock = asyncio.Lock()
            retried = asyncio.Event()

            async def release():
                return {"ok": True}

            async def after_release():
                async with delivery_lock:
                    retried.set()

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(_message):
                return None

            response = HistoryLeasedResponse(
                {"ok": True},
                complete=release,
                cancel=release,
                after_release=after_release,
                ready=lambda: True,
                delivery_lock=delivery_lock,
                on_delivery=lambda: asyncio.sleep(0),
                on_abort=lambda: asyncio.sleep(0),
            )
            await asyncio.wait_for(
                response({"type": "http", "method": "POST", "path": "/"}, receive, send),
                timeout=0.2,
            )
            self.assertTrue(retried.is_set())

        asyncio.run(scenario())

    def test_cancellation_after_body_waits_for_lease_release(self) -> None:
        async def scenario() -> None:
            calls = []
            release_started = asyncio.Event()
            release_allowed = asyncio.Event()

            async def complete():
                calls.append("complete-start")
                release_started.set()
                await release_allowed.wait()
                calls.append("complete-end")
                return {"ok": True}

            async def cancel():
                calls.append("cancel")
                return {"ok": True}

            async def after_release():
                calls.append("after")

            async def delivered():
                calls.append("delivered")

            async def aborted():
                calls.append("abort")

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(message):
                if message["type"] == "http.response.body":
                    calls.append("body")

            response = HistoryLeasedResponse(
                {"ok": True},
                complete=complete,
                cancel=cancel,
                after_release=after_release,
                ready=lambda: True,
                delivery_lock=asyncio.Lock(),
                on_delivery=delivered,
                on_abort=aborted,
            )
            task = asyncio.create_task(
                response({"type": "http", "method": "POST", "path": "/"}, receive, send)
            )
            await release_started.wait()
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            release_allowed.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(
                calls, ["body", "complete-start", "complete-end", "delivered", "after"]
            )

        asyncio.run(scenario())

    def test_page_and_history_scope_cleanup_each_run_once(self) -> None:
        async def scenario() -> None:
            calls = []
            archives = []
            scope = {
                "session_id": "session",
                "instance_id": "instance",
                "product_turn_id": "product",
                "turn_id": "turn",
                "generation": 1,
                "interrupt_generation": 0,
                "lifecycle_epoch": 1,
            }
            live = object.__new__(LiveSession)
            live._browser_scope = None
            live._browser_scope_lock = asyncio.Lock()
            live._browser_delivery_lock = asyncio.Lock()
            live._catalog = SimpleNamespace(archive_browser_action_scope=archives.append)

            async def page_end():
                calls.append("page")
                return {"ok": True}

            async def history_end():
                calls.append("history")
                return {"ok": True}

            live.bind_browser_scope_end(scope, page_end)
            live.bind_browser_scope_end(scope, history_end, owner="history")
            live.bind_browser_scope_end(scope, history_end, owner="history")
            self.assertTrue(await live.end_browser_scope())
            self.assertEqual(calls, ["page", "history"])
            self.assertEqual(archives, [scope])

        asyncio.run(scenario())

    def test_failed_scope_end_remains_retryable_after_history_release(self) -> None:
        async def scenario() -> None:
            live = object.__new__(LiveSession)
            live._browser_scope = None
            live._browser_scope_lock = asyncio.Lock()
            live._browser_delivery_lock = asyncio.Lock()
            live._browser_scope_end_pending = False
            archives = []
            live._catalog = SimpleNamespace(archive_browser_action_scope=archives.append)
            scope = {"session_id": "session", "turn_id": "turn"}
            attempts = 0

            async def end():
                nonlocal attempts
                attempts += 1
                return {"ok": attempts > 1}

            live.bind_browser_scope_end(scope, end, owner="history")
            self.assertFalse(await live.end_browser_scope())
            self.assertTrue(live.browser_scope_end_pending)
            self.assertTrue(await live.end_browser_scope())
            self.assertFalse(live.browser_scope_end_pending)
            self.assertEqual(archives, [scope])

        asyncio.run(scenario())

    def test_history_first_scope_still_runs_page_cleanup(self) -> None:
        async def scenario() -> None:
            live = object.__new__(LiveSession)
            live._browser_scope = None
            live._browser_scope_lock = asyncio.Lock()
            live._browser_delivery_lock = asyncio.Lock()
            live._catalog = SimpleNamespace(archive_browser_action_scope=lambda _scope: None)
            calls = []

            async def history_end():
                calls.append("history")
                return {"ok": True}

            async def page_end():
                calls.append("page")
                return {"ok": True}

            scope = {"session_id": "session", "turn_id": "turn"}
            live.bind_browser_scope_end(scope, history_end, owner="history")
            live.bind_browser_scope_end(scope, page_end)
            self.assertTrue(await live.end_browser_scope())
            self.assertEqual(calls, ["history", "page"])

        asyncio.run(scenario())

    def test_search_has_a_strict_bounded_independent_contract(self) -> None:
        entry = BRIDGE_REQUESTS[("browser-history", "search")]
        request_type, route = entry.request_type, entry.route
        self.assertEqual(route, "/api/internal/bridge/browser-history/search")
        self.assertEqual(
            request_type.model_validate(
                {
                    "search": "paper",
                    "intent": "Find earlier paper",
                }
            ).model_dump(),
            {"search": "paper", "offset": 0, "limit": 10, "intent": "Find earlier paper"},
        )
        for invalid in (
            {"search": "", "intent": "Find earlier paper"},
            {"search": "  ", "intent": "Find earlier paper"},
            {"search": "paper", "intent": ""},
            {"search": "paper", "intent": "  "},
            {"search": "paper", "intent": "Find earlier paper", "offset": -1},
            {"search": "paper", "intent": "Find earlier paper", "offset": 1001},
            {"search": "paper", "intent": "Find earlier paper", "limit": 21},
            {"search": "paper", "intent": "Find earlier paper", "tab_id": "fake"},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                request_type.model_validate(invalid)

    def test_history_hil_is_independent_and_once_only(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory(prefix="browser-history-hil-") as directory:
                database = Path(directory).resolve() / "session.sqlite3"
                catalog = SessionCatalogStore(database)
                catalog.register(
                    "history-session",
                    SessionPrincipal("owner"),
                    runtime_id="codex",
                    vendor_thread_id="thread",
                    vendor_session_id="vendor",
                    runtime_workdir=directory,
                    project_path=None,
                    output_root=directory,
                    codex_version=None,
                    model_id="model",
                    policy_id=None,
                    status=SessionStatus.RUNNING,
                    title="Browser",
                    created_at=1.0,
                )
                events = ProductEventStore(database)
                published = []

                async def publish(*_args, **_kwargs):
                    raise AssertionError("history HIL must use transactional event store")

                interaction = SessionInteractions(
                    "history-session", catalog, publish, events=events, broadcast=published.append
                )
                scope = {
                    "session_id": "history-session",
                    "instance_id": "instance",
                    "product_turn_id": "product-turn",
                    "turn_id": "turn",
                    "generation": 1,
                    "interrupt_generation": 0,
                    "lifecycle_epoch": 1,
                }
                pending = asyncio.create_task(
                    interaction.request_browser_history_approval(
                        request_id="history-request",
                        proof_id="proof",
                        turn_id="turn",
                        runtime_id="codex",
                        vendor_thread_id="thread",
                        search="papers",
                        offset=0,
                        limit=10,
                        intent="Find prior papers",
                        query_digest="a" * 64,
                        history_revision=1,
                        expires_at=time.time() + 30,
                        scope=scope,
                    )
                )
                for _ in range(10):
                    if published:
                        break
                    await asyncio.sleep(0)
                self.assertEqual(len(published), 1)
                payload = published[0].payload
                self.assertEqual(payload["kind"], "browser_history_approval")
                self.assertNotIn("tab_id", payload)
                self.assertNotIn("origin", payload)
                self.assertEqual(payload["search"], "papers")
                resolved = await interaction.resolve(
                    None, "history-request", {"decision": "allow_once"}, active_turn_id="turn"
                )
                self.assertEqual(resolved["decision"], "allow_once")
                self.assertEqual(await pending, {"decision": "allow_once"})
                self.assertIsNone(
                    await interaction.resolve(
                        None, "history-request", {"decision": "allow_once"}, active_turn_id="turn"
                    )
                )

        asyncio.run(scenario())

    def test_route_requires_current_scope_and_single_history_approval(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            with tempfile.TemporaryDirectory(prefix="browser-history-route-") as directory:
                database = Path(directory) / "session.sqlite3"
                catalog = SessionCatalogStore(database)
                catalog.register(
                    "history-session",
                    SessionPrincipal("owner"),
                    runtime_id="codex",
                    vendor_thread_id="thread",
                    vendor_session_id="vendor",
                    runtime_workdir=directory,
                    project_path=None,
                    output_root=directory,
                    codex_version=None,
                    model_id="model",
                    policy_id=None,
                    status=SessionStatus.RUNNING,
                    title="Browser",
                    created_at=1.0,
                )
                live = SimpleNamespace(
                    turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                    id="history-session",
                    bridge_token="private-token",
                    runtime_id="codex",
                    vendor_thread_id="thread",
                    ledger=SimpleNamespace(active_turn_id="turn"),
                    active_product_turn_id="product-turn",
                    product_turn_generation=1,
                    interrupt_generation=0,
                    active_assistant_snapshot_id="snapshot",
                    browser_scope_instance="instance",
                    attachment_generation=1,
                    catalog=catalog,
                )
                audits = []

                async def publish(kind, data, **_kwargs):
                    audits.append((kind, data))

                live.publish = publish
                live._browser_scope = None
                live._browser_scope_lock = asyncio.Lock()
                live._browser_delivery_lock = asyncio.Lock()
                live._catalog = catalog
                live.browser_scope_end_pending = False
                live.browser_delivery_lock = live._browser_delivery_lock
                live.bind_browser_scope_end = LiveSession.bind_browser_scope_end.__get__(live)
                live.end_browser_scope = LiveSession.end_browser_scope.__get__(live)
                approvals = []
                decisions = iter(("allow_once", "deny", "allow_once"))

                class Interactions:
                    async def request_browser_history_approval(self, **kwargs):
                        approvals.append(kwargs)
                        return {"decision": next(decisions)}

                live.interactions = Interactions()

                class Sessions:
                    def bridge_caller(self, session_id):
                        return live if session_id == live.id else None

                class Host:
                    product_enabled = True
                    available = True
                    executions = 0
                    completions = 0
                    scope_ends = 0
                    fail_next_start = False
                    raise_next_start = False

                    async def start_scope(self, **_kwargs):
                        if self.raise_next_start:
                            self.raise_next_start = False
                            raise TimeoutError("start response lost")
                        if self.fail_next_start:
                            self.fail_next_start = False
                            return {"ok": False, "error": "stale_scope"}
                        return {"ok": True}

                    async def end_scope(self, **_kwargs):
                        self.scope_ends += 1
                        return {"ok": True}

                    async def list_tabs(self, **_kwargs):
                        return {"ok": True, "tabs": []}

                    async def prepare_history(self, **kwargs):
                        return {
                            "ok": True,
                            "proof": {
                                "proof_id": "proof",
                                "request_id": kwargs["request_id"],
                                "scope": {
                                    "sessionId": live.id,
                                    "instanceId": "instance",
                                    "productTurnId": "product-turn",
                                    "turnId": "turn",
                                    "generation": 1,
                                    "interruptGeneration": 0,
                                    "lifecycleEpoch": 1,
                                },
                                "query_digest": hashlib.sha256(
                                    b'["private",0,10,"Find prior site"]'
                                ).hexdigest(),
                                "history_revision": 1,
                                "expires_at": int((time.time() + 30) * 1000),
                            },
                        }

                    async def execute_history(self, **_kwargs):
                        self.executions += 1
                        return {
                            "ok": True,
                            "page": {
                                "items": [
                                    {
                                        "id": "visit",
                                        "url": "https://private.example",
                                        "title": "Private",
                                        "visitedAt": 1.0,
                                    }
                                ],
                                "total": 1,
                            },
                        }

                    async def cancel_history(self, **_kwargs):
                        return {"ok": True}

                    async def complete_history(self, **_kwargs):
                        self.completions += 1
                        return {"ok": True}

                host = Host()
                app = FastAPI()
                app.include_router(
                    register_browser_routes(app, Sessions(), host, activities=activities)
                )
                register_browser_history_routes(app, Sessions(), host, activities=activities)
                route = "/api/internal/bridge/browser-history/search"
                headers = {
                    BRIDGE_SESSION_HEADER: live.id,
                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                    BRIDGE_CALLBACK_REQUEST_HEADER: "history-request",
                    BRIDGE_CALLBACK_TURN_HEADER: "turn",
                }
                payload = {"search": "private", "intent": "Find prior site"}
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    forbidden = await client.post(
                        route, headers={**headers, BRIDGE_TOKEN_HEADER: "wrong"}, json=payload
                    )
                    stale = await client.post(
                        route,
                        headers={**headers, BRIDGE_CALLBACK_TURN_HEADER: "prior"},
                        json=payload,
                    )
                    browser = await client.post(
                        "/api/internal/bridge/browser/list", headers=headers, json={}
                    )
                    first = await client.post(route, headers=headers, json=payload)
                    repeated = await client.post(route, headers=headers, json=payload)
                    denied = await client.post(
                        route,
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "history-denied"},
                        json=payload,
                    )

                async def abort_body(scope, receive, send):
                    async def aborting_send(message):
                        if message[
                            "type"
                        ] == "http.response.body" and b"private.example" in message.get(
                            "body", b""
                        ):
                            raise ConnectionError("client disconnected")
                        await send(message)

                    await app(scope, receive, aborting_send)

                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=abort_body), base_url="http://test"
                ) as client:
                    with self.assertRaises(ConnectionError):
                        await client.post(
                            route,
                            headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "history-aborted"},
                            json=payload,
                        )
                self.assertEqual(forbidden.status_code, 403)
                self.assertEqual(stale.status_code, 400)
                self.assertTrue(browser.json()["ok"])
                self.assertEqual(
                    first.json().get("page", {}).get("items", [{}])[0].get("url"),
                    "https://private.example",
                    first.json(),
                )
                self.assertNotIn("page", repeated.json())
                self.assertEqual(denied.json()["error"], "browser_history_approval_denied")
                self.assertEqual(len(approvals), 3)
                self.assertEqual(host.executions, 2)
                self.assertEqual(host.completions, 1)
                self.assertEqual(catalog.browser_action("history-aborted").status.value, "unknown")
                self.assertTrue(
                    any(
                        data.get("request_id") == "history-aborted"
                        and data.get("result") == "prepared"
                        for _, data in audits
                    )
                )
                self.assertFalse(
                    any(
                        data.get("request_id") == "history-aborted"
                        and data.get("result") == "delivered"
                        for _, data in audits
                    )
                )
                self.assertTrue(await live.end_browser_scope())
                self.assertEqual(host.scope_ends, 2)
                self.assertNotIn("private.example", str(audits))
                self.assertNotIn("private", str(audits))
                live.browser_scope_instance = "new-instance"
                live.ledger.active_turn_id = "new-turn"
                live.active_product_turn_id = "new-product-turn"
                live.product_turn_generation = 2
                live.attachment_generation = 2
                host.fail_next_start = True
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    start_failed = await client.post(
                        route,
                        headers={
                            **headers,
                            BRIDGE_CALLBACK_REQUEST_HEADER: "history-start-failed",
                            BRIDGE_CALLBACK_TURN_HEADER: "new-turn",
                        },
                        json=payload,
                    )
                self.assertEqual(start_failed.json()["error"], "browser_request_unknown")
                self.assertEqual(host.scope_ends, 3)
                self.assertEqual(
                    catalog.browser_action("history-start-failed").status.value, "unknown"
                )
                live.browser_scope_instance = "third-instance"
                live.ledger.active_turn_id = "third-turn"
                live.active_product_turn_id = "third-product-turn"
                live.product_turn_generation = 3
                live.attachment_generation = 3
                host.raise_next_start = True
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    start_uncertain = await client.post(
                        route,
                        headers={
                            **headers,
                            BRIDGE_CALLBACK_REQUEST_HEADER: "history-start-uncertain",
                            BRIDGE_CALLBACK_TURN_HEADER: "third-turn",
                        },
                        json=payload,
                    )
                self.assertEqual(start_uncertain.json()["error"], "browser_request_unknown")
                self.assertEqual(host.scope_ends, 4)
                self.assertEqual(
                    catalog.browser_action("history-start-uncertain").status.value, "unknown"
                )

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
