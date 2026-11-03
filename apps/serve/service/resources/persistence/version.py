"""SQLite ledger for project-local resource versions."""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Mapping
from contextlib import closing
from dataclasses import asdict, dataclass, replace
from functools import lru_cache, partial
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from service.persistence.project import (
    ProjectDatabasePath,
    connect,
    inspect_database,
    rebuild_table,
    reject_schema_residue,
    schema_transaction,
    sql_tokens,
    table_clauses,
    transaction,
)
from service.platform.resources import (
    DEFAULT_PENDING_PAGE_SIZE,
    ChangeAttribution,
    DeliveryMemberRef,
    DeliveryRef,
    DeliveryResult,
    FileState,
    PendingFile,
    PendingOrigin,
    PendingReview,
    PendingSnapshot,
    ProductMutationKind,
    ResourceFinalization,
    ResourceTurn,
    ReviewAction,
    ReviewBatchState,
    ReviewCaptureResult,
    ReviewConflict,
    ReviewDecision,
    ReviewMemberState,
    ReviewOutcome,
    ReviewResolutionChoice,
    SealResult,
    SnapshotIdentity,
    SnapshotState,
    TurnOutcome,
    VersionDeletePreview,
    VersionedFile,
    VersionOrigin,
    VersionRef,
)
from service.resources.domain.version import (
    DeliveryDraft,
    DeliveryRecoveryMember,
    DiskObservation,
    ObservationState,
    RestoreCompletion,
    RestoreKind,
    RestoreMember,
    RestoreState,
    RestoreTransaction,
    ReviewResolution,
    SnapshotVersion,
    TurnBaseline,
    same_source_identity,
)
from service.resources.persistence import batch, migration, pending
from service.resources.persistence.codecs import WholeCodec
from service.resources.persistence.objects import CasEntryKind, GcEntry, GcPlan, ObjectDescriptor

OBJECT_READY = "READY"
MANAGED = "managed"
MILLISECONDS_PER_SECOND = 1000
EDITOR_VERSION_WINDOW_MS = 60 * MILLISECONDS_PER_SECOND
MUTATION_AUDIT_RETENTION_MS = 24 * 60 * 60 * MILLISECONDS_PER_SECOND
EXTERNAL_OBSERVATION_REASON = "external"
SQLITE_BIND_BATCH_SIZE = 500
OPERATION_KIND_ADMISSION = "version_admission"
ADMISSION_SOURCE_MANUAL = "manual"
OPERATION_KIND_SEAL = "seal"
OPERATION_KIND_SINGLE_RESTORE = "single_restore"
OPERATION_KIND_DELIVERY_RESTORE = "delivery_restore"
OPERATION_KIND_SAVE_AS = "save_as"
OPERATION_KIND_FINALIZATION_RETRY = "finalization_retry"
OPERATION_KIND_REVIEW_REJECT = "review_reject"
OPERATION_KIND_PENDING_DISCARD = "pending_discard"
OPERATION_KIND_REVIEW_RECONCILE = "review_reconcile"
OPERATION_KIND_VERSION_ALIAS = "version_alias"
OPERATION_KIND_VERSION_DELETE = "version_delete"
OPERATION_STATE_PREPARED = "prepared"
OPERATION_STATE_COMMITTED = "committed"
ACTIVE_MUTATION_STATES = ("prepared", "file_applied")
VERSION_DELETE_CURRENT = "current_version"
VERSION_DELETE_PENDING = "pending_review"
VERSION_DELETE_MIGRATION = "review_migration"
VERSION_DELETE_RESTORE = "active_restore"
ACTIVE_RESTORE_STATES = ("prepared", "applying", "conflicted", "needs_attention")


@dataclass(frozen=True)
class DeliverySnapshot:
    """One CAS-published member awaiting atomic terminal publication."""

    baseline: TurnBaseline
    snapshot: SnapshotVersion
    descriptor: ObjectDescriptor | None
    annotation_descriptor: ObjectDescriptor | None
    change_kind: str
    attribution: ChangeAttribution = ChangeAttribution.UNKNOWN


@dataclass(frozen=True)
class WorkingMutation:
    """Durable current-file write intent used for crash reconciliation."""

    id: str
    file_id: str
    kind: ProductMutationKind
    state: str
    expected_revision: str | None
    target_revision: str
    target_object_id: str
    target_path: str
    target_mode_bits: int
    seal_version: bool
    request_digest: str | None


@dataclass(frozen=True)
class CapabilityState:
    """Persisted head and latest external observation for one logical path."""

    path: str
    file_id: str
    working_revision: str | None
    version_id: str | None
    head_state: str | None
    head_mode_bits: int | None
    observed_revision: str | None
    observed_state: str | None
    observed_mode_bits: int | None
    snapshot_state: SnapshotState
    pending: PendingSnapshot | None

    @property
    def drifted(self) -> bool:
        """An observation is drift only when it differs from the accepted head."""

        return self.observed_state is not None and (
            self.head_state != self.observed_state
            or self.head_mode_bits != self.observed_mode_bits
            or self.working_revision != self.observed_revision
        )


VERSIONED_FILES_SELECT = (
    "SELECT files.file_id, heads.path, heads.file_state, versions.version_id "
    "FROM resources_files files JOIN resources_heads heads USING(file_id) "
    "JOIN resources_versions versions ON versions.file_id = files.file_id "
    "AND versions.sequence = files.next_sequence - 1 "
)
PENDING_FILES_SELECT = (
    "SELECT pending.*, heads.path, heads.file_state, versions.version_id "
    "FROM resources_pending pending JOIN resources_heads heads USING(file_id) "
    "JOIN resources_files files USING(file_id) LEFT JOIN resources_versions versions "
    "ON versions.file_id = files.file_id AND versions.sequence = files.next_sequence - 1 "
)

CAPABILITY_STATES_SELECT = """
                        SELECT files.current_path, files.file_id,
                               heads.revision AS working_revision,
                               heads.file_state AS head_state,
                               heads.mode_bits AS head_mode_bits,
                               versions.version_id,
                               (versions.version_id IS NOT NULL
                                AND heads.file_state IS versions.file_state
                                AND heads.object_id IS versions.object_id
                                AND heads.path IS versions.path
                                AND heads.mode_bits IS versions.mode_bits)
                                   AS snapshot_saved,
                               observations.revision AS observed_revision,
                               observations.file_state AS observed_state,
                               observations.mode_bits AS observed_mode_bits,
                               pending.*
                        FROM resources_files AS files
                        LEFT JOIN resources_heads AS heads ON heads.file_id = files.file_id
                        LEFT JOIN resources_pending AS pending ON pending.file_id = files.file_id
                        LEFT JOIN resources_versions AS versions
                          ON versions.file_id = files.file_id
                         AND versions.sequence = files.next_sequence - 1
                        LEFT JOIN resources_observations AS observations
                          ON observations.observation_id = ? || ':' || files.file_id
"""

MANAGED_FILES_SELECT = """
                SELECT files.file_id, files.current_path, files.state, heads.revision,
                       heads.object_id, heads.mode_bits, heads.annotation_revision,
                       heads.annotation_object_id,
                       versions.version_id AS version_id
                FROM resources_files AS files
                JOIN resources_heads AS heads ON heads.file_id = files.file_id
                LEFT JOIN resources_versions AS versions
                  ON versions.file_id = files.file_id
                 AND versions.sequence = files.next_sequence - 1
                WHERE files.management_state = 'managed'
                  AND (files.state = 'present' OR ?)
                ORDER BY files.file_id
"""

