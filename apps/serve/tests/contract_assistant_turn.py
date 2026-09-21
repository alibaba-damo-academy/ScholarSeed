"""Contract for Assistant snapshot admission, model input, and history safety."""

# isort: skip_file -- SCHOLARSEED_HOME must be isolated before importing runtime modules.

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch
from pathlib import Path
from types import SimpleNamespace
from typing import Any

_TRACE_HOME = tempfile.TemporaryDirectory(prefix="assistant-turn-home-")
os.environ["SCHOLARSEED_HOME"] = _TRACE_HOME.name

from scholarseed_runtime.contract import (  # noqa: E402
    CapabilitySet,
    CommandReceipt,
    CommandState,
    RuntimeBinding,
    RuntimeInventory,
)
from scholarseed_runtime.contract.input import (  # noqa: E402
    InputKind,
    TurnInput,
)
from scholarseed_runtime.contract.history import (  # noqa: E402
    TurnStatus,
)
from service.assistant.persistence.store import AssistantStore  # noqa: E402
from service.assistant.service.context import (  # noqa: E402
    ASSISTANT_CONTEXT_HEADER,
    AssistantService,
)
from service.capabilities.service.skills import SkillCatalog  # noqa: E402
from service.chat.active import RUNTIME_ID  # noqa: E402
from service.chat.constants import (  # noqa: E402
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_MESSAGE_REMOVED,
    PRODUCT_EVENT_REVIEW_READY,
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_SESSION_STATE_CLOSED,
    PRODUCT_TURN_OUTCOME_UNKNOWN,
)
from service.chat.persistence.artifacts import SessionArtifactStore  # noqa: E402
from service.chat.persistence.catalog import (  # noqa: E402
    QueuedMessageState,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
    UncertaintyKind,
    UncertaintyState,
)
from service.chat.persistence.events import ProductEventStore  # noqa: E402
from service.chat.service.events import EventService  # noqa: E402
from scholarseed_runtime.gateway.driver import RuntimeTurnOutcome, RuntimeTurnResult  # noqa: E402

# SCHOLARSEED_HOME test isolation must precede service imports.
from service.chat.runtime.live import LiveSession  # noqa: E402
from service.chat.runtime.ledger import SessionLedger  # noqa: E402
from service.chat.service.turns import TurnResult, TurnService  # noqa: E402
from service.chat.service.sessions import (  # noqa: E402
    SessionService,
    TURN_UNKNOWN_CONFIRM_DECISION,
)
from service.chat.runtime.activation import SessionActivationError  # noqa: E402
from scholarseed_runtime.contract.resource import (  # noqa: E402
    RESOURCE_WAIT_TIMEOUT,
    ResourceReceipt,
    ResourceState,
)
from service.paths import (  # noqa: E402
    SERVICE_BUNDLED_SKILLS_DIR,
    SERVICE_SKILLS_DIR,
)
from service.platform.context import (  # noqa: E402
    AssistantContextResolution,
    AssistantContextResolvedItem,
    AssistantContextResolveRequest,
    ContextLabelFallback,
    ContextRef,
    ContextRefKind,
    ContextResolutionState,
    ContextRetention,
    ProjectContextPolicy,
    SearchScope,
    SelectionAnchor,
    ProductTaskType,
)
from service.platform.resources import ResourceTurnContext, ReviewCaptureResult  # noqa: E402

SESSION_ID = "assistant-turn-session"
OWNER = SessionPrincipal("local")
CLIENT_TURN = "assistant-client-turn"
USER_TEXT = "只回答原始问题"


class CaptureAdapter:
    runtime_id = RUNTIME_ID
    history = ()
    skill_control = None
    model_control = None
    mcp_control = None

    def __init__(self) -> None:
        self.session_id = "assistant-vendor-thread"
        self.inputs: list[Any] = []
        self.started: asyncio.Event | None = None
        self.release: asyncio.Event | None = None
        self.result_status = TurnStatus.COMPLETED
        self.result_outcome: RuntimeTurnOutcome | None = None

    async def steer(self, turn_input: TurnInput) -> str:
        self.inputs.append(turn_input)
        return "assistant-vendor-turn"

    async def interrupt(self) -> None:
        return None

    async def aclose(self) -> None:
        return None


class CaptureDriver:
    def __init__(self, adapter: CaptureAdapter) -> None:
        self.adapter = adapter

    async def submit(self, request: Any) -> RuntimeTurnResult:
        self.adapter.inputs.append(request)
        if self.adapter.started is not None and self.adapter.release is not None:
            self.adapter.started.set()
            await self.adapter.release.wait()
        outcome = self.adapter.result_outcome or (
            RuntimeTurnOutcome.COMPLETED
            if self.adapter.result_status is TurnStatus.COMPLETED
            else (
                RuntimeTurnOutcome.INTERRUPTED
                if self.adapter.result_status is TurnStatus.INTERRUPTED
                else RuntimeTurnOutcome.FAILED
            )
        )
        return RuntimeTurnResult(
            command_id=request.command_id,
            native_turn_id="assistant-vendor-turn",
            outcome=outcome,
            final_text="done" if outcome is RuntimeTurnOutcome.COMPLETED else "",
            safe_error="contract failure" if outcome is RuntimeTurnOutcome.FAILED else "",
        )

    async def close(self) -> None:
        await self.adapter.aclose()


class CaptureSession:
    resource_evidence = None

    def __init__(self, adapter: CaptureAdapter) -> None:
        self.adapter = adapter

    async def steer(self, request: Any) -> CommandReceipt:
        self.adapter.inputs.append(request)
        return CommandReceipt(request.command_id, CommandState.ACCEPTED, "assistant-vendor-turn")

    async def interrupt(self, request: Any) -> CommandReceipt:
        return CommandReceipt(request.command_id, CommandState.ACCEPTED, "assistant-vendor-turn")

    async def terminate(self, request: Any) -> CommandReceipt:
        return CommandReceipt(request.command_id, CommandState.APPLIED)

    async def inventory(self, request: Any) -> RuntimeInventory:
        del request
        return RuntimeInventory(
            revision="assistant-turn-fixture",
            values={"skills": {"skills": []}},
        )


class ReadyProvider:
    def resolve(self, request: AssistantContextResolveRequest) -> AssistantContextResolution:
        return AssistantContextResolution(
            state=ContextResolutionState.READY,
            provider_version="turn-contract/v1",
            items=(
                AssistantContextResolvedItem(
                    item_id=request.ref.source_id,
                    source_id=request.ref.source_id,
                    label=request.ref.label,
                    label_fallback=request.ref.label_fallback,
                    selection_source_label=request.ref.selection_source_label,
                    source_revision="sha256:contract",
                    text="contract evidence",
                ),
            ),
        )


class AssistantTurnContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="assistant-turn-")
        root = Path(self.temporary.name)
        self.database = root / "sessions.sqlite3"
        self.catalog = SessionCatalogStore(self.database)
        self.events = ProductEventStore(self.database)
        artifacts = SessionArtifactStore(self.database)
        skills = SkillCatalog(
            bundled_root=SERVICE_BUNDLED_SKILLS_DIR,
            user_root=SERVICE_SKILLS_DIR,
        )
        workdir = root / "workspace"
        workdir.mkdir()
        self.live = LiveSession(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            runtime_workdir=workdir,
            project_path=None,
            output_root=workdir / "output",
            model_id="contract-model",
            catalog=self.catalog,
            events=self.events,
            artifacts=artifacts,
            skills=skills,
            logger=SimpleNamespace(
                debug=lambda *_args, **_kwargs: None,
                error=lambda *_args, **_kwargs: None,
                info=lambda *_args, **_kwargs: None,
            ),
        )
        self.adapter = CaptureAdapter()
        self.live.vendor_thread_id = self.adapter.session_id
        self.live.runtime_driver = CaptureDriver(self.adapter)  # type: ignore[assignment]
        self.live.runtime_session = CaptureSession(self.adapter)  # type: ignore[assignment]
        self.catalog.register(
            SESSION_ID,
            OWNER,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=self.adapter.session_id,
            vendor_session_id=None,
            runtime_workdir=str(workdir),
            project_path=None,
            output_root=str(workdir / "output"),
            codex_version="contract",
            model_id="contract-model",
            policy_id="ask",
            status=SessionStatus.READY,
            title=SESSION_ID,
            created_at=1.0,
        )
        self.store = AssistantStore(self.database)
        self.assistant = AssistantService(self.store)
        self.turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
        )

    def tearDown(self) -> None:
        asyncio.run(self.live.aclose())
        self.temporary.cleanup()

    def session_service(self, residents=None) -> SessionService:
        return SessionService(
            self.live.runtime_workdir,
            {SESSION_ID: self.live} if residents is None else residents,
            access=self.catalog,
            events=self.events,
            logger=self.live._logger,
            runtime=SimpleNamespace(),
            workspaces=SimpleNamespace(),
            artifacts=SimpleNamespace(),
            settings=SimpleNamespace(),
            credentials=SimpleNamespace(),
        )

    def test_cold_queue_read_preserves_persisted_requests_without_activation(self) -> None:
        request_id = "cold-resource-wait"
        queued = self.catalog.enqueue_message(SESSION_ID, request_id, {"input": []})
        self.catalog.begin_resource_wait(
            SESSION_ID, request_id, deadline=12345.0, purpose=queued.purpose
        )
        residents = {}
        sessions = self.session_service(residents)
        result, status = sessions.queued(SESSION_ID)
        self.assertEqual(status, 200)
        self.assertEqual(result["messages"][0]["queued_message_id"], request_id)
        self.assertEqual(result["messages"][0]["state"], QueuedMessageState.WAITING_RESOURCES.value)
        self.assertEqual(residents, {})
        self.assertEqual(
            self.catalog.queued_message(SESSION_ID, request_id).state,
            QueuedMessageState.WAITING_RESOURCES,
        )
        missing, missing_status = sessions.queued("missing-session")
        self.assertEqual(missing_status, 404)
        self.assertFalse(missing["ok"])

    def test_skill_identity_selects_structured_fulltext_task_type(self) -> None:
        cases = (
            ("research-idea-partner", ProductTaskType.RESEARCH_IDEA),
            ("precise-literature-search", ProductTaskType.PRECISE_SEARCH),
            ("literature-review", ProductTaskType.LITERATURE_REVIEW),
        )
        for skill, expected in cases:
            with self.subTest(skill=skill):
                admission = SimpleNamespace(skill_versions={skill: "1"})
                self.assertEqual(TurnService._task_type({}, admission), expected.value)

    @staticmethod
    def body(revision: int, *, client_turn_id: str = CLIENT_TURN) -> dict:
        return {
            "input": [{"type": "text", "text": USER_TEXT}],
            "assistant_context_revision": revision,
            "client_user_message_id": client_turn_id,
            "wait": True,
        }

    def select(
        self,
        expected_revision: int,
        *,
        refs: tuple[ContextRef, ...] = (),
    ):
        return self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=expected_revision,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.ACADEMIC,
            refs=refs,
        )

    def test_resource_summary_reaches_runtime_without_replacing_user_text(self) -> None:
        summary = 'Resource snapshot state\n[{"path":"notes.md","needs_review":true}]'
        deliveries = SimpleNamespace(
            begin_turn=AsyncMock(return_value=ResourceTurnContext(summary)),
            finish_turn=AsyncMock(return_value=ReviewCaptureResult()),
        )
        self.live.project_path = self.live.runtime_workdir
        self.turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
            deliveries=deliveries,
        )
        selection = self.select(0)
        payload, status = asyncio.run(
            self.turns.post(SESSION_ID, self.body(selection.revision), side=False)
        )
        self.assertEqual(status, 202, payload)
        items = self.adapter.inputs[0].items
        self.assertEqual(items[0]["text"], summary)
        self.assertTrue(any(item.get("text") == USER_TEXT for item in items))
        deliveries.begin_turn.assert_awaited_once()

    def test_open_agent_reviews_block_turn_without_mutating_the_batch(self) -> None:
        deliveries = SimpleNamespace(
            begin_turn=AsyncMock(return_value=ResourceTurnContext()),
            finish_turn=AsyncMock(return_value=ReviewCaptureResult()),
        )
        review_batches = SimpleNamespace(has_open_for_workdir=Mock(return_value=True))
        self.live.project_path = self.live.runtime_workdir
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
            deliveries=deliveries,
            review_batches=review_batches,
        )
        selection = self.select(0)

        payload, status = asyncio.run(
            turns.post(SESSION_ID, self.body(selection.revision), side=False)
        )

        self.assertEqual(status, 409, payload)
        self.assertEqual(payload["error"], "resource_review_required")
        review_batches.has_open_for_workdir.assert_called_once_with(str(self.live.runtime_workdir))
        deliveries.begin_turn.assert_not_awaited()
        self.assertEqual(self.adapter.inputs, [])

    def test_finish_delivery_publishes_durable_review_ready_batch(self) -> None:
        deliveries = SimpleNamespace(
            begin_turn=AsyncMock(return_value=ResourceTurnContext()),
            finish_turn=AsyncMock(
                return_value=ReviewCaptureResult(
                    batch_id="review-batch-current-turn",
                    project_id="project-current-turn",
                    paths=("resources/a.md", "resources/b.md"),
                    file_ids=("file-a", "file-b"),
                    review_ids=("review-a", "review-b"),
                )
            ),
        )
        self.live.project_path = self.live.runtime_workdir
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
            deliveries=deliveries,
        )
        selection = self.select(0)

        payload, status = asyncio.run(
            turns.post(SESSION_ID, self.body(selection.revision), side=False)
        )

        self.assertEqual(status, 202, payload)
        review_ready = [
            event
            for event in self.events.replay(SESSION_ID)
            if event.kind == PRODUCT_EVENT_REVIEW_READY
        ]
        self.assertEqual(len(review_ready), 1)
        self.assertEqual(
            review_ready[0].payload,
            {
                "batch_id": "review-batch-current-turn",
                "project_id": "project-current-turn",
                "paths": ["resources/a.md", "resources/b.md"],
                "file_ids": ["file-a", "file-b"],
                "review_ids": ["review-a", "review-b"],
            },
        )
        self.assertEqual(review_ready[0].vendor_turn_id, "assistant-vendor-turn")
        history_events = EventService(
            {SESSION_ID: self.live}, self.events, self.live._logger
        ).activity_snapshot(SESSION_ID)
        self.assertIn(
            PRODUCT_EVENT_REVIEW_READY,
            [event["type"] for event in history_events],
        )

    def test_finish_delivery_does_not_publish_batch_without_project_identity(self) -> None:
        deliveries = SimpleNamespace(
            begin_turn=AsyncMock(return_value=ResourceTurnContext()),
            finish_turn=AsyncMock(
                return_value=ReviewCaptureResult(
                    batch_id="review-batch-without-project",
                    file_ids=("file-a",),
                    review_ids=("review-a",),
                )
            ),
        )
        self.live.project_path = self.live.runtime_workdir
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
            deliveries=deliveries,
        )
        selection = self.select(0)

        payload, status = asyncio.run(
            turns.post(SESSION_ID, self.body(selection.revision), side=False)
        )

        self.assertEqual(status, 202, payload)
        self.assertFalse(
            any(
                event.kind == PRODUCT_EVENT_REVIEW_READY for event in self.events.replay(SESSION_ID)
            )
        )

    def test_model_card_is_hidden_from_product_history_and_cold_resume(self) -> None:
        selection = self.select(0)
        payload, status = asyncio.run(
            self.turns.post(SESSION_ID, self.body(selection.revision), side=False)
        )

        self.assertEqual(status, 202)
        self.assertTrue(payload["ok"])
        self.assertEqual(len(self.adapter.inputs), 1)
        items = self.adapter.inputs[0].items
        self.assertEqual(
            [item["kind"] for item in items],
            [InputKind.TEXT.value, InputKind.TEXT.value],
        )
        self.assertTrue(items[0]["text"].startswith(ASSISTANT_CONTEXT_HEADER))
        self.assertIn("precise-literature-search", items[0]["text"])
        self.assertEqual(items[1]["text"], USER_TEXT)

        user_events = [
            event
            for event in self.events.replay(SESSION_ID)
            if event.kind == PRODUCT_EVENT_USER_MESSAGE
        ]
        self.assertEqual(len(user_events), 2)
        self.assertEqual(user_events[-1].payload["text"], USER_TEXT)
        self.assertTrue(user_events[-1].payload["assistant_snapshot_id"])
        self.assertNotIn(ASSISTANT_CONTEXT_HEADER, str(user_events[-1].payload))

        vendor_text = f"{items[0]['text']}\n{USER_TEXT}"
        decorated = EventService(
            {SESSION_ID: self.live},
            self.events,
            self.live._logger,
        ).decorate_history(
            SESSION_ID,
            [
                {
                    "kind": "user",
                    "role": "user",
                    "text": vendor_text,
                    "turn_id": "assistant-vendor-turn",
                    "item_id": "vendor-item",
                }
            ],
        )
        self.assertEqual(decorated[0]["text"], USER_TEXT)
        self.assertNotIn(ASSISTANT_CONTEXT_HEADER, decorated[0]["text"])

    def test_default_web_scope_guides_existing_search_without_revision(self) -> None:
        body = self.body(0, client_turn_id="default-web-turn")
        body.pop("assistant_context_revision")

        payload, status = asyncio.run(self.turns.post(SESSION_ID, body, side=False))

        self.assertEqual(status, 202)
        self.assertTrue(payload["ok"])
        items = self.adapter.inputs[0].items
        self.assertEqual(items[0]["kind"], InputKind.TEXT.value)
        self.assertIn('"search_scope":"web"', items[0]["text"])
        self.assertIn("existing web-search capability", items[0]["text"])
        self.assertEqual(items[1]["text"], USER_TEXT)

    def test_unavailable_session_label_provenance_reaches_error_without_starting_adapter(
        self,
    ) -> None:
        selected = self.select(
            0,
            refs=(
                ContextRef(
                    ref_id="untitled-session",
                    kind=ContextRefKind.SESSION,
                    source_id="original-session",
                    label="未命名对话",
                    label_fallback=ContextLabelFallback.UNTITLED_SESSION,
                ),
            ),
        )
        payload, status = asyncio.run(
            self.turns.post(SESSION_ID, self.body(selected.revision), side=False)
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["issues"][0]["label"], "未命名对话")
        self.assertEqual(payload["issues"][0]["label_fallback"], "untitled_session")
        self.assertEqual(payload["issues"][0]["state"], "unavailable")
        self.assertEqual(self.adapter.inputs, [])

    def test_empty_selection_source_label_reaches_failure_issue_without_anchor(self) -> None:
        selected = self.select(
            0,
            refs=(
                ContextRef(
                    ref_id="selected",
                    kind=ContextRefKind.SELECTION,
                    source_id="original.md",
                    label=" · 划词",
                    selection_source_label="",
                    anchor=SelectionAnchor(
                        locator={
                            "kind": "text",
                            "start_line": 0,
                            "start_column": 0,
                            "end_line": 0,
                            "end_column": 1,
                        },
                        selected_text_hash="sha256:" + "a" * 64,
                        preview_text="原文",
                    ),
                ),
            ),
        )
        payload, status = asyncio.run(
            self.turns.post(SESSION_ID, self.body(selected.revision), side=False)
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["issues"][0]["label"], " · 划词")
        self.assertEqual(payload["issues"][0]["selection_source_label"], "")
        self.assertNotIn("anchor", payload["issues"][0])
        self.assertEqual(self.adapter.inputs, [])

    def test_unavailable_ref_and_stale_revision_do_not_start_adapter(self) -> None:
        selection = self.select(
            0,
            refs=(
                ContextRef(
                    ref_id="file-ref",
                    kind=ContextRefKind.FILE,
                    source_id="资料/尚未接入.md",
                    label="尚未接入.md",
                ),
            ),
        )
        unavailable, status = asyncio.run(
            self.turns.post(SESSION_ID, self.body(selection.revision), side=False)
        )
        self.assertEqual(status, 400)
        self.assertEqual(unavailable["error"], "assistant_context_unavailable")
        self.assertEqual(
            unavailable["issues"],
            [
                {
                    "ref_id": "file-ref",
                    "kind": "file",
                    "label": "尚未接入.md",
                    "state": "unavailable",
                    "reason": "upstream_port_unavailable",
                }
            ],
        )
        self.assertEqual(self.adapter.inputs, [])
        self.assertTrue(unavailable["snapshot_id"])
        self.assertEqual(
            [
                event
                for event in self.events.replay(SESSION_ID)
                if event.kind == PRODUCT_EVENT_USER_MESSAGE
            ],
            [],
        )

        stale, stale_status = asyncio.run(
            self.turns.post(
                SESSION_ID,
                self.body(0, client_turn_id="stale-client-turn"),
                side=False,
            )
        )
        self.assertEqual(stale_status, 409)
        self.assertEqual(stale["error"], "assistant_context_revision_conflict")
        self.assertEqual(self.adapter.inputs, [])

    def test_side_inherits_active_snapshot_without_reinjecting_card(self) -> None:
        selection = self.select(0)

        async def exercise() -> tuple[dict, int]:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            main_payload, main_status = await self.turns.post(
                SESSION_ID,
                {**self.body(selection.revision), "wait": False},
                side=False,
            )
            self.assertEqual(main_status, 202)
            self.assertTrue(main_payload["ok"])
            await self.adapter.started.wait()
            queued_payload, queued_status = await self.turns.post(
                SESSION_ID,
                {
                    "input": [{"type": "text", "text": "补充问题"}],
                    "client_user_message_id": "assistant-side-client",
                    "assistant_context_revision": selection.revision,
                },
                side=False,
            )
            self.assertEqual(queued_status, 202)
            self.assertTrue(queued_payload["queued"])
            side_payload, side_status = await self.turns.post(
                SESSION_ID,
                {"queued_message_id": queued_payload["queued_message_id"]},
                side=True,
            )
            self.adapter.release.set()
            assert self.live.current_task is not None
            await self.live.current_task
            return side_payload, side_status

        payload, status = asyncio.run(exercise())
        self.assertEqual(status, 202)
        self.assertTrue(payload["ok"])
        self.assertEqual(len(self.adapter.inputs), 2)
        self.assertEqual(len(self.adapter.inputs[0].items), 2)
        self.assertEqual(len(self.adapter.inputs[1].items), 1)
        self.assertEqual(self.adapter.inputs[1].items[0]["text"], "补充问题")

        bound_side = next(
            event
            for event in reversed(self.events.replay(SESSION_ID))
            if event.payload.get("client_turn_id") == "assistant-side-client"
            and event.payload.get("binding") == "bound"
        )
        main_snapshot = self.store.snapshot_for_turn(SESSION_ID, CLIENT_TURN)
        assert main_snapshot is not None
        self.assertEqual(bound_side.payload["assistant_snapshot_id"], main_snapshot.snapshot_id)

    def test_next_turn_ref_consumes_on_completion_and_survives_failure(self) -> None:
        assistant = AssistantService(
            self.store,
            project_for_session=lambda _session_id: "project-contract",
            providers={ContextRefKind.FILE: ReadyProvider()},
        )
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=assistant,
        )
        transient = ContextRef(
            ref_id="next-turn",
            kind=ContextRefKind.FILE,
            source_id="evidence.md",
            label="evidence.md",
            retention=ContextRetention.NEXT_TURN,
        )
        selected = assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(transient,),
        )
        payload, _status = asyncio.run(
            turns.post(
                SESSION_ID, self.body(selected.revision, client_turn_id="consume"), side=False
            )
        )
        self.assertTrue(payload["ok"])
        self.assertEqual(assistant.selection(SESSION_ID).refs, ())

        retained = assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=assistant.selection(SESSION_ID).revision,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(transient,),
        )
        self.adapter.result_status = TurnStatus.FAILED
        failed, _failed_status = asyncio.run(
            turns.post(
                SESSION_ID, self.body(retained.revision, client_turn_id="retain"), side=False
            )
        )
        self.assertFalse(failed["ok"])
        self.assertEqual(assistant.selection(SESSION_ID).refs, (transient,))

    def test_queued_turn_freezes_only_its_own_next_turn_refs(self) -> None:
        assistant = AssistantService(
            self.store,
            project_for_session=lambda _session_id: "project-contract",
            providers={ContextRefKind.FILE: ReadyProvider()},
        )
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=assistant,
        )
        first = ContextRef(
            ref_id="active-ref",
            kind=ContextRefKind.FILE,
            source_id="active.md",
            label="active.md",
            retention=ContextRetention.NEXT_TURN,
        )
        second = ContextRef(
            ref_id="queued-ref",
            kind=ContextRefKind.FILE,
            source_id="queued.md",
            label="queued.md",
            retention=ContextRetention.NEXT_TURN,
        )
        later = ContextRef(
            ref_id="later-ref",
            kind=ContextRefKind.FILE,
            source_id="later.md",
            label="later.md",
            retention=ContextRetention.NEXT_TURN,
        )
        selected = assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(first,),
        )

        async def exercise() -> dict:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            await turns.post(
                SESSION_ID,
                {**self.body(selected.revision, client_turn_id="active-turn"), "wait": False},
                side=False,
            )
            await self.adapter.started.wait()
            with_second = assistant.replace_selection(
                session_id=SESSION_ID,
                expected_revision=selected.revision,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                refs=(first, second),
            )
            queued, _status = await turns.post(
                SESSION_ID,
                {
                    **self.body(with_second.revision, client_turn_id="queued-turn"),
                    "wait": False,
                    "input": [{"type": "text", "text": "queued question"}],
                },
                side=False,
            )
            listed, _listed_status = self.session_service().queued(SESSION_ID)
            assistant.replace_selection(
                session_id=SESSION_ID,
                expected_revision=with_second.revision,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                refs=(first, second, later),
            )
            main_task = self.live.current_task
            assert main_task is not None
            self.adapter.release.set()
            await main_task
            for _attempt in range(100):
                await asyncio.sleep(0.01)
                if len(self.adapter.inputs) == 2 and self.live.current_task is not None:
                    await self.live.current_task
                    break
            return {**queued, "listed": listed["messages"]}

        queued = asyncio.run(exercise())
        self.assertTrue(queued["queued"])
        messages, _status = self.session_service().queued(SESSION_ID)
        self.assertEqual(messages["messages"], [])
        queued_row = next(
            row for row in queued["listed"] if row["queued_message_id"] == "queued-turn"
        )
        self.assertEqual(
            [ref["source_id"] for ref in queued_row["assistant_references"]],
            ["queued.md"],
        )
        queued_snapshot = self.store.snapshot_for_turn(SESSION_ID, "queued-turn")
        assert queued_snapshot is not None
        self.assertEqual([item.ref.source_id for item in queued_snapshot.items], ["queued.md"])
        self.assertIn("queued.md", self.adapter.inputs[1].items[0]["text"])
        self.assertNotIn("active.md", self.adapter.inputs[1].items[0]["text"])
        self.assertNotIn("later.md", self.adapter.inputs[1].items[0]["text"])
        self.assertEqual(
            [ref.source_id for ref in assistant.selection(SESSION_ID).refs],
            ["later.md"],
        )

    def test_session_label_provenance_crosses_queue_cold_restore_and_user_history(self) -> None:
        assistant = AssistantService(
            self.store, providers={ContextRefKind.SESSION: ReadyProvider()}
        )
        turns = TurnService({SESSION_ID: self.live}, self.live._logger, context_source=assistant)
        reference = ContextRef(
            ref_id="untitled-queued-ref",
            kind=ContextRefKind.SESSION,
            source_id="original-session",
            label="未命名对话",
            retention=ContextRetention.NEXT_TURN,
            label_fallback=ContextLabelFallback.UNTITLED_SESSION,
        )
        queued_text = "队列用户原文"

        async def exercise() -> dict:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            await turns.post(
                SESSION_ID,
                {**self.body(0, client_turn_id="active-provenance"), "wait": False},
                side=False,
            )
            await self.adapter.started.wait()
            selected = assistant.replace_selection(
                session_id=SESSION_ID,
                expected_revision=0,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                refs=(reference,),
            )
            queued, status = await turns.post(
                SESSION_ID,
                {
                    **self.body(selected.revision, client_turn_id="queued-provenance"),
                    "wait": False,
                    "input": [{"type": "text", "text": queued_text}],
                },
                side=False,
            )
            self.assertEqual(status, 202)
            self.assertTrue(queued["queued"])
            durable = SessionCatalogStore(self.database).queued_message(
                SESSION_ID, "queued-provenance"
            )
            assert durable is not None
            cold, cold_status = self.session_service(residents={}).queued(SESSION_ID)
            self.assertEqual(cold_status, 200)
            row = next(
                item
                for item in cold["messages"]
                if item["queued_message_id"] == "queued-provenance"
            )
            self.assertEqual(row["assistant_references"], durable.body["assistant_references"])
            self.assertEqual(row["assistant_references"][0]["label_fallback"], "untitled_session")
            self.assertEqual(row["assistant_references"][0]["source_id"], reference.source_id)
            self.assertEqual(row["assistant_references"][0]["label"], reference.label)
            main_task = self.live.current_task
            assert main_task is not None
            self.adapter.release.set()
            await main_task
            for _attempt in range(100):
                await asyncio.sleep(0.01)
                if len(self.adapter.inputs) == 2 and self.live.current_task is not None:
                    await self.live.current_task
                    break
            return row

        queued = asyncio.run(exercise())
        self.assertEqual(len(self.adapter.inputs), 2)
        self.assertNotIn("label_fallback", self.adapter.inputs[1].items[0]["text"])
        self.assertEqual(self.adapter.inputs[1].items[1]["text"], queued_text)
        events = [
            event
            for event in self.events.replay(SESSION_ID)
            if event.kind == PRODUCT_EVENT_USER_MESSAGE and event.payload.get("text") == queued_text
        ]
        self.assertTrue(events)
        self.assertEqual(events[-1].payload["refs"], queued["assistant_references"])
        cold_events = ProductEventStore(self.database)
        restored = EventService({}, cold_events, self.live._logger).decorate_history(
            SESSION_ID,
            [{"kind": "user", "role": "user", "text": queued_text}],
        )
        row = next(item for item in restored if item.get("text") == queued_text)
        self.assertEqual(row["refs"], queued["assistant_references"])
        self.assertEqual(row["refs"][0]["label_fallback"], "untitled_session")
        self.assertEqual(assistant.selection(SESSION_ID).refs, ())

    def test_selection_source_label_crosses_queue_cold_restore_and_user_history(self) -> None:
        assistant = AssistantService(
            self.store, providers={ContextRefKind.SELECTION: ReadyProvider()}
        )
        turns = TurnService({SESSION_ID: self.live}, self.live._logger, context_source=assistant)
        reference = ContextRef(
            ref_id="untitled-queued-ref",
            kind=ContextRefKind.SELECTION,
            source_id="original-session",
            label="未命名对话",
            retention=ContextRetention.NEXT_TURN,
            selection_source_label=" 原始标题 · 划词 ",
            anchor=SelectionAnchor(
                locator={"kind": "markdown", "start": 0, "end": 1, "source_map_version": "v1"},
                selected_text_hash="sha256:" + "a" * 64,
                preview_text="原文",
            ),
        )
        queued_text = "队列用户原文"

        async def exercise() -> dict:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            await turns.post(
                SESSION_ID,
                {**self.body(0, client_turn_id="active-provenance"), "wait": False},
                side=False,
            )
            await self.adapter.started.wait()
            selected = assistant.replace_selection(
                session_id=SESSION_ID,
                expected_revision=0,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                refs=(reference,),
            )
            queued, status = await turns.post(
                SESSION_ID,
                {
                    **self.body(selected.revision, client_turn_id="queued-provenance"),
                    "wait": False,
                    "input": [{"type": "text", "text": queued_text}],
                },
                side=False,
            )
            self.assertEqual(status, 202)
            self.assertTrue(queued["queued"])
            durable = SessionCatalogStore(self.database).queued_message(
                SESSION_ID, "queued-provenance"
            )
            assert durable is not None
            cold, cold_status = self.session_service(residents={}).queued(SESSION_ID)
            self.assertEqual(cold_status, 200)
            row = next(
                item
                for item in cold["messages"]
                if item["queued_message_id"] == "queued-provenance"
            )
            self.assertEqual(row["assistant_references"], durable.body["assistant_references"])
            self.assertEqual(
                row["assistant_references"][0]["selection_source_label"], " 原始标题 · 划词 "
            )
            self.assertEqual(row["assistant_references"][0]["source_id"], reference.source_id)
            self.assertEqual(row["assistant_references"][0]["label"], reference.label)
            main_task = self.live.current_task
            assert main_task is not None
            self.adapter.release.set()
            await main_task
            for _attempt in range(100):
                await asyncio.sleep(0.01)
                if len(self.adapter.inputs) == 2 and self.live.current_task is not None:
                    await self.live.current_task
                    break
            return row

        queued = asyncio.run(exercise())
        self.assertEqual(len(self.adapter.inputs), 2)
        self.assertNotIn("selection_source_label", self.adapter.inputs[1].items[0]["text"])
        self.assertEqual(self.adapter.inputs[1].items[1]["text"], queued_text)
        events = [
            event
            for event in self.events.replay(SESSION_ID)
            if event.kind == PRODUCT_EVENT_USER_MESSAGE and event.payload.get("text") == queued_text
        ]
        self.assertTrue(events)
        self.assertEqual(events[-1].payload["refs"], queued["assistant_references"])
        cold_events = ProductEventStore(self.database)
        restored = EventService({}, cold_events, self.live._logger).decorate_history(
            SESSION_ID,
            [{"kind": "user", "role": "user", "text": queued_text}],
        )
        row = next(item for item in restored if item.get("text") == queued_text)
        self.assertEqual(row["refs"], queued["assistant_references"])
        self.assertEqual(row["refs"][0]["selection_source_label"], " 原始标题 · 划词 ")
        self.assertEqual(assistant.selection(SESSION_ID).refs, ())

    def test_failed_turn_does_not_auto_run_queue(self) -> None:
        selection = self.select(0)

        async def exercise(status: TurnStatus, suffix: str) -> None:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            self.adapter.result_status = status
            await self.turns.post(
                SESSION_ID,
                {**self.body(selection.revision, client_turn_id=f"active-{suffix}"), "wait": False},
                side=False,
            )
            await self.adapter.started.wait()
            queued, _queued_status = await self.turns.post(
                SESSION_ID,
                {
                    "input": [{"type": "text", "text": f"queued-{suffix}"}],
                    "client_user_message_id": f"queued-{suffix}",
                    "assistant_context_revision": selection.revision,
                },
                side=False,
            )
            self.assertTrue(queued["queued"])
            task = self.live.current_task
            assert task is not None
            self.adapter.release.set()
            await task
            await asyncio.sleep(0.05)
            self.assertEqual(len(self.adapter.inputs), 1)
            rows = self.catalog.queued_messages(SESSION_ID)
            self.assertEqual([row.queued_message_id for row in rows], [f"queued-{suffix}"])

        asyncio.run(exercise(TurnStatus.FAILED, "failed"))

    def test_queued_dequeue_rechecks_review_admission_without_hidden_acceptance(self) -> None:
        selection = self.select(0)
        review_batches = SimpleNamespace(
            has_open_for_workdir=Mock(side_effect=(False, False, True))
        )
        deliveries = SimpleNamespace(
            begin_turn=AsyncMock(return_value=ResourceTurnContext()),
            finish_turn=AsyncMock(return_value=ReviewCaptureResult()),
        )
        self.live.project_path = self.live.runtime_workdir
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
            deliveries=deliveries,
            review_batches=review_batches,
        )

        async def exercise() -> None:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            active, active_status = await turns.post(
                SESSION_ID,
                {
                    **self.body(selection.revision, client_turn_id="active-before-queue"),
                    "wait": False,
                },
                side=False,
            )
            self.assertEqual(active_status, 202, active)
            await self.adapter.started.wait()
            queued, queued_status = await turns.post(
                SESSION_ID,
                {
                    "input": [{"type": "text", "text": "queued after review"}],
                    "client_user_message_id": "queued-after-review",
                    "assistant_context_revision": selection.revision,
                },
                side=False,
            )
            self.assertEqual(queued_status, 202, queued)
            task = self.live.current_task
            assert task is not None
            self.adapter.release.set()
            await task
            await asyncio.sleep(0.05)

        asyncio.run(exercise())

        self.assertEqual(review_batches.has_open_for_workdir.call_count, 3)
        deliveries.begin_turn.assert_awaited_once()
        self.assertEqual(len(self.adapter.inputs), 1)
        queued_rows = self.catalog.queued_messages(SESSION_ID)
        self.assertEqual(len(queued_rows), 1)
        self.assertEqual(queued_rows[0].queued_message_id, "queued-after-review")

    def test_completed_runtime_with_failed_finalization_does_not_auto_run_queue(self) -> None:
        selection = self.select(0)

        async def exercise() -> None:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()

            async def fail_history_binding(
                _client_user_message_id: str,
                *,
                vendor_turn_id: str | None,
            ) -> None:
                del vendor_turn_id
                raise RuntimeError("history binding failed")

            self.live.bind_user_history = fail_history_binding  # type: ignore[method-assign]
            await self.turns.post(
                SESSION_ID,
                {
                    **self.body(selection.revision, client_turn_id="active-finalization-failed"),
                    "wait": False,
                },
                side=False,
            )
            await self.adapter.started.wait()
            queued, _queued_status = await self.turns.post(
                SESSION_ID,
                {
                    "input": [{"type": "text", "text": "queued-after-finalization"}],
                    "client_user_message_id": "queued-after-finalization",
                    "assistant_context_revision": selection.revision,
                },
                side=False,
            )
            self.assertTrue(queued["queued"])
            task = self.live.current_task
            assert task is not None
            self.adapter.release.set()
            result = await task
            await asyncio.sleep(0.05)
            self.assertEqual(result.status, TurnStatus.FAILED)
            self.assertEqual(len(self.adapter.inputs), 1)
            self.assertEqual(
                [row.queued_message_id for row in self.catalog.queued_messages(SESSION_ID)],
                ["queued-after-finalization"],
            )

        asyncio.run(exercise())

    def test_retract_queued_message_discards_only_its_context(self) -> None:
        assistant = AssistantService(
            self.store,
            project_for_session=lambda _session_id: "project-contract",
            providers={ContextRefKind.FILE: ReadyProvider()},
        )
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=assistant,
        )
        active = ContextRef(
            ref_id="active-retract-ref",
            kind=ContextRefKind.FILE,
            source_id="active.md",
            label="active.md",
            retention=ContextRetention.NEXT_TURN,
        )
        queued_ref = ContextRef(
            ref_id="queued-retract-ref",
            kind=ContextRefKind.FILE,
            source_id="queued.md",
            label="queued.md",
            retention=ContextRetention.NEXT_TURN,
        )
        selected = assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(active,),
        )

        async def exercise() -> None:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            await turns.post(
                SESSION_ID,
                {**self.body(selected.revision, client_turn_id="active-retract"), "wait": False},
                side=False,
            )
            await self.adapter.started.wait()
            with_queued = assistant.replace_selection(
                session_id=SESSION_ID,
                expected_revision=selected.revision,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                refs=(active, queued_ref),
            )
            queued, _status = await turns.post(
                SESSION_ID,
                {
                    "input": [{"type": "text", "text": "retract me"}],
                    "client_user_message_id": "queued-retract",
                    "assistant_context_revision": with_queued.revision,
                },
                side=False,
            )
            removed, removed_status = await turns.delete_queued(
                SESSION_ID,
                queued["queued_message_id"],
            )
            self.assertEqual(removed_status, 200)
            self.assertTrue(removed["ok"])
            after_retract = assistant.selection(SESSION_ID)
            self.assertEqual(
                [ref.ref_id for ref in after_retract.refs],
                [active.ref_id],
            )
            self.assertEqual(after_retract.revision, with_queued.revision + 1)
            self.adapter.result_status = TurnStatus.FAILED
            self.adapter.release.set()
            task = self.live.current_task
            assert task is not None
            await task

        asyncio.run(exercise())
        self.assertEqual(self.catalog.queued_messages(SESSION_ID), ())
        self.assertEqual(
            [ref.ref_id for ref in assistant.selection(SESSION_ID).refs],
            [active.ref_id],
        )

    def test_interrupted_turn_does_not_auto_run_queue(self) -> None:
        selection = self.select(0)

        async def exercise() -> None:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            await self.turns.post(
                SESSION_ID,
                {
                    **self.body(selection.revision, client_turn_id="active-interrupted"),
                    "wait": False,
                },
                side=False,
            )
            await self.adapter.started.wait()
            queued, _queued_status = await self.turns.post(
                SESSION_ID,
                {
                    "input": [{"type": "text", "text": "queued-interrupted"}],
                    "client_user_message_id": "queued-interrupted",
                    "assistant_context_revision": selection.revision,
                },
                side=False,
            )
            self.assertTrue(queued["queued"])
            await self.live.interrupt()
            task = self.live.current_task
            assert task is not None
            self.adapter.release.set()
            result = await task
            await asyncio.sleep(0.05)
            self.assertEqual(result.status, TurnStatus.INTERRUPTED)
            self.assertEqual(len(self.adapter.inputs), 1)
            self.assertEqual(
                [row.queued_message_id for row in self.catalog.queued_messages(SESSION_ID)],
                ["queued-interrupted"],
            )

        asyncio.run(exercise())

    def test_retained_queue_context_does_not_block_continuing_original_task(self) -> None:
        assistant = AssistantService(
            self.store,
            project_for_session=lambda _session_id: "project-contract",
            providers={ContextRefKind.FILE: ReadyProvider()},
        )
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=assistant,
        )
        active_ref = ContextRef(
            ref_id="continue-active-ref",
            kind=ContextRefKind.FILE,
            source_id="active.md",
            label="active.md",
            retention=ContextRetention.NEXT_TURN,
        )
        queued_ref = ContextRef(
            ref_id="continue-queued-ref",
            kind=ContextRefKind.FILE,
            source_id="queued.md",
            label="queued.md",
            retention=ContextRetention.NEXT_TURN,
        )
        continued_ref = ContextRef(
            ref_id="continue-new-ref",
            kind=ContextRefKind.FILE,
            source_id="continued.md",
            label="continued.md",
            retention=ContextRetention.NEXT_TURN,
        )
        selected = assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(active_ref,),
        )

        async def exercise() -> tuple[dict, str]:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            await turns.post(
                SESSION_ID,
                {**self.body(selected.revision, client_turn_id="continue-active"), "wait": False},
                side=False,
            )
            await self.adapter.started.wait()
            with_queue = assistant.replace_selection(
                session_id=SESSION_ID,
                expected_revision=selected.revision,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                refs=(active_ref, queued_ref),
            )
            await turns.post(
                SESSION_ID,
                {
                    **self.body(with_queue.revision, client_turn_id="continue-queued"),
                    "wait": False,
                    "input": [{"type": "text", "text": "queued question"}],
                },
                side=False,
            )
            await self.live.interrupt()
            active_task = self.live.current_task
            assert active_task is not None
            self.adapter.release.set()
            await active_task

            with_continuation = assistant.replace_selection(
                session_id=SESSION_ID,
                expected_revision=with_queue.revision,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                refs=(active_ref, queued_ref, continued_ref),
            )
            self.adapter.started = None
            self.adapter.release = None
            self.adapter.result_status = TurnStatus.FAILED
            continued, _status = await turns.post(
                SESSION_ID,
                self.body(with_continuation.revision, client_turn_id="continued-active"),
                side=False,
            )
            return continued, self.adapter.inputs[1].items[0]["text"]

        continued, model_context = asyncio.run(exercise())
        self.assertFalse(continued["ok"])
        self.assertIn("active.md", model_context)
        self.assertIn("continued.md", model_context)
        self.assertNotIn("queued.md", model_context)
        self.assertEqual(
            [row.queued_message_id for row in self.catalog.queued_messages(SESSION_ID)],
            ["continue-queued"],
        )

    def test_resource_wait_is_durable_and_cancellable_without_native_submission(self) -> None:
        selection = self.select(0)

        async def exercise() -> None:
            waiting = asyncio.Event()
            cancelled = asyncio.Event()
            release = asyncio.Event()

            async def prepare(live, *, request_id, deadline, on_wait):
                self.assertFalse(live.lifecycle_lock.locked())
                await on_wait(ResourceReceipt(request_id, "", ResourceState.WAITING), 12345.0)
                waiting.set()
                try:
                    await release.wait()
                finally:
                    cancelled.set()

            turns = TurnService(
                {SESSION_ID: self.live},
                self.live._logger,
                prepare=prepare,
                context_source=self.assistant,
            )
            response, status = await turns.post(
                SESSION_ID,
                {**self.body(selection.revision, client_turn_id="wait-cancel"), "wait": False},
                side=False,
            )
            self.assertEqual(status, 202)
            self.assertTrue(response["queued"])
            self.assertFalse(self.live.running)
            self.assertIsNone(self.live.current_task)
            await asyncio.wait_for(waiting.wait(), 1)
            async with self.live.lifecycle_lock:
                record = self.catalog.queued_message(SESSION_ID, "wait-cancel")
                self.assertEqual(record.state, QueuedMessageState.WAITING_RESOURCES)
                self.assertEqual(record.deadline, 12345.0)
            self.assertTrue(self.live.waiting_resources)
            removed, remove_status = await turns.delete_queued(SESSION_ID, "wait-cancel")
            self.assertEqual(remove_status, 200)
            self.assertTrue(removed["ok"])
            self.assertTrue(cancelled.is_set())
            self.assertFalse(self.live.waiting_resources)
            self.assertIsNone(self.live.resource_task)
            self.assertEqual(self.adapter.inputs, [])
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, "wait-cancel").state,
                QueuedMessageState.CANCELLED,
            )

        asyncio.run(exercise())

    def test_stop_waiting_discards_claim_before_or_after_the_task_first_step(self) -> None:
        assistant = AssistantService(
            self.store,
            project_for_session=lambda _session_id: "project-contract",
            providers={ContextRefKind.FILE: ReadyProvider()},
        )

        async def exercise() -> None:
            for start_waiting in (False, True):
                with self.subTest(start_waiting=start_waiting):
                    waiting = asyncio.Event()
                    request_id = f"stop-resource-{start_waiting}"
                    ref = ContextRef(
                        ref_id=request_id,
                        kind=ContextRefKind.FILE,
                        source_id="waiting.md",
                        label="waiting.md",
                        retention=ContextRetention.NEXT_TURN,
                    )
                    selected = assistant.replace_selection(
                        session_id=SESSION_ID,
                        expected_revision=assistant.selection(SESSION_ID).revision,
                        project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                        search_scope=SearchScope.DISABLED,
                        refs=(ref,),
                    )

                    async def prepare(live, *, request_id, deadline, on_wait):
                        await on_wait(
                            ResourceReceipt(request_id, "", ResourceState.WAITING), 12345.0
                        )
                        waiting.set()
                        await asyncio.Event().wait()

                    turns = TurnService(
                        {SESSION_ID: self.live},
                        self.live._logger,
                        prepare=prepare,
                        context_source=assistant,
                    )
                    response, status = await turns.post(
                        SESSION_ID,
                        {**self.body(selected.revision, client_turn_id=request_id), "wait": False},
                        side=False,
                    )
                    self.assertEqual(status, 202, response)
                    if start_waiting:
                        await asyncio.wait_for(waiting.wait(), 1)
                    self.assertTrue(await self.live.cancel_resource_wait())
                    self.assertEqual(assistant.selection(SESSION_ID).refs, ())
                    self.assertEqual(
                        self.catalog.queued_message(SESSION_ID, request_id).state,
                        QueuedMessageState.CANCELLED,
                    )
                    self.assertIsNone(self.live.resource_task)
                    self.assertEqual(self.adapter.inputs, [])

        asyncio.run(exercise())

    def test_explicit_failed_retry_gets_a_new_resource_deadline(self) -> None:
        selection = self.select(0)

        async def exercise() -> None:
            deadlines = []
            retry_started = asyncio.Event()
            continue_retry = asyncio.Event()
            waiting = asyncio.Event()
            grant = asyncio.Event()
            renewed_deadline = 23456.0

            async def prepare(live, *, request_id, deadline, on_wait):
                deadlines.append(deadline)
                if len(deadlines) == 1:
                    await on_wait(
                        ResourceReceipt(request_id, "", ResourceState.WAITING),
                        12345.0,
                    )
                    raise SessionActivationError(RESOURCE_WAIT_TIMEOUT)
                retry_started.set()
                await continue_retry.wait()
                await on_wait(
                    ResourceReceipt(request_id, "", ResourceState.WAITING),
                    renewed_deadline,
                )
                waiting.set()
                await grant.wait()

            turns = TurnService(
                {SESSION_ID: self.live},
                self.live._logger,
                prepare=prepare,
                context_source=self.assistant,
            )
            body = self.body(selection.revision, client_turn_id="renew-resource")
            result, _status = await turns.post(SESSION_ID, body, side=False)
            self.assertFalse(result["ok"])
            duplicate, _status = await turns.post(SESSION_ID, {**body, "wait": False}, side=False)
            self.assertTrue(duplicate["queued"])
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, "renew-resource").state,
                QueuedMessageState.FAILED,
            )
            self.assertEqual(len(deadlines), 1)
            response, status = await turns.send_queued(SESSION_ID, "renew-resource")
            self.assertEqual(status, 202, response)
            retry_task = self.live.resource_task
            await asyncio.wait_for(retry_started.wait(), 1)
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, "renew-resource").state,
                QueuedMessageState.FAILED,
            )
            duplicate_response, duplicate_status = await turns.send_queued(
                SESSION_ID, "renew-resource"
            )
            self.assertEqual(duplicate_status, 202, duplicate_response)
            self.assertIs(self.live.resource_task, retry_task)
            continue_retry.set()
            await asyncio.wait_for(waiting.wait(), 1)
            self.assertEqual(deadlines, [None, None])
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, "renew-resource").deadline,
                renewed_deadline,
            )
            grant.set()
            await retry_task
            self.assertEqual(len(self.adapter.inputs), 1)
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, "renew-resource").state,
                QueuedMessageState.COMPLETED,
            )

        asyncio.run(exercise())

    def test_interrupt_rechecks_a_wait_that_became_a_running_turn(self) -> None:
        sessions = SessionService(
            self.live.runtime_workdir,
            {SESSION_ID: self.live},
            access=self.catalog,
            events=self.events,
            logger=self.live._logger,
            runtime=SimpleNamespace(runtime_id=RUNTIME_ID),
            workspaces=SimpleNamespace(),
            artifacts=SimpleNamespace(),
            settings=SimpleNamespace(),
            credentials=SimpleNamespace(),
        )

        async def exercise() -> None:
            request_id = "interrupt-admission-race"
            native_turn_id = "native-interrupt-race"
            pending = asyncio.create_task(asyncio.Event().wait())
            self.catalog.enqueue_message(SESSION_ID, request_id, {"text": "once"})
            self.live.resource_task = pending
            self.live.waiting_request_id = request_id
            try:
                with patch.object(
                    self.live.runtime_session,
                    "interrupt",
                    wraps=self.live.runtime_session.interrupt,
                ) as interrupt:
                    async with self.live.lifecycle_lock:
                        stopping = asyncio.create_task(sessions.interrupt(SESSION_ID))
                        await asyncio.sleep(0)
                        self.assertFalse(stopping.done())
                        self.catalog.begin_queued_submission(SESSION_ID, request_id)
                        self.catalog.mark_queue_running(SESSION_ID, request_id, native_turn_id)
                        self.live.ledger.activate_turn(native_turn_id)
                        self.live.current_task = pending
                        self.live.resource_task = None
                        self.live.waiting_request_id = ""
                    response = await asyncio.wait_for(stopping, 1)
                    self.assertTrue(response["ok"])
                    self.assertFalse(response["idle"])
                    self.assertNotIn("cancelled_waiting", response)
                    interrupt.assert_awaited_once()
                    self.assertEqual(
                        self.catalog.queued_message(SESSION_ID, request_id).state,
                        QueuedMessageState.RUNNING,
                    )
            finally:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                self.live.current_task = None
                self.live.resource_task = None

        asyncio.run(exercise())

    def test_resource_grant_keeps_submitting_row_until_native_confirmation(self) -> None:
        selection = self.select(0)

        async def exercise() -> None:
            waiting = asyncio.Event()
            grant = asyncio.Event()
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()

            async def prepare(live, *, request_id, deadline, on_wait):
                await on_wait(ResourceReceipt(request_id, "", ResourceState.WAITING), 12345.0)
                waiting.set()
                await grant.wait()

            turns = TurnService(
                {SESSION_ID: self.live},
                self.live._logger,
                prepare=prepare,
                context_source=self.assistant,
            )
            await turns.post(
                SESSION_ID,
                {**self.body(selection.revision, client_turn_id="wait-grant"), "wait": False},
                side=False,
            )
            await asyncio.wait_for(waiting.wait(), 1)
            grant.set()
            await asyncio.wait_for(self.adapter.started.wait(), 1)
            current = self.catalog.queued_message(SESSION_ID, "wait-grant")
            self.assertEqual(current.state, QueuedMessageState.SUBMITTING)
            self.assertEqual(len(self.catalog.queued_messages(SESSION_ID)), 1)
            denied, status = await turns.delete_queued(SESSION_ID, "wait-grant")
            self.assertEqual(status, 409)
            self.assertFalse(denied["ok"])
            task = self.live.current_task
            self.adapter.release.set()
            await task
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, "wait-grant").state,
                QueuedMessageState.COMPLETED,
            )
            self.assertEqual(self.catalog.queued_messages(SESSION_ID), ())

        asyncio.run(exercise())

    def test_resource_timeout_retains_failed_request_without_native_work(self) -> None:
        selection = self.select(0)

        async def prepare(live, *, request_id, deadline, on_wait):
            await on_wait(ResourceReceipt(request_id, "", ResourceState.WAITING), 12345.0)
            raise SessionActivationError(RESOURCE_WAIT_TIMEOUT)

        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            prepare=prepare,
            context_source=self.assistant,
        )
        result, status = asyncio.run(
            turns.post(
                SESSION_ID, self.body(selection.revision, client_turn_id="wait-expired"), side=False
            )
        )
        self.assertEqual(status, 202)
        self.assertFalse(result["ok"])
        record = self.catalog.queued_message(SESSION_ID, "wait-expired")
        self.assertEqual(record.state, QueuedMessageState.FAILED)
        self.assertEqual(record.safe_error, RESOURCE_WAIT_TIMEOUT)
        self.assertEqual(self.adapter.inputs, [])
        events = [row for row in self.events.replay(SESSION_ID) if row.kind == "send_now_rejected"]
        self.assertEqual(events[-1].payload["state"], QueuedMessageState.FAILED.value)
        self.assertEqual(events[-1].payload["safe_error"], RESOURCE_WAIT_TIMEOUT)

    def test_unknown_claim_stays_owned_until_explicit_confirmation(self) -> None:
        assistant = AssistantService(
            self.store,
            project_for_session=lambda _session_id: "project-contract",
            providers={ContextRefKind.FILE: ReadyProvider()},
        )
        turns = TurnService({SESSION_ID: self.live}, self.live._logger, context_source=assistant)
        sessions = SessionService(
            self.live.runtime_workdir,
            {SESSION_ID: self.live},
            access=self.catalog,
            events=self.events,
            logger=self.live._logger,
            runtime=SimpleNamespace(),
            workspaces=SimpleNamespace(),
            artifacts=SimpleNamespace(),
            settings=SimpleNamespace(),
            credentials=SimpleNamespace(),
        )
        sessions.bind_turn_confirmation(turns.confirm_queued_unknown)

        async def confirm(request_id):
            return await sessions.confirm_unknown_turn(
                SESSION_ID, request_id, {"decision": TURN_UNKNOWN_CONFIRM_DECISION}
            )

        async def exercise() -> None:
            for failure in (
                "native_unknown",
                "transport_exception",
                "native_transport_exception",
                "terminate_cancel",
            ):
                with self.subTest(failure=failure):
                    request_id = f"claim-{failure}"
                    confirmation_id = (
                        f"native-{request_id}"
                        if failure == "native_transport_exception"
                        else request_id
                    )
                    ref = ContextRef(
                        ref_id=request_id,
                        kind=ContextRefKind.FILE,
                        source_id="uncertain.md",
                        label="uncertain.md",
                        retention=ContextRetention.NEXT_TURN,
                    )
                    later = ContextRef(
                        ref_id=f"later-{failure}",
                        kind=ContextRefKind.FILE,
                        source_id="later.md",
                        label="later.md",
                        retention=ContextRetention.NEXT_TURN,
                    )
                    selected = assistant.replace_selection(
                        session_id=SESSION_ID,
                        expected_revision=assistant.selection(SESSION_ID).revision,
                        project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                        search_scope=SearchScope.DISABLED,
                        refs=(ref,),
                    )
                    self.adapter.result_outcome = RuntimeTurnOutcome.UNKNOWN

                    async def submit(_request):
                        if failure == "native_transport_exception":
                            self.catalog.mark_queue_running(SESSION_ID, request_id, confirmation_id)
                            self.live.ledger.activate_turn(confirmation_id)
                        if failure == "terminate_cancel":
                            self.live.terminating = True
                            raise asyncio.CancelledError
                        raise RuntimeError("transport failed after submission")

                    if failure == "native_unknown":
                        result, _status = await turns.post(
                            SESSION_ID,
                            self.body(selected.revision, client_turn_id=request_id),
                            side=False,
                        )
                    else:
                        with patch.object(self.live.runtime_driver, "submit", side_effect=submit):
                            result, _status = await turns.post(
                                SESSION_ID,
                                self.body(selected.revision, client_turn_id=request_id),
                                side=False,
                            )
                    self.assertFalse(result["ok"])
                    retained = self.catalog.queued_message(SESSION_ID, request_id)
                    self.assertEqual(retained.state, QueuedMessageState.OUTCOME_UNKNOWN)
                    self.assertTrue(self.live.ledger.has_unknown_outcome)
                    recoverable = self.live.ledger.uncertainty_snapshot()
                    self.assertEqual(len(recoverable), 1)
                    self.assertEqual(recoverable[0]["correlation_id"], confirmation_id)
                    self.assertEqual(recoverable[0]["state"], UncertaintyState.UNKNOWN.value)
                    terminals = [
                        row
                        for row in self.events.replay(SESSION_ID)
                        if row.vendor_turn_id in {request_id, confirmation_id}
                        and row.kind in {PRODUCT_EVENT_TURN_FAILED, PRODUCT_EVENT_TURN_UNKNOWN}
                    ]
                    self.assertEqual([row.kind for row in terminals], [PRODUCT_EVENT_TURN_UNKNOWN])
                    snapshot = self.store.snapshot_for_turn(SESSION_ID, request_id)
                    self.assertIsNotNone(snapshot)
                    self.store.validate_snapshot_claim(snapshot)
                    with_later = assistant.replace_selection(
                        session_id=SESSION_ID,
                        expected_revision=assistant.selection(SESSION_ID).revision,
                        project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                        search_scope=SearchScope.DISABLED,
                        refs=(ref, later),
                    )
                    # A failed cleanup remains explicitly retryable after ledger confirmation.
                    with patch.object(
                        assistant, "finalize", side_effect=RuntimeError("store busy")
                    ):
                        with self.assertRaisesRegex(RuntimeError, "store busy"):
                            await confirm(confirmation_id)
                    self.assertEqual(
                        self.catalog.queued_message(SESSION_ID, request_id).state,
                        QueuedMessageState.OUTCOME_UNKNOWN,
                    )
                    submitted = len(self.adapter.inputs)
                    for _attempt in range(2):
                        response, status = await confirm(confirmation_id)
                        self.assertEqual(status, 200, response)
                        self.assertTrue(response["ok"])
                    self.assertFalse(self.live.ledger.has_unknown_outcome)
                    self.assertEqual(
                        self.catalog.uncertainty(
                            SESSION_ID, UncertaintyKind.TURN, confirmation_id
                        ).state,
                        UncertaintyState.CONFIRMED,
                    )
                    after = assistant.selection(SESSION_ID)
                    self.assertEqual([item.ref_id for item in after.refs], [later.ref_id])
                    self.assertEqual(after.revision, with_later.revision + 1)
                    settled = self.catalog.queued_message(SESSION_ID, request_id)
                    self.assertEqual(settled.state, QueuedMessageState.COMPLETED)
                    self.assertEqual(settled.safe_error, retained.safe_error)
                    self.assertEqual(len(self.adapter.inputs), submitted)
                    self.live.terminating = False

        asyncio.run(exercise())

    def test_unknown_queue_uses_confirmed_native_identity_for_hydration(self) -> None:
        self.catalog.enqueue_message(SESSION_ID, "client-correlation", {"text": "once"})
        self.catalog.begin_queued_submission(SESSION_ID, "client-correlation")
        self.catalog.mark_queue_running(SESSION_ID, "client-correlation", "native-correlation")
        self.live.ledger.activate_turn("native-correlation")
        self.catalog.record_hil(
            product_request_id="hil-unknown-turn",
            session_id=SESSION_ID,
            vendor_request_id="hil-unknown-turn",
            vendor_turn_id="released-bridge-turn",
            vendor_item_id="item-unknown",
            method="codex.hil",
            payload={"request_id": "hil-unknown-turn", "kind": "permission"},
        )

        async def exercise() -> None:
            await self.turns._fail_queued(
                self.live, "client-correlation", "turn_outcome_unconfirmed", unknown=True
            )
            self.assertEqual(self.live.ledger.active_turn_id, "")
            self.assertEqual(self.catalog.pending_hil(SESSION_ID), ())
            stale = [
                row
                for row in self.events.replay(SESSION_ID)
                if row.kind == PRODUCT_EVENT_HIL_RESOLVED and row.payload.get("state") == "stale"
            ]
            self.assertEqual(len(stale), 1)
            self.assertEqual(stale[0].vendor_turn_id, "released-bridge-turn")
            snapshot = self.live.ledger.uncertainty_snapshot()
            self.assertEqual([row["correlation_id"] for row in snapshot], ["native-correlation"])
            listed, _status = self.session_service().queued(SESSION_ID)
            listed_row = next(
                row
                for row in listed["messages"]
                if row["queued_message_id"] == "client-correlation"
            )
            self.assertEqual(listed_row["native_turn_id"], "native-correlation")
            self.assertTrue(await self.live.ledger.confirm_unknown_turn("native-correlation"))
            await self.turns.confirm_queued_unknown(SESSION_ID, "native-correlation")
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, "client-correlation").state,
                QueuedMessageState.COMPLETED,
            )
            self.assertEqual(self.adapter.inputs, [])

        asyncio.run(exercise())

    def test_terminate_cancels_all_unsent_messages_and_preserves_uncertain_submissions(
        self,
    ) -> None:
        assistant = AssistantService(
            self.store,
            project_for_session=lambda _session_id: "project-contract",
            providers={ContextRefKind.FILE: ReadyProvider()},
        )
        live_sessions = {SESSION_ID: self.live}
        self.live.runtime_session = None
        self.live.runtime_driver = None

        async def exercise() -> None:
            waiting = asyncio.Event()
            cancelled = asyncio.Event()

            async def prepare(live, *, request_id, deadline, on_wait):
                await on_wait(ResourceReceipt(request_id, "", ResourceState.WAITING), 12345.0)
                waiting.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()

            turns = TurnService(
                live_sessions, self.live._logger, prepare=prepare, context_source=assistant
            )
            runtime = SimpleNamespace(cancel_activation=AsyncMock(return_value=False))
            sessions = SessionService(
                self.live.runtime_workdir,
                live_sessions,
                access=self.catalog,
                events=self.events,
                logger=self.live._logger,
                runtime=runtime,
                workspaces=SimpleNamespace(),
                artifacts=SimpleNamespace(),
                settings=SimpleNamespace(),
                credentials=SimpleNamespace(),
            )
            sessions.bind_queue_cancellation(turns.cancel_pending_locked)
            response, status = await turns.post(
                SESSION_ID,
                {**self.body(0, client_turn_id="terminate-waiting"), "wait": False},
                side=False,
            )
            self.assertEqual(status, 202, response)
            await asyncio.wait_for(waiting.wait(), 1)
            selection = assistant.replace_selection(
                session_id=SESSION_ID,
                expected_revision=assistant.selection(SESSION_ID).revision,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                refs=(
                    ContextRef(
                        ref_id="pending-next-turn",
                        kind=ContextRefKind.FILE,
                        source_id="pending.md",
                        label="pending.md",
                        retention=ContextRetention.NEXT_TURN,
                    ),
                ),
            )
            response, status = await turns.post(
                SESSION_ID,
                {**self.body(selection.revision, client_turn_id="terminate-queued"), "wait": False},
                side=False,
            )
            self.assertEqual(status, 202, response)
            self.catalog.enqueue_message(SESSION_ID, "terminate-failed", {"text": "failed"})
            self.catalog.fail_queued_submission(
                SESSION_ID, "terminate-failed", unknown=False, safe_error=RESOURCE_WAIT_TIMEOUT
            )
            for request_id, state in (
                ("preserve-submitting", QueuedMessageState.SUBMITTING),
                ("preserve-running", QueuedMessageState.RUNNING),
                ("preserve-unknown", QueuedMessageState.OUTCOME_UNKNOWN),
            ):
                self.catalog.enqueue_message(SESSION_ID, request_id, {"text": request_id})
                self.catalog.begin_queued_submission(SESSION_ID, request_id)
                if state is QueuedMessageState.RUNNING:
                    self.catalog.mark_queue_running(SESSION_ID, request_id, f"native-{request_id}")
                elif state is QueuedMessageState.OUTCOME_UNKNOWN:
                    self.catalog.fail_queued_submission(
                        SESSION_ID, request_id, unknown=True, safe_error="turn_outcome_unconfirmed"
                    )
            self.catalog.update_status(
                SESSION_ID,
                SessionStatus.ERROR,
                turn_id="preserve-unknown",
                turn_status=PRODUCT_TURN_OUTCOME_UNKNOWN,
            )
            response, status = await sessions.terminate(SESSION_ID)
            self.assertEqual(status, 200, response)
            self.assertTrue(response["terminated"])
            self.assertTrue(cancelled.is_set())
            self.assertNotIn(SESSION_ID, live_sessions)
            self.assertIsNone(self.live.resource_task)
            self.assertIsNone(self.live.termination_task)
            self.assertEqual(self.catalog.get(SESSION_ID).status, SessionStatus.CLOSED)
            self.assertEqual(
                self.catalog.get(SESSION_ID).last_turn_status, PRODUCT_TURN_OUTCOME_UNKNOWN
            )
            closed = [
                row
                for row in self.events.replay(SESSION_ID)
                if row.kind == PRODUCT_EVENT_SESSION_STATE
                and row.payload.get("state") == PRODUCT_SESSION_STATE_CLOSED
            ]
            self.assertEqual(len(closed), 1)
            self.assertEqual(assistant.selection(SESSION_ID).refs, ())
            for request_id in ("terminate-waiting", "terminate-queued", "terminate-failed"):
                self.assertEqual(
                    self.catalog.queued_message(SESSION_ID, request_id).state,
                    QueuedMessageState.CANCELLED,
                )
            self.assertEqual(
                {
                    row.queued_message_id: row.state
                    for row in self.catalog.queued_messages(SESSION_ID)
                },
                {
                    "preserve-submitting": QueuedMessageState.SUBMITTING,
                    "preserve-unknown": QueuedMessageState.OUTCOME_UNKNOWN,
                },
            )
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, "preserve-running").state,
                QueuedMessageState.RUNNING,
            )
            removed = {
                row.payload["queued_message_id"]
                for row in self.events.replay(SESSION_ID)
                if row.kind == PRODUCT_EVENT_MESSAGE_REMOVED
            }
            self.assertEqual(removed, {"terminate-waiting", "terminate-queued", "terminate-failed"})
            self.assertEqual(self.adapter.inputs, [])

        asyncio.run(exercise())

    def test_termination_gate_blocks_new_input_and_reopens_only_after_failure_or_cancellation(
        self,
    ) -> None:
        self.live.runtime_session = None
        self.live.runtime_driver = None
        self.live.runtime_binding = RuntimeBinding(
            product_session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            adapter_version="fixture",
            runtime_version="fixture",
            protocol_version="2",
            protocol_schema_hash="fixture",
            opaque_session_ref=self.adapter.session_id,
            capabilities=CapabilitySet(),
        )
        live_sessions = {SESSION_ID: self.live}
        turns = TurnService(live_sessions, self.live._logger, context_source=self.assistant)

        async def exercise() -> None:
            waiting = asyncio.Event()
            release = asyncio.Event()
            mode = "failure"

            async def restore(live):
                self.assertFalse(live.lifecycle_lock.locked())
                self.assertTrue(live.terminating)
                self.assertIs(live.termination_task, asyncio.current_task())
                if mode != "success":
                    waiting.set()
                    await release.wait()
                    raise SessionActivationError(RESOURCE_WAIT_TIMEOUT)
                live.runtime_session = CaptureSession(self.adapter)
                live.runtime_driver = CaptureDriver(self.adapter)

            sessions = SessionService(
                self.live.runtime_workdir,
                live_sessions,
                access=self.catalog,
                events=self.events,
                logger=self.live._logger,
                runtime=SimpleNamespace(
                    cancel_activation=AsyncMock(return_value=False), ensure_active=restore
                ),
                workspaces=SimpleNamespace(),
                artifacts=SimpleNamespace(),
                settings=SimpleNamespace(),
                credentials=SimpleNamespace(),
            )
            sessions.bind_queue_cancellation(turns.cancel_pending_locked)
            for mode in ("failure", "cancelled"):
                waiting.clear()
                release.clear()
                termination = asyncio.create_task(sessions.terminate(SESSION_ID))
                await asyncio.wait_for(waiting.wait(), 1)
                denied, status = await turns.post(
                    SESSION_ID, self.body(0, client_turn_id=f"during-{mode}"), side=False
                )
                self.assertEqual(status, 409, denied)
                self.assertEqual(denied["error"], "session_terminated")
                denied, status = await turns.post(
                    SESSION_ID, {"queued_message_id": "during-termination"}, side=True
                )
                self.assertEqual(status, 409, denied)
                self.assertEqual(denied["error"], "session_terminated")
                if mode == "failure":
                    release.set()
                    result, status = await asyncio.wait_for(termination, 1)
                    self.assertEqual(status, 409, result)
                else:
                    termination.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await termination
                self.assertFalse(self.live.terminating)
                self.assertIsNone(self.live.termination_task)
                self.assertIn(SESSION_ID, live_sessions)
                self.assertEqual(self.catalog.queued_messages(SESSION_ID), ())
            mode = "success"
            response, status = await sessions.terminate(SESSION_ID)
            self.assertEqual(status, 200, response)
            self.assertTrue(self.live.terminated)
            self.assertIsNone(self.live.termination_task)
            self.assertEqual(self.catalog.get(SESSION_ID).status, SessionStatus.CLOSED)
            self.assertNotIn(SESSION_ID, live_sessions)
            closed = [
                row
                for row in self.events.replay(SESSION_ID)
                if row.kind == PRODUCT_EVENT_SESSION_STATE
                and row.payload.get("state") == PRODUCT_SESSION_STATE_CLOSED
            ]
            self.assertEqual(len(closed), 1)
            self.assertEqual(self.adapter.inputs, [])

        asyncio.run(exercise())

    def test_restart_recovery_keeps_queue_uncertainty_authoritative(self) -> None:
        for request_id in ("restart-unconfirmed", "restart-running"):
            self.catalog.enqueue_message(SESSION_ID, request_id, {"text": request_id})
            self.catalog.begin_queued_submission(SESSION_ID, request_id)
        self.catalog.mark_queue_running(SESSION_ID, "restart-running", "restart-native")
        self.catalog.update_status(
            SESSION_ID, SessionStatus.RUNNING, turn_id="restart-native", turn_status="running"
        )
        self.catalog.recover_inflight()
        record = self.catalog.get(SESSION_ID)
        self.live.ledger = SessionLedger(
            SESSION_ID,
            self.catalog,
            self.live.publish,
            self.live._trace,
            self.live._logger,
            self.live._projection_lock,
        )
        sessions = SessionService(
            self.live.runtime_workdir,
            {SESSION_ID: self.live},
            access=self.catalog,
            events=self.events,
            logger=self.live._logger,
            runtime=SimpleNamespace(),
            workspaces=SimpleNamespace(),
            artifacts=SimpleNamespace(),
            settings=SimpleNamespace(),
            credentials=SimpleNamespace(),
        )
        sessions.bind_turn_confirmation(self.turns.confirm_queued_unknown)

        async def exercise() -> None:
            await sessions._publish_recovery(self.live, record, ())
            await sessions._publish_recovery(self.live, record, ())
            after = self.catalog.get(SESSION_ID)
            self.assertEqual(after.status, SessionStatus.ERROR)
            self.assertEqual(after.last_turn_status, PRODUCT_TURN_OUTCOME_UNKNOWN)
            self.assertEqual(after.last_turn_id, "restart-native")
            self.assertTrue(self.live.ledger.has_unknown_outcome)
            terminal_events = [
                row
                for row in self.events.replay(SESSION_ID)
                if row.kind in {PRODUCT_EVENT_TURN_UNKNOWN, PRODUCT_EVENT_TURN_INTERRUPTED}
            ]
            self.assertEqual(len(terminal_events), 2)
            self.assertTrue(all(row.kind == PRODUCT_EVENT_TURN_UNKNOWN for row in terminal_events))
            self.assertEqual(
                {row.vendor_turn_id for row in terminal_events},
                {"restart-native", "restart-unconfirmed"},
            )
            blocked, status = await self.turns.post(SESSION_ID, self.body(0), side=False)
            self.assertEqual(status, 409, blocked)
            self.assertEqual(blocked["error"], "turn_outcome_unconfirmed")
            for turn_id in ("restart-native", "restart-unconfirmed"):
                for _ in range(2):
                    confirmed, status = await sessions.confirm_unknown_turn(
                        SESSION_ID, turn_id, {"decision": TURN_UNKNOWN_CONFIRM_DECISION}
                    )
                    self.assertEqual(status, 200, confirmed)
            self.assertFalse(self.live.ledger.has_unknown_outcome)
            self.assertEqual(self.catalog.queued_messages(SESSION_ID), ())
            self.assertEqual(self.adapter.inputs, [])

        asyncio.run(exercise())

    def test_restart_without_uncertainty_retains_interrupted_projection(self) -> None:
        self.catalog.update_status(
            SESSION_ID, SessionStatus.RUNNING, turn_id="legacy-running", turn_status="running"
        )
        sessions = SessionService(
            self.live.runtime_workdir,
            {SESSION_ID: self.live},
            access=self.catalog,
            events=self.events,
            logger=self.live._logger,
            runtime=SimpleNamespace(),
            workspaces=SimpleNamespace(),
            artifacts=SimpleNamespace(),
            settings=SimpleNamespace(),
            credentials=SimpleNamespace(),
        )
        asyncio.run(sessions._publish_recovery(self.live, self.catalog.get(SESSION_ID), ()))
        self.assertEqual(self.catalog.get(SESSION_ID).last_turn_status, "interrupted")
        self.assertEqual(
            [row.kind for row in self.events.replay(SESSION_ID)], [PRODUCT_EVENT_TURN_INTERRUPTED]
        )

    def test_wait_result_preserves_known_safe_codes_and_hides_unknown_details(self) -> None:
        for error, expected in (
            ("turn_input_invalid", "turn_input_invalid"),
            (RESOURCE_WAIT_TIMEOUT, RESOURCE_WAIT_TIMEOUT),
            ("private upstream detail", "runtime_turn_failed"),
            ("", None),
        ):
            with self.subTest(error=error):
                payload = self.turns._result_payload(
                    TurnResult("request", TurnStatus.FAILED, error=error)
                )
                self.assertEqual(payload["error"], expected)

    def test_explicit_unknown_confirmation_settles_only_its_request_without_replay(self) -> None:
        for request_id in ("confirmed-request", "other-request"):
            self.catalog.enqueue_message(
                SESSION_ID,
                request_id,
                {
                    "input": [{"type": "text", "text": request_id}],
                    "client_user_message_id": request_id,
                },
            )
            self.catalog.begin_queued_submission(SESSION_ID, request_id)
            self.catalog.mark_queue_running(SESSION_ID, request_id, f"native-{request_id}")
            self.catalog.fail_queued_submission(
                SESSION_ID, request_id, unknown=True, safe_error="unknown"
            )
        asyncio.run(self.turns.confirm_queued_unknown(SESSION_ID, "native-confirmed-request"))
        asyncio.run(self.turns.confirm_queued_unknown(SESSION_ID, "native-confirmed-request"))
        self.assertEqual(
            self.catalog.queued_message(SESSION_ID, "confirmed-request").state,
            QueuedMessageState.COMPLETED,
        )
        self.assertEqual(
            self.catalog.queued_message(SESSION_ID, "other-request").state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )
        self.assertEqual(self.adapter.inputs, [])

    def test_completed_request_identity_cannot_submit_again(self) -> None:
        selection = self.select(0)

        async def exercise() -> None:
            body = self.body(selection.revision, client_turn_id="once-only")
            first, first_status = await self.turns.post(SESSION_ID, body, side=False)
            self.assertEqual(first_status, 202)
            self.assertTrue(first["ok"])
            repeated, repeated_status = await self.turns.post(SESSION_ID, body, side=False)
            self.assertEqual(repeated_status, 202)
            self.assertTrue(repeated["ok"])
            self.assertEqual(len(self.adapter.inputs), 1)
            record = self.catalog.queued_message(SESSION_ID, "once-only")
            self.assertEqual(record.state, QueuedMessageState.COMPLETED)
            outcome, _status = await self.turns.reconcile_queued(SESSION_ID, "once-only")
            self.assertEqual(outcome["outcome"], "applied")

        asyncio.run(exercise())

    def test_unknown_turn_does_not_auto_run_queue(self) -> None:
        selection = self.select(0)

        async def exercise() -> None:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            self.adapter.result_outcome = RuntimeTurnOutcome.UNKNOWN
            await self.turns.post(
                SESSION_ID,
                {**self.body(selection.revision, client_turn_id="active-unknown"), "wait": False},
                side=False,
            )
            await self.adapter.started.wait()
            queued, _queued_status = await self.turns.post(
                SESSION_ID,
                {
                    "input": [{"type": "text", "text": "queued-unknown"}],
                    "client_user_message_id": "queued-unknown",
                    "assistant_context_revision": selection.revision,
                },
                side=False,
            )
            self.assertTrue(queued["queued"])
            task = self.live.current_task
            assert task is not None
            self.adapter.release.set()
            await task
            await asyncio.sleep(0.05)
            self.assertEqual(len(self.adapter.inputs), 1)
            self.assertEqual(
                [row.queued_message_id for row in self.catalog.queued_messages(SESSION_ID)],
                ["active-unknown", "queued-unknown"],
            )
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, "active-unknown").state,
                QueuedMessageState.OUTCOME_UNKNOWN,
            )

        asyncio.run(exercise())

    def test_stopped_session_sends_selected_message_then_resumes_fifo(self) -> None:
        selection = self.select(0)

        async def exercise() -> tuple[dict, int]:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            await self.turns.post(
                SESSION_ID,
                {**self.body(selection.revision, client_turn_id="selected-active"), "wait": False},
                side=False,
            )
            await self.adapter.started.wait()
            for queued_id, text in (
                ("selected-q1", "first queued"),
                ("selected-q2", "second queued"),
            ):
                queued, status = await self.turns.post(
                    SESSION_ID,
                    {
                        "input": [{"type": "text", "text": text}],
                        "client_user_message_id": queued_id,
                        "assistant_context_revision": selection.revision,
                    },
                    side=False,
                )
                self.assertEqual(status, 202)
                self.assertTrue(queued["queued"])
            await self.live.interrupt()
            active_task = self.live.current_task
            assert active_task is not None
            self.adapter.release.set()
            await active_task

            self.adapter.started = None
            self.adapter.release = None
            selected, selected_status = await self.turns.send_queued(
                SESSION_ID,
                "selected-q2",
            )
            for _attempt in range(100):
                await asyncio.sleep(0.01)
                if len(self.adapter.inputs) >= 3 and self.live.current_task is None:
                    break
            return selected, selected_status

        selected, status = asyncio.run(exercise())
        self.assertEqual(status, 202)
        self.assertTrue(selected["ok"])
        self.assertEqual(selected["queued_message_id"], "selected-q2")
        self.assertEqual(
            [request.items[-1]["text"] for request in self.adapter.inputs],
            [USER_TEXT, "second queued", "first queued"],
        )
        self.assertEqual(self.catalog.queued_messages(SESSION_ID), ())

    def test_auto_drain_does_not_skip_an_unknown_queue_head(self) -> None:
        self.catalog.enqueue_message(
            SESSION_ID,
            "blocked-head",
            {
                "input": [{"type": "text", "text": "unknown head"}],
                "client_user_message_id": "blocked-head",
            },
        )
        claimed = self.catalog.begin_queued_submission(SESSION_ID, "blocked-head")
        self.assertIsNotNone(claimed)
        self.catalog.fail_queued_submission(
            SESSION_ID,
            "blocked-head",
            unknown=True,
            safe_error="delivery_unknown",
        )
        self.catalog.enqueue_message(
            SESSION_ID,
            "later-message",
            {
                "input": [{"type": "text", "text": "must wait"}],
                "client_user_message_id": "later-message",
            },
        )

        asyncio.run(self.turns._drain_next(self.live))

        self.assertEqual(self.adapter.inputs, [])
        self.assertEqual(
            [row.queued_message_id for row in self.catalog.queued_messages(SESSION_ID)],
            ["blocked-head", "later-message"],
        )

    def test_reconcile_unknown_queue_distinguishes_applied_ambiguous_and_missing(self) -> None:
        async def exercise() -> tuple[dict, dict, dict]:
            for queued_id in ("unknown-applied", "unknown-missed"):
                self.catalog.enqueue_message(
                    SESSION_ID,
                    queued_id,
                    {
                        "input": [{"type": "text", "text": queued_id}],
                        "client_user_message_id": queued_id,
                    },
                )
                claimed = self.catalog.begin_queued_submission(SESSION_ID, queued_id)
                self.assertIsNotNone(claimed)
                if queued_id == "unknown-applied":
                    self.catalog.mark_queue_running(SESSION_ID, queued_id, "confirmed-native-turn")
                    self.catalog.complete_queued_message(SESSION_ID, queued_id)
                else:
                    self.catalog.fail_queued_submission(
                        SESSION_ID,
                        queued_id,
                        unknown=True,
                        safe_error="delivery_unknown",
                    )
            await self.live.record_user_history(
                "",
                references=({"kind": "assistant_context", "label": "回答批注"},),
                turn_id="unknown-missed",
                item_id="unknown-missed",
            )
            applied, _ = await self.turns.reconcile_queued(SESSION_ID, "unknown-applied")
            ambiguous, _ = await self.turns.reconcile_queued(SESSION_ID, "unknown-missed")
            missing, _ = await self.turns.reconcile_queued(SESSION_ID, "never-arrived")
            return applied, ambiguous, missing

        applied, ambiguous, missing = asyncio.run(exercise())

        self.assertEqual(applied["outcome"], "applied")
        self.assertEqual(
            self.catalog.queued_message(SESSION_ID, "unknown-applied").state,
            QueuedMessageState.COMPLETED,
        )
        self.assertEqual(ambiguous["outcome"], "still_unknown")
        retained = self.catalog.queued_message(SESSION_ID, "unknown-missed")
        assert retained is not None
        self.assertEqual(retained.state.value, "outcome_unknown")
        self.assertEqual(missing["outcome"], "not_applied")
        self.assertTrue(missing["queue_missing"])


if __name__ == "__main__":
    unittest.main()
