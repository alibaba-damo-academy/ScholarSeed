"""Project-owned artifact/library intents and their durable projection outbox."""

from __future__ import annotations

import json
import math
import sqlite3
import time
from dataclasses import dataclass, replace
from enum import Enum
from hashlib import sha256
from pathlib import Path

from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import transaction
from service.platform.content import ContentPort

LINK_TABLE = "assistant_artifact_links"
LINK_CONFLICT = "artifact_library_link_conflict"
LINK_INVALID = "artifact_library_link_invalid"
SHA256_HEX_LENGTH = sha256().digest_size * 2
HEX_CHARACTERS = frozenset("0123456789abcdef")


class LibraryDestination(str, Enum):
    RESOURCES = "resources"
    LITERATURE = "literature"


class LinkState(str, Enum):
    PENDING = "pending"
    COMPLETED = "completed"


class ArtifactLinkError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ArtifactLinkRecord:
    link_id: str
    project_id: str
    session_id: str
    artifact_id: str
    source_sha256: str
    destination: LibraryDestination
    operation_id: str
    fingerprint: str
    state: LinkState
    target_ids: tuple[str, ...]
    created_at: float
    projected: bool


class ArtifactLinkCatalog:
    """Own the product relationship, not the destination owner's file operation."""

    def __init__(self, content: ContentPort) -> None:
        self._content = content

    @staticmethod
    def _link_id(
        project_id: str,
        session_id: str,
        destination: LibraryDestination,
        operation_id: str,
    ) -> str:
        identity = json.dumps(
            [project_id, session_id, destination.value, operation_id],
            separators=(",", ":"),
        )
        return sha256(identity.encode("utf-8")).hexdigest()

    @staticmethod
    def _legacy_link_id(
        session_id: str,
        destination: LibraryDestination,
        operation_id: str,
    ) -> str:
        identity = json.dumps([session_id, destination.value, operation_id], separators=(",", ":"))
        return sha256(identity.encode("utf-8")).hexdigest()

    @staticmethod
    def _schema(connection: sqlite3.Connection) -> None:
        connection.execute(f"""CREATE TABLE IF NOT EXISTS {LINK_TABLE} (
            link_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
            session_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
            source_sha256 TEXT NOT NULL, destination TEXT NOT NULL,
            operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
            state TEXT NOT NULL, target_ids TEXT NOT NULL,
            created_at REAL NOT NULL, projected INTEGER NOT NULL,
            UNIQUE(session_id, destination, operation_id)
        )""")

    @staticmethod
    def _record(row: sqlite3.Row) -> ArtifactLinkRecord:
        try:
            identifiers = (
                "link_id",
                "project_id",
                "session_id",
                "artifact_id",
                "operation_id",
                "fingerprint",
                "source_sha256",
            )
            if any(
                not isinstance(row[key], str) or not row[key] or "\x00" in row[key]
                for key in identifiers
            ):
                raise ArtifactLinkError(LINK_INVALID)
            if any(
                len(row[key]) != SHA256_HEX_LENGTH or not set(row[key]) <= HEX_CHARACTERS
                for key in ("link_id", "fingerprint", "source_sha256")
            ):
                raise ArtifactLinkError(LINK_INVALID)
            if type(row["projected"]) is not int or row["projected"] not in (0, 1):
                raise ArtifactLinkError(LINK_INVALID)
            if (
                type(row["created_at"]) not in (int, float)
                or not math.isfinite(row["created_at"])
                or row["created_at"] < 0
            ):
                raise ArtifactLinkError(LINK_INVALID)
            targets = json.loads(row["target_ids"])
            if not isinstance(targets, list) or any(
                not isinstance(value, str) or not value for value in targets
            ):
                raise ArtifactLinkError(LINK_INVALID)
            if len(targets) != len(set(targets)):
                raise ArtifactLinkError(LINK_INVALID)
            state = LinkState(row["state"])
            if (state is LinkState.COMPLETED) != bool(targets) or (
                state is LinkState.PENDING and row["projected"]
            ):
                raise ArtifactLinkError(LINK_INVALID)
            return ArtifactLinkRecord(
                row["link_id"],
                row["project_id"],
                row["session_id"],
                row["artifact_id"],
                row["source_sha256"],
                LibraryDestination(row["destination"]),
                row["operation_id"],
                row["fingerprint"],
                state,
                tuple(targets),
                row["created_at"],
                bool(row["projected"]),
            )
        except (ValueError, TypeError) as error:
            raise ArtifactLinkError(LINK_INVALID) from error

    def reserve(
        self,
        project_id: str,
        session_id: str,
        artifact_id: str,
        source_sha256: str,
        destination: LibraryDestination,
        operation_id: str,
        fingerprint: str,
    ) -> ArtifactLinkRecord:
        if not all((project_id, session_id, artifact_id, source_sha256, operation_id, fingerprint)):
            raise ArtifactLinkError(LINK_INVALID)
        link_id = self._link_id(project_id, session_id, destination, operation_id)
        legacy_link_id = self._legacy_link_id(session_id, destination, operation_id)
        database = self._content.resolve(project_id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._schema(connection)
            row = None
            for candidate in (link_id, legacy_link_id):
                row = connection.execute(
                    f"SELECT * FROM {LINK_TABLE} WHERE link_id = ?", (candidate,)
                ).fetchone()
                if row is not None:
                    break
            if row is not None:
                record = self._record(row)
                if (
                    record.project_id != project_id
                    or record.session_id != session_id
                    or record.artifact_id != artifact_id
                    or record.source_sha256 != source_sha256
                    or record.destination is not destination
                    or record.operation_id != operation_id
                    or record.fingerprint != fingerprint
                ):
                    raise ArtifactLinkError(LINK_CONFLICT)
                return record
            connection.execute(
                f"INSERT INTO {LINK_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    link_id,
                    project_id,
                    session_id,
                    artifact_id,
                    source_sha256,
                    destination.value,
                    operation_id,
                    fingerprint,
                    LinkState.PENDING.value,
                    "[]",
                    time.time(),
                    0,
                ),
            )
            return self._record(
                connection.execute(
                    f"SELECT * FROM {LINK_TABLE} WHERE link_id = ?", (link_id,)
                ).fetchone()
            )

    def complete(
        self, record: ArtifactLinkRecord, target_ids: tuple[str, ...]
    ) -> ArtifactLinkRecord:
        if not target_ids or any(not isinstance(value, str) or not value for value in target_ids):
            raise ArtifactLinkError(LINK_INVALID)
        if len(target_ids) != len(set(target_ids)):
            raise ArtifactLinkError(LINK_INVALID)
        database = self._content.resolve(record.project_id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                f"SELECT * FROM {LINK_TABLE} WHERE link_id = ?", (record.link_id,)
            ).fetchone()
            if row is None:
                raise ArtifactLinkError(LINK_CONFLICT)
            current = self._record(row)
            if (
                current.project_id != record.project_id
                or current.session_id != record.session_id
                or current.artifact_id != record.artifact_id
                or current.source_sha256 != record.source_sha256
                or current.destination is not record.destination
                or current.operation_id != record.operation_id
                or current.fingerprint != record.fingerprint
                or (current.state is LinkState.COMPLETED and current.target_ids != target_ids)
            ):
                raise ArtifactLinkError(LINK_CONFLICT)
            if current.state is LinkState.PENDING:
                # Completion and pending projection are one project transaction.
                connection.execute(
                    f"UPDATE {LINK_TABLE} SET state = ?, target_ids = ?, projected = 0 WHERE link_id = ?",
                    (LinkState.COMPLETED.value, json.dumps(target_ids), record.link_id),
                )
            return self._record(
                connection.execute(
                    f"SELECT * FROM {LINK_TABLE} WHERE link_id = ?", (record.link_id,)
                ).fetchone()
            )

    def acknowledge(self, record: ArtifactLinkRecord) -> None:
        """Acknowledge only the exact completed fact committed to the event log."""
        if record.state is not LinkState.COMPLETED:
            raise ArtifactLinkError(LINK_CONFLICT)
        database = self._content.resolve(record.project_id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                f"SELECT * FROM {LINK_TABLE} WHERE link_id = ?", (record.link_id,)
            ).fetchone()
            if row is None:
                raise ArtifactLinkError(LINK_CONFLICT)
            current = self._record(row)
            if replace(current, projected=False) != replace(record, projected=False):
                raise ArtifactLinkError(LINK_CONFLICT)
            connection.execute(
                f"UPDATE {LINK_TABLE} SET projected = 1 WHERE link_id = ?", (record.link_id,)
            )

    def list_session(self, project_id: str, session_id: str) -> tuple[ArtifactLinkRecord, ...]:
        database = self._content.resolve(project_id, PROJECT_DB_RELATIVE)
        if not Path(database).is_file():
            return ()
        with transaction(database) as connection:
            if (
                connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                    (LINK_TABLE,),
                ).fetchone()
                is None
            ):
                return ()
            rows = connection.execute(
                f"SELECT * FROM {LINK_TABLE} WHERE project_id = ? AND session_id = ? ORDER BY created_at, link_id",
                (project_id, session_id),
            ).fetchall()
            return tuple(self._record(row) for row in rows)
