"""Persistent projections and resumable progress for resource review batches."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from service.persistence.project import ProjectDatabasePath, connect, transaction
from service.platform.resources import (
    FileState,
    PendingOrigin,
    ReviewAction,
    ReviewBatch,
    ReviewBatchMember,
    ReviewBatchState,
    ReviewMemberState,
    SnapshotIdentity,
)

SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS resources_review_batches (
        batch_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        group_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('open','applying','completed','failed')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS resources_review_batch_members (
        batch_id TEXT NOT NULL REFERENCES resources_review_batches(batch_id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES resources_files(file_id) ON DELETE CASCADE,
        review_id TEXT NOT NULL,
        path TEXT NOT NULL,
        pending_revision INTEGER NOT NULL CHECK (pending_revision >= 1),
        origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent','external')),
        state TEXT NOT NULL CHECK (state IN ('pending','applying','completed','failed')),
        action TEXT CHECK (action IN ('accept','reject','revise')),
        base_object_id TEXT REFERENCES resources_objects(object_id),
        base_state TEXT NOT NULL CHECK (base_state IN ('present','tombstone')),
        base_path TEXT NOT NULL,
        base_mode_bits INTEGER,
        base_annotation_object_id TEXT REFERENCES resources_objects(object_id),
        base_revision TEXT,
        candidate_object_id TEXT REFERENCES resources_objects(object_id),
        candidate_state TEXT NOT NULL CHECK (candidate_state IN ('present','tombstone')),
        candidate_path TEXT NOT NULL,
        candidate_mode_bits INTEGER,
        candidate_annotation_object_id TEXT REFERENCES resources_objects(object_id),
        candidate_revision TEXT,
        result_version_id TEXT REFERENCES resources_versions(version_id),
        error TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(batch_id, file_id),
        UNIQUE(batch_id, review_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS resources_review_batches_state ON resources_review_batches(state, batch_id)",
    """
    CREATE TABLE IF NOT EXISTS resources_review_batch_requests (
        idempotency_key TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES resources_review_batches(batch_id) ON DELETE CASCADE,
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('applying','completed')),
        result_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
    )
    """,
)


class ReviewBatchStoreConflict(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def capture(
    connection: sqlite3.Connection,
    session_id: str,
    turn_id: str,
    group_id: str,
    review_ids: tuple[str, ...],
    now: int,
) -> str | None:
    """Create or advance one batch from already-published pending rows."""

    if not review_ids:
        return None
    row = connection.execute(
        "SELECT batch_id FROM resources_review_batches WHERE group_id = ?", (group_id,)
    ).fetchone()
    batch_id = str(row["batch_id"]) if row is not None else uuid4().hex
    connection.execute(
        """
        INSERT INTO resources_review_batches (
            batch_id, session_id, turn_id, group_id, state, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 'open', ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET session_id = excluded.session_id,
            turn_id = excluded.turn_id, state = 'open', updated_at_ms = excluded.updated_at_ms
        """,
        (batch_id, session_id, turn_id, group_id, now, now),
    )
    placeholders = ",".join("?" for _ in review_ids)
    rows = connection.execute(
        f"SELECT pending.*, files.current_path FROM resources_pending AS pending "
        f"JOIN resources_files AS files USING(file_id) WHERE review_id IN ({placeholders})",
        review_ids,
    ).fetchall()
    if len(rows) != len(review_ids):
        raise ReviewBatchStoreConflict("review_not_found")
    for member in rows:
        connection.execute(
            """
            INSERT INTO resources_review_batch_members (
                batch_id, file_id, review_id, path, pending_revision, origin, state, action,
                base_object_id, base_state, base_path, base_mode_bits,
                base_annotation_object_id, base_revision, candidate_object_id,
                candidate_state, candidate_path, candidate_mode_bits,
                candidate_annotation_object_id, candidate_revision,
                result_version_id, error, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
            ON CONFLICT(batch_id, file_id) DO UPDATE SET
                review_id = excluded.review_id, path = excluded.path,
                pending_revision = excluded.pending_revision, origin = excluded.origin,
                state = 'pending', action = NULL,
                candidate_object_id = excluded.candidate_object_id,
                candidate_state = excluded.candidate_state,
                candidate_path = excluded.candidate_path,
                candidate_mode_bits = excluded.candidate_mode_bits,
                candidate_annotation_object_id = excluded.candidate_annotation_object_id,
                candidate_revision = excluded.candidate_revision,
                result_version_id = NULL, error = NULL, updated_at_ms = excluded.updated_at_ms
            """,
            (
                batch_id,
                member["file_id"],
                member["review_id"],
                member["current_path"],
                member["revision"],
                member["review_origin"],
                member["base_object_id"],
                member["base_state"],
                member["base_path"],
                member["base_mode_bits"],
                member["base_annotation_object_id"],
                member["base_revision"],
                member["candidate_object_id"],
                member["candidate_state"],
                member["candidate_path"],
                member["candidate_mode_bits"],
                member["candidate_annotation_object_id"],
                member["candidate_revision"],
                now,
            ),
        )
    return batch_id


def read(connection: sqlite3.Connection, batch_id: str) -> ReviewBatch | None:
    row = connection.execute(
        "SELECT * FROM resources_review_batches WHERE batch_id = ?", (batch_id,)
    ).fetchone()
    if row is None:
        return None
    members = _members(connection, batch_id)
    return _batch(row, members)


def _required(connection: sqlite3.Connection, batch_id: str) -> ReviewBatch:
    batch = read(connection, batch_id)
    if batch is None:
        raise ReviewBatchStoreConflict("review_batch_not_found")
    return batch


def _members(connection: sqlite3.Connection, batch_id: str) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT member.*,
               pending.revision AS current_pending_revision,
               pending.edited_by_user AS current_edited_by_user
        FROM resources_review_batch_members AS member
        LEFT JOIN resources_pending AS pending
          ON pending.file_id = member.file_id AND pending.review_id = member.review_id
        WHERE member.batch_id = ? ORDER BY member.file_id
        """,
        (batch_id,),
    ).fetchall()


def _batch(row: sqlite3.Row, members: list[sqlite3.Row]) -> ReviewBatch:
    return ReviewBatch(
        id=str(row["batch_id"]),
        session_id=str(row["session_id"]),
        turn_id=str(row["turn_id"]),
        group_id=str(row["group_id"]),
        state=ReviewBatchState(str(row["state"])),
        created_at_ms=int(row["created_at_ms"]),
        updated_at_ms=int(row["updated_at_ms"]),
        members=tuple(_member(member) for member in members),
    )


def _identity(row: sqlite3.Row, prefix: str) -> SnapshotIdentity:
    return SnapshotIdentity(
        object_id=row[f"{prefix}_object_id"],
        state=FileState(str(row[f"{prefix}_state"])),
        path=str(row[f"{prefix}_path"]),
        mode_bits=row[f"{prefix}_mode_bits"],
        annotation_object_id=row[f"{prefix}_annotation_object_id"],
    )


def _member(row: sqlite3.Row) -> ReviewBatchMember:
    return ReviewBatchMember(
        file_id=str(row["file_id"]),
        review_id=str(row["review_id"]),
        path=str(row["path"]),
        pending_revision=int(
            row["current_pending_revision"]
            if row["current_pending_revision"] is not None
            else row["pending_revision"]
        ),
        state=ReviewMemberState(str(row["state"])),
        origin=PendingOrigin(str(row["origin"])),
        base=_identity(row, "base"),
        candidate=_identity(row, "candidate"),
        base_revision=str(row["base_revision"]) if row["base_revision"] is not None else None,
        candidate_revision=(
            str(row["candidate_revision"]) if row["candidate_revision"] is not None else None
        ),
        edited_by_user=bool(row["current_edited_by_user"] or 0),
        action=ReviewAction(str(row["action"])) if row["action"] is not None else None,
        result_version_id=(
            str(row["result_version_id"]) if row["result_version_id"] is not None else None
        ),
        error=str(row["error"]) if row["error"] is not None else None,
    )


class ReviewBatchStore:
    def __init__(
        self, database: ProjectDatabasePath | Path | str, project_root: Path | str
    ) -> None:
        self._database = ProjectDatabasePath(Path(database), Path(project_root))

    def batch(self, batch_id: str) -> ReviewBatch | None:
        if not self._database.exists():
            return None
        with closing(connect(self._database)) as connection:
            return _required(connection, batch_id)

    def reconcile_completed(self, batch_id: str, now: int) -> ReviewBatch:
        """Repair only the batch projection; completed members never replay file writes."""

        with transaction(self._database, immediate=True) as connection:
            current = read(connection, batch_id)
            if current is None:
                raise ReviewBatchStoreConflict("review_batch_not_found")
            if (
                current.state is not ReviewBatchState.COMPLETED
                and current.members
                and all(member.state is ReviewMemberState.COMPLETED for member in current.members)
            ):
                connection.execute(
                    "UPDATE resources_review_batches SET state = ?, updated_at_ms = ? WHERE batch_id = ?",
                    (ReviewBatchState.COMPLETED.value, now, batch_id),
                )
                return _required(connection, batch_id)
            return current

    def batches(
        self, state: ReviewBatchState | None, after_batch_id: str, limit: int
    ) -> tuple[ReviewBatch, ...]:
        if not self._database.exists():
            return ()
        clauses = ["batch_id > ?"]
        values: list[object] = [after_batch_id]
        if state is not None:
            clauses.append("state = ?")
            values.append(state.value)
        values.append(limit)
        with closing(connect(self._database)) as connection:
            rows = connection.execute(
                "SELECT * FROM resources_review_batches WHERE "
                + " AND ".join(clauses)
                + " ORDER BY batch_id LIMIT ?",
                values,
            ).fetchall()
            return tuple(
                _batch(
                    row,
                    _members(connection, str(row["batch_id"])),
                )
                for row in rows
            )

    def open_batches(self, limit: int) -> tuple[ReviewBatch, ...]:
        return (
            self.batches(ReviewBatchState.OPEN, "", limit)
            + self.batches(ReviewBatchState.APPLYING, "", limit)
            + self.batches(ReviewBatchState.FAILED, "", limit)
        )

    def prepare(self, batch_id: str, decisions: tuple, now: int) -> ReviewBatch:
        with transaction(self._database, immediate=True) as connection:
            current = read(connection, batch_id)
            if current is None:
                raise ReviewBatchStoreConflict("review_batch_not_found")
            indexed = {member.file_id: member for member in current.members}
            if not decisions or not {decision.file_id for decision in decisions}.issubset(indexed):
                raise ReviewBatchStoreConflict("review_batch_members_mismatch")
            for decision in decisions:
                member = indexed[decision.file_id]
                if (
                    member.review_id != decision.review_id
                    or member.pending_revision != decision.pending_revision
                ):
                    raise ReviewBatchStoreConflict("review_batch_member_conflict")
                if (
                    member.action is not None
                    and member.action is not decision.action
                    and member.state is not ReviewMemberState.FAILED
                ):
                    raise ReviewBatchStoreConflict("review_batch_decision_conflict")
                if member.state is not ReviewMemberState.COMPLETED:
                    connection.execute(
                        "UPDATE resources_review_batch_members SET action = ?, pending_revision = ?, state = 'applying', error = NULL, updated_at_ms = ? WHERE batch_id = ? AND file_id = ?",
                        (
                            decision.action.value,
                            decision.pending_revision,
                            now,
                            batch_id,
                            decision.file_id,
                        ),
                    )
            state = (
                ReviewBatchState.COMPLETED
                if all(member.state is ReviewMemberState.COMPLETED for member in current.members)
                else ReviewBatchState.APPLYING
            )
            connection.execute(
                "UPDATE resources_review_batches SET state = ?, updated_at_ms = ? WHERE batch_id = ?",
                (state.value, now, batch_id),
            )
            return _required(connection, batch_id)

    def begin_request(
        self, batch_id: str, idempotency_key: str, request_digest: str, now: int
    ) -> dict | None:
        with transaction(self._database, immediate=True) as connection:
            row = connection.execute(
                "SELECT * FROM resources_review_batch_requests WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            if row is not None:
                if row["batch_id"] != batch_id or row["request_digest"] != request_digest:
                    raise ReviewBatchStoreConflict("idempotency_conflict")
                return (
                    json.loads(str(row["result_json"]))
                    if row["state"] == "completed" and row["result_json"] is not None
                    else None
                )
            connection.execute(
                """
                INSERT INTO resources_review_batch_requests (
                    idempotency_key, batch_id, request_digest, state,
                    result_json, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, 'applying', NULL, ?, ?)
                """,
                (idempotency_key, batch_id, request_digest, now, now),
            )
            return None

    def complete_request(
        self, idempotency_key: str, request_digest: str, result: dict, now: int
    ) -> None:
        with transaction(self._database, immediate=True) as connection:
            cursor = connection.execute(
                """
                UPDATE resources_review_batch_requests
                SET state = 'completed', result_json = ?, updated_at_ms = ?
                WHERE idempotency_key = ? AND request_digest = ?
                """,
                (
                    json.dumps(result, separators=(",", ":"), sort_keys=True),
                    now,
                    idempotency_key,
                    request_digest,
                ),
            )
            if cursor.rowcount != 1:
                raise ReviewBatchStoreConflict("idempotency_conflict")

    def finish_member(
        self,
        batch_id: str,
        file_id: str,
        state: ReviewMemberState,
        now: int,
        *,
        version_id: str | None = None,
        error: str | None = None,
    ) -> ReviewBatch:
        with transaction(self._database, immediate=True) as connection:
            connection.execute(
                "UPDATE resources_review_batch_members SET state = ?, result_version_id = ?, error = ?, updated_at_ms = ? WHERE batch_id = ? AND file_id = ?",
                (state.value, version_id, error, now, batch_id, file_id),
            )
            remaining = connection.execute(
                "SELECT state FROM resources_review_batch_members WHERE batch_id = ?",
                (batch_id,),
            ).fetchall()
            batch_state = (
                ReviewBatchState.COMPLETED
                if all(str(row["state"]) == ReviewMemberState.COMPLETED.value for row in remaining)
                else (
                    ReviewBatchState.FAILED
                    if any(str(row["state"]) == ReviewMemberState.FAILED.value for row in remaining)
                    else ReviewBatchState.OPEN
                )
            )
            connection.execute(
                "UPDATE resources_review_batches SET state = ?, updated_at_ms = ? WHERE batch_id = ?",
                (batch_state.value, now, batch_id),
            )
            return _required(connection, batch_id)

    def close_resolved(self, batch_id: str, now: int) -> ReviewBatch:
        """Reconcile members whose existing primitive committed before progress writeback."""

        with transaction(self._database, immediate=True) as connection:
            connection.execute(
                """
                UPDATE resources_review_batch_members AS member
                SET state = 'completed', error = NULL, updated_at_ms = ?
                WHERE batch_id = ? AND state != 'completed' AND action IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM resources_pending AS pending
                    WHERE pending.file_id = member.file_id
                      AND pending.review_id = member.review_id
                  )
                """,
                (now, batch_id),
            )
            rows = connection.execute(
                "SELECT state FROM resources_review_batch_members WHERE batch_id = ?",
                (batch_id,),
            ).fetchall()
            state = (
                ReviewBatchState.COMPLETED
                if rows
                and all(str(row["state"]) == ReviewMemberState.COMPLETED.value for row in rows)
                else ReviewBatchState.FAILED
            )
            connection.execute(
                "UPDATE resources_review_batches SET state = ?, updated_at_ms = ? WHERE batch_id = ?",
                (state.value, now, batch_id),
            )
            return _required(connection, batch_id)


__all__ = [
    "ReviewBatchStore",
    "ReviewBatchStoreConflict",
    "SCHEMA",
    "capture",
    "read",
]
