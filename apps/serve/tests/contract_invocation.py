"""Contract coverage for the isolated single-turn SSE and artifact surface."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract import (
    CallbackAudience,
    CallbackKind,
    DeliveryClass,
    RuntimeCallbackRequest,
    RuntimeCapabilityName,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimePermissionMode,
)
from scholarseed_runtime.gateway.driver import RuntimeTurnOutcome, RuntimeTurnResult
from service.chat.api.artifacts import register_artifact_routes
from service.chat.runtime.composition import OneShotRuntimeResult
from service.invocation.api.routes import register_invocation_routes
from service.invocation.api.schema import InvocationStartRequest
from service.invocation.service.artifacts import ARTIFACT_MAX_BYTES
from service.invocation.service.events import InvocationEventProjector
from service.invocation.service.runtime import InvocationService, OneShotExecution
from service.invocation.service.skills import (
    InvocationSkillError,
    InvocationSkillResolver,
    ResolvedSkill,
)
from service.paths import ONE_SHOT_WORKSPACE_DIRNAME
from service.platform.bridge import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    ArtifactPublishFailure,
)

OWNER_ID = "local"
USER_ID = "account-user"
FINAL_CONTENT = "final artifact\n"
SUPPORTING_CONTENT = "supporting artifact\n"


def event(
    kind: RuntimeEventKind,
    *,
    sequence: int,
    payload: dict[str, Any] | None = None,
    turn_id: str = "turn-1",
) -> RuntimeEvent:
    return RuntimeEvent(
        schema_version=1,
        event_id=f"event-{sequence}",
        runtime_id="codex",
        product_session_id="pending",
        native_session_id="thread-1",
        process_generation=1,
        sequence=sequence,
        kind=kind,
        delivery=DeliveryClass.MUST_PERSIST,
        observed_at="now",
        native_turn_id=turn_id,
        correlation_id="pending",
        payload=payload or {},
    )


class FakeSettings:
    @staticmethod
    def runtime_executable() -> str:
        return "codex"


class FakeSkillResolver:
    def __init__(self, manifest: Path) -> None:
        self.manifest = manifest
        self.calls: list[dict[str, Any]] = []
        self.permission_mode: RuntimePermissionMode | None = None

    async def resolve(self, **kwargs) -> ResolvedSkill:
        self.calls.append(kwargs)
        return ResolvedSkill(
            id=str(kwargs["skill_id"]),
            name="report-skill",
            version="2.0.0",
            fingerprint="fingerprint-1",
            path=self.manifest,
            profile=kwargs.get("profile"),
            permission_mode=self.permission_mode,
        )


class FakeRuntime:
    def __init__(self) -> None:
        self.service: InvocationService | None = None
        self.calls: list[dict[str, Any]] = []
        self.publish_errors: list[str] = []

    async def invoke_once(self, **kwargs) -> OneShotRuntimeResult:
        self.calls.append(kwargs)
        invocation_id = str(kwargs["invocation_id"])
        observer = kwargs["observer"]

        def bound(runtime_event: RuntimeEvent) -> RuntimeEvent:
            return RuntimeEvent(
                **{
                    **runtime_event.__dict__,
                    "product_session_id": invocation_id,
                    "correlation_id": invocation_id,
                }
            )

        await observer(bound(event(RuntimeEventKind.TURN_STARTED, sequence=1)))
        workspace = Path(kwargs["cwd"])
        output = workspace / "outputs"
        output.mkdir()
        final = output / "report.md"
        supporting = output / "notes.txt"
        final.write_text(FINAL_CONTENT, encoding="utf-8")
        supporting.write_text(SUPPORTING_CONTENT, encoding="utf-8")
        await observer(
            bound(
                event(
                    RuntimeEventKind.ARTIFACT_OBSERVED,
                    sequence=2,
                    payload={
                        "changes": [
                            {"path": "outputs/report.md", "kind": "update"},
                            {"path": "outputs/unpublished.tmp", "kind": "update"},
                        ]
                    },
                )
            )
        )
        assert self.service is not None
        caller = self.service.bridge_caller(invocation_id)
        assert caller is not None
        await asyncio.gather(
            caller.publish_artifact("outputs/report.md", "final", turn_id="turn-1"),
            caller.publish_artifact("outputs/notes.txt", "supporting", turn_id="turn-1"),
        )
        outside = workspace.parent / "outside.txt"
        outside.write_text("outside", encoding="utf-8")
        link = workspace / "escape.txt"
        link.symlink_to(outside)
        oversized = workspace / "oversized.bin"
        with oversized.open("wb") as handle:
            handle.truncate(ARTIFACT_MAX_BYTES + 1)
        for invalid in (str(final), "../outside.txt", "escape.txt", "oversized.bin"):
            try:
                await caller.publish_artifact(invalid, "final", turn_id="turn-1")
            except ArtifactPublishFailure as error:
                self.publish_errors.append(error.code)
        await observer(
            bound(
                event(
                    RuntimeEventKind.CONTENT_COMPLETED,
                    sequence=3,
                    payload={"role": "assistant", "text": "done"},
                )
            )
        )
        await observer(bound(event(RuntimeEventKind.TURN_COMPLETED, sequence=4)))
        return OneShotRuntimeResult(
            model_key="test-model",
            vendor_thread_id="thread-1",
            turn=RuntimeTurnResult(
                command_id=invocation_id,
                native_turn_id="turn-1",
                outcome=RuntimeTurnOutcome.COMPLETED,
                final_text="done",
                input_tokens=4,
                output_tokens=2,
            ),
        )

    async def cancel_once(self, _invocation_id: str, *, owner_id: str) -> bool:
        return owner_id == OWNER_ID

    async def respond_once(self, *_args, **_kwargs) -> bool:
        return True


class BlockingRuntime(FakeRuntime):
    def __init__(self, *, cancel_raises: bool) -> None:
        super().__init__()
        self.cancel_raises = cancel_raises
        self.started = asyncio.Event()
        self.cancelled = False

    async def invoke_once(self, **kwargs) -> OneShotRuntimeResult:
        self.started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            self.cancelled = True
            raise

    async def cancel_once(self, _invocation_id: str, *, owner_id: str) -> bool:
        if self.cancel_raises:
            raise RuntimeError("cancel unavailable")
        return False


class HilRuntime(FakeRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.responded = asyncio.Event()
        self.response = None

    async def invoke_once(self, **kwargs) -> OneShotRuntimeResult:
        invocation_id = str(kwargs["invocation_id"])
        observer = kwargs["observer"]
        await observer(
            RuntimeCallbackRequest(
                schema_version=1,
                runtime_id="codex",
                product_session_id=invocation_id,
                native_session_id="thread-hil",
                request_id="hil-1",
                audience=CallbackAudience.USER,
                kind=CallbackKind.USER_INPUT,
                blocking=True,
                prompt="continue?",
                response_contract={},
                observed_at="now",
                native_turn_id="turn-hil",
                allowed_decisions=("accept", "cancel"),
            )
        )
        await self.responded.wait()
        return OneShotRuntimeResult(
            model_key="test-model",
            vendor_thread_id="thread-hil",
            turn=RuntimeTurnResult(
                command_id=invocation_id,
                native_turn_id="turn-hil",
                outcome=RuntimeTurnOutcome.COMPLETED,
                final_text="accepted",
            ),
        )

    async def respond_once(self, *_args, **kwargs) -> bool:
        self.response = kwargs["response"]
        self.responded.set()
        return True


async def environment(_user_id: str) -> dict[str, str]:
    return {}


def frames(response_text: str) -> list[dict[str, Any]]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in response_text.splitlines()
        if line.startswith("data: ")
    ]


class InvocationContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        manifest = root / "skill" / "SKILL.md"
        manifest.parent.mkdir()
        manifest.write_text("# Skill\n", encoding="utf-8")
        self.skills = FakeSkillResolver(manifest)
        runtime = FakeRuntime()
        self.root = root / "one-shots"
        self.service = InvocationService(
            runtime=runtime,
            settings=FakeSettings(),
            skills=self.skills,
            environment=environment,
            root=self.root,
        )
        runtime.service = self.service
        app = FastAPI()
        app.state.invocations = self.service
        app.state.auth_enabled = False
        register_invocation_routes(app)
        self.client = TestClient(app)
        self.runtime = runtime

    def tearDown(self) -> None:
        self.client.close()
        self.temporary.cleanup()

    @staticmethod
    def request(prompt: str = "create a report") -> dict[str, Any]:
        return {"prompt": prompt}

    def test_post_stream_persists_workspace_and_published_artifacts(self) -> None:
        response = self.client.post(
            "/api/agent/invocations",
            headers={"Accept": "text/event-stream"},
            json=self.request(),
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))
        self.assertEqual(response.headers["cache-control"], "no-cache")
        received = frames(response.text)
        self.assertEqual([row["seq"] for row in received], list(range(1, len(received) + 1)))
        self.assertEqual(received[0]["type"], "invocation.started")
        self.assertEqual(received[-1]["type"], "result.completed")
        self.assertEqual(
            sum(row["type"] in {"result.completed", "invocation.failed"} for row in received),
            1,
        )
        published = [row for row in received if row["type"] == "artifact.published"]
        self.assertEqual(len(published), 2)
        self.assertEqual(
            self.runtime.publish_errors,
            [
                "invocation_artifact_path_invalid",
                "invocation_artifact_path_invalid",
                "invocation_artifact_path_invalid",
                "invocation_artifact_file_too_large",
            ],
        )
        finals = received[-1]["data"]["artifacts"]
        self.assertEqual([row["relative_path"] for row in finals], ["outputs/report.md"])
        invocation_id = received[0]["invocation_id"]
        workspace = Path(self.runtime.calls[0]["cwd"])
        self.assertEqual(workspace.name, ONE_SHOT_WORKSPACE_DIRNAME)
        self.assertEqual((workspace / "outputs/report.md").read_text(), FINAL_CONTENT)
        self.assertTrue((workspace.parent / "metadata.json").is_file())
        self.assertFalse((self.root.parent / "one-shots.sqlite3").exists())
        runtime_call = self.runtime.calls[0]
        self.assertEqual(runtime_call["permission_mode"], RuntimePermissionMode.SAFE_AUTO)
        self.assertTrue(runtime_call["network_access"])
        self.assertEqual(runtime_call["reasoning_effort"], "low")
        self.assertEqual(runtime_call["service_tier"], "fast")
        self.assertEqual(runtime_call["required_capabilities"], (RuntimeCapabilityName.WEB_SEARCH,))
        self.assertTrue(runtime_call["instructions"])

        artifact_id = finals[0]["artifact_id"]
        restarted_runtime = FakeRuntime()
        restarted_service = InvocationService(
            runtime=restarted_runtime,
            settings=FakeSettings(),
            skills=self.skills,
            environment=environment,
            root=self.root,
        )
        restarted_runtime.service = restarted_service
        self.client.app.state.invocations = restarted_service
        download = self.client.get(
            f"/api/agent/invocations/{invocation_id}/artifacts/{artifact_id}"
        )
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.content.decode(), FINAL_CONTENT)
        metadata = workspace.parent / "metadata.json"
        metadata_text = metadata.read_text(encoding="utf-8")
        metadata.write_text("[]", encoding="utf-8")
        malformed = self.client.get(
            f"/api/agent/invocations/{invocation_id}/artifacts/{artifact_id}"
        )
        self.assertEqual(malformed.status_code, 404)
        metadata.write_text(metadata_text, encoding="utf-8")
        (workspace / "outputs/report.md").write_text("tampered", encoding="utf-8")
        mismatch = self.client.get(
            f"/api/agent/invocations/{invocation_id}/artifacts/{artifact_id}"
        )
        self.assertEqual(mismatch.status_code, 409)

    def test_http_developer_prompt_can_be_disabled_explicitly(self) -> None:
        disabled = self.client.post(
            "/api/agent/invocations",
            headers={"Accept": "text/event-stream"},
            json={"prompt": "without product prompt", "developer_prompt": False},
        )
        enabled = self.client.post(
            "/api/agent/invocations",
            headers={"Accept": "text/event-stream"},
            json={"prompt": "with product prompt", "developer_prompt": True},
        )

        self.assertEqual((disabled.status_code, enabled.status_code), (200, 200))
        disabled_call, enabled_call = self.runtime.calls[-2:]
        self.assertEqual(disabled_call["instructions"], "")
        self.assertTrue(enabled_call["instructions"])
        self.assertFalse(frames(disabled.text)[0]["data"]["execution"]["developer_prompt"])
        self.assertTrue(frames(enabled.text)[0]["data"]["execution"]["developer_prompt"])

    def test_data_owner_and_authenticated_user_remain_distinct(self) -> None:
        requested_users: list[str] = []

        async def account_environment(user_id: str) -> dict[str, str]:
            requested_users.append(user_id)
            return {}

        runtime = FakeRuntime()
        service = InvocationService(
            runtime=runtime,
            settings=FakeSettings(),
            skills=self.skills,
            environment=account_environment,
            root=self.root / "identity",
        )
        runtime.service = service

        async def scenario() -> None:
            prepared = await service.prepare(
                InvocationStartRequest(prompt="identify").command(),
                owner_id=OWNER_ID,
                user_id=USER_ID,
            )
            async for _event in service.stream(prepared):
                pass

            self.assertEqual(prepared.record.owner_id, OWNER_ID)
            self.assertEqual(prepared.user_id, USER_ID)
            self.assertEqual(requested_users, [USER_ID])
            self.assertEqual(runtime.calls[0]["owner_id"], OWNER_ID)
            self.assertEqual(runtime.calls[0]["user_id"], USER_ID)

        asyncio.run(scenario())

    def test_request_surface_accepts_optional_typed_execution(self) -> None:
        missing_accept = self.client.post("/api/agent/invocations", json=self.request())
        self.assertEqual(missing_accept.status_code, 400)
        extra = self.client.post(
            "/api/agent/invocations",
            headers={"Accept": "text/event-stream"},
            json={"prompt": "hello", "client_attempt_id": "removed"},
        )
        self.assertEqual(extra.status_code, 422)
        invalid_network = self.client.post(
            "/api/agent/invocations",
            headers={"Accept": "text/event-stream"},
            json={
                "prompt": "hello",
                "execution": {"sandbox": "read-only", "network_access": True},
            },
        )
        self.assertEqual(invalid_network.status_code, 422)
        client_full_access = self.client.post(
            "/api/agent/invocations",
            headers={"Accept": "text/event-stream"},
            json={
                "prompt": "hello",
                "execution": {"sandbox": "full-access", "network_access": True},
            },
        )
        self.assertEqual(client_full_access.status_code, 422)
        client_danger_full_access = self.client.post(
            "/api/agent/invocations",
            headers={"Accept": "text/event-stream"},
            json={
                "prompt": "hello",
                "execution": {
                    "sandbox": "danger-full-access",
                    "network_access": False,
                },
            },
        )
        self.assertEqual(client_danger_full_access.status_code, 422)

        configured = self.client.post(
            "/api/agent/invocations",
            headers={"Accept": "text/event-stream"},
            json={
                "prompt": "hello",
                "execution": {
                    "web_search": False,
                    "sandbox": "read-only",
                    "network_access": False,
                    "reasoning_effort": "medium",
                    "service_tier": "standard",
                },
            },
        )
        self.assertEqual(configured.status_code, 200)
        call = self.runtime.calls[-1]
        self.assertEqual(call["permission_mode"], RuntimePermissionMode.READ_ONLY)
        self.assertFalse(call["network_access"])
        self.assertEqual(call["reasoning_effort"], "medium")
        self.assertEqual(call["service_tier"], "standard")
        self.assertEqual(call["required_capabilities"], ())

        full_access = self.client.post(
            "/api/agent/invocations",
            headers={"Accept": "text/event-stream"},
            json={
                "prompt": "hello",
                "execution": {"sandbox": "danger-full-access"},
            },
        )
        self.assertEqual(full_access.status_code, 200)
        call = self.runtime.calls[-1]
        self.assertEqual(call["permission_mode"], RuntimePermissionMode.BYPASS)
        self.assertTrue(call["network_access"])

    def test_trusted_skill_policy_applies_full_access_and_audits_effective_execution(
        self,
    ) -> None:
        self.skills.permission_mode = RuntimePermissionMode.BYPASS
        response = self.client.post(
            "/api/agent/invocations",
            headers={"Accept": "text/event-stream"},
            json={
                "prompt": "browser search",
                "skill": {"id": "builtin:web-search", "profile": "browser"},
                "execution": {"web_search": False},
            },
        )

        self.assertEqual(response.status_code, 200)
        call = self.runtime.calls[-1]
        self.assertEqual(call["permission_mode"], RuntimePermissionMode.BYPASS)
        self.assertEqual(call["required_capabilities"], (RuntimeCapabilityName.SANDBOX,))
        self.assertEqual(call["skill_identity"]["id"], "builtin:web-search")
        self.assertEqual(call["skill_identity"]["profile"], "browser")
        self.assertEqual(self.skills.calls[-1]["profile"], "browser")
        started = frames(response.text)[0]
        self.assertEqual(
            started["data"]["execution"],
            {
                "permission_mode": RuntimePermissionMode.BYPASS.value,
                "network_access": True,
                "web_search": False,
                "developer_prompt": True,
            },
        )
        metadata = json.loads(
            (Path(call["cwd"]).parent / "metadata.json").read_text(encoding="utf-8")
        )
        self.assertEqual(metadata["execution"], started["data"]["execution"])

    def test_only_builtin_catalog_policy_can_resolve_full_access(self) -> None:
        class InventoryRuntime:
            @staticmethod
            async def skill_inventory(**_kwargs):
                return object()

        class Catalog:
            def __init__(self, row: dict[str, Any]) -> None:
                self.row = row

            def payloads(self, *_args):
                return [self.row]

        async def scenario() -> None:
            policy = {"permission": "full-access"}
            base = {
                "name": "browser-search",
                "version": "1.0.0",
                "fingerprint": "fingerprint",
                "path": str(self.skills.manifest),
                "active": True,
                "invocation": policy,
            }
            for skill_id, builtin, expected in (
                ("builtin:browser-search", True, RuntimePermissionMode.BYPASS),
                ("user:browser-search", False, None),
            ):
                resolver = InvocationSkillResolver(
                    InventoryRuntime(),
                    FakeSettings(),
                    Catalog({**base, "id": skill_id, "builtin": builtin}),
                )
                resolved = await resolver.resolve(
                    skill_id=skill_id,
                    cwd=self.root,
                    process_environment={},
                )
                self.assertEqual(resolved.permission_mode, expected)

        asyncio.run(scenario())

    def test_builtin_invocation_profiles_select_exact_permissions(self) -> None:
        manifest = self.skills.manifest

        class InventoryRuntime:
            @staticmethod
            async def skill_inventory(**_kwargs):
                return object()

        class Catalog:
            def payloads(self, *_args):
                return [
                    {
                        "id": "builtin:web-search",
                        "name": "web-search",
                        "version": "1.0.0",
                        "fingerprint": "fingerprint",
                        "path": str(manifest),
                        "active": True,
                        "builtin": True,
                        "invocation": {
                            "profiles": {
                                "native": {"permission": "default"},
                                "official": {"permission": "default"},
                                "browser": {"permission": "full-access"},
                            }
                        },
                    }
                ]

        async def scenario() -> None:
            resolver = InvocationSkillResolver(InventoryRuntime(), FakeSettings(), Catalog())
            for profile, expected in (
                ("native", None),
                ("official", None),
                ("browser", RuntimePermissionMode.BYPASS),
            ):
                resolved = await resolver.resolve(
                    skill_id="builtin:web-search",
                    profile=profile,
                    cwd=self.root,
                    process_environment={},
                )
                self.assertEqual(resolved.profile, profile)
                self.assertEqual(resolved.permission_mode, expected)
            with self.assertRaises(InvocationSkillError):
                await resolver.resolve(
                    skill_id="builtin:web-search",
                    profile="unknown",
                    cwd=self.root,
                    process_environment={},
                )

        asyncio.run(scenario())

    def test_skill_selector_is_resolved_to_typed_runtime_input(self) -> None:
        command = self.request()
        command["skill"] = {"id": "scholarseed:report-skill"}
        response = self.client.post(
            "/api/agent/invocations",
            headers={"Accept": "text/event-stream"},
            json=command,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.skills.calls), 1)
        self.assertNotIn("expected_version", self.skills.calls[0])
        items = self.runtime.calls[0]["items"]
        self.assertEqual(items[0]["kind"], "skill")
        self.assertEqual(items[0]["name"], "report-skill")
        self.assertEqual(items[0]["path"], str(self.skills.manifest))
        self.assertTrue(str(items[1]).startswith("$report-skill"))
        started = frames(response.text)[0]
        self.assertEqual(started["data"]["skill"]["version"], "2.0.0")
        self.assertEqual(started["data"]["skill"]["fingerprint"], "fingerprint-1")

    def test_real_adapter_payload_shapes_are_preserved_by_event_kind(self) -> None:
        projector = InvocationEventProjector("inv-1", self.root)
        progress = projector.project(
            event(
                RuntimeEventKind.TOOL_PROGRESS,
                sequence=1,
                payload={"output": "working", "source": "mcp", "secret": "drop"},
            )
        )
        plan = projector.project(
            event(
                RuntimeEventKind.PLAN_UPDATED,
                sequence=2,
                payload={
                    "explanation": "next",
                    "todos": [{"content": "write", "status": "in_progress", "extra": "drop"}],
                },
            )
        )
        resolved = projector.project(
            event(
                RuntimeEventKind.INTERACTION_RESOLVED,
                sequence=3,
                payload={"request_id": "hil-1", "option_id": "accept", "cancelled": False},
            )
        )
        self.assertEqual(progress["data"], {"output": "working", "source": "mcp"})
        self.assertEqual(
            plan["data"],
            {
                "explanation": "next",
                "todos": [{"content": "write", "status": "in_progress"}],
            },
        )
        self.assertEqual(
            resolved["data"],
            {"request_id": "hil-1", "option_id": "accept", "cancelled": False},
        )

    def test_web_search_extensions_expose_safe_progress_without_raw_results(self) -> None:
        projector = InvocationEventProjector("inv-search", self.root)
        started = projector.project(
            event(
                RuntimeEventKind.RUNTIME_EXTENSION,
                sequence=1,
                payload={
                    "extension_kind": "web_search_started",
                    "query": "Codex invocation API",
                    "action": {
                        "type": "search",
                        "query": "Codex invocation API",
                        "secret": "drop",
                    },
                    "secret": "drop",
                },
            )
        )
        completed = projector.project(
            event(
                RuntimeEventKind.RUNTIME_EXTENSION,
                sequence=2,
                payload={
                    "extension_kind": "web_search_completed",
                    "query": "Codex invocation API",
                    "action": {"type": "search", "query": "Codex invocation API"},
                    "results": [
                        {
                            "title": "private raw result",
                            "url": "https://example.test/private",
                        }
                    ],
                },
            )
        )
        unknown = projector.project(
            event(
                RuntimeEventKind.RUNTIME_EXTENSION,
                sequence=3,
                payload={"extension_kind": "vendor_private", "secret": "drop"},
            )
        )

        self.assertEqual(started["type"], "web_search.started")
        self.assertEqual(
            started["data"],
            {
                "query": "Codex invocation API",
                "action": {"type": "search", "query": "Codex invocation API"},
            },
        )
        self.assertEqual(completed["type"], "web_search.completed")
        self.assertEqual(completed["data"]["result_count"], 1)
        self.assertNotIn("results", completed["data"])
        self.assertIsNone(unknown)

    def test_disconnect_cleans_up_when_runtime_interrupt_is_unavailable(self) -> None:
        async def scenario(cancel_raises: bool) -> None:
            runtime = BlockingRuntime(cancel_raises=cancel_raises)
            service = InvocationService(
                runtime=runtime,
                settings=FakeSettings(),
                skills=self.skills,
                environment=environment,
                root=self.root / ("raises" if cancel_raises else "declines"),
            )
            prepared = await service.prepare(
                InvocationStartRequest(prompt="wait").command(),
                owner_id=OWNER_ID,
                user_id=OWNER_ID,
            )
            stream = service.stream(prepared)
            first = await anext(stream)
            self.assertEqual(first["type"], "invocation.started")
            await runtime.started.wait()
            await stream.aclose()
            self.assertTrue(runtime.cancelled)
            self.assertIsNone(service.bridge_caller(prepared.record.invocation_id))
            metadata = json.loads(
                (Path(prepared.record.workspace).parent / "metadata.json").read_text()
            )
            self.assertEqual(metadata["status"], "unknown")

        asyncio.run(scenario(False))
        asyncio.run(scenario(True))

    def test_cancelled_backpressure_does_not_enqueue_a_ghost_event(self) -> None:
        async def scenario() -> None:
            prepared = await self.service.prepare(
                InvocationStartRequest(prompt="wait").command(),
                owner_id=OWNER_ID,
                user_id=OWNER_ID,
            )
            queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=1)
            await queue.put({"type": "existing"})
            execution = OneShotExecution(
                self.service,
                prepared.record,
                InvocationEventProjector("inv-backpressure", self.root),
                queue,
            )
            blocked = asyncio.create_task(execution.emit({"type": "ghost"}))
            await asyncio.sleep(0)
            blocked.cancel()
            await asyncio.gather(blocked, return_exceptions=True)
            self.assertEqual((await queue.get())["type"], "existing")
            await asyncio.sleep(0)
            self.assertTrue(queue.empty())

        asyncio.run(scenario())

    def test_hil_response_returns_to_the_active_runtime(self) -> None:
        async def scenario() -> None:
            runtime = HilRuntime()
            service = InvocationService(
                runtime=runtime,
                settings=FakeSettings(),
                skills=self.skills,
                environment=environment,
                root=self.root / "hil",
            )
            prepared = await service.prepare(
                InvocationStartRequest(prompt="ask").command(),
                owner_id=OWNER_ID,
                user_id=OWNER_ID,
            )
            received = []
            async for row in service.stream(prepared):
                if row is None:
                    continue
                received.append(row)
                if row["type"] == "interaction.required":
                    accepted = await service.respond(
                        prepared.record.invocation_id,
                        owner_id=OWNER_ID,
                        request_id="hil-1",
                        decision="accept",
                        values={"answer": "yes"},
                    )
                    self.assertTrue(accepted)
            self.assertEqual(received[-1]["type"], "result.completed")
            self.assertEqual(runtime.response.request_id, "hil-1")
            self.assertEqual(runtime.response.values["option_id"], "accept")

        asyncio.run(scenario())


@dataclass
class ScopedPublisher:
    id: str = "scope-1"
    bridge_token: str = "token-1"
    publication_turn_id: str = "turn-1"
    published: dict[str, Any] | None = None

    async def publish_artifact(self, path: str, role: str, *, turn_id: str) -> dict[str, Any]:
        self.published = {"path": path, "role": role, "turn_id": turn_id}
        return self.published


class InvocationBridgeContract(unittest.TestCase):
    def test_artifact_route_accepts_an_authenticated_non_chat_scope(self) -> None:
        publisher = ScopedPublisher()
        app = FastAPI()
        register_artifact_routes(
            app,
            lambda scope_id: publisher if scope_id == publisher.id else None,
        )
        client = TestClient(app)
        denied = client.post(
            "/api/internal/bridge/artifact/publish",
            json={"path": "report.md", "role": "final"},
        )
        accepted = client.post(
            "/api/internal/bridge/artifact/publish",
            headers={
                BRIDGE_SESSION_HEADER: publisher.id,
                BRIDGE_TOKEN_HEADER: publisher.bridge_token,
            },
            json={"path": "report.md", "role": "final"},
        )
        client.close()
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(
            publisher.published,
            {"path": "report.md", "role": "final", "turn_id": "turn-1"},
        )


if __name__ == "__main__":
    unittest.main()
