"""Persistent ownership claims for independently copied artifact snapshots."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from uuid import uuid4

from service.persistence.project import transaction
from service.platform.content import ArtifactScope

SNAPSHOT_CLAIMS_TABLE = "content_snapshot_claims"


class SnapshotClaimStatus(str, Enum):
    PREPARED = "prepared"
    COMPLETED = "completed"


@dataclass(frozen=True)
class SnapshotClaim:
    marker: str
    size: int
    status: SnapshotClaimStatus


def _initialize(connection) -> None:
    connection.execute(f"""
        CREATE TABLE IF NOT EXISTS {SNAPSHOT_CLAIMS_TABLE} (
            scope_kind TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            digest TEXT NOT NULL,
            marker TEXT NOT NULL,
            size INTEGER NOT NULL,
            status TEXT NOT NULL,
            PRIMARY KEY (scope_kind, scope_id, digest)
        )
        """)


def get(database: str | Path, scope: ArtifactScope, digest: str) -> SnapshotClaim | None:
    with transaction(database) as connection:
        _initialize(connection)
        row = connection.execute(
            f"""
            SELECT marker, size, status
            FROM {SNAPSHOT_CLAIMS_TABLE}
            WHERE scope_kind = ? AND scope_id = ? AND digest = ?
            """,
            (scope.kind.value, scope.id, digest),
        ).fetchone()
    if row is None:
        return None
    return SnapshotClaim(str(row["marker"]), int(row["size"]), SnapshotClaimStatus(row["status"]))


def prepare(database: str | Path, scope: ArtifactScope, digest: str, size: int) -> SnapshotClaim:
    with transaction(database, immediate=True) as connection:
        _initialize(connection)
        connection.execute(
            f"""
            INSERT OR IGNORE INTO {SNAPSHOT_CLAIMS_TABLE}
                (scope_kind, scope_id, digest, marker, size, status)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                scope.kind.value,
                scope.id,
                digest,
                uuid4().hex,
                size,
                SnapshotClaimStatus.PREPARED.value,
            ),
        )
        row = connection.execute(
            f"""
            SELECT marker, size, status
            FROM {SNAPSHOT_CLAIMS_TABLE}
            WHERE scope_kind = ? AND scope_id = ? AND digest = ?
            """,
            (scope.kind.value, scope.id, digest),
        ).fetchone()
    claim = SnapshotClaim(str(row["marker"]), int(row["size"]), SnapshotClaimStatus(row["status"]))
    if claim.size != size:
        raise ValueError("snapshot claim size mismatch")
    return claim


def complete(database: str | Path, scope: ArtifactScope, digest: str, marker: str) -> None:
    with transaction(database, immediate=True) as connection:
        _initialize(connection)
        cursor = connection.execute(
            f"""
            UPDATE {SNAPSHOT_CLAIMS_TABLE}
            SET status = ?
            WHERE scope_kind = ? AND scope_id = ? AND digest = ? AND marker = ?
            """,
            (
                SnapshotClaimStatus.COMPLETED.value,
                scope.kind.value,
                scope.id,
                digest,
                marker,
            ),
        )
        if cursor.rowcount != 1:
            raise ValueError("snapshot claim unavailable")


__all__ = [
    "SnapshotClaim",
    "SnapshotClaimStatus",
    "complete",
    "get",
    "prepare",
]
