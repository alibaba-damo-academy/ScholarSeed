"""Deterministic contract for the Service-owned Codex main-session chain."""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import tempfile
import tomllib
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import scholarseed_codex.environment as codex_module
import service.chat.runtime.composition as runtime_module
import service.chat.runtime.live as live_module
import service.chat.service.models as model_module
import service.chat.service.sessions as session_module
import service.chat.service.settings as settings_module
import service.chat.service.turns as turn_module
from scholarseed_codex.protocol.mcp import (
    McpControlCapabilities,
    McpLoginChallenge,
    McpResourceContents,
    McpResourcePage,
    McpResourceView,
    McpSnapshot,
    McpToolCallResult,
    McpToolPage,
    McpToolView,
)
from scholarseed_codex.protocol.state import AppServerError
from scholarseed_codex.turn import CodexTurnRuntime
from scholarseed_runtime.contract import (
    AppliedState,
    CallbackAudience,
    CallbackKind,
    CapabilitySet,
    CommandReceipt,
    CommandState,
    DeliveryClass,
    ModelIntent,
    ModelThinking,
    RuntimeBinding,
    RuntimeCallbackRequest,
    RuntimeControlKind,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeInventory,
    RuntimePermissionMode,
    RuntimeReadiness,
    RuntimeStatus,
)
from scholarseed_runtime.contract.artifact import ArtifactRole
from scholarseed_runtime.contract.capability import RuntimeCapabilityName
from scholarseed_runtime.contract.history import HistoryEntry, MessagePhase, TurnStatus
from scholarseed_runtime.contract.incident import RuntimeRetryability
from scholarseed_runtime.contract.input import CollaborationMode, TurnInput
from scholarseed_runtime.contract.inventory import SkillAvailability, SkillInventory, SkillView
from scholarseed_runtime.contract.resource import ResourcePolicy, ResourceReceipt, ResourceState
from scholarseed_runtime.contract.session import (
    RuntimeActivitySnapshot,
    SuspendReceipt,
    SuspendState,
    SuspendTicket,
)
from service.capabilities.service.skills import SkillCatalog
from service.chat.active import (
    DEVELOPER_PROMPT_FILE,
    RUNTIME_ID,
    base_instructions,
    developer_instructions,
)
from service.chat.api.settings import mount_setting_routes
from service.chat.constants import (
    PRODUCT_EVENT_ANSWER_SOURCES,
    PRODUCT_EVENT_FILE_CHANGED,
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
    PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
    PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
    PRODUCT_EVENT_PAPER_SEARCH_STARTED,
    PRODUCT_EVENT_REASONING_DELTA,
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_SKILL_COMPLETED,
    PRODUCT_EVENT_SKILL_STARTED,
    PRODUCT_EVENT_TOOL_COMPLETED,
    PRODUCT_EVENT_TOOL_STARTED,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
    PRODUCT_EVENT_WEB_SEARCH_STARTED,
    SESSION_TITLE_DEFAULT,
    USER_MESSAGE_BINDING_ADMITTED,
    USER_MESSAGE_BINDING_BOUND,
    SessionTitleFallback,
)
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.catalog import (
    QueuedMessageState,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.provenance import MODEL_RUN_FIELD, ModelRun
from service.chat.runtime.composition import LiveSessionService
from service.chat.runtime.evidence import SessionTrace
from service.chat.runtime.ledger import SessionLedger
from service.chat.runtime.live import LiveSession
from service.chat.runtime.projection import (
    ARTIFACT_PUBLISH_FILE_NOT_FOUND,
    ARTIFACT_PUBLISH_IO_FAILED,
    ARTIFACT_PUBLISH_PATH_INVALID,
    ArtifactPublishError,
    readiness_payload,
)
from service.chat.service.artifacts import ArtifactService
from service.chat.service.completions import CompletionBridge
from service.chat.service.events import EventService
from service.chat.service.models import ModelService
from service.chat.service.publication import (
    PublicationCommand,
    PublicationService,
    SessionArtifactStorage,
)
from service.chat.service.sessions import SessionService, workspace_allows
from service.chat.service.settings import SettingsService
from service.chat.service.turns import TurnService
from service.chat.service.workspaces import SessionWorkspaceService
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.identity.service.skill_credentials import skill_credentials_from_env
from service.paths import SERVICE_BUNDLED_SKILLS_DIR, SERVICE_SKILL_ROOTS, SERVICE_SKILLS_DIR
from service.platform.citations import CITATION_SCHEME
from service.platform.content import ArtifactScopeKind, RootKind
from service.settings.capabilities import apply_capability, bundled_registry
from service.settings.catalog import DEEPRD_GATEWAY_BASE_URL
from service.workbench.domain.model import WorkbenchFormatPolicy

PRODUCT_SESSION_ID = "product-session"
TOGGLE_FORM_MODEL = "qwen3.8-max"
EFFORT_FORM_MODEL = "gpt-5.5"
VENDOR_THREAD_ID = "codex-thread"
OWNER = SessionPrincipal("codex-owner")


# 产品默认提示词 (属于产品资产, 由组合根注入 adapter)。
# 直接复用产品层声明的路径常量, 避免测试自己再拼一遍产品布局。
PRODUCT_PROMPT = DEVELOPER_PROMPT_FILE.read_text(encoding="utf-8")
MAX_DEVELOPER_INSTRUCTION_CHARS = 32_000


class FakeSkillControl:
    def __init__(self, skill_path: Path) -> None:
        self._skill_path = skill_path

    async def list_skills(
        self,
        *,
        cwd: Path | None = None,
        force_reload: bool = False,
    ) -> SkillInventory:
        _ = force_reload
        return SkillInventory(
            cwd=(cwd or self._skill_path.parent).resolve(),
            skills=(
                SkillView(
                    name="test-skill",
                    path=self._skill_path,
                    description="test",
                    availability=SkillAvailability.AVAILABLE,
                    enabled=True,
                ),
            ),
            revision="skill-revision",
        )


class FakeMcpControl:
    capabilities = McpControlCapabilities(
        server_list=True,
        tool_list=True,
        resource_list=True,
        resource_read=True,
        oauth_login=True,
        reload=True,
        direct_tool_call=True,
    )

    def __init__(self) -> None:
        self.direct_calls: list[Any] = []

    async def snapshot(self) -> McpSnapshot:
        return McpSnapshot(RUNTIME_ID, VENDOR_THREAD_ID, "mcp-revision")

    async def list_tools(self, _request: Any) -> McpToolPage:
        return McpToolPage(
            data=(
                McpToolView(
                    runtime_id=RUNTIME_ID,
                    server="papers",
                    name="search",
                    callable_name="papers__search",
                ),
            )
        )

    async def list_resources(self, _request: Any) -> McpResourcePage:
        return McpResourcePage(
            data=(McpResourceView(server="papers", uri="paper://one", name="one"),)
        )

    async def read_resource(self, request: Any) -> McpResourceContents:
        return McpResourceContents(
            server=request.server,
            uri=request.uri,
            contents=({"type": "text", "text": "paper"},),
        )

    async def reload(self, _request: Any) -> McpSnapshot:
        return McpSnapshot(RUNTIME_ID, VENDOR_THREAD_ID, "mcp-reloaded")

    async def call_tool(self, request: Any) -> McpToolCallResult:
        self.direct_calls.append(request)
        return McpToolCallResult(
            server=request.server,
            tool=request.tool,
            ok=True,
            content=({"type": "text", "text": "direct-result"},),
        )

    async def begin_login(self, request: Any) -> McpLoginChallenge:
        return McpLoginChallenge(
            server=request.server,
            authorization_url="https://auth.example/authorize",
        )


class FakeAdapter:
    runtime_id = RUNTIME_ID

    def __init__(self, skill_path: Path) -> None:
        self.session_id = VENDOR_THREAD_ID
        self.history = (HistoryEntry("user", "已有问题", "old-turn", "old-user"),)
        self.runtime = None
        self.agent = self
        self.native_session = None
        self.external_session = self
        self.mcp_control = FakeMcpControl()
        self.skill_control = FakeSkillControl(skill_path)
        self.model_control = None
        self.hil_requests: set[str] = {"hil-1"}
        self.last_turn_input: TurnInput | None = None

    async def interrupt(self) -> None:
        return None

    async def resolve_hil(self, request_id: str, _response: Mapping[str, Any]) -> bool:
        if request_id not in self.hil_requests:
            return False
        self.hil_requests.remove(request_id)
        return True

    async def aclose(self) -> None:
        return None


def fixture_binding(product_session_id: str) -> RuntimeBinding:
    return RuntimeBinding(
        product_session_id=product_session_id,
        runtime_id=RUNTIME_ID,
        adapter_version="fixture",
        runtime_version="fixture",
        protocol_version="2",
        protocol_schema_hash="fixture",
        opaque_session_ref=(
            VENDOR_THREAD_ID
            if product_session_id == PRODUCT_SESSION_ID
            else f"{VENDOR_THREAD_ID}:{product_session_id}"
        ),
        capabilities=CapabilitySet(),
    )


class FakeRuntimeProvider:
    """Deterministic resource SPI fixture: every attachment redeems a distinct grant."""

    descriptor = SimpleNamespace(runtime_id=RUNTIME_ID, capabilities=CapabilitySet())
    resource_policy = ResourcePolicy(wait_seconds=10.0, idle_seconds=1.0)

    def __init__(self, factory: Any) -> None:
        self.factory = factory
        self.requests: list[Any] = []
        self.reservations: dict[str, ResourceReceipt] = {}
        self.opened: list[Any] = []
        self.resumed: list[Any] = []
        self.failure: Exception | None = None

    async def reserve(self, request: Any) -> ResourceReceipt:
        self.requests.append(request)
        receipt = ResourceReceipt(
            request.request_id,
            f"fixture-reservation-{len(self.requests)}",
            ResourceState.GRANTED,
            deadline=request.deadline,
        )
        self.reservations[receipt.reservation_id] = receipt
        return receipt

    async def wait_resource(self, reservation_id: str) -> ResourceReceipt:
        return self.reservations[reservation_id]

    async def cancel_resource(self, reservation_id: str) -> ResourceReceipt:
        receipt = self.reservations[reservation_id]
        if receipt.state is not ResourceState.CONSUMED:
            receipt = ResourceReceipt(
                receipt.request_id,
                reservation_id,
                ResourceState.CANCELLED,
                deadline=receipt.deadline,
            )
            self.reservations[reservation_id] = receipt
        return receipt

    async def _attach(self, request: Any) -> Any:
        receipt = self.reservations[request.reservation_id]
        assert receipt.state is ResourceState.GRANTED
        self.reservations[request.reservation_id] = ResourceReceipt(
            receipt.request_id,
            receipt.reservation_id,
            ResourceState.CONSUMED,
            deadline=receipt.deadline,
        )
        if self.failure is not None:
            raise self.failure
        return await self.factory(request)

    async def open(self, request: Any) -> Any:
        self.opened.append(request)
        return await self._attach(request)

    async def resume(self, request: Any) -> Any:
        self.resumed.append(request)
        return await self._attach(request)


class FakeRuntimeSession:
    capabilities = CapabilitySet()

    def __init__(
        self,
        adapter: FakeAdapter,
        product_session_id: str = PRODUCT_SESSION_ID,
        final_text: str = "完成",
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> None:
        self._adapter = adapter
        self.last_turn_request: Any = None
        self.binding = fixture_binding(product_session_id)
        self.resource_evidence = None
        self._suspend_receipt: SuspendReceipt | None = None
        self._events: asyncio.Queue[RuntimeEvent] = asyncio.Queue()
        self._sequence = 0
        self._final_text = final_text
        self._input_tokens = input_tokens
        self._output_tokens = output_tokens
        self.interrupt_requests: list[Any] = []

    async def reconfigure(self, request: Any) -> AppliedState:
        return AppliedState(request.revision, "", CommandState.RESTART_REQUIRED)

    async def activity(self) -> RuntimeActivitySnapshot:
        return RuntimeActivitySnapshot("fixture-generation", self._sequence, self._sequence, True)

    async def prepare_suspend(self, expected_revision: int) -> SuspendTicket:
        assert expected_revision == self._sequence
        ticket = SuspendTicket(
            "fixture-suspend", "fixture-generation", self._sequence, self._sequence
        )
        self._suspend_receipt = SuspendReceipt(ticket, SuspendState.PREPARED)
        return ticket

    async def commit_suspend(
        self, ticket: SuspendTicket, persisted_watermark: int
    ) -> SuspendReceipt:
        assert self._suspend_receipt is not None and self._suspend_receipt.ticket == ticket
        assert persisted_watermark >= ticket.watermark
        self._suspend_receipt = SuspendReceipt(ticket, SuspendState.RELEASED, finished=True)
        return self._suspend_receipt

    async def abort_suspend(self, ticket: SuspendTicket) -> SuspendReceipt:
        self._suspend_receipt = SuspendReceipt(ticket, SuspendState.ABORTED, finished=True)
        return self._suspend_receipt

    async def suspend_status(self, ticket: SuspendTicket) -> SuspendReceipt:
        assert self._suspend_receipt is not None and self._suspend_receipt.ticket == ticket
        return self._suspend_receipt

    async def snapshot(self) -> dict[str, Any]:
        return {
            "binding": self.binding.opaque_session_ref,
            "active_turn_id": "",
            "usage": {},
            "resume_turns": [],
        }

    async def history(self, _cursor: Any = None) -> list[Any]:
        return [
            {
                "role": row.role,
                "text": row.text,
                "turn_id": row.turn_id,
                "item_id": row.item_id,
                "phase": row.phase.value if row.phase else None,
            }
            for row in self._adapter.history
        ]

    async def inventory(self, request):
        inventory = await self._adapter.skill_control.list_skills()
        return RuntimeInventory(
            inventory.revision, {"skills": SessionService._json_value(inventory)}
        )

    async def events(self) -> Any:
        while True:
            yield await self._events.get()

    async def submit(self, request: Any) -> CommandReceipt:
        self.last_turn_request = request
        for kind, payload in (
            (RuntimeEventKind.TURN_STARTED, {}),
            (
                RuntimeEventKind.CONTENT_COMPLETED,
                {"role": "assistant", "text": self._final_text},
            ),
            (
                RuntimeEventKind.USAGE_UPDATED,
                {
                    "input_tokens": self._input_tokens,
                    "output_tokens": self._output_tokens,
                },
            ),
            (RuntimeEventKind.TURN_COMPLETED, {"status": "completed"}),
        ):
            self._sequence += 1
            await self._events.put(
                RuntimeEvent(
                    schema_version=1,
                    event_id=f"fixture:{self._sequence}",
                    runtime_id=RUNTIME_ID,
                    product_session_id=self.binding.product_session_id,
                    native_session_id=self.binding.opaque_session_ref,
                    process_generation=1,
                    sequence=self._sequence,
                    kind=kind,
                    delivery=DeliveryClass.MUST_PERSIST,
                    observed_at="fixture",
                    native_turn_id=request.command_id,
                    correlation_id=request.command_id,
                    payload=payload,
                )
            )
        return CommandReceipt(request.command_id, CommandState.ACCEPTED)

    async def respond(self, response: Any) -> CommandReceipt:
        accepted = await self._adapter.resolve_hil(response.request_id, response.values)
        return CommandReceipt(
            response.idempotency_key,
            CommandState.APPLIED if accepted else CommandState.REJECTED,
        )

    async def interrupt(self, request: Any) -> CommandReceipt:
        self.interrupt_requests.append(request)
        return CommandReceipt(request.command_id, CommandState.ACCEPTED)

    async def control(self, request: Any) -> AppliedState:
        values = dict(request.values)
        mcp = self._adapter.mcp_control
        if request.kind is RuntimeControlKind.MCP_SNAPSHOT:
            result = await mcp.snapshot()
            payload = SessionService._json_value(result)
            payload["capabilities"] = SessionService._json_value(mcp.capabilities)
        elif request.kind is RuntimeControlKind.MCP_LIST_TOOLS:
            result = await mcp.list_tools(SimpleNamespace(**values))
            payload = SessionService._json_value(result)
        elif request.kind is RuntimeControlKind.MCP_READ_RESOURCE:
            result = await mcp.read_resource(SimpleNamespace(**values))
            payload = SessionService._json_value(result)
        elif request.kind is RuntimeControlKind.MCP_CALL_TOOL:
            result = await mcp.call_tool(SimpleNamespace(**values))
            payload = SessionService._json_value(result)
        elif request.kind is RuntimeControlKind.MCP_LOGIN:
            result = await mcp.begin_login(SimpleNamespace(**values))
            payload = SessionService._json_value(result)
        elif request.kind is RuntimeControlKind.MCP_LIST_PROMPTS:
            return AppliedState(
                request.command_id,
                "",
                CommandState.UNSUPPORTED,
                safe_error="mcp capability is unavailable: prompt_list",
            )
        else:
            return AppliedState(request.command_id, "", CommandState.UNSUPPORTED)
        return AppliedState(
            request.command_id,
            request.command_id,
            CommandState.APPLIED,
            values=payload,
        )

    async def detach(self) -> None:
        return None


class CodexServiceContract(unittest.IsolatedAsyncioTestCase):
    async def test_ledger_terminal_failure_can_retry_after_reconstruction(self):
        for index, service_side in enumerate((False, True)):
            turn_id = f"ledger-retry-{index}"
            self.live.ledger.activate_turn(turn_id)
            await self.live.publish(
                PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
                {
                    "activity_id": "wait",
                    "activity_type": "agent_collaboration",
                    "category": "collaboration",
                    "status": "running",
                    "details": {},
                },
                turn_id=turn_id,
                item_id="wait",
            )
            original = self.events.append

            def fail_terminal(**values):
                if values["kind"] in ("turn_failed", "turn_interrupted"):
                    raise OSError("commit unavailable")
                return original(**values)

            async def finish():
                if service_side:
                    await self.live.ledger.record_turn_failure(
                        turn_id, code="failed", message="failed"
                    )
                else:
                    await self.emit(
                        RuntimeEventKind.TURN_INTERRUPTED,
                        sequence=index + 1,
                        payload={"status": "interrupted"},
                        turn_id=turn_id,
                    )

            with patch.object(self.events, "append", side_effect=fail_terminal):
                with self.assertRaises(OSError):
                    await finish()
            self.assertEqual(self.catalog.get(PRODUCT_SESSION_ID).last_turn_status, "running")
            self.live.ledger = SessionLedger(
                self.live.id,
                self.catalog,
                self.live.publish,
                self.live._trace,
                self.live._logger,
                self.live._projection_lock,
            )
            await finish()
            rows = self.events.turn_records(
                PRODUCT_SESSION_ID,
                turn_id,
                turn_id,
                kinds=(PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,),
            )
            self.assertEqual(len(rows), 1)

    async def test_turn_terminal_persists_collaboration_closures_and_ignores_late_activity(self):
        for index, terminal in enumerate(
            (
                "turn_completed",
                "turn_failed",
                "turn_interrupted",
                "turn_unknown",
            )
        ):
            turn_id = f"collaboration-{index}"
            activity = {
                "activity_id": "wait",
                "activity_type": "agent_collaboration",
                "category": "collaboration",
                "status": "inProgress",
                "details": {"operation": "wait", "receiver_thread_ids": ["child"]},
            }
            await self.live.publish(
                PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
                activity,
                turn_id=turn_id,
                item_id="wait",
            )
            await self.live.publish(
                PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
                activity,
                turn_id="other-turn",
                item_id=f"other-{index}",
            )
            await self.live.publish(
                terminal, {}, turn_id=turn_id, idempotency_key=f"terminal-{index}"
            )
            records = self.events.turn_records(
                PRODUCT_SESSION_ID,
                turn_id,
                turn_id,
                kinds=(
                    PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
                    PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
                    terminal,
                ),
            )
            self.assertEqual(
                [event.kind for event in records],
                [
                    PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
                    PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
                    terminal,
                ],
            )
            closure = records[1]
            self.assertFalse(closure.payload["success"])
            self.assertEqual(closure.payload["details"]["closure_reason"], terminal)
            for kind in (
                PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
                PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
            ):
                late = await self.live.publish(
                    kind, {**activity, "success": True}, turn_id=turn_id, item_id="wait"
                )
                self.assertEqual(late.event_id, closure.event_id)
            await self.live.publish(
                terminal, {}, turn_id=turn_id, idempotency_key=f"terminal-{index}"
            )
            snapshot = EventService({}, self.events, Mock()).activity_snapshot(PRODUCT_SESSION_ID)
            restored = [
                row
                for row in snapshot
                if row["turn_id"] == turn_id
                and row["type"]
                in (
                    PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
                    PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
                )
            ]
            self.assertEqual(len(restored), 2)
        other = self.events.turn_records(
            PRODUCT_SESSION_ID,
            "other-turn",
            "other-turn",
            kinds=(PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,),
        )
        self.assertEqual(other, ())

    async def test_late_collaboration_start_is_closed_after_terminal(self):
        await self.live.publish("turn_interrupted", {}, turn_id="late-turn")
        await self.live.publish(
            PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
            {
                "activity_id": "late",
                "activity_type": "agent_collaboration",
                "category": "collaboration",
                "status": "running",
                "details": {},
            },
            turn_id="late-turn",
            item_id="late",
        )
        records = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual(records[-1].kind, PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED)
        self.assertEqual(records[-1].payload["details"]["closure_reason"], "turn_interrupted")

    async def test_collaboration_terminal_transaction_rolls_back_before_broadcast(self):
        await self.live.publish(
            PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
            {
                "activity_id": "wait",
                "activity_type": "agent_collaboration",
                "category": "collaboration",
                "status": "running",
                "details": {},
            },
            turn_id="atomic-turn",
            item_id="wait",
        )
        original = self.events.append

        def fail_terminal(**values):
            if values["kind"] == "turn_interrupted":
                raise OSError("commit unavailable")
            return original(**values)

        with (
            patch.object(self.events, "append", side_effect=fail_terminal),
            patch.object(
                self.live,
                "_broadcast_product_event",
            ) as broadcast,
        ):
            with self.assertRaises(OSError):
                await self.live.publish("turn_interrupted", {}, turn_id="atomic-turn")
            broadcast.assert_not_called()
        self.assertEqual(len(self.events.replay(PRODUCT_SESSION_ID)), 1)
        await self.live.publish("turn_interrupted", {}, turn_id="atomic-turn")
        self.assertEqual(len(self.events.replay(PRODUCT_SESSION_ID)), 3)

    def test_product_prompt_uses_the_exact_scholarseed_identity(self) -> None:
        prompt = " ".join(base_instructions().split())
        self.assertIn("| Chinese | 书深 | 阿里巴巴达摩院决策智能实验室 |", prompt)
        self.assertIn(
            "| Any other language | ScholarSeed | Alibaba DAMO Academy Decision Intelligence Lab |",
            prompt,
        )
        self.assertIn("never translate, abbreviate, or mix them", prompt)

    def test_response_language_is_a_base_instruction(self) -> None:
        response_language_rule = (
            "Use the language of the user's own request in the **current turn** "
            "for **all user-visible text**"
        )
        prompt = " ".join(base_instructions().split())
        self.assertIn(response_language_rule, prompt)
        self.assertIn("tool-call preambles", prompt)
        self.assertIn("plan steps", prompt)
        self.assertIn("**Before emitting any user-visible text**", prompt)
        self.assertIn("**correct it if needed**", prompt)
        self.assertNotIn(response_language_rule, " ".join(developer_instructions().split()))

    def test_tool_preamble_uses_the_users_language(self) -> None:
        prompt = base_instructions()
        self.assertIn(
            "send a brief preamble to the user in the user's language",
            prompt,
        )
        self.assertIn(
            "Follow the Response Language rule when writing preambles",
            prompt,
        )
        self.assertIn("follow these principles:", prompt)
        self.assertNotIn("follow these principles and examples:", prompt)
        self.assertNotIn("**Examples:**", prompt)
        self.assertNotIn("Add CLI entry with file args", prompt)

    def test_nonresearch_prompt_does_not_require_capability_promotion(self) -> None:
        prompt = developer_instructions()
        self.assertIn("it normally and do not apply the clarification workflow below.", prompt)
        self.assertNotIn("briefly and naturally mention that you", prompt)
        self.assertIn(
            "A fully-specified request asks nothing and routes immediately.",
            " ".join(prompt.split()),
        )
        self.assertIn("Ask ONE item per turn", prompt)
        self.assertIn("Ask in ordinary", prompt)
        self.assertIn("plain-text conversation — no pick-list widgets", prompt)
        self.assertNotIn(
            "`request_user_input` tool to ask it as one structured question card", prompt
        )
        self.assertNotIn(
            "For this task, replace the general ONE-item/plain-text clarification loop", prompt
        )
        self.assertIn("Use the installed precise-literature-search skill", prompt)

    def test_developer_prompt_stays_within_progressive_loading_budget(self) -> None:
        self.assertLessEqual(len(developer_instructions()), MAX_DEVELOPER_INSTRUCTION_CHARS)

    def test_product_prompt_publishes_only_user_facing_deliverables(self) -> None:
        prompt = developer_instructions(output_directory="outputs")
        self.assertIn("tracks other new and changed files as working files", prompt)
        self.assertIn("only published deliverables are shown as conversation file cards", prompt)
        self.assertIn("scholarseed-bridge artifact publish --json", prompt)
        self.assertIn('"role":"final"', prompt)
        self.assertIn("Use `final` for the main deliverable", prompt)
        self.assertIn("`supporting` for additional deliverables", prompt)
        self.assertNotIn("scholarseed-preview", prompt)

    async def asyncSetUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="codex-service-")
        self.root = Path(self._temporary.name)
        self.database = self.root / "sessions.sqlite3"
        self.workdir = self.root / PRODUCT_SESSION_ID
        self.workdir.mkdir()
        self.output_root = self.workdir / "outputs"
        self.output_root.mkdir()
        self.skill_file = self.workdir / "skills" / "test-skill" / "SKILL.md"
        self.skill_file.parent.mkdir(parents=True)
        self.skill_file.write_text("# test\n", encoding="utf-8")
        self.catalog = SessionCatalogStore(self.database)
        self.catalog.register(
            PRODUCT_SESSION_ID,
            OWNER,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_session_id=None,
            runtime_workdir=str(self.workdir),
            project_path=None,
            output_root=str(self.output_root),
            codex_version="codex-cli 1.0",
            model_id="gpt-5-codex",
            policy_id=RuntimePermissionMode.ASK.value,
            status=SessionStatus.READY,
            title=SESSION_TITLE_DEFAULT,
            created_at=1.0,
            runtime_binding=fixture_binding(PRODUCT_SESSION_ID),
        )
        self.events = ProductEventStore(self.database)
        self.artifacts = SessionArtifactStore(self.database)
        content_catalog = ContentCatalog(self.root / "content.sqlite3")
        self.content = ContentService(
            ProjectRegistry(str(self.root), content_catalog), content_catalog
        )
        self.content.bind_artifact_scope(
            ArtifactScopeKind.SESSION, SessionArtifactStorage(self.catalog, self.root).resolve
        )
        self.logger = SimpleNamespace(
            debug=lambda *_args, **_kwargs: None,
            info=lambda *_args, **_kwargs: None,
            error=lambda *_args, **_kwargs: None,
        )
        self.live = LiveSession(
            publications=PublicationService(self.content),
            session_id=PRODUCT_SESSION_ID,
            runtime_id=RUNTIME_ID,
            runtime_workdir=self.workdir,
            project_path=None,
            output_root=self.output_root,
            model_id="gpt-5-codex",
            catalog=self.catalog,
            events=self.events,
            artifacts=self.artifacts,
            skills=SkillCatalog(
                bundled_root=self.skill_file.parent.parent,
                user_root=self.root / "user-skills",
            ),
            logger=self.logger,
            trace=SessionTrace(
                PRODUCT_SESSION_ID,
                self.workdir,
                runtime_id=RUNTIME_ID,
                trace_dir=self.root / "trace",
            ),
            answer_filter=lambda _session_id, _snapshot_id, text: text.replace(
                f"]({CITATION_SCHEME}invalid)", "]"
            ),
        )
        self.adapter = FakeAdapter(self.skill_file)
        self.runtime_session = FakeRuntimeSession(self.adapter)
        self.live.attach_gateway(self.runtime_session, resumed=False)
        self.live.applied_permission_mode = RuntimePermissionMode.ASK.value
        await self.live.activate()

    async def asyncTearDown(self) -> None:
        await self.live.aclose()
        self._temporary.cleanup()

    def runtime_service(
        self, factory: Any = None
    ) -> tuple[LiveSessionService, FakeRuntimeProvider]:
        async def session_factory(request: Any) -> FakeRuntimeSession:
            product_id = (
                request.binding.product_session_id
                if hasattr(request, "binding")
                else request.product_session_id
            )
            return FakeRuntimeSession(FakeAdapter(self.skill_file), product_id)

        provider = FakeRuntimeProvider(factory or session_factory)
        gateway = SimpleNamespace(
            default_runtime_id=RUNTIME_ID,
            provider=lambda _runtime_id="": provider,
            provider_for=lambda _binding: provider,
            inspect=AsyncMock(
                return_value=RuntimeInventory(revision="fixture", values={"skills": {"skills": []}})
            ),
        )
        models = SimpleNamespace(
            selected_model_key=lambda model_id, **_kwargs: model_id,
            validate_effort=AsyncMock(),
            validate_thinking=AsyncMock(),
            session_spec=lambda model_id, **_kwargs: SimpleNamespace(
                key=model_id,
                model_run=None,
                process_environment={},
                reasoning_options=None,
                runtime_model=lambda effort="", thinking=None: (
                    ModelIntent(model_ref=model_id, reasoning_effort=effort, thinking=thinking),
                    None,
                ),
                surface_options=lambda **_kwargs: {
                    "model": model_id,
                    "executable": "codex",
                    "process_environment": {},
                },
            ),
            release_session=Mock(),
        )
        return (
            LiveSessionService(
                catalog=self.catalog,
                events=self.events,
                artifacts=self.artifacts,
                skills=self.live._skills,
                models=models,
                logger=self.logger,
                gateway=gateway,
            ),
            provider,
        )

    def session_service(self, runtime: LiveSessionService) -> SessionService:
        return SessionService(
            self.root,
            {PRODUCT_SESSION_ID: self.live},
            access=self.catalog,
            events=self.events,
            runtime=runtime,
            workspaces=SessionWorkspaceService(workspace_allows),
            artifacts=self.artifacts,
            settings=SimpleNamespace(runtime_executable=lambda: "codex"),
            credentials=skill_credentials_from_env({}),
            logger=self.logger,
        )

    async def test_next_turn_waits_for_retained_product_turn_scope(self) -> None:
        runtime, _provider = self.runtime_service()
        service = self.session_service(runtime)
        self.live.active_product_turn_id = "previous-client-turn"
        with (
            patch.object(runtime, "wait_until_suspended", new=AsyncMock()) as wait,
            patch.object(runtime, "ensure_active", new=AsyncMock()) as ensure,
        ):
            await service.prepare_turn(self.live, request_id="next-client-turn")
        wait.assert_awaited_once_with(self.live, deadline=None)
        ensure.assert_awaited_once()

    async def test_credential_alignment_failure_never_restores_old_authorization(self) -> None:
        runtime, provider = self.runtime_service()
        original_binding = self.live.runtime_binding
        self.live.retarget_environment({"PLATFORM_FIXTURE": "old"})
        provider.failure = RuntimeError("resume refused")
        self.assertTrue(
            await runtime.realign_environment(
                self.live, model_id=self.live.model_id, process_environment={}
            )
        )
        self.assertEqual(provider.resumed, [])
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, "resume refused"):
                await runtime.ensure_active(self.live)
            self.assertEqual(self.live.process_environment, {})
            self.assertIsNone(self.live.runtime_session)
            self.assertEqual(self.live.runtime_binding, original_binding)
        self.assertEqual(len(provider.resumed), 2)
        self.assertEqual(provider.opened, [])
        self.assertTrue(all(not request.launch_secrets.bindings for request in provider.resumed))
        provider.failure = None
        await runtime.ensure_active(self.live)
        self.assertIsNotNone(self.live.runtime_session)
        self.assertEqual(self.live.runtime_binding, original_binding)
        self.assertEqual(provider.opened, [])

    async def test_ordinary_environment_switch_keeps_pending_target(self) -> None:
        runtime, provider = self.runtime_service()
        self.live.retarget_environment({"MODEL_FIXTURE": "old"})
        provider.failure = RuntimeError("switch refused")
        await runtime.realign_environment(
            self.live, model_id=self.live.model_id, process_environment={"MODEL_FIXTURE": "new"}
        )
        self.assertEqual(provider.resumed, [])
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, "switch refused"):
                await runtime.ensure_active(self.live)
        self.assertIsNone(self.live.runtime_session)
        self.assertEqual(self.live.process_environment, {"MODEL_FIXTURE": "new"})
        self.assertEqual(len(provider.resumed), 2)
        for request in provider.resumed:
            secret = await request.secret_port.resolve(
                request.launch_secrets.bindings[0].secret_ref
            )
            self.assertEqual(secret.value, "new")
        provider.failure = None
        await runtime.ensure_active(self.live)
        self.assertIsNotNone(self.live.runtime_session)
        self.assertEqual(self.live.process_environment, {"MODEL_FIXTURE": "new"})

    async def test_new_session_attachment_only_and_title_updates_keep_paired_provenance(
        self,
    ) -> None:
        runtime, _provider = self.runtime_service()
        service = self.session_service(runtime)

        async def ready(_runtime_id: str = "") -> RuntimeReadiness:
            return RuntimeReadiness(
                runtime_id=RUNTIME_ID, status=RuntimeStatus.READY, ready=True, executable="codex"
            )

        runtime._gateway.readiness = ready
        with (
            patch.object(
                service, "_new_paths", return_value=(self.workdir, None, self.output_root)
            ),
            patch.object(
                live_module,
                "SessionTrace",
                side_effect=lambda product_id, workdir, **kwargs: SessionTrace(
                    product_id,
                    workdir,
                    runtime_id=kwargs["runtime_id"],
                    trace_dir=self.root / "title-trace",
                ),
            ),
        ):
            opened, status = await service.open(
                {"model_id": "gpt-5-codex", "permission_mode": "ask"}, OWNER, actor_id=OWNER.user_id
            )
        self.assertEqual(status, 200, opened)
        session_id = opened["session_id"]
        live = service._sessions[session_id]
        try:
            self.assertEqual(opened["title"], SESSION_TITLE_DEFAULT)
            self.assertEqual(opened["title_fallback"], SessionTitleFallback.NEW_SESSION)
            attachment = self.workdir / "title-input.txt"
            attachment.write_text("attached content", encoding="utf-8")
            turns = TurnService({session_id: live}, self.logger, prepare=service.prepare_turn)
            result, status = await turns.post(
                session_id,
                {
                    "wait": True,
                    "input": [{"type": "file", "path": str(attachment), "name": attachment.name}],
                },
                side=False,
            )
            self.assertEqual(status, 202, result)
            self.assertTrue(result["ok"], result)
            record = self.catalog.get(session_id)
            self.assertEqual(record.title, SESSION_TITLE_DEFAULT)
            self.assertEqual(record.title_fallback, SessionTitleFallback.NEW_SESSION)
            listing = await service.list(10, OWNER)
            row = next(row for row in listing["sessions"] if row["session_id"] == session_id)
            self.assertEqual(row["turns"], 1)
            self.assertEqual(
                (row["title"], row["title_fallback"]), (opened["title"], opened["title_fallback"])
            )
            resumed, status = await service.open(
                {"resume_session_id": session_id}, OWNER, actor_id=OWNER.user_id
            )
            self.assertEqual(status, 200, resumed)
            self.assertEqual(resumed["title_fallback"], SessionTitleFallback.NEW_SESSION)
            self.assertTrue(await live.adopt_user_title("First text request", turn_id="named-turn"))
            self.assertIsNone(self.catalog.get(session_id).title_fallback)
            events = [
                event
                for event in self.events.replay(session_id)
                if event.kind == "session_title_updated"
            ]
            self.assertEqual(
                events[-1].payload, {"title": "First text request", "title_fallback": None}
            )
            renamed, status = await service.rename(session_id, SESSION_TITLE_DEFAULT, OWNER)
            self.assertEqual(status, 200)
            self.assertEqual(renamed["title"], SESSION_TITLE_DEFAULT)
            self.assertIsNone(renamed["title_fallback"])
            # Old raw-empty rows receive a display marker without any database write.
            self.catalog.rename(session_id, OWNER, "")
            listing = await service.list(10, OWNER)
            row = next(row for row in listing["sessions"] if row["session_id"] == session_id)
            self.assertEqual(row["title"], SESSION_TITLE_DEFAULT)
            self.assertEqual(row["title_fallback"], SessionTitleFallback.NEW_SESSION)
            self.assertEqual(self.catalog.get(session_id).title, "")
            self.assertIsNone(self.catalog.get(session_id).title_fallback)
        finally:
            await live.aclose()

    async def test_model_connection_reconnects_same_session_after_reservation(self) -> None:
        runtime, provider = self.runtime_service()
        service = self.session_service(runtime)
        binding = self.live.runtime_binding
        payload, status = await service.set_model(
            PRODUCT_SESSION_ID, OWNER, "target", actor_id=OWNER.user_id, reasoning_effort="high"
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["active_model_id"], "target")
        self.assertFalse(payload["deferred"])
        self.assertEqual(payload["active_reasoning_effort"], "high")
        self.assertEqual(self.live.runtime_binding, binding)
        self.assertEqual(provider.opened, [])
        self.assertEqual(len(provider.resumed), 1)
        self.assertEqual(provider.resumed[0].binding, binding)
        self.assertEqual(provider.resumed[0].model.model_ref, "target")
        self.assertTrue(provider.resumed[0].reservation_id)
        self.assertEqual(provider.resumed[0].model.reasoning_effort, "high")

    async def test_thinking_selection_reaches_runtime_and_projection(self) -> None:
        runtime, provider = self.runtime_service()
        service = self.session_service(runtime)
        payload, status = await service.set_model(
            PRODUCT_SESSION_ID,
            OWNER,
            "target",
            actor_id=OWNER.user_id,
            thinking=ModelThinking(enabled=False),
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["thinking"], {"enabled": False, "budget": None})
        self.assertEqual(payload["active_thinking"], {"enabled": False, "budget": None})
        self.assertFalse(payload["deferred"])
        state = self.catalog.model_state(PRODUCT_SESSION_ID)
        self.assertEqual(state.selected_thinking, ModelThinking(enabled=False))
        self.assertEqual(provider.resumed[-1].model.thinking, ModelThinking(enabled=False))
        # 只改思考形态也必须换激活代次：否则 runtime 认为意图没变，选择永远不会出站。
        payload, _status = await service.set_model(
            PRODUCT_SESSION_ID,
            OWNER,
            "target",
            actor_id=OWNER.user_id,
            thinking=ModelThinking(enabled=True),
        )
        self.assertEqual(payload["thinking"], {"enabled": True, "budget": None})
        self.assertEqual(payload["active_thinking"], {"enabled": True, "budget": None})
        self.assertEqual(provider.resumed[-1].model.thinking, ModelThinking(enabled=True))
        # 只发档位的旧客户端不能被拉去做形态准入，也不能被当成「清空思考」之外的东西。
        payload, _status = await service.set_model(
            PRODUCT_SESSION_ID, OWNER, "target", actor_id=OWNER.user_id, reasoning_effort="low"
        )
        self.assertIsNone(payload["thinking"])
        self.assertIsNone(self.catalog.model_state(PRODUCT_SESSION_ID).selected_thinking)
        self.assertIsNone(provider.resumed[-1].model.thinking)

    async def test_undeclared_thinking_form_is_rejected_before_persisting(self) -> None:
        runtime, provider = self.runtime_service()
        service = self.session_service(runtime)
        refusals: list[Any] = []

        async def refuse(_model_id: str, thinking: Any, **_kwargs: Any) -> None:
            refusals.append(thinking)
            raise model_module.SessionModelUnavailableError("所选模型不支持思考开关，请重新选择。")

        runtime._models.validate_thinking = refuse  # pylint: disable=protected-access
        payload, status = await service.set_model(
            PRODUCT_SESSION_ID,
            OWNER,
            "target",
            actor_id=OWNER.user_id,
            thinking=ModelThinking(enabled=True),
        )
        self.assertEqual(status, 400, payload)
        self.assertEqual(payload["error"], "session_model_unavailable")
        self.assertEqual(refusals, [ModelThinking(enabled=True)])
        self.assertIsNone(self.catalog.model_state(PRODUCT_SESSION_ID).selected_thinking)
        self.assertEqual(provider.resumed, [])

    def _stalled_admission(self, provider: Any) -> tuple[asyncio.Event, asyncio.Event, Any]:
        """把首次准入停在 WAITING，返回 ``(已进入, 放行, 需 with 的补丁上下文)``。"""

        entered = asyncio.Event()
        grant = asyncio.Event()
        reserve = provider.reserve

        async def waiting_reserve(request: Any) -> ResourceReceipt:
            receipt = await reserve(request)
            if len(provider.requests) == 1:
                receipt = ResourceReceipt(
                    receipt.request_id,
                    receipt.reservation_id,
                    ResourceState.WAITING,
                    deadline=receipt.deadline,
                )
                provider.reservations[receipt.reservation_id] = receipt
            return receipt

        async def wait_resource(reservation_id: str) -> ResourceReceipt:
            self.assertFalse(self.live.lifecycle_lock.locked())
            entered.set()
            await grant.wait()
            receipt = provider.reservations[reservation_id]
            granted = ResourceReceipt(
                receipt.request_id,
                reservation_id,
                ResourceState.GRANTED,
                deadline=receipt.deadline,
            )
            provider.reservations[reservation_id] = granted
            return granted

        stack = ExitStack()
        stack.enter_context(patch.object(provider, "reserve", waiting_reserve))
        stack.enter_context(patch.object(provider, "wait_resource", wait_resource))
        return entered, grant, stack

    async def test_thinking_changed_while_waiting_replaces_stale_admission(self) -> None:
        runtime, provider = self.runtime_service()
        service = self.session_service(runtime)
        self.assertTrue(await self.live.suspend_runtime())
        await service.set_model(
            PRODUCT_SESSION_ID,
            OWNER,
            self.live.model_id,
            actor_id=OWNER.user_id,
            thinking=ModelThinking(enabled=False),
        )
        entered, grant, stalled = self._stalled_admission(provider)
        with stalled:
            task = asyncio.create_task(service.prepare_turn(self.live))
            try:
                await asyncio.wait_for(entered.wait(), 2.0)
                payload, status = await service.set_model(
                    PRODUCT_SESSION_ID,
                    OWNER,
                    self.live.model_id,
                    actor_id=OWNER.user_id,
                    thinking=ModelThinking(enabled=True),
                )
                self.assertEqual(status, 200)
                self.assertTrue(payload["deferred"])
                self.assertEqual(provider.resumed, [])
                grant.set()
                await asyncio.wait_for(task, 2.0)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        # 关掉思考的那份计划被作废：两次下发记录里，最终生效的必须是新意图。
        self.assertEqual(
            [request.session_request.model.thinking for request in provider.requests],
            [ModelThinking(enabled=False), ModelThinking(enabled=True)],
        )
        self.assertEqual(len(provider.resumed), 1)

    async def test_failed_model_activation_keeps_selected_target_and_rejects_turn(self) -> None:
        runtime, provider = self.runtime_service()
        service = self.session_service(runtime)
        provider.failure = ValueError("unavailable")
        previous = self.catalog.model_state(PRODUCT_SESSION_ID).active_model_id
        payload, status = await service.set_model(
            PRODUCT_SESSION_ID, OWNER, "target", actor_id=OWNER.user_id, reasoning_effort="high"
        )
        self.assertEqual(status, 500)
        self.assertEqual(payload["model_id"], "target")
        self.assertEqual(payload["active_model_id"], "")
        self.assertEqual(payload["reasoning_effort"], "high")
        self.assertEqual(payload["active_reasoning_effort"], "")
        self.assertTrue(payload["deferred"])
        self.assertEqual(self.catalog.model_state(PRODUCT_SESSION_ID).selected_model_id, "target")
        self.assertEqual(self.catalog.model_state(PRODUCT_SESSION_ID).active_model_id, previous)
        with self.assertRaisesRegex(ValueError, "unavailable"):
            await service.prepare_turn(self.live)
        self.assertIsNone(self.live.runtime_session)
        self.assertEqual(
            [request.model.model_ref for request in provider.resumed], ["target", "target"]
        )
        self.assertEqual(provider.opened, [])
        self.assertTrue(
            all(request.model.reasoning_effort == "high" for request in provider.resumed)
        )

    async def test_effort_changed_while_waiting_replaces_stale_admission(self) -> None:
        runtime, provider = self.runtime_service()
        service = self.session_service(runtime)
        binding = self.live.runtime_binding
        self.assertTrue(await self.live.suspend_runtime())
        await service.set_model(
            PRODUCT_SESSION_ID,
            OWNER,
            self.live.model_id,
            actor_id=OWNER.user_id,
            reasoning_effort="low",
        )
        entered = asyncio.Event()
        grant = asyncio.Event()
        reserve = provider.reserve

        async def waiting_reserve(request: Any) -> ResourceReceipt:
            receipt = await reserve(request)
            if len(provider.requests) == 1:
                receipt = ResourceReceipt(
                    receipt.request_id,
                    receipt.reservation_id,
                    ResourceState.WAITING,
                    deadline=receipt.deadline,
                )
                provider.reservations[receipt.reservation_id] = receipt
            return receipt

        async def wait_resource(reservation_id: str) -> ResourceReceipt:
            self.assertFalse(self.live.lifecycle_lock.locked())
            entered.set()
            await grant.wait()
            receipt = provider.reservations[reservation_id]
            granted = ResourceReceipt(
                receipt.request_id,
                reservation_id,
                ResourceState.GRANTED,
                deadline=receipt.deadline,
            )
            provider.reservations[reservation_id] = granted
            return granted

        with (
            patch.object(provider, "reserve", waiting_reserve),
            patch.object(provider, "wait_resource", wait_resource),
        ):
            task = asyncio.create_task(service.prepare_turn(self.live))
            try:
                await asyncio.wait_for(entered.wait(), 2.0)
                payload, status = await service.set_model(
                    PRODUCT_SESSION_ID,
                    OWNER,
                    self.live.model_id,
                    actor_id=OWNER.user_id,
                    reasoning_effort="high",
                )
                self.assertEqual(status, 200)
                self.assertTrue(payload["deferred"])
                self.assertEqual(payload["active_reasoning_effort"], "")
                self.assertEqual(provider.resumed, [])
                grant.set()
                await asyncio.wait_for(task, 2.0)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(
            [r.session_request.model.reasoning_effort for r in provider.requests], ["low", "high"]
        )
        self.assertEqual(len(provider.resumed), 1)
        self.assertEqual(provider.resumed[0].model.reasoning_effort, "high")
        self.assertEqual(provider.resumed[0].binding, binding)
        self.assertEqual(
            self.catalog.model_state(PRODUCT_SESSION_ID).active_reasoning_effort, "high"
        )
        self.assertEqual(
            provider.reservations["fixture-reservation-1"].state, ResourceState.CANCELLED
        )

    async def emit(
        self,
        kind: RuntimeEventKind,
        *,
        sequence: int,
        payload: Mapping[str, Any],
        turn_id: str = "turn-1",
        item_id: str = "item-1",
    ) -> None:
        data = dict(payload)
        if isinstance(kind, CallbackKind):
            await self.live.on_runtime_observation(
                RuntimeCallbackRequest(
                    schema_version=1,
                    runtime_id=RUNTIME_ID,
                    product_session_id=PRODUCT_SESSION_ID,
                    native_session_id=VENDOR_THREAD_ID,
                    request_id=str(data["request_id"]),
                    audience=CallbackAudience.USER,
                    kind=kind,
                    blocking=True,
                    prompt=data,
                    response_contract={},
                    observed_at="fixture",
                    native_turn_id=turn_id,
                    native_item_id=item_id,
                )
            )
            return
        if not isinstance(kind, RuntimeEventKind):
            data["extension_kind"] = kind
            kind = RuntimeEventKind.RUNTIME_EXTENSION
        if kind is RuntimeEventKind.CONTENT_DELTA:
            data["role"] = "assistant"
        await self.live.on_runtime_observation(
            RuntimeEvent(
                schema_version=1,
                event_id=f"projection:{sequence}",
                product_session_id=PRODUCT_SESSION_ID,
                process_generation=1,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at="fixture",
                runtime_id=RUNTIME_ID,
                native_session_id=VENDOR_THREAD_ID,
                kind=kind,
                native_turn_id=turn_id,
                native_item_id=item_id,
                sequence=sequence,
                payload=data,
            )
        )

    async def test_completed_commentary_preserves_identity_and_phase(self) -> None:
        await self.emit(
            RuntimeEventKind.CONTENT_COMPLETED,
            sequence=1,
            payload={"role": "assistant", "phase": "commentary", "text": "正在计算。"},
            turn_id="commentary-turn",
            item_id="commentary-item",
        )
        entry = self.live.portable_history_entries[-1]
        self.assertEqual(entry.item_id, "commentary-item")
        self.assertEqual(entry.turn_id, "commentary-turn")
        self.assertEqual(entry.phase.value, "commentary")
        self.assertEqual(entry.text, "正在计算。")

    async def test_completed_answer_persists_sources_verified_against_same_turn_search(
        self,
    ) -> None:
        await self.emit(
            "web_search_completed",
            sequence=1,
            payload={
                "query": "source",
                "results": [{"title": "Verified", "url": "https://example.test/verified"}],
            },
            turn_id="source-turn",
            item_id="search-1",
        )
        await self.emit(
            RuntimeEventKind.CONTENT_COMPLETED,
            sequence=2,
            payload={
                "role": "assistant",
                "phase": "final_answer",
                "text": (
                    "Verified [48](https://example.test/verified), "
                    "ordinary [link](https://other.test)."
                ),
            },
            turn_id="source-turn",
            item_id="answer-1",
        )

        source_event = next(
            event
            for event in self.events.replay(PRODUCT_SESSION_ID)
            if event.kind == PRODUCT_EVENT_ANSWER_SOURCES
        )
        self.assertEqual(source_event.vendor_item_id, "answer-1")
        self.assertEqual(
            source_event.payload["sources"],
            [
                {
                    "kind": "searched",
                    "url": "https://example.test/verified",
                    "title": "Verified",
                    "search_kind": "web",
                    "search_id": "search-1",
                    "citation_urls": ["https://example.test/verified"],
                    "number": 1,
                }
            ],
        )

    async def test_source_projection_failure_does_not_drop_completed_answer_history(self) -> None:
        with patch.object(
            live_module,
            "answer_sources",
            side_effect=RuntimeError("projection failed"),
        ):
            await self.emit(
                RuntimeEventKind.CONTENT_COMPLETED,
                sequence=3,
                payload={
                    "role": "assistant",
                    "phase": "final_answer",
                    "text": "Answer survives optional source projection.",
                },
                turn_id="source-failure-turn",
                item_id="source-failure-answer",
            )

        entry = self.live.portable_history_entries[-1]
        self.assertEqual(entry.text, "Answer survives optional source projection.")
        self.assertEqual(entry.item_id, "source-failure-answer")

    async def test_completed_body_replaces_streamed_declaration_text(self) -> None:
        await self.emit(
            RuntimeEventKind.CONTENT_DELTA,
            sequence=60,
            payload={"text": '报告已生成。\n::scholarseed-preview{file="report.md"}'},
        )
        await self.emit(
            RuntimeEventKind.CONTENT_COMPLETED,
            sequence=61,
            payload={"role": "assistant", "phase": "final_answer", "text": "报告已生成。"},
        )
        events = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual(events[-1].kind, "message_delta")
        self.assertEqual(events[-1].payload, {"delta": "报告已生成。", "phase": "final_answer"})
        self.assertEqual(events[-1].vendor_item_id, events[-2].vendor_item_id)
        await self.emit(
            RuntimeEventKind.CONTENT_COMPLETED,
            sequence=62,
            payload={"role": "assistant", "text": ""},
            item_id="only-declaration",
        )
        self.assertEqual(self.events.replay(PRODUCT_SESSION_ID)[-1].payload, {"delta": ""})

    async def test_completed_answer_applies_snapshot_citation_filter_before_persistence(
        self,
    ) -> None:
        self.live.active_assistant_snapshot_id = "snapshot-1"
        await self.emit(
            RuntimeEventKind.CONTENT_COMPLETED,
            sequence=63,
            payload={
                "role": "assistant",
                "phase": "final_answer",
                "text": f"Evidence [1]({CITATION_SCHEME}invalid).",
            },
            item_id="citation-filtered",
        )

        event = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(event.payload["delta"], "Evidence [1].")
        self.assertEqual(self.live.portable_history_entries[-1].text, "Evidence [1].")

    async def test_answer_model_snapshot_survives_tail_frame_and_history_reload(self) -> None:
        selected = ModelRun(
            "provider-a", "Provider A", "selected-a", provider_preset_id="dashscope"
        )
        self.live.model_run = selected
        await self.live.record_user_history("Question", turn_id="client-a", item_id="client-a")
        with patch.object(self.live.runtime_driver, "submit", new=AsyncMock()):
            await self.live.run_runtime(TurnInput(items=(), client_user_message_id="client-a"))
        # A later selection cannot change the already admitted turn's fallback.
        self.live.model_run = ModelRun("provider-b", "Provider B", "selected-b")
        await self.emit(RuntimeEventKind.TURN_STARTED, sequence=1, payload={})
        await self.live.bind_user_history("client-a", vendor_turn_id="turn-1")
        await self.emit(
            RuntimeEventKind.CONTENT_COMPLETED,
            sequence=2,
            payload={"role": "assistant", "text": "Earlier answer"},
            item_id="earlier",
        )
        await self.emit(
            RuntimeEventKind.CONTENT_COMPLETED,
            sequence=3,
            payload={"role": "assistant", "text": "Final answer"},
            item_id="final",
        )
        self.live.observe_model("another-client", "wrong-model")
        self.assertEqual(self.live.answer_model("turn-1")[MODEL_RUN_FIELD], selected.payload())
        # Upstream reports its actual model only after the final content item.
        self.live.observe_model("client-a", "actual-a-version")
        # TurnService binds again after completion; model observation must not
        # mutate the existing user-binding event and break idempotent replay.
        await self.live.bind_user_history("client-a", vendor_turn_id="turn-1")
        await self.emit(
            RuntimeEventKind.TURN_COMPLETED,
            sequence=4,
            payload={"status": "completed"},
        )
        records = self.events.replay(PRODUCT_SESSION_ID)
        answers = [record for record in records if record.kind == PRODUCT_EVENT_MESSAGE_DELTA]
        self.assertEqual(len(answers), 3)

        self.assertEqual(answers[0].payload[MODEL_RUN_FIELD], selected.payload())
        self.assertEqual(answers[-1].vendor_item_id, "final")
        self.assertEqual(
            answers[-1].payload[MODEL_RUN_FIELD]["actual_model_id"], "actual-a-version"
        )
        self.assertLess(
            answers[-1].product_seq,
            next(
                record.product_seq
                for record in records
                if record.kind == PRODUCT_EVENT_TURN_COMPLETED
            ),
        )
        # Restore from durable events with no live session or selected-model access.
        restored = EventService({}, ProductEventStore(self.database), self.logger).decorate_history(
            PRODUCT_SESSION_ID,
            [
                {
                    "role": "assistant",
                    "turn_id": "turn-1",
                    "item_id": "earlier",
                    "text": "Earlier answer",
                },
                {
                    "role": "assistant",
                    "turn_id": "turn-1",
                    "item_id": "final",
                    "text": "Final answer",
                },
                {
                    "role": "assistant",
                    "turn_id": "old-turn",
                    "item_id": "legacy",
                    "text": "Legacy answer",
                },
            ],
        )
        restored = [row for row in restored if row.get("role") == "assistant"]
        self.assertEqual(restored[0][MODEL_RUN_FIELD], selected.payload())
        self.assertEqual(restored[1][MODEL_RUN_FIELD]["provider_id"], "provider-a")
        self.assertEqual(restored[1][MODEL_RUN_FIELD]["actual_model_id"], "actual-a-version")
        self.assertEqual(restored[1][MODEL_RUN_FIELD]["provider_preset_id"], "dashscope")
        self.assertNotIn(MODEL_RUN_FIELD, restored[2])

    async def test_product_turn_source_waits_for_descendant_quiescence(self) -> None:
        self.live.active_product_turn_id = "client-a"
        active = RuntimeActivitySnapshot(
            "fixture-generation",
            1,
            1,
            True,
            ("native_turn_active",),
        )
        idle = RuntimeActivitySnapshot("fixture-generation", 2, 2, True)
        session = self.live.runtime_session
        self.assertIsNotNone(session)
        assert session is not None
        with patch.object(session, "activity", new=AsyncMock(side_effect=(active, idle))):
            self.assertFalse(await self.live.release_product_turn("client-a"))
            self.assertEqual(self.live.active_product_turn_id, "client-a")
            self.assertTrue(await self.live.release_product_turn("client-a"))
        self.assertEqual(self.live.active_product_turn_id, "")

    async def test_product_turn_source_is_retained_when_inspection_fails(self) -> None:
        self.live.active_product_turn_id = "client-a"
        session = self.live.runtime_session
        self.assertIsNotNone(session)
        assert session is not None
        with patch.object(session, "activity", new=AsyncMock(side_effect=RuntimeError("private"))):
            self.assertFalse(await self.live.release_product_turn("client-a"))
        self.assertEqual(self.live.active_product_turn_id, "client-a")

    async def test_project_cwd_watcher_does_not_claim_new_session_files(self) -> None:
        project = self.content.adopt_project(str(self.workdir))
        owned = self.content.root(project.id, RootKind.SESSIONS)
        directory = self.content.ensure_directory(project.id, owned.path, "other-session")
        other = Path(self.content.resolve(project.id, directory.path)) / "result.md"
        other.write_text("other session", encoding="utf-8")
        self.live.project_path = self.workdir
        self.live.project_id = project.id
        await self.emit(
            RuntimeEventKind.ARTIFACT_OBSERVED,
            sequence=1,
            payload={"status": "completed", "changes": [{"path": str(other)}]},
            item_id="other-file",
        )
        self.assertEqual(self.live.artifact_snapshot(), [])
        self.assertFalse(
            any(event.kind == "runtime_error" for event in self.events.replay(PRODUCT_SESSION_ID))
        )

    async def test_resource_change_outside_session_cwd_keeps_delivery_hint(self) -> None:
        project = self.content.adopt_project(str(self.workdir))
        owned = self.content.root(project.id, RootKind.SESSIONS)
        directory = self.content.ensure_directory(project.id, owned.path, PRODUCT_SESSION_ID)
        cwd = Path(self.content.resolve(project.id, directory.path))
        self.live.relocate(cwd=cwd, project_path=self.workdir, output_root=cwd)
        self.live.project_id = project.id
        hints = AsyncMock()
        self.live._resource_changes = hints
        resource = self.workdir / "shared.md"
        resource.write_text("shared material", encoding="utf-8")
        await self.emit(
            RuntimeEventKind.ARTIFACT_OBSERVED,
            sequence=1,
            payload={"status": "completed", "changes": [{"path": str(resource)}]},
            item_id="resource-file",
        )
        hints.record_change.assert_awaited_once()
        self.assertEqual(hints.record_change.call_args.args[2], str(resource.resolve()))
        self.assertEqual(self.live.artifact_snapshot(), [])
        self.assertFalse(
            any(event.kind == "runtime_error" for event in self.events.replay(PRODUCT_SESSION_ID))
        )

    async def test_plan_file_and_artifact_projection_is_correlated(self) -> None:
        await self.emit(
            RuntimeEventKind.PLAN_UPDATED,
            sequence=1,
            payload={
                "todos": [{"content": "运行实验", "status": "in_progress"}],
                "explanation": "先完成可复现实验",
            },
        )
        artifact_file = self.output_root / "result.md"
        artifact_file.write_text("# result\n", encoding="utf-8")
        await self.emit(
            RuntimeEventKind.ARTIFACT_OBSERVED,
            sequence=2,
            payload={"status": "completed", "changes": [{"path": "outputs/result.md"}]},
            item_id="file-item",
        )

        event_types = [event.kind for event in self.events.replay(PRODUCT_SESSION_ID)]
        self.assertEqual(event_types, ["plan_snapshot", "file_changed", "artifact_changed"])

        record = self.catalog.get(PRODUCT_SESSION_ID)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.todos[0]["content"], "运行实验")
        self.assertEqual(record.todo_turn_id, "turn-1")
        self.assertEqual(record.todo_explanation, "先完成可复现实验")
        plan_event = self.events.replay(PRODUCT_SESSION_ID)[0]
        self.assertEqual(plan_event.vendor_turn_id, "turn-1")
        self.assertEqual(plan_event.vendor_item_id, "item-1")
        envelope = self.live.event_envelope(plan_event)
        self.assertEqual(envelope["turn_id"], "turn-1")
        self.assertEqual(envelope["item_id"], "item-1")
        indexed = self.artifacts.list_session(PRODUCT_SESSION_ID)
        self.assertEqual(len(indexed), 1)
        self.assertEqual(indexed[0].vendor_item_id, "file-item")
        self.assertEqual(indexed[0].source_product_seq, 2)
        self.assertTrue(indexed[0].content_sha256)
        history = SessionService(
            self.root,
            {PRODUCT_SESSION_ID: self.live},
            access=self.catalog,
            events=self.events,
            runtime=SimpleNamespace(),  # type: ignore[arg-type]
            workspaces=SessionWorkspaceService(workspace_allows),
            artifacts=self.artifacts,
            settings=SimpleNamespace(runtime_executable=lambda: ""),  # type: ignore[arg-type]
            credentials=skill_credentials_from_env({}),
            logger=self.logger,
        ).history(PRODUCT_SESSION_ID)
        self.assertEqual(history["todo_turn_id"], "turn-1")
        self.assertEqual(history["todo_explanation"], "先完成可复现实验")

    async def test_explicit_artifact_publish_is_content_bound_and_idempotent(self) -> None:
        artifact_file = self.output_root / "published.md"
        artifact_file.write_text("# explicit artifact\n", encoding="utf-8")

        first = await self.live.publish_artifact(
            "outputs/published.md", "final", turn_id="turn-publish"
        )
        repeated = await self.live.publish_artifact(
            "outputs/published.md", "final", turn_id="turn-publish"
        )

        self.assertEqual(first, repeated)
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())
        reader.bind_content(self.content)
        artifact_file.write_text("# later edit\n", encoding="utf-8")
        self.assertEqual(
            reader.read_text(PRODUCT_SESSION_ID, first["artifact_id"])["content"],
            "# explicit artifact\n",
        )
        indexed = self.artifacts.list_session(PRODUCT_SESSION_ID)
        self.assertEqual(len(indexed), 1)
        self.assertEqual(indexed[0].source_kind.value, "artifact.publish")
        self.assertEqual(indexed[0].status.value, "published")
        self.assertEqual(indexed[0].role, "final")
        self.assertEqual(
            [event.kind for event in self.events.replay(PRODUCT_SESSION_ID)],
            ["artifact_published", "artifact_changed"],
        )

        with self.assertRaisesRegex(ArtifactPublishError, ARTIFACT_PUBLISH_PATH_INVALID):
            await self.live.publish_artifact(str(artifact_file), "final", turn_id="turn-publish")
        with self.assertRaisesRegex(ArtifactPublishError, ARTIFACT_PUBLISH_FILE_NOT_FOUND):
            await self.live.publish_artifact("outputs/missing.md", "final", turn_id="turn-publish")

    async def test_runtime_declarations_publish_or_fail_explicitly(self) -> None:
        (self.output_root / "report.md").write_text("# report", encoding="utf-8")
        await self.emit(
            RuntimeEventKind.ARTIFACT_DECLARED,
            sequence=30,
            payload={
                "declaration_id": "working-ref",
                "path": "outputs/report.md",
                "role": "intermediate",
                "title": "过程",
            },
        )
        self.assertEqual(
            [row.kind for row in self.events.replay(PRODUCT_SESSION_ID)],
            ["artifact_declared", "artifact_changed"],
        )
        await self.emit(
            RuntimeEventKind.ARTIFACT_DECLARED,
            sequence=31,
            payload={
                "declaration_id": "final-ref",
                "path": "outputs/report.md",
                "role": "final",
                "title": "研究报告",
            },
        )
        self.assertEqual(len(self.live.artifact_snapshot()), 2)
        self.assertEqual(self.live.artifact_snapshot()[-1]["title"], "研究报告")
        await self.emit(
            RuntimeEventKind.ARTIFACT_DECLARED,
            sequence=32,
            payload={"declaration_id": "missing", "path": "outputs/missing.md", "role": "final"},
        )
        self.assertEqual(self.events.replay(PRODUCT_SESSION_ID)[-1].kind, "artifact_failed")
        self.assertEqual(len(self.live.artifact_snapshot()), 2)

    async def test_artifact_io_failure_does_not_expose_local_paths(self) -> None:
        private_path = "/private/account-data/secret-report.md"
        failure = PermissionError(13, "Permission denied", private_path)
        with patch.object(self.live._publications, "publish", side_effect=failure):
            await self.emit(
                RuntimeEventKind.ARTIFACT_DECLARED,
                sequence=36,
                payload={
                    "declaration_id": "io-final",
                    "path": "outputs/report.md",
                    "role": "final",
                },
            )
        with patch.object(self.live, "_declare_working_artifact", side_effect=failure):
            await self.emit(
                RuntimeEventKind.ARTIFACT_DECLARED,
                sequence=37,
                payload={
                    "declaration_id": "io-working",
                    "path": "outputs/report.md",
                    "role": "intermediate",
                },
            )
        failures = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual(len(failures), 2)
        for event in failures:
            self.assertEqual(event.kind, "artifact_failed")
            self.assertEqual(event.payload["code"], ARTIFACT_PUBLISH_IO_FAILED)
            self.assertNotIn(private_path, json.dumps(event.payload))
        self.assertEqual(self.live.artifact_snapshot(), [])

    async def test_working_declaration_replay_ignores_later_source_deletion(self) -> None:
        source = self.output_root / "data.csv"
        source.write_text("a,b", encoding="utf-8")
        payload = {
            "declaration_id": "working-replay",
            "path": "outputs/data.csv",
            "role": "intermediate",
        }
        await self.emit(RuntimeEventKind.ARTIFACT_DECLARED, sequence=40, payload=payload)
        before = self.events.replay(PRODUCT_SESSION_ID)
        source.unlink()
        await self.emit(RuntimeEventKind.ARTIFACT_DECLARED, sequence=41, payload=payload)
        self.assertEqual(self.events.replay(PRODUCT_SESSION_ID), before)
        await self.emit(
            RuntimeEventKind.ARTIFACT_DECLARED,
            sequence=42,
            payload={**payload, "path": "other.csv"},
        )
        self.assertEqual(
            self.events.replay(PRODUCT_SESSION_ID)[-1].payload["code"],
            "artifact_declaration_conflict",
        )

    async def test_declaration_failure_replay_and_changed_failure(self) -> None:
        payload = {
            "declaration_id": "failed-retry",
            "path": "outputs/retry.csv",
            "role": "intermediate",
            "expected_sha256": "0" * 64,
        }
        await self.emit(RuntimeEventKind.ARTIFACT_DECLARED, sequence=50, payload=payload)
        before = self.events.replay(PRODUCT_SESSION_ID)
        await self.emit(RuntimeEventKind.ARTIFACT_DECLARED, sequence=50, payload=payload)
        self.assertEqual(self.events.replay(PRODUCT_SESSION_ID), before)
        (self.output_root / "retry.csv").write_text("a,b", encoding="utf-8")
        await self.emit(RuntimeEventKind.ARTIFACT_DECLARED, sequence=51, payload=payload)
        failures = [
            event
            for event in self.events.replay(PRODUCT_SESSION_ID)
            if event.kind == "artifact_failed"
        ]
        self.assertEqual(len(failures), 2)
        self.assertNotEqual(failures[0].payload["code"], failures[1].payload["code"])
        self.assertEqual(self.live.artifact_snapshot(), [])
        restored = EventService({}, self.events, self.logger).activity_snapshot(PRODUCT_SESSION_ID)
        restored_failures = [event for event in restored if event["type"] == "artifact_failed"]
        self.assertEqual(len(restored_failures), 2)
        self.assertEqual(
            [event["data"] for event in restored_failures],
            [event.payload for event in failures],
        )

    async def test_pending_publication_recovers_after_source_deletion_once(self) -> None:
        source = self.output_root / "recover.md"
        source.write_text("# immutable recovery", encoding="utf-8")
        publications = PublicationService(self.content)
        publication = publications.publish(
            PublicationCommand(
                "",
                PRODUCT_SESSION_ID,
                "turn-recovery",
                "declaration-recovery",
                "outputs/recover.md",
                ArtifactRole.FINAL,
                "恢复产物",
            ),
            provenance={"runtime_id": RUNTIME_ID},
        )
        source.unlink()
        self.assertEqual(self.live.artifact_snapshot(), [])
        self.live.recover_publications()
        snapshot = self.live.artifact_snapshot()
        self.assertEqual(len(snapshot), 1)
        self.assertEqual(snapshot[0]["publication_id"], publication.publication_id)
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())
        reader.bind_content(self.content)
        content, name = reader.export_bytes(PRODUCT_SESSION_ID, snapshot[0]["artifact_id"])
        self.assertEqual(content, b"# immutable recovery")
        self.assertEqual(name, "recover.md")
        before = self.events.replay(PRODUCT_SESSION_ID)
        self.live.recover_publications()
        self.assertEqual(self.events.replay(PRODUCT_SESSION_ID), before)
        self.assertEqual(
            publications.store("", PRODUCT_SESSION_ID).list_session(
                PRODUCT_SESSION_ID, pending_only=True
            ),
            (),
        )

    async def test_offline_history_recovers_publication_without_vendor_start(self) -> None:
        source = self.output_root / "offline.md"
        source.write_text("# offline delivery", encoding="utf-8")
        publications = PublicationService(self.content)
        publication = publications.publish(
            PublicationCommand(
                "",
                PRODUCT_SESSION_ID,
                "offline-turn",
                "offline-declaration",
                "outputs/offline.md",
                ArtifactRole.FINAL,
            ),
            provenance={},
        )
        source.unlink()
        gateway = Mock(default_runtime_id=RUNTIME_ID)
        runtime = LiveSessionService(
            catalog=self.catalog,
            events=self.events,
            artifacts=self.artifacts,
            skills=Mock(),
            models=Mock(),
            logger=self.logger,
            gateway=gateway,
        )
        runtime.bind_publications(publications)
        sessions = SessionService(
            self.root,
            {},
            access=self.catalog,
            events=self.events,
            runtime=runtime,
            workspaces=SessionWorkspaceService(workspace_allows),
            artifacts=self.artifacts,
            settings=SimpleNamespace(runtime_executable=lambda: ""),
            credentials=skill_credentials_from_env({}),
            logger=self.logger,
        )
        first = sessions.history(PRODUCT_SESSION_ID)
        self.assertEqual(len(first["artifacts"]), 1)
        self.assertEqual(first["artifacts"][0]["artifact_id"], publication.publication_id)
        before = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual(sessions.history(PRODUCT_SESSION_ID), first)
        self.assertEqual(self.events.replay(PRODUCT_SESSION_ID), before)
        self.assertEqual(gateway.method_calls, [])
        self.assertEqual(
            publications.store("", PRODUCT_SESSION_ID).list_session(
                PRODUCT_SESSION_ID, pending_only=True
            ),
            (),
        )
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())
        reader.bind_content(self.content)
        self.assertEqual(
            reader.export_bytes(PRODUCT_SESSION_ID, publication.publication_id),
            (b"# offline delivery", "offline.md"),
        )

    async def test_publication_recovery_after_lost_ack_preserves_committed_projection(self) -> None:
        source = self.output_root / "lost-ack.md"
        source.write_text("# original", encoding="utf-8")
        with patch.object(
            PublicationService, "acknowledge", side_effect=OSError("ack unavailable")
        ):
            with self.assertRaises(OSError):
                await self.live.publish_artifact(
                    "outputs/lost-ack.md", "final", turn_id="lost-ack-turn"
                )
        snapshot = self.live.artifact_snapshot()
        events = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual(len(snapshot), 1)
        publications = PublicationService(self.content)
        self.assertEqual(
            len(
                publications.store("", PRODUCT_SESSION_ID).list_session(
                    PRODUCT_SESSION_ID, pending_only=True
                )
            ),
            1,
        )
        source.unlink()
        self.live.recover_publications()
        self.assertEqual(self.live.artifact_snapshot(), snapshot)
        self.assertEqual(self.events.replay(PRODUCT_SESSION_ID), events)
        self.assertEqual(
            publications.store("", PRODUCT_SESSION_ID).list_session(
                PRODUCT_SESSION_ID, pending_only=True
            ),
            (),
        )

    async def test_publication_roles_survive_later_working_observation(self) -> None:
        artifact_file = self.output_root / "published.md"
        artifact_file.write_text("# delivery\n", encoding="utf-8")
        supporting = await self.live.publish_artifact(
            "outputs/published.md", "supporting", turn_id="turn-publish"
        )
        final = await self.live.publish_artifact(
            "outputs/published.md", "final", turn_id="turn-publish"
        )
        self.assertNotEqual(supporting["artifact_id"], final["artifact_id"])
        await self.emit(
            RuntimeEventKind.ARTIFACT_OBSERVED,
            sequence=20,
            payload={"status": "completed", "changes": [{"path": "outputs/published.md"}]},
            item_id="later-watch",
            turn_id="later-turn",
        )
        snapshot = self.live.artifact_snapshot()
        by_id = {row["artifact_id"]: row for row in snapshot}
        self.assertEqual(by_id[final["artifact_id"]]["role"], "final")
        self.assertEqual(by_id[supporting["artifact_id"]]["role"], "supporting")
        self.assertEqual(len(snapshot), 3)

    async def test_runtime_callback_projects_typed_product_options(self) -> None:
        await self.live.on_runtime_observation(
            RuntimeCallbackRequest(
                schema_version=1,
                runtime_id=RUNTIME_ID,
                product_session_id=PRODUCT_SESSION_ID,
                native_session_id=VENDOR_THREAD_ID,
                request_id="approval-1",
                audience=CallbackAudience.USER,
                kind=CallbackKind.COMMAND_APPROVAL,
                blocking=True,
                prompt={"title": "Permission", "body": "Run command?"},
                response_contract={},
                observed_at="fixture",
                native_turn_id="turn-approval",
                native_item_id="item-approval",
                allowed_decisions=("accept", "cancel"),
            )
        )
        event = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(event.kind, "hil_requested")
        self.assertEqual(
            event.payload["options"],
            [
                {"id": "accept", "label": "Allow once"},
                {"id": "cancel", "label": "Decline"},
            ],
        )

    async def test_runtime_artifact_event_reuses_product_index(self) -> None:
        artifact_file = self.output_root / "gateway-result.md"
        artifact_file.write_text("# gateway result\n", encoding="utf-8")
        await self.live.on_runtime_observation(
            RuntimeEvent(
                schema_version=1,
                event_id="runtime-artifact-1",
                runtime_id=RUNTIME_ID,
                product_session_id=PRODUCT_SESSION_ID,
                native_session_id=VENDOR_THREAD_ID,
                process_generation=1,
                sequence=1,
                kind=RuntimeEventKind.ARTIFACT_OBSERVED,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at="fixture",
                native_turn_id="runtime-turn",
                native_item_id="runtime-file",
                payload={
                    "status": "completed",
                    "changes": [{"path": "outputs/gateway-result.md", "change": "add"}],
                },
            )
        )
        projected = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual(
            [row.kind for row in projected],
            [PRODUCT_EVENT_FILE_CHANGED, "artifact_changed"],
        )

    async def test_runtime_assistant_delta_preserves_answer_phase(self) -> None:
        await self.live.on_runtime_observation(
            RuntimeEvent(
                schema_version=1,
                event_id="runtime-answer-1",
                runtime_id=RUNTIME_ID,
                product_session_id=PRODUCT_SESSION_ID,
                native_session_id=VENDOR_THREAD_ID,
                process_generation=1,
                sequence=1,
                kind=RuntimeEventKind.CONTENT_DELTA,
                delivery=DeliveryClass.COALESCIBLE,
                observed_at="fixture",
                native_turn_id="runtime-turn",
                native_item_id="runtime-answer",
                payload={
                    "role": "assistant",
                    "text": "可批注回答",
                    "phase": MessagePhase.FINAL_ANSWER.value,
                },
            )
        )

        event = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(event.kind, PRODUCT_EVENT_MESSAGE_DELTA)
        self.assertEqual(event.payload["phase"], MessagePhase.FINAL_ANSWER.value)

    async def test_runtime_native_activity_extension_reuses_product_activity_events(self) -> None:
        await self.live.on_runtime_observation(
            RuntimeEvent(
                schema_version=1,
                event_id="runtime-auto-review-1",
                runtime_id=RUNTIME_ID,
                product_session_id=PRODUCT_SESSION_ID,
                native_session_id=VENDOR_THREAD_ID,
                process_generation=1,
                sequence=1,
                kind=RuntimeEventKind.RUNTIME_EXTENSION,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at="fixture",
                native_turn_id="runtime-turn",
                native_item_id="review-1",
                payload={
                    "extension_kind": "native_activity_completed",
                    "activity_type": "approval_review",
                    "category": "mode",
                    "details": {"risk_level": "low", "decision_source": "agent"},
                    "status": "approved",
                    "ok": True,
                },
            )
        )

        projected = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual(len(projected), 1)
        self.assertEqual(projected[0].kind, PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED)
        self.assertEqual(projected[0].payload["activity_type"], "approval_review")
        self.assertEqual(projected[0].payload["details"]["risk_level"], "low")
        self.assertTrue(projected[0].payload["success"])
        self.assertEqual(projected[-1].vendor_turn_id, "runtime-turn")

    async def test_runtime_web_search_extension_reaches_product_events(self) -> None:
        action = {"type": "search", "query": "Codex App Server"}
        for sequence, extension_kind, results in (
            (1, "web_search_started", None),
            (
                2,
                "web_search_completed",
                [{"title": "Codex", "url": "https://developers.openai.com/codex/"}],
            ),
        ):
            payload: dict[str, Any] = {
                "extension_kind": extension_kind,
                "query": "Codex App Server",
                "action": action,
            }
            if results is not None:
                payload["results"] = results
            await self.live.on_runtime_observation(
                RuntimeEvent(
                    schema_version=1,
                    event_id=f"runtime-search-{sequence}",
                    runtime_id=RUNTIME_ID,
                    product_session_id=PRODUCT_SESSION_ID,
                    native_session_id=VENDOR_THREAD_ID,
                    process_generation=1,
                    sequence=sequence,
                    kind=RuntimeEventKind.RUNTIME_EXTENSION,
                    delivery=DeliveryClass.MUST_PERSIST,
                    observed_at="fixture",
                    native_turn_id="runtime-search-turn",
                    native_item_id="runtime-search-item",
                    payload=payload,
                )
            )
        projected = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual(
            [row.kind for row in projected],
            [PRODUCT_EVENT_WEB_SEARCH_STARTED, PRODUCT_EVENT_WEB_SEARCH_COMPLETED],
        )
        self.assertEqual(projected[0].payload["action"], action)
        self.assertEqual(projected[1].payload["result_count"], 1)

    async def test_trace_keeps_runtime_thread_turn_item_and_product_sequence(self) -> None:
        await self.emit(
            RuntimeEventKind.SESSION_OPENED,
            sequence=1,
            payload={
                "pid": 123,
                "version": "codex-cli 0.147.0",
                "process_state": "ready",
                "executable": "/private/bin/codex",
                "process_reused": False,
            },
            turn_id="",
            item_id="",
        )
        await self.emit(
            RuntimeEventKind.TURN_STARTED,
            sequence=2,
            payload={},
            turn_id="turn-trace",
            item_id="",
        )
        await self.emit(
            RuntimeEventKind.TOOL_STARTED,
            sequence=3,
            payload={"name": "bash", "input": "must-not-enter-trace"},
            turn_id="turn-trace",
            item_id="item-trace",
        )
        await self.emit(
            RuntimeEventKind.TURN_COMPLETED,
            sequence=4,
            payload={"status": "completed"},
            turn_id="turn-trace",
            item_id="",
        )

        trace_path = self.root / "trace" / f"scholarseed-codex-{PRODUCT_SESSION_ID}.jsonl"
        rows = [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines()]
        names = [row["name"] for row in rows]
        self.assertEqual(
            names[:3],
            ["codex.process.started", "codex.thread.started", "session.runtime.bound"],
        )
        self.assertIn("codex.turn.started", names)
        self.assertIn("codex.event.tool.started", names)
        self.assertIn("codex.turn.completed", names)
        tool_row = next(row for row in rows if row["name"] == "codex.event.tool.started")
        self.assertEqual(tool_row["attributes"]["vendor_thread_id"], VENDOR_THREAD_ID)
        self.assertEqual(tool_row["attributes"]["vendor_turn_id"], "turn-trace")
        self.assertEqual(tool_row["attributes"]["vendor_item_id"], "item-trace")
        self.assertNotIn("must-not-enter-trace", trace_path.read_text(encoding="utf-8"))

    async def test_write_capable_tool_call_records_resource_candidate(self) -> None:
        resource_changes = AsyncMock()
        self.live._resource_changes = resource_changes
        payload = {
            "name": "bash",
            "input": {"command": "python write_document.py resources/李白.md"},
        }

        await self.emit(
            RuntimeEventKind.TOOL_STARTED,
            sequence=5,
            payload=payload,
            turn_id="turn-write",
            item_id="item-write",
        )

        resource_changes.record_tool_call.assert_awaited_once_with(
            PRODUCT_SESSION_ID,
            "turn-write",
            payload["input"],
            generation=f"codex:{VENDOR_THREAD_ID}:1",
        )

    async def test_read_tool_call_does_not_record_resource_candidate(self) -> None:
        resource_changes = AsyncMock()
        self.live._resource_changes = resource_changes

        await self.emit(
            RuntimeEventKind.TOOL_STARTED,
            sequence=5,
            payload={"name": "read", "input": {"command": "cat resources/李白.md"}},
            turn_id="turn-read",
            item_id="item-read",
        )

        resource_changes.record_tool_call.assert_not_awaited()

    async def test_vendor_error_content_is_not_exposed_or_traced(self) -> None:
        secret = "credential-like-vendor-error-must-not-leak"
        await self.emit(
            "runtime_error",
            sequence=1,
            payload={"detail": secret, "error": {"message": secret}},
            turn_id="turn-error",
            item_id="item-error",
        )
        record = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(record.kind, "runtime_error")
        self.assertEqual(record.payload["message"], "Agent runtime error")
        trace_path = self.root / "trace" / f"scholarseed-codex-{PRODUCT_SESSION_ID}.jsonl"
        self.assertNotIn(secret, trace_path.read_text())
        rows = [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines()]
        product_rows = [row for row in rows if row["name"].startswith("scholarseed.product.")]
        self.assertTrue(product_rows)
        self.assertTrue(all(row["attributes"]["product_seq"] > 0 for row in product_rows))

    async def test_vendor_sequence_restart_is_scoped_to_runtime_attachment(self) -> None:
        await self.emit(
            RuntimeEventKind.USAGE_UPDATED,
            sequence=1,
            payload={"input_tokens": 10},
            turn_id="",
            item_id="",
        )
        resumed = LiveSession(
            session_id=PRODUCT_SESSION_ID,
            runtime_id=RUNTIME_ID,
            runtime_workdir=self.workdir,
            project_path=None,
            output_root=self.output_root,
            model_id="gpt-5-codex",
            catalog=self.catalog,
            events=self.events,
            artifacts=self.artifacts,
            skills=SkillCatalog(
                bundled_root=self.skill_file.parent.parent,
                user_root=self.root / "user-skills",
            ),
            logger=self.logger,
            trace=SessionTrace(
                PRODUCT_SESSION_ID,
                self.workdir,
                runtime_id=RUNTIME_ID,
                trace_dir=self.root / "trace-resumed",
            ),
        )
        resumed.attach_gateway(FakeRuntimeSession(FakeAdapter(self.skill_file)), resumed=True)
        await resumed.activate()
        try:
            await resumed.on_runtime_observation(
                RuntimeEvent(
                    schema_version=1,
                    event_id="resumed:1",
                    product_session_id=PRODUCT_SESSION_ID,
                    process_generation=1,
                    delivery=DeliveryClass.MUST_PERSIST,
                    observed_at="fixture",
                    runtime_id=RUNTIME_ID,
                    native_session_id=VENDOR_THREAD_ID,
                    kind=RuntimeEventKind.USAGE_UPDATED,
                    sequence=1,
                    payload={"input_tokens": 20},
                )
            )
        finally:
            await resumed.aclose()
        usage = [
            event
            for event in self.events.replay(PRODUCT_SESSION_ID)
            if event.kind == "usage_updated"
        ]
        self.assertEqual([row.payload["input_tokens"] for row in usage], [10, 20])

    async def test_hil_is_durable_and_resolved_once(self) -> None:
        await self.emit(
            CallbackKind.COMMAND_APPROVAL,
            sequence=1,
            payload={
                "request_id": "hil-1",
                "trigger": "policy.ask",
                "options": [{"id": "accept", "label": "Allow once"}],
            },
        )

        pending = self.catalog.pending_hil(PRODUCT_SESSION_ID)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0].payload["kind"], CallbackKind.COMMAND_APPROVAL.value)
        self.assertEqual(self.live.pending_hil_snapshot()[0]["turn_id"], "turn-1")
        self.assertEqual(self.live.pending_hil_snapshot()[0]["item_id"], "item-1")
        self.assertTrue(
            await self.live.interactions.resolve(
                self.live.runtime_session, "hil-1", {"option_id": "accept"}
            )
        )
        self.assertFalse(
            await self.live.interactions.resolve(
                self.live.runtime_session, "hil-1", {"option_id": "accept"}
            )
        )
        record = self.catalog.get(PRODUCT_SESSION_ID)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.status, SessionStatus.RUNNING)

    async def test_user_input_resolution_preserves_answers_in_product_event(self) -> None:
        question = "今天早餐你想吃什么？"
        await self.emit(
            CallbackKind.USER_INPUT,
            sequence=1,
            payload={
                "request_id": "question-1",
                "questions": [{"id": "breakfast", "question": question, "options": []}],
            },
        )
        self.adapter.hil_requests.add("question-1")

        answers = {question: "包子配豆浆"}
        resolved = await self.live.interactions.resolve(
            self.live.runtime_session,
            "question-1",
            {"answers": answers},
        )

        self.assertIsNotNone(resolved)
        assert resolved is not None
        self.assertEqual(resolved["answers"], answers)
        await self.emit(
            RuntimeEventKind.INTERACTION_RESOLVED,
            sequence=2,
            payload={"request_id": "question-1", "option_id": "submit"},
        )
        events = [
            event
            for event in self.events.replay(PRODUCT_SESSION_ID)
            if event.kind == "hil_resolved"
        ]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].payload["answers"], answers)
        self.assertEqual(events[0].payload["questions"][0]["question"], question)
        replay = EventService({}, self.events, self.logger).activity_snapshot(PRODUCT_SESSION_ID)
        self.assertEqual(
            [event["type"] for event in replay if event["type"].startswith("hil_")],
            ["hil_requested", "hil_resolved"],
        )

    async def test_typed_turn_rejects_escape_and_accepts_session_file(self) -> None:
        attachment = self.workdir / "input.txt"
        attachment.write_text("evidence", encoding="utf-8")
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger)
        payload, status = await turns.post(
            PRODUCT_SESSION_ID,
            {
                "wait": True,
                "collaboration_mode": "plan",
                "input": [
                    {"type": "text", "text": "分析附件"},
                    {"type": "file", "path": str(attachment), "name": "input.txt"},
                ],
            },
            side=False,
        )
        self.assertEqual(status, 202)
        self.assertTrue(payload["ok"])
        self.assertIsNotNone(self.runtime_session.last_turn_request)
        self.assertEqual(
            self.runtime_session.last_turn_request.collaboration_mode,
            CollaborationMode.PLAN.value,
        )

        invalid_mode, invalid_mode_status = await turns.post(
            PRODUCT_SESSION_ID,
            {
                "collaboration_mode": "invented",
                "input": [{"type": "text", "text": "invalid mode"}],
            },
            side=False,
        )
        self.assertEqual(invalid_mode_status, 400)
        self.assertEqual(invalid_mode["error"], "turn_input_invalid")

        escaped = self.root / "outside.txt"
        escaped.write_text("outside", encoding="utf-8")
        denied, denied_status = await turns.post(
            PRODUCT_SESSION_ID,
            {"input": [{"type": "file", "path": str(escaped)}]},
            side=False,
        )
        self.assertEqual(denied_status, 400)
        self.assertEqual(denied["error"], "turn_input_invalid")

        skill_identity = await self.live.skill_identity(self.skill_file, "test-skill")
        assert skill_identity is not None
        skill_result, skill_status = await turns.post(
            PRODUCT_SESSION_ID,
            {
                "wait": True,
                "input": [
                    {
                        "type": "skill",
                        "name": "test-skill",
                        "path": str(self.skill_file),
                        "version": str(skill_identity["version"]),
                    }
                ],
            },
            side=False,
        )
        self.assertEqual(skill_status, 202)
        self.assertTrue(skill_result["ok"])
        trace_path = self.root / "trace" / f"scholarseed-codex-{PRODUCT_SESSION_ID}.jsonl"
        trace_rows = [json.loads(line) for line in trace_path.read_text().splitlines()]
        input_row = [row for row in trace_rows if row["name"] == "scholarseed.turn.input"][-1]
        self.assertEqual(input_row["attributes"]["input_kinds"], ["skill"])
        self.assertEqual(input_row["attributes"]["collaboration_mode"], "default")
        self.assertEqual(input_row["attributes"]["skills"][0]["name"], "test-skill")
        self.assertTrue(input_row["attributes"]["skills"][0]["version"])
        self.assertNotIn(str(self.skill_file), json.dumps(input_row))

        submitted_before_rejection = self.runtime_session.last_turn_request
        stale_skill, stale_skill_status = await turns.post(
            PRODUCT_SESSION_ID,
            {
                "wait": True,
                "input": [
                    {
                        "type": "skill",
                        "name": "test-skill",
                        "path": str(self.skill_file),
                        "version": "stale-version",
                    }
                ],
            },
            side=False,
        )
        self.assertEqual(stale_skill_status, 202)
        self.assertFalse(stale_skill["ok"], stale_skill)
        self.assertIs(self.runtime_session.last_turn_request, submitted_before_rejection)
        self.assertEqual(stale_skill["error"], "turn_input_invalid")
        stale_record = self.catalog.queued_message(PRODUCT_SESSION_ID, stale_skill["turn_id"])
        self.assertIsNotNone(stale_record)
        self.assertEqual(stale_record.state, QueuedMessageState.FAILED)
        self.assertEqual(stale_record.safe_error, "turn_input_invalid")

        fake_skill = self.workdir / "fake-skill.md"
        fake_skill.write_text("# fake\n", encoding="utf-8")
        rejected_skill, rejected_skill_status = await turns.post(
            PRODUCT_SESSION_ID,
            {"wait": True, "input": [{"type": "skill", "name": "fake", "path": str(fake_skill)}]},
            side=False,
        )
        self.assertEqual(rejected_skill_status, 202)
        self.assertFalse(rejected_skill["ok"])
        self.assertIs(self.runtime_session.last_turn_request, submitted_before_rejection)
        self.assertEqual(rejected_skill["error"], "turn_input_invalid")
        rejected_record = self.catalog.queued_message(PRODUCT_SESSION_ID, rejected_skill["turn_id"])
        self.assertIsNotNone(rejected_record)
        self.assertEqual(rejected_record.state, QueuedMessageState.FAILED)
        self.assertEqual(rejected_record.safe_error, "turn_input_invalid")

    async def test_skill_is_typed_without_polluting_history_or_title(self) -> None:
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger)
        identity = await self.live.skill_identity(self.skill_file, "test-skill")
        self.assertIsNotNone(identity)
        assert identity is not None
        result, status = await turns.post(
            PRODUCT_SESSION_ID,
            {
                "wait": True,
                "input": [
                    {"type": "text", "text": "分析这份研究材料"},
                    {
                        "type": "skill",
                        "name": "test-skill",
                        "path": str(self.skill_file),
                        "version": str(identity["version"]),
                    },
                ],
            },
            side=False,
        )
        self.assertEqual(status, 202)
        self.assertTrue(result["ok"])
        record = self.catalog.get(PRODUCT_SESSION_ID)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.title, "分析这份研究材料")
        user_history = [row["text"] for row in self.live.history() if row["role"] == "user"]
        self.assertIn("分析这份研究材料", user_history)
        self.assertTrue(
            all("@skill:" not in text and "$test-skill" not in text for text in user_history)
        )
        title_events = [
            row
            for row in self.events.replay(PRODUCT_SESSION_ID)
            if row.kind == "session_title_updated"
        ]
        self.assertEqual([row.payload["title"] for row in title_events], ["分析这份研究材料"])

    async def test_repeated_title_text_starts_a_new_turn(self) -> None:
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger)
        body = {"wait": True, "input": [{"type": "text", "text": "重复标题"}]}

        first, first_status = await turns.post(PRODUCT_SESSION_ID, body, side=False)
        second, second_status = await turns.post(PRODUCT_SESSION_ID, body, side=False)

        self.assertEqual((first_status, second_status), (202, 202))
        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        record = self.catalog.get(PRODUCT_SESSION_ID)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.title, "重复标题")

    async def test_runtime_admission_failure_exposes_only_curated_code(self) -> None:
        await self.assert_curated_admission_failure("review_pending")

    async def test_private_runtime_admission_failure_exposes_only_curated_code(self) -> None:
        await self.assert_curated_admission_failure("private-path-secret")

    async def assert_curated_admission_failure(self, code: str) -> None:
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger)
        with patch.object(self.live, "run_runtime", side_effect=RuntimeError(code)):
            with patch.object(self.live, "trace_turn_execution_failed") as trace:
                await turns.post(
                    PRODUCT_SESSION_ID,
                    {"wait": True, "input": [{"type": "text", "text": "retry reviewed work"}]},
                    side=False,
                )
        terminals = [
            row
            for row in self.events.replay(PRODUCT_SESSION_ID)
            if row.kind in {"turn_failed", "turn_unknown"}
        ]
        self.assertEqual([row.kind for row in terminals], ["turn_unknown"])
        self.assertEqual(terminals[0].payload["message"], "runtime_turn_failed")
        self.assertNotIn(code, json.dumps(terminals[0].payload))
        queued = self.catalog.queued_messages(PRODUCT_SESSION_ID)
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0].state.value, "outcome_unknown")
        self.assertEqual(queued[0].safe_error, "runtime_turn_failed")
        recoverable = self.live.ledger.uncertainty_snapshot()
        self.assertEqual(len(recoverable), 1)
        self.assertEqual(recoverable[0]["state"], "unknown")
        self.assertEqual(recoverable[0]["correlation_id"], queued[0].queued_message_id)
        self.assertEqual(trace.call_args.kwargs["failure_code"], "")

    async def test_skill_only_turn_keeps_default_title_and_no_synthetic_history(self) -> None:
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger)
        identity = await self.live.skill_identity(self.skill_file, "test-skill")
        self.assertIsNotNone(identity)
        assert identity is not None
        result, status = await turns.post(
            PRODUCT_SESSION_ID,
            {
                "wait": True,
                "input": [
                    {
                        "type": "skill",
                        "name": "test-skill",
                        "path": str(self.skill_file),
                        "version": str(identity["version"]),
                    }
                ],
            },
            side=False,
        )
        self.assertEqual(status, 202)
        self.assertTrue(result["ok"])
        record = self.catalog.get(PRODUCT_SESSION_ID)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.title, SESSION_TITLE_DEFAULT)
        self.assertTrue(
            all("@skill:" not in row["text"] for row in self.live.history()),
            self.live.history(),
        )

    async def test_durable_sse_replay_uses_frozen_envelope(self) -> None:
        await self.emit(
            RuntimeEventKind.CONTENT_DELTA,
            sequence=1,
            payload={"text": "增量", "phase": MessagePhase.COMMENTARY.value},
        )
        service = EventService({}, self.events, self.logger)
        stream = service.open(PRODUCT_SESSION_ID, 0)
        try:
            frames = [await anext(stream)]
        finally:
            await stream.aclose()
        self.assertEqual(len(frames), 1)
        self.assertIn('"type":"message_delta"', frames[0])
        self.assertIn('"phase":"commentary"', frames[0])
        self.assertIn(f'"session_id":"{PRODUCT_SESSION_ID}"', frames[0])

    async def test_history_keeps_commentary_out_of_final_answers(self) -> None:
        self.adapter.history = (
            HistoryEntry(
                "assistant",
                "检查工具返回",
                "turn-phase",
                "commentary-item",
                MessagePhase.COMMENTARY,
            ),
            HistoryEntry(
                "assistant",
                "最终结论",
                "turn-phase",
                "final-item",
                MessagePhase.FINAL_ANSWER,
            ),
        )
        await self.live.hydrate_runtime_history()
        history = self.live.history()
        self.assertEqual([row["kind"] for row in history], ["thinking", "text"])
        self.assertEqual(
            [row["phase"] for row in history],
            [MessagePhase.COMMENTARY.value, MessagePhase.FINAL_ANSWER.value],
        )

    async def test_activity_snapshot_restores_reasoning_tool_and_web_search_events(self) -> None:
        records = (
            (PRODUCT_EVENT_MESSAGE_DELTA, {"delta": "final text"}),
            (PRODUCT_EVENT_REASONING_DELTA, {"delta": "private reasoning"}),
            (PRODUCT_EVENT_TOOL_STARTED, {"tool_id": "tool-1", "name": "read"}),
            (
                PRODUCT_EVENT_TOOL_COMPLETED,
                {"tool_id": "tool-1", "name": "read", "success": True},
            ),
            (
                PRODUCT_EVENT_WEB_SEARCH_STARTED,
                {"search_id": "search-1", "query": "Codex", "action": {}},
            ),
            (
                PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                {
                    "search_id": "search-1",
                    "query": "Codex",
                    "action": {},
                    "results": [],
                    "result_count": 0,
                },
            ),
            (
                PRODUCT_EVENT_PAPER_SEARCH_STARTED,
                {"search_id": "paper-search-1", "query": ""},
            ),
            (
                PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
                {"search_id": "paper-search-1", "query": "agent memory"},
            ),
            (
                PRODUCT_EVENT_SKILL_STARTED,
                {
                    "skill_id": "skill-1",
                    "skill": "literature-search",
                    "path": "/skills/literature-search/SKILL.md",
                    "status": "running",
                },
            ),
            (
                PRODUCT_EVENT_SKILL_COMPLETED,
                {
                    "skill_id": "skill-1",
                    "skill": "literature-search",
                    "path": "/skills/literature-search/SKILL.md",
                    "status": "completed",
                    "success": True,
                },
            ),
            (
                PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
                {
                    "activity_id": "native-1",
                    "activity_type": "agent_collaboration",
                    "category": "collaboration",
                    "details": {"operation": "spawn_agent"},
                    "status": "running",
                },
            ),
            (
                PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
                {
                    "activity_id": "native-1",
                    "activity_type": "agent_collaboration",
                    "category": "collaboration",
                    "details": {"operation": "spawn_agent"},
                    "status": "completed",
                    "success": True,
                },
            ),
        )
        for index, (kind, payload) in enumerate(records, start=1):
            self.events.append(
                session_id=PRODUCT_SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=VENDOR_THREAD_ID,
                vendor_turn_id="turn-activity",
                vendor_item_id=f"item-{index}",
                kind=kind,
                payload=payload,  # type: ignore[arg-type]
                idempotency_key=f"activity-{index}",
            )

        snapshot = EventService({}, self.events, self.logger).activity_snapshot(PRODUCT_SESSION_ID)

        self.assertEqual(
            [event["type"] for event in snapshot],
            [
                PRODUCT_EVENT_MESSAGE_DELTA,
                PRODUCT_EVENT_REASONING_DELTA,
                PRODUCT_EVENT_TOOL_STARTED,
                PRODUCT_EVENT_TOOL_COMPLETED,
                PRODUCT_EVENT_WEB_SEARCH_STARTED,
                PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                PRODUCT_EVENT_PAPER_SEARCH_STARTED,
                PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
                PRODUCT_EVENT_SKILL_STARTED,
                PRODUCT_EVENT_SKILL_COMPLETED,
                PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
                PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
            ],
        )
        self.assertTrue(all(event["turn_id"] == "turn-activity" for event in snapshot))

    async def test_turn_activity_snapshot_restores_duration_and_terminal_truth(self) -> None:
        client_turn_id = "client-turn-duration"
        vendor_turn_id = "vendor-turn-duration"
        records = (
            (
                PRODUCT_EVENT_USER_MESSAGE,
                client_turn_id,
                {
                    "text": "run tools",
                    "refs": [],
                    "client_turn_id": client_turn_id,
                    "binding": USER_MESSAGE_BINDING_ADMITTED,
                },
                100.0,
            ),
            (
                PRODUCT_EVENT_SESSION_STATE,
                vendor_turn_id,
                {"state": "running", "runtime_id": RUNTIME_ID},
                101.0,
            ),
            (
                PRODUCT_EVENT_TOOL_STARTED,
                vendor_turn_id,
                {"tool_id": "tool-failed", "name": "shell"},
                102.0,
            ),
            (
                PRODUCT_EVENT_TOOL_COMPLETED,
                vendor_turn_id,
                {
                    "tool_id": "tool-failed",
                    "name": "shell",
                    "success": False,
                },
                103.0,
            ),
            (
                PRODUCT_EVENT_TURN_COMPLETED,
                vendor_turn_id,
                {"stop_reason": "completed"},
                110.0,
            ),
            (
                PRODUCT_EVENT_USER_MESSAGE,
                vendor_turn_id,
                {
                    "text": "run tools",
                    "refs": [],
                    "client_turn_id": client_turn_id,
                    "binding": USER_MESSAGE_BINDING_BOUND,
                },
                111.0,
            ),
        )
        for index, (kind, turn_id, payload, created_at) in enumerate(records, start=1):
            self.events.append(
                session_id=PRODUCT_SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=VENDOR_THREAD_ID,
                vendor_turn_id=turn_id,
                vendor_item_id=f"duration-item-{index}",
                kind=kind,
                payload=payload,
                idempotency_key=f"duration-{index}",
                created_at=created_at,
            )

        snapshot = EventService({}, self.events, self.logger).turn_activity_snapshot(
            PRODUCT_SESSION_ID
        )

        self.assertEqual(
            snapshot,
            [
                {
                    "turn_id": vendor_turn_id,
                    "started_at": 100.0,
                    "completed_at": 110.0,
                    "outcome": "completed",
                }
            ],
        )

    async def test_web_search_projection_preserves_native_query_action_and_results(self) -> None:
        action = {
            "type": "search",
            "query": "Codex App Server",
            "queries": ["Codex App Server"],
        }
        await self.emit(
            "web_search_started",
            sequence=1,
            payload={"query": "Codex App Server", "action": action, "results": []},
            item_id="search-1",
        )
        await self.emit(
            "web_search_completed",
            sequence=2,
            payload={
                "query": "Codex App Server",
                "action": action,
                "results": [
                    {
                        "title": "Codex App Server",
                        "url": "https://developers.openai.com/codex/app-server",
                    }
                ],
            },
            item_id="search-1",
        )
        started, completed = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual(started.kind, PRODUCT_EVENT_WEB_SEARCH_STARTED)
        self.assertEqual(started.payload["query"], "Codex App Server")
        self.assertEqual(started.payload["action"], action)
        self.assertEqual(completed.kind, PRODUCT_EVENT_WEB_SEARCH_COMPLETED)
        self.assertEqual(completed.payload["result_count"], 1)
        self.assertEqual(completed.payload["results"][0]["title"], "Codex App Server")
        trace_path = self.root / "trace" / f"scholarseed-codex-{PRODUCT_SESSION_ID}.jsonl"
        trace_rows = [
            json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines()
        ]
        search_rows = [
            row for row in trace_rows if row["name"].startswith("codex.event.web_search_")
        ]
        self.assertEqual(
            [row["kind"] for row in search_rows],
            ["tool.exec", "tool.exec"],
        )

    async def test_paper_search_projection_preserves_call_identity_and_query(self) -> None:
        await self.emit(
            "paper_search_started",
            sequence=1,
            payload={"query": ""},
            item_id="paper-search-1",
        )
        await self.emit(
            "paper_search_completed",
            sequence=2,
            payload={"query": "agent memory"},
            item_id="paper-search-1",
        )
        started, completed = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual(started.kind, PRODUCT_EVENT_PAPER_SEARCH_STARTED)
        self.assertEqual(started.payload["search_id"], "paper-search-1")
        self.assertEqual(started.payload["query"], "")
        self.assertEqual(completed.kind, PRODUCT_EVENT_PAPER_SEARCH_COMPLETED)
        self.assertEqual(completed.payload["search_id"], "paper-search-1")
        self.assertEqual(completed.payload["query"], "agent memory")

    async def test_skill_projection_has_a_dedicated_product_lifecycle(self) -> None:
        await self.emit(
            "skill_started",
            sequence=1,
            payload={
                "skill": "literature-search",
                "path": "/skills/literature-search/SKILL.md",
                "status": "running",
            },
            item_id="skill-1",
        )
        await self.emit(
            "skill_completed",
            sequence=2,
            payload={
                "skill": "literature-search",
                "path": "/skills/literature-search/SKILL.md",
                "status": "completed",
                "ok": True,
            },
            item_id="skill-1",
        )
        started, completed = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual(started.kind, PRODUCT_EVENT_SKILL_STARTED)
        self.assertEqual(started.payload["skill"], "literature-search")
        self.assertEqual(started.payload["path"], "/skills/literature-search/SKILL.md")
        self.assertNotIn("success", started.payload)
        self.assertEqual(completed.kind, PRODUCT_EVENT_SKILL_COMPLETED)
        self.assertTrue(completed.payload["success"])

    async def test_native_activity_projection_preserves_lifecycle_and_details(self) -> None:
        await self.emit(
            "native_activity_started",
            sequence=1,
            payload={
                "activity_type": "image_generation",
                "category": "media",
                "details": {"revised_prompt": "draw a chart"},
                "status": "running",
                "ok": False,
            },
            item_id="native-1",
        )
        await self.emit(
            "native_activity_completed",
            sequence=2,
            payload={
                "activity_type": "image_generation",
                "category": "media",
                "details": {"saved_path": "/tmp/chart.png"},
                "status": "completed",
                "ok": True,
            },
            item_id="native-1",
        )
        started, completed = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual(started.kind, PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED)
        self.assertEqual(started.payload["activity_type"], "image_generation")
        self.assertEqual(started.payload["details"]["revised_prompt"], "draw a chart")
        self.assertNotIn("success", started.payload)
        self.assertEqual(completed.kind, PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED)
        self.assertTrue(completed.payload["success"])
        self.assertEqual(completed.payload["details"]["saved_path"], "/tmp/chart.png")

    async def test_attachment_is_written_under_bound_session_root(self) -> None:
        service = SessionService(
            self.root,
            {PRODUCT_SESSION_ID: self.live},
            access=self.catalog,
            events=self.events,
            runtime=SimpleNamespace(),  # type: ignore[arg-type]
            workspaces=SessionWorkspaceService(workspace_allows),
            artifacts=self.artifacts,
            settings=SimpleNamespace(runtime_executable=lambda: ""),  # type: ignore[arg-type]
            credentials=skill_credentials_from_env({}),
            logger=self.logger,
        )
        attachment = service.save_attachment(
            PRODUCT_SESSION_ID,
            filename="../evidence.csv",
            content=b"a,b\n1,2\n",
            media_type="text/csv",
        )
        path = Path(attachment["absolute_path"])
        self.assertEqual(path.name.endswith("-evidence.csv"), True)
        self.assertEqual(path.read_bytes(), b"a,b\n1,2\n")
        path.relative_to(self.live.runtime_workdir)
        self.assertEqual(len(attachment["sha256"]), 64)

    async def test_session_file_browser_uses_bound_root_and_rejects_escape(self) -> None:
        output = self.live.runtime_workdir / "outputs"
        output.mkdir(parents=True, exist_ok=True)
        first = output / "session-a.md"
        second = output / "session-b.md"
        first.write_text("A only\n", encoding="utf-8")
        second.write_text("B only\n", encoding="utf-8")
        (self.live.runtime_workdir / ".secret").write_text("hidden", encoding="utf-8")
        service = SessionService(
            self.root,
            {PRODUCT_SESSION_ID: self.live},
            access=self.catalog,
            events=self.events,
            runtime=SimpleNamespace(),  # type: ignore[arg-type]
            workspaces=SessionWorkspaceService(workspace_allows),
            artifacts=self.artifacts,
            settings=SimpleNamespace(runtime_executable=lambda: ""),  # type: ignore[arg-type]
            credentials=skill_credentials_from_env({}),
            logger=self.logger,
        )

        root = service.files(PRODUCT_SESSION_ID)
        listing = service.files(PRODUCT_SESSION_ID, "outputs")
        self.assertEqual(root["root"], str(self.live.runtime_workdir))
        self.assertNotIn(".secret", {row["name"] for row in root["items"]})
        self.assertEqual(
            {row["name"] for row in listing["items"]},
            {"session-a.md", "session-b.md"},
        )
        self.assertEqual(
            service.file_content(PRODUCT_SESSION_ID, "outputs/session-a.md")["content"],
            "A only\n",
        )
        raw, media_type = service.file_raw(PRODUCT_SESSION_ID, "outputs/session-b.md")
        self.assertEqual(raw, b"B only\n")
        self.assertEqual(media_type, "text/markdown")
        with self.assertRaises(HTTPException) as raised:
            service.file_content(PRODUCT_SESSION_ID, "../../outside")
        self.assertEqual(raised.exception.status_code, 400)

    async def test_model_catalog_and_session_provider_share_one_projection(self) -> None:
        config = {
            "model_name": "deepseek-v4-pro[1m]",
            "call_url": "https://models.example/v1/chat/completions",
            "base_url": "https://models.example/v1",
            "api_key": "contract-key",
            "context_window": 131072,
        }
        available = {
            "key": "deepseek-v4-pro",
            "label": "DeepSeek V4 Pro",
            "provider": "openai",
            "provider_label": "ScholarSeed",
            "model_name": "deepseek-v4-pro",
            "image_input": False,
            "source": "builtin",
            "billing": "api",
            "reasoning_efforts": [],
            "reasoning_effort": "",
        }
        selected = {"model": ""}
        settings = SimpleNamespace(
            runtime_executable=lambda: "codex",
            runtime_model=lambda: selected["model"],
            set_runtime_model=lambda value: selected.__setitem__("model", value),
        )
        completion_bridge = CompletionBridge("http://127.0.0.1:9999")
        service = ModelService(settings, completion_bridge)  # type: ignore[arg-type]
        runtime_home = self.root / "codex-runtime"
        source_home = self.root / "codex-source"
        with (
            patch.object(model_module, "load_builtin_work_config", return_value=config),
            patch.object(model_module, "available_models", return_value=[available]),
            patch.object(model_module, "current_model_key", return_value="deepseek-v4-pro"),
            patch.object(model_module, "subscription_groups", return_value=[]),
            patch.object(
                model_module,
                "resolve_model_choice",
                return_value={"key": "deepseek-v4-pro", "billing": "api"},
            ),
            patch.object(model_module, "apply_model_to_config", return_value=config),
            patch.dict(
                "os.environ",
                {
                    "SCHOLARSEED_CODEX_HOME": str(runtime_home),
                    "SCHOLARSEED_CODEX_SOURCE_HOME": str(source_home),
                },
            ),
        ):
            catalog = await service.catalog()
            self.assertEqual(catalog["current_model"], "deepseek-v4-pro")
            self.assertEqual(catalog["available_models"][0]["source"], "builtin")
            chosen = await service.select("deepseek-v4-pro", persist=True)
            self.assertEqual(chosen["current_model"], "deepseek-v4-pro")
            self.assertEqual(selected["model"], "deepseek-v4-pro")
            intent, credential_port = service.session_spec("deepseek-v4-pro").runtime_model()
        self.assertEqual(intent.model_ref, "deepseek-v4-pro")
        self.assertEqual(intent.context_window, 131072)
        self.assertEqual(intent.transport.wire_protocol.value, "responses")
        self.assertTrue(intent.transport.endpoint.startswith("http://127.0.0.1:9999/"))
        self.assertTrue(intent.transport.endpoint.endswith("/v1"))
        self.assertIsNone(credential_port)
        upstream = next(iter(completion_bridge._upstreams.values()))
        self.assertEqual(upstream.route_model("codex-auto-review"), "codex-auto-review")
        self.assertEqual(intent.capabilities.tool_protocol.value, "json_schema")

    async def test_retry_budget_follows_endpoint_ownership(self) -> None:
        """内置网关路 Codex 侧不重试(0)，BYOK 直连路保留一次瞬时重连(1)；0 不被当 falsy 丢掉。"""

        bridge = CompletionBridge(
            "http://127.0.0.1:9999", source_endpoints=(DEEPRD_GATEWAY_BASE_URL,)
        )
        gateway_provider, _ = model_module._codex_provider(
            {"model_name": "qwen3.8-max", "base_url": DEEPRD_GATEWAY_BASE_URL},
            bridge,
        )
        byok_provider, _ = model_module._codex_provider(
            {
                "model_name": "minimax-m2.1",
                "base_url": "https://byok.example/v1",
                "api_key": "sk-test",
            },
            bridge,
        )
        self.assertEqual(
            gateway_provider["stream_max_retries"], model_module.GATEWAY_STREAM_MAX_RETRIES
        )
        self.assertEqual(
            gateway_provider["request_max_retries"], model_module.GATEWAY_REQUEST_MAX_RETRIES
        )
        self.assertEqual(byok_provider["stream_max_retries"], model_module.BYOK_STREAM_MAX_RETRIES)
        self.assertEqual(
            byok_provider["request_max_retries"], model_module.BYOK_REQUEST_MAX_RETRIES
        )
        self.assertEqual(model_module.GATEWAY_STREAM_MAX_RETRIES, 0)
        self.assertEqual(model_module.BYOK_STREAM_MAX_RETRIES, 1)
        gateway_spec = model_module.SessionModelSpec(
            key="qwen3.8-max",
            model_name="qwen3.8-max",
            config={},
            billing="api",
            codex_provider=gateway_provider,
        )
        intent, _ = gateway_spec.runtime_model()
        self.assertEqual(intent.transport.stream_max_retries, 0)
        self.assertEqual(intent.transport.request_max_retries, 0)
        byok_spec = model_module.SessionModelSpec(
            key="minimax-m2.1",
            model_name="minimax-m2.1",
            config={},
            billing="api",
            codex_provider=byok_provider,
        )
        byok_intent, _ = byok_spec.runtime_model()
        self.assertEqual(byok_intent.transport.stream_max_retries, 1)
        self.assertEqual(byok_intent.transport.request_max_retries, 1)

    async def test_thinking_admission_follows_the_declared_form(self) -> None:
        """形态准入读真注册表：没声明过的形态不能存，区间未确认的预算同样不能存。"""

        def row(model: str) -> dict[str, Any]:
            declared = apply_capability(
                {"model_name": model, "provider": "openai"},
                bundled_registry().lookup(model, ""),
                lane="",
            )
            return {**declared, "key": model, "label": model, "source": "builtin", "billing": "api"}

        settings = SimpleNamespace(
            runtime_executable=lambda: "codex",
            runtime_model=lambda: TOGGLE_FORM_MODEL,
            set_runtime_model=lambda value: None,
        )
        service = ModelService(settings, CompletionBridge("http://127.0.0.1:9999"))  # type: ignore[arg-type]
        with (
            patch.object(model_module, "load_builtin_work_config", return_value={}),
            patch.object(
                model_module,
                "available_models",
                return_value=[row(TOGGLE_FORM_MODEL), row(EFFORT_FORM_MODEL)],
            ),
            patch.object(model_module, "current_model_key", return_value=TOGGLE_FORM_MODEL),
            patch.object(model_module, "subscription_groups", return_value=[]),
        ):
            self.assertIsNone(
                await service.validate_thinking(TOGGLE_FORM_MODEL, ModelThinking(enabled=False))
            )
            with self.assertRaisesRegex(model_module.SessionModelUnavailableError, "思考预算区间"):
                await service.validate_thinking(TOGGLE_FORM_MODEL, ModelThinking(budget=512))
            with self.assertRaisesRegex(model_module.SessionModelUnavailableError, "思考开关"):
                await service.validate_thinking(EFFORT_FORM_MODEL, ModelThinking(enabled=True))
            # 没选任何值不是一次准入请求，不该被拦。
            self.assertIsNone(await service.validate_thinking(EFFORT_FORM_MODEL, ModelThinking()))
            with self.assertRaises(model_module.SessionModelUnavailableError):
                await service.validate_thinking("not-in-catalog", ModelThinking(enabled=True))

    async def test_stale_persisted_model_falls_back_to_the_configured_model(self) -> None:
        """内置模型收敛后, 持久化的旧选择不能把用户静默换到订阅计费。"""

        config = {"model_name": "qwen3.8-max", "base_url": "https://models.example/v1"}
        available = {
            "key": "qwen3.8-max",
            "label": "Qwen 3.8 Max",
            "provider": "openai",
            "model_name": "qwen3.8-max",
            "source": "builtin",
            "billing": "api",
        }
        settings = SimpleNamespace(
            runtime_executable=lambda: "codex",
            runtime_model=lambda: "glm-5.2-1m",  # 已被收敛掉的旧选择
            set_runtime_model=lambda value: None,
        )
        service = ModelService(settings, CompletionBridge("http://127.0.0.1:9999"))  # type: ignore[arg-type]
        with (
            patch.object(model_module, "load_builtin_work_config", return_value=config),
            patch.object(model_module, "available_models", return_value=[available]),
            patch.object(model_module, "current_model_key", return_value="qwen3.8-max"),
            patch.object(model_module, "subscription_groups", return_value=[]),
        ):
            catalog = await service.catalog()
        self.assertEqual(catalog["current_model"], "qwen3.8-max")

    async def test_retired_native_selection_never_falls_back_to_api_billing(self) -> None:
        settings = SimpleNamespace(runtime_model=lambda: model_module.RETIRED_NATIVE_MODEL_KEY)
        service = ModelService(settings, CompletionBridge("http://127.0.0.1:9999"))
        with (
            patch.object(model_module, "load_builtin_work_config", return_value={}),
            patch.object(model_module, "current_model_key", return_value="configured-api"),
            patch.object(
                model_module,
                "available_models",
                return_value=[{"key": "configured-api", "billing": "api"}],
            ),
        ):
            catalog = await service.catalog()
            self.assertEqual(catalog["current_model"], "")
            self.assertEqual(catalog["subscription_groups"], [])
            with self.assertRaises(model_module.SessionModelUnavailableError):
                service.session_spec()
            with self.assertRaises(model_module.SessionModelUnavailableError):
                await service.select(model_module.RETIRED_NATIVE_MODEL_KEY, persist=False)

    def test_retired_session_model_requires_an_explicit_connection(self) -> None:
        settings = SimpleNamespace(runtime_model=lambda: "codex-subscription-default")
        service = ModelService(settings, CompletionBridge("http://127.0.0.1:9999"))
        with (
            patch.object(model_module, "load_builtin_work_config", return_value={}),
            patch.object(model_module, "available_models", return_value=[]),
        ):
            for model_key in ("codex-subscription-default", "gpt-5.6-sol", ""):
                with self.subTest(model_key=model_key):
                    with self.assertRaises(model_module.SessionModelUnavailableError):
                        service.session_spec(model_key)

    def test_product_prompt_defines_session_content_boundaries(self) -> None:
        for expected in (
            "When a project is bound",
            "session working directory may be separate from the project root",
            "`resources/` is the resource library (资料库)",
            "`.scholarseed/` is private product runtime state",
            "Use normal filesystem tools against the supplied Shared Resources directory",
            "discover, list, count, choose, read or modify resource-library files",
            "already supplies the real directory and authorized writable roots",
            "not the\ndefault access path and not a substitute for filesystem reads or writes",
            "`scholarseed-bridge resource list --json '{}'`",
            "`scholarseed-bridge resource list --help`",
            "complete product-managed logical inventory",
            "follow `next_cursor` when necessary",
            "`entries[].path` values\nare project-relative source identifiers",
            "If a logical entry has no supplied real filesystem locator",
            "If `warnings` reports an unavailable linked root",
            "`scholarseed-bridge literature list/read/annotations`",
            "Project Sessions expose current-project papers; global Sessions expose",
            "For literature selected from the current Session's literature\nscope",
            "supplied `literature:<id>` reference",
            "show `notes/a.md` or `资料库/notes/a.md`",
            "never `resources/notes/a.md`",
            "Show an absolute path only when the user",
            "Do not expose\nsession IDs, database IDs, internal reference IDs",
        ):
            self.assertIn(expected, PRODUCT_PROMPT)
        self.assertNotIn("library, first run `scholarseed-bridge resource list", PRODUCT_PROMPT)
        self.assertNotIn("Do not substitute a filesystem scan", PRODUCT_PROMPT)
        self.assertNotIn("literature library (文献库) is product-managed", PRODUCT_PROMPT)

    def test_codex_runtime_home_does_not_persist_product_prompt(self) -> None:
        runtime_home = self.root / "codex-product-runtime"
        source_home = self.root / "codex-user-source"
        source_home.mkdir(parents=True)
        source_auth = source_home / "auth.json"
        source_auth.write_text('{"auth": "contract"}', encoding="utf-8")
        (source_home / "config.toml").write_text(
            'developer_instructions = "user-global-marker"\n',
            encoding="utf-8",
        )
        with patch.dict(
            "os.environ",
            {
                "SCHOLARSEED_CODEX_HOME": str(runtime_home),
                "SCHOLARSEED_CODEX_SOURCE_HOME": str(source_home),
            },
        ):
            prepared = codex_module.prepare_codex_runtime_home(native_authentication=True)
            prepared_again = codex_module.prepare_codex_runtime_home(native_authentication=True)

        self.assertEqual(prepared, runtime_home.resolve())
        self.assertEqual(prepared_again, prepared)
        self.assertFalse((prepared / "config.toml").exists())
        self.assertEqual(
            (prepared / "auth.json").read_text(encoding="utf-8"), '{"auth": "contract"}'
        )
        self.assertEqual((prepared / "auth.json").stat().st_mode & 0o777, 0o600)

        source_auth.write_text('{"auth": "refreshed"}', encoding="utf-8")
        source_mtime = (prepared / "auth.json").stat().st_mtime_ns + 1_000_000_000
        os.utime(source_auth, ns=(source_mtime, source_mtime))
        with patch.dict(
            "os.environ",
            {
                "SCHOLARSEED_CODEX_HOME": str(runtime_home),
                "SCHOLARSEED_CODEX_SOURCE_HOME": str(source_home),
            },
        ):
            codex_module.prepare_codex_runtime_home(native_authentication=True)
        self.assertEqual(
            (prepared / "auth.json").read_text(encoding="utf-8"),
            '{"auth": "refreshed"}',
        )

        product_auth = prepared / "auth.json"
        product_auth.write_text('{"auth": "product-newer"}', encoding="utf-8")
        product_mtime = source_auth.stat().st_mtime_ns + 1_000_000_000
        os.utime(product_auth, ns=(product_mtime, product_mtime))
        with patch.dict(
            "os.environ",
            {
                "SCHOLARSEED_CODEX_HOME": str(runtime_home),
                "SCHOLARSEED_CODEX_SOURCE_HOME": str(source_home),
            },
        ):
            codex_module.prepare_codex_runtime_home(native_authentication=True)
        self.assertEqual(
            product_auth.read_text(encoding="utf-8"),
            '{"auth": "product-newer"}',
        )

    def test_product_prompt_is_not_runtime_home_state(self) -> None:
        runtime_home = self.root / "codex-prompt-refresh-runtime"
        source_home = self.root / "codex-prompt-refresh-source"
        with patch.dict(
            "os.environ",
            {
                "SCHOLARSEED_CODEX_HOME": str(runtime_home),
                "SCHOLARSEED_CODEX_SOURCE_HOME": str(source_home),
            },
        ):
            prepared = codex_module.prepare_codex_runtime_home(native_authentication=True)
        self.assertFalse((prepared / "config.toml").exists())

    def test_subscription_billing_requires_an_explicit_transport(self) -> None:
        for billing in ("subscription", "api"):
            with self.subTest(billing=billing):
                spec = model_module.SessionModelSpec(
                    key="model", model_name="model", config={}, billing=billing
                )
                with self.assertRaises(model_module.SessionModelUnavailableError):
                    spec.runtime_model()

    def test_subscription_billing_does_not_override_explicit_transport(self) -> None:
        spec = model_module.SessionModelSpec(
            key="subscription-model",
            model_name="model",
            config={},
            billing="subscription",
            codex_provider={"base_url": "http://127.0.0.1:9999/v1", "wire_api": "responses"},
        )
        intent, credential_port = spec.runtime_model()
        self.assertEqual(intent.transport.mode.value, "remote")
        self.assertEqual(intent.transport.endpoint, "http://127.0.0.1:9999/v1")
        self.assertEqual(intent.model_ref, "model")
        self.assertIsNone(credential_port)

    async def test_mcp_control_is_session_scoped_and_typed(self) -> None:
        service = SessionService(
            self.root,
            {PRODUCT_SESSION_ID: self.live},
            access=self.catalog,
            events=self.events,
            runtime=self.runtime_service()[0],  # type: ignore[arg-type]
            workspaces=SessionWorkspaceService(workspace_allows),
            artifacts=self.artifacts,
            settings=SimpleNamespace(runtime_executable=lambda: ""),  # type: ignore[arg-type]
            credentials=skill_credentials_from_env({}),
            logger=self.logger,
        )
        snapshot = await service.mcp_snapshot(PRODUCT_SESSION_ID)
        tools = await service.mcp_tools(
            PRODUCT_SESSION_ID,
            server="papers",
            cursor="",
            limit=10,
        )
        resource = await service.mcp_read_resource(
            PRODUCT_SESSION_ID,
            server="papers",
            uri="paper://one",
        )
        self.assertEqual(snapshot["session_id"], VENDOR_THREAD_ID)
        self.assertTrue(snapshot["capabilities"]["direct_tool_call"])
        self.assertEqual(tools["data"][0]["callable_name"], "papers__search")
        self.assertEqual(resource["contents"][0]["text"], "paper")
        with self.assertRaisesRegex(ValueError, "explicit_approval"):
            await service.mcp_call_tool(
                PRODUCT_SESSION_ID,
                server="papers",
                tool="search",
                arguments={"query": "must-not-run"},
                meta={},
                request_id="direct-denied",
            )
        self.assertEqual(self.adapter.mcp_control.direct_calls, [])
        direct = await service.mcp_call_tool(
            PRODUCT_SESSION_ID,
            server="papers",
            tool="search",
            arguments={"query": "unique-direct-nonce"},
            meta={},
            request_id="direct-1",
            explicitly_approved=True,
        )
        self.assertTrue(direct["ok"])
        self.assertEqual(direct["request_id"], "direct-1")
        self.assertEqual(direct["content"][0]["text"], "direct-result")
        self.assertEqual(
            self.adapter.mcp_control.direct_calls[0].arguments,
            {"query": "unique-direct-nonce"},
        )
        self.assertEqual(
            self.adapter.mcp_control.direct_calls[0].meta["scholarseedRequestId"],
            "direct-1",
        )
        challenge = await service.mcp_begin_login(
            PRODUCT_SESSION_ID,
            server="papers",
            scopes=("read",),
        )
        self.assertEqual(challenge["authorization_url"], "https://auth.example/authorize")
        with self.assertRaisesRegex(ValueError, "prompt_list"):
            await service.mcp_prompts(PRODUCT_SESSION_ID, server="papers")
        trace_path = self.root / "trace" / f"scholarseed-codex-{PRODUCT_SESSION_ID}.jsonl"
        trace_rows = [json.loads(line) for line in trace_path.read_text().splitlines()]
        denied_rows = [
            row for row in trace_rows if row["attributes"].get("mcp_request_id") == "direct-denied"
        ]
        approved_rows = [
            row for row in trace_rows if row["attributes"].get("mcp_request_id") == "direct-1"
        ]
        self.assertEqual(
            [row["name"] for row in denied_rows],
            ["codex.mcp.control.started", "codex.mcp.control.completed"],
        )
        self.assertFalse(denied_rows[-1]["attributes"]["success"])
        self.assertEqual(
            [row["name"] for row in approved_rows],
            ["codex.mcp.control.started", "codex.mcp.control.completed"],
        )
        self.assertTrue(approved_rows[0]["attributes"]["explicitly_approved"])
        self.assertTrue(approved_rows[-1]["attributes"]["success"])
        self.assertEqual(approved_rows[-1]["attributes"]["vendor_thread_id"], VENDOR_THREAD_ID)
        self.assertNotIn("unique-direct-nonce", trace_path.read_text())

    def test_readiness_actions_and_source_boundary(self) -> None:
        self.assertFalse(
            any(row.name == "dynamic_tools" for row in self.runtime_session.capabilities.entries)
        )
        missing = RuntimeReadiness(
            runtime_id=RUNTIME_ID,
            status=RuntimeStatus.UNAVAILABLE,
            ready=False,
            safe_error="codex_executable_unavailable",
        )
        configured = readiness_payload(missing, configured_executable="/bad/codex")
        unconfigured = readiness_payload(missing)
        self.assertEqual(configured["action"], "configure")
        self.assertEqual(unconfigured["action"], "install")

        source = inspect.getsource(runtime_module) + inspect.getsource(turn_module)
        self.assertNotIn("WorkSession", source)
        self.assertNotIn("TodoWrite", source)
        self.assertNotIn("workspace_changes", source)

    async def test_open_request_uses_config_baseline_without_product_tools(self) -> None:
        service, provider = self.runtime_service()
        session_id = "baseline-session"
        self.catalog.allocate(
            session_id,
            OWNER,
            runtime_id=RUNTIME_ID,
            runtime_workdir=str(self.workdir),
            project_path=None,
            output_root=str(self.output_root),
            model_id="gpt-5-codex",
            reasoning_effort="high",
            policy_id="ask",
        )
        with patch.object(
            live_module,
            "SessionTrace",
            side_effect=lambda product_id, workdir, **kwargs: SessionTrace(
                product_id,
                workdir,
                runtime_id=kwargs["runtime_id"],
                trace_dir=self.root / "baseline-trace",
            ),
        ):
            opened = await service.open(
                session_id=session_id,
                cwd=self.workdir,
                project_path=None,
                output_root=self.output_root,
                resume_vendor_thread_id="",
                model_id="gpt-5-codex",
                reasoning_effort="high",
                permission_mode="ask",
                executable="codex",
                process_environment={"SCHOLARSEED_API_KEY": "skill-secret"},
            )
            self.assertEqual(provider.opened, [])
            self.assertEqual(provider.requests, [])
            await opened.activate()
            try:
                await service.ensure_active(opened)
                request = provider.opened[0]
                self.assertEqual(request.model.reasoning_effort, "high")
                self.assertEqual(
                    self.catalog.model_state(session_id).active_reasoning_effort, "high"
                )
                self.assertTrue(request.developer_instructions.startswith(PRODUCT_PROMPT))
                self.assertEqual(request.base_instructions, base_instructions())
                self.assertIn(
                    'relative to the working directory, is "outputs"',
                    request.developer_instructions,
                )
                self.assertEqual(request.artifact_directives, ())
                self.assertEqual(request.permission.writable_roots, ())
                self.assertEqual(request.skill_roots, SERVICE_SKILL_ROOTS)
                self.assertTrue(request.reservation_id)
                self.assertTrue(await opened.suspend_runtime())
                self.assertIsNone(opened.runtime_session)
                await service.ensure_active(opened)
                resume_request = provider.resumed[-1]
                self.assertEqual(resume_request.skill_roots, SERVICE_SKILL_ROOTS)
                self.assertEqual(resume_request.artifact_directives, ())
                self.assertIsNotNone(resume_request.secret_port)
                self.assertEqual(
                    tuple(binding.name for binding in resume_request.launch_secrets.bindings),
                    ("SCHOLARSEED_API_KEY",),
                )
                resume_secret = await resume_request.secret_port.resolve(
                    resume_request.launch_secrets.bindings[0].secret_ref
                )
                self.assertEqual(resume_secret.value, "skill-secret")
                binding = opened.runtime_binding
            finally:
                await opened.aclose()
            resumed = await service.open(
                session_id=session_id,
                cwd=self.workdir,
                project_path=None,
                output_root=self.output_root,
                resume_vendor_thread_id=binding.opaque_session_ref,
                model_id="gpt-5-codex",
                reasoning_effort="high",
                permission_mode="ask",
                executable="codex",
            )
            self.assertEqual(len(provider.resumed), 1)
            try:
                await service.ensure_active(resumed)
                self.assertEqual(provider.resumed[-1].skill_roots, SERVICE_SKILL_ROOTS)
                self.assertEqual(provider.resumed[-1].binding, binding)
                self.assertEqual(provider.resumed[-1].model.reasoning_effort, "high")
                self.assertEqual(len(provider.opened), 1)
                self.assertEqual(len(provider.requests), 3)
            finally:
                await resumed.aclose()

    async def test_one_shot_failure_classification_uses_submission_boundary(self) -> None:
        for stage in ("readiness", "model", "submitted"):
            with self.subTest(stage=stage):
                failure = RuntimeError("private failure")
                # Some adapters' timeout exceptions still carry this optimistic hint.
                failure.retryability = RuntimeRetryability.USER_RETRYABLE
                model = SimpleNamespace(
                    key="selected",
                    reasoning_options=None,
                    runtime_model=lambda: (ModelIntent(model_ref="wire"), None),
                    surface_options=lambda **kw: {
                        "model": "wire",
                        "process_environment": {},
                        "executable": "codex",
                    },
                )
                adapter = FakeAdapter(self.skill_file)
                runtime_session = FakeRuntimeSession(adapter, product_session_id=stage)
                runtime_session.submit = AsyncMock(side_effect=failure)
                open_session = AsyncMock(return_value=runtime_session)
                models = SimpleNamespace(
                    session_spec=Mock(
                        side_effect=ValueError("bad model") if stage == "model" else None,
                        return_value=model,
                    ),
                    release_session=Mock(),
                )
                provider = FakeRuntimeProvider(open_session)
                service = LiveSessionService(
                    catalog=self.catalog,
                    events=self.events,
                    artifacts=self.artifacts,
                    skills=self.live._skills,
                    models=models,
                    logger=self.logger,
                    gateway=SimpleNamespace(
                        default_runtime_id=RUNTIME_ID,
                        provider=lambda _runtime_id="": provider,
                    ),
                )
                readiness = RuntimeReadiness(
                    runtime_id=RUNTIME_ID,
                    status=(
                        RuntimeStatus.UNAUTHENTICATED
                        if stage == "readiness"
                        else RuntimeStatus.READY
                    ),
                    ready=stage != "readiness",
                    executable="codex",
                )
                service.skill_inventory = AsyncMock(return_value=await self.live.refresh_skills())
                with (
                    patch.object(service, "readiness", AsyncMock(return_value=readiness)),
                    patch.object(runtime_module, "SessionTrace", Mock()),
                    self.assertRaises(RuntimeError) as raised,
                ):
                    await service.invoke_once(
                        invocation_id=stage,
                        owner_id="owner",
                        user_id="account-owner",
                        cwd=self.workdir,
                        model_id="",
                        base_instructions="one-shot base",
                        developer_instructions="interpret",
                        input_text="source",
                        executable="codex",
                        permission_mode=RuntimePermissionMode.READ_ONLY,
                        purpose="interpret",
                    )
                self.assertEqual(
                    getattr(raised.exception, "retryability", None),
                    (
                        RuntimeRetryability.UNKNOWN_OUTCOME
                        if stage == "submitted"
                        else RuntimeRetryability.USER_RETRYABLE
                    ),
                )
                self.assertEqual(runtime_session.submit.await_count, int(stage == "submitted"))

    async def test_one_shot_runtime_writes_trace_without_product_session_or_input(self) -> None:
        trace_dir = self.root / "one-shot-trace"
        original_trace = runtime_module.SessionTrace
        secret_input = "private selected text must not enter trace"
        self_test = self

        class OneShotRuntimeSession(FakeRuntimeSession):
            async def submit(self, request: Any) -> CommandReceipt:
                self_test.assertFalse(
                    await service.cancel_once("one-shot-invocation", owner_id="other")
                )
                self_test.assertTrue(
                    await service.cancel_once("one-shot-invocation", owner_id="owner-1")
                )
                for kind, payload in (
                    (
                        RuntimeEventKind.PLAN_UPDATED,
                        {"todos": [{"content": "search", "status": "in_progress"}]},
                    ),
                    (RuntimeEventKind.TOOL_STARTED, {"name": "exec_command"}),
                    (RuntimeEventKind.TOOL_COMPLETED, {"name": "exec_command", "ok": True}),
                ):
                    self._sequence += 1
                    await self._events.put(
                        RuntimeEvent(
                            schema_version=1,
                            event_id=f"fixture:{self._sequence}",
                            runtime_id=RUNTIME_ID,
                            product_session_id=self.binding.product_session_id,
                            native_session_id=self.binding.opaque_session_ref,
                            process_generation=1,
                            sequence=self._sequence,
                            kind=kind,
                            delivery=DeliveryClass.MUST_PERSIST,
                            observed_at="fixture",
                            native_turn_id=request.command_id,
                            correlation_id=request.command_id,
                            payload=payload,
                        )
                    )
                return await super().submit(request)

        async def fake_readiness(_runtime_id: str = "") -> RuntimeReadiness:
            return RuntimeReadiness(
                runtime_id=RUNTIME_ID,
                status=RuntimeStatus.READY,
                ready=True,
                executable="codex",
            )

        runtime_module.SessionTrace = lambda session_id, workdir, **kwargs: original_trace(  # type: ignore[assignment,misc]
            session_id,
            workdir,
            runtime_id=str(kwargs["runtime_id"]),
            trace_dir=trace_dir,
        )
        released: list[str] = []
        opened_sessions: list[FakeRuntimeSession] = []
        opened_requests: list[Any] = []
        model_requests: list[dict[str, Any]] = []

        async def _one_shot_session(request: Any) -> FakeRuntimeSession:
            opened_requests.append(request)
            self.assertEqual(request.skill_roots, SERVICE_SKILL_ROOTS)
            runtime_session = OneShotRuntimeSession(
                FakeAdapter(self.skill_file),
                request.product_session_id,
                final_text="translated",
                input_tokens=17,
                output_tokens=5,
            )
            opened_sessions.append(runtime_session)
            return runtime_session

        try:
            model = SimpleNamespace(
                key="resolved-model",
                reasoning_options=None,
                runtime_model=lambda: (ModelIntent(model_ref="wire-model"), None),
                surface_options=lambda **_kwargs: {
                    "model": "wire-model",
                    "executable": "codex",
                    "process_environment": {},
                },
            )

            def session_spec(*_args: Any, **kwargs: Any) -> Any:
                model_requests.append(kwargs)
                return model

            provider = FakeRuntimeProvider(_one_shot_session)
            service = LiveSessionService(
                catalog=self.catalog,
                events=self.events,
                artifacts=self.artifacts,
                skills=SkillCatalog(
                    bundled_root=SERVICE_BUNDLED_SKILLS_DIR,
                    user_root=SERVICE_SKILLS_DIR,
                ),
                models=SimpleNamespace(  # type: ignore[arg-type]
                    session_spec=session_spec,
                    release_session=lambda invocation_id: released.append(invocation_id),
                ),
                logger=self.logger,
                gateway=SimpleNamespace(
                    default_runtime_id=RUNTIME_ID,
                    readiness=fake_readiness,
                    provider=lambda _runtime_id="": provider,
                ),
            )
            with patch.object(
                service, "_session_options", wraps=service._session_options
            ) as session_options:
                service.skill_inventory = AsyncMock(return_value=await self.live.refresh_skills())
                result = await service.invoke_once(
                    invocation_id="one-shot-invocation",
                    owner_id="owner-1",
                    user_id="account-owner-1",
                    cwd=self.workdir,
                    model_id="",
                    base_instructions="one-shot base",
                    developer_instructions="translate only",
                    input_text=secret_input,
                    executable="codex",
                    permission_mode=RuntimePermissionMode.READ_ONLY,
                    purpose="assistant.translate",
                    network_access=True,
                    reasoning_effort="low",
                    service_tier="fast",
                    required_capabilities=(RuntimeCapabilityName.WEB_SEARCH,),
                    skill_identity={
                        "id": "builtin:web-search",
                        "name": "web-search",
                        "version": "0.0.0",
                        "fingerprint": "fixture",
                        "profile": "official",
                    },
                )
            self.assertEqual(session_options.call_args.kwargs["source_text"], secret_input)
        finally:
            runtime_module.SessionTrace = original_trace  # type: ignore[misc]

        self.assertEqual(result.model_key, "resolved-model")
        self.assertEqual(model_requests[0]["user_id"], "account-owner-1")
        self.assertEqual(opened_requests[0].skill_roots, SERVICE_SKILL_ROOTS)
        self.assertEqual(opened_requests[0].base_instructions, "one-shot base")
        self.assertEqual(opened_requests[0].developer_instructions, "translate only")
        self.assertTrue(opened_requests[0].permission.network_access)
        self.assertEqual(opened_requests[0].model.reasoning_effort, "low")
        self.assertEqual(opened_requests[0].model.service_tier, "fast")
        self.assertEqual(
            opened_requests[0].required_capabilities,
            (RuntimeCapabilityName.WEB_SEARCH,),
        )
        self.assertEqual(len(opened_sessions[0].interrupt_requests), 1)
        self.assertFalse(await service.cancel_once("one-shot-invocation", owner_id="owner-1"))
        self.assertEqual(result.turn.final_text, "translated")
        self.assertIsNone(self.catalog.get("one-shot-invocation"))
        self.assertEqual(released, ["one-shot-invocation"])
        trace_path = trace_dir / "scholarseed-codex-one-shot-invocation.jsonl"
        trace_text = trace_path.read_text(encoding="utf-8")
        self.assertNotIn(secret_input, trace_text)
        rows = [json.loads(line) for line in trace_text.splitlines()]
        names = [row["name"] for row in rows]
        self.assertIn("scholarseed.invocation.started", names)
        self.assertIn("scholarseed.invocation.completed", names)
        self.assertIn("codex.event.plan.updated", names)
        self.assertIn("codex.event.tool.started", names)
        self.assertIn("codex.event.tool.completed", names)
        self.assertIn("codex.turn.started", names)
        self.assertIn("codex.turn.completed", names)
        started = next(row for row in rows if row["name"] == "scholarseed.invocation.started")
        self.assertEqual(started["attributes"]["instruction_chars"], len("translate only"))
        self.assertEqual(started["attributes"]["input_chars"], len(secret_input))
        self.assertEqual(started["attributes"]["skill"]["profile"], "official")
        completed = next(row for row in rows if row["name"] == "scholarseed.invocation.completed")
        self.assertEqual(completed["attributes"]["model"], "resolved-model")
        self.assertEqual(
            completed["attributes"]["usage"],
            {"input_tokens": 17, "output_tokens": 5},
        )

    def test_runtime_executable_is_adapter_owned_and_legacy_setting_is_removed(self) -> None:
        selected = "/contract/bin/codex"

        class Runtime:
            runtime_id = RUNTIME_ID
            gateway_capabilities = CapabilitySet()

            async def readiness(self, *, executable: str = "") -> RuntimeReadiness:
                valid = executable == ""
                return RuntimeReadiness(
                    runtime_id=RUNTIME_ID,
                    status=(RuntimeStatus.READY if valid else RuntimeStatus.UNAVAILABLE),
                    ready=valid,
                    executable=selected if valid else "",
                    version="codex-cli 0.147.0" if valid else "",
                    authenticated=True if valid else None,
                    safe_error="" if valid else "codex_executable_unavailable",
                )

        original_path = settings_module.SERVE_SETTINGS_FILE
        settings_module.SERVE_SETTINGS_FILE = self.root / "runtime-settings.json"
        try:
            settings_module.SERVE_SETTINGS_FILE.write_text(
                json.dumps(
                    {
                        "codex_executable": "/legacy/codex",
                        "codex_model": "gpt-contract",
                    }
                ),
                encoding="utf-8",
            )
            settings = SettingsService({codex_module.SCHOLARSEED_CODEX_EXECUTABLE_ENV: selected})
            app = FastAPI()
            mount_setting_routes(
                app,
                models=SimpleNamespace(),  # type: ignore[arg-type]
                settings=settings,
                runtime=Runtime(),  # type: ignore[arg-type]
            )
            client = TestClient(app)
            status = client.get("/api/serve/settings/runtime")
            removed = client.post(
                "/api/serve/settings/runtime",
                json={"runtime_id": RUNTIME_ID, "executable": selected},
            )
            persisted = json.loads(settings_module.SERVE_SETTINGS_FILE.read_text("utf-8"))
            self.assertEqual(status.status_code, 200)
            self.assertTrue(status.json()["readiness"]["ready"])
            self.assertEqual(removed.status_code, 405)
            self.assertEqual(settings.runtime_executable(), "")
            self.assertNotIn("codex_executable", persisted)
            self.assertEqual(persisted["codex_model"], "gpt-contract")
        finally:
            settings_module.SERVE_SETTINGS_FILE = original_path

    def test_provider_error_code_and_safe_message_are_preserved(self) -> None:
        self.assertEqual(
            CodexTurnRuntime._turn_error(
                {
                    "error": {
                        "code": "insufficient_quota",
                        "message": "You exceeded your current quota.",
                    },
                    "request_id": "request-1",
                }
            ),
            ("insufficient_quota", "You exceeded your current quota."),
        )


