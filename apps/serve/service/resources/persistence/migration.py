"""Read-only legacy inputs and atomic cutover receipts in the resource ledger."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict, dataclass
from enum import StrEnum
from hashlib import sha256
from typing import Mapping

from service.platform.resources import (
    ChangeAttribution,
    FileState,
    PendingOrigin,
    PendingReview,
    SnapshotIdentity,
    TurnOutcome,
)
from service.resources.persistence import pending

LEGACY_OPEN_STATES = ("pending", "frozen")
LEGACY_TABLES = frozenset({"documents_change_sets", "documents_change_files"})
LEGACY_DELETED = "deleted"
LEGACY_REVIEW_PREFIX = "legacy:"
EVIDENCE_PATHS = {"baseline": "m.before_path", "snapshot": "v.path"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS resources_review_migrations (
    source_id TEXT NOT NULL,
    path TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    source_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('migrated', 'blocked', 'resolved')),
    file_id TEXT,
    review_id TEXT,
    blocker TEXT,
    decision TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY(source_id, path)
)
"""


class MigrationStatus(StrEnum):
    MIGRATED = "migrated"
    BLOCKED = "blocked"
    RESOLVED = "resolved"


class MigrationBlocker(StrEnum):
    SOURCE_CHANGED = "legacy_source_changed"
    BASELINE_INCOMPLETE = "legacy_baseline_incomplete"
    BLOB_INVALID = "legacy_blob_invalid"
    EVIDENCE_MISSING = "legacy_evidence_missing"
    EVIDENCE_INVALID = "legacy_evidence_invalid"
    HEAD_CONFLICT = "legacy_head_conflict"
    DISK_CONFLICT = "legacy_disk_conflict"
    REVIEW_CONFLICT = "legacy_review_conflict"
    SNAPSHOT_UNAVAILABLE = "legacy_snapshot_unavailable"
    RESOLUTION_NOT_SAVED = "legacy_resolution_not_saved"
    RESOLUTION_CONFLICT = "legacy_resolution_conflict"
    ACTIVE_TURN = "legacy_turn_active"


class MigrationError(RuntimeError):
    def __init__(self, code: MigrationBlocker) -> None:
        super().__init__(code.value)
        self.code = code.value


@dataclass(frozen=True)
class LegacyReview:
    source_id: str
    path: str
    revision: int
    digest: str
    first_session: str
    first_turn: str
    latest_session: str
    latest_turn: str
    baseline_complete: bool
    before_sha: str
    before_blob: str
    after_sha: str
    after_blob: str
    change_kind: str
    decision: str


@dataclass(frozen=True)
class MigrationRecord:
    source_id: str
    path: str
    source_revision: int
    source_digest: str
    status: str
    file_id: str | None
    review_id: str | None
    blocker: str | None


@dataclass(frozen=True)
class MigrationResolution:
    source_id: str
    path: str
    source_digest: str
    file_id: str
    version_id: str
    idempotency_key: str


@dataclass(frozen=True)
class MigrationProof:
    file_id: str
    pending_revision: int | None
    review: PendingReview


