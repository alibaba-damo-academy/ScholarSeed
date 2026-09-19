"""Test-only pre-cutover Delivery rows for retained history/recovery contracts.

Production no longer publishes Deliveries. These fixtures materialize immutable
historical rows from captured snapshots; they are not product acceptance evidence.
"""

from __future__ import annotations

from time import time_ns
from uuid import uuid4

from service.paths import PROJECT_DB_RELATIVE, PROJECT_VERSIONS_RELATIVE
from service.persistence.project import transaction
from service.platform.content import ContentPort
from service.platform.files import guess_media_type
from service.platform.resources import (
    DeliveryResult,
    FileState,
    ReviewCaptureResult,
    ReviewDecision,
    ReviewOutcome,
    VersionOrigin,
)
from service.resources.domain.version import SnapshotVersion
from service.resources.persistence.objects import CasStore
from service.resources.persistence.version import VersionStore


def historical_delivery(
    content: ContentPort, project_id: str, capture: ReviewCaptureResult
) -> DeliveryResult:
    """Seed the old schema's complete snapshots without reviving its publisher."""

    database = content.resolve(project_id, PROJECT_DB_RELATIVE)
    store = VersionStore(database, content.resolve(project_id, ""))
    cas = CasStore(content.resolve(project_id, PROJECT_VERSIONS_RELATIVE))
    delivery_id = uuid4().hex
    members = []
    references = []
    for file_id in capture.file_ids:
        current = store.pending(file_id)
        assert current is not None and current.review is not None
        review = current.review
        references.append(review)
        candidate = review.candidate
        snapshot = SnapshotVersion(
            path=candidate.path,
            media_type=guess_media_type(candidate.path),
            revision=review.candidate_revision,
            object_id=candidate.object_id,
            mode_bits=candidate.mode_bits,
            mtime_ns=None,
            origin=VersionOrigin.AGENT,
            state=candidate.state,
            annotation_revision=candidate.annotation_object_id,
            annotation_object_id=candidate.annotation_object_id,
        )
        sealed = store.seal(
            snapshot,
            cas.verify(candidate.object_id) if candidate.object_id else None,
            cas.verify(candidate.annotation_object_id) if candidate.annotation_object_id else None,
            review_decision=ReviewDecision(review.id, current.revision, ReviewOutcome.ACCEPTED),
            idempotency_key=f"historical-{delivery_id}-{file_id}",
            operation_target=file_id,
            request_digest=delivery_id,
        )
        base = review.base
        if base.state is FileState.TOMBSTONE:
            kind = "create"
        elif candidate.state is FileState.TOMBSTONE:
            kind = "delete"
        elif candidate.path != base.path:
            kind = "move"
        else:
            kind = "update"
        members.append(
            (
                delivery_id,
                file_id,
                kind,
                review.base_version_id,
                base.object_id,
                base.state.value,
                base.path,
                base.mode_bits,
                base.annotation_object_id,
                sealed.version.id,
                "agent",
            )
        )
    assert references, "A historical Delivery must contain changed files"
    session_id, turn_id = references[0].session_id, references[0].turn_id
    assert all(
        (review.session_id, review.turn_id) == (session_id, turn_id) for review in references
    )
    with transaction(database, immediate=True) as connection:
        connection.execute(
            "INSERT INTO resources_deliveries (delivery_id, session_id, turn_id, created_at_ms) "
            "VALUES (?, ?, ?, ?)",
            (delivery_id, session_id, turn_id, time_ns() // 1_000_000),
        )
        connection.executemany(
            "INSERT INTO resources_delivery_members (delivery_id, file_id, change_kind, "
            "before_version_id, before_object_id, before_state, before_path, before_mode_bits, "
            "before_annotation_object_id, after_version_id, attribution) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            members,
        )
        connection.executemany(
            "UPDATE resources_versions SET delivery_id = ?, source_review_id = NULL, "
            "review_outcome = NULL WHERE version_id = ?",
            ((delivery_id, member[-2]) for member in members),
        )
    result = store.delivery_result(session_id, turn_id)
    assert result is not None and result.delivery is not None
    assert len(result.members) == len(capture.file_ids)
    return result