class RuntimeFailureMessageTests(unittest.TestCase):
    def test_unknown_model_switch_error_does_not_guess_cause_or_recovery(self) -> None:
        private_detail = "internal path /private/session; api_key=private-test-secret"
        for error in (
            RuntimeError(private_detail),
            AppServerError(private_detail, safe_error="unrecognized_runtime_failure"),
        ):
            with self.subTest(error=type(error).__name__):
                payload = session_module._runtime_failure_payload(error, operation="model_switch")
                self.assertFalse(payload["ok"])
                self.assertEqual(payload["error"], "session_model_switch_failed")
                self.assertEqual(
                    payload["code"],
                    getattr(error, "safe_error", "session_model_switch_failed"),
                )
                self.assertEqual(payload["failure_type"], type(error).__name__)
                self.assertTrue(payload["detail"].startswith("模型切换失败"))
                self.assertIn("重试", payload["detail"])
                self.assertNotIn("连接", payload["detail"])
                self.assertNotIn("已保留", payload["detail"])
                self.assertNotIn("已恢复", payload["detail"])
                self.assertNotIn(private_detail, json.dumps(payload))

    def test_known_failure_keeps_operation_and_safe_diagnostics(self) -> None:
        operations = (
            ("open", "harness_session_open_failed", "会话创建失败"),
            ("resume", "harness_session_resume_failed", "会话恢复失败"),
            ("model_switch", "session_model_switch_failed", "模型切换失败"),
            ("permission_switch", "session_permission_switch_failed", "权限模式切换失败"),
        )
        reasons = (
            ("agent_runtime_capacity_reached", "运行时进程池已满"),
            ("runtime_rpc_rejected", "拒绝"),
            ("runtime_transport_lost", "本地连接已中断"),
            ("runtime_rpc_timeout", "超时"),
            ("session_model_unavailable", "模型配置"),
        )
        for operation, stable_error, summary in operations:
            for code, reason in reasons:
                with self.subTest(operation=operation, code=code):
                    error = AppServerError(
                        "private runtime diagnostic",
                        safe_error=code,
                        method="thread/resume",
                        rpc_code=-32603,
                    )
                    payload = session_module._runtime_failure_payload(error, operation=operation)
                    self.assertEqual(payload["error"], stable_error)
                    self.assertEqual(payload["code"], code)
                    self.assertEqual(payload["rpc_method"], error.method)
                    self.assertEqual(payload["rpc_code"], error.rpc_code)
                    self.assertTrue(payload["detail"].startswith(summary))
                    self.assertIn(reason, payload["detail"])
                    self.assertNotIn("检查模型连接", payload["detail"])
                    self.assertNotIn("private runtime diagnostic", json.dumps(payload))


