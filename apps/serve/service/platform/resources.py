"""Resource-version contracts shared by content, workbench and chat."""

from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable

from service.platform.content import ContentWriteReceipt

VERSION_MAX_GIBIBYTES = 2
VERSION_MAX_BYTES = VERSION_MAX_GIBIBYTES * 1024 * 1024 * 1024
VERSION_INLINE_MAX_BYTES = 64 * 1024 * 1024
VERSION_FILE_SIZE_KILOBYTE = 1024
DEFAULT_MAX_VERSIONS_PER_FILE = 50
MIN_MAX_VERSIONS_PER_FILE = 1
MAX_MAX_VERSIONS_PER_FILE = 1000
DEFAULT_MAX_VERSION_FILE_SIZE_MB = 50
DEFAULT_MAX_VERSION_FILE_SIZE_KB = DEFAULT_MAX_VERSION_FILE_SIZE_MB * VERSION_FILE_SIZE_KILOBYTE
MIN_MAX_VERSION_FILE_SIZE_KB = 1
MAX_MAX_VERSION_FILE_SIZE_KB = VERSION_MAX_BYTES // VERSION_FILE_SIZE_KILOBYTE
DEFAULT_PRODUCT_FILE_MODE = 0o600
DEFAULT_PENDING_PAGE_SIZE = 50


@dataclass(frozen=True)
class AnnotationContent:
    """Canonical sidecar bytes captured independently from the source file."""

    revision: str
    content: bytes


class FileState(str, Enum):
    """Logical state captured by a version."""

    PRESENT = "present"
    TOMBSTONE = "tombstone"


class SnapshotState(str, Enum):
    """Whether the current complete working snapshot is the sealed version head."""

    SAVED = "saved"
    PENDING = "pending"


@dataclass(frozen=True)
class SnapshotIdentity:
    """Restorable identity, independent of timestamps and current disk availability."""

    object_id: str | None
    state: FileState
    path: str
    mode_bits: int | None
    annotation_object_id: str | None = None


class PendingOrigin(str, Enum):
    """Who produced an unsealed working snapshot; independent of filesystem drift."""

    USER = "user"
    AGENT = "agent"
    EXTERNAL = "external"
    RESTORE = "restore"


class ReviewOutcome(str, Enum):
    """Explicit user decision on a whole-file Agent candidate."""

    ACCEPTED = "accepted"
    REJECTED = "rejected"
    REVISED = "revised"


class ReviewAction(str, Enum):
    """User intent accepted by the unified batch decision boundary."""

    ACCEPT = "accept"
    REJECT = "reject"
    REVISE = "revise"


class ReviewBatchState(str, Enum):
    """Durable aggregate state of one terminal review capture."""

    OPEN = "open"
    APPLYING = "applying"
    COMPLETED = "completed"
    FAILED = "failed"


class ReviewMemberState(str, Enum):
    """Durable progress of one member in a review batch."""

    PENDING = "pending"
    APPLYING = "applying"
    COMPLETED = "completed"
    FAILED = "failed"


class ReviewConflict(str, Enum):
    DECISION_REQUIRED = "pending_review_requires_decision"
    INVALID_OUTCOME = "invalid_review_outcome"
    NOT_FOUND = "review_not_found"
    PENDING_REVISION = "pending_revision_conflict"
    CANDIDATE_REVISION = "review_revision_conflict"
    ACTIVE_TURN = "review_turn_active"


@dataclass(frozen=True)
class ReviewDecision:
    review_id: str
    pending_revision: int
    outcome: ReviewOutcome


@dataclass(frozen=True)
class ReviewBatchDecision:
    file_id: str
    review_id: str
    pending_revision: int
    action: ReviewAction
    expected_disk_revision: str | None
    revised_content: bytes | None = None


@dataclass(frozen=True)
class ReviewBatchMember:
    file_id: str
    review_id: str
    path: str
    pending_revision: int
    state: ReviewMemberState
    origin: PendingOrigin
    base: SnapshotIdentity
    candidate: SnapshotIdentity
    base_revision: str | None
    candidate_revision: str | None
    edited_by_user: bool = False
    action: ReviewAction | None = None
    result_version_id: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class ReviewBatch:
    id: str
    session_id: str
    turn_id: str
    group_id: str
    state: ReviewBatchState
    created_at_ms: int
    updated_at_ms: int
    members: tuple[ReviewBatchMember, ...] = ()