SCHEMA = (
    """CREATE TABLE IF NOT EXISTS resources_admissions (
        file_id TEXT PRIMARY KEY REFERENCES resources_files(file_id) ON DELETE CASCADE,
        source TEXT NOT NULL, created_at_ms INTEGER NOT NULL
    )""",
    """
    CREATE TABLE IF NOT EXISTS resources_files (
        file_id TEXT PRIMARY KEY,
        current_root_id TEXT,
        current_path TEXT NOT NULL UNIQUE,
        media_type TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('present','tombstone')),
        management_state TEXT NOT NULL CHECK (
            management_state IN ('managed','ignored','oversized','unsupported','unavailable')
        ),
        next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_file_paths (
        path_id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES resources_files(file_id) ON DELETE CASCADE,
        root_id TEXT,
        path TEXT NOT NULL,
        valid_from_ms INTEGER NOT NULL,
        valid_to_ms INTEGER,
        move_origin TEXT,
        UNIQUE(file_id, valid_from_ms)
    )
    """,
    "CREATE INDEX IF NOT EXISTS resources_file_paths_lookup ON resources_file_paths(path, valid_to_ms)",
    """
    CREATE TABLE IF NOT EXISTS resources_objects (
        object_id TEXT PRIMARY KEY,
        layout TEXT NOT NULL CHECK (layout IN ('WHOLE','CHUNKED')),
        codec TEXT NOT NULL CHECK (codec IN ('IDENTITY','ZSTD','MANIFEST')),
        format_version INTEGER NOT NULL,
        raw_size_bytes INTEGER NOT NULL CHECK (raw_size_bytes >= 0),
        stored_size_bytes INTEGER NOT NULL CHECK (stored_size_bytes >= 0),
        descriptor_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('READY','TRASHED','CORRUPT')),
        stored_at_ms INTEGER NOT NULL,
        verified_at_ms INTEGER NOT NULL,
        trash_epoch TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_chunks (
        chunk_id TEXT PRIMARY KEY,
        codec TEXT NOT NULL CHECK (codec IN ('IDENTITY')),
        format_version INTEGER NOT NULL,
        raw_size_bytes INTEGER NOT NULL CHECK (raw_size_bytes > 0),
        stored_size_bytes INTEGER NOT NULL CHECK (stored_size_bytes > 0),
        descriptor_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('READY','TRASHED','CORRUPT')),
        stored_at_ms INTEGER NOT NULL,
        verified_at_ms INTEGER NOT NULL,
        trash_epoch TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_object_chunks (
        object_id TEXT NOT NULL REFERENCES resources_objects(object_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        chunk_id TEXT NOT NULL REFERENCES resources_chunks(chunk_id),
        raw_offset INTEGER NOT NULL CHECK (raw_offset >= 0),
        raw_size_bytes INTEGER NOT NULL CHECK (raw_size_bytes > 0),
        PRIMARY KEY(object_id, ordinal)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_heads (
        file_id TEXT PRIMARY KEY REFERENCES resources_files(file_id) ON DELETE CASCADE,
        revision TEXT,
        object_id TEXT REFERENCES resources_objects(object_id),
        file_state TEXT NOT NULL CHECK (file_state IN ('present','tombstone')),
        root_id TEXT,
        path TEXT NOT NULL,
        mode_bits INTEGER,
        annotation_revision TEXT,
        annotation_object_id TEXT REFERENCES resources_objects(object_id),
        accepted_at_ms INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_observations (
        observation_id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES resources_files(file_id) ON DELETE CASCADE,
        revision TEXT,
        file_state TEXT NOT NULL CHECK (file_state IN ('present','tombstone','unavailable')),
        size_bytes INTEGER,
        mtime_ns INTEGER,
        mode_bits INTEGER,
        reason TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS resources_observations_latest ON resources_observations(file_id, observed_at_ms DESC)",
    """
    CREATE TABLE IF NOT EXISTS resources_mutations (
        mutation_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        file_id TEXT NOT NULL REFERENCES resources_files(file_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('write','create','delete','move')),
        state TEXT NOT NULL CHECK (state IN (
            'prepared','file_applied','ledger_committed','conflicted','needs_reconcile'
        )),
        expected_revision TEXT,
        target_revision TEXT NOT NULL,
        target_object_id TEXT NOT NULL REFERENCES resources_objects(object_id),
        target_path TEXT NOT NULL,
        target_mode_bits INTEGER NOT NULL,
        seal_version INTEGER NOT NULL DEFAULT 0,
        request_digest TEXT,
        actor TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS resources_mutations_pending ON resources_mutations(state, created_at_ms)",
    """
    CREATE TABLE IF NOT EXISTS resources_operations (
        idempotency_key TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared','committed')),
        transaction_id TEXT,
        result_version_id TEXT REFERENCES resources_versions(version_id) ON DELETE CASCADE,
        result_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_operation_versions (
        idempotency_key TEXT NOT NULL REFERENCES resources_operations(idempotency_key)
            ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        version_id TEXT NOT NULL REFERENCES resources_versions(version_id) ON DELETE CASCADE,
        PRIMARY KEY(idempotency_key, ordinal),
        UNIQUE(idempotency_key, version_id)
    )
    """,
    """
    CREATE TRIGGER IF NOT EXISTS resources_operation_version_expired
    AFTER DELETE ON resources_operation_versions
    BEGIN
        DELETE FROM resources_operations WHERE idempotency_key = OLD.idempotency_key;
    END
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_versions (
        version_id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES resources_files(file_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        parent_version_id TEXT REFERENCES resources_versions(version_id),
        object_id TEXT REFERENCES resources_objects(object_id),
        file_state TEXT NOT NULL CHECK (file_state IN ('present','tombstone')),
        root_id TEXT,
        path TEXT NOT NULL,
        mode_bits INTEGER,
        annotation_object_id TEXT REFERENCES resources_objects(object_id),
        origin TEXT NOT NULL CHECK (origin IN (
            'initial_scan','user','external_confirmed','agent','restore','delivery_revert'
        )),
        review_backup INTEGER NOT NULL DEFAULT 0,
        editor_save INTEGER NOT NULL DEFAULT 0,
        delivery_id TEXT,
        restored_from_id TEXT REFERENCES resources_versions(version_id),
        restored_from_sequence INTEGER,
        restored_from_object_id TEXT,
        source_delivery_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        created_at_ms INTEGER NOT NULL,
        CHECK (
            (file_state = 'present' AND object_id IS NOT NULL)
            OR (file_state = 'tombstone' AND object_id IS NULL)
        ),
        UNIQUE(file_id, sequence)
    )
    """,
    "CREATE INDEX IF NOT EXISTS resources_versions_history ON resources_versions(file_id, sequence DESC)",
    "CREATE INDEX IF NOT EXISTS resources_versions_delivery ON resources_versions(delivery_id)",
    """
    CREATE TABLE IF NOT EXISTS resources_version_metadata (
        version_id TEXT PRIMARY KEY REFERENCES resources_versions(version_id) ON DELETE CASCADE,
        alias TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        updated_at_ms INTEGER NOT NULL,
        updated_by TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_turns (
        turn_occurrence_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        runtime_generation TEXT NOT NULL,
        baseline_generation INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (
            state IN ('accepted','running','finalizing','completed','discarded','unknown')
        ),
        terminal_payload_hash TEXT,
        finalization_digest TEXT,
        started_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(session_id, turn_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_turn_changes (
        turn_occurrence_id TEXT NOT NULL REFERENCES resources_turns(turn_occurrence_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        file_id TEXT NOT NULL REFERENCES resources_files(file_id) ON DELETE CASCADE,
        first_event_seq INTEGER NOT NULL,
        baseline_revision TEXT,
        baseline_object_id TEXT REFERENCES resources_objects(object_id),
        baseline_state TEXT NOT NULL,
        baseline_root_id TEXT,
        baseline_path TEXT NOT NULL,
        baseline_mode_bits INTEGER,
        baseline_annotation_revision TEXT,
        baseline_annotation_object_id TEXT REFERENCES resources_objects(object_id),
        baseline_version_id TEXT REFERENCES resources_versions(version_id),
        last_reported_revision TEXT,
        change_hint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open','discarded','sealed')),
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(turn_occurrence_id, file_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_turn_objects (
        turn_occurrence_id TEXT NOT NULL REFERENCES resources_turns(turn_occurrence_id) ON DELETE CASCADE,
        object_id TEXT NOT NULL REFERENCES resources_objects(object_id),
        PRIMARY KEY(turn_occurrence_id, object_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_turn_path_hints (
        turn_occurrence_id TEXT NOT NULL REFERENCES resources_turns(turn_occurrence_id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('agent')),
        change_kind TEXT NOT NULL,
        event_seq INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(turn_occurrence_id, path, source)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_turn_tool_calls (
        turn_occurrence_id TEXT NOT NULL REFERENCES resources_turns(turn_occurrence_id) ON DELETE CASCADE,
        event_seq INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        runtime_event_id TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(turn_occurrence_id, event_seq)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_deliveries (
        delivery_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        UNIQUE(session_id, turn_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_delivery_members (
        delivery_id TEXT NOT NULL REFERENCES resources_deliveries(delivery_id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES resources_files(file_id) ON DELETE CASCADE,
        change_kind TEXT NOT NULL CHECK (change_kind IN ('create','update','delete','move')),
        before_version_id TEXT REFERENCES resources_versions(version_id),
        before_object_id TEXT REFERENCES resources_objects(object_id),
        before_state TEXT NOT NULL,
        before_root_id TEXT,
        before_path TEXT NOT NULL,
        before_mode_bits INTEGER,
        before_annotation_object_id TEXT REFERENCES resources_objects(object_id),
        after_version_id TEXT NOT NULL REFERENCES resources_versions(version_id),
        attribution TEXT NOT NULL CHECK (attribution IN ('agent','unknown')),
        PRIMARY KEY(delivery_id, file_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_restores (
        transaction_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('single','delivery')),
        source_id TEXT NOT NULL,
        policy TEXT NOT NULL CHECK (policy IN ('strict','force','skip_conflicts')),
        state TEXT NOT NULL CHECK (state IN (
            'prepared','applying','committed','conflicted','needs_attention','aborted'
        )),
        preflight_token TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_restore_members (
        transaction_id TEXT NOT NULL REFERENCES resources_restores(transaction_id) ON DELETE CASCADE,
        member_order INTEGER NOT NULL,
        file_id TEXT NOT NULL REFERENCES resources_files(file_id),
        conflict_at_prepare INTEGER NOT NULL DEFAULT 0,
        expected_revision TEXT,
        expected_annotation_revision TEXT,
        expected_state TEXT NOT NULL CHECK (expected_state IN ('present','tombstone')),
        expected_path TEXT NOT NULL,
        before_object_id TEXT REFERENCES resources_objects(object_id),
        before_annotation_object_id TEXT REFERENCES resources_objects(object_id),
        before_state TEXT NOT NULL CHECK (before_state IN ('present','tombstone')),
        before_path TEXT NOT NULL,
        before_mode_bits INTEGER,
        target_object_id TEXT REFERENCES resources_objects(object_id),
        target_state TEXT NOT NULL CHECK (target_state IN ('present','tombstone')),
        target_path TEXT NOT NULL,
        target_mode_bits INTEGER,
        target_annotation_object_id TEXT REFERENCES resources_objects(object_id),
        applied INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(transaction_id, file_id),
        UNIQUE(transaction_id, member_order)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_gc_candidates (
        entry_kind TEXT NOT NULL CHECK (entry_kind IN ('object','chunk')),
        identifier TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('trashed')),
        trash_epoch TEXT NOT NULL,
        marked_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(entry_kind, identifier)
    )
    """,
    pending.SCHEMA,
    *batch.SCHEMA,
    migration.SCHEMA,
)

ADDITIVE_COLUMNS = {
    "resources_turn_tool_calls": (("runtime_event_id", "TEXT"),),
    "resources_review_migrations": (("resolution", "TEXT"),),
    "resources_pending": (
        (
            "review_origin",
            "TEXT DEFAULT 'agent' CHECK (review_origin IN ('agent','external'))",
        ),
    ),
    "resources_review_batch_members": (
        (
            "origin",
            "TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent','external'))",
        ),
    ),
    "resources_restores": (
        (
            "completion",
            "TEXT NOT NULL DEFAULT 'version' CHECK (completion IN ('version','pending_cancel'))",
        ),
        ("review_id", "TEXT"),
        ("pending_revision", "INTEGER"),
        ("review_resolution", "TEXT"),
    ),
    "resources_versions": (
        ("source_review_id", "TEXT"),
        ("review_outcome", "TEXT CHECK (review_outcome IN ('accepted','revised'))"),
        ("review_backup", "INTEGER NOT NULL DEFAULT 0"),
        ("editor_save", "INTEGER NOT NULL DEFAULT 0"),
    ),
    "resources_mutations": (
        ("request_digest", "TEXT"),
        ("seal_version", "INTEGER NOT NULL DEFAULT 0"),
    ),
    "resources_observations": (("annotation_revision", "TEXT"),),
    "resources_turns": (
        ("model_context", "TEXT"),
        ("capture_result_json", "TEXT"),
        ("vendor_turn_id", "TEXT"),
        ("initial_paths_json", "TEXT"),
        ("terminal_outcome", "TEXT"),
        ("finalization_error", "TEXT"),
        ("finalization_manifest_json", "TEXT"),
    ),
    "resources_turn_changes": (
        ("baseline_pending_origin", "TEXT"),
        ("baseline_annotation_revision", "TEXT"),
        (
            "baseline_annotation_object_id",
            "TEXT REFERENCES resources_objects(object_id)",
        ),
    ),
    "resources_delivery_members": (
        (
            "attribution",
            "TEXT NOT NULL DEFAULT 'unknown' CHECK (attribution IN ('agent','unknown'))",
        ),
        (
            "before_annotation_object_id",
            "TEXT REFERENCES resources_objects(object_id)",
        ),
    ),
    "resources_restore_members": (
        ("expected_annotation_revision", "TEXT"),
        (
            "before_annotation_object_id",
            "TEXT REFERENCES resources_objects(object_id)",
        ),
    ),
}

LEGACY_COLUMNS = {
    "resources_turns": (("opaque_mutation", "INTEGER NOT NULL DEFAULT 0"),),
}
LEGACY_SCHEMAS = {"resources_pending": (pending.LEGACY_SCHEMA,)}


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


@dataclass(frozen=True)
class ObservationTransition:
    drifted: bool
    accepted: bool
    before: PendingSnapshot | None
    after: PendingSnapshot | None


@dataclass(frozen=True)
class InitialVersionState:
    file_id: str | None
    version: VersionRef | None
    required: bool
    deferred: bool


@dataclass(frozen=True)
class InitialVersionPlan:
    """Explicit first-version identities shared by recovery preview and execution."""

    now_ms: int
    file_id: str
    path_id: str
    version_id: str
    observation_id: str

    def validate(self) -> None:
        if type(self.now_ms) is not int or self.now_ms < 0:
            raise ValueError("invalid initial version timestamp")
        for value in (self.file_id, self.path_id, self.version_id, self.observation_id):
            if (
                not isinstance(value, str)
                or len(value) != 32
                or any(character not in "0123456789abcdef" for character in value)
            ):
                raise ValueError("invalid initial version identity")
        if len({self.file_id, self.path_id, self.version_id, self.observation_id}) != 4:
            raise ValueError("initial version identities must be distinct")

    @classmethod
    def fresh(cls, now_ms: int) -> InitialVersionPlan:
        result = cls(now_ms, *(uuid4().hex for _ in range(4)))
        result.validate()
        return result

    @classmethod
    def for_recovery(
        cls, attempt: str, operation: str, project: str, path: str, *, now_ms: int
    ) -> InitialVersionPlan:
        if (
            not isinstance(attempt, str)
            or len(attempt) != 64
            or any(character not in "0123456789abcdef" for character in attempt)
        ):
            raise ValueError("invalid resource recovery attempt")
        if any(
            not isinstance(value, str) or not value or "\0" in value
            for value in (operation, project, path)
        ):
            raise ValueError("invalid resource recovery scope")
        scope = json.dumps(
            ("scholarseed-initial-version-v1", attempt, operation, project, path, now_ms),
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("ascii")
        result = cls(
            now_ms,
            *(
                sha256(scope + b"\0" + role).hexdigest()[:32]
                for role in (b"file", b"path", b"version", b"observation")
            ),
        )
        result.validate()
        return result


def _version(row: sqlite3.Row) -> VersionRef:
    keys = set(row.keys())
    return VersionRef(
        id=str(row["version_id"]),
        file_id=str(row["file_id"]),
        sequence=int(row["sequence"]),
        object_id=str(row["object_id"]) if row["object_id"] is not None else None,
        state=FileState(str(row["file_state"])),
        path=str(row["path"]),
        mode_bits=int(row["mode_bits"]) if row["mode_bits"] is not None else None,
        annotation_object_id=(
            str(row["annotation_object_id"]) if row["annotation_object_id"] is not None else None
        ),
        origin=VersionOrigin(str(row["origin"])),
        created_at_ms=int(row["created_at_ms"]),
        session_id=str(row["session_id"]) if row["session_id"] is not None else None,
        turn_id=str(row["turn_id"]) if row["turn_id"] is not None else None,
        restored_from_id=(
            str(row["restored_from_id"]) if row["restored_from_id"] is not None else None
        ),
        restored_from_sequence=(
            int(row["restored_from_sequence"])
            if row["restored_from_sequence"] is not None
            else None
        ),
        restored_from_object_id=(
            str(row["restored_from_object_id"])
            if row["restored_from_object_id"] is not None
            else None
        ),
        delivery_id=str(row["delivery_id"]) if row["delivery_id"] is not None else None,
        source_delivery_id=(
            str(row["source_delivery_id"]) if row["source_delivery_id"] is not None else None
        ),
        source_review_id=row["source_review_id"],
        review_outcome=ReviewOutcome(row["review_outcome"]) if row["review_outcome"] else None,
        alias=(str(row["alias"]) if "alias" in keys and row["alias"] is not None else None),
        metadata_revision=(
            int(row["metadata_revision"])
            if "metadata_revision" in keys and row["metadata_revision"] is not None
            else 0
        ),
        review_backup=bool(row["review_backup"]) if "review_backup" in keys else False,
    )


def _restore_member(row: sqlite3.Row) -> RestoreMember:
    return RestoreMember(
        order=int(row["member_order"]),
        file_id=str(row["file_id"]),
        conflict_at_prepare=bool(row["conflict_at_prepare"]),
        expected_revision=(
            str(row["expected_revision"]) if row["expected_revision"] is not None else None
        ),
        expected_annotation_revision=(
            str(row["expected_annotation_revision"])
            if row["expected_annotation_revision"] is not None
            else None
        ),
        expected_state=FileState(str(row["expected_state"])),
        expected_path=str(row["expected_path"]),
        before_object_id=(
            str(row["before_object_id"]) if row["before_object_id"] is not None else None
        ),
        before_annotation_object_id=(
            str(row["before_annotation_object_id"])
            if row["before_annotation_object_id"] is not None
            else None
        ),
        before_state=FileState(str(row["before_state"])),
        before_path=str(row["before_path"]),
        before_mode_bits=(
            int(row["before_mode_bits"]) if row["before_mode_bits"] is not None else None
        ),
        target_object_id=(
            str(row["target_object_id"]) if row["target_object_id"] is not None else None
        ),
        target_annotation_object_id=(
            str(row["target_annotation_object_id"])
            if row["target_annotation_object_id"] is not None
            else None
        ),
        target_state=FileState(str(row["target_state"])),
        target_path=str(row["target_path"]),
        target_mode_bits=(
            int(row["target_mode_bits"]) if row["target_mode_bits"] is not None else None
        ),
        applied=bool(row["applied"]),
    )


def _snapshot_identity(row: sqlite3.Row) -> SnapshotIdentity:
    return SnapshotIdentity(
        object_id=row["object_id"],
        state=FileState(row["file_state"]),
        path=row["path"],
        mode_bits=row["mode_bits"],
        annotation_object_id=row["annotation_object_id"],
    )


@dataclass(frozen=True)
class VersionSchema:
    create_tables: tuple[str, ...]
    add_columns: tuple[tuple[str, str], ...]
    create_indexes: tuple[str, ...]
    create_triggers: tuple[str, ...] = ()
    repair_tables: tuple[str, ...] = ()

    @property
    def needs_write(self) -> bool:
        return bool(
            self.create_tables
            or self.add_columns
            or self.create_indexes
            or self.create_triggers
            or self.repair_tables
        )


class VersionStore:
    """Own all resources_* version relations inside the shared project DB."""

    def __init__(self, database: Path | str, project_root: Path | str) -> None:
        self._database = ProjectDatabasePath(Path(database), Path(project_root))

    def ensure(self) -> None:
        # Runtime callers coexist with other admitted SQLite connections. Their
        # WAL/SHM generations may change across our read connection's closure.
        # Startup/update inspection below retains the strict stable-source gate.
        if not self._inspect_path(self._database.path, stable_sidecars=False).needs_write:
            return
        with closing(connect(self._database)) as connection, schema_transaction(connection):
            self.initialize_schema(connection)

    @classmethod
    def initialize_schema(cls, connection: sqlite3.Connection) -> None:
        """Apply owner migrations in a caller-owned transaction or private copy."""
        schema = cls.inspect_connection(connection)
        if schema.needs_write:
            cls._initialize(connection)
        definitions = {name: definition for name, definition, *_ in cls._schema_definitions()[0]}
        for name in schema.repair_tables:
            rebuild_table(connection, name, partial(cls._create_repaired_table, definitions[name]))
        if cls.inspect_connection(connection).needs_write:
            raise RuntimeError("resource version initialization did not converge")

    @staticmethod
    def _create_repaired_table(definition: str, connection: sqlite3.Connection, name: str) -> None:
        connection.execute(f'CREATE TABLE "{name}" ' + definition[definition.index("(") :])

    @classmethod
    @lru_cache(maxsize=1)
    def _legacy_definitions(cls) -> dict[str, tuple[tuple[tuple[str, ...], ...], ...]]:
        result = {}
        for name, declarations in LEGACY_SCHEMAS.items():
            variants = []
            for declaration in declarations:
                with closing(sqlite3.connect(":memory:")) as reference:
                    reference.execute(declaration)
                    variants.append(table_clauses(declaration, name))
                    for column, definition in ADDITIVE_COLUMNS.get(name, ()):
                        reference.execute(f'ALTER TABLE "{name}" ADD COLUMN {column} {definition}')
                    updated = reference.execute(
                        "SELECT sql FROM sqlite_master WHERE name=?", (name,)
                    ).fetchone()[0]
                    variants.append(table_clauses(updated, name))
            result[name] = tuple(variants)
        return result

    @staticmethod
    def _initialize(connection: sqlite3.Connection) -> None:
        for statement in SCHEMA:
            connection.execute(statement)
        for table, definitions in ADDITIVE_COLUMNS.items():
            columns = {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}
            for name, declaration in definitions:
                if name not in columns:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")

    @classmethod
    def inspect_schema(cls, database: Path) -> VersionSchema:
        """Read one WAL snapshot within caller-owned directory qualification."""
        return cls._inspect_path(database, stable_sidecars=True)

    @classmethod
    def _inspect_path(cls, database: Path, *, stable_sidecars: bool) -> VersionSchema:
        return inspect_database(database, cls.inspect_connection, stable_sidecars=stable_sidecars)

    @classmethod
    @lru_cache(maxsize=1)
    def _schema_definitions(cls):
        """Compile immutable code declarations only; never cache database state."""
        with closing(sqlite3.connect(":memory:")) as reference:
            cls._initialize(reference)
            tables = tuple(
                (
                    name,
                    sql,
                    table_clauses(sql, name),
                    tuple(row[1] for row in reference.execute(f"PRAGMA table_xinfo({name})")),
                )
                for name, sql in reference.execute(
                    "SELECT name,sql FROM sqlite_master WHERE type='table'"
                )
            )
            indexes = tuple(
                (name, table, sql, sql_tokens(sql))
                for name, table, sql in reference.execute(
                    "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
                )
            )
            triggers = tuple(
                (name, table, sql, sql_tokens(sql))
                for name, table, sql in reference.execute(
                    "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger'"
                )
            )
            return tables, indexes, triggers

    @classmethod
    def preview_triggers(cls) -> tuple[tuple[str, str, str], ...]:
        """Exact immutable trigger declarations owned by this signed version."""
        return tuple(
            (name, table, sql) for name, table, sql, _tokens in cls._schema_definitions()[2]
        )

    @classmethod
    def inspect_connection(cls, connection: sqlite3.Connection) -> VersionSchema:
        objects = {
            row["name"]: row
            for row in connection.execute("SELECT name,type,tbl_name,sql FROM sqlite_master")
        }
        missing_tables: list[str] = []
        missing_columns: list[tuple[str, str]] = []
        missing_indexes: list[str] = []
        repair_tables: list[str] = []
        tables, indexes, triggers = cls._schema_definitions()
        reject_schema_residue(connection, (name for name, *_ in tables))
        for name, definition, clauses, column_order in tables:
            if name not in objects:
                missing_tables.append(name)
                continue
            current = objects[name]
            if current["type"] != "table":
                raise RuntimeError("unsupported resource version table object")
            if current["sql"] == definition:
                continue
            columns = connection.execute(f"PRAGMA table_xinfo({name})").fetchall()
            if any(row["hidden"] for row in columns):
                raise RuntimeError("unsupported resource version generated columns")
            observed_names = {row["name"] for row in columns}
            added = {
                column
                for column, _ in ADDITIVE_COLUMNS.get(name, ())
                if column not in observed_names
            }
            missing_columns.extend((name, column) for column in sorted(added))
            expected = tuple(clause for clause in clauses if clause[0] not in added)
            try:
                actual = table_clauses(current["sql"], name)
            except ValueError as error:
                raise RuntimeError("unsupported resource version declaration") from error
            legacy_columns = {
                sql_tokens(f"{column} {declaration}")
                for column, declaration in LEGACY_COLUMNS.get(name, ())
            }
            normalized = tuple(clause for clause in actual if clause not in legacy_columns)
            if len(normalized) != len(expected) or set(normalized) != set(expected):
                if any(
                    len(actual) == len(legacy) and set(actual) == set(legacy)
                    for legacy in cls._legacy_definitions().get(name, ())
                ):
                    repair_tables.append(name)
                else:
                    raise RuntimeError("unsupported resource version constraints or columns")
            if (
                name not in ADDITIVE_COLUMNS
                and tuple(row["name"] for row in columns) != column_order
            ):
                raise RuntimeError("unsupported resource version column order")
        for name, table, definition, tokens in indexes:
            if name not in objects:
                missing_indexes.append(name)
            elif (
                objects[name]["type"] != "index"
                or objects[name]["tbl_name"] != table
                or (
                    objects[name]["sql"] != definition
                    and sql_tokens(objects[name]["sql"] or "") != tokens
                )
            ):
                raise RuntimeError("unsupported resource version index")
        missing_triggers = []
        for name, table, _definition, tokens in triggers:
            if name not in objects:
                missing_triggers.append(name)
            elif (
                objects[name]["type"] != "trigger"
                or objects[name]["tbl_name"] != table
                or sql_tokens(objects[name]["sql"] or "") != tokens
            ):
                raise RuntimeError("unsupported resource version trigger")
        return VersionSchema(
            tuple(missing_tables),
            tuple(missing_columns),
            tuple(missing_indexes),
            tuple(missing_triggers),
            tuple(repair_tables),
        )

    @classmethod
    def inspect_rows(cls, connection: sqlite3.Connection) -> None:
        """Read history/recovery codecs without resuming operations or touching CAS.

        This covers file/observation projections, versions, pending reviews,
        batches, turn manifests, delivery and restore records. Physical CAS
        formats still need their own reader before whole-product admission.
        """
        for query, parameters, decode in (
            (VERSIONED_FILES_SELECT, (), cls._versioned_file),
            (PENDING_FILES_SELECT, (), cls._pending_file),
            (CAPABILITY_STATES_SELECT, (EXTERNAL_OBSERVATION_REASON,), cls._capability_state),
            (MANAGED_FILES_SELECT, (False,), cls._managed_file),
        ):
            for row in connection.execute(query, parameters):
                decode(row)
        for row in connection.execute(
            "SELECT versions.*,metadata.alias,COALESCE(metadata.revision,0) AS metadata_revision "
            "FROM resources_versions versions LEFT JOIN resources_version_metadata metadata USING(version_id)"
        ):
            _version(row)
        for table, decode_record in (
            ("resources_heads", _snapshot_identity),
            ("resources_pending", pending.from_row),
            ("resources_mutations", cls._working_mutation),
            ("resources_turn_changes", cls._turn_baseline),
            ("resources_restore_members", _restore_member),
        ):
            for row in connection.execute(f"SELECT * FROM {table}"):
                decode_record(row)
        for row in connection.execute("SELECT * FROM resources_restores"):
            members = connection.execute(
                "SELECT * FROM resources_restore_members WHERE transaction_id=? ORDER BY member_order",
                (row["transaction_id"],),
            ).fetchall()
            cls._restore_transaction(row, members)
        for row in connection.execute("SELECT * FROM resources_turns"):
            cls._turn_inventory(row)
            cls._staged_delivery(row)
            cls._review_result(row)
            if row["terminal_outcome"] is not None:
                cls._finalization(connection, row)
        for row in connection.execute(
            "SELECT * FROM resources_operations WHERE state=?", (OPERATION_STATE_COMMITTED,)
        ):
            cls._operation_payload(row)
            if row["transaction_id"] is not None:
                cls._restore_outcome(connection, row)
        for delivery in connection.execute("SELECT * FROM resources_deliveries"):
            members = connection.execute(
                "SELECT members.*,versions.path FROM resources_delivery_members members "
                "JOIN resources_versions versions ON versions.version_id=members.after_version_id "
                "WHERE members.delivery_id=? ORDER BY members.file_id",
                (delivery["delivery_id"],),
            ).fetchall()
            cls._delivery_result(delivery, members)
        for row in connection.execute(
            "SELECT members.*,versions.path AS after_path,versions.object_id AS after_revision,"
            "versions.annotation_object_id AS after_annotation_object_id FROM resources_delivery_members members "
            "LEFT JOIN resources_versions versions ON versions.version_id=members.after_version_id"
        ):
            cls._delivery_recovery_member(row)
        batch.inspect_rows(connection)
        migration.inspect_rows(connection)

    def observe(
        self, file_id: str, observation: DiskObservation, *, now_ms: int | None = None
    ) -> bool:
        """Replace one bounded external observation without advancing any head."""
        self.ensure()
        with transaction(self._database, immediate=True) as connection:
            return self.observe_rows(
                connection, file_id, observation, now=_now_ms() if now_ms is None else now_ms
            )

    @staticmethod
    def observe_rows(
        connection: sqlite3.Connection, file_id: str, observation: DiskObservation, *, now: int
    ) -> bool:
        """Apply the real observation transition in a live or private transaction."""
        if not connection.in_transaction:
            raise ValueError("resource observation requires a transaction")
        if type(now) is not int or now < 0:
            raise ValueError("invalid resource observation timestamp")
        identity = f"{EXTERNAL_OBSERVATION_REASON}:{file_id}"
        values = (
            observation.revision,
            observation.state.value,
            observation.size_bytes,
            observation.mtime_ns,
            observation.mode_bits,
            observation.annotation_revision,
        )
        if observation.state is ObservationState.TOMBSTONE:
            connection.execute("DELETE FROM resources_admissions WHERE file_id = ?", (file_id,))
        existing = connection.execute(
            """SELECT revision, file_state, size_bytes, mtime_ns, mode_bits,
                      annotation_revision FROM resources_observations
               WHERE observation_id = ?""",
            (identity,),
        ).fetchone()
        if existing is not None and tuple(existing) == values:
            return False
        connection.execute(
            """INSERT INTO resources_observations
               (observation_id, file_id, revision, file_state, size_bytes,
                mtime_ns, mode_bits, annotation_revision, reason, observed_at_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(observation_id) DO UPDATE SET
                 revision=excluded.revision, file_state=excluded.file_state,
                 size_bytes=excluded.size_bytes, mtime_ns=excluded.mtime_ns,
                 mode_bits=excluded.mode_bits,
                 annotation_revision=excluded.annotation_revision,
                 observed_at_ms=excluded.observed_at_ms""",
            (identity, file_id, *values, EXTERNAL_OBSERVATION_REASON, now),
        )
        return True

    def reconcile_external(
        self,
        file_id: str,
        path: str,
        observation: DiskObservation,
        snapshot: SnapshotVersion | None,
        descriptor: ObjectDescriptor | None,
        *,
        now_ms: int | None = None,
    ) -> ObservationTransition:
        """Persist one captured external change and its pending state atomically."""
        self.ensure()
        with transaction(self._database, immediate=True) as connection:
            return self.reconcile_external_rows(
                connection,
                file_id,
                path,
                observation,
                snapshot,
                descriptor,
                now=_now_ms() if now_ms is None else now_ms,
            )

    @classmethod
    def reconcile_external_rows(
        cls,
        connection: sqlite3.Connection,
        file_id: str,
        path: str,
        observation: DiskObservation,
        snapshot: SnapshotVersion | None,
        descriptor: ObjectDescriptor | None,
        *,
        now: int,
    ) -> ObservationTransition:
        """Share the real observation/review decision with private recovery copies.

        The caller captures content and verifies CAS first. An unavailable source
        records drift without replacing the accepted head; open reviews and active
        execution retain their existing ownership of that head.
        """
        if not connection.in_transaction:
            raise ValueError("external reconciliation requires a transaction")
        row = connection.execute(
            "SELECT current_path FROM resources_files WHERE file_id = ?", (file_id,)
        ).fetchone()
        if row is None or row["current_path"] != path:
            raise VersionStoreConflict("file_not_managed")
        available = observation.state is not ObservationState.UNAVAILABLE
        if available:
            if (
                snapshot is None
                or snapshot.path != path
                or snapshot.state.value != observation.state.value
                or snapshot.revision != observation.revision
                or snapshot.mode_bits != observation.mode_bits
                or snapshot.mtime_ns != observation.mtime_ns
            ):
                raise VersionStoreConflict("observation_snapshot_mismatch")
            if observation.state is ObservationState.PRESENT and (
                descriptor is None
                or descriptor.object_id != snapshot.object_id
                or snapshot.object_id != observation.revision
                or descriptor.raw_size_bytes != observation.size_bytes
            ):
                raise VersionStoreConflict("observation_object_mismatch")
            if observation.state is ObservationState.TOMBSTONE and (
                descriptor is not None or snapshot.object_id is not None
            ):
                raise VersionStoreConflict("tombstone_observation_has_object")
        elif snapshot is not None or descriptor is not None:
            raise VersionStoreConflict("unavailable_observation_has_snapshot")
        changed = cls.observe_rows(connection, file_id, observation, now=now)
        head = connection.execute(
            "SELECT * FROM resources_heads WHERE file_id = ?", (file_id,)
        ).fetchone()
        identity = _snapshot_identity(head) if head is not None else None
        observed = (
            SnapshotIdentity(
                observation.revision,
                FileState(observation.state.value),
                path,
                observation.mode_bits,
                None,
            )
            if available
            else None
        )
        drifted = not available or not same_source_identity(identity, observed)
        before = pending.read(connection, file_id)
        accepted = bool(
            available
            and drifted
            and not (before and before.review)
            and not cls._initialization_deferred(connection, path)
        )
        if accepted:
            assert snapshot is not None
            cls.accept_working_rows(
                connection,
                file_id,
                snapshot,
                descriptor,
                None,
                PendingOrigin.EXTERNAL.value,
                now=now,
            )
        return ObservationTransition(
            changed and drifted, accepted, before, pending.read(connection, file_id)
        )

    def history(self, path: str) -> tuple[VersionRef, ...]:
        if not self._database.exists():
            return ()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute(
                """
                SELECT versions.*
                FROM resources_versions AS versions
                JOIN resources_files AS files ON files.file_id = versions.file_id
                WHERE files.current_path = ?
                ORDER BY versions.sequence DESC
                """,
                (path,),
            ).fetchall()
        finally:
            connection.close()
        return tuple(_version(row) for row in rows)

    def versioned_paths(self) -> frozenset[str]:
        """Return current paths whose stable identity has at least one Version."""

        if not self._database.exists():
            return frozenset()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute("""
                SELECT files.current_path
                FROM resources_files AS files
                WHERE EXISTS (
                    SELECT 1 FROM resources_versions AS versions
                    WHERE versions.file_id = files.file_id
                )
                """).fetchall()
        finally:
            connection.close()
        return frozenset(str(row["current_path"]) for row in rows)

    def history_page(
        self,
        file_id: str,
        *,
        before_sequence: int | None = None,
        limit: int = 50,
        query: str = "",
        origin: str | None = None,
        order: str = "newest",
    ) -> tuple[tuple[VersionRef, ...], int]:
        """Return one filtered, stably ordered page and its total size."""

        if not self._database.exists():
            return (), 0
        self.ensure()
        connection = connect(self._database)
        try:
            where = ["versions.file_id = ?"]
            values: list[object] = [file_id]
            if query:
                where.append(
                    "("
                    "LOWER(COALESCE(metadata.alias, '')) LIKE ? OR "
                    "LOWER(versions.path) LIKE ? OR LOWER(versions.origin) LIKE ? OR "
                    "LOWER(COALESCE(versions.turn_id, '')) LIKE ? OR "
                    "LOWER('v' || versions.sequence) LIKE ?"
                    ")"
                )
                pattern = f"%{query.lower()}%"
                values.extend((pattern,) * 5)
            if origin is not None:
                where.append("versions.origin = ?")
                values.append(origin)
            ascending = order == "oldest"
            base_predicate = " AND ".join(where)
            total = int(
                connection.execute(
                    f"""
                    SELECT COUNT(*) FROM resources_versions AS versions
                    LEFT JOIN resources_version_metadata AS metadata USING(version_id)
                    WHERE {base_predicate}
                    """,
                    values,
                ).fetchone()[0]
            )
            if before_sequence is not None:
                where.append(f"versions.sequence {'>' if ascending else '<'} ?")
                values.append(before_sequence)
            predicate = " AND ".join(where)
            rows = connection.execute(
                f"""
                SELECT versions.*, metadata.alias,
                       COALESCE(metadata.revision, 0) AS metadata_revision
                FROM resources_versions AS versions
                LEFT JOIN resources_version_metadata AS metadata USING(version_id)
                WHERE {predicate}
                ORDER BY versions.sequence {"ASC" if ascending else "DESC"} LIMIT ?
                """,
                (*values, limit),
            ).fetchall()
        finally:
            connection.close()
        return tuple(_version(row) for row in rows), total

    def history_for_file(
        self, file_id: str, *, before_sequence: int | None = None, limit: int = 50
    ) -> tuple[VersionRef, ...]:
        """Preserve the original newest-first history contract."""

        versions, _total = self.history_page(file_id, before_sequence=before_sequence, limit=limit)
        return versions

    def update_alias(
        self,
        version_id: str,
        alias: str | None,
        expected_revision: int,
        actor: str,
        idempotency_key: str,
        request_digest: str,
    ) -> VersionRef:
        """Compare-and-swap mutable display metadata without touching Version facts."""

        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            receipt = self._operation_row(
                connection,
                idempotency_key,
                OPERATION_KIND_VERSION_ALIAS,
                version_id,
                request_digest,
            )
            if receipt is not None:
                row = self._version_row(connection, version_id)
                if row is None:
                    raise VersionStoreConflict("version_not_found")
                return _version(row)
            row = self._version_row(connection, version_id)
            if row is None:
                raise VersionStoreConflict("version_not_found")
            current_revision = int(row["metadata_revision"])
            if current_revision != expected_revision:
                raise VersionStoreConflict("version_metadata_conflict")
            next_revision = current_revision + 1
            connection.execute(
                """
                INSERT INTO resources_version_metadata (
                    version_id, alias, revision, updated_at_ms, updated_by
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(version_id) DO UPDATE SET
                    alias = excluded.alias,
                    revision = excluded.revision,
                    updated_at_ms = excluded.updated_at_ms,
                    updated_by = excluded.updated_by
                """,
                (version_id, alias, next_revision, now, actor),
            )
            result = {"version_id": version_id, "metadata_revision": next_revision}
            connection.execute(
                """
                INSERT INTO resources_operations (
                    idempotency_key, operation_kind, target_id, request_digest,
                    state, result_json, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    idempotency_key,
                    OPERATION_KIND_VERSION_ALIAS,
                    version_id,
                    request_digest,
                    OPERATION_STATE_COMMITTED,
                    json.dumps(result, separators=(",", ":"), sort_keys=True),
                    now,
                    now,
                ),
            )
            updated = self._version_row(connection, version_id)
            if updated is None:
                raise VersionStoreConflict("version_not_found")
            return _version(updated)

    @staticmethod
    def _version_row(connection: sqlite3.Connection, version_id: str) -> sqlite3.Row | None:
        return connection.execute(
            """
            SELECT versions.*, metadata.alias,
                   COALESCE(metadata.revision, 0) AS metadata_revision
            FROM resources_versions AS versions
            LEFT JOIN resources_version_metadata AS metadata USING(version_id)
            WHERE versions.version_id = ?
            """,
            (version_id,),
        ).fetchone()

    @staticmethod
    def _delete_facts(
        connection: sqlite3.Connection, version_id: str
    ) -> tuple[sqlite3.Row, tuple[str, ...], tuple[str, ...], str | None]:
        version = VersionStore._version_row(connection, version_id)
        if version is None:
            raise VersionStoreConflict("version_not_found")
        current = connection.execute(
            """
            SELECT versions.version_id FROM resources_files AS files
            JOIN resources_versions AS versions
              ON versions.file_id = files.file_id
             AND versions.sequence = files.next_sequence - 1
            WHERE files.file_id = ?
            """,
            (version["file_id"],),
        ).fetchone()
        current_id = str(current["version_id"]) if current is not None else None
        delivery_rows = connection.execute(
            """
            SELECT DISTINCT delivery_id FROM resources_delivery_members
            WHERE before_version_id = ? OR after_version_id = ?
            ORDER BY delivery_id
            """,
            (version_id, version_id),
        ).fetchall()
        delivery_ids = tuple(str(row["delivery_id"]) for row in delivery_rows)
        blockers: list[str] = []
        if current_id == version_id:
            blockers.append(VERSION_DELETE_CURRENT)
        if (
            connection.execute(
                "SELECT 1 FROM resources_pending WHERE base_version_id = ? LIMIT 1",
                (version_id,),
            ).fetchone()
            is not None
        ):
            blockers.append(VERSION_DELETE_PENDING)
        protected_versions, protected_deliveries = migration.protected_history(connection)
        if version_id in protected_versions or protected_deliveries.intersection(delivery_ids):
            blockers.append(VERSION_DELETE_MIGRATION)
        restore_placeholders = ",".join("?" for _item in ACTIVE_RESTORE_STATES)
        restore_targets = (version_id, *delivery_ids, *ACTIVE_RESTORE_STATES)
        source_placeholders = ",".join("?" for _item in (version_id, *delivery_ids))
        if (
            connection.execute(
                f"""
            SELECT 1 FROM resources_restores
            WHERE source_id IN ({source_placeholders})
              AND state IN ({restore_placeholders}) LIMIT 1
            """,
                restore_targets,
            ).fetchone()
            is not None
        ):
            blockers.append(VERSION_DELETE_RESTORE)
        return version, tuple(blockers), delivery_ids, current_id

    @staticmethod
    def _delete_token(
        version_id: str,
        current_id: str | None,
        blockers: tuple[str, ...],
        delivery_ids: tuple[str, ...],
    ) -> str:
        payload = json.dumps(
            {
                "version_id": version_id,
                "current_id": current_id,
                "blockers": blockers,
                "delivery_ids": delivery_ids,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        return sha256(payload.encode("utf-8")).hexdigest()

    def preview_delete(self, version_id: str) -> VersionDeletePreview:
        """Return stable deletion blockers and collateral Delivery impact."""

        if not self._database.exists():
            raise VersionStoreConflict("version_not_found")
        self.ensure()
        connection = connect(self._database)
        try:
            version, blockers, delivery_ids, current_id = self._delete_facts(connection, version_id)
        finally:
            connection.close()
        return VersionDeletePreview(
            version_id=version_id,
            file_id=str(version["file_id"]),
            sequence=int(version["sequence"]),
            deletable=not blockers,
            blockers=blockers,
            affected_delivery_ids=delivery_ids,
            preflight_token=self._delete_token(version_id, current_id, blockers, delivery_ids),
        )

    def delete_version(
        self,
        version_id: str,
        preflight_token: str,
        idempotency_key: str,
        request_digest: str,
    ) -> dict:
        """Delete one preflighted non-current version and persist an idempotent receipt."""

        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            receipt = self._operation_row(
                connection,
                idempotency_key,
                OPERATION_KIND_VERSION_DELETE,
                version_id,
                request_digest,
            )
            if receipt is not None:
                return json.loads(str(receipt["result_json"]))
            version, blockers, delivery_ids, current_id = self._delete_facts(connection, version_id)
            expected_token = self._delete_token(version_id, current_id, blockers, delivery_ids)
            if expected_token != preflight_token:
                raise VersionStoreConflict("version_delete_preview_stale")
            if blockers:
                raise VersionStoreConflict("version_delete_forbidden")
            self._delete_exact(connection, (version_id,), delivery_ids)
            remaining_count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM resources_versions WHERE file_id = ?",
                    (version["file_id"],),
                ).fetchone()[0]
            )
            result = {
                "deleted": True,
                "version_id": version_id,
                "remaining_count": remaining_count,
                "deleted_delivery_ids": delivery_ids,
            }
            connection.execute(
                """
                INSERT INTO resources_operations (
                    idempotency_key, operation_kind, target_id, request_digest,
                    state, result_json, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    idempotency_key,
                    OPERATION_KIND_VERSION_DELETE,
                    version_id,
                    request_digest,
                    OPERATION_STATE_COMMITTED,
                    json.dumps(result, separators=(",", ":"), sort_keys=True),
                    now,
                    now,
                ),
            )
            return result

    def manual_admitted(self, path: str) -> bool:
        return self.manual_admitted_states((path,)).get(path, False)

    def manual_admitted_states(self, paths: tuple[str, ...]) -> dict[str, bool]:
        selected = tuple(dict.fromkeys(paths))
        if not selected or not self._database.exists():
            return {}
        self.ensure()
        with transaction(self._database) as connection:
            return self.manual_admitted_rows(connection, selected)

    @staticmethod
    def manual_admitted_rows(
        connection: sqlite3.Connection, paths: tuple[str, ...]
    ) -> dict[str, bool]:
        selected = tuple(dict.fromkeys(paths))
        states: dict[str, bool] = {path: False for path in selected}
        for offset in range(0, len(selected), SQLITE_BIND_BATCH_SIZE):
            batch = selected[offset : offset + SQLITE_BIND_BATCH_SIZE]
            placeholders = ",".join("?" for _ in batch)
            rows = connection.execute(
                "SELECT current_path FROM resources_admissions JOIN resources_files USING(file_id) "
                f"WHERE current_path IN ({placeholders}) AND state = ? AND source = ?",
                (*batch, FileState.PRESENT.value, ADMISSION_SOURCE_MANUAL),
            ).fetchall()
            for row in rows:
                states[str(row["current_path"])] = True
        return states

    def admit(
        self,
        snapshot: SnapshotVersion,
        descriptor: ObjectDescriptor,
        annotation_descriptor: ObjectDescriptor | None,
        key: str,
        digest: str,
    ) -> dict:
        """Publish initial history, explicit selection and receipt atomically."""
        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            replay = self._operation_row(
                connection, key, OPERATION_KIND_ADMISSION, snapshot.path, digest
            )
            if replay is not None:
                return json.loads(replay["result_json"])
            identity = connection.execute(
                "SELECT * FROM resources_files WHERE current_path = ?", (snapshot.path,)
            ).fetchone()
            file_id: str | None = str(identity["file_id"]) if identity is not None else None
            if identity is not None:
                latest = connection.execute(
                    "SELECT * FROM resources_versions WHERE file_id = ? ORDER BY sequence DESC LIMIT 1",
                    (file_id,),
                ).fetchone()
                has_pending = (
                    connection.execute(
                        "SELECT 1 FROM resources_pending WHERE file_id = ?", (file_id,)
                    ).fetchone()
                    is not None
                )
            else:
                latest, has_pending = None, False
            version_id: str | None
            if latest is None and not has_pending:
                result = self._seal_snapshot(
                    connection,
                    snapshot,
                    descriptor,
                    now,
                    annotation_descriptor=annotation_descriptor,
                )
                file_id, version_id, unchanged = (
                    result.version.file_id,
                    result.version.id,
                    result.unchanged,
                )
                pending.sync_working(connection, file_id, PendingOrigin.USER, now)
            else:
                version_id = str(latest["version_id"]) if latest else None
                unchanged = True
            if file_id is None:
                raise VersionStoreConflict("file_identity_conflict")
            connection.execute(
                "INSERT OR IGNORE INTO resources_admissions (file_id, source, created_at_ms) VALUES (?, ?, ?)",
                (file_id, ADMISSION_SOURCE_MANUAL, now),
            )
            response = {"version_id": version_id, "unchanged": unchanged}
            connection.execute(
                "INSERT INTO resources_operations (idempotency_key, operation_kind, target_id, request_digest, state, result_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    key,
                    OPERATION_KIND_ADMISSION,
                    snapshot.path,
                    digest,
                    OPERATION_STATE_COMMITTED,
                    json.dumps(response),
                    now,
                    now,
                ),
            )
            return response

    def identity(self, path: str) -> tuple[str, str | None, str | None] | None:
        """Return file id, WorkingHead revision and VersionHead id for a path."""
        if not self._database.exists():
            return None
        self.ensure()
        with closing(connect(self._database)) as connection:
            return self.identity_rows(connection, path)

    @staticmethod
    def identity_rows(
        connection: sqlite3.Connection, path: str
    ) -> tuple[str, str | None, str | None] | None:
        row = connection.execute(
            """
            SELECT files.file_id, heads.revision,
                   versions.version_id AS version_id
            FROM resources_files AS files
            LEFT JOIN resources_heads AS heads ON heads.file_id = files.file_id
            LEFT JOIN resources_versions AS versions
              ON versions.file_id = files.file_id
             AND versions.sequence = files.next_sequence - 1
            WHERE files.current_path = ?
            """,
            (path,),
        ).fetchone()
        if row is None:
            return None
        return (
            str(row["file_id"]),
            str(row["revision"]) if row["revision"] is not None else None,
            str(row["version_id"]) if row["version_id"] is not None else None,
        )

    def versioned_files(
        self, state: FileState, *, after_file_id: str = "", limit: int = DEFAULT_PENDING_PAGE_SIZE
    ) -> tuple[VersionedFile, ...]:
        if not self._database.exists():
            return ()
        self.ensure()
        with transaction(self._database) as connection:
            rows = connection.execute(
                VERSIONED_FILES_SELECT + "WHERE heads.file_state = ? AND files.file_id > ? "
                "ORDER BY files.file_id LIMIT ?",
                (state.value, after_file_id, limit),
            ).fetchall()
        return tuple(self._versioned_file(row) for row in rows)

    @staticmethod
    def _versioned_file(row: sqlite3.Row) -> VersionedFile:
        return VersionedFile(
            file_id=row["file_id"],
            path=row["path"],
            state=FileState(row["file_state"]),
            version_id=row["version_id"],
        )

    def pending_files(
        self, *, after_file_id: str = "", limit: int = DEFAULT_PENDING_PAGE_SIZE
    ) -> tuple[PendingFile, ...]:
        """Read a bounded ledger page, including tombstones with no disk entry."""

        if not self._database.exists():
            return ()
        self.ensure()
        with transaction(self._database) as connection:
            rows = connection.execute(
                PENDING_FILES_SELECT + "WHERE pending.file_id > ? ORDER BY pending.file_id LIMIT ?",
                (after_file_id, limit),
            ).fetchall()
            return tuple(self._pending_file(row) for row in rows)

    @staticmethod
    def _pending_file(row: sqlite3.Row) -> PendingFile:
        snapshot = pending.from_row(row)
        if snapshot is None:
            raise VersionStoreConflict("pending_snapshot_missing")
        return PendingFile(row["path"], FileState(row["file_state"]), row["version_id"], snapshot)

    def working_snapshot(self, file_id: str) -> SnapshotIdentity | None:
        """Read the durable working identity without observing or changing disk."""

        if not self._database.exists():
            return None
        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                "SELECT * FROM resources_heads WHERE file_id = ?", (file_id,)
            ).fetchone()
            return _snapshot_identity(row) if row is not None else None
        finally:
            connection.close()

    def pending(self, file_id: str) -> PendingSnapshot | None:
        if not self._database.exists():
            return None
        self.ensure()
        connection = connect(self._database)
        try:
            return pending.read(connection, file_id)
        finally:
            connection.close()

    def legacy_reviews(self) -> tuple[migration.LegacyReview, ...]:
        if not self._database.exists():
            return ()
        self.ensure()
        with transaction(self._database) as connection:
            return migration.inputs(connection)

    def migration_records(self) -> tuple[migration.MigrationRecord, ...]:
        if not self._database.exists():
            return ()
        self.ensure()
        with transaction(self._database) as connection:
            return migration.records(connection)

    def migration_proof(self, item: migration.LegacyReview) -> migration.MigrationProof:
        with transaction(self._database) as connection:
            return migration.prove(connection, item)

    def migration_resolution(
        self, request: migration.MigrationResolution
    ) -> migration.MigrationRecord | None:
        self.ensure()
        with transaction(self._database) as connection:
            return migration.resolved(connection, request)

    def resolve_migration(
        self, request: migration.MigrationResolution, disk: SnapshotIdentity
    ) -> migration.MigrationRecord:
        """Confirm a saved snapshot, never infer or execute an old review decision."""

        with transaction(self._database, immediate=True) as connection:
            previous = migration.resolved(connection, request)
            if previous is not None:
                return previous
            if not migration.available(connection):
                raise migration.MigrationError(migration.MigrationBlocker.SOURCE_CHANGED)
            source = migration.read(connection, request.source_id, request.path)
            record = connection.execute(
                "SELECT source_digest FROM resources_review_migrations WHERE source_id = ? AND path = ?",
                (request.source_id, request.path),
            ).fetchone()
            if (
                source is None
                or source.digest != request.source_digest
                or record["source_digest"] != request.source_digest
            ):
                raise migration.MigrationError(migration.MigrationBlocker.SOURCE_CHANGED)
            if self._initialization_deferred(connection, request.path):
                raise migration.MigrationError(migration.MigrationBlocker.ACTIVE_TURN)
            file = connection.execute(
                "SELECT file_id FROM resources_files WHERE current_path = ?", (request.path,)
            ).fetchone()
            head = connection.execute(
                "SELECT * FROM resources_heads WHERE file_id = ?", (request.file_id,)
            ).fetchone()
            version = connection.execute(
                "SELECT * FROM resources_versions WHERE file_id = ? ORDER BY sequence DESC LIMIT 1",
                (request.file_id,),
            ).fetchone()
            if (
                file is None
                or file["file_id"] != request.file_id
                or head is None
                or version is None
                or version["version_id"] != request.version_id
                or pending.read(connection, request.file_id) is not None
                or _snapshot_identity(head) != _snapshot_identity(version)
            ):
                raise migration.MigrationError(migration.MigrationBlocker.RESOLUTION_NOT_SAVED)
            if _snapshot_identity(head) != disk:
                raise migration.MigrationError(migration.MigrationBlocker.DISK_CONFLICT)
            return migration.resolve(connection, request, _now_ms())

    def migrate_review(
        self,
        item: migration.LegacyReview,
        proof: migration.MigrationProof | None,
        descriptors: tuple[ObjectDescriptor, ...] = (),
        *,
        blocker: str | None = None,
    ) -> None:
        """Publish one cutover and its immutable receipt without a new Version."""

        with transaction(self._database, immediate=True) as connection:
            previous = connection.execute(
                "SELECT status FROM resources_review_migrations WHERE source_id = ? AND path = ?",
                (item.source_id, item.path),
            ).fetchone()
            if (
                previous is not None
                and previous["status"] != migration.MigrationStatus.BLOCKED.value
            ):
                return
            now = _now_ms()
            if blocker is None:
                if proof is None or migration.prove(connection, item) != proof:
                    raise migration.MigrationError(migration.MigrationBlocker.HEAD_CONFLICT)
                for descriptor in descriptors:
                    self._record_object(connection, descriptor, now)
                pending.capture(connection, proof.file_id, proof.review, now)
            migration.receipt(connection, item, proof, blocker, now)

    def snapshot_state(self, file_id: str) -> SnapshotState:
        """Compare both heads in one database read transaction."""

        if not self._database.exists():
            return SnapshotState.PENDING
        self.ensure()
        with transaction(self._database) as connection:
            connection.execute("BEGIN")
            working = connection.execute(
                "SELECT * FROM resources_heads WHERE file_id = ?", (file_id,)
            ).fetchone()
            sealed = connection.execute(
                "SELECT * FROM resources_versions WHERE file_id = ? ORDER BY sequence DESC LIMIT 1",
                (file_id,),
            ).fetchone()
            return (
                SnapshotState.SAVED
                if working is not None
                and sealed is not None
                and same_source_identity(_snapshot_identity(working), _snapshot_identity(sealed))
                else SnapshotState.PENDING
            )

    def capability_states(self, paths: tuple[str, ...]) -> dict[str, CapabilityState]:
        """Read list-safe version state without touching current file bytes."""

        selected = tuple(dict.fromkeys(paths))
        if not selected or not self._database.exists():
            return {}
        self.ensure()
        connection = connect(self._database)
        try:
            rows: list[sqlite3.Row] = []
            for offset in range(0, len(selected), SQLITE_BIND_BATCH_SIZE):
                batch = selected[offset : offset + SQLITE_BIND_BATCH_SIZE]
                placeholders = ",".join("?" for _ in batch)
                rows.extend(
                    connection.execute(
                        CAPABILITY_STATES_SELECT + f" WHERE files.current_path IN ({placeholders})",
                        (EXTERNAL_OBSERVATION_REASON, *batch),
                    ).fetchall()
                )
        finally:
            connection.close()
        return {str(row["current_path"]): self._capability_state(row) for row in rows}

    @staticmethod
    def _capability_state(row: sqlite3.Row) -> CapabilityState:
        return CapabilityState(
            path=str(row["current_path"]),
            file_id=str(row["file_id"]),
            working_revision=(
                str(row["working_revision"]) if row["working_revision"] is not None else None
            ),
            version_id=(str(row["version_id"]) if row["version_id"] is not None else None),
            snapshot_state=(
                SnapshotState.SAVED if row["snapshot_saved"] else SnapshotState.PENDING
            ),
            pending=pending.from_row(row),
            head_state=(str(row["head_state"]) if row["head_state"] is not None else None),
            head_mode_bits=row["head_mode_bits"],
            observed_revision=(
                str(row["observed_revision"]) if row["observed_revision"] is not None else None
            ),
            observed_state=(
                str(row["observed_state"]) if row["observed_state"] is not None else None
            ),
            observed_mode_bits=row["observed_mode_bits"],
        )

    def tracked_paths(self) -> tuple[str, ...]:
        """Return managed identities including tombstones for restored-root observation."""

        if not self._database.exists():
            return ()
        self.ensure()
        connection = connect(self._database)
        try:
            return self.tracked_path_rows(connection)
        finally:
            connection.close()

    @staticmethod
    def tracked_path_rows(connection: sqlite3.Connection) -> tuple[str, ...]:
        rows = connection.execute(
            "SELECT current_path FROM resources_files WHERE management_state = ? ORDER BY file_id",
            (MANAGED,),
        ).fetchall()
        return tuple(str(row["current_path"]) for row in rows)

    def managed_files(self, *, include_deleted: bool = False) -> tuple[TurnBaseline, ...]:
        """Return current managed file identities before authoritative baseline reads."""

        if not self._database.exists():
            return ()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute(MANAGED_FILES_SELECT, (include_deleted,)).fetchall()
        finally:
            connection.close()
        return tuple(self._managed_file(row) for row in rows)

    @staticmethod
    def _managed_file(row: sqlite3.Row) -> TurnBaseline:
        return TurnBaseline(
            file_id=str(row["file_id"]),
            path=str(row["current_path"]),
            revision=str(row["revision"]) if row["revision"] is not None else None,
            object_id=str(row["object_id"]) if row["object_id"] is not None else None,
            mode_bits=int(row["mode_bits"]) if row["mode_bits"] is not None else None,
            version_id=(str(row["version_id"]) if row["version_id"] is not None else None),
            annotation_revision=(
                str(row["annotation_revision"]) if row["annotation_revision"] is not None else None
            ),
            annotation_object_id=(
                str(row["annotation_object_id"])
                if row["annotation_object_id"] is not None
                else None
            ),
            state=FileState(row["state"]),
        )

    def begin_turn(
        self,
        session_id: str,
        turn_id: str,
        baselines: tuple[tuple[TurnBaseline, ObjectDescriptor, ObjectDescriptor | None], ...],
        initial_paths: tuple[str, ...],
        model_context: str = "",
    ) -> None:
        """Persist all pre-write bytes before the runtime turn is admitted."""

        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            existing = connection.execute(
                "SELECT turn_occurrence_id FROM resources_turns WHERE session_id = ? AND turn_id = ?",
                (session_id, turn_id),
            ).fetchone()
            if existing is not None:
                return
            occurrence_id = uuid4().hex
            connection.execute(
                """
                INSERT INTO resources_turns (
                    turn_occurrence_id, session_id, turn_id, runtime_generation,
                    baseline_generation, state, terminal_payload_hash,
                    finalization_digest, started_at_ms, updated_at_ms, initial_paths_json, model_context
                ) VALUES (?, ?, ?, 'admission', 1, 'accepted', NULL, NULL, ?, ?, ?, ?)
                """,
                (
                    occurrence_id,
                    session_id,
                    turn_id,
                    now,
                    now,
                    json.dumps(sorted(set(initial_paths)), ensure_ascii=False),
                    model_context,
                ),
            )
            for sequence, (baseline, descriptor, annotation_descriptor) in enumerate(
                baselines, start=1
            ):
                self._record_object(connection, descriptor, now)
                if annotation_descriptor is not None:
                    self._record_object(connection, annotation_descriptor, now)
                connection.execute(
                    """
                    INSERT INTO resources_turn_changes (
                        turn_occurrence_id, session_id, turn_id, file_id,
                        first_event_seq, baseline_revision, baseline_object_id,
                        baseline_state, baseline_root_id, baseline_path,
                        baseline_mode_bits, baseline_annotation_revision,
                        baseline_annotation_object_id, baseline_version_id, baseline_pending_origin,
                        last_reported_revision, change_hint, status, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'present', NULL, ?, ?, ?, ?, ?, ?, NULL, 'baseline', 'open', ?)
                    """,
                    (
                        occurrence_id,
                        session_id,
                        turn_id,
                        baseline.file_id,
                        sequence,
                        baseline.revision,
                        baseline.object_id,
                        baseline.path,
                        baseline.mode_bits,
                        baseline.annotation_revision,
                        baseline.annotation_object_id,
                        baseline.version_id,
                        baseline.pending_origin.value if baseline.pending_origin else None,
                        now,
                    ),
                )

    def turn_model_context(self, session_id: str, turn_id: str) -> str:
        self.ensure()
        with closing(connect(self._database)) as connection:
            row = connection.execute(
                "SELECT model_context FROM resources_turns WHERE session_id = ? AND turn_id = ?",
                (session_id, turn_id),
            ).fetchone()
        return str(row["model_context"] or "") if row is not None else ""

    def session_review_paths(self, session_id: str) -> tuple[str, ...]:
        """Only this session's open reviews and latest completed capture; no inventory."""

        self.ensure()
        with closing(connect(self._database)) as connection:
            current = connection.execute(
                "SELECT file_id FROM resources_pending WHERE session_id = ? AND review_id IS NOT NULL",
                (session_id,),
            ).fetchall()
            recent = connection.execute(
                """SELECT capture_result_json FROM resources_turns
                   WHERE session_id = ? AND capture_result_json IS NOT NULL
                     AND json_array_length(capture_result_json, '$.file_ids') > 0
                   ORDER BY started_at_ms DESC, turn_occurrence_id DESC LIMIT 1""",
                (session_id,),
            ).fetchone()
            ids = {str(row["file_id"]) for row in current}
            if recent is not None:
                ids.update(json.loads(recent["capture_result_json"])["file_ids"])
            paths = []
            for file_id in sorted(ids):
                row = connection.execute(
                    "SELECT current_path FROM resources_files WHERE file_id = ?", (file_id,)
                ).fetchone()
                if row is not None:
                    paths.append(str(row["current_path"]))
        return tuple(paths)

    def turn_inventory(self, session_id: str, turn_id: str) -> frozenset[str] | None:
        """Return admission existence facts, never reconstruct them from current disk."""

        if not self._database.exists():
            return None
        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                "SELECT initial_paths_json FROM resources_turns WHERE session_id = ? AND turn_id = ?",
                (session_id, turn_id),
            ).fetchone()
        finally:
            connection.close()
        return self._turn_inventory(row)

    @staticmethod
    def _turn_inventory(row: sqlite3.Row | None) -> frozenset[str] | None:
        if row is None or row["initial_paths_json"] is None:
            return None
        try:
            paths = json.loads(row["initial_paths_json"])
        except (TypeError, ValueError) as exc:
            raise VersionStoreConflict("turn_inventory_invalid") from exc
        if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
            raise VersionStoreConflict("turn_inventory_invalid")
        return frozenset(paths)

    def turn_baselines(self, session_id: str, turn_id: str) -> tuple[TurnBaseline, ...]:
        """Load a durable turn baseline, including after process restart."""

        if not self._database.exists():
            return ()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute(
                """
                SELECT changes.* FROM resources_turn_changes AS changes
                JOIN resources_turns AS turns
                  ON turns.turn_occurrence_id = changes.turn_occurrence_id
                WHERE turns.session_id = ? AND turns.turn_id = ?
                ORDER BY changes.first_event_seq
                """,
                (session_id, turn_id),
            ).fetchall()
        finally:
            connection.close()
        return tuple(self._turn_baseline(row) for row in rows)

    @staticmethod
    def _turn_baseline(row: sqlite3.Row) -> TurnBaseline:
        return TurnBaseline(
            file_id=str(row["file_id"]),
            path=str(row["baseline_path"]),
            revision=str(row["baseline_revision"]),
            object_id=str(row["baseline_object_id"]),
            mode_bits=int(row["baseline_mode_bits"]),
            version_id=(
                str(row["baseline_version_id"]) if row["baseline_version_id"] is not None else None
            ),
            pending_origin=(
                PendingOrigin(row["baseline_pending_origin"])
                if row["baseline_pending_origin"]
                else None
            ),
            annotation_revision=(
                str(row["baseline_annotation_revision"])
                if row["baseline_annotation_revision"] is not None
                else None
            ),
            annotation_object_id=(
                str(row["baseline_annotation_object_id"])
                if row["baseline_annotation_object_id"] is not None
                else None
            ),
            state=FileState(str(row["baseline_state"])),
        )

    def record_turn_hint(
        self,
        session_id: str,
        turn_id: str,
        path: str,
        change_kind: str,
    ) -> bool:
        """Persist idempotent Agent-owned candidate evidence for terminal reconcile."""

        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            turn = connection.execute(
                """
                SELECT turn_occurrence_id FROM resources_turns
                WHERE session_id = ? AND turn_id = ?
                  AND state IN ('accepted','running')
                """,
                (session_id, turn_id),
            ).fetchone()
            if turn is None:
                return False
            occurrence_id = str(turn["turn_occurrence_id"])
            next_row = connection.execute(
                """
                SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq
                FROM resources_turn_path_hints WHERE turn_occurrence_id = ?
                """,
                (occurrence_id,),
            ).fetchone()
            sequence = int(next_row["next_seq"])
            connection.execute(
                """
                INSERT INTO resources_turn_path_hints (
                    turn_occurrence_id, path, source, change_kind, event_seq, updated_at_ms
                ) VALUES (?, ?, 'agent', ?, ?, ?)
                ON CONFLICT(turn_occurrence_id, path, source) DO UPDATE SET
                    change_kind = excluded.change_kind,
                    updated_at_ms = excluded.updated_at_ms
                """,
                (occurrence_id, path, change_kind, sequence, now),
            )
            return True

    def record_turn_tool_call(
        self, session_id: str, turn_id: str, input_json: str, *, event_id: str = ""
    ) -> bool:
        """Persist one write-capable ToolCall input for terminal filename attribution."""

        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            turn = connection.execute(
                """
                SELECT turn_occurrence_id FROM resources_turns
                WHERE session_id = ? AND turn_id = ?
                  AND state IN ('accepted','running')
                """,
                (session_id, turn_id),
            ).fetchone()
            if turn is None:
                return False
            occurrence_id = str(turn["turn_occurrence_id"])
            if event_id:
                existing = connection.execute(
                    "SELECT input_json FROM resources_turn_tool_calls "
                    "WHERE turn_occurrence_id = ? AND runtime_event_id = ?",
                    (occurrence_id, event_id),
                ).fetchone()
                if existing is not None:
                    if existing["input_json"] != input_json:
                        raise VersionStoreConflict("runtime_event_conflict")
                    return True
            next_row = connection.execute(
                """
                SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq
                FROM resources_turn_tool_calls WHERE turn_occurrence_id = ?
                """,
                (occurrence_id,),
            ).fetchone()
            connection.execute(
                """
                INSERT INTO resources_turn_tool_calls (
                    turn_occurrence_id, event_seq, input_json, runtime_event_id, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (occurrence_id, int(next_row["next_seq"]), input_json, event_id or None, now),
            )
            return True

    def bind_runtime_turn(
        self, session_id: str, client_turn_id: str, vendor_turn_id: str, generation: str
    ) -> None:
        """Persist a one-to-one runtime/admission binding; reject rebinding."""

        self.ensure()
        with transaction(self._database, immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM resources_turns WHERE session_id = ? AND turn_id = ?",
                (session_id, client_turn_id),
            ).fetchone()
            if row is None:
                raise VersionStoreConflict("turn_not_found")
            if row["vendor_turn_id"] is not None:
                if (
                    row["vendor_turn_id"] == vendor_turn_id
                    and row["runtime_generation"] == generation
                ):
                    return
                raise VersionStoreConflict("turn_binding_conflict")
            if row["state"] != "accepted" or not vendor_turn_id or not generation:
                raise VersionStoreConflict("turn_not_open")
            duplicate = connection.execute(
                "SELECT 1 FROM resources_turns WHERE session_id = ? AND vendor_turn_id = ? AND runtime_generation = ?",
                (session_id, vendor_turn_id, generation),
            ).fetchone()
            if duplicate is not None:
                raise VersionStoreConflict("turn_binding_conflict")
            connection.execute(
                "UPDATE resources_turns SET vendor_turn_id = ?, runtime_generation = ?, state = 'running', updated_at_ms = ? WHERE session_id = ? AND turn_id = ?",
                (vendor_turn_id, generation, _now_ms(), session_id, client_turn_id),
            )

    def runtime_turn(self, session_id: str, vendor_turn_id: str, generation: str) -> str | None:
        """Resolve only an exact durable runtime fence, never the newest admission."""

        if not self._database.exists():
            return None
        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                "SELECT turn_id FROM resources_turns WHERE session_id = ? AND vendor_turn_id = ? AND runtime_generation = ?",
                (session_id, vendor_turn_id, generation),
            ).fetchone()
        finally:
            connection.close()
        return str(row["turn_id"]) if row is not None else None

    def turn_hints(self, session_id: str, turn_id: str) -> frozenset[str]:
        """Load durable Agent path hints for one accepted turn."""

        if not self._database.exists():
            return frozenset()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute(
                """
                SELECT hints.path FROM resources_turn_path_hints AS hints
                JOIN resources_turns AS turns
                  ON turns.turn_occurrence_id = hints.turn_occurrence_id
                WHERE turns.session_id = ? AND turns.turn_id = ? AND hints.source = 'agent'
                """,
                (session_id, turn_id),
            ).fetchall()
        finally:
            connection.close()
        return frozenset(str(row["path"]) for row in rows)

    def turn_tool_calls(self, session_id: str, turn_id: str) -> tuple[str, ...]:
        """Load durable write-capable ToolCall inputs for one accepted turn."""

        if not self._database.exists():
            return ()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute(
                """
                SELECT calls.input_json FROM resources_turn_tool_calls AS calls
                JOIN resources_turns AS turns
                  ON turns.turn_occurrence_id = calls.turn_occurrence_id
                WHERE turns.session_id = ? AND turns.turn_id = ?
                ORDER BY calls.event_seq
                """,
                (session_id, turn_id),
            ).fetchall()
        finally:
            connection.close()
        return tuple(str(row["input_json"]) for row in rows)

    def initialization_deferred(self, path: str) -> bool:
        """Fence auto-v1 during execution and for unsealed, undelivered paths."""

        if not self._database.exists():
            return False
        self.ensure()
        connection = connect(self._database)
        try:
            return self._initialization_deferred(connection, path)
        finally:
            connection.close()

    @staticmethod
    def _initialization_deferred(connection: sqlite3.Connection, path: str) -> bool:
        row = connection.execute(
            """
            SELECT 1 FROM resources_turns
            WHERE state IN ('accepted', 'running', 'finalizing')
              AND terminal_outcome IS NULL
            UNION ALL
            SELECT 1 FROM resources_turn_path_hints AS hints
            JOIN resources_turns AS turns USING (turn_occurrence_id)
            WHERE hints.path = ? AND turns.state IN ('discarded', 'unknown', 'finalizing')
            LIMIT 1
            """,
            (path,),
        ).fetchone()
        return row is not None

    def turn_state(self, session_id: str, turn_id: str) -> str | None:
        if not self._database.exists():
            return None
        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                "SELECT state FROM resources_turns WHERE session_id = ? AND turn_id = ?",
                (session_id, turn_id),
            ).fetchone()
        finally:
            connection.close()
        return str(row["state"]) if row is not None else None

    def discard_turn(self, session_id: str, turn_id: str, state: str = "discarded") -> None:
        """Close a non-successful turn without creating versions or a Delivery."""

        self.ensure()
        with transaction(self._database, immediate=True) as connection:
            connection.execute(
                """
                UPDATE resources_turns SET state = ?, updated_at_ms = ?
                WHERE session_id = ? AND turn_id = ? AND state != 'completed'
                """,
                (state, _now_ms(), session_id, turn_id),
            )
            connection.execute(
                """
                UPDATE resources_turn_changes SET status = 'discarded', updated_at_ms = ?
                WHERE session_id = ? AND turn_id = ?
                """,
                (_now_ms(), session_id, turn_id),
            )

    def receive_terminal(self, session_id: str, turn_id: str, outcome: TurnOutcome) -> bool:
        """Record the immutable terminal fact before any fallible snapshot work."""

        self.ensure()
        with transaction(self._database, immediate=True) as connection:
            row = connection.execute(
                "SELECT terminal_outcome, state FROM resources_turns WHERE session_id = ? AND turn_id = ?",
                (session_id, turn_id),
            ).fetchone()
            if row is None:
                raise VersionStoreConflict("turn_not_found")
            if outcome is TurnOutcome.UNKNOWN:
                return False
            if row["terminal_outcome"] is not None:
                if row["terminal_outcome"] != outcome.value:
                    raise VersionStoreConflict("terminal_outcome_conflict")
                return False
            if row["state"] in ("completed", "discarded"):
                raise VersionStoreConflict("terminal_outcome_conflict")
            state = "finalizing"
            connection.execute(
                """
                UPDATE resources_turns SET terminal_outcome = ?,
                    state = CASE WHEN state = 'completed' THEN state ELSE ? END,
                    updated_at_ms = ?
                WHERE session_id = ? AND turn_id = ?
                """,
                (outcome.value, state, _now_ms(), session_id, turn_id),
            )
            return row["state"] in {"accepted", "running"}

    def record_finalization_error(self, session_id: str, turn_id: str, error: str) -> None:
        """Retain the original archive failure without changing the runtime outcome."""

        self.ensure()
        with transaction(self._database, immediate=True) as connection:
            connection.execute(
                """
                UPDATE resources_turns SET finalization_error = COALESCE(finalization_error, ?),
                    updated_at_ms = ?
                WHERE session_id = ? AND turn_id = ? AND state = 'finalizing'
                """,
                (error, _now_ms(), session_id, turn_id),
            )

    def stage_delivery(
        self, session_id: str, turn_id: str, digest: str, members: tuple[DeliverySnapshot, ...]
    ) -> None:
        """Freeze logical after states and root all referenced objects before publication."""

        drafts = [
            asdict(DeliveryDraft(m.baseline, m.snapshot, m.change_kind, m.attribution))
            for m in members
        ]
        self.ensure()
        with transaction(self._database, immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM resources_turns WHERE session_id = ? AND turn_id = ?",
                (session_id, turn_id),
            ).fetchone()
            if row is None or row["terminal_outcome"] not in (
                TurnOutcome.COMPLETED.value,
                TurnOutcome.FAILED.value,
                TurnOutcome.INTERRUPTED.value,
            ):
                raise VersionStoreConflict("terminal_not_received")
            if row["finalization_manifest_json"] is not None:
                if (
                    json.loads(row["finalization_manifest_json"])["members"] != drafts
                    or row["finalization_digest"] != digest
                ):
                    raise VersionStoreConflict("terminal_idempotency_conflict")
                return
            if row["state"] != "finalizing":
                raise VersionStoreConflict("turn_not_finalizing")
            now = _now_ms()
            for member in members:
                for descriptor in (member.descriptor, member.annotation_descriptor):
                    if descriptor is not None:
                        self._record_object(connection, descriptor, now)
                        connection.execute(
                            "INSERT OR IGNORE INTO resources_turn_objects VALUES (?, ?)",
                            (row["turn_occurrence_id"], descriptor.object_id),
                        )
                if (
                    connection.execute(
                        "SELECT 1 FROM resources_files WHERE file_id = ?",
                        (member.baseline.file_id,),
                    ).fetchone()
                    is None
                ):
                    # Reserve the frozen identity so discovery cannot invent a second one.
                    self._insert_file(connection, member.snapshot, now, member.baseline.file_id)
            manifest = json.dumps(
                {
                    "members": drafts,
                    "heads": {
                        m.baseline.file_id: self._terminal_head(
                            connection, m.baseline.file_id, m.snapshot.path
                        )
                        for m in members
                    },
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            connection.execute(
                """
                UPDATE resources_turns SET finalization_manifest_json = ?, finalization_digest = ?,
                    updated_at_ms = ? WHERE session_id = ? AND turn_id = ?
                """,
                (manifest, digest, now, session_id, turn_id),
            )

    def staged_delivery(self, session_id: str, turn_id: str) -> tuple[DeliveryDraft, ...] | None:
        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                "SELECT finalization_manifest_json FROM resources_turns WHERE session_id = ? AND turn_id = ?",
                (session_id, turn_id),
            ).fetchone()
        finally:
            connection.close()
        return self._staged_delivery(row)

    @staticmethod
    def _staged_delivery(row: sqlite3.Row | None) -> tuple[DeliveryDraft, ...] | None:
        if row is None or row["finalization_manifest_json"] is None:
            return None
        try:
            result = []
            payload = json.loads(row["finalization_manifest_json"])
            if not isinstance(payload["members"], list):
                raise ValueError("members must be a list")
            for member in payload["members"]:
                baseline, snapshot = member["baseline"], member["snapshot"]
                baseline["state"] = FileState(baseline["state"])
                if baseline.get("pending_origin") is not None:
                    baseline["pending_origin"] = PendingOrigin(baseline["pending_origin"])
                snapshot["state"] = FileState(snapshot["state"])
                snapshot["origin"] = VersionOrigin(snapshot["origin"])
                result.append(
                    DeliveryDraft(
                        TurnBaseline(**baseline),
                        SnapshotVersion(**snapshot),
                        member["change_kind"],
                        ChangeAttribution(member["attribution"]),
                    )
                )
            return tuple(result)
        except (ValueError, TypeError, KeyError) as exc:
            raise VersionStoreConflict("terminal_manifest_invalid") from exc

    def unreceived_turns(self) -> tuple[ResourceTurn, ...]:
        """Read unbound admissions or unique durable vendor bindings for reconciliation."""

        if not self._database.exists():
            return ()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute("""
                SELECT t.session_id, t.turn_id, t.vendor_turn_id, t.runtime_generation
                FROM resources_turns t
                WHERE t.terminal_outcome IS NULL AND t.state IN ('accepted', 'running', 'finalizing')
                  AND ((t.vendor_turn_id IS NULL AND t.state = 'accepted') OR
                       (t.vendor_turn_id IS NOT NULL AND
                        (SELECT COUNT(*) FROM resources_turns other
                         WHERE other.session_id = t.session_id AND other.vendor_turn_id = t.vendor_turn_id) = 1))
                """).fetchall()
            return tuple(ResourceTurn(**dict(row)) for row in rows)
        finally:
            connection.close()

    def pending_finalizations(self) -> tuple[tuple[str, str], ...]:
        if not self._database.exists():
            return ()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute(
                "SELECT session_id, turn_id FROM resources_turns WHERE state = 'finalizing' AND terminal_outcome IN (?, ?, ?)",
                (
                    TurnOutcome.COMPLETED.value,
                    TurnOutcome.FAILED.value,
                    TurnOutcome.INTERRUPTED.value,
                ),
            ).fetchall()
        finally:
            connection.close()
        return tuple((str(row["session_id"]), str(row["turn_id"])) for row in rows)

    def finalizations(
        self, session_id: str, *, cursor: str | None, limit: int
    ) -> tuple[ResourceFinalization, ...]:
        """Read bounded pending archives; cursor remains valid after an entry is resolved."""

        if not self._database.exists():
            return ()
        self.ensure()
        connection = connect(self._database)
        try:
            boundary = None
            if cursor is not None:
                boundary = connection.execute(
                    "SELECT started_at_ms, turn_id FROM resources_turns WHERE session_id = ? AND turn_id = ?",
                    (session_id, cursor),
                ).fetchone()
                if boundary is None:
                    raise VersionStoreConflict("invalid_finalization_cursor")
            rows = connection.execute(
                """
                SELECT * FROM resources_turns
                WHERE session_id = ? AND state = 'finalizing' AND terminal_outcome IN (?, ?, ?)
                  AND (? IS NULL OR (started_at_ms, turn_id) < (?, ?))
                ORDER BY started_at_ms DESC, turn_id DESC LIMIT ?
                """,
                (
                    session_id,
                    TurnOutcome.COMPLETED.value,
                    TurnOutcome.FAILED.value,
                    TurnOutcome.INTERRUPTED.value,
                    cursor,
                    boundary["started_at_ms"] if boundary is not None else None,
                    cursor,
                    limit,
                ),
            ).fetchall()
            return tuple(self._finalization(connection, row) for row in rows)
        finally:
            connection.close()

    def finalization(self, session_id: str, turn_id: str) -> ResourceFinalization | None:
        if not self._database.exists():
            return None
        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                "SELECT * FROM resources_turns WHERE session_id = ? AND turn_id = ? AND state = 'finalizing' AND terminal_outcome IN (?, ?, ?)",
                (
                    session_id,
                    turn_id,
                    TurnOutcome.COMPLETED.value,
                    TurnOutcome.FAILED.value,
                    TurnOutcome.INTERRUPTED.value,
                ),
            ).fetchone()
            return self._finalization(connection, row) if row is not None else None
        finally:
            connection.close()

    @classmethod
    def _finalization(
        cls, connection: sqlite3.Connection, row: sqlite3.Row
    ) -> ResourceFinalization:
        paths = connection.execute(
            "SELECT DISTINCT path FROM resources_turn_path_hints WHERE turn_occurrence_id = ? ORDER BY path",
            (row["turn_occurrence_id"],),
        ).fetchall()
        available = row["finalization_manifest_json"] is not None
        retryable = False
        if available:
            try:
                payload = json.loads(row["finalization_manifest_json"])
                retryable = all(
                    payload["heads"][member["baseline"]["file_id"]]
                    == cls._terminal_head(
                        connection, member["baseline"]["file_id"], member["snapshot"]["path"]
                    )
                    and (
                        member["baseline"]["version_id"] is None
                        or connection.execute(
                            "SELECT 1 FROM resources_versions WHERE version_id = ?",
                            (member["baseline"]["version_id"],),
                        ).fetchone()
                        is not None
                    )
                    for member in payload["members"]
                )
            except (ValueError, TypeError, KeyError):
                retryable = False
        return ResourceFinalization(
            session_id=str(row["session_id"]),
            turn_id=str(row["turn_id"]),
            terminal_outcome=TurnOutcome(str(row["terminal_outcome"])),
            error=str(row["finalization_error"]) if row["finalization_error"] is not None else None,
            paths=tuple(str(path["path"]) for path in paths),
            created_at_ms=int(row["started_at_ms"]),
            snapshot_available=available,
            retryable=retryable,
        )

    @staticmethod
    def _terminal_head(connection: sqlite3.Connection, file_id: str, path: str) -> str:
        """Fence both the source identity and any occupant of its frozen target path."""

        rows = connection.execute(
            """
            SELECT files.file_id, files.next_sequence, files.current_path, heads.*,
                   pending.revision AS pending_revision, pending.review_id
            FROM resources_files AS files LEFT JOIN resources_heads AS heads USING (file_id)
            LEFT JOIN resources_pending AS pending USING (file_id)
            WHERE files.file_id = ? OR files.current_path = ? ORDER BY files.file_id
            """,
            (file_id, path),
        ).fetchall()
        return json.dumps([dict(row) for row in rows], sort_keys=True, separators=(",", ":"))

    def finalize_review(
        self,
        project_id: str,
        session_id: str,
        turn_id: str,
        group_id: str | None,
        finalization_digest: str,
        members: tuple[DeliverySnapshot, ...],
    ) -> ReviewCaptureResult:
        """Publish candidate heads and review metadata without creating Versions."""

        existing = self.review_result(session_id, turn_id)
        if existing is not None:
            return existing
        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            turn = connection.execute(
                """
                SELECT state, terminal_outcome, finalization_digest, finalization_manifest_json FROM resources_turns
                WHERE session_id = ? AND turn_id = ?
                """,
                (session_id, turn_id),
            ).fetchone()
            if turn is None:
                raise VersionStoreConflict("turn_not_found")
            recorded_digest = turn["finalization_digest"]
            if recorded_digest is not None and str(recorded_digest) != finalization_digest:
                raise VersionStoreConflict("terminal_idempotency_conflict")
            if turn["finalization_manifest_json"] is None:
                raise VersionStoreConflict("terminal_snapshot_unavailable")
            expected_heads = json.loads(turn["finalization_manifest_json"])["heads"]
            for member in members:
                if expected_heads[member.baseline.file_id] != self._terminal_head(
                    connection, member.baseline.file_id, member.snapshot.path
                ):
                    raise VersionStoreConflict("terminal_head_conflict")
                if (
                    member.baseline.version_id is not None
                    and connection.execute(
                        "SELECT 1 FROM resources_versions WHERE version_id = ?",
                        (member.baseline.version_id,),
                    ).fetchone()
                    is None
                ):
                    raise VersionStoreConflict("terminal_baseline_expired")
            connection.execute(
                """
                UPDATE resources_turns
                SET state = 'finalizing', finalization_digest = ?, updated_at_ms = ?
                WHERE session_id = ? AND turn_id = ?
                """,
                (finalization_digest, now, session_id, turn_id),
            )
            review_file_ids = []
            review_ids = []
            review_paths = []
            for member in members:
                snapshot, baseline = member.snapshot, member.baseline
                file_id = baseline.file_id
                for descriptor in (member.descriptor, member.annotation_descriptor):
                    if descriptor is not None:
                        self._record_object(connection, descriptor, now)
                previous = connection.execute(
                    "SELECT current_path FROM resources_files WHERE file_id = ?", (file_id,)
                ).fetchone()
                if previous["current_path"] != snapshot.path:
                    self._release_discovery_identity(connection, snapshot)
                    self._move_identity(
                        connection, file_id, snapshot.path, VersionOrigin.AGENT.value, now
                    )
                connection.execute(
                    "UPDATE resources_files SET current_path = ?, state = ?, media_type = ?, updated_at_ms = ? WHERE file_id = ?",
                    (snapshot.path, snapshot.state.value, snapshot.media_type, now, file_id),
                )
                self._advance_head(connection, file_id, snapshot, now)
                if member.attribution is not ChangeAttribution.AGENT:
                    pending.sync_working(connection, file_id, PendingOrigin.EXTERNAL, now)
                    continue
                review = PendingReview(
                    id=uuid4().hex,
                    group_id=group_id or turn_id,
                    session_id=session_id,
                    first_turn_id=turn_id,
                    turn_id=turn_id,
                    terminal_outcome=TurnOutcome(turn["terminal_outcome"]),
                    origin=PendingOrigin.AGENT,
                    base=SnapshotIdentity(
                        baseline.object_id,
                        baseline.state,
                        baseline.path,
                        baseline.mode_bits,
                        baseline.annotation_object_id,
                    ),
                    candidate=SnapshotIdentity(
                        snapshot.object_id,
                        snapshot.state,
                        snapshot.path,
                        snapshot.mode_bits,
                        snapshot.annotation_object_id,
                    ),
                    base_revision=baseline.revision,
                    candidate_revision=snapshot.revision,
                    base_origin=baseline.pending_origin,
                    base_version_id=baseline.version_id,
                    edited_by_user=False,
                )
                pending.capture(
                    connection,
                    file_id,
                    review,
                    now,
                )
                captured = pending.read(connection, file_id)
                if captured is None or captured.review is None:
                    raise VersionStoreConflict("review_capture_missing")
                review_file_ids.append(file_id)
                review_ids.append(captured.review.id)
                review_paths.append(snapshot.path)
            batch_id = batch.capture(
                connection,
                session_id,
                turn_id,
                group_id or turn_id,
                tuple(review_ids),
                now,
            )
            result = ReviewCaptureResult(
                tuple(review_file_ids),
                tuple(review_ids),
                batch_id,
                project_id,
                tuple(review_paths),
            )
            connection.execute(
                """
                UPDATE resources_turns
                SET state = 'completed', finalization_manifest_json = NULL,
                    finalization_error = NULL, updated_at_ms = ?, capture_result_json = ?
                WHERE session_id = ? AND turn_id = ?
                """,
                (now, json.dumps(asdict(result), sort_keys=True), session_id, turn_id),
            )
            connection.execute(
                """
                DELETE FROM resources_turn_objects WHERE turn_occurrence_id IN (
                    SELECT turn_occurrence_id FROM resources_turns WHERE session_id = ? AND turn_id = ?
                )
                """,
                (session_id, turn_id),
            )
            connection.execute(
                """
                DELETE FROM resources_turn_changes WHERE session_id = ? AND turn_id = ?
                """,
                (session_id, turn_id),
            )
        return result

    def review_result(self, session_id: str, turn_id: str) -> ReviewCaptureResult | None:
        if not self._database.exists():
            return None
        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                "SELECT capture_result_json FROM resources_turns WHERE session_id = ? AND turn_id = ?",
                (session_id, turn_id),
            ).fetchone()
        finally:
            connection.close()
        return self._review_result(row)

    @staticmethod
    def _review_result(row: sqlite3.Row | None) -> ReviewCaptureResult | None:
        if row is None or row["capture_result_json"] is None:
            return None
        result = json.loads(row["capture_result_json"])
        return ReviewCaptureResult(
            tuple(result["file_ids"]),
            tuple(result["review_ids"]),
            result.get("batch_id"),
            result.get("project_id"),
            tuple(result.get("paths", ())),
        )

    def accept_review_batch(
        self,
        batch_id: str,
        snapshots: tuple[tuple[str, ReviewDecision, SnapshotVersion], ...],
    ) -> tuple[VersionRef, ...]:
        """Seal one all-accept batch and its progress in one SQLite transaction."""

        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            current = batch.read(connection, batch_id)
            if current is None:
                raise VersionStoreConflict("review_batch_not_found")
            indexed = {member.file_id: member for member in current.members}
            requested = {file_id for file_id, _decision, _snapshot in snapshots}
            if not requested or not requested.issubset(indexed):
                raise VersionStoreConflict("review_batch_members_mismatch")
            prepared: list[tuple[str, ReviewDecision, SnapshotVersion]] = []
            for file_id, decision, snapshot in snapshots:
                member = indexed[file_id]
                if member.state is ReviewMemberState.COMPLETED:
                    if member.action is not ReviewAction.ACCEPT:
                        raise VersionStoreConflict("review_batch_decision_conflict")
                    continue
                row = connection.execute(
                    "SELECT file_id FROM resources_pending WHERE review_id = ?",
                    (decision.review_id,),
                ).fetchone()
                if row is None or str(row["file_id"]) != file_id:
                    raise VersionStoreConflict(ReviewConflict.NOT_FOUND.value)
                if (
                    decision.outcome is not ReviewOutcome.ACCEPTED
                    or member.review_id != decision.review_id
                    or member.pending_revision != decision.pending_revision
                    or (
                        member.action not in (None, ReviewAction.ACCEPT)
                        and member.state is not ReviewMemberState.FAILED
                    )
                ):
                    raise VersionStoreConflict("review_batch_member_conflict")
                prepared.append(
                    (
                        file_id,
                        decision,
                        self._review_seal(connection, snapshot, decision),
                    )
                )
            versions: list[VersionRef] = []
            for file_id, _decision, snapshot in prepared:
                result = self._seal_snapshot(connection, snapshot, None, now, force_new=True)
                connection.execute("DELETE FROM resources_pending WHERE file_id = ?", (file_id,))
                pending.sync_working(connection, file_id, PendingOrigin.USER, now)
                connection.execute(
                    """
                    UPDATE resources_review_batch_members
                    SET state = 'completed', action = 'accept', pending_revision = ?, result_version_id = ?,
                        error = NULL, updated_at_ms = ?
                    WHERE batch_id = ? AND file_id = ?
                    """,
                    (_decision.pending_revision, result.version.id, now, batch_id, file_id),
                )
                versions.append(result.version)
            states = connection.execute(
                "SELECT state FROM resources_review_batch_members WHERE batch_id = ?",
                (batch_id,),
            ).fetchall()
            state = (
                ReviewBatchState.COMPLETED.value
                if all(str(row["state"]) == ReviewMemberState.COMPLETED.value for row in states)
                else (
                    ReviewBatchState.FAILED.value
                    if any(str(row["state"]) == ReviewMemberState.FAILED.value for row in states)
                    else ReviewBatchState.OPEN.value
                )
            )
            connection.execute(
                "UPDATE resources_review_batches SET state = ?, updated_at_ms = ? WHERE batch_id = ?",
                (state, now, batch_id),
            )
            return tuple(versions)

    def delivery_result(self, session_id: str, turn_id: str) -> DeliveryResult | None:
        """Return a completed terminal projection, including the no-op case."""

        if not self._database.exists():
            return None
        self.ensure()
        connection = connect(self._database)
        try:
            turn = connection.execute(
                "SELECT state FROM resources_turns WHERE session_id = ? AND turn_id = ?",
                (session_id, turn_id),
            ).fetchone()
            if turn is None or str(turn["state"]) != "completed":
                return None
            delivery = connection.execute(
                "SELECT * FROM resources_deliveries WHERE session_id = ? AND turn_id = ?",
                (session_id, turn_id),
            ).fetchone()
            if delivery is None:
                return DeliveryResult(None)
            rows = connection.execute(
                """
                SELECT members.*, versions.path FROM resources_delivery_members AS members
                JOIN resources_versions AS versions
                  ON versions.version_id = members.after_version_id
                WHERE members.delivery_id = ? ORDER BY members.file_id
                """,
                (delivery["delivery_id"],),
            ).fetchall()
        finally:
            connection.close()
        return self._delivery_result(delivery, rows)

    @staticmethod
    def _delivery_result(delivery: sqlite3.Row, rows: list[sqlite3.Row]) -> DeliveryResult:
        reference = DeliveryRef(
            id=str(delivery["delivery_id"]),
            session_id=str(delivery["session_id"]),
            turn_id=str(delivery["turn_id"]),
            created_at_ms=int(delivery["created_at_ms"]),
        )
        return DeliveryResult(
            delivery=reference,
            members=tuple(
                DeliveryMemberRef(
                    file_id=str(row["file_id"]),
                    path=str(row["path"]),
                    change_kind=str(row["change_kind"]),
                    before_version_id=(
                        str(row["before_version_id"])
                        if row["before_version_id"] is not None
                        else None
                    ),
                    before_object_id=(
                        str(row["before_object_id"])
                        if row["before_object_id"] is not None
                        else None
                    ),
                    after_version_id=str(row["after_version_id"]),
                    attribution=ChangeAttribution(str(row["attribution"])),
                )
                for row in rows
            ),
        )

    def delivery_members(self, delivery_id: str) -> tuple[DeliveryRecoveryMember, ...]:
        """Load exact before/after references required for rollback."""

        if not self._database.exists():
            return ()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute(
                """
                SELECT members.*, versions.path AS after_path,
                       versions.object_id AS after_revision,
                       versions.annotation_object_id AS after_annotation_object_id
                FROM resources_delivery_members AS members
                JOIN resources_versions AS versions
                  ON versions.version_id = members.after_version_id
                WHERE members.delivery_id = ? ORDER BY members.file_id
                """,
                (delivery_id,),
            ).fetchall()
        finally:
            connection.close()
        return tuple(self._delivery_recovery_member(row) for row in rows)

    @staticmethod
    def _delivery_recovery_member(row: sqlite3.Row) -> DeliveryRecoveryMember:
        return DeliveryRecoveryMember(
            baseline=TurnBaseline(
                file_id=str(row["file_id"]),
                path=str(row["before_path"]),
                revision=(
                    str(row["before_object_id"]) if row["before_object_id"] is not None else None
                ),
                object_id=(
                    str(row["before_object_id"]) if row["before_object_id"] is not None else None
                ),
                mode_bits=(
                    int(row["before_mode_bits"]) if row["before_mode_bits"] is not None else None
                ),
                version_id=(
                    str(row["before_version_id"]) if row["before_version_id"] is not None else None
                ),
                annotation_object_id=(
                    str(row["before_annotation_object_id"])
                    if row["before_annotation_object_id"] is not None
                    else None
                ),
                state=FileState(str(row["before_state"])),
            ),
            after_path=str(row["after_path"]),
            after_revision=(
                str(row["after_revision"]) if row["after_revision"] is not None else None
            ),
            after_annotation_object_id=(
                str(row["after_annotation_object_id"])
                if row["after_annotation_object_id"] is not None
                else None
            ),
            after_version_id=str(row["after_version_id"]),
            change_kind=str(row["change_kind"]),
        )

    def deliveries(self, limit: int) -> tuple[DeliveryResult, ...]:
        """Return newest logical Deliveries without exposing persistence rows."""

        if not self._database.exists():
            return ()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute(
                """
                SELECT session_id, turn_id FROM resources_deliveries
                ORDER BY created_at_ms DESC, delivery_id DESC LIMIT ?
                """,
                (limit,),
            ).fetchall()
        finally:
            connection.close()
        results = (
            self.delivery_result(str(row["session_id"]), str(row["turn_id"])) for row in rows
        )
        return tuple(result for result in results if result is not None)

    def delivery(self, delivery_id: str) -> DeliveryResult | None:
        """Load one Delivery and all members by stable identity."""

        if not self._database.exists():
            return None
        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                "SELECT session_id, turn_id FROM resources_deliveries WHERE delivery_id = ?",
                (delivery_id,),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            return None
        return self.delivery_result(str(row["session_id"]), str(row["turn_id"]))

    def head(self, file_id: str) -> tuple[str, str | None, str, str | None, str | None] | None:
        """Return current logical path and accepted disk revision for restore preflight."""

        if not self._database.exists():
            return None
        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                """
                SELECT path, revision, file_state, annotation_revision,
                       annotation_object_id
                FROM resources_heads WHERE file_id = ?
                """,
                (file_id,),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            return None
        return (
            str(row["path"]),
            str(row["revision"]) if row["revision"] is not None else None,
            str(row["file_state"]),
            (str(row["annotation_revision"]) if row["annotation_revision"] is not None else None),
            (str(row["annotation_object_id"]) if row["annotation_object_id"] is not None else None),
        )

    def version(self, version_id: str) -> VersionRef | None:
        """Look up one version inside this project ledger."""

        if not self._database.exists():
            return None
        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                """
                SELECT versions.*, metadata.alias,
                       COALESCE(metadata.revision, 0) AS metadata_revision
                FROM resources_versions AS versions
                LEFT JOIN resources_version_metadata AS metadata USING(version_id)
                WHERE versions.version_id = ?
                """,
                (version_id,),
            ).fetchone()
        finally:
            connection.close()
        return _version(row) if row is not None else None

    def media_type(self, file_id: str) -> str | None:
        """Return the persisted media type for one stable file identity."""

        if not self._database.exists():
            return None
        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                "SELECT media_type FROM resources_files WHERE file_id = ?", (file_id,)
            ).fetchone()
        finally:
            connection.close()
        return str(row["media_type"]) if row is not None else None

    def prepare_restore(
        self,
        kind: RestoreKind,
        source_id: str,
        policy: str,
        preflight_token: str,
        members: tuple[RestoreMember, ...],
        descriptors: tuple[ObjectDescriptor, ...],
        *,
        idempotency_key: str | None = None,
        operation_kind: str | None = None,
        request_digest: str | None = None,
        skipped_file_ids: tuple[str, ...] = (),
        reserved_snapshot: SnapshotVersion | None = None,
        review_decision: ReviewDecision | None = None,
        discard_revision: int | None = None,
        review_resolution: ReviewResolution | None = None,
    ) -> RestoreTransaction:
        """Persist a complete restore manifest before the first target write."""

        self.ensure()
        transaction_id = uuid4().hex
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            if idempotency_key is not None:
                if operation_kind is None or request_digest is None:
                    raise VersionStoreConflict("invalid_idempotency_request")
                existing = self._operation_row(
                    connection,
                    idempotency_key,
                    operation_kind,
                    source_id,
                    request_digest,
                )
                if existing is not None:
                    existing_transaction = existing["transaction_id"]
                    if existing_transaction is None:
                        raise VersionStoreConflict("idempotency_result_unavailable")
                    return self.restore_transaction(str(existing_transaction))
            for descriptor in descriptors:
                self._record_object(connection, descriptor, now)
            if discard_revision is not None:
                if review_decision is not None or len(members) != 1:
                    raise VersionStoreConflict("invalid_restore_reservation")
                self._validate_discard(connection, members[0].file_id, discard_revision, source_id)
            if review_resolution is not None:
                if (
                    len(members) != 1
                    or review_decision is not None
                    or discard_revision is not None
                    or reserved_snapshot is not None
                ):
                    raise VersionStoreConflict("invalid_restore_reservation")
                current = self._validate_resolution(
                    connection, members[0].file_id, review_resolution
                )
                self._validate_resolution_target(current, review_resolution, members[0])
            if review_decision is not None:
                if len(members) != 1 or review_decision.outcome is not ReviewOutcome.REJECTED:
                    raise VersionStoreConflict(ReviewConflict.INVALID_OUTCOME.value)
                self._validate_review(connection, members[0].file_id, review_decision)
            if reserved_snapshot is not None:
                if len(members) != 1:
                    raise VersionStoreConflict("invalid_restore_reservation")
                try:
                    self._insert_file(
                        connection,
                        reserved_snapshot,
                        now,
                        file_id=members[0].file_id,
                    )
                except sqlite3.IntegrityError as exc:
                    raise VersionStoreConflict("save_as_conflict") from exc
            connection.execute(
                """
                INSERT INTO resources_restores (
                    transaction_id, kind, source_id, policy, state,
                    preflight_token, created_at_ms, updated_at_ms, completion, review_id, pending_revision, review_resolution
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    transaction_id,
                    kind.value,
                    source_id,
                    policy,
                    RestoreState.PREPARED.value,
                    preflight_token,
                    now,
                    now,
                    (
                        RestoreCompletion.PENDING_CANCEL.value
                        if review_decision is not None or discard_revision is not None
                        else RestoreCompletion.VERSION.value
                    ),
                    review_decision.review_id if review_decision else None,
                    review_decision.pending_revision if review_decision else discard_revision,
                    (
                        json.dumps(asdict(review_resolution), sort_keys=True)
                        if review_resolution
                        else None
                    ),
                ),
            )
            connection.executemany(
                """
                INSERT INTO resources_restore_members (
                    transaction_id, member_order, file_id, conflict_at_prepare,
                    expected_revision, expected_state, expected_path,
                    expected_annotation_revision, before_object_id,
                    before_annotation_object_id, before_state, before_path, before_mode_bits,
                    target_object_id, target_state, target_path, target_mode_bits,
                    target_annotation_object_id, applied
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                tuple(
                    (
                        transaction_id,
                        member.order,
                        member.file_id,
                        int(member.conflict_at_prepare),
                        member.expected_revision,
                        member.expected_state.value,
                        member.expected_path,
                        member.expected_annotation_revision,
                        member.before_object_id,
                        member.before_annotation_object_id,
                        member.before_state.value,
                        member.before_path,
                        member.before_mode_bits,
                        member.target_object_id,
                        member.target_state.value,
                        member.target_path,
                        member.target_mode_bits,
                        member.target_annotation_object_id,
                    )
                    for member in members
                ),
            )
            if idempotency_key is not None:
                connection.execute(
                    """
                    INSERT INTO resources_operations (
                        idempotency_key, operation_kind, target_id, request_digest,
                        state, transaction_id, result_version_id, result_json,
                        created_at_ms, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
                    """,
                    (
                        idempotency_key,
                        operation_kind,
                        source_id,
                        request_digest,
                        OPERATION_STATE_PREPARED,
                        transaction_id,
                        json.dumps(
                            {"skipped_file_ids": list(skipped_file_ids)},
                            separators=(",", ":"),
                            sort_keys=True,
                        ),
                        now,
                        now,
                    ),
                )
        return self.restore_transaction(transaction_id)

    def restore_operation(
        self,
        idempotency_key: str,
        operation_kind: str,
        source_id: str,
        request_digest: str,
    ) -> RestoreTransaction | None:
        """Resolve an existing restore request without observing current files."""

        self.ensure()
        connection = connect(self._database)
        try:
            row = self._operation_row(
                connection,
                idempotency_key,
                operation_kind,
                source_id,
                request_digest,
            )
        finally:
            connection.close()
        if row is None:
            return None
        transaction_id = row["transaction_id"]
        if transaction_id is None:
            raise VersionStoreConflict("idempotency_result_unavailable")
        return self.restore_transaction(str(transaction_id))

    @staticmethod
    def _operation_row(
        connection: sqlite3.Connection,
        idempotency_key: str,
        operation_kind: str,
        target_id: str,
        request_digest: str,
    ) -> sqlite3.Row | None:
        row = connection.execute(
            "SELECT * FROM resources_operations WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone()
        if row is not None and (
            str(row["operation_kind"]) != operation_kind
            or str(row["target_id"]) != target_id
            or str(row["request_digest"]) != request_digest
        ):
            raise VersionStoreConflict("idempotency_conflict")
        return row

    def restore_outcome(
        self, transaction_id: str
    ) -> tuple[tuple[VersionRef, ...], tuple[str, ...]]:
        """Load the exact committed response associated with one restore manifest."""

        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                """
                SELECT result_json FROM resources_operations
                WHERE transaction_id = ? AND state = ?
                """,
                (transaction_id, OPERATION_STATE_COMMITTED),
            ).fetchone()
            if row is None:
                raise VersionStoreConflict("idempotency_result_unavailable")
            return self._restore_outcome(connection, row)
        finally:
            connection.close()

    @staticmethod
    def _operation_payload(row: sqlite3.Row) -> dict:
        return json.loads(str(row["result_json"]))

    @classmethod
    def _restore_outcome(
        cls, connection: sqlite3.Connection, row: sqlite3.Row
    ) -> tuple[tuple[VersionRef, ...], tuple[str, ...]]:
        result = cls._operation_payload(row)
        version_ids = tuple(str(item) for item in result.get("version_ids", ()))
        versions = tuple(
            _version(version)
            for version_id in version_ids
            for version in (
                connection.execute(
                    "SELECT * FROM resources_versions WHERE version_id = ?", (version_id,)
                ).fetchone(),
            )
            if version is not None
        )
        if len(versions) != len(version_ids):
            raise VersionStoreConflict("idempotency_result_unavailable")
        skipped = tuple(str(item) for item in result.get("skipped_file_ids", ()))
        return versions, skipped

    def operation_result(
        self,
        idempotency_key: str,
        operation_kind: str,
        target_id: str,
        request_digest: str,
    ) -> dict | None:
        """Read one generic committed receipt and reject semantic key reuse."""

        self.ensure()
        connection = connect(self._database)
        try:
            row = self._operation_row(
                connection,
                idempotency_key,
                operation_kind,
                target_id,
                request_digest,
            )
            if row is None:
                return None
            if str(row["state"]) != OPERATION_STATE_COMMITTED:
                raise VersionStoreConflict("idempotency_operation_incomplete")
            return self._operation_payload(row)
        finally:
            connection.close()

    def commit_operation(
        self,
        idempotency_key: str,
        operation_kind: str,
        target_id: str,
        request_digest: str,
        result: dict,
    ) -> dict:
        """Persist a receipt for an operation whose domain result is naturally unique."""

        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            existing = self._operation_row(
                connection,
                idempotency_key,
                operation_kind,
                target_id,
                request_digest,
            )
            if existing is not None:
                if str(existing["state"]) != OPERATION_STATE_COMMITTED:
                    raise VersionStoreConflict("idempotency_operation_incomplete")
                return json.loads(str(existing["result_json"]))
            connection.execute(
                """
                INSERT INTO resources_operations (
                    idempotency_key, operation_kind, target_id, request_digest,
                    state, transaction_id, result_version_id, result_json,
                    created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
                """,
                (
                    idempotency_key,
                    operation_kind,
                    target_id,
                    request_digest,
                    OPERATION_STATE_COMMITTED,
                    json.dumps(result, separators=(",", ":"), sort_keys=True),
                    now,
                    now,
                ),
            )
        return result

    def restore_transaction(self, transaction_id: str) -> RestoreTransaction:
        """Load one durable restore manifest and its member progress."""

        self.ensure()
        connection = connect(self._database)
        try:
            row = connection.execute(
                "SELECT * FROM resources_restores WHERE transaction_id = ?",
                (transaction_id,),
            ).fetchone()
            if row is None:
                raise VersionStoreConflict("restore_transaction_not_found")
            member_rows = connection.execute(
                """
                SELECT * FROM resources_restore_members
                WHERE transaction_id = ? ORDER BY member_order
                """,
                (transaction_id,),
            ).fetchall()
        finally:
            connection.close()
        return self._restore_transaction(row, member_rows)

    @classmethod
    def _restore_transaction(
        cls, row: sqlite3.Row, member_rows: list[sqlite3.Row]
    ) -> RestoreTransaction:
        return RestoreTransaction(
            id=str(row["transaction_id"]),
            kind=RestoreKind(str(row["kind"])),
            source_id=str(row["source_id"]),
            policy=str(row["policy"]),
            state=RestoreState(str(row["state"])),
            preflight_token=str(row["preflight_token"]),
            members=tuple(_restore_member(member) for member in member_rows),
            completion=RestoreCompletion(row["completion"]),
            review_decision=(
                ReviewDecision(
                    row["review_id"], int(row["pending_revision"]), ReviewOutcome.REJECTED
                )
                if row["review_id"] is not None
                else None
            ),
            discard_revision=(
                int(row["pending_revision"])
                if row["review_id"] is None and row["pending_revision"] is not None
                else None
            ),
            review_resolution=cls._read_resolution(row["review_resolution"]),
        )

    @staticmethod
    def _read_resolution(value: str | None) -> ReviewResolution | None:
        if value is None:
            return None
        data = json.loads(value)
        head = data["expected_head"]
        return ReviewResolution(
            data["review_id"],
            data["pending_revision"],
            ReviewResolutionChoice(data["choice"]),
            SnapshotIdentity(
                head["object_id"],
                FileState(head["state"]),
                head["path"],
                head["mode_bits"],
                head["annotation_object_id"],
            ),
            data["expected_revision"],
            data["expected_version_id"],
        )

    @staticmethod
    def _validate_resolution(
        connection: sqlite3.Connection, file_id: str, resolution: ReviewResolution
    ) -> PendingSnapshot:
        if VersionStore._initialization_deferred(connection, resolution.expected_head.path):
            raise VersionStoreConflict(ReviewConflict.ACTIVE_TURN.value)
        current = pending.read(connection, file_id)
        if current is None or current.review is None or current.review.id != resolution.review_id:
            raise VersionStoreConflict(ReviewConflict.NOT_FOUND.value)
        if current.revision != resolution.pending_revision:
            raise VersionStoreConflict(ReviewConflict.PENDING_REVISION.value)
        head = connection.execute(
            "SELECT * FROM resources_heads WHERE file_id = ?", (file_id,)
        ).fetchone()
        if (
            head is None
            or _snapshot_identity(head) != resolution.expected_head
            or head["revision"] != resolution.expected_revision
        ):
            raise VersionStoreConflict(ReviewConflict.CANDIDATE_REVISION.value)
        latest = connection.execute(
            "SELECT version_id FROM resources_versions WHERE file_id = ? ORDER BY sequence DESC LIMIT 1",
            (file_id,),
        ).fetchone()
        if (latest["version_id"] if latest else None) != resolution.expected_version_id:
            raise VersionStoreConflict("version_head_conflict")
        return current

    @staticmethod
    def _validate_resolution_target(
        current: PendingSnapshot, resolution: ReviewResolution, member: RestoreMember
    ) -> None:
        before = SnapshotIdentity(
            member.before_object_id,
            member.before_state,
            member.before_path,
            member.before_mode_bits,
            member.before_annotation_object_id,
        )
        target = SnapshotIdentity(
            member.target_object_id,
            member.target_state,
            member.target_path,
            member.target_mode_bits,
            member.target_annotation_object_id,
        )
        review = current.review
        if review is None:
            raise VersionStoreConflict(ReviewConflict.NOT_FOUND.value)
        expected_target = (
            before if resolution.choice is ReviewResolutionChoice.KEEP_CURRENT else review.candidate
        )
        if (
            before.path != resolution.expected_head.path
            or member.expected_path != before.path
            or target != expected_target
        ):
            raise VersionStoreConflict("invalid_restore_reservation")

    def validate_restore_pending(self, manifest: RestoreTransaction) -> None:
        if manifest.review_resolution is not None:
            with transaction(self._database) as connection:
                current = self._validate_resolution(
                    connection, manifest.members[0].file_id, manifest.review_resolution
                )
                self._validate_resolution_target(
                    current, manifest.review_resolution, manifest.members[0]
                )
            return
        if manifest.review_decision is None and manifest.discard_revision is None:
            return
        with transaction(self._database) as connection:
            if manifest.review_decision is not None:
                self._validate_review(
                    connection, manifest.members[0].file_id, manifest.review_decision
                )
            else:
                discard_revision = manifest.discard_revision
                if discard_revision is None:
                    raise VersionStoreConflict("invalid_restore_reservation")
                self._validate_discard(
                    connection,
                    manifest.members[0].file_id,
                    discard_revision,
                    manifest.source_id,
                )

    @staticmethod
    def _validate_discard(
        connection: sqlite3.Connection, file_id: str, revision: int, version_id: str
    ) -> PendingSnapshot:
        current = pending.read(connection, file_id)
        if current is None or current.revision != revision:
            raise VersionStoreConflict(ReviewConflict.PENDING_REVISION.value)
        if current.needs_review:
            raise VersionStoreConflict(ReviewConflict.DECISION_REQUIRED.value)
        latest = connection.execute(
            "SELECT version_id FROM resources_versions WHERE file_id = ? ORDER BY sequence DESC LIMIT 1",
            (file_id,),
        ).fetchone()
        if latest is None or latest["version_id"] != version_id:
            raise VersionStoreConflict("version_head_conflict")
        return current

    @staticmethod
    def _validate_review(
        connection: sqlite3.Connection, file_id: str, decision: ReviewDecision
    ) -> PendingSnapshot:
        current = pending.read(connection, file_id)
        if current is None or current.review is None or current.review.id != decision.review_id:
            raise VersionStoreConflict(ReviewConflict.NOT_FOUND.value)
        if current.revision != decision.pending_revision:
            raise VersionStoreConflict(ReviewConflict.PENDING_REVISION.value)
        return current

    def pending_restores(self) -> tuple[RestoreTransaction, ...]:
        """Return non-terminal restore manifests in creation order."""

        if not self._database.exists():
            return ()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute("""
                SELECT transaction_id FROM resources_restores
                WHERE state IN ('prepared','applying')
                ORDER BY created_at_ms, transaction_id
                """).fetchall()
        finally:
            connection.close()
        return tuple(self.restore_transaction(str(row["transaction_id"])) for row in rows)

    def set_restore_state(
        self,
        transaction_id: str,
        state: RestoreState,
        *,
        expected: tuple[RestoreState, ...],
    ) -> None:
        """Advance a restore through an explicit compare-and-set transition."""

        placeholders = ",".join("?" for _item in expected)
        with transaction(self._database, immediate=True) as connection:
            cursor = connection.execute(
                f"""
                UPDATE resources_restores SET state = ?, updated_at_ms = ?
                WHERE transaction_id = ? AND state IN ({placeholders})
                """,
                (
                    state.value,
                    _now_ms(),
                    transaction_id,
                    *(item.value for item in expected),
                ),
            )
            if cursor.rowcount != 1:
                raise VersionStoreConflict("invalid_transaction_state")

    def mark_restore_member_applied(self, transaction_id: str, file_id: str) -> None:
        """Durably record progress after one member reaches its target state."""

        with transaction(self._database, immediate=True) as connection:
            cursor = connection.execute(
                """
                UPDATE resources_restore_members SET applied = 1
                WHERE transaction_id = ? AND file_id = ?
                """,
                (transaction_id, file_id),
            )
            if cursor.rowcount != 1:
                raise VersionStoreConflict("restore_member_not_found")

    @staticmethod
    def live_object_ids(connection: sqlite3.Connection) -> frozenset[str]:
        """The same retained references drive GC and read-only CAS admission."""
        return frozenset(str(row["object_id"]) for row in connection.execute("""
                    SELECT object_id FROM resources_versions WHERE object_id IS NOT NULL
                    UNION SELECT annotation_object_id FROM resources_versions
                        WHERE annotation_object_id IS NOT NULL
                    UNION SELECT object_id FROM resources_heads WHERE object_id IS NOT NULL
                    UNION SELECT annotation_object_id FROM resources_heads
                        WHERE annotation_object_id IS NOT NULL
                    UNION SELECT base_object_id FROM resources_pending
                        WHERE base_object_id IS NOT NULL
                    UNION SELECT base_annotation_object_id FROM resources_pending
                        WHERE base_annotation_object_id IS NOT NULL
                    UNION SELECT candidate_object_id FROM resources_pending
                        WHERE candidate_object_id IS NOT NULL
                    UNION SELECT candidate_annotation_object_id FROM resources_pending
                        WHERE candidate_annotation_object_id IS NOT NULL
                    UNION SELECT base_object_id FROM resources_review_batch_members
                        WHERE base_object_id IS NOT NULL
                    UNION SELECT base_annotation_object_id FROM resources_review_batch_members
                        WHERE base_annotation_object_id IS NOT NULL
                    UNION SELECT candidate_object_id FROM resources_review_batch_members
                        WHERE candidate_object_id IS NOT NULL
                    UNION SELECT candidate_annotation_object_id FROM resources_review_batch_members
                        WHERE candidate_annotation_object_id IS NOT NULL
                    UNION SELECT before_object_id FROM resources_delivery_members
                        WHERE before_object_id IS NOT NULL
                    UNION SELECT before_annotation_object_id FROM resources_delivery_members
                        WHERE before_annotation_object_id IS NOT NULL
                    UNION SELECT baseline_object_id FROM resources_turn_changes
                        WHERE baseline_object_id IS NOT NULL
                    UNION SELECT baseline_annotation_object_id FROM resources_turn_changes
                        WHERE baseline_annotation_object_id IS NOT NULL
                    UNION SELECT object_id FROM resources_turn_objects
                    UNION SELECT before_object_id FROM resources_restore_members
                        WHERE before_object_id IS NOT NULL
                    UNION SELECT before_annotation_object_id FROM resources_restore_members
                        WHERE before_annotation_object_id IS NOT NULL
                    UNION SELECT target_object_id FROM resources_restore_members
                        WHERE target_object_id IS NOT NULL
                    UNION SELECT target_annotation_object_id FROM resources_restore_members
                        WHERE target_annotation_object_id IS NOT NULL
                    UNION SELECT target_object_id FROM resources_mutations
                    """))

    @classmethod
    def inspect_cas_references(
        cls, connection: sqlite3.Connection, physical: Mapping[str, ObjectDescriptor]
    ) -> None:
        """Cross-check the actual ledger against already verified immutable bytes.

        The caller owns the project qualification and a private projected SQLite
        snapshot. No repair, GC, object registration or history rewrite occurs.
        Unreferenced trash may be partway through physical collection; retained
        history and READY rows must instead have matching live descriptors.
        """
        live = cls.live_object_ids(connection)
        registered = set()
        for row in connection.execute("SELECT * FROM resources_objects"):
            identifier = row["object_id"]
            registered.add(identifier)
            if identifier not in live and row["state"] != OBJECT_READY:
                continue
            descriptor = physical.get(identifier)
            if descriptor is None or row["state"] != OBJECT_READY:
                raise ValueError("resource ledger references unavailable CAS object")
            expected = (
                descriptor.layout.value,
                (
                    descriptor.codec.value
                    if isinstance(descriptor.codec, WholeCodec)
                    else descriptor.codec
                ),
                descriptor.format_version,
                descriptor.raw_size_bytes,
                descriptor.stored_size_bytes,
                descriptor.descriptor_digest,
            )
            actual = tuple(
                row[key]
                for key in (
                    "layout",
                    "codec",
                    "format_version",
                    "raw_size_bytes",
                    "stored_size_bytes",
                    "descriptor_digest",
                )
            )
            if actual != expected or row["trash_epoch"] is not None:
                raise ValueError("resource ledger CAS descriptor mismatch")
            mappings = tuple(
                tuple(mapping)
                for mapping in connection.execute(
                    "SELECT ordinal,chunk_id,raw_offset,raw_size_bytes FROM resources_object_chunks "
                    "WHERE object_id=? ORDER BY ordinal",
                    (identifier,),
                )
            )
            if mappings != tuple(
                (chunk.ordinal, chunk.chunk_id, chunk.raw_offset, chunk.raw_size_bytes)
                for chunk in descriptor.chunks
            ):
                raise ValueError("resource ledger CAS chunk mapping mismatch")
            for chunk in descriptor.chunks:
                recorded = connection.execute(
                    "SELECT codec,format_version,raw_size_bytes,stored_size_bytes,descriptor_digest,state,trash_epoch "
                    "FROM resources_chunks WHERE chunk_id=?",
                    (chunk.chunk_id,),
                ).fetchone()
                expected_chunk = (
                    WholeCodec.IDENTITY.value,
                    descriptor.format_version,
                    chunk.raw_size_bytes,
                    chunk.raw_size_bytes,
                    chunk.chunk_id,
                    OBJECT_READY,
                    None,
                )
                if recorded is None or tuple(recorded) != expected_chunk:
                    raise ValueError("resource ledger CAS chunk descriptor mismatch")
        if not live <= registered:
            raise ValueError("resource history references an unregistered CAS object")

    def plan_gc(
        self,
        epoch: str,
        physical_objects: frozenset[str],
        physical_chunks: frozenset[str],
        *,
        now_ms: int,
        grace_ms: int,
    ) -> GcPlan:
        """Mark unreachable objects first, then chunks after object grace expires."""

        self.ensure()
        with transaction(self._database, immediate=True) as connection:
            connection.execute(
                """
                DELETE FROM resources_mutations
                WHERE state = 'ledger_committed' AND updated_at_ms < ?
                """,
                (now_ms - MUTATION_AUDIT_RETENTION_MS,),
            )
            # Every object still pointed at by a non-cascading foreign key must stay in
            # this live set, or the DELETE below trips FOREIGN KEY constraint failed.
            # Restore members qualify for their whole lifetime: their object FKs do not
            # cascade and resources_restores rows are never pruned, so a terminal restore
            # (committed/conflicted/aborted) keeps pinning them just like a delivery does.
            live_objects = self.live_object_ids(connection)
            connection.executemany(
                "DELETE FROM resources_gc_candidates WHERE entry_kind = ? AND identifier = ?",
                tuple((CasEntryKind.OBJECT.value, identifier) for identifier in live_objects),
            )
            connection.executemany(
                """
                UPDATE resources_objects SET state = 'READY', trash_epoch = NULL
                WHERE object_id = ?
                """,
                tuple((identifier,) for identifier in live_objects),
            )
            registered_objects = {
                str(row["object_id"])
                for row in connection.execute("SELECT object_id FROM resources_objects")
            }
            object_trash, object_delete = self._plan_gc_kind(
                connection,
                CasEntryKind.OBJECT,
                physical_objects | registered_objects,
                live_objects,
                epoch,
                now_ms,
                grace_ms,
            )
            connection.executemany(
                "UPDATE resources_objects SET state = 'TRASHED', trash_epoch = ? WHERE object_id = ?",
                tuple((entry.trash_epoch, entry.identifier) for entry in object_trash),
            )
            connection.executemany(
                "DELETE FROM resources_objects WHERE object_id = ?",
                tuple((entry.identifier,) for entry in object_delete),
            )

            live_chunks = {str(row["chunk_id"]) for row in connection.execute("""
                    SELECT DISTINCT mapping.chunk_id
                    FROM resources_object_chunks AS mapping
                    JOIN resources_objects AS objects USING (object_id)
                    WHERE objects.state IN ('READY','TRASHED','CORRUPT')
                    """)}
            connection.executemany(
                "DELETE FROM resources_gc_candidates WHERE entry_kind = ? AND identifier = ?",
                tuple((CasEntryKind.CHUNK.value, identifier) for identifier in live_chunks),
            )
            connection.executemany(
                """
                UPDATE resources_chunks SET state = 'READY', trash_epoch = NULL
                WHERE chunk_id = ?
                """,
                tuple((identifier,) for identifier in live_chunks),
            )
            registered_chunks = {
                str(row["chunk_id"])
                for row in connection.execute("SELECT chunk_id FROM resources_chunks")
            }
            chunk_trash, chunk_delete = self._plan_gc_kind(
                connection,
                CasEntryKind.CHUNK,
                physical_chunks | registered_chunks,
                live_chunks,
                epoch,
                now_ms,
                grace_ms,
            )
            connection.executemany(
                "UPDATE resources_chunks SET state = 'TRASHED', trash_epoch = ? WHERE chunk_id = ?",
                tuple((entry.trash_epoch, entry.identifier) for entry in chunk_trash),
            )
            connection.executemany(
                "DELETE FROM resources_chunks WHERE chunk_id = ?",
                tuple((entry.identifier,) for entry in chunk_delete),
            )
        return GcPlan(
            trash=tuple((*object_trash, *chunk_trash)),
            delete=tuple((*object_delete, *chunk_delete)),
        )

    @staticmethod
    def _plan_gc_kind(
        connection: sqlite3.Connection,
        kind: CasEntryKind,
        known: frozenset[str],
        live: set[str] | frozenset[str],
        epoch: str,
        now_ms: int,
        grace_ms: int,
    ) -> tuple[tuple[GcEntry, ...], tuple[GcEntry, ...]]:
        rows = {
            str(row["identifier"]): row
            for row in connection.execute(
                """
                SELECT identifier, trash_epoch, marked_at_ms
                FROM resources_gc_candidates WHERE entry_kind = ?
                """,
                (kind.value,),
            )
        }
        trash: list[GcEntry] = []
        delete: list[GcEntry] = []
        for identifier in sorted((known | frozenset(rows)) - live):
            candidate = rows.get(identifier)
            if candidate is None:
                entry = GcEntry(kind, identifier, epoch)
                trash.append(entry)
                connection.execute(
                    """
                    INSERT INTO resources_gc_candidates (
                        entry_kind, identifier, state, trash_epoch,
                        marked_at_ms, updated_at_ms
                    ) VALUES (?, ?, 'trashed', ?, ?, ?)
                    """,
                    (kind.value, identifier, epoch, now_ms, now_ms),
                )
                continue
            if now_ms - int(candidate["marked_at_ms"]) < grace_ms:
                continue
            entry = GcEntry(kind, identifier, str(candidate["trash_epoch"]))
            delete.append(entry)
            connection.execute(
                "DELETE FROM resources_gc_candidates WHERE entry_kind = ? AND identifier = ?",
                (kind.value, identifier),
            )
        return tuple(trash), tuple(delete)

    def retention_plan(
        self, limit: int
    ) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
        """Return exact old versions, their files, and referencing Deliveries."""

        if not self._database.exists():
            return (), (), ()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute(
                """
                SELECT version_id, file_id FROM (
                    SELECT version_id, file_id, review_backup,
                           ROW_NUMBER() OVER (
                               PARTITION BY file_id ORDER BY sequence DESC
                           ) AS position
                    FROM resources_versions
                ) WHERE position > ? AND review_backup = 0 AND version_id NOT IN (
                    SELECT base_version_id FROM resources_pending WHERE base_version_id IS NOT NULL
                ) ORDER BY version_id
                """,
                (limit,),
            ).fetchall()
            protected_versions, _ = migration.protected_history(connection)
            rows = [row for row in rows if row["version_id"] not in protected_versions]
            version_ids = tuple(str(row["version_id"]) for row in rows)
            file_ids = tuple(sorted({str(row["file_id"]) for row in rows}))
            deliveries: list[sqlite3.Row]
            if version_ids:
                placeholders = ",".join("?" for _item in version_ids)
                deliveries = connection.execute(
                    f"""
                    SELECT DISTINCT delivery_id FROM resources_delivery_members
                    WHERE before_version_id IN ({placeholders})
                       OR after_version_id IN ({placeholders})
                    ORDER BY delivery_id
                    """,
                    (*version_ids, *version_ids),
                ).fetchall()
            else:
                deliveries = []
        finally:
            connection.close()
        return version_ids, file_ids, tuple(str(row["delivery_id"]) for row in deliveries)

    @staticmethod
    def _delete_exact(
        connection: sqlite3.Connection,
        version_ids: tuple[str, ...],
        delivery_ids: tuple[str, ...],
    ) -> None:
        """Remove an already validated exact set while preserving ledger integrity."""

        placeholders = ",".join("?" for _item in version_ids)
        if delivery_ids:
            delivery_placeholders = ",".join("?" for _item in delivery_ids)
            delivery_rows = connection.execute(
                f"""
                SELECT delivery_id, session_id, turn_id FROM resources_deliveries
                WHERE delivery_id IN ({delivery_placeholders})
                """,
                delivery_ids,
            ).fetchall()
            terminal_keys = tuple(
                (str(row["session_id"]), str(row["turn_id"])) for row in delivery_rows
            )
            connection.executemany(
                """
                UPDATE resources_turn_changes
                SET baseline_object_id = NULL,
                    baseline_annotation_object_id = NULL,
                    baseline_version_id = NULL
                WHERE turn_occurrence_id IN (
                    SELECT turn_occurrence_id FROM resources_turns
                    WHERE session_id = ? AND turn_id = ?
                )
                """,
                terminal_keys,
            )
            connection.executemany(
                """
                DELETE FROM resources_turn_objects
                WHERE turn_occurrence_id IN (
                    SELECT turn_occurrence_id FROM resources_turns
                    WHERE session_id = ? AND turn_id = ?
                )
                """,
                terminal_keys,
            )
            connection.execute(
                f"UPDATE resources_versions SET delivery_id = NULL "
                f"WHERE delivery_id IN ({delivery_placeholders})",
                delivery_ids,
            )
            connection.execute(
                f"UPDATE resources_versions SET source_delivery_id = NULL "
                f"WHERE source_delivery_id IN ({delivery_placeholders})",
                delivery_ids,
            )
            connection.execute(
                f"DELETE FROM resources_deliveries WHERE delivery_id IN ({delivery_placeholders})",
                delivery_ids,
            )
        connection.execute(
            f"UPDATE resources_versions SET parent_version_id = NULL "
            f"WHERE parent_version_id IN ({placeholders})",
            version_ids,
        )
        connection.execute(
            f"UPDATE resources_versions SET restored_from_id = NULL "
            f"WHERE restored_from_id IN ({placeholders})",
            version_ids,
        )
        connection.execute(
            f"UPDATE resources_turn_changes SET baseline_version_id = NULL "
            f"WHERE baseline_version_id IN ({placeholders})",
            version_ids,
        )
        connection.execute(
            f"UPDATE resources_review_batch_members SET result_version_id = NULL "
            f"WHERE result_version_id IN ({placeholders})",
            version_ids,
        )
        connection.execute("""
            UPDATE resources_review_batch_members
            SET base_object_id = NULL, base_annotation_object_id = NULL,
                candidate_object_id = NULL, candidate_annotation_object_id = NULL
            WHERE batch_id IN (
                SELECT batch_id FROM resources_review_batches WHERE state = 'completed'
            )
            """)
        connection.execute(
            f"DELETE FROM resources_versions WHERE version_id IN ({placeholders})",
            version_ids,
        )

    def apply_retention(self, version_ids: tuple[str, ...], delivery_ids: tuple[str, ...]) -> int:
        """Delete an exact preflight set after clearing nullable historical links."""

        if not version_ids or not self._database.exists():
            return 0
        placeholders = ",".join("?" for _item in version_ids)
        with transaction(self._database, immediate=True) as connection:
            current = {
                str(row["version_id"])
                for row in connection.execute(
                    f"SELECT version_id FROM resources_versions WHERE version_id IN ({placeholders})",
                    version_ids,
                )
            }
            if current != set(version_ids):
                raise VersionStoreConflict("retention_preview_stale")
            pinned = connection.execute(
                f"SELECT 1 FROM resources_pending WHERE base_version_id IN ({placeholders}) LIMIT 1",
                version_ids,
            ).fetchone()
            if pinned is not None:
                raise VersionStoreConflict("retention_preview_stale")
            protected_versions, protected_deliveries = migration.protected_history(connection)
            if protected_versions.intersection(version_ids) or protected_deliveries.intersection(
                delivery_ids
            ):
                raise VersionStoreConflict("retention_preview_stale")
            if delivery_ids:
                delivery_placeholders = ",".join("?" for _item in delivery_ids)
                delivery_rows = connection.execute(
                    f"""
                    SELECT delivery_id, session_id, turn_id FROM resources_deliveries
                    WHERE delivery_id IN ({delivery_placeholders})
                    """,
                    delivery_ids,
                ).fetchall()
                current_deliveries = {str(row["delivery_id"]) for row in delivery_rows}
                if current_deliveries != set(delivery_ids):
                    raise VersionStoreConflict("retention_preview_stale")
            self._delete_exact(connection, version_ids, delivery_ids)
        return len(version_ids)

    def initial_version_state(self, path: str) -> InitialVersionState:
        self.ensure()
        with closing(connect(self._database)) as connection:
            connection.execute("BEGIN")
            return self.initial_version_state_rows(connection, path)

    @classmethod
    def initial_version_state_rows(
        cls, connection: sqlite3.Connection, path: str
    ) -> InitialVersionState:
        latest = connection.execute(
            "SELECT versions.* FROM resources_versions versions JOIN resources_files files USING(file_id) "
            "WHERE files.current_path = ? ORDER BY versions.sequence DESC LIMIT 1",
            (path,),
        ).fetchone()
        if latest is not None:
            version = _version(latest)
            return InitialVersionState(version.file_id, version, False, False)
        row = connection.execute(
            "SELECT file_id FROM resources_files WHERE current_path = ?", (path,)
        ).fetchone()
        file_id = str(row["file_id"]) if row is not None else None
        if file_id is not None and pending.read(connection, file_id) is not None:
            return InitialVersionState(file_id, None, False, False)
        deferred = cls._initialization_deferred(connection, path)
        return InitialVersionState(file_id, None, not (deferred and file_id is not None), deferred)

    def initialize_first(
        self,
        snapshot: SnapshotVersion,
        descriptor: ObjectDescriptor,
        *,
        plan: InitialVersionPlan | None = None,
    ) -> SealResult | None:
        """Create automatic v1, or retain the actual pending/execution fence."""
        self.ensure()
        selected = plan if plan is not None else InitialVersionPlan.fresh(_now_ms())
        with transaction(self._database, immediate=True) as connection:
            return self.initialize_first_rows(connection, snapshot, descriptor, plan=selected)

    @classmethod
    def initialize_first_rows(
        cls,
        connection: sqlite3.Connection,
        snapshot: SnapshotVersion,
        descriptor: ObjectDescriptor,
        *,
        plan: InitialVersionPlan,
    ) -> SealResult | None:
        """Run normal automatic initialization on qualified bytes or a private copy."""
        if not connection.in_transaction:
            raise ValueError("initial version requires a transaction")
        plan.validate()
        if (
            snapshot.origin is not VersionOrigin.INITIAL_SCAN
            or snapshot.state is not FileState.PRESENT
            or snapshot.object_id != snapshot.revision
            or descriptor.object_id != snapshot.object_id
        ):
            raise VersionStoreConflict("invalid_initial_version_snapshot")
        state = cls.initial_version_state_rows(connection, snapshot.path)
        if state.version is not None:
            return SealResult(state.version, unchanged=True)
        if not state.required:
            return None
        if state.deferred:
            cls.accept_working_rows(
                connection,
                None,
                replace(snapshot, origin=VersionOrigin.USER),
                descriptor,
                None,
                PendingOrigin.EXTERNAL.value,
                now=plan.now_ms,
                new_file_id=plan.file_id,
                new_path_id=plan.path_id,
            )
            return None
        result = cls._seal_snapshot(connection, snapshot, descriptor, plan.now_ms, identities=plan)
        pending.sync_working(connection, result.version.file_id, PendingOrigin.USER, plan.now_ms)
        return result

    def seal(
        self,
        snapshot: SnapshotVersion,
        descriptor: ObjectDescriptor | None,
        annotation_descriptor: ObjectDescriptor | None = None,
        *,
        expected_version_id: str | None = None,
        force_new: bool = False,
        idempotency_key: str | None = None,
        operation_target: str | None = None,
        request_digest: str | None = None,
        review_decision: ReviewDecision | None = None,
        expected_pending_revision: int | None = None,
    ) -> SealResult:
        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            if idempotency_key is not None:
                if operation_target is None or request_digest is None:
                    raise VersionStoreConflict("invalid_idempotency_request")
                existing = self._seal_receipt(
                    connection, idempotency_key, operation_target, request_digest
                )
                if existing is not None:
                    return existing
            unresolved = connection.execute(
                """
                SELECT 1 FROM resources_pending AS pending
                JOIN resources_files AS file USING (file_id)
                WHERE file.current_path = ? AND pending.review_id IS NOT NULL
                """,
                (snapshot.path,),
            ).fetchone()
            if unresolved is not None and review_decision is None:
                raise VersionStoreConflict(ReviewConflict.DECISION_REQUIRED.value)
            if review_decision is not None:
                if idempotency_key is None:
                    raise VersionStoreConflict("invalid_idempotency_request")
                snapshot = self._review_seal(connection, snapshot, review_decision)
                force_new = True
            elif operation_target is not None:
                self._validate_seal_snapshot(
                    connection,
                    snapshot,
                    operation_target,
                    expected_version_id,
                    expected_pending_revision,
                )
            result = self._seal_snapshot(
                connection,
                snapshot,
                descriptor,
                now,
                annotation_descriptor=annotation_descriptor,
                expected_version_id=expected_version_id,
                force_new=force_new,
            )
            if review_decision is not None:
                connection.execute(
                    "DELETE FROM resources_pending WHERE file_id = ?",
                    (result.version.file_id,),
                )
                connection.execute(
                    """
                    UPDATE resources_review_batch_members
                    SET state = 'completed', action = ?, result_version_id = ?,
                        error = NULL, updated_at_ms = ?
                    WHERE review_id = ?
                    """,
                    (
                        (
                            ReviewAction.ACCEPT.value
                            if review_decision.outcome is ReviewOutcome.ACCEPTED
                            else ReviewAction.REVISE.value
                        ),
                        result.version.id,
                        now,
                        review_decision.review_id,
                    ),
                )
                connection.execute(
                    """
                    UPDATE resources_review_batches
                    SET state = 'completed', updated_at_ms = ?
                    WHERE batch_id IN (
                        SELECT batch_id FROM resources_review_batch_members
                        WHERE review_id = ?
                    ) AND NOT EXISTS (
                        SELECT 1 FROM resources_review_batch_members AS member
                        WHERE member.batch_id = resources_review_batches.batch_id
                          AND member.state != 'completed'
                    )
                    """,
                    (now, review_decision.review_id),
                )
            pending.sync_working(connection, result.version.file_id, PendingOrigin.USER, now)
            if idempotency_key is not None:
                connection.execute(
                    """
                    INSERT INTO resources_operations (
                        idempotency_key, operation_kind, target_id, request_digest,
                        state, transaction_id, result_version_id, result_json,
                        created_at_ms, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
                    """,
                    (
                        idempotency_key,
                        OPERATION_KIND_SEAL,
                        operation_target,
                        request_digest,
                        OPERATION_STATE_COMMITTED,
                        result.version.id,
                        json.dumps(
                            {
                                "unchanged": result.unchanged,
                            },
                            separators=(",", ":"),
                            sort_keys=True,
                        ),
                        now,
                        now,
                    ),
                )
        return result

    def backup_review_current(
        self,
        file_id: str,
        review_id: str,
        expected_pending_revision: int,
        snapshot: SnapshotVersion,
        descriptor: ObjectDescriptor | None,
    ) -> VersionRef:
        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            existing = connection.execute(
                """
                SELECT * FROM resources_versions
                WHERE file_id = ? AND source_review_id = ? AND review_backup = 1
                  AND object_id IS ? AND file_state = ? AND path = ? AND mode_bits IS ?
                ORDER BY sequence DESC LIMIT 1
                """,
                (
                    file_id,
                    review_id,
                    snapshot.object_id,
                    snapshot.state.value,
                    snapshot.path,
                    snapshot.mode_bits,
                ),
            ).fetchone()
            if existing is not None:
                return _version(existing)
            current = pending.read(connection, file_id)
            if current is None or current.review is None or current.review.id != review_id:
                raise VersionStoreConflict(ReviewConflict.NOT_FOUND.value)
            if current.revision != expected_pending_revision:
                raise VersionStoreConflict(ReviewConflict.PENDING_REVISION.value)
            return self._seal_snapshot(
                connection,
                snapshot,
                descriptor,
                now,
                file_id=file_id,
                force_new=True,
                review_backup=True,
            ).version

    def review_backup(self, file_id: str, review_id: str, object_id: str) -> VersionRef | None:
        self.ensure()
        with closing(connect(self._database)) as connection:
            row = connection.execute(
                """
                SELECT * FROM resources_versions
                WHERE file_id = ? AND source_review_id = ? AND review_backup = 1
                  AND object_id = ?
                ORDER BY sequence DESC LIMIT 1
                """,
                (file_id, review_id, object_id),
            ).fetchone()
            return _version(row) if row is not None else None

    @staticmethod
    def _validate_seal_snapshot(
        connection: sqlite3.Connection,
        snapshot: SnapshotVersion,
        file_id: str,
        expected_version_id: str | None,
        expected_pending_revision: int | None,
    ) -> None:
        head = connection.execute(
            "SELECT heads.*, versions.version_id FROM resources_heads heads "
            "JOIN resources_files files USING(file_id) LEFT JOIN resources_versions versions "
            "ON versions.file_id = files.file_id AND versions.sequence = files.next_sequence - 1 "
            "WHERE heads.file_id = ?",
            (file_id,),
        ).fetchone()
        if head is None or head["path"] != snapshot.path:
            raise VersionStoreConflict("file_not_managed")
        current = pending.read(connection, file_id)
        if (current.revision if current else None) != expected_pending_revision:
            raise VersionStoreConflict(ReviewConflict.PENDING_REVISION.value)
        if head["version_id"] != expected_version_id:
            raise VersionStoreConflict("version_head_conflict")
        identity = SnapshotIdentity(
            snapshot.object_id,
            snapshot.state,
            snapshot.path,
            snapshot.mode_bits,
            snapshot.annotation_object_id,
        )
        if head["revision"] != snapshot.revision or _snapshot_identity(head) != identity:
            raise VersionStoreConflict("revision_conflict")

    @staticmethod
    def _review_seal(
        connection: sqlite3.Connection, snapshot: SnapshotVersion, decision: ReviewDecision
    ) -> SnapshotVersion:
        if decision.outcome not in (ReviewOutcome.ACCEPTED, ReviewOutcome.REVISED):
            raise VersionStoreConflict(ReviewConflict.INVALID_OUTCOME.value)
        head = connection.execute(
            "SELECT * FROM resources_heads WHERE path = ?", (snapshot.path,)
        ).fetchone()
        state = pending.read(connection, str(head["file_id"])) if head else None
        if state is None or state.review is None or state.review.id != decision.review_id:
            raise VersionStoreConflict(ReviewConflict.NOT_FOUND.value)
        if state.revision != decision.pending_revision:
            raise VersionStoreConflict(ReviewConflict.PENDING_REVISION.value)
        identity = SnapshotIdentity(
            snapshot.object_id,
            snapshot.state,
            snapshot.path,
            snapshot.mode_bits,
            snapshot.annotation_object_id,
        )
        if head["revision"] != snapshot.revision or _snapshot_identity(head) != identity:
            raise VersionStoreConflict(ReviewConflict.CANDIDATE_REVISION.value)
        if decision.outcome is ReviewOutcome.ACCEPTED and (
            state.review.edited_by_user
            or state.review.candidate != identity
            or state.review.candidate_revision != snapshot.revision
        ):
            raise VersionStoreConflict(ReviewConflict.CANDIDATE_REVISION.value)
        if decision.outcome is ReviewOutcome.REVISED and not state.review.edited_by_user:
            raise VersionStoreConflict(ReviewConflict.CANDIDATE_REVISION.value)
        return replace(
            snapshot,
            origin=(
                VersionOrigin.AGENT
                if decision.outcome is ReviewOutcome.ACCEPTED
                else VersionOrigin.USER
            ),
            session_id=state.review.session_id,
            turn_id=state.review.turn_id,
            source_review_id=state.review.id,
            review_outcome=decision.outcome,
        )

    def seal_receipt(
        self,
        idempotency_key: str,
        operation_target: str,
        request_digest: str,
    ) -> SealResult | None:
        """Return a committed response before a replay touches the current disk."""

        self.ensure()
        connection = connect(self._database)
        try:
            return self._seal_receipt(connection, idempotency_key, operation_target, request_digest)
        finally:
            connection.close()

    @staticmethod
    def _seal_receipt(
        connection: sqlite3.Connection,
        idempotency_key: str,
        operation_target: str,
        request_digest: str,
    ) -> SealResult | None:
        existing = connection.execute(
            "SELECT * FROM resources_operations WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone()
        if existing is None:
            return None
        if (
            str(existing["operation_kind"]) != OPERATION_KIND_SEAL
            or str(existing["target_id"]) != operation_target
            or str(existing["request_digest"]) != request_digest
        ):
            raise VersionStoreConflict("idempotency_conflict")
        result = json.loads(str(existing["result_json"]))
        version = connection.execute(
            "SELECT * FROM resources_versions WHERE version_id = ?",
            (str(existing["result_version_id"]),),
        ).fetchone()
        if version is None:
            raise VersionStoreConflict("idempotency_result_unavailable")
        return SealResult(version=_version(version), unchanged=bool(result["unchanged"]))

    def commit_restore(
        self,
        transaction_id: str,
        snapshots: tuple[
            tuple[
                SnapshotVersion,
                ObjectDescriptor | None,
                ObjectDescriptor | None,
            ],
            ...,
        ],
    ) -> tuple[VersionRef, ...]:
        """Commit restored heads and their explicit version/cancel completion atomically."""

        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            state = connection.execute(
                "SELECT state FROM resources_restores WHERE transaction_id = ?",
                (transaction_id,),
            ).fetchone()
            if state is None or str(state["state"]) != RestoreState.APPLYING.value:
                raise VersionStoreConflict("invalid_transaction_state")
            manifest = connection.execute(
                "SELECT * FROM resources_restores WHERE transaction_id = ?", (transaction_id,)
            ).fetchone()
            members = connection.execute(
                "SELECT * FROM resources_restore_members WHERE transaction_id = ? ORDER BY member_order",
                (transaction_id,),
            ).fetchall()
            results_list: list[VersionRef] = []
            for (snapshot, descriptor, annotation_descriptor), member in zip(
                snapshots, members, strict=True
            ):
                file_id = str(member["file_id"])
                resolution = self._read_resolution(manifest["review_resolution"])
                if resolution is not None:
                    current = self._validate_resolution(connection, file_id, resolution)
                    self._validate_resolution_target(current, resolution, _restore_member(member))
                    target = SnapshotIdentity(
                        snapshot.object_id,
                        snapshot.state,
                        snapshot.path,
                        snapshot.mode_bits,
                        snapshot.annotation_object_id,
                    )
                    expected_target = SnapshotIdentity(
                        member["target_object_id"],
                        FileState(member["target_state"]),
                        member["target_path"],
                        member["target_mode_bits"],
                        member["target_annotation_object_id"],
                    )
                    if (
                        target != expected_target
                        or snapshot.revision != target.object_id
                        or snapshot.annotation_revision != target.annotation_object_id
                    ):
                        raise VersionStoreConflict("preflight_stale")
                    review = current.review
                    if review is None:
                        raise VersionStoreConflict(ReviewConflict.NOT_FOUND.value)
                    if resolution.choice is ReviewResolutionChoice.RESTORE_CANDIDATE and (
                        member["before_object_id"] != member["target_object_id"]
                        or member["before_state"] != member["target_state"]
                        or member["before_path"] != member["target_path"]
                        or member["before_mode_bits"] != member["target_mode_bits"]
                    ):
                        self._seal_review_backup(connection, file_id, review.id, member, now)
                    if (
                        resolution.choice is ReviewResolutionChoice.RESTORE_CANDIDATE
                        and target != review.candidate
                    ):
                        raise VersionStoreConflict(ReviewConflict.CANDIDATE_REVISION.value)
                    if descriptor is not None:
                        self._record_object(connection, descriptor, now)
                    if annotation_descriptor is not None:
                        self._record_object(connection, annotation_descriptor, now)
                    if target.path != resolution.expected_head.path:
                        self._release_discovery_identity(connection, snapshot)
                        self._move_identity(
                            connection, file_id, target.path, PendingOrigin.RESTORE.value, now
                        )
                    self._advance_head(connection, file_id, snapshot, now)
                    connection.execute(
                        "UPDATE resources_files SET state = ?, updated_at_ms = ?, media_type = CASE WHEN ? = 'present' THEN ? ELSE media_type END WHERE file_id = ?",
                        (
                            snapshot.state.value,
                            now,
                            snapshot.state.value,
                            snapshot.media_type,
                            file_id,
                        ),
                    )
                    connection.execute(
                        "UPDATE resources_pending SET revision = revision + 1, edited_by_user = ?, updated_at_ms = ? WHERE file_id = ?",
                        (resolution.choice is ReviewResolutionChoice.KEEP_CURRENT, now, file_id),
                    )
                elif manifest["completion"] == RestoreCompletion.PENDING_CANCEL.value:
                    if manifest["review_id"] is not None:
                        decision = ReviewDecision(
                            manifest["review_id"],
                            int(manifest["pending_revision"]),
                            ReviewOutcome.REJECTED,
                        )
                        current = self._validate_review(connection, file_id, decision)
                        review = current.review
                        candidate = review.candidate if review is not None else None
                        before = SnapshotIdentity(
                            member["before_object_id"],
                            FileState(member["before_state"]),
                            str(member["before_path"]),
                            member["before_mode_bits"],
                            member["before_annotation_object_id"],
                        )
                        if review is not None and candidate is not None and before != candidate:
                            self._seal_review_backup(connection, file_id, review.id, member, now)
                    else:
                        current = self._validate_discard(
                            connection,
                            file_id,
                            int(manifest["pending_revision"]),
                            manifest["source_id"],
                        )
                    latest = connection.execute(
                        "SELECT * FROM resources_versions WHERE file_id = ? ORDER BY sequence DESC LIMIT 1",
                        (file_id,),
                    ).fetchone()
                    restored = SnapshotIdentity(
                        snapshot.object_id,
                        snapshot.state,
                        snapshot.path,
                        snapshot.mode_bits,
                        snapshot.annotation_object_id,
                    )
                    seal_restored_base = manifest["review_id"] is not None and (
                        latest is None or _snapshot_identity(latest) != restored
                    )
                    self._cancel_pending(connection, file_id, snapshot, current, now)
                    if seal_restored_base and current.review is not None:
                        self._seal_snapshot(
                            connection,
                            replace(snapshot, source_review_id=current.review.id),
                            descriptor,
                            now,
                            annotation_descriptor=annotation_descriptor,
                            file_id=file_id,
                            force_new=True,
                        )
                else:
                    results_list.append(
                        self._seal_snapshot(
                            connection,
                            snapshot,
                            descriptor,
                            now,
                            annotation_descriptor=annotation_descriptor,
                            file_id=file_id,
                            force_new=True,
                        ).version
                    )
            results = tuple(results_list)
            connection.execute(
                """
                UPDATE resources_restores SET state = ?, updated_at_ms = ?
                WHERE transaction_id = ?
                """,
                (RestoreState.COMMITTED.value, now, transaction_id),
            )
            operation = connection.execute(
                "SELECT idempotency_key, result_json FROM resources_operations WHERE transaction_id = ?",
                (transaction_id,),
            ).fetchone()
            if operation is not None:
                previous = json.loads(str(operation["result_json"]))
                connection.execute(
                    """
                    UPDATE resources_operations
                    SET state = ?, result_version_id = ?, result_json = ?, updated_at_ms = ?
                    WHERE idempotency_key = ? AND state = ?
                    """,
                    (
                        OPERATION_STATE_COMMITTED,
                        results[0].id if len(results) == 1 else None,
                        json.dumps(
                            {
                                "skipped_file_ids": previous.get("skipped_file_ids", []),
                                "version_ids": [item.id for item in results],
                            },
                            separators=(",", ":"),
                            sort_keys=True,
                        ),
                        now,
                        str(operation["idempotency_key"]),
                        OPERATION_STATE_PREPARED,
                    ),
                )
                if len(results) > 1:
                    connection.executemany(
                        """
                        INSERT INTO resources_operation_versions (
                            idempotency_key, ordinal, version_id
                        ) VALUES (?, ?, ?)
                        """,
                        tuple(
                            (str(operation["idempotency_key"]), index, item.id)
                            for index, item in enumerate(results)
                        ),
                    )
        return results

    def _seal_review_backup(
        self,
        connection: sqlite3.Connection,
        file_id: str,
        review_id: str,
        member: sqlite3.Row,
        now: int,
    ) -> None:
        row = connection.execute(
            "SELECT media_type FROM resources_files WHERE file_id = ?", (file_id,)
        ).fetchone()
        if row is None:
            raise VersionStoreConflict("file_not_managed")
        self._seal_snapshot(
            connection,
            SnapshotVersion(
                path=str(member["before_path"]),
                media_type=str(row["media_type"]),
                revision=member["before_object_id"],
                object_id=member["before_object_id"],
                mode_bits=member["before_mode_bits"],
                mtime_ns=None,
                origin=VersionOrigin.EXTERNAL_CONFIRMED,
                state=FileState(member["before_state"]),
                source_review_id=review_id,
            ),
            None,
            now,
            file_id=file_id,
            force_new=True,
            review_backup=True,
        )

    def _cancel_pending(
        self,
        connection: sqlite3.Connection,
        file_id: str,
        snapshot: SnapshotVersion,
        current: PendingSnapshot,
        now: int,
    ) -> None:
        review = current.review
        if review is not None:
            target, origin = review.base, review.base_origin or PendingOrigin.USER
        else:
            latest = connection.execute(
                "SELECT * FROM resources_versions WHERE file_id = ? ORDER BY sequence DESC LIMIT 1",
                (file_id,),
            ).fetchone()
            if latest is None:
                raise VersionStoreConflict("version_not_found")
            target, origin = _snapshot_identity(latest), PendingOrigin.USER
        restored = SnapshotIdentity(
            snapshot.object_id,
            snapshot.state,
            snapshot.path,
            snapshot.mode_bits,
            snapshot.annotation_object_id,
        )
        if restored != target or snapshot.revision != target.object_id:
            raise VersionStoreConflict(ReviewConflict.CANDIDATE_REVISION.value)
        previous = connection.execute(
            "SELECT current_path FROM resources_files WHERE file_id = ?", (file_id,)
        ).fetchone()
        if previous["current_path"] != snapshot.path:
            self._release_discovery_identity(connection, snapshot)
            connection.execute(
                "UPDATE resources_file_paths SET valid_to_ms = ? WHERE file_id = ? AND valid_to_ms IS NULL",
                (now, file_id),
            )
            connection.execute(
                """INSERT INTO resources_file_paths (path_id, file_id, root_id, path, valid_from_ms, valid_to_ms, move_origin)
                VALUES (?, ?, NULL, ?, ?, NULL, ?)""",
                (uuid4().hex, file_id, snapshot.path, now, PendingOrigin.RESTORE.value),
            )
        connection.execute(
            """UPDATE resources_files SET current_path = ?, state = ?, updated_at_ms = ?,
                media_type = CASE WHEN ? = 'present' THEN ? ELSE media_type END WHERE file_id = ?""",
            (
                snapshot.path,
                snapshot.state.value,
                now,
                snapshot.state.value,
                snapshot.media_type,
                file_id,
            ),
        )
        self._advance_head(connection, file_id, snapshot, now)
        connection.execute("DELETE FROM resources_pending WHERE file_id = ?", (file_id,))
        pending.sync_working(connection, file_id, origin, now)

    @classmethod
    def _seal_snapshot(
        cls,
        connection: sqlite3.Connection,
        snapshot: SnapshotVersion,
        descriptor: ObjectDescriptor | None,
        now: int,
        *,
        annotation_descriptor: ObjectDescriptor | None = None,
        file_id: str | None = None,
        expected_version_id: str | None = None,
        force_new: bool = False,
        review_backup: bool = False,
        editor_save: bool = False,
        identities: InitialVersionPlan | None = None,
    ) -> SealResult:
        if identities is not None:
            identities.validate()
            if identities.now_ms != now:
                raise ValueError("initial version clock changed")
        if descriptor is not None:
            cls._record_object(connection, descriptor, now)
        if annotation_descriptor is not None:
            cls._record_object(connection, annotation_descriptor, now)
        file_row = connection.execute(
            (
                "SELECT * FROM resources_files WHERE file_id = ?"
                if file_id is not None
                else "SELECT * FROM resources_files WHERE current_path = ?"
            ),
            (file_id if file_id is not None else snapshot.path,),
        ).fetchone()
        if file_row is None:
            file_id = cls._insert_file(
                connection,
                snapshot,
                now,
                file_id or (identities.file_id if identities else None),
                path_id=identities.path_id if identities else None,
            )
        else:
            file_id = str(file_row["file_id"])
            if str(file_row["current_path"]) != snapshot.path:
                cls._release_discovery_identity(connection, snapshot)
                connection.execute(
                    """
                    UPDATE resources_file_paths SET valid_to_ms = ?
                    WHERE file_id = ? AND valid_to_ms IS NULL
                    """,
                    (now, file_id),
                )
                connection.execute(
                    """
                    INSERT INTO resources_file_paths (
                        path_id, file_id, root_id, path, valid_from_ms,
                        valid_to_ms, move_origin
                    ) VALUES (?, ?, NULL, ?, ?, NULL, ?)
                    """,
                    (
                        identities.path_id if identities else uuid4().hex,
                        file_id,
                        snapshot.path,
                        now,
                        snapshot.origin.value,
                    ),
                )

        latest = connection.execute(
            """
            SELECT * FROM resources_versions
            WHERE file_id = ? ORDER BY sequence DESC LIMIT 1
            """,
            (file_id,),
        ).fetchone()
        if expected_version_id is not None and (
            latest is None or str(latest["version_id"]) != expected_version_id
        ):
            raise VersionStoreConflict("version_head_conflict")
        if (
            not force_new
            and latest is not None
            and latest["file_state"] == snapshot.state.value
            and latest["object_id"] == snapshot.object_id
            and latest["path"] == snapshot.path
            and latest["mode_bits"] == snapshot.mode_bits
        ):
            if latest["annotation_object_id"] != snapshot.annotation_object_id:
                return SealResult(version=_version(latest), unchanged=True)
            cls._advance_head(connection, file_id, snapshot, now)
            return SealResult(version=_version(latest), unchanged=True)

        sequence = int(file_row["next_sequence"]) if file_row is not None else 1
        version_id = identities.version_id if identities else uuid4().hex
        parent_id = str(latest["version_id"]) if latest is not None else None
        connection.execute(
            """
            INSERT INTO resources_versions (
                version_id, file_id, sequence, parent_version_id, object_id,
                file_state, root_id, path, mode_bits, annotation_object_id,
                origin, delivery_id, restored_from_id, restored_from_sequence,
                restored_from_object_id, source_delivery_id, session_id, turn_id,
                created_at_ms, source_review_id, review_outcome, review_backup, editor_save
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                version_id,
                file_id,
                sequence,
                parent_id,
                snapshot.object_id,
                snapshot.state.value,
                snapshot.path,
                snapshot.mode_bits,
                snapshot.annotation_object_id,
                snapshot.origin.value,
                snapshot.delivery_id,
                snapshot.restored_from_id,
                snapshot.restored_from_sequence,
                snapshot.restored_from_object_id,
                snapshot.source_delivery_id,
                snapshot.session_id,
                snapshot.turn_id,
                now,
                snapshot.source_review_id,
                snapshot.review_outcome.value if snapshot.review_outcome else None,
                int(review_backup),
                int(editor_save),
            ),
        )
        connection.execute(
            """
            UPDATE resources_files
            SET next_sequence = ?, current_path = ?, media_type = ?, state = ?,
                updated_at_ms = ?
            WHERE file_id = ?
            """,
            (
                sequence + 1,
                snapshot.path,
                snapshot.media_type,
                snapshot.state.value,
                now,
                file_id,
            ),
        )
        connection.execute(
            """
            INSERT INTO resources_observations (
                observation_id, file_id, revision, file_state, size_bytes,
                mtime_ns, mode_bits, reason, observed_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                identities.observation_id if identities else uuid4().hex,
                file_id,
                snapshot.revision,
                snapshot.state.value,
                descriptor.raw_size_bytes if descriptor is not None else None,
                snapshot.mtime_ns,
                snapshot.mode_bits,
                snapshot.origin.value,
                now,
            ),
        )
        cls._advance_head(connection, file_id, snapshot, now)
        row = connection.execute(
            "SELECT * FROM resources_versions WHERE version_id = ?", (version_id,)
        ).fetchone()
        return SealResult(version=_version(row), unchanged=False)

    def move_identity(self, file_id: str, path: str, origin: str) -> None:
        """Advance logical path history while retaining one stable file id."""

        self.ensure()
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            self._move_identity(connection, file_id, path, origin, now)

    @staticmethod
    def _move_identity(
        connection: sqlite3.Connection, file_id: str, path: str, origin: str, now: int
    ) -> None:
        connection.execute(
            "UPDATE resources_file_paths SET valid_to_ms = ? WHERE file_id = ? AND valid_to_ms IS NULL",
            (now, file_id),
        )
        connection.execute(
            "UPDATE resources_files SET current_path = ?, updated_at_ms = ? WHERE file_id = ?",
            (path, now, file_id),
        )
        connection.execute("UPDATE resources_heads SET path = ? WHERE file_id = ?", (path, file_id))
        connection.execute(
            """
                INSERT INTO resources_file_paths (
                    path_id, file_id, root_id, path, valid_from_ms, valid_to_ms, move_origin
                ) VALUES (?, ?, NULL, ?, ?, NULL, ?)
                """,
            (uuid4().hex, file_id, path, now, origin),
        )

    def prepare_working_mutation(
        self,
        file_id: str | None,
        snapshot: SnapshotVersion,
        descriptor: ObjectDescriptor,
        idempotency_key: str,
        expected_revision: str | None,
        kind: ProductMutationKind = ProductMutationKind.WRITE,
        request_digest: str | None = None,
        seal_version: bool = False,
    ) -> WorkingMutation:
        """Persist target bytes and expected head before the filesystem is changed."""

        self.ensure()
        if snapshot.revision is None or snapshot.object_id is None or snapshot.mode_bits is None:
            raise VersionStoreConflict("invalid_mutation_target")
        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            existing = connection.execute(
                "SELECT * FROM resources_mutations WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            if existing is not None:
                return self._working_mutation(existing)
            if kind is ProductMutationKind.CREATE:
                if file_id is not None or expected_revision is not None:
                    raise VersionStoreConflict("invalid_mutation_target")
                occupied = connection.execute(
                    """
                    SELECT files.file_id, files.state, heads.file_state
                    FROM resources_files AS files
                    LEFT JOIN resources_heads AS heads USING(file_id)
                    WHERE files.current_path = ?
                    """,
                    (snapshot.path,),
                ).fetchone()
                if occupied is not None:
                    active_mutation_placeholders = ",".join(
                        "?" for _state in ACTIVE_MUTATION_STATES
                    )
                    active_restore_placeholders = ",".join("?" for _state in ACTIVE_RESTORE_STATES)
                    blocked = connection.execute(
                        f"""
                        SELECT 1 FROM resources_mutations
                        WHERE file_id = ? AND state IN ({active_mutation_placeholders})
                        UNION ALL
                        SELECT 1 FROM resources_restore_members AS members
                        JOIN resources_restores AS restores USING(transaction_id)
                        WHERE members.file_id = ?
                          AND restores.state IN ({active_restore_placeholders})
                        LIMIT 1
                        """,
                        (
                            occupied["file_id"],
                            *ACTIVE_MUTATION_STATES,
                            occupied["file_id"],
                            *ACTIVE_RESTORE_STATES,
                        ),
                    ).fetchone()
                    if (
                        occupied["state"] != FileState.TOMBSTONE.value
                        or occupied["file_state"] != FileState.TOMBSTONE.value
                        or blocked is not None
                    ):
                        raise VersionStoreConflict("path_exists")
                    file_id = str(occupied["file_id"])
                else:
                    reserved = SnapshotVersion(
                        path=snapshot.path,
                        media_type=snapshot.media_type,
                        revision=None,
                        object_id=None,
                        mode_bits=None,
                        mtime_ns=None,
                        origin=VersionOrigin.INITIAL_SCAN,
                        state=FileState.TOMBSTONE,
                    )
                    file_id = self._insert_file(connection, reserved, now)
            else:
                if file_id is None:
                    raise VersionStoreConflict("file_not_managed")
                head = connection.execute(
                    "SELECT revision FROM resources_heads WHERE file_id = ?", (file_id,)
                ).fetchone()
                if head is None:
                    raise VersionStoreConflict("file_not_managed")
                if head["revision"] != expected_revision:
                    raise VersionStoreConflict("revision_conflict")
            self._record_object(connection, descriptor, now)
            mutation_id = uuid4().hex
            connection.execute(
                """
                INSERT INTO resources_mutations (
                    mutation_id, idempotency_key, file_id, kind, state,
                    expected_revision, target_revision, target_object_id,
                    target_path, target_mode_bits, request_digest, seal_version, actor,
                    created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)
                """,
                (
                    mutation_id,
                    idempotency_key,
                    file_id,
                    kind.value,
                    expected_revision,
                    snapshot.revision,
                    snapshot.object_id,
                    snapshot.path,
                    snapshot.mode_bits,
                    request_digest,
                    int(seal_version),
                    now,
                    now,
                ),
            )
            row = connection.execute(
                "SELECT * FROM resources_mutations WHERE mutation_id = ?", (mutation_id,)
            ).fetchone()
        return self._working_mutation(row)

    def mark_working_mutation_applied(self, mutation_id: str) -> None:
        """Record that the exact target revision reached disk."""

        with transaction(self._database, immediate=True) as connection:
            cursor = connection.execute(
                """
                UPDATE resources_mutations SET state = 'file_applied', updated_at_ms = ?
                WHERE mutation_id = ? AND state = 'prepared'
                """,
                (_now_ms(), mutation_id),
            )
            if cursor.rowcount != 1:
                raise VersionStoreConflict("invalid_mutation_state")

    def working_mutation(self, idempotency_key: str) -> WorkingMutation | None:
        """Resolve one durable product mutation without observing the filesystem."""

        self.ensure()
        with closing(connect(self._database)) as connection:
            row = connection.execute(
                "SELECT * FROM resources_mutations WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
        return self._working_mutation(row) if row is not None else None

    def commit_working_mutation(
        self,
        mutation_id: str,
        snapshot: SnapshotVersion,
        annotation_descriptor: ObjectDescriptor | None = None,
    ) -> SealResult | None:
        """Atomically publish the complete WorkingHead, optional Version, and close the intent."""

        now = _now_ms()
        with transaction(self._database, immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM resources_mutations WHERE mutation_id = ?", (mutation_id,)
            ).fetchone()
            if row is None or str(row["state"]) not in {"prepared", "file_applied"}:
                raise VersionStoreConflict("invalid_mutation_state")
            seals_version = str(row["kind"]) == ProductMutationKind.CREATE.value or bool(
                row["seal_version"]
            )
            sealed = None
            if seals_version:
                editor_save = (
                    str(row["kind"]) == ProductMutationKind.WRITE.value
                    and row["request_digest"] is None
                )
                if editor_save:
                    sealed = self._coalesce_working_version(
                        connection, str(row["file_id"]), snapshot, now, annotation_descriptor
                    )
                if sealed is None:
                    sealed = self._seal_snapshot(
                        connection,
                        snapshot,
                        None,
                        now,
                        annotation_descriptor=annotation_descriptor,
                        file_id=str(row["file_id"]),
                        editor_save=editor_save,
                    )
            else:
                if annotation_descriptor is not None:
                    self._record_object(connection, annotation_descriptor, now)
                self._advance_head(connection, str(row["file_id"]), snapshot, now)
            pending.sync_working(connection, str(row["file_id"]), PendingOrigin.USER, now)
            object_row = connection.execute(
                "SELECT raw_size_bytes FROM resources_objects WHERE object_id = ?",
                (snapshot.object_id,),
            ).fetchone()
            connection.execute(
                """
                INSERT INTO resources_observations (
                    observation_id, file_id, revision, file_state, size_bytes,
                    mtime_ns, mode_bits, reason, observed_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?)
                """,
                (
                    uuid4().hex,
                    row["file_id"],
                    snapshot.revision,
                    snapshot.state.value,
                    object_row["raw_size_bytes"] if object_row is not None else None,
                    snapshot.mtime_ns,
                    snapshot.mode_bits,
                    now,
                ),
            )
            connection.execute(
                """
                UPDATE resources_files
                SET current_path = ?, media_type = ?, state = ?, updated_at_ms = ?
                WHERE file_id = ?
                """,
                (
                    snapshot.path,
                    snapshot.media_type,
                    snapshot.state.value,
                    now,
                    row["file_id"],
                ),
            )
            connection.execute(
                """
                UPDATE resources_mutations
                SET state = 'ledger_committed', updated_at_ms = ? WHERE mutation_id = ?
                """,
                (now, mutation_id),
            )
        return sealed

    def _coalesce_working_version(
        self,
        connection: sqlite3.Connection,
        file_id: str,
        snapshot: SnapshotVersion,
        now: int,
        annotation_descriptor: ObjectDescriptor | None,
    ) -> SealResult | None:
        version = connection.execute(
            """
            SELECT versions.*, metadata.alias,
                   COALESCE(metadata.revision, 0) AS metadata_revision
            FROM resources_versions AS versions
            LEFT JOIN resources_version_metadata AS metadata USING(version_id)
            WHERE versions.file_id = ? ORDER BY sequence DESC LIMIT 1
            """,
            (file_id,),
        ).fetchone()
        if version is None:
            return None
        version_id = str(version["version_id"])
        if (
            snapshot.origin is not VersionOrigin.USER
            or snapshot.state is not FileState.PRESENT
            or version["origin"] != VersionOrigin.USER.value
            or not version["editor_save"]
            or version["file_state"] != snapshot.state.value
            or version["path"] != snapshot.path
            or not 0 <= now - int(version["created_at_ms"]) < EDITOR_VERSION_WINDOW_MS
            or version["alias"]
            or version["review_backup"]
            or version["source_review_id"] is not None
            or version["session_id"] is not None
            or version["restored_from_id"] is not None
        ):
            return None
        _version_row, blockers, delivery_ids, _current_id = self._delete_facts(
            connection, version_id
        )
        if delivery_ids or any(blocker != VERSION_DELETE_CURRENT for blocker in blockers):
            return None
        references = connection.execute(
            """
            SELECT 1 FROM resources_turn_changes WHERE baseline_version_id = :version_id
            UNION ALL SELECT 1 FROM resources_versions WHERE restored_from_id = :version_id
            UNION ALL SELECT 1 FROM resources_restores WHERE source_id = :version_id
            UNION ALL SELECT 1 FROM resources_operations WHERE result_version_id = :version_id
            UNION ALL SELECT 1 FROM resources_operation_versions WHERE version_id = :version_id
            UNION ALL SELECT 1 FROM resources_review_batch_members WHERE result_version_id = :version_id
            LIMIT 1
            """,
            {"version_id": version_id},
        ).fetchone()
        if references is not None:
            return None
        if (
            version["object_id"] == snapshot.object_id
            and version["mode_bits"] == snapshot.mode_bits
            and version["annotation_object_id"] == snapshot.annotation_object_id
        ):
            return None
        if annotation_descriptor is not None:
            self._record_object(connection, annotation_descriptor, now)
        connection.execute(
            """
            UPDATE resources_versions
            SET object_id = ?, mode_bits = ?, annotation_object_id = ?
            WHERE version_id = ?
            """,
            (snapshot.object_id, snapshot.mode_bits, snapshot.annotation_object_id, version_id),
        )
        self._advance_head(connection, file_id, snapshot, now)
        updated = replace(
            _version(version),
            object_id=snapshot.object_id,
            mode_bits=snapshot.mode_bits,
            annotation_object_id=snapshot.annotation_object_id,
        )
        return SealResult(version=updated, unchanged=False, replaced=True)

    def pending_working_mutations(self) -> tuple[WorkingMutation, ...]:
        """Return intents whose disk/ledger outcome must be reconciled."""

        if not self._database.exists():
            return ()
        self.ensure()
        connection = connect(self._database)
        try:
            rows = connection.execute("""
                SELECT * FROM resources_mutations
                WHERE state IN ('prepared','file_applied')
                ORDER BY created_at_ms, mutation_id
                """).fetchall()
        finally:
            connection.close()
        return tuple(self._working_mutation(row) for row in rows)

    def fail_working_mutation(self, mutation_id: str, state: str) -> None:
        """Close an intent whose disk no longer matches either fenced revision."""

        if state not in {"conflicted", "needs_reconcile"}:
            raise ValueError("invalid mutation failure state")
        with transaction(self._database, immediate=True) as connection:
            connection.execute(
                "UPDATE resources_mutations SET state = ?, updated_at_ms = ? WHERE mutation_id = ?",
                (state, _now_ms(), mutation_id),
            )

    @staticmethod
    def _working_mutation(row: sqlite3.Row) -> WorkingMutation:
        return WorkingMutation(
            id=str(row["mutation_id"]),
            file_id=str(row["file_id"]),
            kind=ProductMutationKind(str(row["kind"])),
            state=str(row["state"]),
            expected_revision=(
                str(row["expected_revision"]) if row["expected_revision"] is not None else None
            ),
            target_revision=str(row["target_revision"]),
            target_object_id=str(row["target_object_id"]),
            target_path=str(row["target_path"]),
            target_mode_bits=int(row["target_mode_bits"]),
            seal_version=bool(row["seal_version"]),
            request_digest=(
                str(row["request_digest"]) if row["request_digest"] is not None else None
            ),
        )

    def accept_working(
        self,
        file_id: str | None,
        snapshot: SnapshotVersion,
        descriptor: ObjectDescriptor | None,
        annotation_descriptor: ObjectDescriptor | None,
        reason: str,
        *,
        now_ms: int | None = None,
    ) -> None:
        """Advance WorkingHead after a product write without appending a Version."""
        self.ensure()
        with transaction(self._database, immediate=True) as connection:
            self.accept_working_rows(
                connection,
                file_id,
                snapshot,
                descriptor,
                annotation_descriptor,
                reason,
                now=_now_ms() if now_ms is None else now_ms,
                new_file_id=uuid4().hex if file_id is None else None,
                new_path_id=uuid4().hex if file_id is None else None,
                observation_id=uuid4().hex if reason != EXTERNAL_OBSERVATION_REASON else None,
            )

    @classmethod
    def accept_working_rows(
        cls,
        connection: sqlite3.Connection,
        file_id: str | None,
        snapshot: SnapshotVersion,
        descriptor: ObjectDescriptor | None,
        annotation_descriptor: ObjectDescriptor | None,
        reason: str,
        *,
        now: int,
        new_file_id: str | None = None,
        new_path_id: str | None = None,
        observation_id: str | None = None,
    ) -> None:
        """Use actual head/pending writers with explicit projection identities.

        Private callers must supply every new identity; this transition never
        substitutes random values or samples the wall clock. It does not prove
        the snapshot's source bytes or publish its referenced CAS objects.
        """
        if not connection.in_transaction:
            raise ValueError("working head recovery requires a transaction")
        if type(now) is not int or now < 0:
            raise ValueError("invalid working head timestamp")
        required = (() if file_id is not None else (new_file_id, new_path_id)) + (
            () if reason == EXTERNAL_OBSERVATION_REASON else (observation_id,)
        )
        if any(not isinstance(value, str) or not value or "\0" in value for value in required):
            raise ValueError("working head recovery requires explicit identities")
        PendingOrigin(reason)
        if file_id is None:
            file_id = cls._insert_file(connection, snapshot, now, new_file_id, path_id=new_path_id)
        else:
            exists = connection.execute(
                "SELECT 1 FROM resources_files WHERE file_id = ?", (file_id,)
            ).fetchone()
            if exists is None:
                raise VersionStoreConflict("file_not_managed")
        if descriptor is not None:
            cls._record_object(connection, descriptor, now)
        if annotation_descriptor is not None:
            cls._record_object(connection, annotation_descriptor, now)
        connection.execute(
            """
            UPDATE resources_files
            SET current_path = ?,
                media_type = CASE WHEN ? = 'present' THEN ? ELSE media_type END,
                state = ?, updated_at_ms = ?
            WHERE file_id = ?
            """,
            (
                snapshot.path,
                snapshot.state.value,
                snapshot.media_type,
                snapshot.state.value,
                now,
                file_id,
            ),
        )
        if reason != EXTERNAL_OBSERVATION_REASON:
            connection.execute(
                """
                INSERT INTO resources_observations (
                    observation_id, file_id, revision, file_state, size_bytes,
                    mtime_ns, mode_bits, reason, observed_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    observation_id,
                    file_id,
                    snapshot.revision,
                    snapshot.state.value,
                    descriptor.raw_size_bytes if descriptor is not None else None,
                    snapshot.mtime_ns,
                    snapshot.mode_bits,
                    reason,
                    now,
                ),
            )
        cls._advance_head(connection, file_id, snapshot, now)

        pending.sync_working(connection, file_id, PendingOrigin(reason), now)

    @staticmethod
    def _release_discovery_identity(
        connection: sqlite3.Connection, snapshot: SnapshotVersion
    ) -> None:
        """A correlated Agent move may replace only an unreferenced discovery identity."""

        destination = connection.execute(
            "SELECT file_id FROM resources_files WHERE current_path = ?", (snapshot.path,)
        ).fetchone()
        if destination is None:
            return
        identity = str(destination["file_id"])
        referenced = connection.execute(
            """
            SELECT 1 FROM resources_versions WHERE file_id = ?
            UNION ALL SELECT 1 FROM resources_turn_changes WHERE file_id = ?
            UNION ALL SELECT 1 FROM resources_mutations WHERE file_id = ?
            UNION ALL SELECT 1 FROM resources_restore_members WHERE file_id = ?
            UNION ALL SELECT 1 FROM resources_pending
                WHERE file_id = ? AND (review_id IS NOT NULL OR origin != ?)
            UNION ALL SELECT 1 FROM resources_review_batch_members WHERE file_id = ?
            LIMIT 1
            """,
            (
                identity,
                identity,
                identity,
                identity,
                identity,
                PendingOrigin.EXTERNAL.value,
                identity,
            ),
        ).fetchone()
        if snapshot.origin is not VersionOrigin.AGENT or referenced is not None:
            raise VersionStoreConflict("file_identity_conflict")
        connection.execute("DELETE FROM resources_files WHERE file_id = ?", (identity,))

    @staticmethod
    def _insert_file(
        connection: sqlite3.Connection,
        snapshot: SnapshotVersion,
        now: int,
        file_id: str | None = None,
        *,
        path_id: str | None = None,
    ) -> str:
        """Register stable identity independently of the first visible Version."""

        identity = file_id or uuid4().hex
        connection.execute(
            """
            INSERT INTO resources_files (
                file_id, current_root_id, current_path, media_type, state,
                management_state, next_sequence, created_at_ms, updated_at_ms
            ) VALUES (?, NULL, ?, ?, ?, ?, 1, ?, ?)
            """,
            (identity, snapshot.path, snapshot.media_type, snapshot.state.value, MANAGED, now, now),
        )
        connection.execute(
            """
            INSERT INTO resources_file_paths (
                path_id, file_id, root_id, path, valid_from_ms, valid_to_ms, move_origin
            ) VALUES (?, ?, NULL, ?, ?, NULL, NULL)
            """,
            (path_id or uuid4().hex, identity, snapshot.path, now),
        )
        return identity

    @staticmethod
    def _record_object(
        connection: sqlite3.Connection, descriptor: ObjectDescriptor, now: int
    ) -> None:
        connection.execute(
            """
            INSERT INTO resources_objects (
                object_id, layout, codec, format_version, raw_size_bytes,
                stored_size_bytes, descriptor_digest, state, stored_at_ms,
                verified_at_ms, trash_epoch
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(object_id) DO UPDATE SET
                state = excluded.state,
                verified_at_ms = excluded.verified_at_ms,
                trash_epoch = NULL
            """,
            (
                descriptor.object_id,
                descriptor.layout.value,
                (
                    descriptor.codec.value
                    if isinstance(descriptor.codec, WholeCodec)
                    else descriptor.codec
                ),
                descriptor.format_version,
                descriptor.raw_size_bytes,
                descriptor.stored_size_bytes,
                descriptor.descriptor_digest,
                OBJECT_READY,
                now,
                now,
            ),
        )
        for chunk in descriptor.chunks:
            connection.execute(
                """
                INSERT INTO resources_chunks (
                    chunk_id, codec, format_version, raw_size_bytes, stored_size_bytes,
                    descriptor_digest, state, stored_at_ms, verified_at_ms, trash_epoch
                ) VALUES (?, 'IDENTITY', ?, ?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT(chunk_id) DO UPDATE SET
                    state = excluded.state,
                    verified_at_ms = excluded.verified_at_ms,
                    trash_epoch = NULL
                """,
                (
                    chunk.chunk_id,
                    descriptor.format_version,
                    chunk.raw_size_bytes,
                    chunk.raw_size_bytes,
                    chunk.chunk_id,
                    OBJECT_READY,
                    now,
                    now,
                ),
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO resources_object_chunks (
                    object_id, ordinal, chunk_id, raw_offset, raw_size_bytes
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    descriptor.object_id,
                    chunk.ordinal,
                    chunk.chunk_id,
                    chunk.raw_offset,
                    chunk.raw_size_bytes,
                ),
            )

    @staticmethod
    def _advance_head(
        connection: sqlite3.Connection,
        file_id: str,
        snapshot: SnapshotVersion,
        now: int,
    ) -> None:
        if snapshot.state is FileState.TOMBSTONE:
            connection.execute("DELETE FROM resources_admissions WHERE file_id = ?", (file_id,))
        # A successful product/user/restore write supersedes the bounded external
        # observation. Retaining it would report stale drift after the accepted head moves.
        connection.execute(
            "DELETE FROM resources_observations WHERE observation_id = ?",
            (f"{EXTERNAL_OBSERVATION_REASON}:{file_id}",),
        )
        connection.execute(
            """
            INSERT INTO resources_heads (
                file_id, revision, object_id, file_state, root_id, path,
                mode_bits, annotation_revision, annotation_object_id, accepted_at_ms
            ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
            ON CONFLICT(file_id) DO UPDATE SET
                revision = excluded.revision,
                object_id = excluded.object_id,
                file_state = excluded.file_state,
                path = excluded.path,
                mode_bits = excluded.mode_bits,
                annotation_revision = excluded.annotation_revision,
                annotation_object_id = excluded.annotation_object_id,
                accepted_at_ms = excluded.accepted_at_ms
            """,
            (
                file_id,
                snapshot.revision,
                snapshot.object_id,
                snapshot.state.value,
                snapshot.path,
                snapshot.mode_bits,
                snapshot.annotation_revision,
                snapshot.annotation_object_id,
                now,
            ),
        )


class VersionStoreConflict(RuntimeError):
    """An optimistic ledger precondition no longer matches."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


__all__ = ["SCHEMA", "VersionStore", "VersionStoreConflict"]