class ModelConnectionSwitchTests(unittest.IsolatedAsyncioTestCase):
    async def test_restart_required_preserves_effort_without_private_resume(self) -> None:
        runtime = SimpleNamespace(
            resolve_model=lambda key, **kwargs: SimpleNamespace(
                key=key,
                runtime_model=lambda effort="", thinking=None: (
                    ModelIntent(model_ref=key, reasoning_effort=effort, thinking=thinking),
                    None,
                ),
            ),
        )
        live = SimpleNamespace(
            model_id="previous",
            reasoning_effort="low",
            user_id="local",
            id="effort-switch-contract",
            runtime_session=SimpleNamespace(
                reconfigure=AsyncMock(
                    return_value=AppliedState(
                        requested_revision="next",
                        applied_revision="",
                        state=CommandState.RESTART_REQUIRED,
                        scope="session",
                    )
                )
            ),
        )
        result = await SessionService._apply_model_intent(
            SimpleNamespace(_runtime=runtime), live, "target", "high"
        )
        self.assertEqual(result, CommandState.RESTART_REQUIRED)
        self.assertEqual((live.model_id, live.reasoning_effort), ("previous", "low"))
        intent = live.runtime_session.reconfigure.await_args.args[0].model
        self.assertEqual(intent.reasoning_effort, "high")

    async def test_failed_safe_suspend_preserves_current_model_and_effort(self) -> None:
        live = SimpleNamespace(
            model_id="previous",
            reasoning_effort="low",
            runtime_session=object(),
            suspend_runtime=AsyncMock(return_value=False),
            lifecycle_lock=asyncio.Lock(),
        )
        with self.assertRaisesRegex(RuntimeError, "quiescent"):
            await LiveSessionService.switch_model(
                SimpleNamespace(), live, model_id="target", reasoning_effort="high"
            )
        self.assertEqual((live.model_id, live.reasoning_effort), ("previous", "low"))


if __name__ == "__main__":
    unittest.main()