@dataclass(frozen=True)
class ReviewBatchMemberResult:
    file_id: str
    action: ReviewAction
    state: ReviewMemberState
    version_id: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class ReviewBatchDecisionResult:
    batch: ReviewBatch | None
    results: tuple[ReviewBatchMemberResult, ...] = ()


class ReviewResolutionChoice(str, Enum):
    KEEP_CURRENT = "keep_current"
    RESTORE_CANDIDATE = "restore_candidate"


@dataclass(frozen=True)
class ReviewConflictPreview:
    file_id: str
    review_id: str
    pending_revision: int
    disk: SnapshotIdentity
    token: str


@dataclass(frozen=True)
class PendingReview:
    """An immutable first baseline and the latest review candidate for one file."""

    id: str
    group_id: str
    session_id: str
    first_turn_id: str
    turn_id: str
    terminal_outcome: TurnOutcome
    origin: PendingOrigin
    base: SnapshotIdentity
    candidate: SnapshotIdentity
    base_revision: str | None
    candidate_revision: str | None
    base_origin: PendingOrigin | None
    base_version_id: str | None
    edited_by_user: bool


@dataclass(frozen=True)
class PendingSnapshot:
    """Durable provenance attached to the one authoritative WorkingHead."""

    file_id: str
    revision: int
    origin: PendingOrigin
    review: PendingReview | None = None

    @property
    def needs_review(self) -> bool:
        return self.review is not None


@dataclass(frozen=True)
class PendingFile:
    """List projection independent of disk availability and open editor sessions."""

    path: str
    state: FileState
    version_id: str | None
    pending: PendingSnapshot


@dataclass(frozen=True)
class VersionedFile:
    """A logical file with retained history, independent of its disk presence."""

    file_id: str
    path: str
    state: FileState
    version_id: str


@dataclass(frozen=True)
class ResourceTurnContext:
    """Frozen, metadata-only input from the resource turn admission."""

    model_context: str = ""


@dataclass(frozen=True)
class ReviewCaptureResult:
    """Immutable terminal receipt; file contents remain in WorkingHead/pending CAS."""

    file_ids: tuple[str, ...] = ()
    review_ids: tuple[str, ...] = ()
    batch_id: str | None = None
    project_id: str | None = None
    paths: tuple[str, ...] = ()


GIT_VERSION_DISABLED_ERROR = "git_version_disabled"


class ManagementState(str, Enum):
    """Whether a resource currently participates in version management."""

    MANAGED = "managed"
    GIT = "git"
    IGNORED = "ignored"
    OVERSIZED = "oversized"
    UNSUPPORTED = "unsupported"
    UNAVAILABLE = "unavailable"
    MIGRATION_REQUIRED = "migration_required"


class VersionPolicyMode(str, Enum):
    """The single active rule list for automatic file version admission."""

    WHITELIST = "whitelist"
    BLACKLIST = "blacklist"


@runtime_checkable
class ResourceAdmissionPolicy(Protocol):
    """Resources-owned eligibility shared by discovery and mutation capture."""

    def admission_state(self, project_id: str, path: str) -> ManagementState:
        """Classify a current logical file through the authoritative admission policy."""
        raise NotImplementedError

    def max_size_bytes(self) -> int:
        """Return the configured automatic version-capture size ceiling."""
        raise NotImplementedError

    def capability(self, project_id: str, path: str) -> ResourceCapability:
        """Project eligibility and current version identity for a product consumer."""
        raise NotImplementedError


class VersionOrigin(str, Enum):
    """User-visible reason a version exists."""

    INITIAL_SCAN = "initial_scan"
    USER = "user"
    EXTERNAL_CONFIRMED = "external_confirmed"
    AGENT = "agent"
    RESTORE = "restore"
    DELIVERY_REVERT = "delivery_revert"


