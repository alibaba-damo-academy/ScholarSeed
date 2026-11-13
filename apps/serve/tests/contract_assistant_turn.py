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
    DeliveryClass,
    RuntimeBinding,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeInventory,
)
from scholarseed_runtime.contract.input import (  # noqa: E402
    InputKind,
    TurnInput,
)
from scholarseed_runtime.contract.history import (  # noqa: E402
    TurnStatus,
)
from scholarseed_runtime.contract.session import RuntimeActivitySnapshot  # noqa: E402
from service.platform.activity import Activities, ActivityDomain, MaintenanceActive  # noqa: E402
from service.assistant.persistence.store import AssistantStore  # noqa: E402
from service.assistant.service.annotations import (  # noqa: E402
    AnswerAnnotationService,
    text_revision,
)
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
    QUEUE_PURPOSE_RECOVERY,
    QueuedMessageState,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
    SubmissionMode,
    UncertaintyKind,
    UncertaintyState,
)
from service.chat.persistence.events import ProductEventStore  # noqa: E402
from service.chat.service.events import EventService  # noqa: E402
from service.chat.service.recovery import RECOVERY_SOURCE  # noqa: E402
from scholarseed_runtime.gateway.driver import RuntimeTurnOutcome, RuntimeTurnResult  # noqa: E402
from scholarseed_runtime.contract.incident import RUNTIME_TURN_NOT_SUBMITTED  # noqa: E402

