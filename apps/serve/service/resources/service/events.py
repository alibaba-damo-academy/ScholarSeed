"""Stable structured event vocabulary for the resource-version domain."""

from __future__ import annotations

import logging
from enum import Enum
from hashlib import sha256
from threading import Lock

from damoatrace.contract.event import EventKind
from damoatrace.paths import TRACE_DIR
from damoatrace.recording.writer import EvidenceWriter
from service.brand import PRODUCT_SLUG
from service.platform.resources import PendingSnapshot


class ResourceVersionEvent(str, Enum):
    """Names consumed by product logs and DamoATrace log correlation."""

    SCAN_STARTED = "resources.versions.scan.started"
    SCAN_PROGRESS = "resources.versions.scan.progress"
    SCAN_COMPLETED = "resources.versions.scan.completed"
    OBSERVE_DRIFT = "resources.versions.observe.drift"
    VERSION_CREATED = "resources.versions.version.created"
    VERSION_UPDATED = "resources.versions.version.updated"
    PENDING_CREATED = "resources.versions.pending.created"
    PENDING_UPDATED = "resources.versions.pending.updated"
    CONTEXT_PREPARED = "resources.versions.context.prepared"
    REVIEW_ACCEPT = "resources.versions.review.accept"
    REVIEW_REJECT = "resources.versions.review.reject"
    REVIEW_REVISED = "resources.versions.review.revised"
    REVIEW_RECONCILED = "resources.versions.review.reconciled"
    REVIEW_PREFLIGHT = "resources.versions.review.preflight"
    REVIEW_CONFLICT = "resources.versions.review.conflict"
    DELIVERY_FINALIZED = "resources.versions.delivery.finalized"
    DELIVERY_DISCARDED = "resources.versions.delivery.discarded"
    RESTORE_PREFLIGHT = "resources.versions.restore.preflight"
    RESTORE_APPLY = "resources.versions.restore.apply"
    RESTORE_RECOVERED = "resources.versions.restore.recovered"
    RESTORE_CONFLICT = "resources.versions.restore.conflict"
    RETENTION_PREVIEW = "resources.versions.retention.preview"
    RETENTION_APPLIED = "resources.versions.retention.applied"
    GC_MARKED = "resources.versions.gc.marked"
    GC_TRASHED = "resources.versions.gc.trashed"
    GC_DELETED = "resources.versions.gc.deleted"
    GC_FAILED = "resources.versions.gc.failed"


class ResourceSearchEvent(str, Enum):
    STARTED = "resources.search.started"
    CREDENTIAL_READY = "resources.search.credential.ready"
    REQUESTED = "resources.search.official.requested"
    RECEIVED = "resources.search.official.received"
    COMPLETED = "resources.search.completed"
    CANCELLED = "resources.search.cancelled"
    RESULT_READY = "resources.search.result.ready"
    CLEANUP_COMPLETED = "resources.search.cleanup.completed"


TRACE_COMPONENT = "service:resources"
TRACE_NAMESPACE = f"{PRODUCT_SLUG}-resources"
TRACE_SUFFIX = ".jsonl"
TRACE_ENCODING = "utf-8"
TRACE_EVENTS = frozenset(
    (
        ResourceVersionEvent.PENDING_CREATED,
        ResourceVersionEvent.PENDING_UPDATED,
        ResourceVersionEvent.CONTEXT_PREPARED,
        ResourceVersionEvent.REVIEW_ACCEPT,
        ResourceVersionEvent.REVIEW_REJECT,
        ResourceVersionEvent.REVIEW_REVISED,
        ResourceVersionEvent.REVIEW_RECONCILED,
        ResourceVersionEvent.REVIEW_PREFLIGHT,
        ResourceVersionEvent.REVIEW_CONFLICT,
        ResourceVersionEvent.RESTORE_PREFLIGHT,
        ResourceVersionEvent.RESTORE_APPLY,
        ResourceVersionEvent.RESTORE_RECOVERED,
        ResourceVersionEvent.RESTORE_CONFLICT,
    )
) | frozenset(ResourceSearchEvent)
_trace_lock = Lock()


def emit(
    logger: logging.Logger, event: ResourceVersionEvent | ResourceSearchEvent, **fields: object
) -> None:
    """Publish one structured event without content-bearing fields."""

    logger.info(event.value, extra=fields)
    if event not in TRACE_EVENTS:
        return
    project_id = str(fields.get("project_id") or "")
    project_key = sha256(project_id.encode(TRACE_ENCODING)).hexdigest()
    path = TRACE_DIR / f"{TRACE_NAMESPACE}-{project_key}{TRACE_SUFFIX}"
    correlation = (
        fields.get("search_id")
        or fields.get("review_id")
        or fields.get("transaction_id")
        or project_key
    )
    try:
        with _trace_lock, EvidenceWriter(path) as writer:
            writer.emit(
                session_id=str(fields.get("session_id") or ""),
                kind=EventKind.MODE_TRANSITION.value,
                name=event.value,
                task_run_id=f"{TRACE_NAMESPACE}:{correlation}",
                component_id=TRACE_COMPONENT,
                attributes=fields,
            )
    except OSError:
        # Evidence is not the state owner; a committed decision must remain successful.
        logger.warning("resources evidence write failed: %s", event.value, exc_info=True)


def emit_pending(
    logger: logging.Logger,
    project_id: str,
    before: PendingSnapshot | None,
    after: PendingSnapshot | None,
    working_revision: str | None,
) -> None:
    """Record the committed Agent review identity, including user edits to its head."""

    if after is None or after.review is None or after == before:
        return
    review = after.review
    event = (
        ResourceVersionEvent.PENDING_UPDATED
        if before is not None and before.review is not None
        else ResourceVersionEvent.PENDING_CREATED
    )
    emit(
        logger,
        event,
        project_id=project_id,
        file_id=after.file_id,
        review_id=review.id,
        session_id=review.session_id,
        turn_id=review.turn_id,
        first_turn_id=review.first_turn_id,
        pending_revision=after.revision,
        revision=working_revision,
        candidate_revision=review.candidate_revision,
        terminal_outcome=review.terminal_outcome.value,
        edited_by_user=review.edited_by_user,
        result_code="committed",
    )


def emit_review(
    logger: logging.Logger,
    event: ResourceVersionEvent,
    project_id: str,
    current: PendingSnapshot | None,
    **fields: object,
) -> None:
    """Attach verified review provenance to a preflight or rejected attempt."""

    if current is None or current.review is None:
        return
    emit(
        logger,
        event,
        project_id=project_id,
        file_id=current.file_id,
        review_id=current.review.id,
        session_id=current.review.session_id,
        turn_id=current.review.turn_id,
        pending_revision=current.revision,
        **fields,
    )


__all__ = ["ResourceVersionEvent", "emit", "emit_pending", "emit_review"]