class ProductMutationKind(str, Enum):
    """Filesystem transition requested by a ScholarSeed-owned product action."""

    WRITE = "write"
    CREATE = "create"


class RestorePolicy(str, Enum):
    """Conflict policy explicitly chosen for a restore execution."""

    STRICT = "strict"
    FORCE = "force"
    SKIP_CONFLICTS = "skip_conflicts"


class TurnOutcome(str, Enum):
    """Agent terminal outcome relevant to resource delivery."""

    COMPLETED = "completed"
    FAILED = "failed"
    INTERRUPTED = "interrupted"
    UNKNOWN = "unknown"


class ChangeAttribution(str, Enum):
    """Evidence strength for attributing a Delivery member to the Agent."""

    AGENT = "agent"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class VersionRef:
    """One immutable resource version; CAS layout is intentionally absent."""

    id: str
    file_id: str
    sequence: int
    object_id: str | None
    state: FileState
    path: str
    mode_bits: int | None
    annotation_object_id: str | None
    origin: VersionOrigin
    created_at_ms: int
    session_id: str | None = None
    turn_id: str | None = None
    restored_from_id: str | None = None
    restored_from_sequence: int | None = None
    restored_from_object_id: str | None = None
    delivery_id: str | None = None
    source_delivery_id: str | None = None
    source_review_id: str | None = None
    review_outcome: ReviewOutcome | None = None
    alias: str | None = None
    metadata_revision: int = 0
    review_backup: bool = False


@dataclass(frozen=True)
class VersionDeletePreview:
    """Exact user-visible impact of deleting one historical ledger entry."""

    version_id: str
    file_id: str
    sequence: int
    deletable: bool
    blockers: tuple[str, ...]
    affected_delivery_ids: tuple[str, ...]
    preflight_token: str


@dataclass(frozen=True)
class VersionContentSnapshot:
    """Complete verified content detached from storage and retention lifetime."""

    version: VersionRef
    media_type: str
    content: bytes


@dataclass(frozen=True)
class VersionPairSnapshot:
    """Two ordered versions of one logical file read in one consistency window."""

    before: VersionContentSnapshot
    after: VersionContentSnapshot


@runtime_checkable
class ResourceVersionReadPort(Protocol):
    """Format-neutral historical input for version-derived product operations."""

    def read_pair(
        self, project_id: str, before_version_id: str, after_version_id: str
    ) -> VersionPairSnapshot:
        """Materialize present same-file versions in strictly increasing order."""
        raise NotImplementedError


class ResourceVersionReadError(RuntimeError):
    """Stable read-port failure without exposing storage implementation types."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SealResult:
    """Result of an idempotent version seal."""

    version: VersionRef
    unchanged: bool
    replaced: bool = False


@dataclass(frozen=True)
class ResourceCapability:
    """Version capability projected for one current logical path."""

    path: str
    managed: bool
    can_version: bool
    can_diff: bool
    can_preview_history: bool
    max_size_bytes: int
    management_state: ManagementState
    drifted: bool = False
    file_id: str | None = None
    working_revision: str | None = None
    disk_revision: str | None = None
    version_id: str | None = None
    snapshot_state: SnapshotState = SnapshotState.PENDING
    pending: PendingSnapshot | None = None
    manual_admitted: bool = False


@dataclass(frozen=True)
class RestorePreview:
    """Single-file restore preflight bound to observed disk state."""

    version_id: str
    file_id: str
    path: str
    expected_revision: str | None
    observed_revision: str | None
    conflict: bool
    preflight_token: str
    path_conflict: bool = False


@dataclass(frozen=True)
class DeliveryRef:
    """One successful Agent turn's logical version group."""

    id: str
    session_id: str
    turn_id: str
    created_at_ms: int


@dataclass(frozen=True)
class DeliveryMemberRef:
    """A separately restorable file member in a Delivery."""

    file_id: str
    path: str
    change_kind: str
    before_version_id: str | None
    before_object_id: str | None
    after_version_id: str
    attribution: ChangeAttribution = ChangeAttribution.UNKNOWN