# SCHOLARSEED_HOME test isolation must precede service imports.
from service.chat.runtime.live import LiveSession  # noqa: E402
from service.chat.runtime.ledger import SessionLedger  # noqa: E402
from service.chat.service.turns import TurnResult, TurnService  # noqa: E402
from service.chat.service.sessions import (  # noqa: E402
    SessionService,
    TURN_UNKNOWN_CONFIRM_DECISION,
)
from service.chat.runtime.activation import SessionActivationError  # noqa: E402
from service.chat.runtime.reconfiguration import (  # noqa: E402
    PREPARATION_DEFAULT_FAILED,
    RECONFIGURATION_STALE,
)
from service.content.domain.model import ContentError, ContentReadPermissionError  # noqa: E402
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
    AssistantAnswer,
    AssistantContextResolution,
    AssistantContextResolvedItem,
    AssistantContextResolveRequest,
    AssistantTurnFinalization,
    ContextLabelFallback,
    ContextOrigin,
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
QUEUE_SETTLEMENT_TIMEOUT_SECONDS = 5


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
    projection_failed = False

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
    capabilities = CapabilitySet()

    def __init__(self, adapter: CaptureAdapter) -> None:
        self.adapter = adapter

    async def activity(self) -> RuntimeActivitySnapshot:
        return RuntimeActivitySnapshot("fixture", 0, 0, True)

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
    def test_stop_inspects_native_activity_after_product_turn_has_ended(self) -> None:
        async def scenario() -> None:
            self.assertFalse(self.live.running)
            sessions = self.session_service()
            sessions._runtime = SimpleNamespace(runtime_id=RUNTIME_ID)
            activity = RuntimeActivitySnapshot("fixture", 0, 0, True, ("native_turn_active",))
            with (
                patch.object(
                    self.live.runtime_session, "activity", new=AsyncMock(return_value=activity)
                ),
                patch.object(self.live, "interrupt", new=AsyncMock()) as interrupt,
            ):
                result = await sessions.interrupt(SESSION_ID)
            self.assertTrue(result["ok"])
            self.assertFalse(result["idle"])
            interrupt.assert_awaited_once_with(cleanup_background_processes=True)

        asyncio.run(scenario())

    def test_projection_recovery_requires_readable_storage(self) -> None:
        async def scenario() -> None:
            previous = self.live.runtime_driver
            driver = SimpleNamespace(
                projection_failed=True, recover_projection=AsyncMock(return_value=1)
            )
            self.live.runtime_driver = driver
            error = OSError("persistent storage fault")
            self.live._publication_error = error
            try:
                with patch.object(self.live.persistence, "run", new=AsyncMock(side_effect=error)):
                    with self.assertRaises(OSError):
                        await self.live.recover_runtime_projection()
                driver.recover_projection.assert_not_awaited()
                self.assertIs(self.live._publication_error, error)
                await self.live.recover_runtime_projection()
                driver.recover_projection.assert_awaited_once()
                self.assertIsNone(self.live._publication_error)
            finally:
                self.live.runtime_driver = previous

        asyncio.run(scenario())

    def test_continuation_restores_only_original_turn_skill(self) -> None:
        self.turns._events = self.events
        skill_path = self.live.runtime_workdir / "SKILL.md"
        skill_path.write_text("skill", encoding="utf-8")
        reference = {"type": "skill", "id": "research", "path": str(skill_path), "status": "1"}
        for index, origin in enumerate(("turn", "steer")):
            self.events.append(
                session_id=SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=self.adapter.session_id,
                vendor_turn_id="original",
                vendor_item_id=None,
                kind=PRODUCT_EVENT_USER_MESSAGE,
                payload={
                    "origin": origin,
                    "binding": "bound",
                    "refs": [reference if origin == "turn" else {**reference, "id": "other"}],
                },
                idempotency_key=f"binding-{index}",
            )
        body = {"continue_turn_id": "original", "input": [{"type": "text", "text": "continue"}]}
        restored = self.turns._continuation_input(self.live, body)
        self.assertEqual(
            restored["input"][-1],
            {"type": "skill", "name": "research", "path": str(skill_path), "version": "1"},
        )
        self.assertEqual(len(body["input"]), 1)
        unknown = {**body, "continue_turn_id": "unrelated"}
        self.assertEqual(self.turns._continuation_input(self.live, unknown), unknown)
        with patch.object(
            self.live, "skill_identity", new=AsyncMock(return_value={"version": "2"})
        ):
            with self.assertRaisesRegex(ValueError, "version"):
                asyncio.run(self.turns._typed_input(self.live, restored))

    def test_continuation_ignores_cancelled_ambiguous_and_foreign_skill_records(self) -> None:
        self.turns._events = self.events
        reference = {"type": "skill", "id": "research", "path": "/skill/SKILL.md", "status": "1"}
        for name, binding, references in (
            ("cancelled", "cancelled", [reference]),
            ("ambiguous", "bound", [reference, reference]),
            ("unversioned", "bound", [{**reference, "status": ""}]),
            ("valid", "admitted", [reference]),
        ):
            self.events.append(
                session_id=SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=self.adapter.session_id,
                vendor_turn_id=name,
                vendor_item_id=None,
                kind=PRODUCT_EVENT_USER_MESSAGE,
                payload={"origin": "turn", "binding": binding, "refs": references},
                idempotency_key=f"binding-{name}",
            )
            body = {"continue_turn_id": name, "input": [{"type": "text", "text": "continue"}]}
            restored = self.turns._continuation_input(self.live, body)
            self.assertEqual(len(restored["input"]), 2 if name == "valid" else 1)
        self.assertIsNone(self.events.original_user_message_for_turn("another-session", "valid"))

    def test_continuation_admission_persists_inherited_skill_for_next_recovery(self) -> None:
        self.turns._events = self.events
        selection = self.select(0)
        skill_path = self.live.runtime_workdir / "SKILL.md"
        skill_path.write_text("skill", encoding="utf-8")
        reference = {"type": "skill", "id": "research", "path": str(skill_path), "status": "1"}
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=self.adapter.session_id,
            vendor_turn_id="original",
            vendor_item_id=None,
            kind=PRODUCT_EVENT_USER_MESSAGE,
            payload={"origin": "turn", "binding": "bound", "refs": [reference]},
            idempotency_key="binding-original",
        )
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=self.adapter.session_id,
            vendor_turn_id="original",
            vendor_item_id=None,
            kind=PRODUCT_EVENT_TURN_FAILED,
            payload={"retryable": True},
            idempotency_key="binding-failed",
        )

        async def scenario() -> None:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            with patch.object(
                self.live, "skill_identity", new=AsyncMock(return_value={"version": "1"})
            ):
                result, status = await self.turns.post(
                    SESSION_ID,
                    {
                        **self.body(selection.revision),
                        "continue_turn_id": "original",
                        "wait": False,
                    },
                    side=False,
                )
                self.assertEqual(status, 202, result)
                await self.adapter.started.wait()
                try:
                    recovery_text = "\n".join(
                        item.get("text", "") for item in self.adapter.inputs[0].items
                    )
                    self.assertIn("Continuation is not an answer or approval", recovery_text)
                    self.assertIn("Reissue any unanswered interaction", recovery_text)
                    binding = self.live.active_skill_presentation
                    self.assertIsNotNone(binding)
                    self.assertEqual(binding.skill_name, "research")
                    self.assertEqual(binding.turn_id, CLIENT_TURN)
                    record = self.events.original_user_message_for_turn(SESSION_ID, CLIENT_TURN)
                    self.assertIsNotNone(record)
                    self.assertEqual(record.payload["refs"][0]["id"], "research")
                    restored = self.turns._continuation_input(
                        self.live,
                        {
                            "continue_turn_id": CLIENT_TURN,
                            "input": [{"type": "text", "text": "continue"}],
                        },
                    )
                    self.assertEqual(restored["input"][-1]["name"], "research")
                finally:
                    self.adapter.release.set()
                    await self.live.current_task

        asyncio.run(scenario())

    def crash_context(self):
        assistant = AssistantService(
            self.store,
            project_for_session=lambda _session_id: "project-contract",
            providers={ContextRefKind.FILE: ReadyProvider()},
        )
        selected = assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(
                ContextRef(
                    ref_id="crash-ref",
                    kind=ContextRefKind.FILE,
                    source_id="crash.md",
                    label="crash.md",
                    retention=ContextRetention.NEXT_TURN,
                ),
            ),
        )
        result = assistant.freeze_queued(
            session_id=SESSION_ID,
            client_turn_id=CLIENT_TURN,
            expected_revision=selected.revision,
            question=USER_TEXT,
        )
        self.assertIsNone(result.failure)
        assistant.finalize(
            session_id=SESSION_ID,
            client_turn_id=CLIENT_TURN,
            outcome=AssistantTurnFinalization.UNKNOWN,
        )
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=assistant,
            activities=Activities(),
            catalog=self.catalog,
            events=self.events,
        )
        return turns, result.context

    def test_crash_retry_preserves_frozen_once_only_context_and_settles_original_claim(self):
        turns, original = self.crash_context()
        source = {"client_id": CLIENT_TURN, "question": USER_TEXT}
        body = {
            **self.body(original.snapshot.selection_revision, client_turn_id="crash-successor"),
            "assistant_snapshot_id": original.snapshot.snapshot_id,
            RECOVERY_SOURCE: source,
        }
        admission = SimpleNamespace(
            turn_input=SimpleNamespace(client_user_message_id="crash-successor"),
            display_text=USER_TEXT,
        )
        queued = turns._freeze_queued_context(self.live, body, admission, recovery=source)
        resumed = turns._freeze_context(self.live, body, admission, recovery=source)
        self.assertEqual(queued.snapshot, original.snapshot)
        self.assertEqual(resumed.model_context, original.model_context)
        self.assertTrue(queued.snapshot.items)
        self.catalog.enqueue_message(
            SESSION_ID, "crash-successor", body, purpose=QUEUE_PURPOSE_RECOVERY
        )
        turns._finalize_context(SESSION_ID, "crash-successor", AssistantTurnFinalization.ACCEPTED)
        self.assertEqual(self.store.selection(SESSION_ID).refs, ())

    def test_completed_crash_recovery_consumes_original_context_claim(self):
        turns, _original = self.crash_context()
        turns._complete_recovered_context(self.live, CLIENT_TURN)
        self.assertEqual(self.store.selection(SESSION_ID).refs, ())

    def test_not_submitted_settlement_retains_failed_queue_without_auto_send(self) -> None:
        async def scenario() -> None:
            self.catalog.enqueue_message(SESSION_ID, CLIENT_TURN, self.body(0))
            self.catalog.begin_queued_submission(SESSION_ID, CLIENT_TURN)
            await self.turns._settle_queued_outcome(
                self.live, CLIENT_TURN, RuntimeTurnOutcome.FAILED, RUNTIME_TURN_NOT_SUBMITTED
            )
            row = self.catalog.queued_message(SESSION_ID, CLIENT_TURN)
            self.assertEqual(row.state, QueuedMessageState.FAILED)
            self.assertEqual(row.safe_error, RUNTIME_TURN_NOT_SUBMITTED)
            self.assertFalse(self.live.ledger.has_unknown_outcome)
            await self.turns._drain_next(self.live)
            self.assertEqual(self.adapter.inputs, [])
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, CLIENT_TURN).state,
                QueuedMessageState.FAILED,
            )
            self.assertIsNone(self.turns._schedule_locked(self.live, CLIENT_TURN))

        asyncio.run(scenario())

    def test_not_submitted_code_cannot_override_an_unknown_outcome(self) -> None:
        async def scenario() -> None:
            self.catalog.enqueue_message(SESSION_ID, CLIENT_TURN, self.body(0))
            self.catalog.begin_queued_submission(SESSION_ID, CLIENT_TURN)
            await self.turns._settle_queued_outcome(
                self.live, CLIENT_TURN, RuntimeTurnOutcome.UNKNOWN, RUNTIME_TURN_NOT_SUBMITTED
            )
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, CLIENT_TURN).state,
                QueuedMessageState.OUTCOME_UNKNOWN,
            )
            await self.turns._drain_next(self.live)
            self.assertEqual(self.adapter.inputs, [])

        asyncio.run(scenario())

    def test_recover_persisted_not_submitted_settlement_without_resending(self) -> None:
        async def scenario() -> None:
            self.catalog.enqueue_message(SESSION_ID, CLIENT_TURN, self.body(0))
            self.catalog.begin_queued_submission(SESSION_ID, CLIENT_TURN)
            event = RuntimeEvent(
                schema_version=1,
                event_id="not-submitted:settlement",
                runtime_id=RUNTIME_ID,
                product_session_id=SESSION_ID,
                native_session_id=self.adapter.session_id,
                process_generation=1,
                sequence=1,
                kind=RuntimeEventKind.TURN_FAILED,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at="2026-10-29T00:00:00Z",
                correlation_id=CLIENT_TURN,
                native_turn_id=CLIENT_TURN,
                payload={
                    "safe_error": RUNTIME_TURN_NOT_SUBMITTED,
                    "error_code": RUNTIME_TURN_NOT_SUBMITTED,
                },
            )
            self.catalog.record_turn_settlement(SESSION_ID, CLIENT_TURN, event)
            self.catalog.recover_inflight()
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, CLIENT_TURN).state,
                QueuedMessageState.FAILED,
            )
            with patch.object(
                self.live.runtime_session,
                "activity",
                new=AsyncMock(
                    return_value=RuntimeActivitySnapshot(
                        "fixture",
                        0,
                        0,
                        True,
                        execution_tree_complete=True,
                    )
                ),
            ):
                await asyncio.wait_for(self.turns._recover_settlement(self.live), 2)
            self.assertIsNone(self.catalog.pending_turn_settlement(SESSION_ID))
            row = self.catalog.queued_message(SESSION_ID, CLIENT_TURN)
            self.assertEqual(row.state, QueuedMessageState.FAILED)
            self.assertEqual(row.safe_error, RUNTIME_TURN_NOT_SUBMITTED)
            self.assertEqual(self.adapter.inputs, [])
            self.assertFalse(self.live.ledger.has_unknown_outcome)

        asyncio.run(scenario())

    def test_restart_negative_proof_cannot_downgrade_positive_or_historical_evidence(self) -> None:
        for mode in (
            "running",
            "unknown",
            "uncertain",
            "wrong_correlation",
            "unknown_terminal",
            "no_proof",
        ):
            with self.subTest(mode=mode):
                request_id = f"negative-proof-{mode}"
                self.catalog.enqueue_message(SESSION_ID, request_id, self.body(0))
                self.catalog.begin_queued_submission(SESSION_ID, request_id)
                event = RuntimeEvent(
                    schema_version=1,
                    event_id=f"proof:{mode}",
                    runtime_id=RUNTIME_ID,
                    product_session_id=SESSION_ID,
                    native_session_id=self.adapter.session_id,
                    native_turn_id=request_id,
                    process_generation=1,
                    sequence=1,
                    kind=(
                        RuntimeEventKind.TURN_UNKNOWN
                        if mode == "unknown_terminal"
                        else RuntimeEventKind.TURN_FAILED
                    ),
                    delivery=DeliveryClass.MUST_PERSIST,
                    observed_at="2026-10-29T00:00:00Z",
                    correlation_id="another-command" if mode == "wrong_correlation" else request_id,
                    payload={
                        "safe_error": RUNTIME_TURN_NOT_SUBMITTED,
                        "error_code": RUNTIME_TURN_NOT_SUBMITTED,
                    },
                )
                if mode != "no_proof":
                    self.catalog.record_turn_settlement(SESSION_ID, request_id, event)
                if mode == "running":
                    self.catalog.mark_queue_running(SESSION_ID, request_id, "actual-native-turn")
                elif mode == "unknown":
                    self.catalog.fail_queued_submission(
                        SESSION_ID, request_id, unknown=True, safe_error="old-unknown"
                    )
                elif mode == "uncertain":
                    asyncio.run(
                        self.live.ledger.record_unknown_submission(
                            request_id, safe_error="old-unknown"
                        )
                    )
                self.catalog.recover_inflight()
                self.assertEqual(
                    self.catalog.queued_message(SESSION_ID, request_id).state,
                    QueuedMessageState.OUTCOME_UNKNOWN,
                )
                if mode != "no_proof":
                    self.catalog.clear_turn_settlement(SESSION_ID, request_id)

    def test_live_not_submitted_result_does_not_complete_the_queue(self) -> None:
        async def scenario() -> None:
            failed = RuntimeTurnResult(
                command_id=CLIENT_TURN,
                native_turn_id="",
                outcome=RuntimeTurnOutcome.FAILED,
                safe_error=RUNTIME_TURN_NOT_SUBMITTED,
            )
            with patch.object(
                self.live.runtime_driver, "submit", new=AsyncMock(return_value=failed)
            ) as submit:
                payload, status = await self.turns.post(SESSION_ID, self.body(0), side=False)
                self.assertEqual(status, 202, payload)
                await self.turns._drain_next(self.live)
                self.assertEqual(submit.await_count, 1)
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, CLIENT_TURN).state,
                QueuedMessageState.FAILED,
            )
            self.assertFalse(self.live.ledger.has_unknown_outcome)

        asyncio.run(scenario())

    def test_continuation_preparation_failure_preserves_pending_work_and_safe_diagnostics(
        self,
    ) -> None:
        async def scenario() -> None:
            await self.live.ledger.record_unknown_submission(
                "interrupted-turn", safe_error="process_exit"
            )
            self.live.runtime_session = None
            cases = (
                (ValueError("private-token /private/project"), PREPARATION_DEFAULT_FAILED),
                (RuntimeError("private-token /private/project"), PREPARATION_DEFAULT_FAILED),
                (SessionActivationError(RESOURCE_WAIT_TIMEOUT), RESOURCE_WAIT_TIMEOUT),
            )
            for failure, expected in cases:
                with self.subTest(failure=type(failure).__name__):
                    logger = Mock()
                    self.turns._logger = logger
                    self.turns._prepare = AsyncMock(side_effect=failure)
                    payload, status = await self.turns.post(
                        SESSION_ID,
                        {**self.body(0), "continue_turn_id": "interrupted-turn"},
                        side=False,
                    )
                    self.assertEqual(status, 409)
                    self.assertEqual(
                        payload,
                        {"ok": False, "error": expected, "preparation_error": True},
                    )
                    self.assertIsNone(self.catalog.queued_message(SESSION_ID, CLIENT_TURN))
                    self.assertTrue(self.live.ledger.has_unknown_outcome)
                    self.assertFalse(self.live.lifecycle_lock.locked())
                    self.assertEqual(self.adapter.inputs, [])
                    logger.error.assert_called_once()
                    self.assertNotIn("private-token", repr(logger.mock_calls))
                    self.assertNotIn("/private/project", repr(logger.mock_calls))

        asyncio.run(scenario())

    def test_cancelled_continuation_preparation_does_not_become_a_retryable_refusal(self) -> None:
        async def scenario() -> None:
            self.live.runtime_session = None
            self.turns._prepare = AsyncMock(side_effect=asyncio.CancelledError())
            with self.assertRaises(asyncio.CancelledError):
                await self.turns.post(
                    SESSION_ID,
                    {**self.body(0), "continue_turn_id": "interrupted-turn"},
                    side=False,
                )
            self.assertIsNone(self.catalog.queued_message(SESSION_ID, CLIENT_TURN))
            self.assertEqual(self.adapter.inputs, [])

        asyncio.run(scenario())

    def test_unknown_turn_continue_checks_activity_and_starts_new_message_once(self) -> None:
        self.turns._events = self.events

        async def scenario() -> None:
            self.catalog.enqueue_message(
                SESSION_ID, "interrupted-turn", {"text": "original request"}
            )
            self.catalog.begin_queued_submission(SESSION_ID, "interrupted-turn")
            self.catalog.fail_queued_submission(
                SESSION_ID, "interrupted-turn", unknown=True, safe_error="process_exit"
            )
            await self.live.ledger.record_unknown_submission(
                "interrupted-turn", safe_error="process_exit"
            )
            self.events.append(
                session_id=SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=self.adapter.session_id,
                vendor_turn_id="interrupted-turn",
                vendor_item_id=None,
                kind=PRODUCT_EVENT_TURN_UNKNOWN,
                payload={},
                idempotency_key="interrupted-origin",
            )
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            body = {**self.body(0), "continue_turn_id": "interrupted-turn", "wait": False}
            for activity in (
                RuntimeActivitySnapshot("fixture", 0, 0, False),
                RuntimeActivitySnapshot(
                    "fixture", 0, 0, True, ("native_background_terminal_active",)
                ),
            ):
                with patch.object(
                    self.live.runtime_session, "activity", new=AsyncMock(return_value=activity)
                ):
                    payload, status = await self.turns.post(SESSION_ID, body, side=False)
                self.assertEqual(status, 409, payload)
                self.assertTrue(self.live.ledger.has_unknown_outcome)
                self.assertIsNone(self.catalog.queued_message(SESSION_ID, CLIENT_TURN))
            with patch.object(
                self.live.runtime_session,
                "activity",
                new=AsyncMock(side_effect=RuntimeError("offline")),
            ):
                payload, status = await self.turns.post(SESSION_ID, body, side=False)
            self.assertEqual(
                (payload["error"], status), ("previous_turn_activity_unavailable", 409)
            )
            payload, status = await self.turns.post(
                SESSION_ID, {"continue_turn_id": "interrupted-turn"}, side=False
            )
            self.assertEqual(status, 400, payload)
            self.assertTrue(self.live.ledger.has_unknown_outcome)
            retained_session = self.live.runtime_session
            self.live.runtime_session = None

            async def prepare_recovery(live, *, request_id, deadline, on_wait):
                self.assertFalse(live.lifecycle_lock.locked())
                live.runtime_session = retained_session

            self.turns._prepare = prepare_recovery
            with patch.object(
                self.turns,
                "_confirm_queued_unknown_locked",
                new=AsyncMock(side_effect=RuntimeError("store busy")),
            ):
                with self.assertRaisesRegex(RuntimeError, "store busy"):
                    await self.turns.post(SESSION_ID, body, side=False)
            self.assertTrue(self.live.ledger.has_unknown_outcome)
            self.assertIsNotNone(self.catalog.queued_message(SESSION_ID, CLIENT_TURN))
            payload, status = await self.turns.post(SESSION_ID, body, side=False)
            self.assertEqual(status, 202, payload)
            self.assertFalse(self.live.ledger.has_unknown_outcome)
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, "interrupted-turn").state,
                QueuedMessageState.COMPLETED,
            )
            duplicate, status = await self.turns.post(
                SESSION_ID, {**body, "client_user_message_id": "duplicate"}, side=False
            )
            self.assertEqual(status, 409, duplicate)
            await self.adapter.started.wait()
            repeated, status = await self.turns.post(SESSION_ID, body, side=False)
            self.assertEqual(status, 202, repeated)
            self.assertEqual(len(self.adapter.inputs), 1)
            self.assertIn("Do not blindly replay", self.adapter.inputs[0].items[0]["text"])
            task = self.live.current_task
            self.adapter.release.set()
            await task

        asyncio.run(scenario())

    def test_maintenance_rejects_new_turn_before_enqueue(self) -> None:
        self.activities.begin()
        with self.assertRaises(MaintenanceActive):
            asyncio.run(self.turns.post(SESSION_ID, self.body(0), side=False))
        self.assertFalse(self.catalog.queued_messages(SESSION_ID))
        self.assertEqual(self.adapter.inputs, [])

    def test_expected_model_is_rechecked_inside_lifecycle_before_first_enqueue(self) -> None:
        async def scenario() -> None:
            await self.live.lifecycle_lock.acquire()
            pending = asyncio.create_task(
                self.turns.post(
                    SESSION_ID,
                    self.body(0),
                    side=False,
                    expected_model_id="contract-model",
                    prepared_activity=True,
                )
            )
            try:
                await asyncio.sleep(0)
                self.assertFalse(pending.done())
                self.catalog.set_model(SESSION_ID, OWNER, "replacement-model")
            finally:
                self.live.lifecycle_lock.release()
            payload, status = await asyncio.wait_for(pending, QUEUE_SETTLEMENT_TIMEOUT_SECONDS)
            self.assertEqual(status, 409, payload)
            self.assertEqual(payload["error"], RECONFIGURATION_STALE)
            self.assertIs(payload["preparation_error"], True)
            self.assertFalse(self.catalog.queued_messages(SESSION_ID))
            self.assertIsNone(self.catalog.queued_message(SESSION_ID, CLIENT_TURN))
            self.assertEqual(self.adapter.inputs, [])
            self.assertIsNone(self.live.current_task)
            self.assertIsNone(self.live.resource_task)
            self.assertEqual(self.activities.snapshot().counts, {})

        asyncio.run(scenario())

    def test_prepared_turn_continues_its_owned_parent_during_drain_without_new_root(self) -> None:
        async def scenario() -> None:
            with self.activities.enter(ActivityDomain.TURN, root=True):
                generation = self.activities.begin()
                with self.assertRaises(MaintenanceActive):
                    await self.turns.post(SESSION_ID, self.body(0), side=False)
                self.assertFalse(self.catalog.queued_messages(SESSION_ID))
                payload, status = await self.turns.post(
                    SESSION_ID,
                    self.body(0),
                    side=False,
                    expected_model_id="contract-model",
                    prepared_activity=True,
                )
                self.assertEqual(status, 202, payload)
                self.assertTrue(payload["ok"])
                self.assertEqual(len(self.adapter.inputs), 1)
                self.assertEqual(
                    self.catalog.queued_message(SESSION_ID, CLIENT_TURN).state,
                    QueuedMessageState.COMPLETED,
                )
                await self.turns.aclose()
                self.assertFalse(self.activities.seal(generation))
            self.assertTrue(self.activities.seal(generation))
            self.activities.resume(generation)
            self.assertEqual(self.activities.snapshot().counts, {})

        asyncio.run(scenario())

    def test_prepared_flag_without_owned_parent_does_not_bypass_drain(self) -> None:
        async def scenario() -> None:
            generation = self.activities.begin()
            with self.assertRaises(MaintenanceActive):
                await self.turns.post(
                    SESSION_ID,
                    self.body(0),
                    side=False,
                    expected_model_id="contract-model",
                    prepared_activity=True,
                )
            self.assertFalse(self.catalog.queued_messages(SESSION_ID))
            self.assertEqual(self.adapter.inputs, [])
            self.assertTrue(self.activities.seal(generation))
            self.activities.resume(generation)

        asyncio.run(scenario())

    def test_prepared_duplicate_preserves_failed_or_unknown_submission_without_replay(self) -> None:
        async def scenario() -> None:
            for unknown in (False, True):
                with self.subTest(unknown=unknown):
                    identity = "prepared-unknown" if unknown else "prepared-failed"
                    body = self.body(0, client_turn_id=identity)
                    queued, status = await self.turns._enqueue(
                        self.live, body, submission_mode=SubmissionMode.DIRECT
                    )
                    self.assertEqual(status, 202, queued)
                    self.catalog.begin_queued_submission(SESSION_ID, identity)
                    self.catalog.fail_queued_submission(
                        SESSION_ID, identity, unknown=unknown, safe_error="preserved-failure"
                    )
                    before = self.catalog.queued_message(SESSION_ID, identity)
                    expected = (
                        QueuedMessageState.OUTCOME_UNKNOWN if unknown else QueuedMessageState.FAILED
                    )
                    self.assertIs(before.state, expected)
                    with self.activities.enter(ActivityDomain.TURN, root=True):
                        payload, status = await self.turns.post(
                            SESSION_ID,
                            body,
                            side=False,
                            expected_model_id="contract-model",
                            prepared_activity=True,
                        )
                    self.assertIn(status, (202, 409), payload)
                    await asyncio.sleep(0)
                    self.assertEqual(self.catalog.queued_message(SESSION_ID, identity), before)
                    self.assertEqual(self.adapter.inputs, [])
                    self.assertIsNone(self.live.current_task)
                    self.assertIsNone(self.live.resource_task)
            self.assertEqual(self.activities.snapshot().counts, {})

        asyncio.run(scenario())

    def test_maintenance_pauses_queue_and_control_delete_returns(self) -> None:
        async def scenario() -> None:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            self.catalog.enqueue_message(
                SESSION_ID, "remove", self.body(0, client_turn_id="remove")
            )
            self.catalog.enqueue_message(SESSION_ID, CLIENT_TURN, self.body(0))
            generation = self.activities.begin()
            payload, status = await asyncio.wait_for(
                self.turns.delete_queued(SESSION_ID, "remove"), timeout=2
            )
            self.assertEqual(status, 200, payload)
            self.assertEqual(self.adapter.inputs, [])
            self.assertEqual(len(self.catalog.queued_messages(SESSION_ID)), 1)
            self.assertTrue(self.activities.seal(generation))
            self.activities.resume(generation)
            try:
                await asyncio.wait_for(self.adapter.started.wait(), timeout=2)
                self.assertEqual(len(self.adapter.inputs), 1)
            finally:
                self.adapter.release.set()
                if self.live.current_task is not None:
                    await self.live.current_task
                if self.live.resource_task is not None:
                    await self.live.resource_task
                await self.turns.aclose()
            # The queued preparation awaits the execution through shield; its
            # finally runs on a later loop turn even after current_task completes.
            async with asyncio.timeout(2):
                while self.activities.snapshot().counts:
                    await asyncio.sleep(0)
            self.assertEqual(self.activities.snapshot().counts, {})

        asyncio.run(scenario())

    def test_completed_turn_with_pending_hil_rejects_before_enqueue(self) -> None:
        self.live.active_product_turn_id = "previous-turn"
        with patch.object(
            self.live, "pending_hil_snapshot", return_value=[{"request_id": "hil-1"}]
        ):
            payload, status = asyncio.run(self.turns.post(SESSION_ID, self.body(0), side=False))
        self.assertEqual((payload["error"], status), ("previous_turn_pending_hil", 409))
        self.assertIsNone(self.catalog.queued_message(SESSION_ID, CLIENT_TURN))

    def test_completed_turn_with_background_activity_rejects_before_enqueue(self) -> None:
        self.live.active_product_turn_id = "previous-turn"
        activity = SimpleNamespace(idle=False, blockers=("native_background_terminal_active",))
        with patch.object(
            self.live.runtime_session, "activity", new=AsyncMock(return_value=activity)
        ):
            payload, status = asyncio.run(self.turns.post(SESSION_ID, self.body(0), side=False))
        self.assertEqual((payload["error"], status), ("previous_turn_background_active", 409))
        self.assertIsNone(self.catalog.queued_message(SESSION_ID, CLIENT_TURN))

    def test_pending_settlement_admission_distinguishes_known_outcomes(self) -> None:
        async def scenario() -> None:
            nativeTurnId = "previous-native-turn"
            self.live.active_product_turn_id = "previous-client-turn"
            await self.live.ledger.activate_turn(nativeTurnId)
            self.catalog.enqueue_message(SESSION_ID, "queued-next", self.body(0))
            background = RuntimeActivitySnapshot(
                "fixture",
                0,
                0,
                True,
                execution_tree_complete=True,
                execution_tree_blockers=("native_background_terminal_active",),
            )
            idle = RuntimeActivitySnapshot("fixture", 0, 0, True, execution_tree_complete=True)
            cases = (
                (background, [], "previous_turn_background_active"),
                (background, [{"request_id": "hil"}], "previous_turn_pending_hil"),
                (
                    RuntimeActivitySnapshot("fixture", 0, 0, False),
                    [],
                    "previous_turn_activity_unavailable",
                ),
                (RuntimeError("activity unavailable"), [], "previous_turn_activity_unavailable"),
                (None, [], "previous_turn_activity_unavailable"),
                (idle, [], "previous_turn_settling"),
            )
            for eventKind in (
                RuntimeEventKind.TURN_COMPLETED,
                RuntimeEventKind.TURN_FAILED,
                RuntimeEventKind.TURN_INTERRUPTED,
                RuntimeEventKind.TURN_UNKNOWN,
            ):
                event = RuntimeEvent(
                    schema_version=1,
                    event_id=f"pending:{eventKind.value}",
                    runtime_id=RUNTIME_ID,
                    product_session_id=SESSION_ID,
                    native_session_id=self.adapter.session_id,
                    process_generation=1,
                    sequence=1,
                    kind=eventKind,
                    delivery=DeliveryClass.MUST_PERSIST,
                    observed_at="fixture",
                    native_turn_id=nativeTurnId,
                )
                self.catalog.record_turn_settlement(SESSION_ID, "previous-client-turn", event)
                self.catalog.mark_turn_recovery_blocked(SESSION_ID, True)
                for activity, pendingHil, expectedError in cases:
                    expected = (
                        "turn_outcome_unconfirmed"
                        if eventKind is RuntimeEventKind.TURN_UNKNOWN
                        else expectedError
                    )
                    runtimeSession = self.live.runtime_session
                    if activity is None:
                        self.live.runtime_session = None
                    query = AsyncMock(
                        side_effect=activity if isinstance(activity, Exception) else None,
                        return_value=activity,
                    )
                    try:
                        with (
                            patch.object(runtimeSession, "activity", new=query),
                            patch.object(
                                self.live, "pending_hil_snapshot", return_value=pendingHil
                            ),
                        ):
                            for action in ("post", "send_queued", "steer"):
                                with self.subTest(kind=eventKind, activity=activity, action=action):
                                    if action == "send_queued":
                                        payload, status = await self.turns.send_queued(
                                            SESSION_ID, "queued-next"
                                        )
                                    else:
                                        payload, status = await self.turns.post(
                                            SESSION_ID,
                                            {**self.body(0), "queued_message_id": "queued-next"},
                                            side=action == "steer",
                                        )
                                    self.assertEqual((payload["error"], status), (expected, 409))
                                    self.assertIsNone(
                                        self.catalog.queued_message(SESSION_ID, CLIENT_TURN)
                                    )
                                    self.assertEqual(
                                        self.catalog.queued_message(
                                            SESSION_ID, "queued-next"
                                        ).state,
                                        QueuedMessageState.QUEUED,
                                    )
                                    self.assertEqual(self.adapter.inputs, [])
                                    self.assertIsNotNone(
                                        self.catalog.pending_turn_settlement(SESSION_ID)
                                    )
                    finally:
                        self.live.runtime_session = runtimeSession
                self.catalog.clear_turn_settlement(SESSION_ID, nativeTurnId)

        asyncio.run(scenario())

    def test_online_pending_unknown_rejects_queue_admission(self) -> None:
        event = RuntimeEvent(
            schema_version=1,
            event_id="pending:unknown",
            runtime_id=RUNTIME_ID,
            product_session_id=SESSION_ID,
            native_session_id=self.adapter.session_id,
            process_generation=1,
            sequence=1,
            kind=RuntimeEventKind.TURN_UNKNOWN,
            delivery=DeliveryClass.MUST_PERSIST,
            observed_at="fixture",
            native_turn_id="unknown-native-turn",
        )
        self.live.active_product_turn_id = "unknown-client-turn"
        asyncio.run(self.live.ledger.activate_turn(event.native_turn_id))
        self.catalog.record_turn_settlement(SESSION_ID, "unknown-client-turn", event)
        payload, status = asyncio.run(self.turns.post(SESSION_ID, self.body(0), side=False))
        self.assertEqual((payload["error"], status), ("turn_outcome_unconfirmed", 409))
        self.assertIsNone(self.catalog.queued_message(SESSION_ID, CLIENT_TURN))

    def test_completed_turn_with_unavailable_activity_rejects_before_enqueue(self) -> None:
        self.live.active_product_turn_id = "previous-turn"
        with patch.object(
            self.live.runtime_session,
            "activity",
            new=AsyncMock(side_effect=RuntimeError("unavailable")),
        ):
            payload, status = asyncio.run(self.turns.post(SESSION_ID, self.body(0), side=False))
        self.assertEqual((payload["error"], status), ("previous_turn_activity_unavailable", 409))
        self.assertIsNone(self.catalog.queued_message(SESSION_ID, CLIENT_TURN))

    def test_completed_turn_with_idle_runtime_admits_next_turn(self) -> None:
        self.live.active_product_turn_id = "previous-turn"
        payload, status = asyncio.run(self.turns.post(SESSION_ID, self.body(0), side=False))
        self.assertEqual(status, 202, payload)
        self.assertTrue(payload["accepted"])

    def test_running_turn_still_accepts_next_message_into_queue(self) -> None:
        async def scenario() -> None:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            first, status = await self.turns.post(
                SESSION_ID, {**self.body(0), "wait": False}, side=False
            )
            self.assertEqual(status, 202, first)
            await self.adapter.started.wait()
            with patch.object(
                self.live, "pending_hil_snapshot", return_value=[{"request_id": "hil-1"}]
            ):
                second, status = await self.turns.post(
                    SESSION_ID,
                    {**self.body(0, client_turn_id="next-turn"), "wait": False},
                    side=False,
                )
            self.assertEqual(status, 202, second)
            self.assertEqual(second["disposition"], "queued")
            self.adapter.release.set()
            if self.live.current_task is not None:
                await self.live.current_task

        asyncio.run(scenario())

    def test_queued_turn_rejects_retained_activity_before_native_submission(self) -> None:
        async def scenario() -> None:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            first, status = await self.turns.post(
                SESSION_ID, {**self.body(0), "wait": False}, side=False
            )
            self.assertEqual(status, 202, first)
            await self.adapter.started.wait()
            second, status = await self.turns.post(
                SESSION_ID,
                {**self.body(0, client_turn_id="queued-next-turn"), "wait": False},
                side=False,
            )
            self.assertEqual(status, 202, second)
            blocked = RuntimeActivitySnapshot(
                "fixture", 1, 1, False, ("native_background_terminal_active",)
            )
            with patch.object(
                self.live.runtime_session, "activity", new=AsyncMock(return_value=blocked)
            ):
                first_task = self.live.current_task
                assert first_task is not None
                self.adapter.release.set()
                await first_task
                await asyncio.sleep(0.05)
            queued = self.catalog.queued_message(SESSION_ID, "queued-next-turn")
            assert queued is not None
            self.assertEqual(queued.state, QueuedMessageState.FAILED)
            self.assertEqual(queued.safe_error, "runtime_resource_wait_blocked")
            self.assertEqual(len(self.adapter.inputs), 1)

        asyncio.run(scenario())

    def test_queued_turn_rejects_pending_hil_before_native_submission(self) -> None:
        async def scenario() -> None:
            queued, status = await self.turns._enqueue(
                self.live,
                self.body(0, client_turn_id="queued-after-hil"),
                submission_mode=SubmissionMode.QUEUED,
            )
            self.assertEqual(status, 202, queued)
            with patch.object(
                self.live, "pending_hil_snapshot", return_value=[{"request_id": "hil-1"}]
            ):
                result = await self.turns._prepare_queued(self.live, "queued-after-hil")
            self.assertEqual(result.error, "runtime_resource_wait_pending_hil")
            record = self.catalog.queued_message(SESSION_ID, "queued-after-hil")
            assert record is not None
            self.assertEqual(record.state, QueuedMessageState.FAILED)
            self.assertEqual(self.adapter.inputs, [])

        asyncio.run(scenario())

    def test_pending_hil_blocks_suspend_with_a_recorded_reason(self) -> None:
        async def scenario() -> None:
            with patch.object(
                self.live, "pending_hil_snapshot", return_value=[{"request_id": "hil-1"}]
            ):
                self.assertFalse(await self.live.suspend_runtime())
            self.assertEqual(self.live.suspend_blockers, ("pending_hil",))

        asyncio.run(scenario())

    def test_failed_turn_recovery_accepts_only_once_and_expires_after_completion(self) -> None:
        self.turns._events = self.events
        selection = self.select(0)
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=self.adapter.session_id,
            vendor_turn_id="failed-turn",
            vendor_item_id=None,
            kind=PRODUCT_EVENT_TURN_FAILED,
            payload={"retryable": True},
            idempotency_key="recoverable-failure",
        )

        async def scenario() -> None:
            self.adapter.started = asyncio.Event()
            self.adapter.release = asyncio.Event()
            body = {
                **self.body(selection.revision),
                "wait": False,
                "continue_turn_id": "failed-turn",
            }
            first, first_status = await self.turns.post(SESSION_ID, body, side=False)
            self.assertEqual(first_status, 202)
            self.assertTrue(first["accepted"])
            duplicate, status = await self.turns.post(
                SESSION_ID, {**body, "client_user_message_id": "duplicate"}, side=False
            )
            self.assertEqual((duplicate["error"], status), ("continuation_origin_stale", 409))
            await self.adapter.started.wait()
            task = self.live.current_task
            self.adapter.release.set()
            await task
            stale, status = await self.turns.post(
                SESSION_ID, {**body, "client_user_message_id": "after-completion"}, side=False
            )
            self.assertEqual((stale["error"], status), ("continuation_origin_stale", 409))
            self.assertIsNone(self.catalog.queued_message(SESSION_ID, "duplicate"))
            self.assertIsNone(self.catalog.queued_message(SESSION_ID, "after-completion"))

        asyncio.run(scenario())

    def test_failed_turn_recovery_rejects_stale_origin_before_enqueue(self) -> None:
        self.turns._events = self.events
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=self.adapter.session_id,
            vendor_turn_id="completed-turn",
            vendor_item_id=None,
            kind=PRODUCT_EVENT_TURN_INTERRUPTED,
            payload={},
            idempotency_key="recovery-terminal",
        )
        payload, status = asyncio.run(
            self.turns.post(SESSION_ID, {"continue_turn_id": "old-failure"}, side=False)
        )
        self.assertEqual((payload.get("error"), status), ("continuation_origin_stale", 409))
        self.assertFalse(self.catalog.queued_messages(SESSION_ID))

    def test_continuation_admission_rejects_replaced_or_cancelled_origin(self) -> None:
        async def scenario() -> None:
            self.live.last_submission_id = "new-submission"
            payload, status = await self.turns.post(
                SESSION_ID, {}, side=False, expected_submission_id="old-submission"
            )
            self.assertEqual((payload["error"], status), ("continuation_origin_stale", 409))
            self.live.interrupt_generation = 1
            payload, status = await self.turns.post(
                SESSION_ID,
                {},
                side=False,
                expected_submission_id="new-submission",
                expected_interrupt_generation=0,
            )
            self.assertEqual((payload["error"], status), ("continuation_origin_stale", 409))
            self.assertFalse(self.catalog.queued_messages(SESSION_ID))

        asyncio.run(scenario())

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
        self.activities = Activities()
        self.turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
            activities=self.activities,
        )

    def tearDown(self) -> None:
        asyncio.run(self.live.aclose())
        self.temporary.cleanup()

    def session_service(self, residents=None) -> SessionService:
        return SessionService(
            self.live.runtime_workdir,
            {SESSION_ID: self.live} if residents is None else residents,
            activities=Activities(),
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

    def test_cold_queue_withdrawal_is_durable_and_idempotent(self) -> None:
        request_id = "cold-withdraw"
        self.catalog.enqueue_message(
            SESSION_ID, request_id, {"client_user_message_id": request_id, "input": []}
        )
        context = Mock()
        residents = {}
        turns = TurnService(
            residents,
            self.live._logger,
            context_source=context,
            catalog=self.catalog,
            events=self.events,
            activities=Activities(),
        )
        for _attempt in range(2):
            result, status = asyncio.run(turns.delete_queued(SESSION_ID, request_id))
            self.assertEqual(status, 200)
            self.assertTrue(result["ok"])
        self.assertEqual(residents, {})
        self.assertEqual(self.catalog.queued_messages(SESSION_ID), ())
        self.assertEqual(
            SessionCatalogStore(self.database).queued_message(SESSION_ID, request_id).state,
            QueuedMessageState.CANCELLED,
        )
        self.assertIsNone(self.catalog.begin_queued_submission(SESSION_ID, request_id))
        context.finalize.assert_called_with(
            session_id=SESSION_ID,
            client_turn_id=request_id,
            outcome=AssistantTurnFinalization.DISCARDED,
        )
        self.assertEqual(
            len(
                [
                    event
                    for event in self.events.replay(SESSION_ID)
                    if event.idempotency_key == f"queue:{request_id}:deleted"
                ]
            ),
            1,
        )
        residents[SESSION_ID] = self.live
        result, status = asyncio.run(turns.delete_queued(SESSION_ID, request_id))
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])

    def test_cold_resource_wait_can_be_withdrawn_without_starting_runtime(self) -> None:
        request_id = "cold-withdraw-wait"
        queued = self.catalog.enqueue_message(SESSION_ID, request_id, {"input": []})
        self.catalog.begin_resource_wait(SESSION_ID, request_id, purpose=queued.purpose)
        residents = {}
        turns = TurnService(
            residents,
            self.live._logger,
            catalog=self.catalog,
            events=self.events,
            activities=Activities(),
        )
        result, status = asyncio.run(turns.delete_queued(SESSION_ID, request_id))
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])
        self.assertEqual(residents, {})
        self.assertEqual(
            self.catalog.queued_message(SESSION_ID, request_id).state,
            QueuedMessageState.CANCELLED,
        )

    def test_cold_queue_withdrawal_preserves_submission_conflicts(self) -> None:
        request_id = "cold-submitting"
        self.catalog.enqueue_message(SESSION_ID, request_id, {"input": []})
        self.catalog.begin_queued_submission(SESSION_ID, request_id)
        turns = TurnService(
            {}, self.live._logger, catalog=self.catalog, events=self.events, activities=Activities()
        )
        result, status = asyncio.run(turns.delete_queued(SESSION_ID, request_id))
        self.assertEqual(status, 409)
        self.assertEqual(result["error"], "queued_message_not_editable")
        self.assertEqual(
            self.catalog.queued_message(SESSION_ID, request_id).state,
            QueuedMessageState.SUBMITTING,
        )
        self.assertIsNone(self.events.by_key(SESSION_ID, f"queue:{request_id}:deleted"))
        missing, status = asyncio.run(turns.delete_queued(SESSION_ID, "missing-message"))
        self.assertEqual(status, 404)
        self.assertEqual(missing["error"], "queued_message_not_found")
        missing, status = asyncio.run(turns.delete_queued("missing-session", request_id))
        self.assertEqual(status, 404)
        self.assertEqual(missing["error"], "session_not_found")

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

    def test_reference_only_turn_passes_names_to_titles_without_replacing_history(self) -> None:
        titles = Mock()
        titles.prepare.return_value = None
        self.turns.bind_titles(titles)
        source = self.live.runtime_workdir / "科研综述.md"
        source.write_text("contract input", encoding="utf-8")
        selection = self.select(0)
        for kind in ("file", "skill"):
            with (
                self.subTest(kind=kind),
                patch.object(self.turns, "_require_allowed_skill", new=AsyncMock(return_value="1")),
            ):
                body = {
                    **self.body(selection.revision, client_turn_id=f"title-{kind}"),
                    "input": [{"type": kind, "path": str(source), "name": source.name}],
                }
                payload, status = asyncio.run(self.turns.post(SESSION_ID, body, side=False))
                self.assertEqual(status, 202, payload)
                arguments = titles.prepare.call_args
                self.assertIs(arguments.args[0], self.live)
                self.assertEqual(arguments.args[1], "")
                self.assertEqual(arguments.kwargs["turn_id"], f"title-{kind}")
                self.assertEqual(arguments.kwargs["references"][0]["title"], source.name)
                message = self.events.latest_kind(SESSION_ID, PRODUCT_EVENT_USER_MESSAGE)
                self.assertEqual(message.payload["text"], "")
                self.assertEqual(message.payload["refs"][0]["title"], source.name)

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
            activities=Activities(),
        )
        selection = self.select(0)
        payload, status = asyncio.run(
            self.turns.post(SESSION_ID, self.body(selection.revision), side=False)
        )
        self.assertEqual(status, 202, payload)
        self.assertTrue(payload["accepted"])
        self.assertEqual(payload["disposition"], "direct")
        items = self.adapter.inputs[0].items
        self.assertEqual(items[0]["text"], summary)
        self.assertTrue(any(item.get("text") == USER_TEXT for item in items))
        deliveries.begin_turn.assert_awaited_once()

    def test_reference_only_turn_reaches_runtime_without_synthetic_user_text(self) -> None:
        self.assistant = AssistantService(
            self.store, providers={ContextRefKind.FILE: ReadyProvider()}
        )
        self.turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
            activities=self.activities,
        )
        selection = self.select(
            0,
            refs=(
                ContextRef(
                    ref_id="file-only",
                    kind=ContextRefKind.FILE,
                    source_id="notes.md",
                    label="notes.md",
                ),
            ),
        )
        payload, status = asyncio.run(
            self.turns.post(
                SESSION_ID,
                {**self.body(selection.revision), "input": []},
                side=False,
            )
        )
        self.assertEqual(status, 202, payload)
        self.assertEqual(len(self.adapter.inputs), 1)
        self.assertEqual(len(self.adapter.inputs[0].items), 1)
        self.assertIn("contract evidence", self.adapter.inputs[0].items[0]["text"])
        messages = [
            event
            for event in self.events.replay(SESSION_ID)
            if event.kind == PRODUCT_EVENT_USER_MESSAGE
        ]
        self.assertEqual(messages[-1].payload["text"], "")
        self.assertTrue(messages[-1].payload["refs"])

    def test_empty_turn_rejects_background_context_and_revision_only(self) -> None:
        selection = self.select(0)
        payload, status = asyncio.run(
            self.turns.post(
                SESSION_ID,
                {**self.body(selection.revision), "input": []},
                side=False,
            )
        )
        self.assertEqual(status, 400, payload)
        self.assertEqual(payload["detail"], "turn_input_required")
        self.assertFalse(self.adapter.inputs)

    def test_reference_only_turn_preserves_revision_and_resolution_failures(self) -> None:
        selection = self.select(
            0,
            refs=(
                ContextRef(
                    ref_id="unavailable",
                    kind=ContextRefKind.FILE,
                    source_id="missing.md",
                    label="missing.md",
                ),
            ),
        )
        for revision, expected_status, expected_error in (
            (0, 409, "assistant_context_revision_conflict"),
            (selection.revision, 400, "assistant_context_unavailable"),
        ):
            with self.subTest(revision=revision):
                payload, status = asyncio.run(
                    self.turns.post(
                        SESSION_ID,
                        {**self.body(revision), "input": []},
                        side=False,
                    )
                )
                self.assertEqual(status, expected_status, payload)
                self.assertEqual(payload["error"], expected_error)
        self.assertFalse(self.adapter.inputs)

    def test_reference_only_queued_turn_freezes_and_dispatches(self) -> None:
        self.assistant = AssistantService(
            self.store, providers={ContextRefKind.FILE: ReadyProvider()}
        )
        self.turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
            activities=self.activities,
        )
        selection = self.select(
            0,
            refs=(
                ContextRef(
                    ref_id="queued-only",
                    kind=ContextRefKind.FILE,
                    source_id="queued.md",
                    label="queued.md",
                ),
            ),
        )

        async def exercise() -> None:
            body = {**self.body(selection.revision), "input": []}
            payload, status = await self.turns._enqueue(
                self.live,
                body,
                submission_mode=SubmissionMode.QUEUED,
            )
            self.assertEqual(status, 202, payload)
            edited, edited_status = await self.turns.update_queued(
                SESSION_ID,
                CLIENT_TURN,
                body,
            )
            self.assertEqual(edited_status, 409, edited)
            self.assertEqual(edited["error"], "queued_message_frozen")
            await self.turns._prepare_queued(self.live, CLIENT_TURN)

        asyncio.run(exercise())
        self.assertEqual(len(self.adapter.inputs), 1)
        self.assertIn("queued.md", self.adapter.inputs[0].items[0]["text"])

    def test_reference_only_current_reply_selection_reaches_runtime(self) -> None:
        assistant = AssistantService(
            self.store, providers={ContextRefKind.SELECTION: ReadyProvider()}
        )
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=assistant,
            activities=self.activities,
        )
        selection = assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(
                ContextRef(
                    ref_id="current-reply",
                    kind=ContextRefKind.SELECTION,
                    source_id=SESSION_ID,
                    label="当前回复选区",
                ),
            ),
        )
        payload, status = asyncio.run(
            turns.post(
                SESSION_ID,
                {**self.body(selection.revision), "input": []},
                side=False,
            )
        )
        self.assertEqual(status, 202, payload)
        self.assertIn("contract evidence", self.adapter.inputs[0].items[0]["text"])

    def test_empty_turn_does_not_use_implicit_material_as_user_input(self) -> None:
        assistant = AssistantService(self.store, providers={ContextRefKind.FILE: ReadyProvider()})
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=assistant,
            activities=self.activities,
        )
        selection = assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(
                ContextRef(
                    ref_id="implicit",
                    kind=ContextRefKind.FILE,
                    source_id="background.md",
                    label="background.md",
                    origin=ContextOrigin.CURRENT_DOCUMENT,
                ),
            ),
        )
        payload, status = asyncio.run(
            turns.post(
                SESSION_ID,
                {**self.body(selection.revision), "input": []},
                side=False,
            )
        )
        self.assertEqual(status, 400, payload)
        self.assertEqual(payload["detail"], "turn_input_required")
        self.assertFalse(self.adapter.inputs)

    def test_empty_input_remains_invalid_without_context_admission(self) -> None:
        async def exercise() -> None:
            for body in ({}, {"input": None}, {"input": []}):
                with self.subTest(body=body):
                    with self.assertRaisesRegex(ValueError, "turn_input_required"):
                        await self.turns._typed_input(self.live, body)
            queued_id = "editable-empty"
            self.catalog.enqueue_message(SESSION_ID, queued_id, self.body(0))
            payload, status = await self.turns.update_queued(
                SESSION_ID,
                queued_id,
                {"input": []},
            )
            self.assertEqual(status, 400, payload)
            self.assertEqual(payload["detail"], "turn_input_required")

        asyncio.run(exercise())

    def test_reference_only_note_reaches_runtime(self) -> None:
        answer_text = "当前回复原文"
        answers = Mock()
        answers.answer.return_value = AssistantAnswer(
            answer_id="item:reply",
            session_id=SESSION_ID,
            turn_id="reply-turn",
            source_product_seq=1,
            vendor_item_id="reply",
            markdown=answer_text,
            revision=text_revision(answer_text),
            completed_at=3.0,
        )
        annotations = AnswerAnnotationService(self.store, answers)
        _annotation, selection = annotations.create(
            session_id=SESSION_ID,
            answer_id="item:reply",
            client_annotation_id="reply-note",
            expected_context_revision=0,
            answer_revision=text_revision(answer_text),
            start_utf16=0,
            end_utf16=len(answer_text),
            selected_text_hash=text_revision(answer_text),
            preview_text=answer_text,
            comment="",
            enqueue=True,
        )
        assistant = AssistantService(self.store, providers={ContextRefKind.NOTE: annotations})
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=assistant,
            activities=self.activities,
        )
        payload, status = asyncio.run(
            turns.post(
                SESSION_ID,
                {**self.body(selection.revision), "input": []},
                side=False,
            )
        )
        self.assertEqual(status, 202, payload)
        self.assertIn(answer_text, self.adapter.inputs[0].items[0]["text"])

    def test_reference_only_truncation_requires_material_or_locator(self) -> None:
        cases = (
            ("empty-slot", ContextResolutionState.TRUNCATED, (), 400),
            (
                "empty-file",
                ContextResolutionState.READY,
                (
                    AssistantContextResolvedItem(
                        item_id="empty",
                        source_id="empty",
                        label="empty",
                        source_revision="",
                        text="",
                    ),
                ),
                202,
            ),
            (
                "excerpt",
                ContextResolutionState.TRUNCATED,
                (
                    AssistantContextResolvedItem(
                        item_id="excerpt",
                        source_id="excerpt",
                        label="excerpt",
                        text="partial",
                        source_revision="",
                    ),
                ),
                202,
            ),
            (
                "locator",
                ContextResolutionState.TRUNCATED,
                (
                    AssistantContextResolvedItem(
                        item_id="locator",
                        source_id="locator",
                        label="locator",
                        model_locator="resource://locator",
                        source_revision="",
                        text="",
                    ),
                ),
                202,
            ),
        )
        for case, state, items, expected_status in cases:
            with self.subTest(case=case):
                provider = Mock()
                provider.resolve.return_value = AssistantContextResolution(
                    state=state,
                    provider_version="turn-contract/v1",
                    items=items,
                )
                assistant = AssistantService(self.store, providers={ContextRefKind.FILE: provider})
                turns = TurnService(
                    {SESSION_ID: self.live},
                    self.live._logger,
                    context_source=assistant,
                    activities=self.activities,
                )
                selection = assistant.replace_selection(
                    session_id=SESSION_ID,
                    expected_revision=assistant.selection(SESSION_ID).revision,
                    project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                    search_scope=SearchScope.DISABLED,
                    refs=(
                        ContextRef(
                            ref_id=case,
                            kind=ContextRefKind.FILE,
                            source_id=case,
                            label=case,
                        ),
                    ),
                )
                payload, status = asyncio.run(
                    turns.post(
                        SESSION_ID,
                        {**self.body(selection.revision, client_turn_id=case), "input": []},
                        side=False,
                    )
                )
                self.assertEqual(status, expected_status, payload)

    def test_permission_baseline_failure_projects_file_details_without_runtime_submission(
        self,
    ) -> None:
        path = "resources/受限文件.md"
        deliveries = SimpleNamespace(
            begin_turn=AsyncMock(side_effect=ContentReadPermissionError(path)),
            finish_turn=AsyncMock(return_value=ReviewCaptureResult()),
        )
        self.live.project_path = self.live.runtime_workdir
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
            deliveries=deliveries,
            activities=Activities(),
        )
        selection = self.select(0)
        payload, status = asyncio.run(
            turns.post(
                SESSION_ID,
                self.body(selection.revision),
                side=False,
            )
        )
        self.assertEqual(status, 202, payload)
        self.assertEqual(payload["error"], "resource_baseline_permission_denied")
        queued = self.catalog.queued_message(SESSION_ID, CLIENT_TURN)
        self.assertEqual(queued.state, QueuedMessageState.FAILED)
        self.assertEqual(queued.safe_error_details, {"path": path})
        rejected = next(
            event for event in self.events.replay(SESSION_ID) if event.kind == "send_now_rejected"
        )
        self.assertEqual(rejected.payload["safe_error_details"], {"path": path})
        self.assertEqual(self.adapter.inputs, [])

    def test_nonpermission_baseline_failure_retains_generic_error(self) -> None:
        deliveries = SimpleNamespace(
            begin_turn=AsyncMock(side_effect=ContentError("read_failed")),
            finish_turn=AsyncMock(return_value=ReviewCaptureResult()),
        )
        self.live.project_path = self.live.runtime_workdir
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
            deliveries=deliveries,
            activities=Activities(),
        )
        selection = self.select(0)
        payload, status = asyncio.run(
            turns.post(
                SESSION_ID,
                self.body(selection.revision),
                side=False,
            )
        )
        self.assertEqual(status, 202, payload)
        self.assertEqual(payload["error"], "resource_baseline_failed")
        self.assertEqual(
            self.catalog.queued_message(SESSION_ID, CLIENT_TURN).safe_error_details, {}
        )
        self.assertEqual(self.adapter.inputs, [])

    def test_pending_resource_context_does_not_block_turn(self) -> None:
        deliveries = SimpleNamespace(
            begin_turn=AsyncMock(return_value=ResourceTurnContext(model_context="Pending review")),
            finish_turn=AsyncMock(return_value=ReviewCaptureResult()),
        )
        self.live.project_path = self.live.runtime_workdir
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
            deliveries=deliveries,
            activities=Activities(),
        )
        selection = self.select(0)

        payload, status = asyncio.run(
            turns.post(SESSION_ID, self.body(selection.revision), side=False)
        )

        self.assertEqual(status, 202, payload)
        deliveries.begin_turn.assert_awaited_once()
        self.assertEqual(len(self.adapter.inputs), 1)

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
            activities=Activities(),
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
            activities=Activities(),
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
        self.assertIn('"search_scope":"academic"', items[0]["text"])
        self.assertNotIn("retrieval_directive", items[0]["text"])
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

    def test_default_web_scope_sends_only_user_text_without_revision(self) -> None:
        body = self.body(0, client_turn_id="default-web-turn")
        body.pop("assistant_context_revision")

        payload, status = asyncio.run(self.turns.post(SESSION_ID, body, side=False))

        self.assertEqual(status, 202)
        self.assertTrue(payload["ok"])
        items = self.adapter.inputs[0].items
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["kind"], InputKind.TEXT.value)
        self.assertEqual(items[0]["text"], USER_TEXT)

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
            self.assertTrue(main_payload["accepted"])
            self.assertEqual(main_payload["disposition"], "direct")
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
            self.assertTrue(queued_payload["accepted"])
            self.assertEqual(queued_payload["disposition"], "queued")
            self.assertEqual(
                self.catalog.queued_message(SESSION_ID, "assistant-side-client").submission_mode,
                SubmissionMode.QUEUED,
            )
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
            activities=Activities(),
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
            activities=Activities(),
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
        self.assertTrue(queued["accepted"])
        self.assertEqual(queued["disposition"], "queued")
        messages, _status = self.session_service().queued(SESSION_ID)
        self.assertEqual(messages["messages"], [])
        queued_row = next(
            row for row in queued["listed"] if row["queued_message_id"] == "queued-turn"
        )
        self.assertEqual(queued_row["submission_mode"], "queued")
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
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=assistant,
            activities=Activities(),
        )
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
            self.assertTrue(queued["accepted"])
            self.assertEqual(queued["disposition"], "queued")
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
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=assistant,
            activities=Activities(),
        )
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
            self.assertTrue(queued["accepted"])
            self.assertEqual(queued["disposition"], "queued")
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
            self.assertTrue(queued["accepted"])
            self.assertEqual(queued["disposition"], "queued")
            task = self.live.current_task
            assert task is not None
            self.adapter.release.set()
            await task
            await asyncio.sleep(0.05)
            self.assertEqual(len(self.adapter.inputs), 1)
            rows = self.catalog.queued_messages(SESSION_ID)
            self.assertEqual([row.queued_message_id for row in rows], [f"queued-{suffix}"])

        asyncio.run(exercise(TurnStatus.FAILED, "failed"))

    def test_queued_dequeue_does_not_wait_for_review_decisions(self) -> None:
        selection = self.select(0)
        deliveries = SimpleNamespace(
            begin_turn=AsyncMock(return_value=ResourceTurnContext(model_context="Pending review")),
            finish_turn=AsyncMock(return_value=ReviewCaptureResult()),
        )
        self.live.project_path = self.live.runtime_workdir
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=self.assistant,
            deliveries=deliveries,
            activities=Activities(),
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

            async def queue_finished() -> None:
                while self.catalog.queued_messages(SESSION_ID):
                    await asyncio.sleep(0)

            await asyncio.wait_for(queue_finished(), timeout=QUEUE_SETTLEMENT_TIMEOUT_SECONDS)

        asyncio.run(exercise())

        self.assertEqual(deliveries.begin_turn.await_count, 2)
        self.assertEqual(len(self.adapter.inputs), 2)
        queued_rows = self.catalog.queued_messages(SESSION_ID)
        self.assertEqual(queued_rows, ())

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
            self.assertTrue(queued["accepted"])
            self.assertEqual(queued["disposition"], "queued")
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
            activities=Activities(),
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
            self.assertTrue(queued["accepted"])
            self.assertEqual(queued["disposition"], "queued")
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
            activities=Activities(),
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
                activities=Activities(),
            )
            response, status = await turns.post(
                SESSION_ID,
                {**self.body(selection.revision, client_turn_id="wait-cancel"), "wait": False},
                side=False,
            )
            self.assertEqual(status, 202)
            self.assertTrue(response["accepted"])
            self.assertEqual(response["disposition"], "direct")
            self.assertFalse(self.live.running)
            self.assertIsNone(self.live.current_task)
            await asyncio.wait_for(waiting.wait(), 1)
            async with self.live.lifecycle_lock:
                record = self.catalog.queued_message(SESSION_ID, "wait-cancel")
            self.assertEqual(record.state, QueuedMessageState.WAITING_RESOURCES)
            self.assertEqual(record.deadline, 12345.0)
            self.assertEqual(record.submission_mode, SubmissionMode.DIRECT)
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
                        activities=Activities(),
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

    def test_stop_keeps_admission_closed_until_initialization_cleanup_finishes(self) -> None:
        selection = self.select(0)

        async def exercise() -> None:
            entered = asyncio.Event()
            cleaning = asyncio.Event()
            released = asyncio.Event()

            async def prepare(live, **_kwargs):
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cleaning.set()
                    await released.wait()

            turns = TurnService(
                {SESSION_ID: self.live},
                self.live._logger,
                prepare=prepare,
                context_source=self.assistant,
                activities=Activities(),
            )
            await turns.post(
                SESSION_ID,
                {**self.body(selection.revision, client_turn_id="initializing"), "wait": False},
                side=False,
            )
            await asyncio.wait_for(entered.wait(), 1)
            stopping = asyncio.create_task(self.live.cancel_resource_wait())
            await asyncio.wait_for(cleaning.wait(), 1)
            try:
                self.assertTrue(self.live.interrupting)
                self.assertFalse(stopping.done())
                response, status = await turns.post(
                    SESSION_ID,
                    self.body(selection.revision, client_turn_id="during-stop"),
                    side=False,
                )
                self.assertEqual(status, 409, response)
                self.assertEqual(response["error"], "session_interrupting")
                self.assertEqual(self.adapter.inputs, [])
            finally:
                released.set()
                self.assertTrue(await stopping)
            self.assertFalse(self.live.interrupting)
            self.assertTrue(self.live.last_interrupt_succeeded)

        asyncio.run(exercise())

    def test_cancelled_message_remains_visible_and_reaches_next_model_turn(self) -> None:
        self._exercise_cancelled_message_history()

    def _exercise_cancelled_message_history(self) -> None:
        selection = self.select(0)

        async def prepare(live, *, request_id, deadline, on_wait):
            if request_id == "cancelled-first":
                await asyncio.Event().wait()

        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            prepare=prepare,
            context_source=self.assistant,
            events=self.events,
            activities=Activities(),
        )

        async def exercise() -> None:
            first, status = await turns.post(
                SESSION_ID,
                {
                    **self.body(selection.revision, client_turn_id="cancelled-first"),
                    "input": [{"type": "text", "text": "第一条：不要执行"}],
                    "wait": False,
                },
                side=False,
            )
            self.assertEqual(status, 202, first)
            self.assertTrue(await self.live.cancel_resource_wait())
            self.assertEqual(self.adapter.inputs, [])
            history = EventService({SESSION_ID: self.live}, self.events, self.live._logger)
            cancelled = history.decorate_history(SESSION_ID, self.live.history())
            self.assertEqual(cancelled[0]["text"], "第一条：不要执行")
            self.assertEqual(cancelled[0]["status"], "cancelled")
            self.assertIn("第一条：不要执行", self.events.portable_history(SESSION_ID)[0].text)

            second, status = await turns.post(
                SESSION_ID,
                {
                    **self.body(
                        self.assistant.selection(SESSION_ID).revision,
                        client_turn_id="second-turn",
                    ),
                    "input": [{"type": "text", "text": "我上一条消息是什么？"}],
                },
                side=False,
            )
            self.assertEqual(status, 202, second)
            self.assertEqual(len(self.adapter.inputs), 1)
            model_items = self.adapter.inputs[0].items
            self.assertIn("第一条：不要执行", model_items[0]["text"])
            self.assertIn("cancelled before execution", model_items[0]["text"])
            self.assertEqual(model_items[-1]["text"], "我上一条消息是什么？")
            visible = history.decorate_history(SESSION_ID, self.live.history())
            self.assertEqual(
                [row["text"] for row in visible if row["kind"] == "user"],
                ["第一条：不要执行", "我上一条消息是什么？"],
            )

        asyncio.run(exercise())

    def test_cancelled_portable_history_is_not_a_second_visible_user_message(self) -> None:
        self._exercise_cancelled_message_history()
        history = EventService({SESSION_ID: self.live}, self.events, self.live._logger)
        expected = history.decorate_history(SESSION_ID, self.live.history())
        seeded = [
            {
                "kind": "user",
                "role": "user",
                "text": self.events.portable_history(SESSION_ID)[0].text,
                "turn_id": "injected-turn",
                "item_id": "injected-user",
            },
            *self.live.history(),
        ]
        restored = history.decorate_history(SESSION_ID, seeded)
        self.assertEqual(
            [row["text"] for row in restored if row["kind"] == "user"],
            [row["text"] for row in expected if row["kind"] == "user"],
        )
        self.assertEqual(restored[0]["status"], "cancelled")
        self.assertEqual(history.decorate_history(SESSION_ID, restored), restored)

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
                activities=Activities(),
            )
            body = self.body(selection.revision, client_turn_id="renew-resource")
            result, _status = await turns.post(SESSION_ID, body, side=False)
            self.assertFalse(result["ok"])
            duplicate, _status = await turns.post(SESSION_ID, {**body, "wait": False}, side=False)
            self.assertTrue(duplicate["accepted"])
            self.assertEqual(duplicate["disposition"], "direct")
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
            activities=Activities(),
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
                        await self.live.ledger.activate_turn(native_turn_id)
                        self.live.current_task = pending
                        self.live.resource_task = None
                        self.live.waiting_request_id = ""
                    response = await asyncio.wait_for(stopping, 1)
                    self.assertTrue(response["ok"])
                    self.assertFalse(response["idle"])
                    self.assertNotIn("cancelled_waiting", response)
                    interrupt.assert_awaited_once()
                    self.assertTrue(interrupt.await_args.args[0].cleanup_background_processes)
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
                activities=Activities(),
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

    def test_sandbox_startup_failure_retains_safe_code_without_native_submission(self) -> None:
        selection = self.select(0)
        for index, code in enumerate(
            (
                "windows_sandbox_tool_access_failed",
                "windows_sandbox_setup_failed",
                "windows_sandbox_policy_rejected",
                "windows_sandbox_setup_cancelled",
                "private upstream detail",
            )
        ):
            with self.subTest(code=code):

                async def prepare(live, **kwargs):
                    error = RuntimeError("private upstream message")
                    error.safe_error = code
                    raise error

                turns = TurnService(
                    {SESSION_ID: self.live},
                    self.live._logger,
                    prepare=prepare,
                    context_source=self.assistant,
                    activities=Activities(),
                )
                request_id = f"startup-failure-{index}"
                _, status = asyncio.run(
                    turns.post(
                        SESSION_ID,
                        self.body(selection.revision, client_turn_id=request_id),
                        side=False,
                    )
                )
                self.assertEqual(status, 202)
                expected = code if index < 4 else "session_model_switch_failed"
                record = self.catalog.queued_message(SESSION_ID, request_id)
                self.assertEqual(record.state, QueuedMessageState.FAILED)
                self.assertEqual(record.safe_error, expected)
                self.assertFalse(record.native_turn_id)
                self.assertEqual(self.adapter.inputs, [])
                events = [
                    row for row in self.events.replay(SESSION_ID) if row.kind == "send_now_rejected"
                ]
                self.assertEqual(events[-1].payload["safe_error"], expected)
                asyncio.run(turns.delete_queued(SESSION_ID, request_id))

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
            activities=Activities(),
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
        turns = TurnService(
            {SESSION_ID: self.live},
            self.live._logger,
            context_source=assistant,
            activities=Activities(),
        )
        sessions = SessionService(
            self.live.runtime_workdir,
            {SESSION_ID: self.live},
            activities=Activities(),
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
                            await self.live.ledger.activate_turn(confirmation_id)
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
        asyncio.run(self.live.ledger.activate_turn("native-correlation"))
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
                live_sessions,
                self.live._logger,
                prepare=prepare,
                context_source=assistant,
                activities=Activities(),
            )
            runtime = SimpleNamespace(cancel_activation=AsyncMock(return_value=False))
            sessions = SessionService(
                self.live.runtime_workdir,
                live_sessions,
                activities=Activities(),
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
        turns = TurnService(
            live_sessions, self.live._logger, context_source=self.assistant, activities=Activities()
        )

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
                activities=Activities(),
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
            self.live._persistence,
        )
        sessions = SessionService(
            self.live.runtime_workdir,
            {SESSION_ID: self.live},
            activities=Activities(),
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
            activities=Activities(),
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
            self.assertTrue(queued["accepted"])
            self.assertEqual(queued["disposition"], "queued")
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
                self.assertTrue(queued["accepted"])
                self.assertEqual(queued["disposition"], "queued")
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
