"""Deterministic search orchestration contracts; not product acceptance."""

from __future__ import annotations

import asyncio
import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract import PermissionIntent, RuntimePermissionMode
from service.chat.api.search import register_conversation_search_routes
from service.chat.service.search import (
    SEARCH_ARTIFACT,
    SEARCH_BEGIN,
    SEARCH_END,
    SEARCH_PROFILES,
    SearchService,
    search_result,
)
from service.invocation.service.artifacts import InvocationArtifactError
from service.invocation.service.runtime import INVOCATION_WORKSPACE_UNAVAILABLE, InvocationError
from service.invocation.service.skills import InvocationSkillRuntimeError
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    SEARCH_ROUTE,
    WebSearchRequest,
)
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)

URL = "https://example.com/result"
INVOCATION_ID = "invocation"
OWNER = "owner"
USER = "user"


def payload(provider: str = "official-api") -> str:
    return json.dumps(
        {
            "schema": "scholarseed.web_search.v1",
            "provider": provider,
            "status": "completed",
            "query": "query",
            "error": None,
            "candidates": [{"url": URL, "title": "Page", "description": "Candidate only"}],
        }
    )


def terminal() -> dict:
    return {
        "type": "result.completed",
        "data": {
            "text": "truncated stdout is irrelevant",
            "artifacts": [
                {
                    "relative_path": SEARCH_ARTIFACT,
                    "role": "final",
                    "artifact_id": "artifact",
                    "size_bytes": len(payload()),
                }
            ],
        },
    }