@dataclass(frozen=True)
class DeliveryResult:
    """Idempotent terminal projection result."""

    delivery: DeliveryRef | None
    members: tuple[DeliveryMemberRef, ...] = ()


@dataclass(frozen=True)
class ResourceFinalization:
    """Resource-owned archive status, distinct from the successful runtime outcome."""

    session_id: str
    turn_id: str
    terminal_outcome: TurnOutcome
    error: str | None
    paths: tuple[str, ...]
    created_at_ms: int
    snapshot_available: bool
    retryable: bool


@dataclass(frozen=True)
class DeliveryRestoreMember:
    """One Delivery member's current preflight state."""

    file_id: str
    path: str
    target_path: str
    expected_revision: str | None
    observed_revision: str | None
    conflict: bool


@dataclass(frozen=True)
class DeliveryRestorePreview:
    """All-member preflight bound to exact disk observations."""

    delivery_id: str
    members: tuple[DeliveryRestoreMember, ...]
    preflight_token: str


@dataclass(frozen=True)
class DeliveryRestoreResult:
    """Versions appended by one explicit Delivery recovery operation."""

    versions: tuple[VersionRef, ...]
    skipped_file_ids: tuple[str, ...] = ()


@runtime_checkable
class ResourceVersionPort(Protocol):
    """Workbench-facing version operations without persistence details."""

    def seal(self, project_id: str, path: str, origin: VersionOrigin) -> SealResult:
        """Append a version for the current stable disk bytes unless unchanged."""
        raise NotImplementedError

    def history(self, project_id: str, path: str) -> tuple[VersionRef, ...]:
        """Return newest-first file history."""
        raise NotImplementedError

    def commit_working(
        self,
        project_id: str,
        path: str,
        content: bytes,
        expected_revision: str,
        idempotency_key: str,
    ) -> ContentWriteReceipt:
        """Durably update current bytes and WorkingHead without creating a Version."""
        raise NotImplementedError


@runtime_checkable
class ResourceManagedCopyPort(Protocol):
    """Workbench-facing creation of complete memory bytes inside the resource library."""

    def create_managed_copy(
        self,
        project_id: str,
        name: str,
        content: bytes,
        idempotency_key: str,
    ) -> ContentWriteReceipt:
        """Create one collision-free managed file and its complete initial version."""
        raise NotImplementedError


@dataclass(frozen=True)
class PayloadImportPreview:
    """Frozen destination and policy for an owner-resolved byte source."""

    path: str
    token: str
    conflict: bool
    suggested_name: str
    can_replace: bool
    target_revision: str | None

    def response(self) -> dict:
        return {
            "path": self.path,
            "token": self.token,
            "conflict": self.conflict,
            "suggested_name": self.suggested_name,
            "can_replace": self.can_replace,
            "target_revision": self.target_revision,
        }


class ResourcePayloadImportPort(Protocol):
    """Resources-owned import of bytes already validated by their source owner."""

    def preview_payload(
        self,
        project_id: str,
        parent: str,
        name: str,
        content: bytes,
        *,
        replace_path: str | None = None,
        context: str = "",
    ) -> PayloadImportPreview: ...

    def import_payload(
        self,
        project_id: str,
        parent: str,
        name: str,
        content: bytes,
        token: str,
        idempotency_key: str,
        *,
        replace_path: str | None = None,
        context: str = "",
    ) -> ContentWriteReceipt: ...

    def finish_payload(self, project_id: str, path: str, revision: str) -> None: ...


@runtime_checkable
class ResourceChangeSink(Protocol):
    """Content-facing sink for successful product-owned filesystem mutations."""

    def record_changes(self, project_id: str, paths: tuple[str, ...]) -> None:
        """Advance working state without creating user-visible versions."""
        raise NotImplementedError

    def record_move(self, project_id: str, source: str, target: str) -> None:
        """Move stable identities for a successful file or directory mutation."""
        raise NotImplementedError

    def relocation_scope(self, project_id: str) -> AbstractContextManager[None]:
        """Exclude observation until filesystem and stable path identities agree."""
        raise NotImplementedError

    def import_scope(self, project_id: str) -> AbstractContextManager[None]:
        """Reuse one resource eligibility snapshot for a COPY import batch."""
        raise NotImplementedError

    def commit_product_bytes(
        self,
        project_id: str,
        path: str,
        content: bytes,
        kind: ProductMutationKind,
        idempotency_key: str,
        *,
        mode_bits: int | None = None,
        request_digest: str | None = None,
    ) -> ContentWriteReceipt | None:
        """Commit eligible bytes durably, or decline paths outside version policy."""
        raise NotImplementedError