def available(connection: sqlite3.Connection) -> bool:
    tables = {
        row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    return LEGACY_TABLES.issubset(tables)


def read(connection: sqlite3.Connection, source_id: str, path: str) -> LegacyReview | None:
    batch = connection.execute(
        "SELECT * FROM documents_change_sets WHERE id = ?", (source_id,)
    ).fetchone()
    row = connection.execute(
        "SELECT * FROM documents_change_files WHERE change_set_id = ? AND path = ?",
        (source_id, path),
    ).fetchone()
    if batch is None or row is None or batch["state"] not in LEGACY_OPEN_STATES:
        return None
    batch, row = dict(batch), dict(row)
    digest = sha256(
        json.dumps([batch, row], sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return LegacyReview(
        source_id,
        path,
        int(batch["revision"]),
        digest,
        str(batch["session_id"]),
        str(batch["turn_id"]),
        str(batch.get("latest_session_id") or batch["session_id"]),
        str(batch.get("latest_turn_id") or batch["turn_id"]),
        bool(batch.get("baseline_complete", False)),
        str(row["before_sha256"]),
        str(row["before_blob"]),
        str(row["after_sha256"]),
        str(row["after_blob"]),
        str(row["change_kind"]),
        str(row["decision"]),
    )


def inputs(connection: sqlite3.Connection) -> tuple[LegacyReview, ...]:
    if not available(connection):
        return ()
    keys = connection.execute(
        "SELECT f.change_set_id, f.path FROM documents_change_files f "
        "JOIN documents_change_sets b ON b.id = f.change_set_id "
        "LEFT JOIN resources_review_migrations m ON m.source_id = f.change_set_id AND m.path = f.path "
        "WHERE b.state IN (?, ?) AND (m.status IS NULL OR m.status = ?) ORDER BY b.id, f.path",
        (*LEGACY_OPEN_STATES, MigrationStatus.BLOCKED.value),
    ).fetchall()
    return tuple(item for row in keys if (item := read(connection, row[0], row[1])) is not None)


def records(connection: sqlite3.Connection) -> tuple[MigrationRecord, ...]:
    return tuple(
        MigrationRecord(**dict(row))
        for row in connection.execute(
            "SELECT source_id, path, source_revision, source_digest, status, file_id, review_id, blocker "
            "FROM resources_review_migrations ORDER BY source_id, path"
        )
    )


def resolved(
    connection: sqlite3.Connection, request: MigrationResolution
) -> MigrationRecord | None:
    """A replay returns the original confirmation without examining newer files."""

    row = connection.execute(
        "SELECT status, resolution FROM resources_review_migrations WHERE source_id = ? AND path = ?",
        (request.source_id, request.path),
    ).fetchone()
    if row is None:
        raise MigrationError(MigrationBlocker.SOURCE_CHANGED)
    if row["status"] == MigrationStatus.RESOLVED.value:
        if not row["resolution"] or json.loads(row["resolution"]) != asdict(request):
            raise MigrationError(MigrationBlocker.RESOLUTION_CONFLICT)
        return next(
            item
            for item in records(connection)
            if item.source_id == request.source_id and item.path == request.path
        )
    if row["status"] != MigrationStatus.BLOCKED.value:
        raise MigrationError(MigrationBlocker.REVIEW_CONFLICT)
    return None


def resolve(
    connection: sqlite3.Connection, request: MigrationResolution, now: int
) -> MigrationRecord:
    connection.execute(
        "UPDATE resources_review_migrations SET status = ?, file_id = ?, blocker = NULL, "
        "resolution = ?, updated_at_ms = ? WHERE source_id = ? AND path = ?",
        (
            MigrationStatus.RESOLVED.value,
            request.file_id,
            json.dumps(asdict(request), sort_keys=True),
            now,
            request.source_id,
            request.path,
        ),
    )
    return next(
        item
        for item in records(connection)
        if item.source_id == request.source_id and item.path == request.path
    )


def protected_history(connection: sqlite3.Connection) -> tuple[set[str], set[str]]:
    """Keep exact historical evidence while a legacy review remains unresolved."""

    versions: set[str] = set()
    deliveries: set[str] = set()
    for item in inputs(connection):
        for session_id, turn_id in (
            (item.first_session, item.first_turn),
            (item.latest_session, item.latest_turn),
        ):
            # Protect whole Deliveries: retention removes a Delivery if any of its
            # members' versions are removed, even when that member is unrelated.
            rows = connection.execute(
                "SELECT d.delivery_id, m.before_version_id, m.after_version_id "
                "FROM resources_deliveries d JOIN resources_delivery_members m USING(delivery_id) "
                "WHERE d.session_id = ? AND (d.turn_id = ? OR d.turn_id IN ("
                "SELECT turn_id FROM resources_turns WHERE session_id = ? AND vendor_turn_id = ?))",
                (session_id, turn_id, session_id, turn_id),
            )
            for row in rows:
                deliveries.add(row["delivery_id"])
                versions.update(
                    value for value in (row["before_version_id"], row["after_version_id"]) if value
                )
    return versions, deliveries


def identity(payload: Mapping[str, object], *, stored: bool = False) -> SnapshotIdentity:
    object_id = payload["object_id"]
    path = payload["path"]
    mode_bits = payload["mode_bits"]
    annotation_object_id = payload["annotation_object_id"]
    if (
        not (object_id is None or isinstance(object_id, str))
        or not isinstance(path, str)
        or not (mode_bits is None or type(mode_bits) is int)
        or not (annotation_object_id is None or isinstance(annotation_object_id, str))
    ):
        raise MigrationError(MigrationBlocker.EVIDENCE_INVALID)
    result = SnapshotIdentity(
        object_id=object_id,
        state=FileState(payload["file_state" if stored else "state"]),
        path=path,
        mode_bits=mode_bits,
        annotation_object_id=annotation_object_id,
    )
    if result.state is FileState.PRESENT and (
        result.object_id is None or type(result.mode_bits) is not int
    ):
        raise MigrationError(MigrationBlocker.EVIDENCE_INVALID)
    if result.state is FileState.TOMBSTONE and (
        result.object_id is not None or result.mode_bits is not None
    ):
        raise MigrationError(MigrationBlocker.EVIDENCE_INVALID)
    return result


def _member(
    connection: sqlite3.Connection, session_id: str, turn_id: str, path: str, side: str
) -> tuple[dict, TurnOutcome]:
    turns = connection.execute(
        "SELECT turn_id, terminal_outcome, finalization_manifest_json FROM resources_turns "
        "WHERE session_id = ? AND (turn_id = ? OR vendor_turn_id = ?)",
        (session_id, turn_id, turn_id),
    ).fetchall()
    if len(turns) != 1 or not turns[0]["terminal_outcome"]:
        raise MigrationError(MigrationBlocker.EVIDENCE_MISSING)
    outcome = TurnOutcome(turns[0]["terminal_outcome"])
    if outcome is TurnOutcome.UNKNOWN:
        raise MigrationError(MigrationBlocker.EVIDENCE_MISSING)
    if turns[0]["finalization_manifest_json"]:
        members = json.loads(turns[0]["finalization_manifest_json"])["members"]
    else:
        # Completed old turns discarded the transient manifest. Their immutable
        # Delivery members retain the exact before metadata and after Version.
        rows = connection.execute(
            "SELECT m.*, v.object_id, v.file_state, v.path, v.mode_bits, v.annotation_object_id "
            "FROM resources_deliveries d JOIN resources_delivery_members m USING(delivery_id) "
            "JOIN resources_versions v ON v.version_id = m.after_version_id "
            f"WHERE d.session_id = ? AND d.turn_id = ? AND {EVIDENCE_PATHS[side]} = ?",
            (session_id, turns[0]["turn_id"], path),
        ).fetchall()
        members = [
            {
                "attribution": row["attribution"],
                "baseline": {
                    "file_id": row["file_id"],
                    "object_id": row["before_object_id"],
                    "state": row["before_state"],
                    "path": row["before_path"],
                    "mode_bits": row["before_mode_bits"],
                    "annotation_object_id": row["before_annotation_object_id"],
                    "version_id": row["before_version_id"],
                    "revision": row["before_object_id"],
                },
                "snapshot": {
                    "object_id": row["object_id"],
                    "state": row["file_state"],
                    "path": row["path"],
                    "mode_bits": row["mode_bits"],
                    "annotation_object_id": row["annotation_object_id"],
                    "revision": row["object_id"],
                },
            }
            for row in rows
        ]
    found = [member for member in members if member[side]["path"] == path]
    if len(found) != 1:
        raise MigrationError(MigrationBlocker.EVIDENCE_MISSING)
    if found[0].get("attribution") != ChangeAttribution.AGENT.value:
        raise MigrationError(MigrationBlocker.EVIDENCE_INVALID)
    return found[0], outcome


def prove(connection: sqlite3.Connection, item: LegacyReview) -> MigrationProof:
    if read(connection, item.source_id, item.path) != item:
        raise MigrationError(MigrationBlocker.SOURCE_CHANGED)
    if not item.baseline_complete:
        raise MigrationError(MigrationBlocker.BASELINE_INCOMPLETE)
    existing = connection.execute(
        "SELECT file_id FROM resources_files WHERE current_path = ?", (item.path,)
    ).fetchone()
    if existing is not None:
        current = pending.read(connection, existing["file_id"])
        if current is not None and current.needs_review:
            raise MigrationError(MigrationBlocker.REVIEW_CONFLICT)
    try:
        first, _ = _member(connection, item.first_session, item.first_turn, item.path, "baseline")
        latest, outcome = _member(
            connection, item.latest_session, item.latest_turn, item.path, "snapshot"
        )
        base, candidate = identity(first["baseline"]), identity(latest["snapshot"])
        file_id = str(first["baseline"]["file_id"])
        if file_id != latest["baseline"]["file_id"]:
            raise MigrationError(MigrationBlocker.EVIDENCE_INVALID)
        expected_base = f"sha256:{item.before_sha}" if item.before_blob else None
        expected_candidate = (
            None if item.change_kind == LEGACY_DELETED else f"sha256:{item.after_sha}"
        )
        if (
            base.object_id != expected_base
            or candidate.object_id != expected_candidate
            or (base.state is FileState.TOMBSTONE) != (not item.before_blob)
            or (candidate.state is FileState.TOMBSTONE) != (item.change_kind == LEGACY_DELETED)
        ):
            raise MigrationError(MigrationBlocker.EVIDENCE_INVALID)
        head = connection.execute(
            "SELECT * FROM resources_heads WHERE file_id = ?", (file_id,)
        ).fetchone()
        if head is None or identity(head, stored=True) != candidate:
            raise MigrationError(MigrationBlocker.HEAD_CONFLICT)
        current = pending.read(connection, file_id)
        if current is not None and current.needs_review:
            raise MigrationError(MigrationBlocker.REVIEW_CONFLICT)
        base_version_id = first["baseline"]["version_id"]
        base_origin = first["baseline"].get("pending_origin")
        base_version = connection.execute(
            "SELECT * FROM resources_versions WHERE version_id = ?", (base_version_id,)
        ).fetchone()
        if base_version is not None and identity(base_version, stored=True) == base:
            base_origin = None
        elif base.state is FileState.PRESENT and base_origin is None:
            raise MigrationError(MigrationBlocker.EVIDENCE_MISSING)
        if base_version is None:
            base_version_id = None
        review = PendingReview(
            id=LEGACY_REVIEW_PREFIX + sha256(f"{item.source_id}\0{item.path}".encode()).hexdigest(),
            group_id=LEGACY_REVIEW_PREFIX + item.source_id,
            session_id=item.latest_session,
            first_turn_id=item.first_turn,
            turn_id=item.latest_turn,
            terminal_outcome=outcome,
            origin=PendingOrigin.AGENT,
            base=base,
            candidate=candidate,
            base_revision=first["baseline"]["revision"],
            candidate_revision=latest["snapshot"]["revision"],
            base_origin=PendingOrigin(base_origin) if base_origin else None,
            base_version_id=base_version_id,
            edited_by_user=False,
        )
        return MigrationProof(file_id, current.revision if current else None, review)
    except (KeyError, TypeError, ValueError) as exc:
        raise MigrationError(MigrationBlocker.EVIDENCE_INVALID) from exc


def receipt(
    connection: sqlite3.Connection,
    item: LegacyReview,
    proof: MigrationProof | None,
    blocker: str | None,
    now: int,
) -> None:
    connection.execute(
        "INSERT INTO resources_review_migrations "
        "(source_id, path, source_revision, source_digest, status, file_id, review_id, blocker, decision, updated_at_ms) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, path) DO UPDATE SET "
        "source_revision = excluded.source_revision, source_digest = excluded.source_digest, status = excluded.status, "
        "file_id = excluded.file_id, review_id = excluded.review_id, blocker = excluded.blocker, updated_at_ms = excluded.updated_at_ms",
        (
            item.source_id,
            item.path,
            item.revision,
            item.digest,
            MigrationStatus.BLOCKED.value if blocker else MigrationStatus.MIGRATED.value,
            proof.file_id if proof else None,
            proof.review.id if proof and not blocker else None,
            blocker,
            item.decision,
            now,
        ),
    )
