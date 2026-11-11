"""Admission and cancellation contracts for product browser fallback."""

from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract import (
    DeliveryClass,
    PermissionIntent,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimePermissionMode,
)
from scholarseed_runtime.contract.inventory import SkillAvailability, SkillInventory, SkillView
from scholarseed_runtime.gateway.driver import RuntimeTurnOutcome, RuntimeTurnResult
from service.capabilities.service.install import parse_skill_frontmatter
from service.capabilities.service.skills import SkillCatalog
from service.capabilities.service.source import compile_source_skills
from service.chat.api.artifacts import register_artifact_routes
from service.chat.api.browsersearch import register_browser_search_routes, search_invocation_allowed
from service.chat.api.search import register_conversation_search_routes
from service.chat.runtime.composition import OneShotRuntimeResult
from service.chat.service.receipts import SEARCH_RECEIPT_PREFIX
from service.chat.service.search import SEARCH_BROWSER_ARTIFACT, SearchService
from service.invocation.service.results import RESULT_READY_EVENT
from service.invocation.service.runtime import (
    INVOCATION_PERMISSION_EXCEEDS_PARENT,
    InvocationService,
)
from service.invocation.service.skills import InvocationSkillResolver
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import ARTIFACT_PUBLISH_ROUTE, SEARCH_BROWSER_ROUTE, SEARCH_ROUTE
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)
from service.resources.api.search import FALLBACK_SEARCH_ROUTE, register_resource_search_routes
from service.resources.service.fallback import (
    FALLBACK_BROWSER_ARTIFACT,
    FALLBACK_PROFILE,
    ResourceSearchFallback,
)

INVOCATION_ID = "search-invocation"
TOKEN = "private-invocation-token"
QUERY = "product search"
OWNER = "search-owner"
USER = "search-user"
TURN = "search-turn"
SEARCH_SOURCE = Path(__file__).resolve().parents[3] / "skills/community/web-search"


def execution():
    return SimpleNamespace(
        id=INVOCATION_ID,
        bridge_token=TOKEN,
        bridge_activity=None,
        publication_turn_id="vendor-turn",
        closed=asyncio.Event(),
        browser_search_lock=asyncio.Lock(),
        browser_search_generation=0,
        record=SimpleNamespace(
            skill={"id": "builtin:web-search", "name": "web-search", "profile": "browser"},
            execution={
                "permission_mode": RuntimePermissionMode.BYPASS.value,
                "network_access": True,
            },
        ),
    )