@runtime_checkable
class AgentResourceChangeSink(Protocol):
    """Chat-facing sink for turn-fenced runtime file-change evidence."""

    async def bind_turn(
        self, session_id: str, client_turn_id: str, vendor_turn_id: str, generation: str
    ) -> None:
        """Bind runtime identity to the durable pre-write admission."""
        raise NotImplementedError

    async def record_change(
        self,
        session_id: str,
        turn_id: str,
        absolute_path: str,
        change_kind: str,
        *,
        generation: str,
    ) -> None:
        """Persist one post-write hint without treating it as final file truth."""
        raise NotImplementedError

    async def record_tool_call(
        self,
        session_id: str,
        turn_id: str,
        tool_input: object,
        *,
        generation: str,
        event_id: str = "",
    ) -> None:
        """Match write-capable tool input against the admitted file inventory."""
        raise NotImplementedError


@dataclass(frozen=True)
class ResourceTurn:
    """A durable admission, unbound or uniquely vendor-bound across generations."""

    session_id: str
    turn_id: str
    vendor_turn_id: str | None
    runtime_generation: str


@dataclass(frozen=True)
class TurnTerminalEvidence:
    """An accepted product terminal, not an inference from current session status."""

    outcome: TurnOutcome
    product_seq: int


class ResourceTerminalSource(Protocol):
    def terminal_outcome(
        self, project_root: str, turn: ResourceTurn
    ) -> TurnTerminalEvidence | None:
        """Return exact durable evidence, or None when missing or contradictory."""
        raise NotImplementedError


class ResourceProjectPreparation(Protocol):
    """Project-local recovery barrier that runs before observation or Agent admission."""

    def prepare(self, project_id: str) -> None:
        """Recover durable resource state for one currently available project."""
        raise NotImplementedError


@runtime_checkable
class ResourceFormatPolicy(Protocol):
    """Injected Workbench format decision used by background version discovery."""

    def versionable(self, path: str) -> bool:
        """Whether the current Workbench supports version history for this path."""
        raise NotImplementedError

    def version_patterns(self) -> tuple[str, ...]:
        """Return user-facing patterns for every explicitly versionable format."""
        raise NotImplementedError

    def diffable(self, path: str) -> bool:
        """Whether historical raw bytes support UTF-8 line comparison."""
        raise NotImplementedError

    def reviewable(self, path: str) -> bool:
        """Whether the current Workbench can present a file review."""
        raise NotImplementedError


@runtime_checkable
class ResourceVersionSettings(Protocol):
    """Global user settings consumed by the project-local version domain."""

    def max_versions_per_file(self) -> int:
        """Return the global newest-version retention limit."""
        raise NotImplementedError

    def max_version_file_size_kb(self) -> int:
        """Return the global automatic version-capture size ceiling in KiB."""
        raise NotImplementedError

    def version_include_patterns(self) -> tuple[str, ...] | None:
        """Return global allow rules; None selects defaults and an empty tuple selects none."""
        raise NotImplementedError

    def version_mode(self) -> VersionPolicyMode:
        """Return the one active automatic admission mode."""
        raise NotImplementedError

    def version_migration_required(self) -> bool:
        """Whether existing combined rules still need explicit conversion."""
        raise NotImplementedError

    def version_ignore_patterns(self) -> tuple[str, ...]:
        """Return global gitignore-style patterns."""
        raise NotImplementedError


@runtime_checkable
class ResourceRetentionPort(Protocol):
    """Version-domain retention invoked after a logical mutation commits."""

    def enforce(self, project_id: str) -> int:
        """Apply the current global limit and collect newly unreachable CAS data."""
        raise NotImplementedError


