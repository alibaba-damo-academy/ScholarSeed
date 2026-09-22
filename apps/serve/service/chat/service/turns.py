"""Typed product-turn admission and runtime gateway execution."""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Protocol

from scholarseed_runtime.contract.command import CommandState
from scholarseed_runtime.contract.history import TurnStatus
from scholarseed_runtime.contract.incident import RuntimeRetryability
from scholarseed_runtime.contract.input import (
    CollaborationMode,
    InputItem,
    InputKind,
    TurnInput,
)
from scholarseed_runtime.contract.resource import RESOURCE_CANCELLED, ResourceReceipt
from scholarseed_runtime.gateway.driver import (
    RuntimeCommandError,
    RuntimeTurnOutcome,
    RuntimeTurnResult,
)
from service.chat.constants import (
    PRODUCT_EVENT_MESSAGE_QUEUED,
    PRODUCT_EVENT_MESSAGE_REMOVED,
    PRODUCT_EVENT_MESSAGE_UPDATED,
    PRODUCT_EVENT_REVIEW_READY,
    PRODUCT_EVENT_SEND_NOW_ACCEPTED,
    PRODUCT_EVENT_SEND_NOW_OUTCOME_UNKNOWN,
    PRODUCT_EVENT_SEND_NOW_REJECTED,
    PRODUCT_EVENT_SEND_NOW_SUBMITTED,
    PRODUCT_REFERENCE_DIRECTORY,
    PRODUCT_REFERENCE_FILE,
    PRODUCT_REFERENCE_ORIGIN_LOCAL_DIRECTORY,
    PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE,
    PRODUCT_REFERENCE_SKILL,
    PRODUCT_TURN_OUTCOME_UNKNOWN,
    QUEUED_ASSISTANT_REFERENCES,
    RUNTIME_CAPABILITY_UNAVAILABLE,
    SESSION_TERMINATED,
    TURN_OUTCOME_UNCONFIRMED,
    USER_MESSAGE_ORIGIN_STEER,
)
from service.chat.persistence.catalog import (
    QUEUE_SUBMITTABLE_STATES,
    QueuedMessageState,
    SessionCatalogStore,
    SessionQueueCapacityError,
    SessionStateConflictError,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.activation import ACTIVATION_SAFE_ERRORS, SessionActivationError
from service.chat.runtime.live import LiveSession
from service.chat.runtime.projection import queued_message_payload
from service.identity.service.skill_credentials import CredentialAdmissionError
from service.platform.context import (
    AssistantContextFailure,
    AssistantContextFailureKind,
    AssistantTurnContext,
    AssistantTurnContextSource,
    AssistantTurnFinalization,
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
RESOURCE_DELIVERY_FAILED = "resource_delivery_failed"
RESOURCE_REVIEW_REQUIRED = "resource_review_required"
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
        RESOURCE_REVIEW_REQUIRED,
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


class ResourceReviewAdmission(Protocol):
    def has_open_for_workdir(self, workdir: str) -> bool: ...


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
        prepare: TurnPreparation | None = None,
        context_source: AssistantTurnContextSource | None = None,
        deliveries: ResourceDeliveryService | None = None,
        review_batches: ResourceReviewAdmission | None = None,
        catalog: SessionCatalogStore | None = None,
        events: ProductEventStore | None = None,
    ) -> None:
        self._sessions = sessions
        self._logger = logger
        self._prepare = prepare
        self._context_source = context_source
        self._deliveries = deliveries
        self._review_batches = review_batches
        self._catalog = catalog
        self._events = events

    def bind_context_source(self, source: AssistantTurnContextSource) -> None:
        """在应用组合阶段绑定唯一的产品上下文来源。"""

        if self._context_source is not None and self._context_source is not source:
            raise RuntimeError("turn context source is already bound")
        self._context_source = source

    async def post(
        self,
        session_id: str,
        body: Mapping[str, Any],
        *,
        side: bool,
    ) -> tuple[dict[str, Any], int]:
        live = self._sessions.get(session_id)
        if live is None:
            return {"ok": False, "error": "session_not_live"}, HTTP_NOT_FOUND
        if side:
            return await self._steer(live, body)
        task: asyncio.Task[TurnResult] | None = None
        async with live.lifecycle_lock:
            if self._sessions.get(session_id) is not live:
                return {"ok": False, "error": SESSION_NOT_LIVE}, HTTP_NOT_FOUND
            if live.interrupting:
                return {"ok": False, "error": TURN_INTERRUPTING}, HTTP_CONFLICT
            if live.terminating or live.terminated:
                return {"ok": False, "error": SESSION_TERMINATED}, HTTP_CONFLICT
            if live.ledger.has_unknown_outcome:
                return {"ok": False, "error": TURN_OUTCOME_UNCONFIRMED}, HTTP_CONFLICT
            if not live.running and self._has_open_review(live):
                return {"ok": False, "error": RESOURCE_REVIEW_REQUIRED}, HTTP_CONFLICT
            payload, status = await self._enqueue(live, body)
            if payload.get("ok"):
                scheduled = self._schedule_locked(live, str(payload["queued_message_id"]))
                if live.waiting_request_id == payload.get("queued_message_id"):
                    task = scheduled
        if task is not None and bool(body.get("wait")):
            result = await asyncio.shield(task)
            return self._result_payload(result), HTTP_ACCEPTED
        return payload, status

    def _schedule_locked(
        self, live: LiveSession, selected_id: str = "", *, retry_failed: bool = False
    ) -> asyncio.Task[TurnResult] | None:
        """Own exactly one resource admission without claiming native execution."""

        if (
            self._sessions.get(live.id) is not live
            or live.running
            or live.interrupting
            or live.terminating
            or live.terminated
            or live.ledger.has_unknown_outcome
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
        live.waiting_request_id = queued.queued_message_id
        task = asyncio.create_task(self._prepare_queued(live, queued.queued_message_id))
        live.resource_task = task
        task.add_done_callback(
            lambda done: self._finish_resource_task(live, queued.queued_message_id, done)
        )
        return task

    async def _prepare_queued(self, live: LiveSession, request_id: str) -> TurnResult:
        """Wait outside lifecycle_lock; only a confirmed grant permits submission."""

        queued = live.catalog.queued_message(live.id, request_id)
        if queued is None:
            return TurnResult(request_id, TurnStatus.FAILED, error=QUEUED_MESSAGE_NOT_SENDABLE)

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
            if self._prepare is not None:
                await self._prepare(
                    live,
                    request_id=request_id,
                    deadline=None if queued.state is QueuedMessageState.FAILED else queued.deadline,
                    on_wait=on_wait,
                )
            async with live.lifecycle_lock:
                if (
                    self._sessions.get(live.id) is not live
                    or live.interrupting
                    or live.terminating
                    or live.terminated
                ):
                    raise asyncio.CancelledError
                submitting = live.catalog.begin_queued_submission(live.id, request_id)
                if submitting is None:
                    raise asyncio.CancelledError
                live.waiting_resources = False
                await live.publish(
                    PRODUCT_EVENT_SEND_NOW_SUBMITTED,
                    queued_message_payload(submitting),
                    idempotency_key=f"queue:{request_id}:submitted:{submitting.operation_seq}",
                )
                payload, _status, task = await self._admit_turn_locked(live, submitting.body)
                if task is None:
                    error = str(payload.get("error") or RUNTIME_TURN_FAILED)
                    await self._fail_queued(live, request_id, error, unknown=False)
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

    def _finish_resource_task(
        self, live: LiveSession, request_id: str, task: asyncio.Task[TurnResult]
    ) -> None:
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
        self, live: LiveSession, request_id: str, safe_error: str, *, unknown: bool
    ) -> None:
        live.catalog.fail_queued_submission(
            live.id, request_id, unknown=unknown, safe_error=safe_error
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

    def _has_open_review(self, live: LiveSession) -> bool:
        return (
            self._review_batches is not None
            and live.project_path is not None
            and self._review_batches.has_open_for_workdir(str(live.project_path))
        )

    async def _admit_turn_locked(
        self,
        live: LiveSession,
        body: Mapping[str, Any],
    ) -> tuple[dict[str, Any], int, asyncio.Task[TurnResult] | None]:
        """Admit one new turn while the caller owns ``lifecycle_lock``."""

        if self._has_open_review(live):
            return {"ok": False, "error": RESOURCE_REVIEW_REQUIRED}, HTTP_CONFLICT, None

        try:
            admission = await self._typed_input(live, body)
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
            context_result = self._freeze_context(live, body, admission)
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
        if self._deliveries is not None and live.project_path is not None:
            try:
                resource_context = await self._deliveries.begin_turn(
                    live.id, client_turn_id, str(live.project_path)
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
                return {"ok": False, "error": RESOURCE_BASELINE_FAILED}, 500, None
        live.trace_turn_input(
            admission.turn_input,
            user_text=admission.display_text,
            product_context=(context_result.model_context if context_result is not None else ""),
            skill_versions=admission.skill_versions,
            assistant_snapshot_id=admission.assistant_snapshot_id,
            assistant_context_revision=admission.assistant_context_revision,
        )
        await live.adopt_user_title(admission.display_text, turn_id=client_turn_id)
        await live.record_user_history(
            admission.display_text,
            references=admission.references,
            turn_id=client_turn_id,
            item_id=client_turn_id,
            assistant_snapshot_id=admission.assistant_snapshot_id,
            assistant_context_revision=admission.assistant_context_revision,
        )
        live.last_submission_id = client_turn_id
        live.active_assistant_snapshot_id = admission.assistant_snapshot_id
        live.active_assistant_revision = admission.assistant_context_revision
        live.active_task_type = task_type
        live.active_task_lease = None
        live.product_turn_generation += 1
        live.active_turn_started_at = time.time()
        task = asyncio.create_task(self._execute(live, admission.turn_input))
        live.current_task = task
        return {"ok": True, "turn_id": client_turn_id}, HTTP_ACCEPTED, task

    async def _enqueue(
        self,
        live: LiveSession,
        body: Mapping[str, Any],
    ) -> tuple[dict[str, Any], int]:
        try:
            admission = await self._typed_input(live, body, validate_skill_inventory=False)
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
                if key not in (QUEUED_ASSISTANT_SNAPSHOT_ID, QUEUED_ASSISTANT_REFERENCES)
            }
            if existing_input != queued_body:
                return {"ok": False, "error": QUEUED_MESSAGE_CONFLICT}, HTTP_CONFLICT
            return self._queue_receipt(live, queued_message_id), HTTP_ACCEPTED
        try:
            context = self._freeze_queued_context(live, body, admission)
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
        try:
            record = live.catalog.enqueue_message(live.id, queued_message_id, queued_body)
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
        return self._queue_receipt(live, queued_message_id), HTTP_ACCEPTED

    @staticmethod
    def _queue_receipt(live: LiveSession, request_id: str) -> dict[str, Any]:
        return {
            "ok": True,
            "queued": True,
            "queued_message_id": request_id,
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
            await self._typed_input(live, body, validate_skill_inventory=False)
        except ValueError as exc:
            return {
                "ok": False,
                "error": TURN_INPUT_INVALID,
                "detail": str(exc),
            }, HTTP_BAD_REQUEST
        queued_body = dict(body)
        queued_body["queued_message_id"] = queued_message_id
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
                    payload={"queued_message_id": queued_message_id, "reason": QUEUE_DELETED_REASON},
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
                    client_turn_id=str(
                        queued.body.get("client_user_message_id") or queued.queued_message_id
                    ),
                    outcome=AssistantTurnFinalization.DISCARDED,
                )
            if not live.catalog.delete_queued_message(session_id, queued.queued_message_id):
                continue
            if (
                live.waiting_request_id == queued.queued_message_id
                and live.resource_task is not None
            ):
                live.resource_task.cancel()
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

        live = self._sessions.get(session_id)
        if live is None:
            return {"ok": False, "error": "session_not_live"}, HTTP_NOT_FOUND
        async with live.lifecycle_lock:
            if self._sessions.get(session_id) is not live:
                return {"ok": False, "error": "session_not_live"}, HTTP_NOT_FOUND
            if live.interrupting:
                return {"ok": False, "error": TURN_INTERRUPTING}, HTTP_CONFLICT
            if live.ledger.has_unknown_outcome:
                return {"ok": False, "error": TURN_OUTCOME_UNCONFIRMED}, HTTP_CONFLICT
            if live.running:
                return {"ok": False, "error": TURN_ALREADY_RUNNING}, HTTP_CONFLICT
            if live.terminating or live.terminated:
                return {"ok": False, "error": SESSION_TERMINATED}, HTTP_CONFLICT
            if (
                live.waiting_request_id == queued_message_id
                and live.resource_task is not None
                and not live.resource_task.done()
            ):
                queued = live.catalog.queued_message(session_id, queued_message_id)
                if queued is not None and queued.state in (
                    QueuedMessageState.QUEUED,
                    QueuedMessageState.WAITING_RESOURCES,
                    QueuedMessageState.FAILED,
                ):
                    return self._queue_receipt(live, queued_message_id), HTTP_ACCEPTED
            task = self._schedule_locked(live, queued_message_id, retry_failed=True)
            if task is None:
                return {
                    "ok": False,
                    "error": QUEUED_MESSAGE_NOT_SENDABLE,
                }, HTTP_CONFLICT
            return self._queue_receipt(live, queued_message_id), HTTP_ACCEPTED

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
        if live.terminating or live.terminated:
            return {"ok": False, "error": SESSION_TERMINATED}, HTTP_CONFLICT
        if live.interrupting:
            return {"ok": False, "error": TURN_INTERRUPTING}, HTTP_CONFLICT
        if live.ledger.has_unknown_outcome:
            return {"ok": False, "error": TURN_OUTCOME_UNCONFIRMED}, HTTP_CONFLICT
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
            for queued in live.catalog.queued_messages(session_id):
                if queued.state is not QueuedMessageState.OUTCOME_UNKNOWN or turn_id not in (
                    queued.queued_message_id,
                    queued.native_turn_id,
                ):
                    continue
                if self._context_source is not None:
                    # Consume first so a failed cleanup leaves the durable request retryable.
                    self._context_source.finalize(
                        session_id=session_id,
                        client_turn_id=queued.queued_message_id,
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
                live.catalog.fail_queued_submission(
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
            live.catalog.fail_queued_submission(
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
        live.catalog.fail_queued_submission(
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
                client_turn_id=admission.turn_input.client_user_message_id,
                snapshot_id=snapshot_id,
                question=admission.display_text,
            )
        else:
            revision = self._expected_context_revision(body)
            result = self._context_source.freeze(
                session_id=live.id,
                client_turn_id=admission.turn_input.client_user_message_id,
                expected_revision=revision,
                question=admission.display_text,
                metadata_only=self._task_type(body, admission) in FULLTEXT_GATED_TASK_TYPES,
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

    def _freeze_queued_context(
        self,
        live: LiveSession,
        body: Mapping[str, Any],
        admission: TurnAdmission,
    ) -> AssistantTurnContext | tuple[dict[str, Any], int] | None:
        if self._context_source is None:
            if body.get("assistant_context_revision") is not None:
                return {
                    "ok": False,
                    "error": ASSISTANT_CONTEXT_UNAVAILABLE,
                }, HTTP_CONFLICT
            return None
        revision = self._expected_context_revision(body)
        result = self._context_source.freeze_queued(
            session_id=live.id,
            client_turn_id=admission.turn_input.client_user_message_id,
            expected_revision=revision,
            question=admission.display_text,
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

    async def _typed_input(
        self,
        live: LiveSession,
        body: Mapping[str, Any],
        *,
        validate_skill_inventory: bool = True,
    ) -> TurnAdmission:
        raw_items = body.get("input")
        if not isinstance(raw_items, list) or not raw_items:
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
        should_drain = False
        runtime_result: RuntimeTurnResult | None = None
        interrupt_generation = live.interrupt_generation
        try:
            async with live.turn_lock:
                runtime_result = await live.run_runtime(turn_input)
            await live.bind_user_history(
                turn_input.client_user_message_id,
                vendor_turn_id=runtime_result.native_turn_id or runtime_result.command_id,
            )
            outcome = (
                RuntimeTurnOutcome.INTERRUPTED
                if live.interrupt_generation != interrupt_generation
                else runtime_result.outcome
            )
            status = {
                RuntimeTurnOutcome.COMPLETED: TurnStatus.COMPLETED,
                RuntimeTurnOutcome.FAILED: TurnStatus.FAILED,
                RuntimeTurnOutcome.INTERRUPTED: TurnStatus.INTERRUPTED,
                RuntimeTurnOutcome.UNKNOWN: TurnStatus.FAILED,
            }[outcome]
            result = TurnResult(
                turn_id=runtime_result.native_turn_id or runtime_result.command_id,
                status=status,
                final_text=runtime_result.final_text,
                error=runtime_result.safe_error,
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
            if outcome is RuntimeTurnOutcome.UNKNOWN:
                await self._fail_queued(
                    live,
                    turn_input.client_user_message_id,
                    TURN_OUTCOME_UNCONFIRMED,
                    unknown=True,
                )
            else:
                await self._complete_queued(live, turn_input.client_user_message_id)
            should_drain = outcome is RuntimeTurnOutcome.COMPLETED
            return result
        except asyncio.CancelledError:
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
            live.active_assistant_snapshot_id = ""
            live.active_assistant_revision = None
            live.clear_task_lease()
            live.current_task = None
            await live.release_product_turn(turn_input.client_user_message_id)
            if should_drain:
                asyncio.create_task(self._drain_next(live))

    async def _complete_queued(self, live: LiveSession, request_id: str) -> None:
        if live.catalog.complete_queued_message(live.id, request_id):
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
        async with live.lifecycle_lock:
            self._schedule_locked(live)

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
                client_turn_id=client_turn_id,
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
