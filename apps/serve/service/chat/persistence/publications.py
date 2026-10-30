"""Project-owned immutable publications and their recoverable session projection outbox."""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import asdict, dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any

from service.persistence.project import transaction
from service.platform.content import ArtifactScope, ArtifactScopeKind, VerifiedArtifactContent

PUBLICATION_TABLE = "chat_artifact_publication"
DECLARATION_TABLE = "chat_artifact_declaration"
OUTBOX_TABLE = "chat_artifact_outbox"
ENCODING = "utf-8"
DECLARATION_CONFLICT = "artifact_declaration_conflict"


@dataclass(frozen=True)
class PublicationRecord:
    publication_id: str
    session_id: str
    turn_id: str
    title: str
    role: str
    content: VerifiedArtifactContent
    created_at: float


class PublicationConflictError(ValueError):
    """A stable declaration identity was reused for a different request."""


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class PublicationStore:
    """One project database; immutable revisions never use a path-latest identity."""

    def __init__(self, database: str | Path):
        self.database = Path(database)
        with transaction(self.database) as connection:
            connection.execute(f"""
                CREATE TABLE IF NOT EXISTS {PUBLICATION_TABLE} (
                    publication_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    turn_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
            """)
            connection.execute(f"""
                CREATE TABLE IF NOT EXISTS {DECLARATION_TABLE} (
                    session_id TEXT NOT NULL,
                    declaration_id TEXT NOT NULL,
                    publication_id TEXT NOT NULL REFERENCES {PUBLICATION_TABLE}(publication_id),
                    request TEXT NOT NULL,
                    provenance TEXT NOT NULL,
                    PRIMARY KEY(session_id, declaration_id)
                )
            """)
            connection.execute(f"""
                CREATE TABLE IF NOT EXISTS {OUTBOX_TABLE} (
                    publication_id TEXT PRIMARY KEY REFERENCES {PUBLICATION_TABLE}(publication_id),
                    acknowledged INTEGER NOT NULL DEFAULT 0
                )
            """)
            connection.execute(
                f"CREATE INDEX IF NOT EXISTS idx_{PUBLICATION_TABLE}_session "
                f"ON {PUBLICATION_TABLE}(session_id, created_at, publication_id)"
            )

    @staticmethod
    def _record(row: sqlite3.Row) -> PublicationRecord:
        content = json.loads(row["content"])
        scope = content.pop("scope")
        content["scope"] = ArtifactScope(ArtifactScopeKind(scope["kind"]), scope["id"])
        return PublicationRecord(
            publication_id=row["publication_id"],
            session_id=row["session_id"],
            turn_id=row["turn_id"],
            title=row["title"],
            role=row["role"],
            content=VerifiedArtifactContent(**content),
            created_at=row["created_at"],
        )

    @classmethod
    def _declaration(
        cls,
        connection: sqlite3.Connection,
        session_id: str,
        declaration_id: str,
        request: dict[str, str],
    ) -> PublicationRecord | None:
        row = connection.execute(
            f"SELECT p.*, d.request FROM {DECLARATION_TABLE} d "
            f"JOIN {PUBLICATION_TABLE} p ON p.publication_id = d.publication_id "
            "WHERE d.session_id = ? AND d.declaration_id = ?",
            (session_id, declaration_id),
        ).fetchone()
        if row is None:
            return None
        if row["request"] != _json(request):
            raise PublicationConflictError(DECLARATION_CONFLICT)
        return cls._record(row)

    def declaration(
        self, session_id: str, declaration_id: str, request: dict[str, str]
    ) -> PublicationRecord | None:
        with transaction(self.database) as connection:
            return self._declaration(connection, session_id, declaration_id, request)

    def publish(
        self,
        *,
        session_id: str,
        turn_id: str,
        declaration_id: str,
        request: dict[str, str],
        title: str,
        role: str,
        content: VerifiedArtifactContent,
        provenance: dict[str, Any],
    ) -> PublicationRecord:
        # Equivalent Bridge/directive declarations share a publication, while every
        # declaration retains its own request and source evidence.
        identity = _json((session_id, turn_id, content.source_path, content.sha256, role))
        publication_id = sha256(identity.encode(ENCODING)).hexdigest()
        with transaction(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = self._declaration(connection, session_id, declaration_id, request)
            if existing is not None:
                return existing
            connection.execute(
                f"INSERT OR IGNORE INTO {PUBLICATION_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    publication_id,
                    session_id,
                    turn_id,
                    title,
                    role,
                    _json(asdict(content)),
                    time.time(),
                ),
            )
            connection.execute(
                f"INSERT INTO {DECLARATION_TABLE} VALUES (?, ?, ?, ?, ?)",
                (session_id, declaration_id, publication_id, _json(request), _json(provenance)),
            )
            connection.execute(
                f"INSERT OR IGNORE INTO {OUTBOX_TABLE}(publication_id) VALUES (?)",
                (publication_id,),
            )
            row = connection.execute(
                f"SELECT * FROM {PUBLICATION_TABLE} WHERE publication_id = ?", (publication_id,)
            ).fetchone()
            return self._record(row)

    def list_session(
        self, session_id: str, *, pending_only: bool = False
    ) -> tuple[PublicationRecord, ...]:
        pending = "AND o.acknowledged = 0" if pending_only else ""
        with transaction(self.database) as connection:
            rows = connection.execute(
                f"SELECT p.* FROM {PUBLICATION_TABLE} p JOIN {OUTBOX_TABLE} o "
                "ON p.publication_id = o.publication_id "
                f"WHERE p.session_id = ? {pending} ORDER BY p.created_at, p.publication_id",
                (session_id,),
            ).fetchall()
            return tuple(self._record(row) for row in rows)

    def acknowledge(self, session_id: str, publication_id: str) -> None:
        """Call only after the session's atomic event/index transaction has committed."""

        with transaction(self.database) as connection:
            connection.execute(
                f"UPDATE {OUTBOX_TABLE} SET acknowledged = 1 WHERE publication_id = ? "
                f"AND publication_id IN (SELECT publication_id FROM {PUBLICATION_TABLE} "
                "WHERE session_id = ?)",
                (publication_id, session_id),
            )

    def snapshot_shared(self, session_id: str, digest: str) -> bool:
        with transaction(self.database) as connection:
            rows = connection.execute(
                f"SELECT content FROM {PUBLICATION_TABLE} WHERE session_id != ?", (session_id,)
            )
            return any(json.loads(row["content"])["sha256"] == digest for row in rows)

    def remove_session(self, session_id: str) -> None:
        with transaction(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                f"DELETE FROM {OUTBOX_TABLE} WHERE publication_id IN "
                f"(SELECT publication_id FROM {PUBLICATION_TABLE} WHERE session_id = ?)",
                (session_id,),
            )
            connection.execute(
                f"DELETE FROM {DECLARATION_TABLE} WHERE session_id = ?", (session_id,)
            )
            connection.execute(
                f"DELETE FROM {PUBLICATION_TABLE} WHERE session_id = ?", (session_id,)
            )