class SearchContract(unittest.IsolatedAsyncioTestCase):
    def service(self, events: list[dict]) -> tuple[SearchService, SimpleNamespace]:
        async def stream(prepared):
            for event in events:
                yield event

        invocations = SimpleNamespace(
            prepare=AsyncMock(
                return_value=SimpleNamespace(record=SimpleNamespace(invocation_id=INVOCATION_ID))
            ),
            stream=stream,
            artifact=AsyncMock(
                side_effect=lambda *args, **kwargs: (None, io.BytesIO(payload().encode()))
            ),
            interrupt=AsyncMock(return_value=True),
        )
        return SearchService(invocations), invocations

    async def run_search(self, service, *, profile="official", current=lambda: True, publish=None):
        return await service.run(
            WebSearchRequest(query="query", profile=profile),
            owner_id=OWNER,
            user_id=USER,
            permission=PermissionIntent(
                mode=RuntimePermissionMode.ASK, network_domains=("example.com",)
            ),
            current=current,
            publish=publish or AsyncMock(),
        )

    async def test_registered_artifact_not_tool_stdout_is_source(self):
        service, invocations = self.service([terminal()])
        publish = AsyncMock()
        result = await self.run_search(service, publish=publish)
        self.assertTrue(result["ok"])
        self.assertEqual(result["candidates"][0]["url"], URL)
        invocations.artifact.assert_awaited_once_with(INVOCATION_ID, "artifact", owner_id=OWNER)
        publish.assert_awaited_once_with(result)
        permission = invocations.prepare.call_args.kwargs["permission"]
        self.assertEqual(permission.mode, RuntimePermissionMode.ASK)
        self.assertFalse(permission.network_access)
        self.assertEqual(permission.network_domains, ("example.com",))

    async def test_no_explicit_artifact_never_reads_workspace(self):
        event = terminal()
        event["data"]["artifacts"] = []
        service, invocations = self.service([event])
        with self.assertRaisesRegex(ValueError, "search_artifact_invalid"):
            await self.run_search(service)
        invocations.artifact.assert_not_awaited()

    async def test_wrong_query_never_registers_another_search(self):
        service, invocations = self.service([terminal()])
        invocations.artifact.side_effect = lambda *args, **kwargs: (
            None,
            io.BytesIO(payload().replace('"query": "query"', '"query": "another"').encode()),
        )
        publish = AsyncMock()
        with self.assertRaisesRegex(ValueError, "search_query_mismatch"):
            await self.run_search(service, publish=publish)
        publish.assert_not_awaited()

    async def test_wrong_artifact_role_rejected(self):
        event = terminal()
        event["data"]["artifacts"][0]["role"] = "supporting"
        service, _ = self.service([event])
        with self.assertRaises(ValueError):
            await self.run_search(service)

    async def test_native_requires_real_search_activity(self):
        event = {
            "type": "result.completed",
            "data": {"text": SEARCH_BEGIN + payload("codex-native") + SEARCH_END},
        }
        service, _ = self.service([event])
        with self.assertRaisesRegex(ValueError, "search_native_execution_missing"):
            await self.run_search(service, profile="native")
        service, invocations = self.service([{"type": "web_search.completed"}, event])
        self.assertTrue((await self.run_search(service, profile="native"))["ok"])
        invocations.artifact.assert_not_awaited()

    async def test_hil_never_approved(self):
        service, invocations = self.service([{"type": "interaction.required"}])
        publish = AsyncMock()
        result = await self.run_search(service, publish=publish)
        self.assertEqual(result["status"], "action_required")
        self.assertEqual(result["invocation_id"], INVOCATION_ID)
        publish.assert_not_awaited()
        invocations.interrupt.assert_awaited_once()

    async def test_failed_child_preserves_safe_error_and_identity(self):
        service, _ = self.service(
            [{"type": "invocation.failed", "data": {"error": "agent_runtime_failed"}}]
        )
        publish = AsyncMock()
        result = await self.run_search(service, publish=publish)
        self.assertEqual(result["error"], "agent_runtime_failed")
        self.assertEqual(result["invocation_id"], INVOCATION_ID)
        publish.assert_not_awaited()

    async def test_concurrent_search_failures_keep_distinct_invocation_ids(self):
        service, invocations = self.service(
            [{"type": "invocation.failed", "data": {"error": "agent_runtime_failed"}}]
        )
        identities = ("first-child", "second-child")
        invocations.prepare.side_effect = [
            SimpleNamespace(record=SimpleNamespace(invocation_id=identity))
            for identity in identities
        ]
        results = await asyncio.gather(self.run_search(service), self.run_search(service))
        self.assertEqual({result["invocation_id"] for result in results}, set(identities))

    async def test_budget_timeout_preserves_identity_and_drains_child(self):
        service, invocations = self.service([])
        closed = asyncio.Event()

        async def stream(prepared):
            try:
                await asyncio.Event().wait()
                yield terminal()
            finally:
                closed.set()

        invocations.stream = stream
        with patch("service.chat.service.search.SEARCH_TIMEOUT_SECONDS", 0.01):
            result = await self.run_search(service)
        self.assertEqual(result["error"], "search_timeout")
        self.assertEqual(result["invocation_id"], INVOCATION_ID)
        self.assertTrue(closed.is_set())
        invocations.interrupt.assert_awaited_once()

    async def test_internal_timeout_is_not_mislabeled_as_search_budget(self):
        service, invocations = self.service([])
        invocations.prepare.side_effect = TimeoutError("internal timeout")
        result = await self.run_search(service)
        self.assertEqual(result["error"], "search_execution_timeout")
        self.assertNotIn("internal timeout", str(result))

    async def test_artifact_failure_preserves_identity(self):
        service, invocations = self.service([terminal()])
        invocations.artifact.side_effect = InvocationArtifactError(
            "invocation_artifact_path_invalid"
        )
        result = await self.run_search(service)
        self.assertEqual(result["error"], "invocation_artifact_path_invalid")
        self.assertEqual(result["invocation_id"], INVOCATION_ID)

    async def test_terminal_stream_drains_before_result_is_published(self):
        for event in (terminal(), {"type": "invocation.failed", "data": {}}):
            service, invocations = self.service([])
            drained = False

            async def stream(prepared):
                nonlocal drained
                yield event
                await asyncio.sleep(0)
                drained = True

            async def publish(result):
                self.assertTrue(drained)

            invocations.stream = stream
            await self.run_search(service, publish=publish)
            self.assertTrue(drained)
            invocations.interrupt.assert_not_awaited()

    async def test_stop_cancels_waiting_child_and_no_publish(self):
        service, invocations = self.service([])
        closed = asyncio.Event()
        entered = asyncio.Event()
        active = True

        async def stream(prepared):
            try:
                entered.set()
                await asyncio.Event().wait()
                yield terminal()
            finally:
                closed.set()

        invocations.stream = stream
        publish = AsyncMock()
        with patch("service.chat.service.search.SEARCH_POLL_SECONDS", 0.001):
            task = asyncio.create_task(
                self.run_search(service, current=lambda: active, publish=publish)
            )
            await entered.wait()
            active = False
            result = await asyncio.wait_for(task, 1)
        self.assertEqual(result["status"], "interrupted")
        self.assertTrue(closed.is_set())
        publish.assert_not_awaited()
        invocations.interrupt.assert_awaited_once()

    async def test_turn_changed_before_publication(self):
        service, invocations = self.service([terminal()])
        active = True

        async def artifact(*args, **kwargs):
            nonlocal active
            active = False
            return None, io.BytesIO(payload().encode())

        invocations.artifact.side_effect = artifact
        publish = AsyncMock()
        result = await self.run_search(service, current=lambda: active, publish=publish)
        self.assertEqual(result["status"], "interrupted")
        publish.assert_not_awaited()

    def test_candidate_validation(self):
        for value in ("[]", "{}", payload().replace(URL, "file:///etc/passwd")):
            with self.assertRaises(ValueError):
                search_result(value, SEARCH_PROFILES["official"], 20)

    def test_malformed_result_has_a_stable_validation_code(self):
        for value in ("not JSON", '{"schema":'):
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(ValueError, "search_result_invalid"),
            ):
                search_result(value, SEARCH_PROFILES["official"], 20)

    async def test_invalid_artifact_encoding_has_a_stable_validation_code(self):
        service, invocations = self.service([terminal()])
        invocations.artifact.side_effect = lambda *args, **kwargs: (None, io.BytesIO(b"\xff"))
        with self.assertRaisesRegex(ValueError, "search_result_encoding_invalid"):
            await self.run_search(service)

    def test_invalid_native_encoding_has_a_stable_validation_code(self):
        with self.assertRaisesRegex(ValueError, "search_result_encoding_invalid"):
            search_result(SEARCH_BEGIN + "\ud800" + SEARCH_END, SEARCH_PROFILES["native"], 20)


