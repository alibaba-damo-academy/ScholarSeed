"""Resource-version domain records and invariants."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from service.platform.resources import (
    ChangeAttribution,
    FileState,
    PendingOrigin,
    ReviewDecision,
    ReviewOutcome,
    ReviewResolutionChoice,
    SnapshotIdentity,
    VersionOrigin,
)


class ObservationState(str, Enum):
    """Disk availability is broader than the two restorable version states."""

    PRESENT = FileState.PRESENT.value
    TOMBSTONE = FileState.TOMBSTONE.value
    UNAVAILABLE = "unavailable"


def same_source_identity(left: SnapshotIdentity | None, right: SnapshotIdentity | None) -> bool:
    """Compare only source-file facts, excluding independently persisted annotations."""

    if left is None or right is None:
        return left is right
    return (
        left.object_id,
        left.state,
        left.path,
        left.mode_bits,
    ) == (
        right.object_id,
        right.state,
        right.path,
        right.mode_bits,
    )


@dataclass(frozen=True)
class DiskObservation:
    """Stable current facts; contains no archived object or version identity."""

    state: ObservationState
    revision: str | None = None
    size_bytes: int | None = None
    mtime_ns: int | None = None
    mode_bits: int | None = None
    annotation_revision: str | None = None


@dataclass(frozen=True)
class SnapshotVersion:
    """A persistence-ready snapshot after its CAS object is published."""

    path: str
    media_type: str
    revision: str | None
    object_id: str | None
    mode_bits: int | None
    mtime_ns: int | None
    origin: VersionOrigin
    annotation_revision: str | None = None
    annotation_object_id: str | None = None
    state: FileState = FileState.PRESENT
    session_id: str | None = None
    turn_id: str | None = None
    restored_from_id: str | None = None
    restored_from_sequence: int | None = None
    restored_from_object_id: str | None = None
    delivery_id: str | None = None
    source_delivery_id: str | None = None
    source_review_id: str | None = None
    review_outcome: ReviewOutcome | None = None


@dataclass(frozen=True)
class TurnBaseline:
    """One complete pre-turn file state ready for durable intake."""

    file_id: str
    path: str
    revision: str | None
    object_id: str | None
    mode_bits: int | None
    version_id: str | None
    annotation_revision: str | None = None
    annotation_object_id: str | None = None
    state: FileState = FileState.PRESENT
    pending_origin: PendingOrigin | None = None


@dataclass(frozen=True)
class DeliveryRecoveryMember:
    """Exact before and after states retained by one Delivery member."""

    baseline: TurnBaseline
    after_path: str
    after_revision: str | None
    after_annotation_object_id: str | None
    after_version_id: str
    change_kind: str


@dataclass(frozen=True)
class DeliveryDraft:
    """Frozen logical member; independent of physical CAS object layout."""

    baseline: TurnBaseline
    snapshot: SnapshotVersion
    change_kind: str
    attribution: ChangeAttribution


class RestoreKind(str, Enum):
    """Durable recovery operation kind."""

    SINGLE = "single"
    DELIVERY = "delivery"


class RestoreState(str, Enum):
    """Persisted recovery states used for crash reconciliation."""

    PREPARED = "prepared"
    APPLYING = "applying"
    COMMITTED = "committed"
    CONFLICTED = "conflicted"
    NEEDS_ATTENTION = "needs_attention"
    ABORTED = "aborted"


class RestoreCompletion(str, Enum):
    VERSION = "version"
    PENDING_CANCEL = "pending_cancel"


@dataclass(frozen=True)
class RestoreMember:
    """One fully materializable member of a durable recovery manifest."""

    order: int
    file_id: str
    conflict_at_prepare: bool
    expected_revision: str | None
    expected_annotation_revision: str | None
    expected_state: FileState
    expected_path: str
    before_object_id: str | None
    before_annotation_object_id: str | None
    before_state: FileState
    before_path: str
    before_mode_bits: int | None
    target_object_id: str | None
    target_annotation_object_id: str | None
    target_state: FileState
    target_path: str
    target_mode_bits: int | None
    applied: bool = False


@dataclass(frozen=True)
class ReviewResolution:
    review_id: str
    pending_revision: int
    choice: ReviewResolutionChoice
    expected_head: SnapshotIdentity
    expected_revision: str | None
    expected_version_id: str | None


@dataclass(frozen=True)
class RestoreTransaction:
    """Durable manifest and progress for one logical restore."""

    id: str
    kind: RestoreKind
    source_id: str
    policy: str
    state: RestoreState
    preflight_token: str
    members: tuple[RestoreMember, ...]
    completion: RestoreCompletion = RestoreCompletion.VERSION
    review_decision: ReviewDecision | None = None
    discard_revision: int | None = None
    review_resolution: ReviewResolution | None = None


__all__ = [
    "DeliveryRecoveryMember",
    "RestoreKind",
    "RestoreCompletion",
    "RestoreMember",
    "RestoreState",
    "RestoreTransaction",
    "ReviewResolution",
    "same_source_identity",
    "SnapshotVersion",
    "TurnBaseline",
]
