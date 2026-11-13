"""Typed product-turn admission and runtime gateway execution."""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from contextlib import nullcontext
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Protocol

from scholarseed_runtime.contract.command import (
    CommandState,
    SubmissionRetryProof,
    ThreadReplacementProof,
)
from scholarseed_runtime.contract.event import RuntimeEventKind
from scholarseed_runtime.contract.history import TurnStatus
from scholarseed_runtime.contract.incident import RUNTIME_TURN_NOT_SUBMITTED, RuntimeRetryability
from scholarseed_runtime.contract.input import (
    CollaborationMode,
    InputItem,
    InputKind,
    TurnInput,
)
from scholarseed_runtime.contract.provider import RuntimeOpenNotAppliedError
from scholarseed_runtime.contract.resource import RESOURCE_CANCELLED, ResourceReceipt
from scholarseed_runtime.contract.sandbox import SANDBOX_STARTUP_ERRORS
from scholarseed_runtime.gateway.driver import (
    RuntimeCommandError,
    RuntimeTurnNotSubmittedError,
    RuntimeTurnOutcome,
    RuntimeTurnResult,
)
from service.capabilities.service.presentation import TurnSkillBinding
from service.chat.constants import (
    AUTOMATIC_CRASH_RETRY,
    CANCELLED_MESSAGE_CONTEXT_HEADER,
    PRODUCT_EVENT_MESSAGE_QUEUED,
    PRODUCT_EVENT_MESSAGE_REMOVED,
    PRODUCT_EVENT_MESSAGE_UPDATED,
    PRODUCT_EVENT_REVIEW_READY,
    PRODUCT_EVENT_SEND_NOW_ACCEPTED,
    PRODUCT_EVENT_SEND_NOW_OUTCOME_UNKNOWN,
    PRODUCT_EVENT_SEND_NOW_REJECTED,
    PRODUCT_EVENT_SEND_NOW_SUBMITTED,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_REFERENCE_DIRECTORY,
    PRODUCT_REFERENCE_FILE,
    PRODUCT_REFERENCE_ORIGIN_LOCAL_DIRECTORY,
    PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE,
    PRODUCT_REFERENCE_SKILL,
    QUEUED_ASSISTANT_REFERENCES,
    QUEUED_DISPLAY_TEXT,
    QUEUED_REFERENCES,
    RUNTIME_CAPABILITY_UNAVAILABLE,
    SESSION_ARCHIVED_ERROR,
    SESSION_TERMINATED,
    TURN_OUTCOME_UNCONFIRMED,
    USER_MESSAGE_ORIGIN_RECOVERY,
    USER_MESSAGE_ORIGIN_STEER,
    USER_MESSAGE_ORIGIN_TURN,
)
from service.chat.persistence.catalog import (
    QUEUE_PURPOSE_RECOVERY,
    QUEUE_PURPOSE_TURN,
    QUEUE_SUBMITTABLE_STATES,
    PendingTurnSettlement,
    QueuedMessageRecord,
    QueuedMessageState,
    ReplacementState,
    SessionCatalogStore,
    SessionQueueCapacityError,
    SessionStateConflictError,
    SubmissionMode,
    UncertaintyKind,
    UncertaintyState,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.activation import (
    ACTIVATION_SAFE_ERRORS,
    RESOURCE_WAIT_ACTIVITY_UNAVAILABLE,
    RESOURCE_WAIT_BLOCKED,
    RESOURCE_WAIT_PENDING_HIL,
    SessionActivationError,
)
from service.chat.runtime.live import (
    PENDING_HIL_BLOCKER,
    RUNTIME_ACTIVITY_UNAVAILABLE_BLOCKER,
    LiveSession,
)
from service.chat.runtime.projection import queued_message_payload
from service.chat.runtime.reconfiguration import PREPARATION_DEFAULT_FAILED, RECONFIGURATION_STALE
from service.chat.service.completions import bridge_fingerprint
from service.chat.service.recovery import (
    RECOVERY_CLAIMED,
    RECOVERY_CONTEXT,
    RECOVERY_DISPLAY,
    RECOVERY_INPUT,
    RECOVERY_REBUILD_PROOF,
    RECOVERY_SOURCE,
    RECOVERY_STALE,
    RecoveryAction,
    RecoveryCheckpoint,
    RecoveryService,
    recovery_key,
)
from service.chat.service.titles import SessionTitles
from service.content.domain.model import ContentReadPermissionError
from service.identity.service.skill_credentials import CredentialAdmissionError
from service.platform.activity import (
    Activities,
    ActivityDomain,
    ActivityLease,
    ActivityPhase,
    MaintenanceActive,
)
from service.platform.context import (
    AssistantContextFailure,
    AssistantContextFailureKind,
    AssistantTurnContext,
    AssistantTurnContextSource,
    AssistantTurnFinalization,
    ContextOrigin,
    ContextResolutionState,
    MessageReferencePayload,
    ProductTaskType,
)
from service.platform.resources import TurnOutcome
from service.resources.service.delivery import ResourceDeliveryService

HTTP_ACCEPTED = 202
HTTP_BAD_REQUEST = 400
HTTP_CONFLICT = 409
HTTP_NOT_FOUND = 404
TURN_INPUT_REQUIRED = "turn_input_required"
TURN_INPUT_INVALID = "turn_input_invalid"
TURN_ALREADY_RUNNING = "turn_already_running"
CONTINUATION_ORIGIN_STALE = "continuation_origin_stale"
CONTINUE_TURN_ID = "continue_turn_id"
RECOVERABLE_TURN_EVENTS = frozenset({PRODUCT_EVENT_TURN_FAILED, PRODUCT_EVENT_TURN_UNKNOWN})
INTERRUPTED_TURN_CONTEXT = (
    "The previous turn was interrupted and some operations may already have completed. "
    "Inspect the conversation history and existing results before continuing unfinished work. "
    "Continuation is not an answer or approval for an unanswered interaction. "
    "Reissue any unanswered interaction through its original user-input or approval tool and "
    "wait for the user's new response before taking the dependent action. An expired, "
    "cancelled, or interrupted request is not consent; never infer a choice from this recovery request. "
    "Do not blindly replay prior operations. If an external operation cannot be verified, "
    "explain the uncertainty and ask before repeating a potentially irreversible action."
)
RECOVERY_BOUNDARY_EVENTS = (
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
)
TURN_NOT_RUNNING = "turn_not_running"
TURN_INTERRUPTING = "session_interrupting"
RUNTIME_TURN_FAILED = "runtime_turn_failed"
RUNTIME_TURN_STEER_FAILED = "runtime_turn_steer_failed"
RUNTIME_TURN_STEER_OUTCOME_UNKNOWN = "runtime_turn_steer_outcome_unknown"
SESSION_MESSAGE_QUEUE_FULL = "session_message_queue_full"
SESSION_MODEL_SWITCH_FAILED = "session_model_switch_failed"
ASSISTANT_CONTEXT_UNAVAILABLE = "assistant_context_unavailable"
ASSISTANT_CONTEXT_REVISION_INVALID = "assistant_context_revision_invalid"
QUEUED_ASSISTANT_SNAPSHOT_ID = "assistant_snapshot_id"
QUEUED_MESSAGE_FROZEN = "queued_message_frozen"
ASSISTANT_CONTEXT_CLIENT_ID_REQUIRED = "assistant_context_client_id_required"
ASSISTANT_CONTEXT_FINALIZE_FAILED = "assistant_context_finalize_failed"
QUEUED_RECONCILE_APPLIED = "applied"
QUEUED_RECONCILE_NOT_APPLIED = "not_applied"
QUEUED_RECONCILE_STILL_UNKNOWN = "still_unknown"
QUEUED_SUBMISSION_NOT_APPLIED = "queued_submission_not_applied"
RESOURCE_BASELINE_FAILED = "resource_baseline_failed"
RESOURCE_BASELINE_PERMISSION_DENIED = "resource_baseline_permission_denied"
RESOURCE_DELIVERY_FAILED = "resource_delivery_failed"
TURN_SETTLEMENT_POLL_SECONDS = 1.0
TURN_SETTLEMENT_OUTCOMES = {
    RuntimeEventKind.TURN_COMPLETED: RuntimeTurnOutcome.COMPLETED,
    RuntimeEventKind.TURN_FAILED: RuntimeTurnOutcome.FAILED,
    RuntimeEventKind.TURN_INTERRUPTED: RuntimeTurnOutcome.INTERRUPTED,
    RuntimeEventKind.TURN_UNKNOWN: RuntimeTurnOutcome.UNKNOWN,
}
PREVIOUS_TURN_PENDING_HIL = "previous_turn_pending_hil"
PREVIOUS_TURN_BACKGROUND_ACTIVE = "previous_turn_background_active"
PREVIOUS_TURN_ACTIVITY_UNAVAILABLE = "previous_turn_activity_unavailable"
PREVIOUS_TURN_SETTLING = "previous_turn_settling"
SESSION_NOT_LIVE = "session_not_live"
QUEUED_MESSAGE_NOT_SENDABLE = "queued_message_not_sendable"
QUEUED_MESSAGE_CONFLICT = "queued_message_conflict"
QUEUED_MESSAGE_NOT_EDITABLE = "queued_message_not_editable"
QUEUED_MESSAGE_NOT_FOUND = "queued_message_not_found"
SESSION_NOT_FOUND = "session_not_found"
QUEUE_DELETED_REASON = "deleted"
HTTP_OK = 200
TURN_RESULT_SAFE_ERRORS = ACTIVATION_SAFE_ERRORS | frozenset(
    {
        TURN_INPUT_INVALID,
        TURN_OUTCOME_UNCONFIRMED,
        QUEUED_MESSAGE_NOT_SENDABLE,
        RESOURCE_BASELINE_FAILED,
        RESOURCE_BASELINE_PERMISSION_DENIED,
        SESSION_MODEL_SWITCH_FAILED,
        CredentialAdmissionError.code,
        ASSISTANT_CONTEXT_UNAVAILABLE,
        *(f"assistant_context_{kind.value}" for kind in AssistantContextFailureKind),
    }
)
RESEARCH_IDEA_SKILL = "research-idea-partner"
PRECISE_SEARCH_SKILL = "precise-literature-search"
LITERATURE_REVIEW_SKILL = "literature-review"
TASK_TYPES_BY_SKILL = {
    RESEARCH_IDEA_SKILL: ProductTaskType.RESEARCH_IDEA.value,
    PRECISE_SEARCH_SKILL: ProductTaskType.PRECISE_SEARCH.value,
    LITERATURE_REVIEW_SKILL: ProductTaskType.LITERATURE_REVIEW.value,
}
SUPPORTED_TASK_TYPES = frozenset(task.value for task in ProductTaskType)
FULLTEXT_GATED_TASK_TYPES = frozenset(TASK_TYPES_BY_SKILL.values())


class TurnPreparation(Protocol):
    async def __call__(
        self,
        live: LiveSession,
        *,
        request_id: str,
        deadline: float | None,
        on_wait: Callable[[ResourceReceipt, float], Awaitable[None]],
    ) -> None: ...


@dataclass(frozen=True)
class TurnResult:
    turn_id: str
    status: TurnStatus
    final_text: str = ""
    error: str = ""


@dataclass(frozen=True)
class TurnAdmission:
    turn_input: TurnInput
    display_text: str
    skill_versions: dict[str, str]
    references: tuple[MessageReferencePayload, ...]
    assistant_snapshot_id: str = ""
    assistant_context_revision: int | None = None


class TurnService:
    """Convert the frozen product input schema into a typed surface turn."""

    def __init__(
        self,
        sessions: dict[str, LiveSession],
        logger: Any,
        *,
        activities: Activities,
        prepare: TurnPreparation | None = None,
        context_source: AssistantTurnContextSource | None = None,
        deliveries: ResourceDeliveryService | None = None,
        catalog: SessionCatalogStore | None = None,
        events: ProductEventStore | None = None,
        binding_alive: Callable[[str, str], bool] | None = None,
    ) -> None:
        self._sessions = sessions
        self._activities = activities
        self._queue_waiters: dict[str, asyncio.Task[None]] = {}
        self._closed = False
        self._logger = logger
        self._prepare = prepare
        self._context_source = context_source
        self._deliveries = deliveries
        self._catalog = catalog
        self._events = events
        self._binding_alive = binding_alive
        self.recovery = (
            RecoveryService(sessions, events, activities, logger, self._enqueue_recovery)
            if events is not None and catalog is not None
            else None
        )
        if self.recovery is not None:
            self.recovery.bind_completion(self._complete_recovered_context)
        self._titles: SessionTitles | None = None

    def bind_titles(self, titles: SessionTitles) -> None:
        self._titles = titles

    def bind_context_source(self, source: AssistantTurnContextSource) -> None:
        """在应用组合阶段绑定唯一的产品上下文来源。"""

        if self._context_source is not None and self._context_source is not source:
            raise RuntimeError("turn context source is already bound")
        self._context_source = source

    async def aclose(self) -> None:
        self._closed = True
        if self._titles is not None:
            await self._titles.aclose()
        if self.recovery is not None:
            await self.recovery.aclose()
        waiters = tuple(self._queue_waiters.values())
        for task in waiters:
            task.cancel()
        await asyncio.gather(*waiters, return_exceptions=True)
        self._queue_waiters.clear()

    async def _enqueue_recovery(
        self, live: LiveSession, checkpoint: RecoveryCheckpoint, generation: str
    ) -> None:
        recovery = self.recovery
        if recovery is None or self._events is None or self._closed:
            return
        async with live.lifecycle_lock:
            if not await recovery.eligible(live, checkpoint):
                return
            if self._events.by_key(
                live.id, recovery_key(checkpoint.client_id, RECOVERY_CLAIMED, checkpoint.epoch)
            ):
                return
            rows = live.catalog.queued_messages(live.id)
            if any(
                row.queued_message_id != checkpoint.client_id
                or row.native_turn_id not in ("", None, checkpoint.native_turn_id)
                or row.state is not QueuedMessageState.OUTCOME_UNKNOWN
                for row in rows
            ):
                return
            original = live.catalog.queued_message(live.id, checkpoint.client_id)
            if original is None or original.state not in {
                QueuedMessageState.OUTCOME_UNKNOWN,
                QueuedMessageState.COMPLETED,
            }:
                return
            settled = original.state is QueuedMessageState.COMPLETED
            if settled:
                uncertainty = live.catalog.uncertainty(
                    live.id, UncertaintyKind.TURN, original.native_turn_id or checkpoint.client_id
                )
                if uncertainty is None or uncertainty.state is not UncertaintyState.RECONCILED:
                    return
            request_id = uuid.uuid5(uuid.NAMESPACE_OID, f"{live.id}:{checkpoint.client_id}").hex
            await recovery.claim(live, checkpoint, generation)
            body = {
                **original.body,
                "client_user_message_id": request_id,
                "queued_message_id": request_id,
                RECOVERY_SOURCE: recovery.source(checkpoint, generation),
            }
            if checkpoint.action is RecoveryAction.CONTINUE:
                body["input"] = [{"type": InputKind.TEXT.value, "text": RECOVERY_INPUT}]
                if RECOVERY_REBUILD_PROOF in checkpoint.payload:
                    body["input"].append(
                        {
                            "type": InputKind.TEXT.value,
                            "text": recovery.rebuild_context(live, checkpoint),
                        }
                    )
            payload, _status = await self._enqueue(
                live, body, submission_mode=SubmissionMode.DIRECT, purpose=QUEUE_PURPOSE_RECOVERY
            )
            if payload.get("ok"):
                if not await recovery.eligible(live, checkpoint) or not await recovery.authorize(
                    live, checkpoint
                ):
                    return
                if not await recovery.eligible(live, checkpoint):
                    return
                if getattr(live, "active_product_turn_id", "") == checkpoint.client_id:
                    if not await live.release_product_turn(checkpoint.client_id):
                        return
                if not await recovery.eligible(live, checkpoint):
                    return
                if not settled:
                    if not await live.persistence.run(
                        live.catalog.remove_reconciled_unknown_message,
                        live.id,
                        checkpoint.client_id,
                        int(original.operation_seq or 0),
                    ):
                        return
                    await live.publish(
                        PRODUCT_EVENT_MESSAGE_REMOVED,
                        {
                            "queued_message_id": checkpoint.client_id,
                            "reason": AUTOMATIC_CRASH_RETRY,
                        },
                        turn_id=checkpoint.client_id,
                        idempotency_key=recovery_key(
                            checkpoint.client_id, AUTOMATIC_CRASH_RETRY, checkpoint.epoch
                        ),
                    )
                if await recovery.current(live, body[RECOVERY_SOURCE]):
                    self._schedule_locked(live, request_id)

    async def _recovery_current(self, live: LiveSession, source: object) -> bool:
        return self.recovery is not None and await self.recovery.current(live, source)

    async def post(
        self,
        session_id: str,
        body: Mapping[str, Any],
        *,
        side: bool,
        expected_submission_id: str = "",
        expected_interrupt_generation: int | None = None,
        continuation_activity: ActivityLease | None = None,
        expected_permission_mode: str = "",
        expected_model_id: str = "",
        prepared_activity: bool = False,
    ) -> tuple[dict[str, Any], int]:
        if continuation_activity is not None and (side or not expected_submission_id):
            raise ValueError("continuation activity requires a guarded product continuation")
        lease = (
            self._activities.continue_from(continuation_activity, ActivityDomain.TURN)
            if continuation_activity is not None
            else self._activities.enter(ActivityDomain.TURN, root=not prepared_activity)
        )
        with lease:
            record = self._catalog.get(session_id) if self._catalog is not None else None
            if record is not None and record.archived:
                return {"ok": False, "error": SESSION_ARCHIVED_ERROR}, HTTP_CONFLICT
            live = self._sessions.get(session_id)
            if live is None:
                return {"ok": False, "error": "session_not_live"}, HTTP_NOT_FOUND
            if live.closing:
                return {"ok": False, "error": SESSION_TERMINATED}, HTTP_CONFLICT
            if side:
                return await self._steer(live, body)
            if (
                CONTINUE_TURN_ID in body
                and live.runtime_session is None
                and self._prepare is not None
            ):

                async def on_recovery_wait(_receipt: ResourceReceipt, _deadline: float) -> None:
                    return None

                try:
                    await self._prepare(
                        live,
                        request_id=str(body.get("client_user_message_id") or ""),
                        deadline=None,
                        on_wait=on_recovery_wait,
                    )
                except Exception as preparation_failure:
                    safe_error = (
                        preparation_failure.safe_error
                        if isinstance(preparation_failure, SessionActivationError)
                        else PREPARATION_DEFAULT_FAILED
                    )
                    self._logger.error(
                        "continuation_prepare_failed session_id=%s request_id=%s error=%s failure_type=%s",
                        live.id,
                        str(body.get("client_user_message_id") or ""),
                        safe_error,
                        type(preparation_failure).__name__,
                    )
                    return {
                        "ok": False,
                        "error": safe_error,
                        "preparation_error": True,
                    }, HTTP_CONFLICT
            task: asyncio.Task[TurnResult] | None = None
            async with live.lifecycle_lock:
                record = live.catalog.get(live.id)
                if record is not None and record.archived:
                    return {"ok": False, "error": SESSION_ARCHIVED_ERROR}, HTTP_CONFLICT
                if live.closing:
                    return {"ok": False, "error": SESSION_TERMINATED}, HTTP_CONFLICT
                if (
                    CONTINUE_TURN_ID not in body
                    and live.runtime_driver is not None
                    and live.runtime_driver.projection_failed
                ):
                    return {"ok": False, "error": PREVIOUS_TURN_ACTIVITY_UNAVAILABLE}, HTTP_CONFLICT
                unknown_turn_id = ""
                if CONTINUE_TURN_ID in body:
                    failed_turn_id = body[CONTINUE_TURN_ID]
                    continuation_id = str(body.get("client_user_message_id") or "")
                    existing = live.catalog.queued_message(live.id, continuation_id)
                    if (
                        existing is not None
                        and existing.body.get(CONTINUE_TURN_ID) == failed_turn_id
                        and not live.ledger.has_unknown_outcome
                    ):
                        payload, status = await self._enqueue(
                            live, body, submission_mode=existing.submission_mode
                        )
                        if payload.get("ok"):
                            self._schedule_locked(live, continuation_id)
                        return payload, status
                    boundaries = (
                        tuple(
                            event
                            for kind in RECOVERY_BOUNDARY_EVENTS
                            if (event := self._events.latest_kind(session_id, kind)) is not None
                        )
                        if self._events is not None
                        else ()
                    )
                    latest = max(boundaries, key=lambda event: event.product_seq, default=None)
                    if (
                        not isinstance(failed_turn_id, str)
                        or not failed_turn_id
                        or live.running
                        or any(
                            not (
                                queued.state is QueuedMessageState.OUTCOME_UNKNOWN
                                and failed_turn_id
                                in (queued.queued_message_id, queued.native_turn_id)
                            )
                            and not (
                                queued.queued_message_id == continuation_id
                                and queued.body.get(CONTINUE_TURN_ID) == failed_turn_id
                            )
                            for queued in live.catalog.queued_messages(live.id)
                        )
                        or latest is None
                        or latest.kind not in RECOVERABLE_TURN_EVENTS
                        or latest.vendor_turn_id != failed_turn_id
                    ):
                        return {"ok": False, "error": CONTINUATION_ORIGIN_STALE}, HTTP_CONFLICT
                    if latest.kind == PRODUCT_EVENT_TURN_UNKNOWN:
                        uncertainties = live.ledger.uncertainty_snapshot()
                        if (
                            len(uncertainties) != 1
                            or uncertainties[0]["correlation_id"] != failed_turn_id
                        ):
                            return {"ok": False, "error": TURN_OUTCOME_UNCONFIRMED}, HTTP_CONFLICT
                        if live.runtime_session is None:
                            return {
                                "ok": False,
                                "error": PREVIOUS_TURN_ACTIVITY_UNAVAILABLE,
                            }, HTTP_CONFLICT
                        try:
                            await live.recover_runtime_projection()
                            activity = await live.runtime_session.activity()
                        except Exception:
                            return {
                                "ok": False,
                                "error": PREVIOUS_TURN_ACTIVITY_UNAVAILABLE,
                            }, HTTP_CONFLICT
                        if not activity.idle:
                            return {
                                "ok": False,
                                "error": self._previous_turn_error(activity.blockers),
                            }, HTTP_CONFLICT
                        unknown_turn_id = failed_turn_id
                if expected_submission_id and (
                    live.last_submission_id != expected_submission_id
                    or live.running
                    or live.catalog.queued_messages(live.id)
                    or (
                        expected_permission_mode
                        and (
                            (record := live.catalog.get(session_id)) is None
                            or record.policy_id != expected_permission_mode
                        )
                    )
                    or (
                        expected_interrupt_generation is not None
                        and live.interrupt_generation != expected_interrupt_generation
                    )
                ):
                    return {"ok": False, "error": CONTINUATION_ORIGIN_STALE}, HTTP_CONFLICT
                if self._sessions.get(session_id) is not live:
                    return {"ok": False, "error": SESSION_NOT_LIVE}, HTTP_NOT_FOUND
                if live.interrupting:
                    return {"ok": False, "error": TURN_INTERRUPTING}, HTTP_CONFLICT
                admission_error = await self._settlement_admission_error(
                    live, allow_queue=True, confirmed_unknown_turn_id=unknown_turn_id
                )
                if admission_error:
                    return {"ok": False, "error": admission_error}, HTTP_CONFLICT
                if not live.running:
                    blockers = await live.previous_turn_blockers()
                    if blockers:
                        live.trace_resource("turn_admission_blocked", blockers=list(blockers))
                        error = self._previous_turn_error(blockers)
                        return {"ok": False, "error": error}, HTTP_CONFLICT
                submission_mode = (
                    SubmissionMode.QUEUED
                    if live.running
                    or (live.catalog.queued_messages(live.id) and not unknown_turn_id)
                    else SubmissionMode.DIRECT
                )
                if (
                    expected_model_id
                    and live.catalog.model_state(live.id).selected_model_id != expected_model_id
                ):
                    return {
                        "ok": False,
                        "error": RECONFIGURATION_STALE,
                        "preparation_error": True,
                    }, HTTP_CONFLICT
                payload, status = await self._enqueue(live, body, submission_mode=submission_mode)
                if payload.get("ok"):
                    if unknown_turn_id:
                        await self._confirm_queued_unknown_locked(live, unknown_turn_id)
                        await live.ledger.confirm_unknown_turn(unknown_turn_id)
                    scheduled = self._schedule_locked(live, str(payload["queued_message_id"]))
                    if live.waiting_request_id == payload.get("queued_message_id"):
                        task = scheduled
            if task is not None and bool(body.get("wait")):
                result = await asyncio.shield(task)
                result_payload = self._result_payload(result)
                result_payload.update(
                    accepted=True,
                    disposition=str(payload["disposition"]),
                )
                return result_payload, HTTP_ACCEPTED
            return payload, status

    @staticmethod
    def _previous_turn_error(blockers: tuple[str, ...]) -> str:
        if PENDING_HIL_BLOCKER in blockers:
            return PREVIOUS_TURN_PENDING_HIL
        if RUNTIME_ACTIVITY_UNAVAILABLE_BLOCKER in blockers:
            return PREVIOUS_TURN_ACTIVITY_UNAVAILABLE
        return PREVIOUS_TURN_BACKGROUND_ACTIVE

    async def _settlement_admission_error(
        self,
        live: LiveSession,
        *,
        allow_queue: bool = False,
        confirmed_unknown_turn_id: str = "",
    ) -> str | None:
        if live.ledger.has_unknown_outcome and not confirmed_unknown_turn_id:
            return TURN_OUTCOME_UNCONFIRMED
        pending = live.catalog.pending_turn_settlement(live.id)
        if pending is None:
            return None
        if pending.event.kind is RuntimeEventKind.TURN_UNKNOWN:
            return TURN_OUTCOME_UNCONFIRMED
        if allow_queue and live.running and not pending.recovery_blocked:
            return None
        if live.pending_hil_snapshot():
            return PREVIOUS_TURN_PENDING_HIL
        session = live.runtime_session
        if session is None:
            return PREVIOUS_TURN_ACTIVITY_UNAVAILABLE
        try:
            activity = await session.activity()
        except Exception:
            return PREVIOUS_TURN_ACTIVITY_UNAVAILABLE
        if not activity.execution_tree_complete:
            return PREVIOUS_TURN_ACTIVITY_UNAVAILABLE
        if activity.execution_tree_blockers:
            return self._previous_turn_error(activity.execution_tree_blockers)
        return PREVIOUS_TURN_SETTLING

    def _schedule_locked(
        self, live: LiveSession, selected_id: str = "", *, retry_failed: bool = False
    ) -> asyncio.Task[TurnResult] | None:
        """Own exactly one resource admission without claiming native execution."""

        record = live.catalog.get(live.id)
        if (
            self._sessions.get(live.id) is not live
            or (record is not None and record.archived)
            or live.running
            or live.interrupting
            or live.closing
            or live.ledger.has_unknown_outcome
            or live.catalog.pending_turn_settlement(live.id) is not None
            or (live.resource_task is not None and not live.resource_task.done())
        ):
            return None
        rows = live.catalog.queued_messages(live.id)
        if any(
            row.state in (QueuedMessageState.SUBMITTING, QueuedMessageState.OUTCOME_UNKNOWN)
            for row in rows
        ):
            return None
        queued = (
            next((row for row in rows if row.queued_message_id == selected_id), None)
            if selected_id
            else rows[0] if rows else None
        )
        allowed = (
            (QueuedMessageState.QUEUED, QueuedMessageState.FAILED)
            if retry_failed
            else (QueuedMessageState.QUEUED,)
        )
        if queued is None or queued.state not in allowed:
            return None
        if retry_failed and queued.state is QueuedMessageState.FAILED:
            live.catalog.authorize_replacement_retry(live.id, queued.queued_message_id)
        live.waiting_request_id = queued.queued_message_id
        task = self._activities.spawn(
            ActivityDomain.TURN, lambda: self._prepare_queued(live, queued.queued_message_id)
        )
        live.resource_task = task
        live.submission_tasks.add(task)
        task.add_done_callback(
            lambda done: self._finish_resource_task(live, queued.queued_message_id, done)
        )
        return task

    async def _prepare_queued(self, live: LiveSession, request_id: str) -> TurnResult:
        """Wait outside lifecycle_lock; only a confirmed grant permits submission."""

        queued = live.catalog.queued_message(live.id, request_id)
        if queued is None:
            return TurnResult(request_id, TurnStatus.FAILED, error=QUEUED_MESSAGE_NOT_SENDABLE)
        recovery_cancelled = False

        async def on_wait(_receipt: ResourceReceipt, deadline: float) -> None:
            async with live.lifecycle_lock:
                waiting = live.catalog.begin_resource_wait(
                    live.id, request_id, purpose=queued.purpose, deadline=deadline
                )
                if waiting is None:
                    raise asyncio.CancelledError
                live.waiting_resources = True
                await live.publish(
                    PRODUCT_EVENT_MESSAGE_UPDATED,
                    queued_message_payload(waiting),
                    idempotency_key=f"queue:{request_id}:waiting:{waiting.updated_at}",
                )

        try:
            preparation = None
            if queued.purpose == QUEUE_PURPOSE_RECOVERY and self._prepare is not None:
                recovery = queued.body.get(RECOVERY_SOURCE)
                if self.recovery is not None:
                    async with live.lifecycle_lock:
                        preparation = await self.recovery.prepare_readmission(
                            live, recovery, request_id
                        )
                if preparation is None:
                    recovery_cancelled = True
                    await self._fail_queued(live, request_id, RECOVERY_STALE, unknown=False)
                    return TurnResult(request_id, TurnStatus.INTERRUPTED, error=RECOVERY_STALE)
            if self._prepare is not None:
                with (
                    preparation.renewal.capture()
                    if preparation is not None and preparation.renewal is not None
                    else nullcontext()
                ):
                    await self._prepare(
                        live,
                        request_id=request_id,
                        deadline=(
                            None if queued.state is QueuedMessageState.FAILED else queued.deadline
                        ),
                        on_wait=on_wait,
                    )
            async with live.lifecycle_lock:
                record = live.catalog.get(live.id)
                if record is not None and record.archived:
                    raise asyncio.CancelledError
                if self._sessions.get(live.id) is not live or live.interrupting or live.closing:
                    raise asyncio.CancelledError
                recovery = None
                if queued.purpose == QUEUE_PURPOSE_RECOVERY:
                    recovery = queued.body.get(RECOVERY_SOURCE)
                    if (
                        preparation is not None
                        and (
                            self.recovery is None
                            or not await self.recovery.complete_readmission(live, preparation)
                        )
                    ) or not await self._recovery_current(live, recovery):
                        recovery_cancelled = True
                        await self._fail_queued(live, request_id, RECOVERY_STALE, unknown=False)
                        return TurnResult(request_id, TurnStatus.INTERRUPTED, error=RECOVERY_STALE)
                blockers = await live.previous_turn_blockers()
                if blockers:
                    live.trace_resource("turn_admission_blocked", blockers=list(blockers))
                    safe_error = (
                        RESOURCE_WAIT_PENDING_HIL
                        if PENDING_HIL_BLOCKER in blockers
                        else (
                            RESOURCE_WAIT_ACTIVITY_UNAVAILABLE
                            if RUNTIME_ACTIVITY_UNAVAILABLE_BLOCKER in blockers
                            else RESOURCE_WAIT_BLOCKED
                        )
                    )
                    raise SessionActivationError(safe_error)
                attachment = getattr(live, "attachment_model_bridge_id", None)
                held = attachment() if callable(attachment) else None
                if (
                    held
                    and self._binding_alive is not None
                    and not self._binding_alive(live.id, held)
                ):
                    self._logger.info(
                        "model_bridge_binding_missing session_id=%s purpose=%s action=blocked "
                        "fingerprint=%s",
                        live.id,
                        queued.purpose,
                        bridge_fingerprint(held),
                    )
                    if queued.purpose == QUEUE_PURPOSE_RECOVERY:
                        recovery_cancelled = True
                        await self._fail_queued(live, request_id, RECOVERY_STALE, unknown=False)
                        return TurnResult(request_id, TurnStatus.INTERRUPTED, error=RECOVERY_STALE)
                    raise SessionActivationError(RESOURCE_WAIT_BLOCKED)
                submitting = live.catalog.begin_queued_submission(live.id, request_id)
                if submitting is None:
                    raise asyncio.CancelledError
                live.waiting_resources = False
                await live.publish(
                    PRODUCT_EVENT_SEND_NOW_SUBMITTED,
                    queued_message_payload(submitting),
                    idempotency_key=f"queue:{request_id}:submitted:{submitting.operation_seq}",
                )
                payload, _status, task = await self._admit_turn_locked(
                    live, submitting.body, recovery=recovery
                )
                if task is None:
                    error = str(payload.get("error") or RUNTIME_TURN_FAILED)
                    await self._fail_queued(
                        live,
                        request_id,
                        error,
                        unknown=False,
                        safe_error_details=payload.get("safe_error_details"),
                    )
                    return TurnResult(request_id, TurnStatus.FAILED, error=error)
                self._clear_resource_task(live, request_id)
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # The selected request is cancellable only until native submission begins.
            current = live.catalog.queued_message(live.id, request_id)
            if current is not None and current.state in (
                QueuedMessageState.SUBMITTING,
                QueuedMessageState.RUNNING,
            ):
                await self._fail_queued(live, request_id, TURN_OUTCOME_UNCONFIRMED, unknown=True)
            return TurnResult(request_id, TurnStatus.INTERRUPTED, error=RESOURCE_CANCELLED)
        except Exception as exc:
            error = (
                exc.safe_error
                if isinstance(exc, SessionActivationError)
                else (
                    CredentialAdmissionError.code
                    if isinstance(exc, CredentialAdmissionError)
                    else SESSION_MODEL_SWITCH_FAILED
                )
            )
            if isinstance(exc, RuntimeOpenNotAppliedError):
                replacement = live.catalog.replacement(live.id)
                if (
                    replacement is not None
                    and replacement["state"] is ReplacementState.NOT_APPLIED
                    and replacement["command_id"] == request_id
                    and replacement.get("reservation_id") == exc.reservation_id
                ):
                    error = RUNTIME_TURN_NOT_SUBMITTED
            startup_error = getattr(exc, "safe_error", None)
            if (
                error != RUNTIME_TURN_NOT_SUBMITTED
                and isinstance(startup_error, str)
                and startup_error in SANDBOX_STARTUP_ERRORS
            ):
                error = startup_error
            self._logger.error(
                error,
                extra={"session_id": live.id, "failure_type": type(exc).__name__},
                exc_info=True,
            )
            current = live.catalog.queued_message(live.id, request_id)
            unknown = current is not None and current.state in (
                QueuedMessageState.SUBMITTING,
                QueuedMessageState.RUNNING,
            )
            await self._fail_queued(live, request_id, error, unknown=unknown)
            return TurnResult(request_id, TurnStatus.FAILED, error=error)
        finally:
            self._clear_resource_task(live, request_id)
            if recovery_cancelled:
                self._defer_queue(live)

    def _finish_resource_task(
        self, live: LiveSession, request_id: str, task: asyncio.Task[TurnResult]
    ) -> None:
        live.submission_tasks.discard(task)
        # A task cancelled before its first step never enters its coroutine's finally.
        queued = live.catalog.queued_message(live.id, request_id)
        if queued is not None and queued.state is QueuedMessageState.CANCELLED:
            self._discard_queued_context(live, request_id)
        if live.resource_task is task:
            self._clear_resource_task(live, request_id)

    @staticmethod
    def _clear_resource_task(live: LiveSession, request_id: str) -> None:
        if live.waiting_request_id == request_id:
            live.resource_task = None
            live.waiting_request_id = ""
            live.waiting_resources = False

    async def _fail_queued(
        self,
        live: LiveSession,
        request_id: str,
        safe_error: str,
        *,
        unknown: bool,
        safe_error_details: Mapping[str, str] | None = None,
    ) -> None:
        await live.persistence.run(
            live.catalog.fail_queued_submission,
            live.id,
            request_id,
            unknown=unknown,
            safe_error=safe_error,
            safe_error_details=safe_error_details,
        )
        failed = live.catalog.queued_message(live.id, request_id)
        if failed is None or failed.state not in (
            QueuedMessageState.FAILED,
            QueuedMessageState.OUTCOME_UNKNOWN,
        ):
            return
        if failed.state is QueuedMessageState.OUTCOME_UNKNOWN:
            await live.ledger.record_unknown_submission(
                failed.native_turn_id or failed.queued_message_id,
                safe_error=failed.safe_error,
            )
        await live.publish(
            (
                PRODUCT_EVENT_SEND_NOW_OUTCOME_UNKNOWN
                if failed.state is QueuedMessageState.OUTCOME_UNKNOWN
                else PRODUCT_EVENT_SEND_NOW_REJECTED
            ),
            queued_message_payload(failed),
            idempotency_key=f"queue:{request_id}:failure:{failed.updated_at}",
        )

    async def _admit_turn_locked(
        self,
        live: LiveSession,
        body: Mapping[str, Any],
        *,
        recovery: Mapping[str, Any] | None = None,
    ) -> tuple[dict[str, Any], int, asyncio.Task[TurnResult] | None]:
        """Admit one new turn while the caller owns ``lifecycle_lock``."""

        try:
            admission = await self._typed_input(
                live, self._continuation_input(live, body), allow_context_only=True
            )
        except ValueError as exc:
            return (
                {
                    "ok": False,
                    "error": TURN_INPUT_INVALID,
                    "detail": str(exc),
                },
                HTTP_BAD_REQUEST,
                None,
            )
        client_turn_id = admission.turn_input.client_user_message_id
        try:
            task_type = self._task_type(body, admission)
        except ValueError as exc:
            return (
                {"ok": False, "error": TURN_INPUT_INVALID, "detail": str(exc)},
                HTTP_BAD_REQUEST,
                None,
            )
        try:
            context_result = self._freeze_context(live, body, admission, recovery=recovery)
            if not isinstance(context_result, tuple):
                self._require_turn_content(live, admission, context_result)
        except ValueError as exc:
            return (
                {
                    "ok": False,
                    "error": TURN_INPUT_INVALID,
                    "detail": str(exc),
                },
                HTTP_BAD_REQUEST,
                None,
            )
        if isinstance(context_result, tuple):
            payload, status = context_result
            return payload, status, None
        if context_result is not None:
            admission = self._with_context(admission, context_result)
        if self._deliveries is not None:
            try:
                resource_context = await self._deliveries.begin_turn(
                    live.id, client_turn_id, str(live.project_path or live.runtime_workdir)
                )
                if resource_context.model_context:
                    admission = replace(
                        admission,
                        turn_input=replace(
                            admission.turn_input,
                            items=(
                                InputItem(InputKind.TEXT, text=resource_context.model_context),
                                *admission.turn_input.items,
                            ),
                        ),
                    )
            except Exception as exc:  # noqa: BLE001 - admission must fail closed
                self._logger.error(
                    RESOURCE_BASELINE_FAILED,
                    extra={
                        "session_id": live.id,
                        "turn_id": client_turn_id,
                        "failure_type": type(exc).__name__,
                    },
                    exc_info=True,
                )
                if isinstance(exc, ContentReadPermissionError):
                    return (
                        {
                            "ok": False,
                            "error": RESOURCE_BASELINE_PERMISSION_DENIED,
                            "safe_error_details": {"path": exc.path},
                        },
                        500,
                        None,
                    )
                return {"ok": False, "error": RESOURCE_BASELINE_FAILED}, 500, None
        cancelled_messages = (
            self._events.cancelled_messages_since_bound(live.id) if self._events is not None else ()
        )
        if cancelled_messages:
            cancelled_context = (
                CANCELLED_MESSAGE_CONTEXT_HEADER
                + "\n"
                + json.dumps([message.text for message in cancelled_messages], ensure_ascii=False)
            )
            admission = replace(
                admission,
                turn_input=replace(
                    admission.turn_input,
                    items=(
                        InputItem(InputKind.TEXT, text=cancelled_context),
                        *admission.turn_input.items,
                    ),
                ),
            )
        if CONTINUE_TURN_ID in body or recovery is not None:
            admission = replace(
                admission,
                turn_input=replace(
                    admission.turn_input,
                    items=(
                        InputItem(
                            InputKind.TEXT,
                            text=(
                                RECOVERY_CONTEXT
                                if recovery is not None
                                else INTERRUPTED_TURN_CONTEXT
                            ),
                        ),
                        *admission.turn_input.items,
                    ),
                ),
            )
        live.trace_turn_input(
            admission.turn_input,
            user_text=admission.display_text,
            product_context=(context_result.model_context if context_result is not None else ""),
            skill_versions=admission.skill_versions,
            assistant_snapshot_id=admission.assistant_snapshot_id,
            assistant_context_revision=admission.assistant_context_revision,
        )
        title_request = (
            self._titles.prepare(
                live,
                admission.display_text,
                turn_id=client_turn_id,
                references=admission.references,
            )
            if self._titles is not None and recovery is None
            else None
        )
        if recovery is not None:
            await live.refresh_skills()
            fence = await self.recovery.admission(live, recovery, client_turn_id)
            if fence is None:
                return {"ok": False, "error": RECOVERY_STALE}, HTTP_CONFLICT, None
            admission = replace(
                admission, turn_input=replace(admission.turn_input, admission=fence)
            )
        replacement = live.catalog.replacement(live.id)
        reuse_admitted = bool(
            replacement is not None
            and replacement["state"] is ReplacementState.BOUND
            and replacement.get("manual_retry")
            and replacement["command_id"] == client_turn_id
        )
        await live.record_user_history(
            RECOVERY_DISPLAY if recovery is not None else admission.display_text,
            references=admission.references,
            turn_id=client_turn_id,
            item_id=client_turn_id,
            assistant_snapshot_id=admission.assistant_snapshot_id,
            assistant_context_revision=admission.assistant_context_revision,
            origin=(
                USER_MESSAGE_ORIGIN_RECOVERY if recovery is not None else USER_MESSAGE_ORIGIN_TURN
            ),
            reuse_admitted=reuse_admitted,
        )
        if self.recovery is not None:
            await self.recovery.begin(
                live, client_turn_id, automatic=recovery is not None, manual=reuse_admitted
            )
        live.last_submission_id = client_turn_id
        live.active_assistant_snapshot_id = admission.assistant_snapshot_id
        live.active_assistant_revision = admission.assistant_context_revision
        live.active_task_type = task_type
        live.active_task_lease = None
        live.product_turn_generation += 1
        live.active_skill_presentation = TurnSkillBinding.from_input(
            admission.turn_input, admission.skill_versions, live.product_turn_generation
        )
        live.active_turn_started_at = time.time()
        live.settlement_observer = self.resume_pending_settlement
        task = self._activities.spawn(
            ActivityDomain.TURN, lambda: self._execute(live, admission.turn_input)
        )
        live.current_task = task
        if title_request is not None and self._titles is not None:
            self._titles.start(live, title_request)
        return {"ok": True, "turn_id": client_turn_id}, HTTP_ACCEPTED, task

    async def _enqueue(
        self,
        live: LiveSession,
        body: Mapping[str, Any],
        *,
        submission_mode: SubmissionMode,
        purpose: str = QUEUE_PURPOSE_TURN,
    ) -> tuple[dict[str, Any], int]:
        try:
            admission = await self._typed_input(
                live, body, validate_skill_inventory=False, allow_context_only=True
            )
        except ValueError as exc:
            return {
                "ok": False,
                "error": TURN_INPUT_INVALID,
                "detail": str(exc),
            }, HTTP_BAD_REQUEST
        queued_message_id = str(
            body.get("queued_message_id")
            or admission.turn_input.client_user_message_id
            or uuid.uuid4().hex
        )
        if queued_message_id != admission.turn_input.client_user_message_id:
            return {"ok": False, "error": QUEUED_MESSAGE_CONFLICT}, HTTP_CONFLICT
        queued_body = dict(body)
        queued_body.pop("wait", None)
        queued_body["client_user_message_id"] = admission.turn_input.client_user_message_id
        queued_body["queued_message_id"] = queued_message_id
        existing = live.catalog.queued_message(live.id, queued_message_id)
        if existing is not None:
            existing_input = {
                key: value
                for key, value in existing.body.items()
                if key
                not in (
                    QUEUED_ASSISTANT_SNAPSHOT_ID,
                    QUEUED_ASSISTANT_REFERENCES,
                    QUEUED_DISPLAY_TEXT,
                    QUEUED_REFERENCES,
                )
            }
            if existing_input != queued_body:
                return {"ok": False, "error": QUEUED_MESSAGE_CONFLICT}, HTTP_CONFLICT
            return self._queue_receipt(live, existing), HTTP_ACCEPTED
        try:
            context = self._freeze_queued_context(
                live,
                body,
                admission,
                recovery=body.get(RECOVERY_SOURCE) if purpose == QUEUE_PURPOSE_RECOVERY else None,
            )
            if not isinstance(context, tuple):
                self._require_turn_content(live, admission, context)
        except ValueError as exc:
            return {
                "ok": False,
                "error": TURN_INPUT_INVALID,
                "detail": str(exc),
            }, HTTP_BAD_REQUEST
        if isinstance(context, tuple):
            return context
        if context is not None:
            queued_body[QUEUED_ASSISTANT_SNAPSHOT_ID] = context.snapshot.snapshot_id
            queued_body["assistant_context_revision"] = context.snapshot.selection_revision
            queued_body[QUEUED_ASSISTANT_REFERENCES] = list(context.surface_refs)
        queued_body[QUEUED_DISPLAY_TEXT] = (
            RECOVERY_DISPLAY if purpose == QUEUE_PURPOSE_RECOVERY else admission.display_text
        )
        queued_body[QUEUED_REFERENCES] = list(admission.references)
        try:
            record = live.catalog.enqueue_message(
                live.id,
                queued_message_id,
                queued_body,
                submission_mode=submission_mode,
                purpose=purpose,
            )
        except SessionQueueCapacityError:
            self._release_queued_context(live, admission.turn_input.client_user_message_id)
            return {"ok": False, "error": SESSION_MESSAGE_QUEUE_FULL}, HTTP_CONFLICT
        except SessionStateConflictError:
            self._release_queued_context(live, admission.turn_input.client_user_message_id)
            return {"ok": False, "error": "queued_message_conflict"}, HTTP_CONFLICT
        await live.publish(
            PRODUCT_EVENT_MESSAGE_QUEUED,
            queued_message_payload(record),
            idempotency_key=f"queue:{queued_message_id}:queued",
        )
        return self._queue_receipt(live, record), HTTP_ACCEPTED

    @staticmethod
    def _queue_receipt(live: LiveSession, record: QueuedMessageRecord) -> dict[str, Any]:
        return {
            "ok": True,
            "accepted": True,
            "disposition": record.submission_mode.value,
            "queued_message_id": record.queued_message_id,
            "queued_depth": len(live.catalog.queued_messages(live.id)),
        }

    async def update_queued(
        self,
        session_id: str,
        queued_message_id: str,
        body: Mapping[str, Any],
    ) -> tuple[dict[str, Any], int]:
        live = self._sessions.get(session_id)
        if live is None:
            return {"ok": False, "error": "session_not_live"}, HTTP_NOT_FOUND
        current = live.catalog.queued_message(session_id, queued_message_id)
        if current is not None and current.body.get(QUEUED_ASSISTANT_SNAPSHOT_ID):
            return {"ok": False, "error": QUEUED_MESSAGE_FROZEN}, HTTP_CONFLICT
        try:
            admission = await self._typed_input(live, body, validate_skill_inventory=False)
        except ValueError as exc:
            return {
                "ok": False,
                "error": TURN_INPUT_INVALID,
                "detail": str(exc),
            }, HTTP_BAD_REQUEST
        queued_body = dict(body)
        queued_body["queued_message_id"] = queued_message_id
        queued_body[QUEUED_DISPLAY_TEXT] = admission.display_text
        queued_body[QUEUED_REFERENCES] = list(admission.references)
        record = live.catalog.update_queued_message(session_id, queued_message_id, queued_body)
        if record is None:
            return {"ok": False, "error": "queued_message_not_editable"}, HTTP_CONFLICT
        await live.publish(
            PRODUCT_EVENT_MESSAGE_UPDATED,
            queued_message_payload(record),
            idempotency_key=f"queue:{queued_message_id}:updated:{record.updated_at}",
        )
        return {"ok": True, "message": queued_message_payload(record)}, 200

    async def delete_queued(
        self,
        session_id: str,
        queued_message_id: str,
    ) -> tuple[dict[str, Any], int]:
        live = self._sessions.get(session_id)
        if live is None:
            catalog = self._catalog
            session = catalog.get(session_id) if catalog is not None else None
            if session is None or catalog is None:
                return {"ok": False, "error": SESSION_NOT_FOUND}, HTTP_NOT_FOUND
            payload, status = self._delete_persisted_queue(catalog, session_id, queued_message_id)
            if (
                payload["ok"]
                and self._events is not None
                and self._events.by_key(session_id, f"queue:{queued_message_id}:deleted") is None
            ):
                self._events.append(
                    session_id=session_id,
                    runtime_id=session.runtime_id,
                    vendor_thread_id=session.vendor_thread_id or "",
                    vendor_turn_id=None,
                    vendor_item_id=None,
                    kind=PRODUCT_EVENT_MESSAGE_REMOVED,
                    payload={
                        "queued_message_id": queued_message_id,
                        "reason": QUEUE_DELETED_REASON,
                    },
                    idempotency_key=f"queue:{queued_message_id}:deleted",
                )
            return payload, status
        waiting_task: asyncio.Task[TurnResult] | None = None
        async with live.lifecycle_lock:
            if self._sessions.get(session_id) is not live:
                return await self.delete_queued(session_id, queued_message_id)
            payload, status = self._delete_persisted_queue(
                live.catalog, session_id, queued_message_id
            )
            if not payload["ok"]:
                return payload, status
            if live.waiting_request_id == queued_message_id:
                waiting_task = live.resource_task
                if waiting_task is not None:
                    waiting_task.cancel()
        if waiting_task is not None:
            await asyncio.gather(waiting_task, return_exceptions=True)
        await self._drain_next(live)
        if (
            self._events is None
            or self._events.by_key(session_id, f"queue:{queued_message_id}:deleted") is None
        ):
            await live.publish(
                PRODUCT_EVENT_MESSAGE_REMOVED,
                {"queued_message_id": queued_message_id, "reason": QUEUE_DELETED_REASON},
                idempotency_key=f"queue:{queued_message_id}:deleted",
            )
        return payload, status

    def _delete_persisted_queue(
        self,
        catalog: SessionCatalogStore,
        session_id: str,
        queued_message_id: str,
    ) -> tuple[dict[str, Any], int]:
        queued = catalog.queued_message(session_id, queued_message_id)
        if queued is None:
            return {"ok": False, "error": QUEUED_MESSAGE_NOT_FOUND}, HTTP_NOT_FOUND
        if not catalog.delete_queued_message(session_id, queued_message_id):
            queued = catalog.queued_message(session_id, queued_message_id)
            if queued is None or queued.state is not QueuedMessageState.CANCELLED:
                return {"ok": False, "error": QUEUED_MESSAGE_NOT_EDITABLE}, HTTP_CONFLICT
        client_turn_id = str(queued.body.get("client_user_message_id") or "")
        if client_turn_id:
            self._finalize_context(session_id, client_turn_id, AssistantTurnFinalization.DISCARDED)
        return {"ok": True, "queued_message_id": queued_message_id}, HTTP_OK

    async def cancel_pending_locked(self, session_id: str) -> None:
        """Settle unsent work before termination; the caller owns lifecycle_lock."""

        live = self._sessions.get(session_id)
        if live is None:
            return
        for queued in live.catalog.queued_messages(session_id):
            if queued.state not in QUEUE_SUBMITTABLE_STATES:
                continue
            if self._context_source is not None:
                self._context_source.finalize(
                    session_id=session_id,
                    client_turn_id=str(self._context_owner(session_id, queued.queued_message_id)),
                    outcome=AssistantTurnFinalization.DISCARDED,
                )
            if not live.catalog.delete_queued_message(session_id, queued.queued_message_id):
                continue
            if (
                live.waiting_request_id == queued.queued_message_id
                and live.resource_task is not None
            ):
                live.resource_task.cancel()
            await live.record_cancelled_user_history(queued)
            await live.publish(
                PRODUCT_EVENT_MESSAGE_REMOVED,
                {"queued_message_id": queued.queued_message_id, "reason": "cancelled"},
                idempotency_key=f"queue:{queued.queued_message_id}:cancelled",
            )

    async def send_queued(
        self,
        session_id: str,
        queued_message_id: str,
    ) -> tuple[dict[str, Any], int]:
        """Start one selected queued message as a new turn while the session is idle."""
        with self._activities.enter(ActivityDomain.TURN, root=True):
            live = self._sessions.get(session_id)
            if live is None:
                return {"ok": False, "error": "session_not_live"}, HTTP_NOT_FOUND
            async with live.lifecycle_lock:
                if self._sessions.get(session_id) is not live:
                    return {"ok": False, "error": "session_not_live"}, HTTP_NOT_FOUND
                if live.interrupting:
                    return {"ok": False, "error": TURN_INTERRUPTING}, HTTP_CONFLICT
                admission_error = await self._settlement_admission_error(live)
                if admission_error:
                    return {"ok": False, "error": admission_error}, HTTP_CONFLICT
                if live.running:
                    return {"ok": False, "error": TURN_ALREADY_RUNNING}, HTTP_CONFLICT
                if live.closing:
                    return {"ok": False, "error": SESSION_TERMINATED}, HTTP_CONFLICT
                queued = live.catalog.queued_message(session_id, queued_message_id)
                if (
                    live.waiting_request_id == queued_message_id
                    and live.resource_task is not None
                    and not live.resource_task.done()
                ):
                    if queued is not None and queued.state in (
                        QueuedMessageState.QUEUED,
                        QueuedMessageState.WAITING_RESOURCES,
                        QueuedMessageState.FAILED,
                    ):
                        return self._queue_receipt(live, queued), HTTP_ACCEPTED
                if queued is None:
                    return {"ok": False, "error": QUEUED_MESSAGE_NOT_SENDABLE}, HTTP_CONFLICT
                task = self._schedule_locked(live, queued_message_id, retry_failed=True)
                if task is None:
                    return {
                        "ok": False,
                        "error": QUEUED_MESSAGE_NOT_SENDABLE,
                    }, HTTP_CONFLICT
                return self._queue_receipt(live, queued), HTTP_ACCEPTED

    async def _steer(
        self,
        live: LiveSession,
        body: Mapping[str, Any],
    ) -> tuple[dict[str, Any], int]:
        queued_message_id = str(body.get("queued_message_id") or "")
        if not queued_message_id:
            return {
                "ok": False,
                "error": "queued_message_id_required",
            }, HTTP_BAD_REQUEST
        if live.closing:
            return {"ok": False, "error": SESSION_TERMINATED}, HTTP_CONFLICT
        if live.interrupting:
            return {"ok": False, "error": TURN_INTERRUPTING}, HTTP_CONFLICT
        admission_error = await self._settlement_admission_error(live)
        if admission_error:
            return {"ok": False, "error": admission_error}, HTTP_CONFLICT
        if not live.running:
            return {"ok": False, "error": TURN_NOT_RUNNING}, HTTP_CONFLICT
        if live.runtime_session is None:
            return {
                "ok": False,
                "error": RUNTIME_CAPABILITY_UNAVAILABLE,
                "capability": "side_input",
            }, HTTP_CONFLICT
        async with live.steer_lock:
            queued = live.catalog.begin_queued_submission(live.id, queued_message_id)
            if queued is None:
                return {
                    "ok": False,
                    "error": "queued_message_not_sendable",
                }, HTTP_CONFLICT
            await live.publish(
                PRODUCT_EVENT_SEND_NOW_SUBMITTED,
                queued_message_payload(queued),
                idempotency_key=f"queue:{queued_message_id}:submitted:{queued.operation_seq}",
            )
            queued_body = queued.body
            return await self._submit_steer(live, queued, queued_body)

    async def reconcile_queued(
        self,
        session_id: str,
        queued_message_id: str,
    ) -> tuple[dict[str, Any], int]:
        """Resolve an uncertain queue submission from durable product facts."""

        live = self._sessions.get(session_id)
        if live is None:
            return {"ok": False, "error": "session_not_live"}, HTTP_NOT_FOUND
        queued = live.catalog.queued_message(session_id, queued_message_id)
        client_message_id = (
            str(queued.body.get("client_user_message_id") or queued_message_id)
            if queued is not None
            else queued_message_id
        )
        if queued is not None and queued.state in (
            QueuedMessageState.RUNNING,
            QueuedMessageState.COMPLETED,
        ):
            return {
                "ok": True,
                "outcome": QUEUED_RECONCILE_APPLIED,
                "queued_message_id": queued_message_id,
            }, 200
        if queued is not None and queued.state is QueuedMessageState.CANCELLED:
            return {
                "ok": True,
                "outcome": QUEUED_RECONCILE_NOT_APPLIED,
                "queued_message_id": queued_message_id,
                "queue_missing": True,
                "reason": RESOURCE_CANCELLED,
            }, 200
        if queued is None:
            applied = live.has_user_message(client_message_id)
            return {
                "ok": True,
                "outcome": (QUEUED_RECONCILE_APPLIED if applied else QUEUED_RECONCILE_NOT_APPLIED),
                "queued_message_id": queued_message_id,
                "queue_missing": True,
                "reason": "" if applied else QUEUED_SUBMISSION_NOT_APPLIED,
            }, 200
        if queued.state is not QueuedMessageState.OUTCOME_UNKNOWN:
            return {
                "ok": False,
                "error": "queued_message_not_uncertain",
            }, HTTP_CONFLICT
        return {
            "ok": True,
            "outcome": QUEUED_RECONCILE_STILL_UNKNOWN,
            "queued_message_id": queued_message_id,
            "message": queued_message_payload(queued),
            "reason": TURN_OUTCOME_UNCONFIRMED,
        }, 200

    async def confirm_queued_unknown(self, session_id: str, turn_id: str) -> None:
        """Settle only the explicitly confirmed request; its execution outcome stays unknown."""

        live = self._sessions.get(session_id)
        if live is None:
            return
        async with live.lifecycle_lock:
            await self._confirm_queued_unknown_locked(live, turn_id)

    async def _confirm_queued_unknown_locked(self, live: LiveSession, turn_id: str) -> None:
        session_id = live.id
        for queued in live.catalog.queued_messages(session_id):
            if queued.state is not QueuedMessageState.OUTCOME_UNKNOWN or turn_id not in (
                queued.queued_message_id,
                queued.native_turn_id,
            ):
                continue
            if self._context_source is not None:
                self._context_source.finalize(
                    session_id=session_id,
                    client_turn_id=self._context_owner(session_id, queued.queued_message_id),
                    outcome=AssistantTurnFinalization.DISCARDED,
                )
            if not live.catalog.remove_reconciled_unknown_message(
                session_id, queued.queued_message_id, int(queued.operation_seq or 0)
            ):
                continue
            await live.publish(
                PRODUCT_EVENT_MESSAGE_REMOVED,
                {
                    "queued_message_id": queued.queued_message_id,
                    "reason": "confirmed_without_replay",
                },
                turn_id=turn_id,
                idempotency_key=f"queue:{queued.queued_message_id}:confirmed-without-replay",
            )

    async def _submit_steer(
        self,
        live: LiveSession,
        queued: Any,
        body: Mapping[str, Any],
    ) -> tuple[dict[str, Any], int]:
        queued_message_id = queued.queued_message_id
        try:
            admission = await self._typed_input(live, body)
            revision = self._expected_context_revision(body)
            active_revision = getattr(live, "active_assistant_revision", None)
            active_snapshot_id = str(getattr(live, "active_assistant_snapshot_id", ""))
            if revision is not None and revision != active_revision:
                await self._reject_steer(
                    live,
                    queued,
                    "assistant_context_revision_not_active",
                )
                return {
                    "ok": False,
                    "error": "assistant_context_revision_not_active",
                    "active_revision": active_revision,
                }, HTTP_CONFLICT
            admission = TurnAdmission(
                turn_input=admission.turn_input,
                display_text=admission.display_text,
                skill_versions=admission.skill_versions,
                references=admission.references,
                assistant_snapshot_id=active_snapshot_id,
                assistant_context_revision=active_revision,
            )
            live.trace_turn_input(
                admission.turn_input,
                user_text=admission.display_text,
                steer=True,
                skill_versions=admission.skill_versions,
                assistant_snapshot_id=admission.assistant_snapshot_id,
                assistant_context_revision=admission.assistant_context_revision,
            )
            client_turn_id = admission.turn_input.client_user_message_id
            turn_id = await live.steer_runtime(admission.turn_input)
        except ValueError as exc:
            await self._reject_steer(live, queued, TURN_INPUT_INVALID)
            return {
                "ok": False,
                "error": TURN_INPUT_INVALID,
                "detail": str(exc),
            }, HTTP_BAD_REQUEST
        except Exception as exc:
            retryability = getattr(exc, "retryability", None)
            retryability_value = getattr(retryability, "value", retryability)
            self._logger.error(
                RUNTIME_TURN_STEER_FAILED,
                extra={"session_id": live.id, "failure_type": type(exc).__name__},
            )
            if retryability_value == RuntimeRetryability.UNKNOWN_OUTCOME.value:
                await live.persistence.run(
                    live.catalog.fail_queued_submission,
                    live.id,
                    queued_message_id,
                    unknown=True,
                    safe_error=RUNTIME_TURN_STEER_OUTCOME_UNKNOWN,
                )
                await live.publish(
                    PRODUCT_EVENT_SEND_NOW_OUTCOME_UNKNOWN,
                    {
                        **queued_message_payload(queued),
                        "safe_error": RUNTIME_TURN_STEER_OUTCOME_UNKNOWN,
                    },
                    idempotency_key=f"queue:{queued_message_id}:unknown:{queued.operation_seq}",
                )
                return {
                    "ok": False,
                    "error": RUNTIME_TURN_STEER_OUTCOME_UNKNOWN,
                    "unknown_outcome": True,
                }, HTTP_CONFLICT
            await self._reject_steer(live, queued, RUNTIME_TURN_STEER_FAILED)
            return {
                "ok": False,
                "error": RUNTIME_TURN_STEER_FAILED,
            }, HTTP_CONFLICT
        await live.record_user_history(
            admission.display_text,
            references=admission.references,
            turn_id=client_turn_id,
            item_id=client_turn_id,
            assistant_snapshot_id=admission.assistant_snapshot_id,
            assistant_context_revision=admission.assistant_context_revision,
            origin=USER_MESSAGE_ORIGIN_STEER,
        )
        await live.bind_user_history(client_turn_id, vendor_turn_id=turn_id)
        self._release_queued_context(live, client_turn_id)
        if not live.catalog.remove_queued_message(live.id, queued_message_id):
            await live.persistence.run(
                live.catalog.fail_queued_submission,
                live.id,
                queued_message_id,
                unknown=True,
                safe_error=RUNTIME_TURN_STEER_OUTCOME_UNKNOWN,
            )
            await live.publish(
                PRODUCT_EVENT_SEND_NOW_OUTCOME_UNKNOWN,
                {
                    **queued_message_payload(queued),
                    "safe_error": RUNTIME_TURN_STEER_OUTCOME_UNKNOWN,
                },
                idempotency_key=f"queue:{queued_message_id}:unknown:{queued.operation_seq}",
            )
            return {
                "ok": False,
                "error": RUNTIME_TURN_STEER_OUTCOME_UNKNOWN,
            }, HTTP_CONFLICT
        await live.publish(
            PRODUCT_EVENT_SEND_NOW_ACCEPTED,
            {**queued_message_payload(queued), "native_turn_id": turn_id},
            turn_id=turn_id,
            idempotency_key=f"queue:{queued_message_id}:accepted:{queued.operation_seq}",
        )
        await live.publish(
            PRODUCT_EVENT_MESSAGE_REMOVED,
            {"queued_message_id": queued_message_id, "reason": "steered"},
            turn_id=turn_id,
            idempotency_key=f"queue:{queued_message_id}:removed",
        )
        return {
            "ok": True,
            "turn_id": turn_id,
            "queued_message_id": queued_message_id,
        }, HTTP_ACCEPTED

    async def _reject_steer(self, live: LiveSession, queued: Any, safe_error: str) -> None:
        await live.persistence.run(
            live.catalog.fail_queued_submission,
            live.id,
            queued.queued_message_id,
            unknown=False,
            safe_error=safe_error,
        )
        await live.publish(
            PRODUCT_EVENT_SEND_NOW_REJECTED,
            {**queued_message_payload(queued), "safe_error": safe_error},
            idempotency_key=(
                f"queue:{queued.queued_message_id}:rejected:{queued.operation_seq}:{safe_error}"
            ),
        )

    def _freeze_context(
        self,
        live: LiveSession,
        body: Mapping[str, Any],
        admission: TurnAdmission,
        *,
        recovery: Mapping[str, Any] | None = None,
    ) -> AssistantTurnContext | tuple[dict[str, Any], int] | None:
        if self._context_source is None:
            if body.get("assistant_context_revision") is not None:
                return {
                    "ok": False,
                    "error": ASSISTANT_CONTEXT_UNAVAILABLE,
                }, HTTP_CONFLICT
            return None
        snapshot_id = str(body.get(QUEUED_ASSISTANT_SNAPSHOT_ID) or "")
        if snapshot_id:
            result = self._context_source.resume_queued(
                session_id=live.id,
                client_turn_id=(
                    str(recovery["client_id"])
                    if recovery is not None
                    else admission.turn_input.client_user_message_id
                ),
                snapshot_id=snapshot_id,
                question=(
                    str(recovery["question"]) if recovery is not None else admission.display_text
                ),
            )
        else:
            revision = self._expected_context_revision(body)
            active_document = body.get("active_document")
            result = self._context_source.freeze(
                session_id=live.id,
                client_turn_id=admission.turn_input.client_user_message_id,
                expected_revision=revision,
                question=admission.display_text,
                metadata_only=self._task_type(body, admission) in FULLTEXT_GATED_TASK_TYPES,
                active_document=active_document if isinstance(active_document, Mapping) else None,
                selected_literature_ids=self._selected_literature_ids(body),
            )
        if result.failure is None:
            if result.context is None:
                raise RuntimeError("assistant context source returned an empty result")
            return result.context
        return self._context_failure(live, result.failure)

    @staticmethod
    def _task_type(body: Mapping[str, Any], admission: TurnAdmission) -> str:
        raw = str(body.get("task_type") or "").strip()
        if raw and raw not in SUPPORTED_TASK_TYPES:
            raise ValueError("unsupported task type")
        for skill, task_type in TASK_TYPES_BY_SKILL.items():
            if skill in admission.skill_versions:
                return task_type
        return raw

    @staticmethod
    def _selected_literature_ids(body: Mapping[str, Any]) -> tuple[str, ...]:
        selected = body.get("selected_literature_ids", [])
        if selected is None:
            return ()
        if not isinstance(selected, list) or any(not isinstance(item, str) for item in selected):
            raise ValueError("selected_literature_ids must be a list of strings")
        return tuple(selected)

    def _freeze_queued_context(
        self,
        live: LiveSession,
        body: Mapping[str, Any],
        admission: TurnAdmission,
        *,
        recovery: object = None,
    ) -> AssistantTurnContext | tuple[dict[str, Any], int] | None:
        if self._context_source is None:
            if body.get("assistant_context_revision") is not None:
                return {
                    "ok": False,
                    "error": ASSISTANT_CONTEXT_UNAVAILABLE,
                }, HTTP_CONFLICT
            return None
        snapshot_id = str(body.get(QUEUED_ASSISTANT_SNAPSHOT_ID) or "")
        if isinstance(recovery, Mapping) and snapshot_id:
            return self._freeze_context(live, body, admission, recovery=recovery)
        revision = self._expected_context_revision(body)
        active_document = body.get("active_document")
        result = self._context_source.freeze_queued(
            session_id=live.id,
            client_turn_id=admission.turn_input.client_user_message_id,
            expected_revision=revision,
            question=admission.display_text,
            active_document=active_document if isinstance(active_document, Mapping) else None,
            selected_literature_ids=self._selected_literature_ids(body),
        )
        if result.failure is None:
            if result.context is None:
                raise RuntimeError("assistant context source returned an empty result")
            return result.context
        return self._context_failure(live, result.failure)

    def _context_failure(
        self,
        live: LiveSession,
        failure: AssistantContextFailure,
    ) -> tuple[dict[str, Any], int]:
        status = (
            HTTP_CONFLICT
            if failure.kind
            in (
                AssistantContextFailureKind.REVISION_REQUIRED,
                AssistantContextFailureKind.REVISION_CONFLICT,
                AssistantContextFailureKind.IDEMPOTENCY_CONFLICT,
            )
            else HTTP_BAD_REQUEST
        )
        issues = [
            {
                "ref_id": issue.ref_id,
                "kind": issue.kind.value,
                "label": issue.label,
                **({"label_fallback": issue.label_fallback.value} if issue.label_fallback else {}),
                **(
                    {"selection_source_label": issue.selection_source_label}
                    if issue.selection_source_label is not None
                    else {}
                ),
                "state": issue.state.value,
                "reason": issue.reason,
            }
            for issue in failure.issues
        ]
        error = f"assistant_context_{failure.kind.value}"
        if issues:
            self._logger.info(
                error,
                extra={
                    "session_id": live.id,
                    "snapshot_id": failure.snapshot_id,
                    "issues": issues,
                },
            )
        return {
            "ok": False,
            "error": error,
            "detail": failure.detail,
            "latest_revision": failure.latest_revision,
            "snapshot_id": failure.snapshot_id,
            "issues": issues,
        }, status

    def _release_queued_context(self, live: LiveSession, client_turn_id: str) -> None:
        self._finalize_context(live.id, client_turn_id, AssistantTurnFinalization.REJECTED)

    def _discard_queued_context(self, live: LiveSession, client_turn_id: str) -> None:
        self._finalize_context(live.id, client_turn_id, AssistantTurnFinalization.DISCARDED)

    def _require_turn_content(
        self,
        live: LiveSession,
        admission: TurnAdmission,
        context: AssistantTurnContext | None,
    ) -> None:
        if admission.turn_input.items:
            return
        if (
            context is not None
            and context.model_context
            and any(
                item.ref.origin is ContextOrigin.EXPLICIT
                and (
                    item.state is ContextResolutionState.READY
                    or (
                        item.state is ContextResolutionState.TRUNCATED
                        and bool(item.excerpt_text or item.model_locator)
                    )
                )
                for item in context.snapshot.items
            )
        ):
            return
        if context is not None:
            self._release_queued_context(live, admission.turn_input.client_user_message_id)
        raise ValueError(TURN_INPUT_REQUIRED)

    @staticmethod
    def _with_context(
        admission: TurnAdmission,
        context: AssistantTurnContext,
    ) -> TurnAdmission:
        items = admission.turn_input.items
        if context.model_context:
            items = (
                InputItem(InputKind.TEXT, text=context.model_context),
                *items,
            )
        return TurnAdmission(
            turn_input=TurnInput(
                items,
                client_user_message_id=admission.turn_input.client_user_message_id,
                collaboration_mode=admission.turn_input.collaboration_mode,
            ),
            display_text=admission.display_text,
            skill_versions=admission.skill_versions,
            references=(*admission.references, *context.surface_refs),
            assistant_snapshot_id=context.snapshot.snapshot_id,
            assistant_context_revision=context.snapshot.selection_revision,
        )

    @staticmethod
    def _expected_context_revision(body: Mapping[str, Any]) -> int | None:
        raw = body.get("assistant_context_revision")
        if raw is None:
            return None
        if isinstance(raw, bool):
            raise ValueError(ASSISTANT_CONTEXT_REVISION_INVALID)
        try:
            revision = int(raw)
        except (TypeError, ValueError) as exc:
            raise ValueError(ASSISTANT_CONTEXT_REVISION_INVALID) from exc
        if revision < 0:
            raise ValueError(ASSISTANT_CONTEXT_REVISION_INVALID)
        return revision

    def _continuation_input(self, live: LiveSession, body: Mapping[str, Any]) -> Mapping[str, Any]:
        turn_id = body.get(CONTINUE_TURN_ID)
        items = body.get("input")
        if not isinstance(turn_id, str) or not isinstance(items, list) or self._events is None:
            return body
        if any(
            isinstance(item, Mapping) and item.get("type") == InputKind.SKILL.value
            for item in items
        ):
            return body
        original = self._events.original_user_message_for_turn(live.id, turn_id)
        if original is None:
            return body
        references = original.payload.get("refs")
        if not isinstance(references, list):
            return body
        skills = [
            reference
            for reference in references
            if isinstance(reference, Mapping) and reference.get("type") == PRODUCT_REFERENCE_SKILL
        ]
        if len(skills) != 1:
            return body
        skill = skills[0]
        if not all(
            isinstance(skill.get(key), str) and skill[key].strip()
            for key in ("id", "path", "status")
        ):
            return body
        return {
            **body,
            "input": [
                *items,
                {
                    "type": InputKind.SKILL.value,
                    "name": skill["id"],
                    "path": skill["path"],
                    "version": skill["status"],
                },
            ],
        }

    async def _typed_input(
        self,
        live: LiveSession,
        body: Mapping[str, Any],
        *,
        validate_skill_inventory: bool = True,
        allow_context_only: bool = False,
    ) -> TurnAdmission:
        raw_items = body.get("input")
        if not isinstance(raw_items, list) or (not raw_items and not allow_context_only):
            raise ValueError(TURN_INPUT_REQUIRED)
        items: list[InputItem] = []
        display_parts: list[str] = []
        skill_versions: dict[str, str] = {}
        references: list[MessageReferencePayload] = []
        for raw in raw_items:
            if not isinstance(raw, Mapping):
                raise ValueError("turn input item must be an object")
            try:
                kind = InputKind(str(raw.get("type") or ""))
            except ValueError as exc:
                raise ValueError(f"unsupported turn input type: {raw.get('type')!r}") from exc
            text = str(raw.get("text") or "")
            name = str(raw.get("name") or "")
            reference_id = str(raw.get("reference_id") or "").strip()
            path = self._input_path(live, kind, raw.get("path"))
            if kind == InputKind.TEXT:
                if reference_id:
                    raise ValueError("text input does not accept a file reference id")
                if not text:
                    raise ValueError("text input must not be empty")
                display_parts.append(text)
            elif kind == InputKind.SKILL:
                if reference_id:
                    raise ValueError("skill input does not accept a file reference id")
                if not name or path is None:
                    raise ValueError("skill input requires name and path")
                selected_version = str(raw.get("version") or "").strip()
                self._require_existing_file(path)
                canonical_version = (
                    await self._require_allowed_skill(live, path, name, selected_version)
                    if validate_skill_inventory
                    else selected_version
                )
                skill_versions[name] = canonical_version
                references.append(
                    {
                        "type": PRODUCT_REFERENCE_SKILL,
                        "id": name,
                        "title": name,
                        "status": canonical_version,
                        "path": str(path),
                    }
                )
            else:
                if kind == InputKind.DIRECTORY and (not reference_id or path is not None):
                    raise ValueError("directory input requires a registered reference id")
                if reference_id:
                    if path is not None:
                        raise ValueError("file input accepts either path or reference id")
                    path = live.resolve_local_input_path(reference_id, kind)
                    if path is None:
                        raise ValueError("local path reference is not authorized for this session")
                    if kind == InputKind.DIRECTORY:
                        self._require_existing_directory(path)
                    else:
                        self._require_existing_file(path)
                elif path is None:
                    raise ValueError(f"{kind.value} input requires path or reference id")
                else:
                    self._require_allowed_file(live, path)
                reference: MessageReferencePayload = {
                    "type": (
                        PRODUCT_REFERENCE_DIRECTORY
                        if kind == InputKind.DIRECTORY
                        else PRODUCT_REFERENCE_FILE
                    ),
                    "id": reference_id or str(path),
                    "title": name or path.name,
                    "path": str(path),
                    "media_type": str(raw.get("media_type") or ""),
                    "sha256": str(raw.get("sha256") or ""),
                }
                if kind != InputKind.DIRECTORY:
                    reference["size"] = path.stat().st_size
                if reference_id:
                    reference["reference_id"] = reference_id
                    reference["origin"] = (
                        PRODUCT_REFERENCE_ORIGIN_LOCAL_DIRECTORY
                        if kind == InputKind.DIRECTORY
                        else PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE
                    )
                references.append(reference)
            items.append(InputItem(kind=kind, text=text, path=path, name=name))
        supplied_client_id = str(body.get("client_user_message_id") or "").strip()
        if body.get("assistant_context_revision") is not None and not supplied_client_id:
            raise ValueError(ASSISTANT_CONTEXT_CLIENT_ID_REQUIRED)
        client_id = supplied_client_id or uuid.uuid4().hex
        try:
            collaboration_mode = CollaborationMode(
                str(body.get("collaboration_mode") or CollaborationMode.DEFAULT.value)
            )
        except ValueError as exc:
            raise ValueError("unsupported collaboration mode") from exc
        return TurnAdmission(
            turn_input=TurnInput(
                tuple(items),
                client_user_message_id=client_id,
                collaboration_mode=collaboration_mode,
            ),
            display_text="\n".join(display_parts),
            skill_versions=skill_versions,
            references=tuple(references),
        )

    @staticmethod
    def _input_path(
        live: LiveSession,
        kind: InputKind,
        value: object,
    ) -> Path | None:
        if kind == InputKind.TEXT:
            return None
        raw = str(value or "").strip()
        if not raw:
            return None
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = live.runtime_workdir / path
        return path.resolve()

    @staticmethod
    def _require_allowed_file(live: LiveSession, path: Path) -> None:
        TurnService._require_existing_file(path)
        try:
            path.relative_to(live.runtime_workdir)
        except ValueError as exc:
            raise ValueError("input file must belong to this session workspace") from exc

    @staticmethod
    def _require_existing_file(path: Path) -> None:
        if not path.exists() or not path.is_file():
            raise ValueError(f"input file does not exist: {path}")

    @staticmethod
    def _require_existing_directory(path: Path) -> None:
        if path.is_symlink() or path.is_junction() or not path.is_dir():
            raise ValueError(f"input directory does not exist: {path}")

    @staticmethod
    async def _require_allowed_skill(
        live: LiveSession,
        path: Path,
        name: str,
        selected_version: str,
    ) -> str:
        if not path.exists() or not path.is_file():
            raise ValueError(f"skill file does not exist: {path}")
        identity = await live.skill_identity(path, name)
        if identity is None:
            raise ValueError("skill must be enabled in this Codex session inventory")
        canonical_version = str(identity.get("version") or "")
        if selected_version and selected_version != canonical_version:
            raise ValueError("skill version does not match the current Codex inventory")
        return canonical_version

    async def _execute(
        self,
        live: LiveSession,
        turn_input: TurnInput,
    ) -> TurnResult:
        with self._activities.enter(ActivityDomain.TURN) as activity:
            live.turn_activity = activity
            try:
                return await self._execute_turn(live, turn_input)
            finally:
                if live.turn_activity is activity:
                    live.turn_activity = None

    async def _execute_turn(
        self,
        live: LiveSession,
        turn_input: TurnInput,
    ) -> TurnResult:
        should_drain = False
        runtime_result: RuntimeTurnResult | None = None
        interrupt_generation = live.interrupt_generation

        def intent() -> tuple[object, ...]:
            record = live.catalog.get(live.id)
            model = live.catalog.model_state(live.id)
            return (
                live.model_id,
                live.user_id,
                live.runtime_workdir,
                live.project_path,
                live.output_root,
                live.writable_roots,
                tuple(sorted(live.process_environment.items())),
                record.policy_id if record is not None else None,
                model.selected_model_id,
                model.selected_reasoning_effort,
                model.selected_thinking,
                self._activities.snapshot().maintenance_revision,
            )

        original_intent = intent()

        async def authorize_retry(proof: SubmissionRetryProof) -> Callable[[], bool]:
            runtime = live.runtime_session
            queued = live.catalog.queued_message(live.id, turn_input.client_user_message_id)
            if (
                runtime is None
                or runtime.binding != proof.binding
                or proof.command_id != turn_input.client_user_message_id
                or queued is None
                or queued.state is not QueuedMessageState.SUBMITTING
                or queued.native_turn_id
                or intent() != original_intent
                or live.interrupt_generation != interrupt_generation
            ):
                raise RuntimeError(RECOVERY_STALE)

            def recovery_current() -> bool:
                return True

            if self.recovery is not None:
                recovery_current = await self.recovery.retry_unsubmitted(live, proof)
            operation_seq = queued.operation_seq

            def current() -> bool:
                current_queued = live.catalog.queued_message(live.id, proof.command_id)
                return (
                    not self._closed
                    and self._sessions.get(live.id) is live
                    and live.runtime_session is runtime
                    and runtime.binding == proof.binding
                    and intent() == original_intent
                    and live.interrupt_generation == interrupt_generation
                    and not live.terminating
                    and not live.terminated
                    and not live.pending_hil_snapshot()
                    and not live.ledger.uncertainty_snapshot()
                    and self._activities.snapshot().phase is ActivityPhase.OPEN
                    and current_queued is not None
                    and current_queued.state is QueuedMessageState.SUBMITTING
                    and current_queued.operation_seq == operation_seq
                    and not current_queued.native_turn_id
                    and recovery_current()
                )

            return current

        live.submission_retry_authorizer = authorize_retry
        try:
            replaced = False
            frozen_request = None
            while True:
                try:
                    async with live.turn_lock:
                        runtime_result = (
                            await live.run_runtime(turn_input)
                            if frozen_request is None
                            else await live.run_runtime(turn_input, frozen_request=frozen_request)
                        )
                    break
                except RuntimeTurnNotSubmittedError as error:
                    if (
                        replaced
                        or live.recover_empty is None
                        or turn_input.admission is not None
                        or error.request is None
                        or live.interrupt_generation != interrupt_generation
                        or error.proof.command_id != turn_input.client_user_message_id
                    ):
                        raise
                    replaced = True
                    try:
                        fence = await live.recover_empty(error.proof)
                    except RuntimeOpenNotAppliedError:
                        replacement = live.catalog.replacement(live.id)
                        if (
                            replacement is None
                            or replacement["proof_id"] != error.proof.proof_id
                            or replacement["state"] is not ReplacementState.NOT_APPLIED
                        ):
                            raise
                        runtime_result = RuntimeTurnResult(
                            turn_input.client_user_message_id,
                            "",
                            RuntimeTurnOutcome.FAILED,
                            safe_error=RUNTIME_TURN_NOT_SUBMITTED,
                        )
                        break
                    if live.interrupt_generation != interrupt_generation:
                        raise
                    if self.recovery is not None:
                        recovery_current = await self.recovery.replace_unsubmitted(
                            live, error.proof
                        )
                        attachment_current = fence.current

                        def current_attachment(
                            attachment_current: Callable[[], bool] = attachment_current,
                            recovery_current: Callable[[], bool] = recovery_current,
                        ) -> bool:
                            return attachment_current() and recovery_current()

                        fence = replace(fence, current=current_attachment)
                    turn_input = replace(
                        turn_input,
                        admission=fence,
                        submission_deadline=error.proof.submission_deadline,
                        submission_attempts=error.proof.submission_attempts,
                    )
                    frozen_request = error.request
            settled = await self._settle_pending_turn(live, turn_input.client_user_message_id)
            native_turn_id = (
                settled.native_turn_id
                if settled is not None
                else runtime_result.native_turn_id or runtime_result.command_id
            )
            not_submitted = (
                runtime_result.outcome is RuntimeTurnOutcome.FAILED
                and runtime_result.safe_error == RUNTIME_TURN_NOT_SUBMITTED
                and not runtime_result.native_turn_id
            )
            if not_submitted:
                await live.ledger.record_turn_failure(
                    turn_input.client_user_message_id,
                    code=RUNTIME_TURN_NOT_SUBMITTED,
                    message="Agent runtime turn was not submitted",
                )
            else:
                await live.bind_user_history(
                    turn_input.client_user_message_id,
                    vendor_turn_id=native_turn_id,
                )
            outcome = (
                RuntimeTurnOutcome.INTERRUPTED
                if live.interrupt_generation != interrupt_generation
                else (
                    TURN_SETTLEMENT_OUTCOMES[settled.event.kind]
                    if settled is not None
                    else runtime_result.outcome
                )
            )
            status = {
                RuntimeTurnOutcome.COMPLETED: TurnStatus.COMPLETED,
                RuntimeTurnOutcome.FAILED: TurnStatus.FAILED,
                RuntimeTurnOutcome.INTERRUPTED: TurnStatus.INTERRUPTED,
                RuntimeTurnOutcome.UNKNOWN: TurnStatus.FAILED,
            }[outcome]
            result = TurnResult(
                turn_id=native_turn_id,
                status=status,
                final_text=runtime_result.final_text,
                error=(
                    runtime_result.safe_error
                    if settled is None or settled.event.kind is RuntimeEventKind.TURN_UNKNOWN
                    else (
                        str(settled.event.payload.get("safe_error") or "")
                        if isinstance(settled.event.payload, dict)
                        else ""
                    )
                ),
            )
            self._finalize_context(
                live.id,
                turn_input.client_user_message_id,
                self._context_outcome(outcome),
            )
            await self._finish_delivery(
                live,
                turn_input,
                status,
                runtime_outcome=outcome,
                event_turn_id=result.turn_id,
            )
            await self._settle_queued_outcome(
                live, turn_input.client_user_message_id, outcome, result.error
            )
            await live.persistence.run(live.catalog.clear_turn_settlement, live.id, result.turn_id)
            should_drain = outcome is RuntimeTurnOutcome.COMPLETED
            return result
        except asyncio.CancelledError:
            if live.catalog.pending_turn_settlement(live.id) is not None:
                raise
            if (
                runtime_result is not None
                and runtime_result.outcome is not RuntimeTurnOutcome.UNKNOWN
            ):
                await self._complete_queued(live, turn_input.client_user_message_id)
            else:
                await self._fail_queued(
                    live, turn_input.client_user_message_id, TURN_OUTCOME_UNCONFIRMED, unknown=True
                )
            self._finalize_context(
                live.id,
                turn_input.client_user_message_id,
                self._context_outcome(
                    runtime_result.outcome if runtime_result is not None else None
                ),
            )
            if live.terminating or live.terminated:
                result = TurnResult(
                    turn_id=turn_input.client_user_message_id,
                    status=TurnStatus.INTERRUPTED,
                )
                await self._finish_delivery(
                    live, turn_input, result.status, event_turn_id=result.turn_id
                )
                return result
            await self._finish_delivery(
                live,
                turn_input,
                TurnStatus.INTERRUPTED,
                event_turn_id=live.ledger.active_turn_id,
            )
            raise
        except Exception as exc:
            if live.catalog.pending_turn_settlement(live.id) is not None:
                self._logger.error(
                    "turn_settlement_deferred session_id=%s failure_type=%s",
                    live.id,
                    type(exc).__name__,
                    exc_info=True,
                )
                raise
            rejected = isinstance(exc, RuntimeCommandError) and exc.receipt.state in (
                CommandState.REJECTED,
                CommandState.UNSUPPORTED,
                CommandState.RESTART_REQUIRED,
            )
            if (
                runtime_result is not None
                and runtime_result.outcome is not RuntimeTurnOutcome.UNKNOWN
            ):
                await self._complete_queued(live, turn_input.client_user_message_id)
            else:
                await self._fail_queued(
                    live,
                    turn_input.client_user_message_id,
                    RUNTIME_TURN_FAILED,
                    unknown=not rejected,
                )
            context_outcome = self._context_outcome(
                runtime_result.outcome if runtime_result is not None else None,
                rejected=rejected,
            )
            self._finalize_context(live.id, turn_input.client_user_message_id, context_outcome)
            if live.terminating or live.terminated:
                result = TurnResult(
                    turn_id=turn_input.client_user_message_id,
                    status=TurnStatus.INTERRUPTED,
                )
                await self._finish_delivery(
                    live, turn_input, result.status, event_turn_id=result.turn_id
                )
                return result
            retryability = getattr(exc, "retryability", None)
            failure_code = RUNTIME_TURN_FAILED
            live.trace_turn_execution_failed(
                failure_type=type(exc).__name__,
                retryability=str(getattr(retryability, "value", retryability) or ""),
                failure_code=(failure_code if failure_code != RUNTIME_TURN_FAILED else ""),
            )
            self._logger.error(
                RUNTIME_TURN_FAILED,
                extra={"session_id": live.id, "failure_type": type(exc).__name__},
            )
            failed_request = live.catalog.queued_message(live.id, turn_input.client_user_message_id)
            failure_turn_id = (
                (failed_request.native_turn_id if failed_request is not None else "")
                or live.ledger.active_turn_id
                or turn_input.client_user_message_id
            )
            if (
                failed_request is None
                or failed_request.state is not QueuedMessageState.OUTCOME_UNKNOWN
            ):
                await live.ledger.record_turn_failure(
                    failure_turn_id,
                    code=failure_code,
                    message="Agent runtime turn failed",
                )
            result = TurnResult(
                turn_id=failure_turn_id,
                status=TurnStatus.FAILED,
                error=failure_code,
            )
            await self._finish_delivery(
                live, turn_input, result.status, event_turn_id=result.turn_id
            )
            return result
        finally:
            live.submission_retry_authorizer = None
            live.active_assistant_snapshot_id = ""
            live.active_assistant_revision = None
            live.active_skill_presentation = None
            live.clear_task_lease()
            live.current_task = None
            if live.catalog.pending_turn_settlement(live.id) is not None and not live.terminated:
                self.resume_pending_settlement(live)
            await live.release_product_turn(turn_input.client_user_message_id)
            if should_drain:
                asyncio.create_task(self._drain_next(live))

    async def _settle_pending_turn(
        self, live: LiveSession, client_turn_id: str
    ) -> PendingTurnSettlement | None:
        pending = live.catalog.pending_turn_settlement(live.id)
        if pending is None:
            return None
        if pending.client_turn_id != client_turn_id:
            raise SessionStateConflictError("pending turn settlement identity mismatch")
        last_activity: tuple[bool, tuple[str, ...], bool] | None = None
        while not live.terminating and not live.terminated:
            pending = live.catalog.pending_turn_settlement(live.id)
            if pending is None:
                return None
            if pending.client_turn_id != client_turn_id:
                raise SessionStateConflictError("pending turn settlement identity mismatch")
            proof = getattr(live, "thread_replacement_proof", None)
            if (
                isinstance(proof, ThreadReplacementProof)
                and proof.binding == live.catalog.runtime_binding(live.id)
                and proof.command_id == pending.client_turn_id
                and pending.event.kind is RuntimeEventKind.TURN_UNKNOWN
                and pending.event.native_session_id == proof.binding.opaque_session_ref
                and pending.event.process_generation == proof.failed_generation
                and not live.pending_hil_snapshot()
            ):
                if await live.settle_product_turn(pending.event):
                    return pending
            session = live.runtime_session
            if session is None:
                await live.persistence.run(live.catalog.mark_turn_recovery_blocked, live.id, True)
                return None
            try:
                activity = await session.activity()
            except Exception:
                self._logger.warning(
                    "turn_settlement_activity_unavailable session_id=%s",
                    live.id,
                    exc_info=True,
                )
            else:
                if activity.execution_tree_complete:
                    await live.persistence.run(
                        live.catalog.mark_turn_recovery_blocked, live.id, False
                    )
                has_pending_hil = bool(live.pending_hil_snapshot())
                current_activity = (
                    activity.execution_tree_complete,
                    activity.execution_tree_blockers,
                    has_pending_hil,
                )
                if current_activity != last_activity:
                    self._logger.info(
                        "turn_settlement_activity session_id=%s native_turn_id=%s "
                        "complete=%s blockers=%s pending_hil=%s activity_blockers=%s",
                        live.id,
                        pending.native_turn_id,
                        current_activity[0],
                        current_activity[1],
                        current_activity[2],
                        activity.blockers,
                    )
                    last_activity = current_activity
                if activity.execution_tree_idle and not has_pending_hil:
                    if await live.settle_product_turn(pending.event):
                        return pending
            await asyncio.sleep(TURN_SETTLEMENT_POLL_SECONDS)
        return None

    def resume_pending_settlement(self, live: LiveSession) -> None:
        if self._closed or live.closing:
            return
        pending = live.catalog.pending_turn_settlement(live.id)
        if pending is None:
            return
        live.active_product_turn_id = pending.client_turn_id
        task = self._activities.spawn(
            ActivityDomain.SETTLEMENT, lambda: self._recover_pending_settlement(live)
        )
        live.current_task = task

    async def _recover_pending_settlement(self, live: LiveSession) -> None:
        with self._activities.enter(ActivityDomain.SETTLEMENT) as activity:
            live.turn_activity = activity
            try:
                await self._recover_settlement(live)
            finally:
                if live.turn_activity is activity:
                    live.turn_activity = None

    async def _recover_settlement(self, live: LiveSession) -> None:
        pending = live.catalog.pending_turn_settlement(live.id)
        if pending is None:
            return
        should_drain = False
        try:
            await live.ledger.activate_turn(pending.native_turn_id)
            while not live.terminating and not live.terminated:
                try:
                    settled = await self._settle_pending_turn(live, pending.client_turn_id)
                    if settled is None:
                        return
                    pending = settled
                    outcome = TURN_SETTLEMENT_OUTCOMES[pending.event.kind]
                    self._finalize_context(
                        live.id,
                        pending.client_turn_id,
                        self._context_outcome(outcome),
                    )
                    await self._finish_delivery(
                        live,
                        TurnInput((), pending.client_turn_id),
                        TurnStatus(
                            outcome.value if outcome is not RuntimeTurnOutcome.UNKNOWN else "failed"
                        ),
                        runtime_outcome=outcome,
                        event_turn_id=pending.native_turn_id,
                    )
                    await self._settle_queued_outcome(
                        live,
                        pending.client_turn_id,
                        outcome,
                        (
                            str(pending.event.payload.get("safe_error") or "")
                            if isinstance(pending.event.payload, Mapping)
                            else ""
                        ),
                        native_turn_id=pending.native_turn_id,
                    )
                    await live.persistence.run(
                        live.catalog.clear_turn_settlement, live.id, pending.native_turn_id
                    )
                    should_drain = outcome is RuntimeTurnOutcome.COMPLETED
                    return
                except Exception:
                    self._logger.error(
                        "turn_settlement_recovery_failed session_id=%s",
                        live.id,
                        exc_info=True,
                    )
                    await asyncio.sleep(TURN_SETTLEMENT_POLL_SECONDS)
        finally:
            live.current_task = None
            await live.release_product_turn(pending.client_turn_id)
            if should_drain:
                asyncio.create_task(self._drain_next(live))

    async def _settle_queued_outcome(
        self,
        live: LiveSession,
        request_id: str,
        outcome: RuntimeTurnOutcome,
        safe_error: str,
        *,
        native_turn_id: str = "",
    ) -> None:
        if outcome is RuntimeTurnOutcome.UNKNOWN:
            await self._fail_queued(live, request_id, TURN_OUTCOME_UNCONFIRMED, unknown=True)
        elif outcome is RuntimeTurnOutcome.FAILED and safe_error == RUNTIME_TURN_NOT_SUBMITTED:
            await self._fail_queued(live, request_id, RUNTIME_TURN_NOT_SUBMITTED, unknown=False)
        else:
            queued = live.catalog.queued_message(live.id, request_id) if native_turn_id else None
            uncertainty = (
                live.catalog.uncertainty(live.id, UncertaintyKind.TURN, native_turn_id)
                if queued is not None
                else None
            )
            if (
                queued is not None
                and queued.state is QueuedMessageState.OUTCOME_UNKNOWN
                and queued.native_turn_id == native_turn_id
                and uncertainty is not None
                and uncertainty.state is UncertaintyState.RECONCILED
            ):
                if await live.persistence.run(
                    live.catalog.remove_reconciled_unknown_message,
                    live.id,
                    request_id,
                    int(queued.operation_seq or 0),
                ):
                    await live.publish(
                        PRODUCT_EVENT_MESSAGE_REMOVED,
                        {
                            "queued_message_id": request_id,
                            "reason": QueuedMessageState.COMPLETED.value,
                        },
                        turn_id=native_turn_id,
                        idempotency_key=f"queue:{request_id}:native-reconciled:{queued.operation_seq}",
                    )
                return
            await self._complete_queued(live, request_id)

    async def _complete_queued(self, live: LiveSession, request_id: str) -> None:
        if await live.persistence.run(live.catalog.complete_queued_message, live.id, request_id):
            await live.publish(
                PRODUCT_EVENT_MESSAGE_REMOVED,
                {"queued_message_id": request_id, "reason": "completed"},
                idempotency_key=f"queue:{request_id}:completed",
            )

    async def _finish_delivery(
        self,
        live: LiveSession,
        turn_input: TurnInput,
        status: TurnStatus,
        *,
        runtime_outcome: RuntimeTurnOutcome | None = None,
        event_turn_id: str | None = None,
    ) -> None:
        if self._deliveries is None or live.project_path is None:
            return
        outcomes = {
            TurnStatus.COMPLETED: TurnOutcome.COMPLETED,
            TurnStatus.FAILED: TurnOutcome.FAILED,
            TurnStatus.INTERRUPTED: TurnOutcome.INTERRUPTED,
        }
        try:
            capture = await self._deliveries.finish_turn(
                live.id,
                turn_input.client_user_message_id,
                (
                    TurnOutcome(runtime_outcome.value)
                    if runtime_outcome is not None
                    else outcomes.get(status, TurnOutcome.UNKNOWN)
                ),
            )
            if capture.batch_id and capture.project_id:
                await live.publish(
                    PRODUCT_EVENT_REVIEW_READY,
                    {
                        "batch_id": capture.batch_id,
                        "project_id": capture.project_id,
                        "paths": list(capture.paths),
                        "file_ids": list(capture.file_ids),
                        "review_ids": list(capture.review_ids),
                    },
                    turn_id=event_turn_id or turn_input.client_user_message_id,
                    idempotency_key=f"review:{capture.batch_id}:ready",
                )
        except Exception as exc:  # noqa: BLE001 - runtime terminal already occurred
            self._logger.error(
                RESOURCE_DELIVERY_FAILED,
                extra={
                    "session_id": live.id,
                    "turn_id": turn_input.client_user_message_id,
                    "failure_type": type(exc).__name__,
                },
                exc_info=True,
            )

    async def _drain_next(self, live: LiveSession) -> None:
        if self._closed or live.closing:
            return
        async with live.lifecycle_lock:
            try:
                with self._activities.enter(ActivityDomain.TURN, root=True):
                    self._schedule_locked(live)
                    return
            except MaintenanceActive:
                self._defer_queue(live)

    def _defer_queue(self, live: LiveSession) -> None:
        if live.id in self._queue_waiters or self._closed:
            return
        task = asyncio.create_task(self._resume_queue(live))
        self._queue_waiters[live.id] = task

        def finished(done: asyncio.Task[None]) -> None:
            if self._queue_waiters.get(live.id) is done:
                self._queue_waiters.pop(live.id, None)
            if not done.cancelled() and done.exception() is not None:
                self._logger.error("queued turn resume failed session_id=%s", live.id)

        task.add_done_callback(finished)

    async def _resume_queue(self, live: LiveSession) -> None:
        # This is a dormant queue watcher, not executing work. Control requests
        # must return while paused instead of waiting for maintenance to finish.
        while not self._closed and not live.closing:
            await self._activities.wait_open()
            async with live.lifecycle_lock:
                try:
                    with self._activities.enter(ActivityDomain.TURN, root=True):
                        self._schedule_locked(live)
                        return
                except MaintenanceActive:
                    continue

    @staticmethod
    def _context_outcome(
        outcome: RuntimeTurnOutcome | None, *, rejected: bool = False
    ) -> AssistantTurnFinalization:
        if outcome is RuntimeTurnOutcome.COMPLETED:
            return AssistantTurnFinalization.ACCEPTED
        if outcome is RuntimeTurnOutcome.UNKNOWN or (outcome is None and not rejected):
            return AssistantTurnFinalization.UNKNOWN
        return AssistantTurnFinalization.REJECTED

    def _finalize_context(
        self,
        session_id: str,
        client_turn_id: str,
        outcome: AssistantTurnFinalization,
    ) -> None:
        if self._context_source is None:
            return
        try:
            self._context_source.finalize(
                session_id=session_id,
                client_turn_id=self._context_owner(session_id, client_turn_id),
                outcome=outcome,
            )
        except Exception as exc:  # noqa: BLE001 - turn outcome must not be rewritten by cleanup
            self._logger.error(
                ASSISTANT_CONTEXT_FINALIZE_FAILED,
                extra={
                    "session_id": session_id,
                    "client_turn_id": client_turn_id,
                    "outcome": outcome.value,
                    "failure_type": type(exc).__name__,
                },
                exc_info=True,
            )

    def _context_owner(self, session_id: str, client_turn_id: str) -> str:
        queued = (
            self._catalog.queued_message(session_id, client_turn_id)
            if self._catalog is not None
            else None
        )
        if queued is not None and queued.purpose == QUEUE_PURPOSE_RECOVERY:
            source = queued.body.get(RECOVERY_SOURCE)
            if isinstance(source, Mapping) and isinstance(source.get("client_id"), str):
                return source["client_id"]
        return client_turn_id

    def _complete_recovered_context(self, live: LiveSession, client_id: str) -> None:
        if self._context_source is not None:
            self._context_source.finalize(
                session_id=live.id,
                client_turn_id=self._context_owner(live.id, client_id),
                outcome=AssistantTurnFinalization.ACCEPTED,
            )

    @staticmethod
    def _result_payload(result: TurnResult) -> dict[str, Any]:
        return {
            "ok": result.status == TurnStatus.COMPLETED,
            "turn_id": result.turn_id,
            "status": result.status.value,
            "error": (
                result.error
                if result.error in TURN_RESULT_SAFE_ERRORS
                else RUNTIME_TURN_FAILED if result.error else None
            ),
        }


__all__ = ["TurnService"]