class SearchRouteContract(unittest.TestCase):
    def setUp(self):
        self.activities = Activities()
        self.turn_activity = self.activities.enter(ActivityDomain.RUNTIME)
        self.live = SimpleNamespace(
            catalog=SimpleNamespace(get=Mock(return_value=SimpleNamespace(principal_id=OWNER))),
            id="session",
            bridge_token="token",
            turn_activity=self.turn_activity,
            publication_turn_id="turn",
            interrupt_generation=0,
            attachment_generation=0,
            user_id=USER,
            applied_permission_mode=RuntimePermissionMode.ASK.value,
            permission_intent=Mock(return_value=PermissionIntent(mode=RuntimePermissionMode.ASK)),
            publish=AsyncMock(),
        )
        self.sessions = SimpleNamespace(bridge_caller=Mock(return_value=self.live))
        self.service = SimpleNamespace(run=AsyncMock(return_value={"ok": False}))
        self.allowed = True
        self.can_search = Mock(side_effect=lambda *_: self.allowed)
        app = FastAPI()
        app.state.auth_enabled = False
        register_conversation_search_routes(
            app, self.sessions, self.service, self.can_search, activities=self.activities
        )
        self.client = TestClient(app)
        self.headers = {
            BRIDGE_SESSION_HEADER: self.live.id,
            BRIDGE_TOKEN_HEADER: self.live.bridge_token,
        }

    def tearDown(self):
        self.client.close()
        self.turn_activity.close()

    def test_expired_turn_cannot_start_search(self):
        self.turn_activity.close()
        response = self.client.post(SEARCH_ROUTE, headers=self.headers, json={"query": "query"})
        self.assertEqual(response.status_code, 503)
        self.service.run.assert_not_awaited()

    def test_search_holds_bridge_until_response_after_parent_turn_ends(self):
        self.activities.begin()

        async def run(*args, **kwargs):
            self.turn_activity.close()
            self.assertEqual(self.activities.snapshot().counts.get(ActivityDomain.BRIDGE.value), 1)
            drained = asyncio.create_task(self.activities.wait_execution_drained())
            try:
                await asyncio.sleep(0)
                self.assertFalse(drained.done())
                return {"ok": False}
            finally:
                drained.cancel()
                await asyncio.gather(drained, return_exceptions=True)

        self.service.run.side_effect = run
        response = self.client.post(SEARCH_ROUTE, headers=self.headers, json={"query": "query"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.activities.snapshot().counts, {})

    def test_parent_scope_refuses_before_child_execution(self):
        self.allowed = False
        response = self.client.post(SEARCH_ROUTE, headers=self.headers, json={"query": "query"})
        self.assertEqual(response.status_code, 403)
        self.service.run.assert_not_awaited()

    def test_invalid_request_never_runs_search(self):
        for body in ("not JSON", '{"query": ""}', '{"query": 1}'):
            with self.subTest(body=body):
                response = self.client.post(SEARCH_ROUTE, headers=self.headers, content=body)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"], "search_request_invalid")
        self.service.run.assert_not_awaited()

    def test_child_validation_failure_preserves_safe_reason_and_identity(self):
        event = terminal()
        event["data"]["artifacts"] = []
        service, _ = SearchContract().service([event])
        self.service.run.side_effect = service.run
        with self.assertLogs("service.chat.api.search", level="WARNING") as captured:
            response = self.client.post(
                SEARCH_ROUTE, headers=self.headers, json={"query": "private query"}
            )
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["status"], "failed")
        self.assertEqual(response.json()["error"], "search_artifact_invalid")
        self.assertEqual(response.json()["invocation_id"], INVOCATION_ID)
        diagnostic = " ".join(captured.output)
        for identity in ("session", "turn", "official", INVOCATION_ID, "search_artifact_invalid"):
            self.assertIn(identity, diagnostic)
        self.assertNotIn("private query", diagnostic)
        self.assertNotIn("token", diagnostic)
        self.live.publish.assert_not_awaited()

    def test_invalid_profile_is_not_echoed_in_diagnostics(self):
        service, invocations = SearchContract().service([])
        self.service.run.side_effect = service.run
        with self.assertLogs("service.chat.api.search", level="WARNING") as captured:
            response = self.client.post(
                SEARCH_ROUTE,
                headers=self.headers,
                json={"query": "query", "profile": "private-profile-value"},
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "search_profile_invalid")
        self.assertNotIn("private-profile-value", " ".join(captured.output))
        invocations.prepare.assert_not_awaited()

    def test_whitespace_query_is_rejected_before_child_execution(self):
        service, invocations = SearchContract().service([])
        self.service.run.side_effect = service.run
        response = self.client.post(SEARCH_ROUTE, headers=self.headers, json={"query": "   "})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "search_query_required")
        invocations.prepare.assert_not_awaited()

    def test_wrong_session_token_refused(self):
        response = self.client.post(
            SEARCH_ROUTE,
            headers={**self.headers, BRIDGE_TOKEN_HEADER: "wrong"},
            json={"query": "query"},
        )
        self.assertEqual(response.status_code, 403)
        self.service.run.assert_not_awaited()

    def test_scope_snapshot_is_read_once_but_turn_checks_remain_live(self):
        async def run(*args, **kwargs):
            for _ in range(10):
                self.assertTrue(kwargs["current"]())
            self.live.interrupt_generation += 1
            self.assertFalse(kwargs["current"]())
            return {"ok": False, "status": "interrupted"}

        self.service.run.side_effect = run
        self.client.post(SEARCH_ROUTE, headers=self.headers, json={"query": "query"})
        self.can_search.assert_called_once_with("session", "turn")

    def test_unknown_permission_uses_safe_ask_default(self):
        self.live.applied_permission_mode = ""
        response = self.client.post(SEARCH_ROUTE, headers=self.headers, json={"query": "query"})
        self.assertEqual(response.status_code, 200)
        self.live.permission_intent.assert_called_once_with(RuntimePermissionMode.ASK)

    def test_infrastructure_failure_is_not_an_approval_request(self):
        for error in (
            InvocationError(INVOCATION_WORKSPACE_UNAVAILABLE),
            InvocationSkillRuntimeError(),
        ):
            self.service.run.side_effect = error
            response = self.client.post(SEARCH_ROUTE, headers=self.headers, json={"query": "query"})
            self.assertEqual(response.json()["status"], "failed")
            self.assertEqual(response.json()["error"], error.code)

    def test_publishes_bound_turn_before_response(self):
        async def run(*args, **kwargs):
            result = search_result(payload(), SEARCH_PROFILES["official"], 20)
            result["search_id"] = INVOCATION_ID
            await kwargs["publish"](result)
            self.live.publish.assert_awaited_once()
            return result

        self.service.run.side_effect = run
        response = self.client.post(SEARCH_ROUTE, headers=self.headers, json={"query": "query"})
        self.assertTrue(response.json()["ok"])
        self.assertEqual(self.live.publish.call_args.kwargs["turn_id"], "turn")
        self.assertEqual(self.live.publish.call_args.args[0], "source_candidates")
        self.assertEqual(self.service.run.call_args.kwargs["user_id"], USER)
        self.assertEqual(self.service.run.call_args.kwargs["owner_id"], OWNER)

    def test_late_turn_cannot_publish(self):
        async def run(*args, **kwargs):
            result = search_result(payload(), SEARCH_PROFILES["official"], 20)
            result["search_id"] = INVOCATION_ID
            self.live.publication_turn_id = "next-turn"
            await kwargs["publish"](result)
            return result

        self.service.run.side_effect = run
        response = self.client.post(SEARCH_ROUTE, headers=self.headers, json={"query": "query"})
        self.assertFalse(response.json()["ok"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "interrupted")
        self.live.publish.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
