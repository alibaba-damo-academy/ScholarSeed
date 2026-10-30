"""Pending metadata within the resource ledger's existing SQLite transaction.

This module owns no connection or bytes. WorkingHead remains the current snapshot;
only review baselines/candidates need their own immutable CAS references.
"""

from __future__ import annotations

import sqlite3
from dataclasses import asdict

from service.platform.resources import (
    FileState,
    PendingOrigin,
    PendingReview,
    PendingSnapshot,
    SnapshotIdentity,
    TurnOutcome,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS resources_pending (
    file_id TEXT PRIMARY KEY REFERENCES resources_files(file_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    origin TEXT NOT NULL CHECK (origin IN ('user','agent','external','restore')),
    review_id TEXT UNIQUE,
    group_id TEXT,
    session_id TEXT,
    first_turn_id TEXT,
    turn_id TEXT,
    terminal_outcome TEXT CHECK (terminal_outcome IN ('completed','failed','interrupted')),
    review_origin TEXT CHECK (review_origin IN ('agent','external')),
    base_object_id TEXT REFERENCES resources_objects(object_id),
    base_state TEXT CHECK (base_state IN ('present','tombstone')),
    base_path TEXT,
    base_mode_bits INTEGER,
    base_annotation_object_id TEXT REFERENCES resources_objects(object_id),
    base_revision TEXT,
    base_origin TEXT CHECK (base_origin IN ('user','agent','external','restore')),
    base_version_id TEXT REFERENCES resources_versions(version_id),
    candidate_object_id TEXT REFERENCES resources_objects(object_id),
    candidate_state TEXT CHECK (candidate_state IN ('present','tombstone')),
    candidate_path TEXT,
    candidate_mode_bits INTEGER,
    candidate_annotation_object_id TEXT REFERENCES resources_objects(object_id),
    candidate_revision TEXT,
    edited_by_user INTEGER NOT NULL DEFAULT 0 CHECK (edited_by_user IN (0,1)),
    updated_at_ms INTEGER NOT NULL,
    CHECK (review_id IS NULL OR (
        origin = 'agent' AND group_id IS NOT NULL AND session_id IS NOT NULL
        AND first_turn_id IS NOT NULL AND turn_id IS NOT NULL AND terminal_outcome IS NOT NULL
        AND review_origin IS NOT NULL
        AND base_state IS NOT NULL AND base_path IS NOT NULL
        AND candidate_state IS NOT NULL AND candidate_path IS NOT NULL
    ))
)
"""

LEGACY_SCHEMA = """
CREATE TABLE resources_pending (
    file_id TEXT PRIMARY KEY REFERENCES resources_files(file_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    origin TEXT NOT NULL CHECK (origin IN ('user','agent','external','restore')),
    review_id TEXT UNIQUE,
    group_id TEXT,
    session_id TEXT,
    first_turn_id TEXT,
    turn_id TEXT,
    terminal_outcome TEXT CHECK (terminal_outcome IN ('completed','failed','interrupted')),
    base_object_id TEXT REFERENCES resources_objects(object_id),
    base_state TEXT CHECK (base_state IN ('present','tombstone')),
    base_path TEXT,
    base_mode_bits INTEGER,
    base_annotation_object_id TEXT REFERENCES resources_objects(object_id),
    base_revision TEXT,
    base_origin TEXT CHECK (base_origin IN ('user','agent','external','restore')),
    base_version_id TEXT REFERENCES resources_versions(version_id),
    candidate_object_id TEXT REFERENCES resources_objects(object_id),
    candidate_state TEXT CHECK (candidate_state IN ('present','tombstone')),
    candidate_path TEXT,
    candidate_mode_bits INTEGER,
    candidate_annotation_object_id TEXT REFERENCES resources_objects(object_id),
    candidate_revision TEXT,
    edited_by_user INTEGER NOT NULL DEFAULT 0 CHECK (edited_by_user IN (0,1)),
    updated_at_ms INTEGER NOT NULL,
    CHECK (review_id IS NULL OR (
        origin = 'agent' AND group_id IS NOT NULL AND session_id IS NOT NULL
        AND first_turn_id IS NOT NULL AND turn_id IS NOT NULL AND terminal_outcome IS NOT NULL
        AND base_state IS NOT NULL AND base_path IS NOT NULL
        AND candidate_state IS NOT NULL AND candidate_path IS NOT NULL
    ))
)
"""


def read(connection: sqlite3.Connection, file_id: str) -> PendingSnapshot | None:
    row = connection.execute(
        "SELECT * FROM resources_pending WHERE file_id = ?", (file_id,)
    ).fetchone()
    if row is None:
        return None
    return from_row(row)


def from_row(row: sqlite3.Row) -> PendingSnapshot | None:
    if row["origin"] is None:
        return None
    review = None
    if row["review_id"] is not None:
        review = PendingReview(
            id=row["review_id"],
            group_id=row["group_id"],
            session_id=row["session_id"],
            first_turn_id=row["first_turn_id"],
            turn_id=row["turn_id"],
            terminal_outcome=TurnOutcome(row["terminal_outcome"]),
            origin=PendingOrigin(row["review_origin"]),
            base=SnapshotIdentity(
                object_id=row["base_object_id"],
                state=FileState(row["base_state"]),
                path=row["base_path"],
                mode_bits=row["base_mode_bits"],
                annotation_object_id=row["base_annotation_object_id"],
            ),
            candidate=SnapshotIdentity(
                object_id=row["candidate_object_id"],
                state=FileState(row["candidate_state"]),
                path=row["candidate_path"],
                mode_bits=row["candidate_mode_bits"],
                annotation_object_id=row["candidate_annotation_object_id"],
            ),
            base_revision=row["base_revision"],
            candidate_revision=row["candidate_revision"],
            base_origin=PendingOrigin(row["base_origin"]) if row["base_origin"] else None,
            base_version_id=row["base_version_id"],
            edited_by_user=bool(row["edited_by_user"]),
        )
    return PendingSnapshot(
        file_id=row["file_id"],
        revision=int(row["revision"]),
        origin=PendingOrigin(row["origin"]),
        review=review,
    )


def sync_working(
    connection: sqlite3.Connection, file_id: str, origin: PendingOrigin, now: int
) -> None:
    """Record a product write, retaining unresolved Agent lineage until a decision."""

    current = read(connection, file_id)
    if current is not None and current.needs_review:
        connection.execute(
            """
            UPDATE resources_pending SET revision = revision + 1,
                edited_by_user = CASE WHEN ? = 'user' THEN 1 ELSE edited_by_user END,
                updated_at_ms = ? WHERE file_id = ?
            """,
            (origin.value, now, file_id),
        )
        return
    if current is not None and current.origin is PendingOrigin.EXTERNAL:
        origin = PendingOrigin.EXTERNAL
    saved = connection.execute(
        """
        SELECT 1 FROM resources_heads AS head
        JOIN resources_versions AS version ON version.file_id = head.file_id
        WHERE head.file_id = ?
          AND version.sequence = (SELECT MAX(sequence) FROM resources_versions WHERE file_id = ?)
          AND head.object_id IS version.object_id AND head.file_state IS version.file_state
          AND head.path IS version.path AND head.mode_bits IS version.mode_bits
          AND head.annotation_object_id IS version.annotation_object_id
        """,
        (file_id, file_id),
    ).fetchone()
    if saved is not None:
        connection.execute("DELETE FROM resources_pending WHERE file_id = ?", (file_id,))
        return
    connection.execute(
        """
        INSERT INTO resources_pending (file_id, revision, origin, updated_at_ms)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(file_id) DO UPDATE SET revision = revision + 1,
            origin = excluded.origin, updated_at_ms = excluded.updated_at_ms
        """,
        (file_id, origin.value, now),
    )


def capture(connection: sqlite3.Connection, file_id: str, review: PendingReview, now: int) -> None:
    """Publish review provenance in the caller's head-advance transaction.

    Later turns replace only the candidate and latest turn reference, never the
    first review identity/baseline or its pre-Agent pending origin.
    """

    values = {
        "file_id": file_id,
        "review_id": review.id,
        "group_id": review.group_id,
        "session_id": review.session_id,
        "first_turn_id": review.first_turn_id,
        "turn_id": review.turn_id,
        "terminal_outcome": review.terminal_outcome.value,
        "review_origin": review.origin.value,
        "base_revision": review.base_revision,
        "base_origin": review.base_origin.value if review.base_origin else None,
        "base_version_id": review.base_version_id,
        "candidate_revision": review.candidate_revision,
        "edited_by_user": review.edited_by_user,
        "now": now,
        **{f"base_{key}": value for key, value in asdict(review.base).items()},
        **{f"candidate_{key}": value for key, value in asdict(review.candidate).items()},
    }
    connection.execute(
        """
        INSERT INTO resources_pending (
            file_id, revision, origin, review_id, group_id, session_id, first_turn_id, turn_id,
            terminal_outcome, review_origin,
            base_object_id, base_state, base_path, base_mode_bits,
            base_annotation_object_id, base_revision, base_origin, base_version_id,
            candidate_object_id, candidate_state, candidate_path, candidate_mode_bits,
            candidate_annotation_object_id, candidate_revision, edited_by_user, updated_at_ms
        ) VALUES (
            :file_id, 1, 'agent', :review_id, :group_id, :session_id, :first_turn_id, :turn_id,
            :terminal_outcome, :review_origin,
            :base_object_id, :base_state, :base_path, :base_mode_bits,
            :base_annotation_object_id, :base_revision, :base_origin, :base_version_id,
            :candidate_object_id, :candidate_state, :candidate_path, :candidate_mode_bits,
            :candidate_annotation_object_id, :candidate_revision, :edited_by_user, :now
        )
        ON CONFLICT(file_id) DO UPDATE SET
            revision = revision + 1, origin = 'agent',
            review_id = COALESCE(resources_pending.review_id, excluded.review_id),
            group_id = CASE WHEN resources_pending.review_id IS NULL
                THEN excluded.group_id ELSE resources_pending.group_id END,
            first_turn_id = CASE WHEN resources_pending.review_id IS NULL
                THEN excluded.first_turn_id ELSE resources_pending.first_turn_id END,
            base_object_id = CASE WHEN resources_pending.review_id IS NULL
                THEN excluded.base_object_id ELSE resources_pending.base_object_id END,
            base_state = CASE WHEN resources_pending.review_id IS NULL
                THEN excluded.base_state ELSE resources_pending.base_state END,
            base_path = CASE WHEN resources_pending.review_id IS NULL
                THEN excluded.base_path ELSE resources_pending.base_path END,
            base_mode_bits = CASE WHEN resources_pending.review_id IS NULL
                THEN excluded.base_mode_bits ELSE resources_pending.base_mode_bits END,
            base_annotation_object_id = CASE WHEN resources_pending.review_id IS NULL
                THEN excluded.base_annotation_object_id ELSE resources_pending.base_annotation_object_id END,
            base_revision = CASE WHEN resources_pending.review_id IS NULL
                THEN excluded.base_revision ELSE resources_pending.base_revision END,
            base_origin = CASE WHEN resources_pending.review_id IS NULL
                THEN excluded.base_origin ELSE resources_pending.base_origin END,
            base_version_id = CASE WHEN resources_pending.review_id IS NULL
                THEN excluded.base_version_id ELSE resources_pending.base_version_id END,
            session_id = excluded.session_id, turn_id = excluded.turn_id,
            terminal_outcome = excluded.terminal_outcome,
            review_origin = excluded.review_origin,
            candidate_object_id = excluded.candidate_object_id,
            candidate_state = excluded.candidate_state,
            candidate_path = excluded.candidate_path,
            candidate_mode_bits = excluded.candidate_mode_bits,
            candidate_annotation_object_id = excluded.candidate_annotation_object_id,
            candidate_revision = excluded.candidate_revision,
            edited_by_user = resources_pending.edited_by_user OR excluded.edited_by_user,
            updated_at_ms = excluded.updated_at_ms
        """,
        values,
    )