@runtime_checkable
class ResourceAnnotationPort(Protocol):
    """Optional format-owned sidecar projected into resource versions."""

    def version_snapshot(self, project_id: str, path: str) -> AnnotationContent | None:
        """Return canonical sidecar bytes for a supported file."""
        raise NotImplementedError

    def apply(
        self,
        project_id: str,
        path: str,
        content: bytes,
        expected_revision: str | None,
        *,
        force: bool,
    ) -> AnnotationContent:
        """Restore exact sidecar bytes using the selected conflict policy."""
        raise NotImplementedError

    def move(self, project_id: str, source: str, target: str) -> None:
        """Move format-owned companion state with its primary asset."""
        raise NotImplementedError

    def remove(self, project_id: str, path: str) -> None:
        """Remove live companion state without deleting versioned CAS bytes."""
        raise NotImplementedError


@runtime_checkable
class MutableResourceVersionSettings(ResourceVersionSettings, Protocol):
    """Writable global settings boundary owned by the existing settings service."""

    def set_file_version_settings(
        self,
        max_versions_per_file: int,
        include_patterns: tuple[str, ...],
        ignore_patterns: tuple[str, ...],
        mode: VersionPolicyMode = VersionPolicyMode.WHITELIST,
        *,
        max_file_size_kb: int = DEFAULT_MAX_VERSION_FILE_SIZE_KB,
    ) -> None:
        """Persist validated retention, allow and deny settings together."""
        raise NotImplementedError


__all__ = [
    "PayloadImportPreview",
    "ResourcePayloadImportPort",
    "ResourceAdmissionPolicy",
    "VersionPolicyMode",
    "AgentResourceChangeSink",
    "AnnotationContent",
    "ChangeAttribution",
    "DeliveryMemberRef",
    "DeliveryRef",
    "DeliveryResult",
    "DeliveryRestoreMember",
    "DeliveryRestorePreview",
    "DeliveryRestoreResult",
    "FileState",
    "SnapshotIdentity",
    "SnapshotState",
    "PendingOrigin",
    "PendingReview",
    "PendingSnapshot",
    "PendingFile",
    "DEFAULT_PENDING_PAGE_SIZE",
    "ReviewConflict",
    "ReviewConflictPreview",
    "ReviewResolutionChoice",
    "VersionedFile",
    "ReviewDecision",
    "ReviewAction",
    "ReviewBatch",
    "ReviewBatchDecision",
    "ReviewBatchDecisionResult",
    "ReviewBatchMember",
    "ReviewBatchMemberResult",
    "ReviewBatchState",
    "ReviewMemberState",
    "ReviewOutcome",
    "ReviewCaptureResult",
    "DEFAULT_MAX_VERSIONS_PER_FILE",
    "DEFAULT_MAX_VERSION_FILE_SIZE_KB",
    "MAX_MAX_VERSION_FILE_SIZE_KB",
    "MAX_MAX_VERSIONS_PER_FILE",
    "ManagementState",
    "MutableResourceVersionSettings",
    "MIN_MAX_VERSIONS_PER_FILE",
    "MIN_MAX_VERSION_FILE_SIZE_KB",
    "VERSION_FILE_SIZE_KILOBYTE",
    "ResourceVersionPort",
    "ResourceVersionReadPort",
    "ResourceVersionReadError",
    "ResourceProjectPreparation",
    "ResourceChangeSink",
    "ResourceCapability",
    "ResourceAnnotationPort",
    "ResourceFormatPolicy",
    "ResourceFinalization",
    "ResourceTurnContext",
    "ResourceTerminalSource",
    "ResourceTurn",
    "ResourceRetentionPort",
    "ResourceVersionSettings",
    "RestorePolicy",
    "RestorePreview",
    "TurnOutcome",
    "TurnTerminalEvidence",
    "SealResult",
    "VERSION_MAX_BYTES",
    "VERSION_INLINE_MAX_BYTES",
    "VersionOrigin",
    "VersionRef",
    "VersionContentSnapshot",
    "VersionPairSnapshot",
]
