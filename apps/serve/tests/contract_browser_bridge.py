"""Browser product-bridge vocabulary and fail-closed admission contracts."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from pydantic import ValidationError

from service.chat.api.browser import BROWSER_CLEANUP_DRAIN_SECONDS, register_browser_routes
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.interaction import SessionInteractions
from service.chat.runtime.live import LiveSession
from service.chat.runtime.tools import SERVICE_BRIDGE_TOOL, execute_service_tool
from service.chat.service.browserhost import AGENT_BROWSER_SCOPE_END_TIMEOUT_SECONDS
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    BRIDGE_CALLBACK_REQUEST_HEADER,
    BRIDGE_CALLBACK_TURN_HEADER,
    BRIDGE_REQUESTS,
)
from service.platform.vocabulary import (
    BRIDGE_ROUTE_PREFIX,
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    INTERNAL_BASE_URL_ENV,
)

OPERATIONS = ("list", "open", "close", "navigate", "snapshot", "read", "interact", "submit")
VALID_REQUESTS = {
    "list": {},
    "open": {},
    "close": {"tab_id": "browser-tab"},
    "navigate": {"tab_id": "browser-tab", "url": "https://example.com", "intent": "Open page"},
    "snapshot": {"tab_id": "browser-tab"},
    "read": {"tab_id": "browser-tab", "snapshot_id": "snapshot", "element_ref": "element"},
    "interact": {
        "tab_id": "browser-tab",
        "snapshot_id": "snapshot",
        "element_ref": "element",
        "action": "fill",
        "value": "hello",
        "intent": "Fill search query",
    },
    "submit": {
        "tab_id": "browser-tab",
        "snapshot_id": "snapshot",
        "element_ref": "element",
        "intent": "Send search query",
    },
}


def attach_browser_scope(live: SimpleNamespace) -> None:
    live.browser_scope_instance = f"instance-{live.id}"
    live.attachment_generation = 1
    live.bound_scope = None

    def bind(scope, _callback):
        live.bound_scope = scope

    live.bind_browser_scope_end = bind


class ScopeHost:
    product_enabled = True

    async def start_scope(self, **_kwargs):
        return {"ok": True}

    async def end_scope(self, **_kwargs):
        return {"ok": True}


class BrowserBridgeContracts(unittest.TestCase):
    def test_cleanup_budget_outlives_scope_end_transport_wait(self) -> None:
        self.assertGreater(BROWSER_CLEANUP_DRAIN_SECONDS, AGENT_BROWSER_SCOPE_END_TIMEOUT_SECONDS)

    def test_close_replay_expiration_fails_closed_without_reexecuting(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            parent = activities.enter(ActivityDomain.TURN, root=True)
            live = SimpleNamespace(
                turn_activity=parent,
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn"),
                active_product_turn_id="product",
                product_turn_generation=1,
                interrupt_generation=0,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)
            calls = []

            async def close_tab(**kwargs):
                calls.append(kwargs)
                return {"ok": True, "tab_id": kwargs["tab_id"]}

            async def publish(*_args, **_kwargs):
                return None

            live.publish = publish
            app = FastAPI()
            register_browser_routes(
                app,
                SimpleNamespace(
                    bridge_caller=lambda identity: live if identity == live.id else None
                ),
                SimpleNamespace(product_enabled=True, available=True, close_tab=close_tab),
                activities=activities,
            )
            headers = {
                BRIDGE_SESSION_HEADER: live.id,
                BRIDGE_TOKEN_HEADER: live.bridge_token,
                BRIDGE_CALLBACK_TURN_HEADER: "turn",
                BRIDGE_CALLBACK_REQUEST_HEADER: "close",
            }
            replay_lifetime = 0.01
            try:
                with patch(
                    "service.chat.api.browser.BROWSER_REPLAY_LIFETIME_SECONDS", replay_lifetime
                ):
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as client:
                        self.assertTrue(
                            (
                                await client.post(
                                    BRIDGE_ROUTE_PREFIX + "browser/close",
                                    headers=headers,
                                    json={"tab_id": "owned"},
                                )
                            ).json()["ok"]
                        )
                        await asyncio.sleep(replay_lifetime * 2)
                        expired = await client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/close",
                            headers=headers,
                            json={"tab_id": "owned"},
                        )
                        self.assertEqual(
                            expired.json()["error"], "browser_request_capacity_exhausted"
                        )
                        self.assertEqual(len(calls), 1)
            finally:
                parent.close()

        asyncio.run(scenario())

    def test_frozen_scope_close_keeps_execution_and_replay_frozen(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            parent = activities.enter(ActivityDomain.TURN, root=True)
            live = SimpleNamespace(
                turn_activity=parent,
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn-one"),
                active_product_turn_id="product-one",
                product_turn_generation=1,
                interrupt_generation=0,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)
            callbacks = []
            live.bind_browser_scope_end = lambda _scope, callback: callbacks.append(callback)

            async def publish(*_args, **_kwargs):
                return None

            live.publish = publish

            class Host(ScopeHost):
                available = True
                starts = 0
                closures = 0

                async def start_scope(self, **_kwargs):
                    self.starts += 1
                    return {"ok": True}

                async def end_scope(self, **_kwargs):
                    self.available = False
                    return {"ok": False, "error": "request_expired"}

                async def list_tabs(self, **_kwargs):
                    return {"ok": True, "tabs": []}

                async def close_tab(self, **kwargs):
                    if kwargs["tab_id"] != "owned":
                        return {"ok": False, "error": "target_closed"}
                    self.closures += 1
                    return {"ok": True, "tab_id": kwargs["tab_id"]}

            host = Host()
            app = FastAPI()
            register_browser_routes(
                app,
                SimpleNamespace(
                    bridge_caller=lambda identity: live if identity == live.id else None,
                ),
                host,
                activities=activities,
            )
            headers = {
                BRIDGE_SESSION_HEADER: live.id,
                BRIDGE_TOKEN_HEADER: live.bridge_token,
                BRIDGE_CALLBACK_TURN_HEADER: "turn-one",
                BRIDGE_CALLBACK_REQUEST_HEADER: "first",
            }
            try:
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    self.assertTrue(
                        (
                            await client.post(
                                BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={}
                            )
                        ).json()["ok"]
                    )
                    self.assertFalse((await callbacks[0]())["ok"])
                    live.ledger.active_turn_id = "turn-two"
                    live.active_product_turn_id = "product-two"
                    live.product_turn_generation = 2
                    current = {
                        **headers,
                        BRIDGE_CALLBACK_TURN_HEADER: "turn-two",
                        BRIDGE_CALLBACK_REQUEST_HEADER: "close-owned",
                    }
                    for callback_turn in ("turn-one", "future-turn"):
                        invalid = await client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/close",
                            headers={**current, BRIDGE_CALLBACK_TURN_HEADER: callback_turn},
                            json={"tab_id": "owned"},
                        )
                        self.assertEqual(invalid.status_code, 400)
                    closed = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/close",
                        headers=current,
                        json={"tab_id": "owned"},
                    )
                    self.assertTrue(closed.json()["ok"])
                    self.assertEqual(
                        (
                            await client.post(
                                BRIDGE_ROUTE_PREFIX + "browser/close",
                                headers=current,
                                json={"tab_id": "owned"},
                            )
                        ).json(),
                        closed.json(),
                    )
                    self.assertEqual(host.closures, 1)
                    changed = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/close",
                        headers=current,
                        json={"tab_id": "manual"},
                    )
                    self.assertEqual(changed.json()["error"], "browser_request_conflict")
                    for operation in ("list", "open"):
                        blocked = await client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/" + operation,
                            headers={
                                **current,
                                BRIDGE_CALLBACK_REQUEST_HEADER: "blocked-" + operation,
                            },
                            json={},
                        )
                        self.assertEqual(blocked.json()["error"], "browser_request_conflict")
                    self.assertEqual(host.starts, 1)
                    self.assertEqual(len(callbacks), 1)
                    self.assertFalse((await callbacks[0]())["ok"])
                    with patch("service.chat.api.browser.BROWSER_REPLAY_LIMIT", 2):
                        exhausted = await client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/close",
                            headers={**current, BRIDGE_CALLBACK_REQUEST_HEADER: "capacity-close"},
                            json={"tab_id": "owned"},
                        )
                        self.assertEqual(
                            exhausted.json()["error"], "browser_request_capacity_exhausted"
                        )
                    self.assertFalse(getattr(live, "_browser_replay_exhausted", False))
                    self.assertEqual(host.closures, 1)
            finally:
                parent.close()

        asyncio.run(scenario())

    def test_open_close_use_the_live_private_scope_and_replay_once(self) -> None:
        async def scenario(operation: str, payload: dict[str, str]) -> None:
            activities = Activities()
            parent = activities.enter(ActivityDomain.TURN, root=True)
            live = SimpleNamespace(
                turn_activity=parent,
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn"),
                active_product_turn_id="product",
                product_turn_generation=1,
                interrupt_generation=0,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)

            async def publish(*_args, **_kwargs):
                return None

            live.publish = publish

            class Host(ScopeHost):
                available = True
                calls = 0

                async def open_tab(self, **kwargs):
                    self.calls += 1
                    self.assert_scope = kwargs
                    return {"ok": True, "tab_id": "blank-tab"}

                async def close_tab(self, **kwargs):
                    self.calls += 1
                    self.assert_scope = kwargs
                    return {"ok": True, "tab_id": kwargs["tab_id"]}

            host = Host()
            app = FastAPI()
            register_browser_routes(
                app,
                SimpleNamespace(
                    bridge_caller=lambda identity: live if identity == live.id else None
                ),
                host,
                activities=activities,
            )
            headers = {
                BRIDGE_SESSION_HEADER: live.id,
                BRIDGE_TOKEN_HEADER: live.bridge_token,
                BRIDGE_CALLBACK_TURN_HEADER: "turn",
                BRIDGE_CALLBACK_REQUEST_HEADER: "open-blank",
            }
            try:
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    route = BRIDGE_ROUTE_PREFIX + "browser/" + operation
                    self.assertEqual((await client.post(route, json=payload)).status_code, 403)
                    original_client = httpx.AsyncClient

                    def local_client(**kwargs):
                        kwargs["transport"] = httpx.ASGITransport(app=app)
                        return original_client(**kwargs)

                    with (
                        patch.dict(os.environ, {INTERNAL_BASE_URL_ENV: "http://127.0.0.1"}),
                        patch(
                            "service.chat.runtime.tools.httpx.AsyncClient", side_effect=local_client
                        ),
                    ):
                        for callback_id, callback_turn in (
                            ("", "turn"),
                            ("wrong-turn", "other-turn"),
                        ):
                            rejected = await execute_service_tool(
                                {
                                    "capability": "browser",
                                    "operation": operation,
                                    "request": payload,
                                },
                                session_id=live.id,
                                token=live.bridge_token,
                                local_socket=None,
                                callback_request_id=callback_id,
                                callback_turn_id=callback_turn,
                            )
                            self.assertEqual(rejected["error"], "bridge_invalid_callback_request")
                        self.assertEqual(host.calls, 0)
                        opened = await execute_service_tool(
                            {"capability": "browser", "operation": operation, "request": payload},
                            session_id=live.id,
                            token=live.bridge_token,
                            local_socket=None,
                            callback_request_id="open-blank",
                            callback_turn_id="turn",
                        )
                    self.assertEqual(opened, {"ok": True, "tab_id": "blank-tab"})
                    repeated = await client.post(route, headers=headers, json=payload)
                    self.assertEqual(repeated.json(), opened)
                    self.assertEqual(host.calls, 1)
                    self.assertEqual(host.assert_scope["session_id"], live.id)
                    if operation == "close":
                        self.assertEqual(host.assert_scope["tab_id"], "blank-tab")
                    self.assertEqual(
                        (
                            await client.post(
                                route,
                                headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "invalid"},
                                json={**payload, "url": "https://example.org"},
                            )
                        ).status_code,
                        400,
                    )
                    if operation == "close":
                        for invalid in ({}, {"tab_id": ""}, {"tab_id": 1}):
                            self.assertEqual(
                                (
                                    await client.post(
                                        route,
                                        headers=headers,
                                        json=invalid,
                                    )
                                ).status_code,
                                400,
                            )
                        self.assertEqual(host.calls, 1)
                    live.ledger.active_turn_id = ""
                    self.assertEqual(
                        (
                            await client.post(
                                route,
                                headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "late"},
                                json=payload,
                            )
                        ).status_code,
                        403,
                    )
            finally:
                parent.close()

        asyncio.run(scenario("open", {}))
        asyncio.run(scenario("close", {"tab_id": "blank-tab"}))

    def test_update_drain_retains_browser_work_after_parent_turn_closes(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            parent = activities.enter(ActivityDomain.TURN, root=True)
            live = SimpleNamespace(
                turn_activity=parent,
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn"),
                active_product_turn_id="product",
                product_turn_generation=1,
                interrupt_generation=0,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)
            entered, release = asyncio.Event(), asyncio.Event()

            async def publish(*_args, **_kwargs):
                return None

            live.publish = publish

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            class Host(ScopeHost):
                available = True

                async def list_tabs(self, **_kwargs):
                    entered.set()
                    await release.wait()
                    return {"ok": True, "tabs": []}

            app = FastAPI()
            register_browser_routes(app, Sessions(), Host(), activities=activities)
            headers = {
                BRIDGE_SESSION_HEADER: live.id,
                BRIDGE_TOKEN_HEADER: live.bridge_token,
                BRIDGE_CALLBACK_TURN_HEADER: "turn",
                BRIDGE_CALLBACK_REQUEST_HEADER: "request",
            }
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                request = asyncio.create_task(
                    client.post(BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={})
                )
                try:
                    await asyncio.wait_for(entered.wait(), 1)
                    generation = activities.begin()
                    parent.close()
                    self.assertFalse(activities.seal(generation))
                    denied = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={}
                    )
                    self.assertEqual(denied.status_code, 503)
                    release.set()
                    self.assertTrue((await request).json()["ok"])
                    self.assertTrue(activities.seal(generation))
                finally:
                    release.set()
                    await request
                    parent.close()

        asyncio.run(scenario())

    def test_list_replay_checks_current_main_authority_and_never_revives_old_epoch(self) -> None:
        asyncio.run(self.list_replay_authority_scenario(False))

    def test_inflight_list_duplicate_checks_main_authority_after_pending_completion(self) -> None:
        asyncio.run(self.list_replay_authority_scenario(True))

    async def list_replay_authority_scenario(self, inflight: bool) -> None:
        activities = Activities()
        live = SimpleNamespace(
            turn_activity=activities.enter(ActivityDomain.TURN, root=True),
            id="session",
            bridge_token="private-token",
            ledger=SimpleNamespace(active_turn_id="turn"),
            active_product_turn_id="product",
            product_turn_generation=1,
            interrupt_generation=0,
            active_assistant_snapshot_id="snapshot",
        )
        attach_browser_scope(live)
        audits = []

        async def publish(*args, **kwargs):
            audits.append((args, kwargs))

        live.publish = publish

        class Sessions:
            def bridge_caller(self, session_id):
                return live if session_id == live.id else None

        class Host(ScopeHost):
            available = True
            enabled = True
            revision = 1

            def __init__(self):
                self.entries = {}
                self.entered = asyncio.Event()
                self.release = asyncio.Event()
                self.requests = []

            async def list_tabs(self, **kwargs):
                self.requests.append(kwargs)
                request_id = kwargs["request_id"]
                if not self.available or not self.enabled:
                    return {"ok": False, "error": "browser_unavailable"}
                prior = self.entries.get(request_id)
                if prior is not None:
                    return prior[1] if prior[0] == self.revision else {"ok": False}
                result = {
                    "ok": True,
                    "tabs": [{"title": "Private page", "url": "https://example.org/private"}],
                }
                self.entries[request_id] = (self.revision, result)
                self.entered.set()
                if inflight:
                    await self.release.wait()
                return result

        host = Host()
        app = FastAPI()
        register_browser_routes(app, Sessions(), host, activities=activities)
        headers = {
            BRIDGE_SESSION_HEADER: live.id,
            BRIDGE_TOKEN_HEADER: live.bridge_token,
            BRIDGE_CALLBACK_TURN_HEADER: "turn",
            BRIDGE_CALLBACK_REQUEST_HEADER: "original",
        }
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:

            async def listing():
                return (
                    await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={}
                    )
                ).json()

            if inflight:
                first = asyncio.create_task(listing())
                await host.entered.wait()
                duplicate = asyncio.create_task(listing())
                await asyncio.sleep(0)
                host.enabled = False
                host.revision = 2
                host.release.set()
                await first
                self.assertFalse((await duplicate)["ok"])
            else:
                self.assertTrue((await listing())["ok"])
                self.assertTrue((await listing())["ok"])
                self.assertEqual(len(host.entries), 1)
                self.assertEqual(len(audits), 1)
                host.enabled = False
                host.revision = 2
                self.assertFalse((await listing())["ok"])
            host.enabled = True
            host.revision = 3
            self.assertFalse((await listing())["ok"])
            headers[BRIDGE_CALLBACK_REQUEST_HEADER] = "new-epoch"
            self.assertTrue((await listing())["ok"])
            host.available = False
            unavailable = await listing()
            self.assertFalse(unavailable["ok"])
            self.assertNotIn("Private page", str(unavailable))
            self.assertTrue(
                all(call["instance_id"] == "instance-session" for call in host.requests)
            )

    def test_shutdown_drains_browser_before_upstream_teardown(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            teardown_entered = asyncio.Event()
            release_teardown = asyncio.Event()
            body_entered = asyncio.Event()
            release_body = asyncio.Event()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn"),
                active_product_turn_id="product",
                product_turn_generation=1,
                interrupt_generation=0,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            @asynccontextmanager
            async def upstream_lifespan(_application):
                yield
                teardown_entered.set()
                await release_teardown.wait()

            async def body():
                yield b"{"
                body_entered.set()
                await release_body.wait()
                yield b"}"

            app = FastAPI(lifespan=upstream_lifespan)
            register_browser_routes(app, Sessions(), ScopeHost(), activities=activities)
            lifespan = app.router.lifespan_context(app)
            await lifespan.__aenter__()
            try:
                with (
                    patch("service.chat.api.browser.BROWSER_BODY_TIMEOUT_SECONDS", 3600.0),
                    patch("service.chat.api.browser.BROWSER_ROUTE_DRAIN_SECONDS", 0.02),
                ):
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as client:
                        headers = {
                            BRIDGE_SESSION_HEADER: live.id,
                            BRIDGE_TOKEN_HEADER: live.bridge_token,
                        }
                        startup = await client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/navigate",
                            headers=headers,
                            json=VALID_REQUESTS["navigate"],
                        )
                        self.assertEqual(startup.json()["error"], "bridge_invalid_callback_request")
                        pending = asyncio.create_task(
                            client.post(
                                BRIDGE_ROUTE_PREFIX + "browser/list",
                                headers=headers,
                                content=body(),
                            )
                        )
                        await asyncio.wait_for(body_entered.wait(), timeout=1)
                        shutdown = asyncio.create_task(lifespan.__aexit__(None, None, None))
                        await asyncio.wait_for(teardown_entered.wait(), timeout=1)
                        self.assertTrue(pending.done())
                        late = await client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/navigate",
                            headers=headers,
                            json=VALID_REQUESTS["navigate"],
                        )
                        self.assertEqual(late.json()["error"], "browser_unavailable")
                        release_teardown.set()
                        await asyncio.wait_for(shutdown, timeout=1)
            finally:
                release_body.set()
                release_teardown.set()

        asyncio.run(scenario())

    def test_partial_browser_body_has_an_absolute_read_deadline(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            entered = asyncio.Event()
            release = asyncio.Event()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn"),
                active_product_turn_id="product",
                product_turn_generation=1,
                interrupt_generation=0,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            class Host(ScopeHost):
                available = True
                starts = 0

                async def start_scope(self, **_kwargs):
                    self.starts += 1
                    return {"ok": True}

            async def body():
                yield b"{"
                entered.set()
                await release.wait()
                yield b"}"

            host = Host()
            app = FastAPI()
            register_browser_routes(app, Sessions(), host, activities=activities)
            try:
                with patch(
                    "service.chat.api.browser.BROWSER_BODY_TIMEOUT_SECONDS", 0.02, create=True
                ):
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as client:
                        response = await asyncio.wait_for(
                            client.post(
                                BRIDGE_ROUTE_PREFIX + "browser/list",
                                headers={
                                    BRIDGE_SESSION_HEADER: live.id,
                                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                                },
                                content=body(),
                            ),
                            timeout=0.5,
                        )
                self.assertEqual(response.status_code, 408)
                self.assertEqual(host.starts, 0)
            finally:
                release.set()

        asyncio.run(scenario())

    def test_shutdown_cancels_a_half_open_browser_body(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            entered = asyncio.Event()
            release = asyncio.Event()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn"),
                active_product_turn_id="product",
                product_turn_generation=1,
                interrupt_generation=0,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            async def body():
                yield b"{"
                entered.set()
                await release.wait()
                yield b"}"

            app = FastAPI()
            register_browser_routes(app, Sessions(), ScopeHost(), activities=activities)
            lifespan = app.router.lifespan_context(app)
            await lifespan.__aenter__()
            try:
                with (
                    patch(
                        "service.chat.api.browser.BROWSER_BODY_TIMEOUT_SECONDS", 3600.0, create=True
                    ),
                    patch(
                        "service.chat.api.browser.BROWSER_ROUTE_DRAIN_SECONDS", 0.02, create=True
                    ),
                ):
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as client:
                        pending = asyncio.create_task(
                            client.post(
                                BRIDGE_ROUTE_PREFIX + "browser/list",
                                headers={
                                    BRIDGE_SESSION_HEADER: live.id,
                                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                                },
                                content=body(),
                            )
                        )
                        await asyncio.wait_for(entered.wait(), timeout=1)
                        closing = asyncio.create_task(lifespan.__aexit__(None, None, None))
                        await asyncio.wait_for(asyncio.shield(closing), timeout=0.5)
                        self.assertTrue(pending.done())
            finally:
                release.set()

        asyncio.run(scenario())

    def test_completed_scope_reclaims_serve_replay_without_reopening_old_turn(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn-one"),
                active_product_turn_id="product-one",
                product_turn_generation=1,
                interrupt_generation=0,
                active_assistant_snapshot_id="snapshot",
                browser_scope_instance="instance",
                attachment_generation=1,
            )

            async def publish(*_args, **_kwargs):
                return None

            live.publish = publish
            callbacks = []
            live.bind_browser_scope_end = lambda _scope, callback: callbacks.append(callback)

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            class Host(ScopeHost):
                available = True
                calls = 0

                async def list_tabs(self, **_kwargs):
                    self.calls += 1
                    return {"ok": True, "tabs": []}

            host = Host()
            app = FastAPI()
            register_browser_routes(app, Sessions(), host, activities=activities)
            with patch("service.chat.api.browser.BROWSER_REPLAY_LIMIT", 1):
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    headers = {
                        BRIDGE_SESSION_HEADER: live.id,
                        BRIDGE_TOKEN_HEADER: live.bridge_token,
                        BRIDGE_CALLBACK_TURN_HEADER: "turn-one",
                        BRIDGE_CALLBACK_REQUEST_HEADER: "first",
                    }
                    self.assertTrue(
                        (
                            await client.post(
                                BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={}
                            )
                        ).json()["ok"]
                    )
                    self.assertTrue((await callbacks[0]())["ok"])
                    live.ledger.active_turn_id = "turn-two"
                    live.active_product_turn_id = "product-two"
                    live.product_turn_generation = 2
                    stale = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "old-retry"},
                        json={},
                    )
                    self.assertEqual(stale.status_code, 400)
                    fresh = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list",
                        headers={
                            **headers,
                            BRIDGE_CALLBACK_TURN_HEADER: "turn-two",
                            BRIDGE_CALLBACK_REQUEST_HEADER: "second",
                        },
                        json={},
                    )
                    self.assertTrue(fresh.json()["ok"])
                    self.assertEqual(host.calls, 2)

        asyncio.run(scenario())

    def test_released_product_turn_ends_bound_browser_scope_once(self) -> None:
        async def scenario() -> None:
            live = object.__new__(LiveSession)
            live.active_product_turn_id = "product"
            live.runtime_session = None
            live._browser_scope = None
            live._browser_scope_lock = asyncio.Lock()
            live._browser_delivery_lock = asyncio.Lock()
            live._catalog = SimpleNamespace(archive_browser_action_scope=lambda _scope: 0)
            calls = []
            scope = {"session_id": "session", "generation": 1}

            async def end():
                calls.append("end")
                return {"ok": True}

            live.bind_browser_scope_end(scope, end)
            self.assertTrue(await live.release_product_turn("product"))
            self.assertEqual(live.active_product_turn_id, "")
            self.assertEqual(calls, ["end"])
            self.assertTrue(await live.end_browser_scope())
            self.assertEqual(calls, ["end"])

        asyncio.run(scenario())

    def test_failed_scope_end_does_not_archive_browser_actions(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory(prefix="browser-ledger-") as temporary:
                catalog = SessionCatalogStore(Path(temporary) / "catalog.sqlite3")
                catalog.allocate(
                    "browser-session",
                    SessionPrincipal("owner"),
                    runtime_id="codex",
                    runtime_workdir="/research",
                    project_path="/research",
                    output_root="/research/out",
                )
                scope = {
                    "session_id": "browser-session",
                    "instance_id": "instance-browser",
                    "product_turn_id": "product-one",
                    "turn_id": "native-one",
                    "generation": 1,
                    "interrupt_generation": 0,
                    "lifecycle_epoch": 1,
                }
                catalog.reserve_browser_action(
                    request_id="browser-action", scope=scope, operation="read", payload={}
                )
                catalog.transition_browser_action("browser-action", "pending", "approved")
                catalog.transition_browser_action("browser-action", "approved", "dispatching")
                catalog.transition_browser_action("browser-action", "dispatching", "succeeded")
                live = object.__new__(LiveSession)
                live._catalog = catalog
                live._browser_scope = None
                live._browser_scope_lock = asyncio.Lock()
                live._browser_delivery_lock = asyncio.Lock()
                outcomes = iter(({"ok": False}, {"ok": True}))

                async def end():
                    return next(outcomes)

                live.bind_browser_scope_end(scope, end)
                self.assertFalse(await live.end_browser_scope())
                self.assertIsNotNone(catalog.browser_action("browser-action"))
                with patch("service.chat.persistence.catalog.MAX_BROWSER_ACTION_RECORDS", 1):
                    with self.assertRaisesRegex(RuntimeError, "browser action capacity"):
                        catalog.reserve_browser_action(
                            request_id="browser-next",
                            scope={**scope, "generation": 2},
                            operation="read",
                            payload={},
                        )
                self.assertTrue(await live.end_browser_scope())
                self.assertIsNone(catalog.browser_action("browser-action"))

        asyncio.run(scenario())

    def test_suspend_without_runtime_ends_bound_browser_scope(self) -> None:
        async def scenario() -> None:
            live = object.__new__(LiveSession)
            live.lifecycle_lock = asyncio.Lock()
            live.runtime_driver = None
            live.active_product_turn_id = "product"
            live._browser_scope = None
            live._browser_scope_lock = asyncio.Lock()
            live._browser_delivery_lock = asyncio.Lock()
            live._catalog = SimpleNamespace(archive_browser_action_scope=lambda _scope: 0)
            calls = []

            async def end():
                calls.append("end")
                return {"ok": True}

            live.bind_browser_scope_end({"session_id": "session", "generation": 1}, end)
            self.assertTrue(await live.suspend_runtime())
            self.assertEqual(live.active_product_turn_id, "")
            self.assertEqual(calls, ["end"])

        asyncio.run(scenario())

    def test_scope_end_rejects_another_inflight_list_result(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="vendor"),
                active_product_turn_id="product",
                product_turn_generation=1,
                interrupt_generation=0,
                active_assistant_snapshot_id="snapshot",
                browser_scope_instance="instance",
                attachment_generation=1,
            )

            async def publish(*_args, **_kwargs):
                return None

            live.publish = publish
            callbacks = []
            live.bind_browser_scope_end = lambda _scope, callback: callbacks.append(callback)
            listing_started = asyncio.Event()
            listing_released = asyncio.Event()

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            class Host(ScopeHost):
                available = True

                async def list_tabs(self, **kwargs):
                    if kwargs["request_id"] == "second":
                        listing_started.set()
                        await listing_released.wait()
                    return {"ok": True, "tabs": []}

            app = FastAPI()
            register_browser_routes(app, Sessions(), Host(), activities=activities)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                headers = {
                    BRIDGE_SESSION_HEADER: live.id,
                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                    BRIDGE_CALLBACK_TURN_HEADER: "vendor",
                }
                first = await client.post(
                    BRIDGE_ROUTE_PREFIX + "browser/list",
                    headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "first"},
                    json={},
                )
                self.assertTrue(first.json()["ok"])
                second = asyncio.create_task(
                    client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "second"},
                        json={},
                    )
                )
                await listing_started.wait()
                self.assertTrue((await callbacks[0]())["ok"])
                listing_released.set()
                result = await second
                self.assertEqual(result.status_code, 403)
                self.assertEqual(result.json()["error"], "bridge_access_denied")

        asyncio.run(scenario())

    def test_list_requires_a_live_main_scope_before_reading_tabs(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="vendor"),
                active_product_turn_id="product",
                product_turn_generation=3,
                interrupt_generation=1,
                active_assistant_snapshot_id="snapshot",
                browser_scope_instance="instance",
                attachment_generation=7,
            )

            async def publish(*_args, **_kwargs):
                return None

            live.publish = publish
            scopes = []
            live.bind_browser_scope_end = lambda scope, callback: scopes.append((scope, callback))

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            class Host(ScopeHost):
                available = True
                calls = []

                async def start_scope(self, **kwargs):
                    self.calls.append(("start", kwargs))
                    return {"ok": True}

                async def list_tabs(self, **kwargs):
                    self.calls.append(("list", kwargs))
                    return {"ok": True, "tabs": []}

                async def end_scope(self, **kwargs):
                    self.calls.append(("end", kwargs))
                    return {"ok": True}

            host = Host()
            app = FastAPI()
            register_browser_routes(app, Sessions(), host, activities=activities)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.post(
                    BRIDGE_ROUTE_PREFIX + "browser/list",
                    headers={
                        BRIDGE_SESSION_HEADER: live.id,
                        BRIDGE_TOKEN_HEADER: live.bridge_token,
                        BRIDGE_CALLBACK_REQUEST_HEADER: "callback",
                        BRIDGE_CALLBACK_TURN_HEADER: "vendor",
                    },
                    json={},
                )
            self.assertTrue(response.json()["ok"])
            self.assertEqual([action for action, _ in host.calls], ["start", "list"])
            self.assertEqual(
                host.calls[0][1],
                {
                    "session_id": "session",
                    "instance_id": "instance",
                    "product_turn_id": "product",
                    "turn_id": "vendor",
                    "generation": 3,
                    "interrupt_generation": 1,
                    "lifecycle_epoch": 7,
                },
            )
            self.assertEqual(len(scopes), 1)
            self.assertTrue((await scopes[0][1]())["ok"])
            self.assertEqual(host.calls[-1][0], "end")

        asyncio.run(scenario())

    def test_replay_does_not_block_other_sessions_or_repeat_pending_call(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            first_started = asyncio.Event()
            release_first = asyncio.Event()
            lives = {
                session_id: SimpleNamespace(
                    turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                    id=session_id,
                    bridge_token="private-token",
                    ledger=SimpleNamespace(active_turn_id="turn"),
                    active_product_turn_id="product-turn",
                    product_turn_generation=1,
                    interrupt_generation=0,
                    active_assistant_snapshot_id="snapshot",
                )
                for session_id in ("first", "second")
            }
            for live in lives.values():
                attach_browser_scope(live)

                async def publish(*_args, **_kwargs):
                    return None

                live.publish = publish

            class Sessions:
                def bridge_caller(self, session_id):
                    return lives.get(session_id)

            class Host(ScopeHost):
                available = True

                def __init__(self):
                    self.calls = []

                async def list_tabs(self, **kwargs):
                    self.calls.append(kwargs)
                    if kwargs["session_id"] == "first":
                        first_started.set()
                        await release_first.wait()
                    return {"ok": True, "tabs": []}

            host = Host()
            app = FastAPI()
            register_browser_routes(app, Sessions(), host, activities=activities)

            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:

                def headers(session_id):
                    return {
                        BRIDGE_SESSION_HEADER: session_id,
                        BRIDGE_TOKEN_HEADER: "private-token",
                        BRIDGE_CALLBACK_REQUEST_HEADER: "callback-123",
                        BRIDGE_CALLBACK_TURN_HEADER: "turn",
                    }

                first = asyncio.create_task(
                    client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers("first"), json={}
                    )
                )
                await asyncio.wait_for(first_started.wait(), timeout=1)
                duplicate = asyncio.create_task(
                    client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers("first"), json={}
                    )
                )
                second = await asyncio.wait_for(
                    client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers("second"), json={}
                    ),
                    timeout=1,
                )
                self.assertEqual(second.status_code, 200)
                self.assertEqual(len(host.calls), 2)
                release_first.set()
                self.assertEqual((await first).json(), (await duplicate).json())
                self.assertEqual(len(host.calls), 3)

        asyncio.run(scenario())

    def test_cancelled_owner_keeps_callback_terminal(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            started = asyncio.Event()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn"),
                active_product_turn_id="product-turn",
                product_turn_generation=1,
                interrupt_generation=0,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)

            async def publish(*_args, **_kwargs):
                return None

            live.publish = publish

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            class Host(ScopeHost):
                available = True
                calls = 0

                async def list_tabs(self, **_kwargs):
                    self.calls += 1
                    started.set()
                    await asyncio.Event().wait()

            host = Host()
            app = FastAPI()
            register_browser_routes(app, Sessions(), host, activities=activities)
            headers = {
                BRIDGE_SESSION_HEADER: live.id,
                BRIDGE_TOKEN_HEADER: live.bridge_token,
                BRIDGE_CALLBACK_REQUEST_HEADER: "callback-cancelled",
                BRIDGE_CALLBACK_TURN_HEADER: "turn",
            }
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                first = asyncio.create_task(
                    client.post(BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={})
                )
                await asyncio.wait_for(started.wait(), timeout=1)
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                repeated = await asyncio.wait_for(
                    client.post(BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={}),
                    timeout=1,
                )
                self.assertFalse(repeated.json()["ok"])
                self.assertEqual(host.calls, 1)

        asyncio.run(scenario())

    def test_uncertain_start_is_revoked_before_a_new_lifecycle(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn-one"),
                active_product_turn_id="product-one",
                product_turn_generation=1,
                interrupt_generation=0,
                attachment_generation=1,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)

            async def publish(*_args, **_kwargs):
                return None

            live.publish = publish

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            class Host(ScopeHost):
                available = True

                def __init__(self):
                    self.started = []
                    self.ended = []

                async def start_scope(self, **kwargs):
                    self.started.append(kwargs)
                    if len(self.started) == 1:
                        return {"ok": False, "error": "browser_unavailable"}
                    if len(self.started) == 3:
                        return {"ok": False, "error": "stale_scope"}
                    return {"ok": True}

                async def end_scope(self, **kwargs):
                    self.ended.append(kwargs)
                    return {"ok": True}

                async def list_tabs(self, **_kwargs):
                    return {"ok": True, "tabs": []}

            host = Host()
            app = FastAPI()
            register_browser_routes(app, Sessions(), host, activities=activities)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                headers = {
                    BRIDGE_SESSION_HEADER: live.id,
                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                    BRIDGE_CALLBACK_TURN_HEADER: "turn-one",
                    BRIDGE_CALLBACK_REQUEST_HEADER: "first",
                }
                first = await client.post(
                    BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={}
                )
                self.assertFalse(first.json()["ok"])
                self.assertEqual(host.ended, host.started)
                live.ledger.active_turn_id = "turn-two"
                live.active_product_turn_id = "product-two"
                live.product_turn_generation = 1
                live.attachment_generation = 2
                second = await client.post(
                    BRIDGE_ROUTE_PREFIX + "browser/list",
                    headers={
                        **headers,
                        BRIDGE_CALLBACK_TURN_HEADER: "turn-two",
                        BRIDGE_CALLBACK_REQUEST_HEADER: "second",
                    },
                    json={},
                )
                self.assertTrue(second.json()["ok"])
                rejected = await client.post(
                    BRIDGE_ROUTE_PREFIX + "browser/list",
                    headers={
                        **headers,
                        BRIDGE_CALLBACK_TURN_HEADER: "turn-two",
                        BRIDGE_CALLBACK_REQUEST_HEADER: "third",
                    },
                    json={},
                )
                self.assertFalse(rejected.json()["ok"])
                self.assertEqual(len(host.ended), 1)

        asyncio.run(scenario())

    def test_cancelled_scope_start_is_revoked(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn"),
                active_product_turn_id="product",
                product_turn_generation=1,
                interrupt_generation=0,
                attachment_generation=1,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)

            async def publish(*_args, **_kwargs):
                return None

            live.publish = publish
            entered = asyncio.Event()

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            class Host(ScopeHost):
                available = True

                def __init__(self):
                    self.ended = []

                async def start_scope(self, **_kwargs):
                    entered.set()
                    await asyncio.Event().wait()

                async def end_scope(self, **kwargs):
                    self.ended.append(kwargs)
                    return {"ok": True}

            host = Host()
            app = FastAPI()
            register_browser_routes(app, Sessions(), host, activities=activities)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                pending = asyncio.create_task(
                    client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list",
                        headers={
                            BRIDGE_SESSION_HEADER: live.id,
                            BRIDGE_TOKEN_HEADER: live.bridge_token,
                            BRIDGE_CALLBACK_TURN_HEADER: "turn",
                            BRIDGE_CALLBACK_REQUEST_HEADER: "cancelled",
                        },
                        json={},
                    )
                )
                await asyncio.wait_for(entered.wait(), timeout=1)
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
                self.assertEqual(len(host.ended), 1)

        asyncio.run(scenario())

    def test_second_cancel_leaves_scope_end_tracked_until_shutdown_drain(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn"),
                active_product_turn_id="product",
                product_turn_generation=1,
                interrupt_generation=0,
                attachment_generation=1,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)
            live.publish = lambda *_args, **_kwargs: None
            start_entered = asyncio.Event()
            end_entered = asyncio.Event()
            finish_end = asyncio.Event()
            end_finished = asyncio.Event()

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            class Host(ScopeHost):
                available = True

                async def start_scope(self, **_kwargs):
                    start_entered.set()
                    await asyncio.Event().wait()

                async def end_scope(self, **_kwargs):
                    end_entered.set()
                    await finish_end.wait()
                    end_finished.set()
                    return {"ok": True}

            app = FastAPI()
            register_browser_routes(app, Sessions(), Host(), activities=activities)
            lifespan = app.router.lifespan_context(app)
            await lifespan.__aenter__()
            try:
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    pending = asyncio.create_task(
                        client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/list",
                            headers={
                                BRIDGE_SESSION_HEADER: live.id,
                                BRIDGE_TOKEN_HEADER: live.bridge_token,
                                BRIDGE_CALLBACK_TURN_HEADER: "turn",
                                BRIDGE_CALLBACK_REQUEST_HEADER: "cancel-twice",
                            },
                            json={},
                        )
                    )
                    await asyncio.wait_for(start_entered.wait(), timeout=1)
                    pending.cancel()
                    await asyncio.wait_for(end_entered.wait(), timeout=1)
                    pending.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await pending
                    closing = asyncio.create_task(lifespan.__aexit__(None, None, None))
                    await asyncio.sleep(0)
                    self.assertFalse(closing.done())
                    closing.cancel()
                    await asyncio.sleep(0)
                    closing.cancel()
                    await asyncio.sleep(0)
                    self.assertFalse(closing.done())
                    finish_end.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(closing, timeout=1)
                    self.assertTrue(end_finished.is_set())
            finally:
                finish_end.set()

        asyncio.run(scenario())

    def test_repeated_shutdown_cancel_keeps_scope_end_before_upstream_teardown(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            start_entered = asyncio.Event()
            end_entered = asyncio.Event()
            finish_end = asyncio.Event()
            end_finished = asyncio.Event()
            teardown_entered = asyncio.Event()
            listener_closed = asyncio.Event()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn"),
                active_product_turn_id="product",
                product_turn_generation=1,
                interrupt_generation=0,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            class Host(ScopeHost):
                available = True

                async def start_scope(self, **_kwargs):
                    start_entered.set()
                    await asyncio.Event().wait()

                async def end_scope(self, **_kwargs):
                    end_entered.set()
                    await finish_end.wait()
                    end_finished.set()
                    return {"ok": True}

            @asynccontextmanager
            async def upstream_lifespan(_application):
                try:
                    yield
                finally:
                    teardown_entered.set()

            app = FastAPI(lifespan=upstream_lifespan)
            register_browser_routes(app, Sessions(), Host(), activities=activities)

            @asynccontextmanager
            async def listener_lifespan(application):
                try:
                    async with application.router.lifespan_context(application):
                        yield
                finally:
                    listener_closed.set()

            lifespan = listener_lifespan(app)
            await lifespan.__aenter__()
            try:
                with patch("service.chat.api.browser.BROWSER_ROUTE_DRAIN_SECONDS", 0.02):
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as client:
                        pending = asyncio.create_task(
                            client.post(
                                BRIDGE_ROUTE_PREFIX + "browser/list",
                                headers={
                                    BRIDGE_SESSION_HEADER: live.id,
                                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                                    BRIDGE_CALLBACK_TURN_HEADER: "turn",
                                    BRIDGE_CALLBACK_REQUEST_HEADER: "shutdown-cancel",
                                },
                                json={},
                            )
                        )
                        await asyncio.wait_for(start_entered.wait(), timeout=1)
                        shutdown = asyncio.create_task(lifespan.__aexit__(None, None, None))
                        await asyncio.wait_for(end_entered.wait(), timeout=1)
                        shutdown.cancel()
                        await asyncio.sleep(0)
                        shutdown.cancel()
                        await asyncio.sleep(0)
                        self.assertFalse(teardown_entered.is_set())
                        self.assertFalse(shutdown.done())
                        finish_end.set()
                        with self.assertRaises(asyncio.CancelledError):
                            await asyncio.wait_for(shutdown, timeout=1)
                        self.assertTrue(end_finished.is_set())
                        self.assertTrue(teardown_entered.is_set())
                        self.assertTrue(listener_closed.is_set())
                        self.assertTrue(pending.done())
            finally:
                finish_end.set()

        asyncio.run(scenario())

    def test_shutdown_waits_for_inflight_scope_start_and_its_late_end(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn"),
                active_product_turn_id="product",
                product_turn_generation=1,
                interrupt_generation=0,
                attachment_generation=1,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)
            entered = asyncio.Event()
            release = asyncio.Event()
            ended = asyncio.Event()

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            class Host(ScopeHost):
                available = True

                async def start_scope(self, **_kwargs):
                    entered.set()
                    await release.wait()
                    return {"ok": True}

                async def end_scope(self, **_kwargs):
                    ended.set()
                    return {"ok": True}

            app = FastAPI()
            register_browser_routes(app, Sessions(), Host(), activities=activities)
            lifespan = app.router.lifespan_context(app)
            await lifespan.__aenter__()
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                pending = asyncio.create_task(
                    client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list",
                        headers={
                            BRIDGE_SESSION_HEADER: live.id,
                            BRIDGE_TOKEN_HEADER: live.bridge_token,
                            BRIDGE_CALLBACK_TURN_HEADER: "turn",
                            BRIDGE_CALLBACK_REQUEST_HEADER: "inflight",
                        },
                        json={},
                    )
                )
                await asyncio.wait_for(entered.wait(), timeout=1)
                closing = asyncio.create_task(lifespan.__aexit__(None, None, None))
                await asyncio.sleep(0)
                self.assertFalse(closing.done())
                release.set()
                response = await asyncio.wait_for(pending, timeout=1)
                self.assertFalse(response.json()["ok"])
                await asyncio.wait_for(closing, timeout=1)
                self.assertTrue(ended.is_set())

        asyncio.run(scenario())

    def test_replay_keeps_historical_ids_and_fails_closed_at_global_capacity(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            lives = {
                session_id: SimpleNamespace(
                    turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                    id=session_id,
                    bridge_token="private-token",
                    ledger=SimpleNamespace(active_turn_id="turn"),
                    active_product_turn_id="product-turn",
                    product_turn_generation=1,
                    interrupt_generation=0,
                    active_assistant_snapshot_id="snapshot",
                )
                for session_id in ("first", "second", "third")
            }
            for live in lives.values():
                attach_browser_scope(live)

                async def publish(*_args, **_kwargs):
                    return None

                live.publish = publish

            class Sessions:
                def bridge_caller(self, session_id):
                    return lives.get(session_id)

            class Host(ScopeHost):
                available = True
                calls = 0

                async def list_tabs(self, **_kwargs):
                    self.calls += 1
                    return {"ok": True, "tabs": []}

            host = Host()
            app = FastAPI()
            register_browser_routes(app, Sessions(), host, activities=activities)

            async def listing(client, session_id, request_id):
                return await client.post(
                    BRIDGE_ROUTE_PREFIX + "browser/list",
                    headers={
                        BRIDGE_SESSION_HEADER: session_id,
                        BRIDGE_TOKEN_HEADER: "private-token",
                        BRIDGE_CALLBACK_REQUEST_HEADER: request_id,
                        BRIDGE_CALLBACK_TURN_HEADER: "turn",
                    },
                    json={},
                )

            with patch("service.chat.api.browser.BROWSER_REPLAY_LIMIT", 2):
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    self.assertTrue((await listing(client, "first", "callback-one")).json()["ok"])
                    self.assertTrue((await listing(client, "first", "callback-two")).json()["ok"])
                    self.assertTrue((await listing(client, "second", "callback-one")).json()["ok"])
                    self.assertEqual(
                        (await listing(client, "first", "callback-one")).json()["error"],
                        "browser_request_capacity_exhausted",
                    )
                    self.assertTrue((await listing(client, "third", "callback-one")).json()["ok"])
            self.assertEqual(host.calls, 4)

        asyncio.run(scenario())

    def test_expired_replay_session_cannot_reexecute_historical_id(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            live = SimpleNamespace(
                turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                id="session",
                bridge_token="private-token",
                ledger=SimpleNamespace(active_turn_id="turn"),
                active_product_turn_id="product-turn",
                product_turn_generation=1,
                interrupt_generation=0,
                active_assistant_snapshot_id="snapshot",
            )
            attach_browser_scope(live)

            async def publish(*_args, **_kwargs):
                return None

            live.publish = publish

            class Sessions:
                def bridge_caller(self, session_id):
                    return live if session_id == live.id else None

            class Host(ScopeHost):
                available = True
                calls = 0

                async def list_tabs(self, **_kwargs):
                    self.calls += 1
                    return {"ok": True, "tabs": []}

            host = Host()
            app = FastAPI()
            register_browser_routes(app, Sessions(), host, activities=activities)
            headers = {
                BRIDGE_SESSION_HEADER: live.id,
                BRIDGE_TOKEN_HEADER: live.bridge_token,
                BRIDGE_CALLBACK_REQUEST_HEADER: "callback-one",
                BRIDGE_CALLBACK_TURN_HEADER: "turn",
            }
            with patch(
                "service.chat.api.browser.BROWSER_REPLAY_LIFETIME_SECONDS", 0.01, create=True
            ):
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    first = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={}
                    )
                    self.assertTrue(first.json()["ok"])
                    await asyncio.sleep(0.02)
                    repeated = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={}
                    )
                    self.assertEqual(repeated.json()["error"], "browser_request_capacity_exhausted")
            self.assertEqual(host.calls, 1)

        asyncio.run(scenario())

    def test_runtime_callback_identity_is_forwarded_and_replayed_once(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            with tempfile.TemporaryDirectory(prefix="browser-callback-") as directory:
                catalog = SessionCatalogStore(Path(directory) / "session.sqlite3")
                catalog.register(
                    "browser-session",
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
                    id="browser-session",
                    bridge_token="private-token",
                    ledger=SimpleNamespace(active_turn_id="turn"),
                    active_product_turn_id="product-turn",
                    product_turn_generation=1,
                    interrupt_generation=0,
                    active_assistant_snapshot_id="snapshot",
                )
                attach_browser_scope(live)
                published = []

                async def publish(kind, data, *, turn_id="", idempotency_key=""):
                    published.append((kind, data, turn_id, idempotency_key))

                live.publish = publish

                class Sessions:
                    def bridge_caller(self, session_id):
                        return live if session_id == live.id else None

                class Host(ScopeHost):
                    available = True

                    def __init__(self):
                        self.requests = []

                    async def list_tabs(self, **kwargs):
                        self.requests.append(kwargs)
                        return {"ok": True, "tabs": [{"tab_id": "tab"}]}

                host = Host()
                app = FastAPI()
                register_browser_routes(app, Sessions(), host, activities=activities)
                headers = {
                    BRIDGE_SESSION_HEADER: live.id,
                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                    BRIDGE_CALLBACK_REQUEST_HEADER: "callback-123",
                    BRIDGE_CALLBACK_TURN_HEADER: "turn",
                }
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    first = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={}
                    )
                    again = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={}
                    )
                    missing = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list",
                        headers={
                            k: v for k, v in headers.items() if k != BRIDGE_CALLBACK_REQUEST_HEADER
                        },
                        json={},
                    )
                    malformed = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "x" * 129},
                        json={},
                    )
                self.assertEqual(first.json(), again.json())
                self.assertEqual(len(host.requests), 2)
                self.assertEqual(
                    host.requests[:1],
                    [
                        {
                            "session_id": live.id,
                            "instance_id": live.browser_scope_instance,
                            "product_turn_id": "product-turn",
                            "turn_id": "turn",
                            "generation": 1,
                            "interrupt_generation": 0,
                            "lifecycle_epoch": 1,
                            "request_id": "callback-123",
                        }
                    ],
                )
                self.assertEqual(host.requests[0], host.requests[1])
                self.assertEqual(len(published), 1)
                self.assertEqual(missing.status_code, 400)
                self.assertEqual(malformed.status_code, 400)

                live.ledger.active_turn_id = "next-turn"
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    conflict = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={}
                    )
                self.assertEqual(conflict.status_code, 400)
                self.assertEqual(conflict.json()["error"], "bridge_invalid_callback_request")
                self.assertEqual(len(host.requests), 2)

        asyncio.run(scenario())

    def test_runtime_tool_sends_callback_identity_outside_model_payload(self) -> None:
        observed = []

        def respond(request: httpx.Request) -> httpx.Response:
            observed.append((request.headers, request.content))
            return httpx.Response(200, json={"ok": True, "tabs": []})

        original_client = httpx.AsyncClient

        def local_client(**kwargs):
            kwargs["transport"] = httpx.MockTransport(respond)
            return original_client(**kwargs)

        with (
            patch.dict(os.environ, {INTERNAL_BASE_URL_ENV: "http://127.0.0.1"}),
            patch("service.chat.runtime.tools.httpx.AsyncClient", side_effect=local_client),
        ):
            for operation in OPERATIONS:
                with self.subTest(operation=operation):
                    result = asyncio.run(
                        execute_service_tool(
                            {
                                "capability": "browser",
                                "operation": operation,
                                "request": VALID_REQUESTS[operation],
                            },
                            session_id="browser-session",
                            token="private-token",
                            local_socket=None,
                            callback_request_id="callback-123",
                            callback_turn_id="vendor-turn",
                        )
                    )
                    self.assertEqual(result["ok"], True)
                    self.assertEqual(
                        observed[-1][0][BRIDGE_CALLBACK_REQUEST_HEADER], "callback-123"
                    )
                    self.assertEqual(observed[-1][0][BRIDGE_CALLBACK_TURN_HEADER], "vendor-turn")
                    self.assertEqual(json.loads(observed[-1][1]), VALID_REQUESTS[operation])
                    self.assertNotIn(BRIDGE_CALLBACK_REQUEST_HEADER, json.loads(observed[-1][1]))

    def test_runtime_browser_action_timeout_covers_approval_and_main_execution(self) -> None:
        timeouts = []
        original_client = httpx.AsyncClient

        def local_client(**kwargs):
            timeouts.append(kwargs["timeout"])
            kwargs["transport"] = httpx.MockTransport(
                lambda _request: httpx.Response(
                    200, json={"ok": False, "error": "browser_action_unavailable"}
                )
            )
            return original_client(**kwargs)

        with (
            patch.dict(os.environ, {INTERNAL_BASE_URL_ENV: "http://127.0.0.1"}),
            patch("service.chat.runtime.tools.httpx.AsyncClient", side_effect=local_client),
        ):
            for operation in ("snapshot", "read", "navigate", "interact", "submit"):
                result = asyncio.run(
                    execute_service_tool(
                        {
                            "capability": "browser",
                            "operation": operation,
                            "request": VALID_REQUESTS[operation],
                        },
                        session_id="browser-session",
                        token="private-token",
                        local_socket=None,
                        callback_request_id="callback-1",
                        callback_turn_id="turn",
                    )
                )
                self.assertEqual(result["error"], "browser_action_unavailable")
        self.assertEqual(len(timeouts), 5)
        self.assertTrue(all(timeout.read >= 120 for timeout in timeouts))

    def test_read_only_route_uses_durable_reservation_and_replays_without_dispatch(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            with tempfile.TemporaryDirectory(prefix="browser-read-route-") as directory:
                catalog = SessionCatalogStore(Path(directory) / "session.sqlite3")
                catalog.register(
                    "browser-session",
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
                    id="browser-session",
                    bridge_token="private-token",
                    runtime_id="codex",
                    vendor_thread_id="thread",
                    ledger=SimpleNamespace(active_turn_id="turn"),
                    active_product_turn_id="product-turn",
                    product_turn_generation=1,
                    interrupt_generation=0,
                    active_assistant_snapshot_id="assistant-snapshot",
                    catalog=catalog,
                )
                attach_browser_scope(live)
                published = []

                async def publish(kind, data, *, turn_id="", idempotency_key=""):
                    published.append((kind, data))

                live.publish = publish

                class Sessions:
                    def bridge_caller(self, session_id):
                        return live if session_id == live.id else None

                class Host(ScopeHost):
                    available = True
                    snapshots = 0
                    reads = 0
                    policy_decision = "allow"
                    snapshot_requests = []
                    cancelled_requests = []
                    snapshot_error = None
                    read_error = None

                    async def prepare_read(self, **kwargs):
                        return {
                            "ok": True,
                            "proof": {
                                "proof_id": "main-proof",
                                "request_id": kwargs["request_id"],
                                "scope": {
                                    "sessionId": live.id,
                                    "instanceId": live.browser_scope_instance,
                                    "productTurnId": live.active_product_turn_id,
                                    "turnId": "turn",
                                    "generation": 1,
                                    "interruptGeneration": 0,
                                    "lifecycleEpoch": 1,
                                },
                                "tab_id": "browser-tab",
                                "target_instance_id": "tab-instance",
                                "target_generation": 1,
                                "origin": "https://example.org",
                                "intent": kwargs["intent"],
                                "expires_at": int((time.time() + 60) * 1000),
                                "policy_revision": 1,
                                "policy_decision": self.policy_decision,
                            },
                        }

                    async def snapshot(self, **kwargs):
                        self.snapshots += 1
                        self.snapshot_requests.append(kwargs)
                        if self.snapshot_error is not None:
                            return {"ok": False, "error": self.snapshot_error}
                        return {
                            "ok": True,
                            "snapshot": {
                                "snapshot_id": "main-snapshot",
                                "origin": "https://example.org",
                                "title": "Untrusted page",
                                "elements": [
                                    {
                                        "element_ref": "main-ref",
                                        "role": "link",
                                        "name": "Untrusted text",
                                    }
                                ],
                            },
                        }

                    async def read(self, **kwargs):
                        self.reads += 1
                        self.assert_read_request = kwargs
                        if self.read_error is not None:
                            return {"ok": False, "error": self.read_error}
                        return {
                            "ok": True,
                            "element": {
                                "element_ref": "main-ref",
                                "role": "link",
                                "name": "Untrusted text",
                            },
                        }

                    async def cancel_read(self, **kwargs):
                        self.cancelled_requests.append(kwargs)
                        return {"ok": True}

                host = Host()
                decisions = iter(("allow_once", "deny"))
                approval_requests = []
                approval_started = asyncio.Event()
                release_approval = asyncio.Event()

                class Interactions:
                    async def request_browser_approval(self, **kwargs):
                        approval_requests.append(kwargs)
                        if kwargs["request_id"] == "callback-disconnected":
                            approval_started.set()
                            await release_approval.wait()
                            return {"decision": "allow_once"}
                        return {"decision": next(decisions)}

                live.interactions = Interactions()
                app = FastAPI()
                register_browser_routes(app, Sessions(), host, activities=activities)
                headers = {
                    BRIDGE_SESSION_HEADER: live.id,
                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                    BRIDGE_CALLBACK_REQUEST_HEADER: "callback-snapshot",
                    BRIDGE_CALLBACK_TURN_HEADER: "turn",
                }
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    first = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/snapshot",
                        headers=headers,
                        json={"tab_id": "browser-tab"},
                    )
                    repeated = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/snapshot",
                        headers=headers,
                        json={"tab_id": "browser-tab"},
                    )
                    read = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/read",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "callback-read"},
                        json={
                            "tab_id": "browser-tab",
                            "snapshot_id": "main-snapshot",
                            "element_ref": "main-ref",
                        },
                    )
                    host.policy_decision = "ask"
                    approved = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/snapshot",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "callback-approved"},
                        json={"tab_id": "browser-tab"},
                    )
                    denied = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/snapshot",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "callback-denied"},
                        json={"tab_id": "browser-tab"},
                    )
                    disconnected_task = asyncio.create_task(
                        client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/snapshot",
                            headers={
                                **headers,
                                BRIDGE_CALLBACK_REQUEST_HEADER: "callback-disconnected",
                            },
                            json={"tab_id": "browser-tab"},
                        )
                    )
                    await asyncio.wait_for(approval_started.wait(), timeout=1)
                    disconnected_task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await disconnected_task
                    release_approval.set()
                    disconnected_replay = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/snapshot",
                        headers={
                            **headers,
                            BRIDGE_CALLBACK_REQUEST_HEADER: "callback-disconnected",
                        },
                        json={"tab_id": "browser-tab"},
                    )
                    host.available = False
                    unavailable_snapshot = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/snapshot",
                        headers={
                            **headers,
                            BRIDGE_CALLBACK_REQUEST_HEADER: "callback-host-unavailable",
                        },
                        json={"tab_id": "browser-tab"},
                    )
                    host.available = True
                    unavailable_replay = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/snapshot",
                        headers={
                            **headers,
                            BRIDGE_CALLBACK_REQUEST_HEADER: "callback-host-unavailable",
                        },
                        json={"tab_id": "browser-tab"},
                    )
                    unavailable = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/navigate",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "callback-navigate"},
                        json=VALID_REQUESTS["navigate"],
                    )
                    host.policy_decision = "allow"
                    failures = {
                        "snapshot_too_large": "browser_snapshot_too_large",
                        "snapshot_timeout": "browser_snapshot_timeout",
                        "stale_ref": "browser_stale_ref",
                        "stale_grant": "browser_read_authority_invalid",
                        "private page text": "browser_request_unknown",
                    }
                    for code, expected in failures.items():
                        host.snapshot_error = code
                        failure = await client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/snapshot",
                            headers={
                                **headers,
                                BRIDGE_CALLBACK_REQUEST_HEADER: "callback-"
                                + code.replace(" ", "-"),
                            },
                            json={"tab_id": "browser-tab"},
                        )
                        self.assertEqual(
                            failure.json()["error"],
                            expected,
                        )
                        if code in ("stale_ref", "stale_grant"):
                            self.assertIn(
                                "no page action was dispatched", failure.json()["guidance"]
                            )
                        self.assertFalse(failure.json()["ok"])
                        self.assertNotIn("private page text", failure.text)
                    for code, expected in {
                        "stale_ref": "browser_stale_ref",
                        "stale_grant": "browser_read_authority_invalid",
                        "private page text": "browser_request_unknown",
                    }.items():
                        host.read_error = code
                        read_headers = {
                            **headers,
                            BRIDGE_CALLBACK_REQUEST_HEADER: "read-" + code.replace(" ", "-"),
                        }
                        failure = await client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/read",
                            headers=read_headers,
                            json={
                                "tab_id": "browser-tab",
                                "snapshot_id": "main-snapshot",
                                "element_ref": "main-ref",
                            },
                        )
                        self.assertEqual(failure.json()["error"], expected)
                        repeated_failure = await client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/read",
                            headers=read_headers,
                            json={
                                "tab_id": "browser-tab",
                                "snapshot_id": "main-snapshot",
                                "element_ref": "main-ref",
                            },
                        )
                        self.assertEqual(repeated_failure.json(), failure.json())
                        self.assertNotIn("private page text", failure.text)
                self.assertTrue(first.json()["ok"])
                self.assertEqual(first.json(), repeated.json())
                self.assertEqual(read.json()["element"]["element_ref"], "main-ref")
                self.assertTrue(approved.json()["ok"])
                self.assertEqual(denied.json()["error"], "browser_approval_denied")
                self.assertEqual(unavailable_snapshot.json()["error"], "browser_unavailable")
                self.assertEqual(unavailable_replay.json(), unavailable_snapshot.json())
                self.assertEqual(disconnected_replay.json()["error"], "browser_request_unknown")
                self.assertEqual(unavailable.json()["error"], "browser_request_unknown")
                self.assertEqual(host.snapshots, 7)
                self.assertEqual(host.reads, 4)
                self.assertEqual(len(approval_requests), 3)
                self.assertEqual(approval_requests[0]["request_id"], "callback-approved")
                self.assertEqual(approval_requests[0]["proof_id"], "main-proof")
                self.assertEqual(host.snapshot_requests[0]["grant_request_id"], "callback-snapshot")
                self.assertEqual(host.snapshot_requests[1]["grant_request_id"], "callback-approved")
                self.assertEqual(host.assert_read_request["snapshot_id"], "main-snapshot")
                self.assertEqual(
                    catalog.browser_action("callback-snapshot").status.value, "succeeded"
                )
                self.assertEqual(catalog.browser_action("callback-read").status.value, "succeeded")
                self.assertEqual(
                    catalog.browser_action("callback-approved").status.value, "succeeded"
                )
                self.assertEqual(catalog.browser_action("callback-denied").status.value, "denied")
                self.assertEqual(
                    catalog.browser_action("callback-disconnected").status.value, "unknown"
                )
                self.assertEqual(
                    catalog.browser_action("callback-host-unavailable").status.value, "unknown"
                )
                self.assertIn(
                    "callback-disconnected",
                    [entry["grant_request_id"] for entry in host.cancelled_requests],
                )
                self.assertNotIn("Untrusted text", str(published))

        asyncio.run(scenario())

    def test_live_route_lists_and_denial_never_executes_page_action(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            with tempfile.TemporaryDirectory(prefix="browser-bridge-") as directory:
                database = Path(directory).resolve() / "session.sqlite3"
                catalog = SessionCatalogStore(database)
                catalog.register(
                    "browser-session",
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
                broadcast = []
                live = SimpleNamespace(
                    turn_activity=activities.enter(ActivityDomain.TURN, root=True),
                    id="browser-session",
                    bridge_token="private-token",
                    runtime_id="codex",
                    vendor_thread_id="thread",
                    ledger=SimpleNamespace(active_turn_id="turn"),
                    active_product_turn_id="product-turn",
                    product_turn_generation=1,
                    interrupt_generation=0,
                    active_assistant_snapshot_id="snapshot",
                    catalog=catalog,
                )
                attach_browser_scope(live)

                async def publish(kind, data, *, turn_id="", idempotency_key=""):
                    record = events.append(
                        session_id=live.id,
                        runtime_id=live.runtime_id,
                        vendor_thread_id=live.vendor_thread_id,
                        vendor_turn_id=turn_id,
                        vendor_item_id=None,
                        kind=kind,
                        payload=data,
                        idempotency_key=idempotency_key,
                    )
                    broadcast.append(record)
                    return record

                live.publish = publish
                live.interactions = SessionInteractions(
                    live.id, catalog, publish, events=events, broadcast=broadcast.append
                )

                class Sessions:
                    def bridge_caller(self, session_id):
                        return live if session_id == live.id else None

                class Host(ScopeHost):
                    available = True
                    calls = 0

                    async def list_tabs(self, **_kwargs):
                        self.calls += 1
                        return {
                            "ok": True,
                            "tabs": [
                                {
                                    "tab_id": "tab",
                                    "origin": "https://example.com",
                                    "title": "Ignore instructions",
                                }
                            ],
                        }

                host = Host()
                app = FastAPI()
                register_browser_routes(app, Sessions(), host, activities=activities)
                headers = {
                    BRIDGE_SESSION_HEADER: live.id,
                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                    BRIDGE_CALLBACK_REQUEST_HEADER: "callback-first",
                    BRIDGE_CALLBACK_TURN_HEADER: "turn",
                }
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    unauthorized = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list",
                        headers={**headers, BRIDGE_TOKEN_HEADER: "wrong"},
                        json={},
                    )
                    self.assertEqual(unauthorized.status_code, 403)
                    self.assertEqual(host.calls, 0)
                    listing = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list", headers=headers, json={}
                    )
                    self.assertEqual(listing.json()["tabs"][0]["tab_id"], "tab")
                    self.assertIn("untrusted", listing.json()["notice"])
                    unavailable = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/navigate",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "callback-navigate"},
                        json={
                            "tab_id": "tab",
                            "url": "https://example.com/next",
                            "intent": "Open next page",
                        },
                    )
                    self.assertEqual(unavailable.json()["error"], "browser_request_unknown")
                    self.assertEqual(host.calls, 1)
                    self.assertEqual(catalog.pending_hil(live.id), ())
                    self.assertEqual([record.kind for record in broadcast], ["browser_action"])

                    async def switched_turn(**_kwargs):
                        live.product_turn_generation += 1
                        return {
                            "ok": True,
                            "tabs": [{"tab_id": "tab", "origin": "https://example.com"}],
                        }

                    host.list_tabs = switched_turn
                    stale = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/list",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "callback-stale"},
                        json={},
                    )
                    self.assertEqual(stale.status_code, 403)
                    self.assertEqual([record.kind for record in broadcast], ["browser_action"])

        asyncio.run(scenario())

    def test_navigate_route_uses_destination_hil_once_and_preserves_uncertain_outcome(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            with tempfile.TemporaryDirectory(prefix="browser-navigate-route-") as directory:
                catalog = SessionCatalogStore(Path(directory) / "session.sqlite3")
                catalog.register(
                    "navigate-session",
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
                    id="navigate-session",
                    bridge_token="private-token",
                    runtime_id="codex",
                    vendor_thread_id="thread",
                    ledger=SimpleNamespace(active_turn_id="turn"),
                    active_product_turn_id="product-turn",
                    product_turn_generation=1,
                    interrupt_generation=0,
                    active_assistant_snapshot_id="assistant-snapshot",
                    catalog=catalog,
                )
                attach_browser_scope(live)
                audits = []

                async def publish(kind, data, *, turn_id="", idempotency_key=""):
                    audits.append((kind, data, turn_id, idempotency_key))

                live.publish = publish

                class Sessions:
                    def bridge_caller(self, session_id):
                        return live if session_id == live.id else None

                class Host(ScopeHost):
                    available = True
                    policy_decision = "ask"
                    effect_result = {"ok": True}
                    cancel_result = {"ok": True}
                    prepared = []
                    executed = []
                    cancelled = []
                    execute_started = None
                    execute_gate = None

                    async def prepare_navigate(self, **kwargs):
                        self.prepared.append(kwargs)
                        return {
                            "ok": True,
                            "proof": {
                                "proof_id": f"proof-{kwargs['request_id']}",
                                "request_id": kwargs["request_id"],
                                "scope": {
                                    "sessionId": live.id,
                                    "instanceId": live.browser_scope_instance,
                                    "productTurnId": live.active_product_turn_id,
                                    "turnId": "turn",
                                    "generation": 1,
                                    "interruptGeneration": 0,
                                    "lifecycleEpoch": 1,
                                },
                                "tab_id": "browser-tab",
                                "target_instance_id": "tab-instance",
                                "target_generation": 1,
                                "source_origin": None,
                                "destination_url": "https://example.com/next",
                                "destination_origin": "https://example.com",
                                "intent": kwargs["intent"],
                                "expires_at": int((time.time() + 60) * 1000),
                                "policy_revision": 1,
                                "policy_decision": self.policy_decision,
                            },
                        }

                    async def execute_navigate(self, **kwargs):
                        self.executed.append(kwargs)
                        if self.execute_started is not None and self.execute_gate is not None:
                            self.execute_started.set()
                            await self.execute_gate.wait()
                        return self.effect_result

                    async def cancel_navigate(self, **kwargs):
                        self.cancelled.append(kwargs)
                        return self.cancel_result

                host = Host()
                approvals = []
                decisions = iter(("allow_once", "deny", "deny"))

                class Interactions:
                    async def request_browser_approval(self, **kwargs):
                        approvals.append(kwargs)
                        return {"decision": next(decisions)}

                live.interactions = Interactions()
                app = FastAPI()
                register_browser_routes(app, Sessions(), host, activities=activities)
                headers = {
                    BRIDGE_SESSION_HEADER: live.id,
                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                    BRIDGE_CALLBACK_TURN_HEADER: "turn",
                }

                async def navigate(client, request_id, payload=None):
                    return await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/navigate",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: request_id},
                        json=payload
                        or {
                            "tab_id": "browser-tab",
                            "url": "https://example.com/next",
                            "intent": "Open next page",
                        },
                    )

                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    approved = await navigate(client, "navigate-approved")
                    repeated = await navigate(client, "navigate-approved")
                    denied = await navigate(client, "navigate-denied")
                    host.cancel_result = {"ok": False, "error": "cancel_unconfirmed"}
                    cancel_unknown = await navigate(client, "navigate-cancel-unknown")
                    host.cancel_result = {"ok": True}
                    host.policy_decision = "allow"
                    allowed = await navigate(client, "navigate-allowed")
                    host.effect_result = {"ok": False, "error": "navigation_outcome_unknown"}
                    uncertain = await navigate(client, "navigate-unknown")
                    uncertain_replay = await navigate(client, "navigate-unknown")
                    host.execute_started = asyncio.Event()
                    host.execute_gate = asyncio.Event()
                    cancelled_action = asyncio.create_task(
                        navigate(client, "navigate-disconnected")
                    )
                    await asyncio.wait_for(host.execute_started.wait(), timeout=1)
                    cancelled_action.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await cancelled_action
                    host.execute_gate.set()
                    disconnected_replay = await navigate(client, "navigate-disconnected")
                self.assertEqual(approved.json()["requested_url"], "https://example.com/next")
                self.assertEqual(repeated.json(), approved.json())
                self.assertEqual(denied.json()["error"], "browser_approval_denied")
                self.assertEqual(cancel_unknown.json()["error"], "browser_request_unknown")
                self.assertTrue(allowed.json()["ok"])
                self.assertEqual(uncertain.json()["error"], "browser_request_unknown")
                self.assertEqual(uncertain_replay.json(), uncertain.json())
                self.assertEqual(disconnected_replay.json()["error"], "browser_request_unknown")
                self.assertEqual(len(host.executed), 4)
                self.assertEqual(len(host.cancelled), 3)
                self.assertEqual(len(approvals), 3)
                self.assertEqual(approvals[0]["origin"], "https://example.com")
                self.assertIsNone(approvals[0]["source_origin"])
                self.assertEqual(approvals[0]["destination_url"], "https://example.com/next")
                self.assertEqual(approvals[0]["destination_origin"], "https://example.com")
                self.assertEqual(
                    [
                        catalog.browser_action(request_id).status.value
                        for request_id in (
                            "navigate-approved",
                            "navigate-denied",
                            "navigate-cancel-unknown",
                            "navigate-allowed",
                            "navigate-unknown",
                            "navigate-disconnected",
                        )
                    ],
                    ["succeeded", "denied", "unknown", "succeeded", "unknown", "unknown"],
                )
                self.assertEqual(len(audits), 2)
                self.assertNotIn("https://example.com/next", str(audits))

        asyncio.run(scenario())

    def test_interact_submit_require_each_time_hil_and_do_not_publish_fill_value(self) -> None:
        async def scenario() -> None:
            activities = Activities()
            with tempfile.TemporaryDirectory(prefix="browser-action-route-") as directory:
                catalog = SessionCatalogStore(Path(directory) / "session.sqlite3")
                catalog.register(
                    "action-session",
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
                    id="action-session",
                    bridge_token="private-token",
                    runtime_id="codex",
                    vendor_thread_id="thread",
                    ledger=SimpleNamespace(active_turn_id="turn"),
                    active_product_turn_id="product-turn",
                    product_turn_generation=1,
                    interrupt_generation=0,
                    active_assistant_snapshot_id="assistant-snapshot",
                    catalog=catalog,
                )
                attach_browser_scope(live)
                audits = []

                async def publish(kind, data, *, turn_id="", idempotency_key=""):
                    audits.append((kind, data))

                live.publish = publish

                class Sessions:
                    def bridge_caller(self, session_id):
                        return live if session_id == live.id else None

                class Host(ScopeHost):
                    available = True
                    prepared = []
                    executed = []
                    cancelled = []
                    effect_result = {"ok": True}
                    element_name = "Send"
                    preparation_error = None
                    revalidation_error = None
                    action_target = "target"
                    read_decision = "ask"
                    read_prepared = []
                    read_cancelled = []
                    preparation_attempts = []
                    prepared_started = None
                    prepared_gate = None

                    async def prepare_action(self, **kwargs):
                        self.preparation_attempts.append(kwargs)
                        if self.preparation_error and not kwargs.get("read_request_id"):
                            return {"ok": False, "error": self.preparation_error}
                        if self.revalidation_error and kwargs.get("read_request_id"):
                            return {"ok": False, "error": self.revalidation_error}
                        self.prepared.append(kwargs)
                        if kwargs.get("read_request_id") and self.prepared_gate is not None:
                            self.prepared_started.set()
                            await self.prepared_gate.wait()
                        return {
                            "ok": True,
                            "proof": {
                                "prepared_id": "prepared-" + kwargs["request_id"],
                                "proof_id": "proof-" + kwargs["request_id"],
                                "request_id": kwargs["request_id"],
                                "scope": {
                                    "sessionId": live.id,
                                    "instanceId": live.browser_scope_instance,
                                    "productTurnId": "product-turn",
                                    "turnId": "turn",
                                    "generation": 1,
                                    "interruptGeneration": 0,
                                    "lifecycleEpoch": 1,
                                },
                                "tab_id": "browser-tab",
                                "target_instance_id": self.action_target,
                                "target_generation": 1,
                                "origin": "https://example.org",
                                "snapshot_id": "snapshot",
                                "element_ref": "element",
                                "grant_request_id": kwargs.get(
                                    "read_request_id", "snapshot-callback"
                                ),
                                "browser_action": kwargs["browser_action"],
                                "intent": kwargs["intent"],
                                "expires_at": int((time.time() + 60) * 1000),
                                "element": {"role": "button", "name": self.element_name},
                            },
                        }

                    async def execute_action(self, **kwargs):
                        self.executed.append(kwargs)
                        return self.effect_result

                    async def prepare_read(self, **kwargs):
                        self.read_prepared.append(kwargs)
                        return {
                            "ok": True,
                            "proof": {
                                "proof_id": "read-proof-" + kwargs["request_id"],
                                "request_id": kwargs["request_id"],
                                "tab_id": kwargs["tab_id"],
                                "target_instance_id": "target",
                                "target_generation": 1,
                                "origin": "https://example.org",
                                "intent": kwargs["intent"],
                                "policy_decision": self.read_decision,
                                "policy_revision": 1,
                                "scope": {
                                    "sessionId": live.id,
                                    "instanceId": live.browser_scope_instance,
                                    "productTurnId": "product-turn",
                                    "turnId": "turn",
                                    "generation": 1,
                                    "interruptGeneration": 0,
                                    "lifecycleEpoch": 1,
                                },
                                "expires_at": int((time.time() + 30) * 1000),
                            },
                        }

                    async def cancel_read(self, **kwargs):
                        self.read_cancelled.append(kwargs)
                        return {"ok": True}

                    async def cancel_action(self, **kwargs):
                        self.cancelled.append(kwargs)
                        return {"ok": True}

                host = Host()
                approvals = []

                class Interactions:
                    deny_observation = False
                    interrupt_observation = False

                    async def request_browser_approval(self, **kwargs):
                        approvals.append(kwargs)
                        if self.interrupt_observation and kwargs["action"] == "read":
                            live.interrupt_generation += 1
                        return {
                            "decision": (
                                "deny"
                                if kwargs["request_id"] == "denied"
                                or self.deny_observation
                                and kwargs["action"] == "read"
                                else "allow_once"
                            )
                        }

                live.interactions = Interactions()
                app = FastAPI()
                register_browser_routes(app, Sessions(), host, activities=activities)
                headers = {
                    BRIDGE_SESSION_HEADER: live.id,
                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                    BRIDGE_CALLBACK_TURN_HEADER: "turn",
                }
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    for operation in ("interact", "submit"):
                        host.preparation_error = "stale_ref"
                        stale_reference = await client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/" + operation,
                            headers={
                                **headers,
                                BRIDGE_CALLBACK_REQUEST_HEADER: "expired-" + operation,
                            },
                            json=VALID_REQUESTS[operation],
                        )
                        self.assertEqual(stale_reference.json()["error"], "browser_stale_ref")
                        self.assertIn("snapshot", stale_reference.json()["guidance"])
                        self.assertEqual(approvals, [])
                        self.assertEqual(host.executed, [])
                    self.assertEqual(len(host.cancelled), 2)
                    host.preparation_error = None
                    leaked_intent = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/interact",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "leaked-intent"},
                        json={
                            **VALID_REQUESTS["interact"],
                            "value": "secret-value",
                            "intent": "Fill secret-value",
                        },
                    )
                    host.element_name = "secret-value"
                    leaked_element = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/interact",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "leaked-element"},
                        json={**VALID_REQUESTS["interact"], "value": "secret-value"},
                    )
                    host.element_name = "Send"
                    results = []
                    for request_id, operation, payload in (
                        (
                            "clicked",
                            "interact",
                            {**VALID_REQUESTS["interact"], "action": "click", "value": None},
                        ),
                        (
                            "filled",
                            "interact",
                            {**VALID_REQUESTS["interact"], "value": "secret-value"},
                        ),
                        ("submitted", "submit", VALID_REQUESTS["submit"]),
                        ("denied", "submit", VALID_REQUESTS["submit"]),
                    ):
                        if payload.get("value") is None:
                            payload = {
                                key: value for key, value in payload.items() if value is not None
                            }
                        results.append(
                            await client.post(
                                BRIDGE_ROUTE_PREFIX + "browser/" + operation,
                                headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: request_id},
                                json=payload,
                            )
                        )
                    replay = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/interact",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "clicked"},
                        json={
                            key: value
                            for key, value in {
                                **VALID_REQUESTS["interact"],
                                "action": "click",
                            }.items()
                            if key != "value"
                        },
                    )
                    host.effect_result = {"ok": False, "error": "action_outcome_unknown"}
                    unknown = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/submit",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "unknown"},
                        json=VALID_REQUESTS["submit"],
                    )
                    unknown_replay = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/submit",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "unknown"},
                        json=VALID_REQUESTS["submit"],
                    )
                self.assertTrue(all(result.json()["ok"] for result in results[:3]))
                self.assertEqual(leaked_intent.status_code, 400)
                self.assertEqual(leaked_element.json()["error"], "browser_unavailable")
                self.assertEqual(results[3].json()["error"], "browser_approval_denied")
                self.assertEqual(
                    [item["action"] for item in approvals],
                    ["click", "fill", "submit", "submit", "submit"],
                )
                self.assertEqual(unknown.json()["error"], "browser_request_unknown")
                self.assertEqual(unknown_replay.json(), unknown.json())
                self.assertEqual(len(host.executed), 4)
                self.assertEqual(replay.json(), results[0].json())
                self.assertEqual(len(host.cancelled), 4)
                self.assertEqual(len(audits), 3)
                self.assertNotIn("secret-value", str(approvals) + str(audits) + str(results))
                self.assertEqual(catalog.browser_action("filled").status.value, "succeeded")
                self.assertEqual(catalog.browser_action("denied").status.value, "denied")
                self.assertEqual(catalog.browser_action("unknown").status.value, "unknown")

                host.preparation_error = "observation_read_required"
                host.effect_result = {"ok": True}
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    for operation in ("interact", "submit"):
                        action_id = "revalidated-" + operation
                        approval_count = len(approvals)
                        executed_count = len(host.executed)
                        renewed = await client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/" + operation,
                            headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: action_id},
                            json=VALID_REQUESTS[operation],
                        )
                        self.assertTrue(renewed.json()["ok"])
                        self.assertEqual(
                            [item["action"] for item in approvals[approval_count:]],
                            ["read", "fill" if operation == "interact" else "submit"],
                        )
                        read_id = approvals[approval_count]["request_id"]
                        self.assertNotEqual(read_id, action_id)
                        self.assertEqual(host.prepared[-1]["read_request_id"], read_id)
                        self.assertNotEqual(host.prepared[-1]["preparation_request_id"], read_id)
                        repeated = await client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/" + operation,
                            headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: action_id},
                            json=VALID_REQUESTS[operation],
                        )
                        self.assertEqual(repeated.json(), renewed.json())
                        self.assertEqual(len(host.executed), executed_count + 1)
                        self.assertEqual(len(approvals), approval_count + 2)
                    live.interactions.deny_observation = True
                    executed_count = len(host.executed)
                    denied_read = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/submit",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "denied-observation"},
                        json=VALID_REQUESTS["submit"],
                    )
                    self.assertEqual(denied_read.json()["error"], "browser_approval_denied")
                    self.assertEqual(len(host.executed), executed_count)
                    self.assertEqual(
                        host.read_cancelled[-1]["grant_request_id"],
                        host.read_prepared[-1]["request_id"],
                    )
                    live.interactions.deny_observation = False

                    host.revalidation_error = None
                    host.action_target = "other-target"
                    mismatched = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/submit",
                        headers={
                            **headers,
                            BRIDGE_CALLBACK_REQUEST_HEADER: "wrong-observation-target",
                        },
                        json=VALID_REQUESTS["submit"],
                    )
                    self.assertEqual(mismatched.json()["error"], "browser_unavailable")
                    self.assertEqual(len(host.executed), executed_count)
                    host.action_target = "target"
                    host.read_decision = "allow"
                    approval_count = len(approvals)
                    persistent_read = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/submit",
                        headers={
                            **headers,
                            BRIDGE_CALLBACK_REQUEST_HEADER: "persistent-observation-read",
                        },
                        json=VALID_REQUESTS["submit"],
                    )
                    self.assertTrue(persistent_read.json()["ok"])
                    self.assertEqual(
                        [item["action"] for item in approvals[approval_count:]], ["submit"]
                    )
                    executed_count = len(host.executed)
                    host.revalidation_error = "observation_read_required"
                    attempts = len(host.preparation_attempts)
                    stopped = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/submit",
                        headers={**headers, BRIDGE_CALLBACK_REQUEST_HEADER: "no-revalidation-loop"},
                        json=VALID_REQUESTS["submit"],
                    )
                    self.assertEqual(stopped.json()["error"], "browser_unavailable")
                    self.assertEqual(len(host.preparation_attempts), attempts + 2)
                    self.assertEqual(len(host.executed), executed_count)
                    host.revalidation_error = None
                    host.read_decision = "ask"
                    live.interactions.interrupt_observation = True
                    approval_count = len(approvals)
                    attempts = len(host.preparation_attempts)
                    interrupted = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/submit",
                        headers={
                            **headers,
                            BRIDGE_CALLBACK_REQUEST_HEADER: "interrupted-observation",
                        },
                        json=VALID_REQUESTS["submit"],
                    )
                    self.assertEqual(interrupted.status_code, 403)
                    self.assertEqual(interrupted.json()["error"], "bridge_access_denied")
                    self.assertEqual(
                        [item["action"] for item in approvals[approval_count:]], ["read"]
                    )
                    self.assertEqual(len(host.preparation_attempts), attempts + 1)
                    self.assertEqual(len(host.executed), executed_count)
                    self.assertEqual(
                        host.read_cancelled[-1]["grant_request_id"],
                        host.read_prepared[-1]["request_id"],
                    )
                    live.interrupt_generation -= 1
                    live.interactions.interrupt_observation = False
                    host.prepared_started = asyncio.Event()
                    host.prepared_gate = asyncio.Event()
                    approval_count = len(approvals)
                    attempts = len(host.preparation_attempts)
                    pending = asyncio.create_task(
                        client.post(
                            BRIDGE_ROUTE_PREFIX + "browser/submit",
                            headers={
                                **headers,
                                BRIDGE_CALLBACK_REQUEST_HEADER: "lost-preparation-response",
                            },
                            json=VALID_REQUESTS["submit"],
                        )
                    )
                    await asyncio.wait_for(host.prepared_started.wait(), timeout=1)
                    pending.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await pending
                    host.prepared_gate.set()
                    self.assertEqual(len(host.preparation_attempts), attempts + 2)
                    self.assertEqual(
                        [item["action"] for item in approvals[approval_count:]], ["read"]
                    )
                    self.assertEqual(len(host.executed), executed_count)
                    self.assertEqual(
                        host.cancelled[-1]["grant_request_id"], "lost-preparation-response"
                    )
                    self.assertEqual(
                        host.read_cancelled[-1]["grant_request_id"],
                        host.read_prepared[-1]["request_id"],
                    )
                    repeated = await client.post(
                        BRIDGE_ROUTE_PREFIX + "browser/submit",
                        headers={
                            **headers,
                            BRIDGE_CALLBACK_REQUEST_HEADER: "lost-preparation-response",
                        },
                        json=VALID_REQUESTS["submit"],
                    )
                    self.assertEqual(repeated.json()["error"], "browser_request_unknown")
                    self.assertEqual(len(host.preparation_attempts), attempts + 2)

        asyncio.run(scenario())

    def test_browser_operations_are_explicit_and_strict(self) -> None:
        for operation in OPERATIONS:
            with self.subTest(operation=operation):
                entry = BRIDGE_REQUESTS[("browser", operation)]
                request_type, route = entry.request_type, entry.route
                self.assertEqual(route, BRIDGE_ROUTE_PREFIX + "browser/" + operation)
                self.assertEqual(
                    request_type.model_validate(VALID_REQUESTS[operation]).model_dump(
                        exclude_none=True
                    ),
                    VALID_REQUESTS[operation],
                )
                for forbidden in (
                    "evaluate",
                    "cdp_method",
                    "web_contents_id",
                    "path",
                    "token",
                    "origin",
                    "grant_revision",
                    "request_id",
                ):
                    with self.subTest(forbidden=forbidden), self.assertRaises(ValidationError):
                        request_type.model_validate(
                            {
                                **VALID_REQUESTS[operation],
                                forbidden: "forged",
                            }
                        )

    def test_browser_input_bounds_and_action_invariants(self) -> None:
        invalid = (
            ("navigate", {**VALID_REQUESTS["navigate"], "url": "https://" + "a" * 4096}),
            ("navigate", {**VALID_REQUESTS["navigate"], "url": "file:///etc/passwd"}),
            ("navigate", {**VALID_REQUESTS["navigate"], "url": "https://example.com:bad/"}),
            ("navigate", {**VALID_REQUESTS["navigate"], "url": "https://example.com:0/"}),
            ("navigate", {**VALID_REQUESTS["navigate"], "url": "https://example.com:65536/"}),
            ("navigate", {**VALID_REQUESTS["navigate"], "url": "https://bad host/"}),
            ("navigate", {**VALID_REQUESTS["navigate"], "url": "https://example.com\\evil.com/"}),
            ("navigate", {**VALID_REQUESTS["navigate"], "url": "https://example.com/\\evil.com/"}),
            ("navigate", {**VALID_REQUESTS["navigate"], "url": "https://%20host/"}),
            ("navigate", {**VALID_REQUESTS["navigate"], "url": "https://@example.com/"}),
            ("read", {**VALID_REQUESTS["read"], "selector": "main"}),
            ("read", {**VALID_REQUESTS["read"], "element_ref": "a" * 4096}),
            (
                "navigate",
                {
                    key: value
                    for key, value in VALID_REQUESTS["navigate"].items()
                    if key != "intent"
                },
            ),
            ("interact", {**VALID_REQUESTS["interact"], "value": "x" * 65536}),
            (
                "interact",
                {
                    key: value
                    for key, value in VALID_REQUESTS["interact"].items()
                    if key != "intent"
                },
            ),
            ("interact", {**VALID_REQUESTS["interact"], "action": "evaluate"}),
            ("interact", {**VALID_REQUESTS["interact"], "action": "click", "value": "x"}),
            (
                "interact",
                {key: value for key, value in VALID_REQUESTS["interact"].items() if key != "value"},
            ),
            ("submit", {**VALID_REQUESTS["submit"], "intent": "x" * 65536}),
        )
        for operation, payload in invalid:
            with self.subTest(operation=operation), self.assertRaises(ValidationError):
                BRIDGE_REQUESTS[("browser", operation)].request_type.model_validate(payload)

    def test_tool_advertises_untrusted_page_content(self) -> None:
        browser_schema = next(
            branch
            for branch in SERVICE_BRIDGE_TOOL.input_schema["oneOf"]
            if branch["properties"]["capability"].get("const") == "browser"
        )
        for operation in OPERATIONS:
            self.assertIn(operation, browser_schema["properties"]["operation"]["enum"])
        self.assertIn("untrusted", SERVICE_BRIDGE_TOOL.description.lower())
        self.assertIn("user approval", SERVICE_BRIDGE_TOOL.description.lower())

    def test_unavailable_browser_never_falls_back_to_system_browser(self) -> None:
        for operation in OPERATIONS:
            with self.subTest(operation=operation):
                with patch.dict(os.environ, {INTERNAL_BASE_URL_ENV: "http://127.0.0.1"}):
                    result = asyncio.run(
                        execute_service_tool(
                            {
                                "capability": "browser",
                                "operation": operation,
                                "request": VALID_REQUESTS[operation],
                            },
                            session_id="live-session",
                            token="secret",
                            local_socket=None,
                        )
                    )
                self.assertEqual(result, {"ok": False, "error": "browser_unavailable"})

    def test_malformed_browser_operation_is_not_mistaken_for_unavailable(self) -> None:
        result = asyncio.run(
            execute_service_tool(
                {"capability": "browser", "operation": "evaluate", "request": {}},
                session_id="live-session",
                token="secret",
                local_socket=None,
            )
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "bridge_operation_unknown")
        self.assertEqual(set(result["valid_operations"]), set(OPERATIONS))
        self.assertIn("contract/describe", result["next_action"])
        self.assertNotIn("request_schemas", result)
        self.assertNotIn("evaluate", result["valid_operations"])

    def test_browser_fail_closed_preserves_request_and_context_validation(self) -> None:
        with patch.dict(os.environ, {INTERNAL_BASE_URL_ENV: "http://127.0.0.1"}):
            invalid = asyncio.run(
                execute_service_tool(
                    {
                        "capability": "browser",
                        "operation": "navigate",
                        "request": {**VALID_REQUESTS["navigate"], "token": "forged"},
                    },
                    session_id="live-session",
                    token="secret",
                    local_socket=None,
                )
            )
            no_session = asyncio.run(
                execute_service_tool(
                    {
                        "capability": "browser",
                        "operation": "list",
                        "request": {},
                    },
                    session_id="",
                    token="secret",
                    local_socket=None,
                )
            )
        self.assertEqual(invalid["ok"], False)
        self.assertEqual(invalid["error"], "bridge_invalid_parameters")
        self.assertEqual(invalid["invalid_parameters"], ["token"])
        self.assertEqual(no_session, {"ok": False, "error": "bridge_context_unavailable"})


if __name__ == "__main__":
    unittest.main()