class BrowserSearchContract(unittest.TestCase):
    def test_resource_fallback_profile_retains_scoped_admission(self):
        live = execution()
        live.record.skill["profile"] = "fallback"
        self.assertTrue(search_invocation_allowed(live))
        live.record.execution["permission_mode"] = RuntimePermissionMode.READ_ONLY.value
        self.assertFalse(search_invocation_allowed(live))
        live.record.execution["permission_mode"] = RuntimePermissionMode.BYPASS.value
        live.record.skill["id"] = "user:web-search"
        self.assertFalse(search_invocation_allowed(live))

    def test_ineligible_callback_is_denied_with_correct_entry_and_no_host_effect(self):
        live = execution()
        host = SimpleNamespace(start_scope=AsyncMock(), search=AsyncMock(), end_scope=AsyncMock())
        activities = Activities()
        live.bridge_activity = activities.enter(ActivityDomain.INVOCATION)
        self.addCleanup(live.bridge_activity.close)
        app = FastAPI()
        register_browser_search_routes(
            app,
            SimpleNamespace(bridge_caller=lambda scope: live if scope == live.id else None),
            host,
            activities=activities,
        )
        headers = {BRIDGE_SESSION_HEADER: live.id, BRIDGE_TOKEN_HEADER: TOKEN}
        cases = [
            ("conversation", "", RuntimePermissionMode.SAFE_AUTO.value),
            ("user:web-search", "browser", RuntimePermissionMode.SAFE_AUTO.value),
            ("builtin:web-search", "official", RuntimePermissionMode.SAFE_AUTO.value),
            ("builtin:web-search", "native", RuntimePermissionMode.SAFE_AUTO.value),
            ("builtin:web-search", "browser", RuntimePermissionMode.READ_ONLY.value),
            ("builtin:web-search", "browser", "unknown"),
        ]
        with TestClient(app) as client:
            for skill_id, profile, mode in cases:
                with self.subTest(skill_id=skill_id, profile=profile, mode=mode):
                    live.record.skill = {"id": skill_id, "profile": profile}
                    live.record.execution["permission_mode"] = mode
                    response = client.post(
                        SEARCH_BROWSER_ROUTE, json={"query": QUERY}, headers=headers
                    )
                    self.assertEqual(response.status_code, 403)
                    self.assertEqual(response.json()["error"], "browser_search_not_allowed")
                    self.assertIn("search/run", response.json()["guidance"])
                    self.assertNotIn("cards", response.json())
                    host.start_scope.assert_not_awaited()
                    host.search.assert_not_awaited()
                    host.end_scope.assert_not_awaited()

    def test_shipped_search_profiles_keep_declared_permission_boundaries(self):
        manifest = Path(__file__).resolve().parents[3] / "skills/community/web-search/SKILL.md"
        metadata, _body = parse_skill_frontmatter(manifest.read_text(encoding="utf-8"))
        row = {
            "id": "builtin:web-search",
            "name": "web-search",
            "active": True,
            "builtin": True,
            "path": str(manifest),
            "invocation": metadata["metadata"]["invocation"],
        }
        resolver = InvocationSkillResolver(
            SimpleNamespace(skill_inventory=AsyncMock(return_value=object())),
            SimpleNamespace(runtime_executable=lambda: "codex"),
            SimpleNamespace(payloads=lambda *_args, **_kwargs: [row]),
        )

        async def scenario():
            for profile, permission in (
                ("automatic", None),
                ("browser", None),
                ("fallback", None),
                ("native", None),
                ("official", None),
            ):
                resolved = await resolver.resolve(
                    skill_id=row["id"], profile=profile, cwd=manifest.parent, process_environment={}
                )
                self.assertEqual(resolved.permission_mode, permission)

        asyncio.run(scenario())

    def test_search_accepts_normal_modes_but_rejects_readonly_unknown_and_terminal(self):
        live = execution()
        self.assertTrue(search_invocation_allowed(live))
        for profile in ("native", "official", ""):
            live.record.skill["profile"] = profile
            self.assertFalse(search_invocation_allowed(live))
        live.record.skill = {"id": "builtin:fast-search", "name": "fast-search"}
        self.assertTrue(search_invocation_allowed(live))
        live.publication_turn_id = ""
        self.assertFalse(search_invocation_allowed(live))
        live.publication_turn_id = "vendor-turn"
        live.record.execution["network_access"] = False
        self.assertTrue(search_invocation_allowed(live))
        live.record.execution["network_access"] = True
        for mode in (
            RuntimePermissionMode.ASK,
            RuntimePermissionMode.SAFE_AUTO,
            RuntimePermissionMode.BYPASS,
        ):
            live.record.execution["permission_mode"] = mode.value
            self.assertTrue(search_invocation_allowed(live))
        for mode in (RuntimePermissionMode.READ_ONLY.value, "unknown", None):
            live.record.execution["permission_mode"] = mode
            self.assertFalse(search_invocation_allowed(live))
        live.record.execution["permission_mode"] = RuntimePermissionMode.BYPASS.value
        live.closed.set()
        self.assertFalse(search_invocation_allowed(live))

    def test_user_skill_with_builtin_name_cannot_enter_product_search(self):
        live = execution()
        live.record.execution["permission_mode"] = RuntimePermissionMode.SAFE_AUTO.value
        live.record.skill["id"] = "user:web-search"
        self.assertFalse(search_invocation_allowed(live))

    def test_authenticated_route_keeps_results_and_always_ends_scope(self):
        live = execution()
        live.record.execution["permission_mode"] = RuntimePermissionMode.SAFE_AUTO.value
        workspace = tempfile.TemporaryDirectory(prefix="browser-search-contract-")
        self.addCleanup(workspace.cleanup)
        live.workspace = Path(workspace.name)
        host = SimpleNamespace(
            start_scope=AsyncMock(return_value={"ok": True}),
            search=AsyncMock(
                return_value={
                    "ok": True,
                    "url": "https://www.bing.com/search?q=product+search",
                    "cards": [],
                    "challenge": False,
                }
            ),
            end_scope=AsyncMock(return_value={"ok": True}),
        )
        app = FastAPI()
        activities = Activities()
        live.bridge_activity = activities.enter(ActivityDomain.INVOCATION)
        register_browser_search_routes(
            app,
            SimpleNamespace(bridge_caller=lambda scope: live if scope == live.id else None),
            host,
            activities=activities,
        )
        self.addCleanup(live.bridge_activity.close)
        headers = {BRIDGE_SESSION_HEADER: live.id, BRIDGE_TOKEN_HEADER: TOKEN}
        with TestClient(app) as client:
            self.assertEqual(
                client.post(SEARCH_BROWSER_ROUTE, json={"query": QUERY}).status_code, 403
            )
            result = client.post(SEARCH_BROWSER_ROUTE, json={"query": QUERY}, headers=headers)
            self.assertTrue(result.json()["ok"])
            stored = live.workspace / result.json()["response_path"]
            self.assertEqual(json.loads(stored.read_text())["cards"], [])
            self.assertEqual(host.search.await_count, 1)
            self.assertEqual(host.end_scope.await_count, 1)
            host.search.return_value = {
                "ok": False,
                "error": "browser_search_authorization_required",
            }
            self.assertEqual(
                client.post(SEARCH_BROWSER_ROUTE, json={"query": QUERY}, headers=headers).json()[
                    "status"
                ],
                "action_required",
            )
            self.assertEqual(host.start_scope.call_args.kwargs["generation"], 2)
            self.assertEqual(
                client.post(
                    SEARCH_BROWSER_ROUTE,
                    json={"query": QUERY, "url": "https://example.com"},
                    headers=headers,
                ).status_code,
                400,
            )
            host.start_scope.return_value = {"ok": False, "error": "browser_unavailable"}
            self.assertEqual(
                client.post(SEARCH_BROWSER_ROUTE, json={"query": QUERY}, headers=headers).json()[
                    "error"
                ],
                "browser_unavailable",
            )
            self.assertEqual(host.end_scope.await_count, 3)
            host.start_scope.return_value = {"ok": True}

            async def terminate_during_search(**_parameters):
                live.closed.set()
                return {"ok": True, "cards": [{"title": "late"}]}

            host.search.side_effect = terminate_during_search
            late = client.post(SEARCH_BROWSER_ROUTE, json={"query": QUERY}, headers=headers).json()
            self.assertFalse(late["ok"])
            self.assertNotIn("cards", late)
            self.assertEqual(host.end_scope.await_count, 4)


class BrowserSearchFlowContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="browser-search-flow-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        shutil.copytree(SEARCH_SOURCE, self.source / SEARCH_SOURCE.name)
        shutil.copyfile(SEARCH_SOURCE.parents[1] / "registry.json", self.root / "registry.json")
        self.bundled = self.root / "bundled"
        compile_source_skills(self.bundled, self.source)
        manifest = self.bundled / "web-search/SKILL.md"
        inventory = SkillInventory(
            cwd=self.root,
            skills=(
                SkillView(
                    name="web-search",
                    path=manifest,
                    description="Bundled search contract",
                    availability=SkillAvailability.AVAILABLE,
                    enabled=True,
                ),
            ),
        )
        self.runtime = SimpleNamespace(
            skill_inventory=AsyncMock(return_value=inventory),
            invoke_once=AsyncMock(side_effect=self.invoke_once),
            cancel_once=AsyncMock(return_value=True),
        )
        settings = SimpleNamespace(runtime_executable=lambda: "codex")
        catalog = SkillCatalog(bundled_root=self.bundled, user_root=self.root / "user-skills")
        catalog.bind_authentication(lambda _user_id: True)
        resolver = InvocationSkillResolver(self.runtime, settings, catalog)
        self.activities = Activities()
        self.turn_activity = self.activities.enter(ActivityDomain.RUNTIME)
        self.addCleanup(self.turn_activity.close)
        self.invocations = InvocationService(
            activities=self.activities,
            runtime=self.runtime,
            settings=settings,
            skills=resolver,
            environment=AsyncMock(return_value={}),
            root=self.root / "invocations",
        )
        self.permission = PermissionIntent(mode=RuntimePermissionMode.SAFE_AUTO)
        self.live = SimpleNamespace(
            id="conversation",
            bridge_token=TOKEN,
            turn_activity=self.turn_activity,
            publication_turn_id=TURN,
            interrupt_generation=0,
            attachment_generation=0,
            user_id=USER,
            applied_permission_mode=self.permission.mode.value,
            permission_intent=Mock(side_effect=lambda _mode: self.permission),
            catalog=SimpleNamespace(get=Mock(return_value=SimpleNamespace(principal_id=OWNER))),
            publish=AsyncMock(),
        )
        self.host = SimpleNamespace(
            start_scope=AsyncMock(return_value={"ok": True}),
            search=AsyncMock(
                return_value={
                    "ok": True,
                    "url": "https://www.bing.com/search?q=product+search",
                    "cards": [],
                    "challenge": False,
                }
            ),
            end_scope=AsyncMock(return_value={"ok": True}),
        )
        self.app = FastAPI()
        self.app.state.auth_enabled = False
        register_conversation_search_routes(
            self.app,
            SimpleNamespace(
                bridge_caller=lambda scope: self.live if scope == self.live.id else None
            ),
            SearchService(self.invocations),
            lambda _session, _turn: True,
            activities=self.activities,
        )
        register_browser_search_routes(
            self.app, self.invocations, self.host, activities=self.activities
        )
        register_artifact_routes(
            self.app, self.invocations.bridge_caller, activities=self.activities
        )
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://test"
        )
        self.addAsyncCleanup(self.client.aclose)
        self.callback_responses = []

    async def invoke_once(self, **parameters):
        invocation_id = parameters["invocation_id"]
        started = RuntimeEvent(
            schema_version=1,
            event_id="search-started",
            runtime_id="codex",
            product_session_id=invocation_id,
            native_session_id="search-native-session",
            process_generation=1,
            sequence=1,
            kind=RuntimeEventKind.TURN_STARTED,
            delivery=DeliveryClass.MUST_PERSIST,
            observed_at="now",
            native_turn_id=TURN,
            correlation_id=invocation_id,
            payload={},
        )
        await parameters["observer"](started)
        headers = {
            BRIDGE_SESSION_HEADER: invocation_id,
            BRIDGE_TOKEN_HEADER: parameters["bridge_token"],
        }
        response = await self.client.post(
            SEARCH_BROWSER_ROUTE, headers=headers, json={"query": QUERY}
        )
        self.callback_responses.append(response)
        result = response.json()
        if result["ok"]:
            resource = parameters["skill_identity"].get("profile") == FALLBACK_PROFILE
            artifact_name = FALLBACK_BROWSER_ARTIFACT if resource else SEARCH_BROWSER_ARTIFACT
            payload = {
                "schema": "scholarseed.web_search.v1",
                "provider": "visible-browser",
                "status": "empty",
                "query": QUERY,
                "candidates": [],
                "error": None,
            }
            artifact = Path(parameters["cwd"]) / artifact_name
            artifact.write_text(json.dumps(payload), encoding="utf-8")
            if resource:
                await parameters["observer"](
                    replace(
                        started,
                        event_id="resource-tool-started",
                        sequence=2,
                        kind=RuntimeEventKind.TOOL_STARTED,
                        native_item_id="resource-tool",
                    )
                )
                await parameters["observer"](
                    replace(
                        started,
                        event_id="resource-tool-completed",
                        sequence=3,
                        kind=RuntimeEventKind.TOOL_COMPLETED,
                        native_item_id="resource-tool",
                        payload={
                            "status": "completed",
                            "exit_code": 0,
                            "output": SEARCH_RECEIPT_PREFIX
                            + json.dumps({**payload, "truncated": False}),
                        },
                    )
                )
            else:
                published = await self.client.post(
                    ARTIFACT_PUBLISH_ROUTE,
                    headers=headers,
                    json={"path": artifact_name, "role": "final"},
                )
                self.assertTrue(published.json()["ok"], published.text)
        return OneShotRuntimeResult(
            model_key="contract-model",
            vendor_thread_id="search-native-session",
            turn=RuntimeTurnResult(
                command_id=invocation_id,
                native_turn_id=TURN,
                outcome=(
                    RuntimeTurnOutcome.COMPLETED if result["ok"] else RuntimeTurnOutcome.FAILED
                ),
                safe_error=result.get("error", ""),
            ),
        )

    async def search(self, mode):
        self.permission = replace(self.permission, mode=mode)
        self.live.applied_permission_mode = mode.value
        return await self.client.post(
            SEARCH_ROUTE,
            headers={BRIDGE_SESSION_HEADER: self.live.id, BRIDGE_TOKEN_HEADER: TOKEN},
            json={"query": QUERY, "profile": "browser"},
        )

    async def test_shipped_browser_profile_reaches_host_with_inherited_permissions(self):
        for mode in (
            RuntimePermissionMode.ASK,
            RuntimePermissionMode.SAFE_AUTO,
            RuntimePermissionMode.BYPASS,
        ):
            with self.subTest(mode=mode):
                self.permission = PermissionIntent(
                    mode=mode,
                    revision="parent-revision",
                    writable_roots=(self.root / "parent-workspace",),
                    local_sockets=(self.root / "parent.sock",),
                    network_access=False,
                    network_domains=("www.bing.com",),
                    deny_read_roots=(self.root / "private",),
                )
                response = await self.search(mode)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json()["ok"], response.text)
                invocation = self.runtime.invoke_once.call_args.kwargs
                self.assertEqual(
                    invocation["permission"], replace(self.permission, writable_roots=())
                )
                self.assertEqual(invocation["permission_mode"], mode)
                self.assertFalse(invocation["network_access"])
                self.assertNotEqual(invocation["cwd"], self.permission.writable_roots[0])
                self.assertEqual(self.callback_responses[-1].status_code, 200)
        self.assertEqual(self.host.search.await_count, 3)
        self.assertEqual(self.host.end_scope.await_count, 3)
        self.assertEqual(self.live.publish.await_count, 3)

    async def test_resource_entry_reaches_browser_with_explicit_root_permissions(self):
        self.app.state.resource_search_fallback = ResourceSearchFallback(
            self.invocations,
            lambda: 1,
            permission=lambda: self.permission,
            profile_root=self.root.resolve() / "profiles",
        )
        register_resource_search_routes(self.app)
        for mode in (
            RuntimePermissionMode.ASK,
            RuntimePermissionMode.SAFE_AUTO,
            RuntimePermissionMode.BYPASS,
        ):
            with self.subTest(mode=mode):
                self.permission = PermissionIntent(
                    mode=mode,
                    revision="root-revision",
                    writable_roots=(self.root / "unrelated-workspace",),
                    local_sockets=(self.root / "root.sock",),
                    network_access=False,
                    network_domains=("www.bing.com",),
                    deny_read_roots=(self.root / "private",),
                )
                response = await self.client.post(
                    FALLBACK_SEARCH_ROUTE,
                    headers={"accept": "text/event-stream"},
                    json={"query": QUERY, "native_available": False},
                )
                self.assertEqual(response.status_code, 200, response.text)
                events = [
                    json.loads(line.removeprefix("data: "))
                    for line in response.text.splitlines()
                    if line.startswith("data: ")
                ]
                kinds = [event["type"] for event in events]
                self.assertIn(RESULT_READY_EVENT, kinds)
                self.assertEqual(kinds[-1], "result.completed")
                self.assertLess(kinds.index(RESULT_READY_EVENT), kinds.index("result.completed"))
                invocation = self.runtime.invoke_once.call_args.kwargs
                self.assertEqual(
                    invocation["permission"], replace(self.permission, writable_roots=())
                )
                self.assertEqual(invocation["permission_mode"], mode)
                self.assertFalse(invocation["network_access"])
                self.assertEqual(invocation["skill_identity"]["profile"], FALLBACK_PROFILE)
                self.assertEqual(self.callback_responses[-1].status_code, 200)
                self.assertTrue(self.callback_responses[-1].json()["ok"])
        self.assertEqual(self.host.search.await_count, 3)
        self.assertEqual(self.host.end_scope.await_count, 3)
        self.live.permission_intent.assert_not_called()
        self.live.publish.assert_not_awaited()

    async def test_readonly_parent_cannot_reach_browser_host(self):
        response = await self.search(RuntimePermissionMode.READ_ONLY)
        self.assertFalse(response.json()["ok"], response.text)
        self.assertEqual(response.json()["error"], "browser_search_not_allowed")
        self.assertEqual(self.callback_responses[-1].status_code, 403)
        self.host.start_scope.assert_not_awaited()
        self.host.search.assert_not_awaited()
        self.host.end_scope.assert_not_awaited()
        self.live.publish.assert_not_awaited()

    async def test_full_access_declaration_still_cannot_expand_parent(self):
        manifest = self.source / "web-search/SKILL.md"
        metadata, body = parse_skill_frontmatter(manifest.read_text(encoding="utf-8"))
        metadata["metadata"]["invocation"]["profiles"]["browser"]["permission"] = "full-access"
        manifest.write_text("---\n" + yaml.safe_dump(metadata) + "---\n" + body, encoding="utf-8")
        compile_source_skills(self.bundled, self.source)
        for mode in (RuntimePermissionMode.ASK, RuntimePermissionMode.SAFE_AUTO):
            with self.subTest(mode=mode):
                response = await self.search(mode)
                self.assertEqual(response.json()["error"], INVOCATION_PERMISSION_EXCEEDS_PARENT)
                self.assertEqual(response.json()["status"], "action_required")
        self.runtime.invoke_once.assert_not_awaited()
        self.host.start_scope.assert_not_awaited()
        self.host.search.assert_not_awaited()
        self.assertEqual(list((self.root / "invocations").iterdir()), [])

    async def test_website_authorization_remains_independent_of_parent_permission(self):
        for mode in (RuntimePermissionMode.SAFE_AUTO, RuntimePermissionMode.BYPASS):
            for error in ("browser_search_authorization_required", "stale_grant"):
                with self.subTest(mode=mode, error=error):
                    self.host.search.return_value = {"ok": False, "error": error}
                    response = await self.search(mode)
                    self.assertFalse(response.json()["ok"], response.text)
                    self.assertEqual(response.json()["error"], error)
                    callback = self.callback_responses[-1].json()
                    self.assertEqual(callback["error"], error)
                    if error == "browser_search_authorization_required":
                        self.assertEqual(callback["status"], "action_required")
        self.assertEqual(self.host.start_scope.await_count, 4)
        self.assertEqual(self.host.search.await_count, 4)
        self.assertEqual(self.host.end_scope.await_count, 4)
        self.live.publish.assert_not_awaited()

    async def test_request_cannot_supply_its_own_permission_source(self):
        for override in (
            {"permission_mode": RuntimePermissionMode.BYPASS.value},
            {"network_access": True},
            {"permission": {"mode": RuntimePermissionMode.BYPASS.value}},
        ):
            with self.subTest(override=override):
                response = await self.client.post(
                    SEARCH_ROUTE,
                    headers={BRIDGE_SESSION_HEADER: self.live.id, BRIDGE_TOKEN_HEADER: TOKEN},
                    json={"query": QUERY, "profile": "browser", **override},
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"], "search_request_invalid")
        self.runtime.invoke_once.assert_not_awaited()
        self.host.start_scope.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
