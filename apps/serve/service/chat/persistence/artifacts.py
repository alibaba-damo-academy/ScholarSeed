"""Session-scoped artifact index sourced only from structured runtime events."""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import closing, contextmanager, nullcontext
from dataclasses import dataclass
from enum import Enum
from hashlib import sha256
from pathlib import Path
from typing import Any, Iterator

from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SQLITE_TIMEOUT_SECONDS,
    SessionBindingConflictError,
    SessionStateConflictError,
)
from service.chat.persistence.events import PRODUCT_EVENT_TABLE
from service.chat.persistence.utils import validate_transaction
from service.paths import SESSION_CATALOG_DB

SESSION_ARTIFACT_TABLE = "session_artifact"
SESSION_ARTIFACT_DRAFT_TABLE = "session_artifact_draft"
SESSION_ARTIFACT_SAVED_TO_COLUMN = "saved_to"
ARTIFACT_FOREIGN_KEY_MIGRATION_SUFFIX = "_foreign_key_migration"
PRODUCT_ARTIFACT_ID_ENCODING = "utf-8"
ARTIFACT_CHANGE_DELETE = "delete"
ARTIFACT_CHANGE_UPDATE = "update"


class ArtifactSource(str, Enum):
    """Structured sources accepted as product artifact evidence."""

    FILE_CHANGE = "fileChange"
    STRUCTURED_TOOL = "structured_tool"
    ARTIFACT_PUBLISH = "artifact.publish"
    ARTIFACT_DECLARATION = "artifact.declaration"


class ArtifactStatus(str, Enum):
    """Terminal artifact states visible to the product."""

    COMPLETED = "completed"
    PUBLISHED = "published"


@dataclass(frozen=True)
class SessionArtifactRecord:
    """One idempotently indexed session artifact occurrence."""

    artifact_id: str
    session_id: str
    runtime_id: str
    vendor_thread_id: str
    vendor_turn_id: str | None
    vendor_item_id: str | None
    source_kind: ArtifactSource
    source_product_seq: int
    original_path: str
    canonical_path: str
    role: str
    status: ArtifactStatus
    mime_type: str | None
    content_sha256: str | None
    size_bytes: int | None
    saved_to: str | None
    metadata: dict[str, Any]
    idempotency_key: str
    created_at: float


def product_artifact_id(session_id: str, canonical_path: str) -> str:
    """Return the stable product identity for one session-owned path."""

    identity = f"{session_id}\0{canonical_path}".encode(PRODUCT_ARTIFACT_ID_ENCODING)
    return sha256(identity).hexdigest()


def current_artifact_records(
    records: tuple[SessionArtifactRecord, ...],
) -> tuple[SessionArtifactRecord, ...]:
    """Keep publication occurrences and independently reduce mutable working paths."""

    current: dict[str, SessionArtifactRecord] = {}
    publications: dict[str, SessionArtifactRecord] = {}
    for record in records:
        if record.status is ArtifactStatus.PUBLISHED:
            publications[record.artifact_id] = record
            continue
        change = str(record.metadata.get("change") or ARTIFACT_CHANGE_UPDATE)
        if change == ARTIFACT_CHANGE_DELETE:
            current.pop(record.canonical_path, None)
        else:
            current[record.canonical_path] = record
    return tuple(
        sorted(
            (*current.values(), *publications.values()),
            key=lambda record: (record.source_product_seq, record.artifact_id),
        )
    )


def artifact_identity(record: SessionArtifactRecord) -> str:
    """Published occurrences are immutable identities; working files identify a path."""

    if record.status is ArtifactStatus.PUBLISHED:
        return str(record.metadata.get("publication_id") or record.artifact_id)
    return product_artifact_id(record.session_id, record.canonical_path)


class SessionArtifactStore:
    """Index artifacts without observing or diffing a shared workspace."""

    def __init__(self, database: Path | None = None) -> None:
        self._database = Path(database or SESSION_CATALOG_DB)
        self._database.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection, connection:
            self._create_table(connection)
            self._repair_foreign_keys(connection)
            connection.execute(f"""
                CREATE TABLE IF NOT EXISTS {SESSION_ARTIFACT_DRAFT_TABLE} (
                    artifact_id TEXT PRIMARY KEY,
                    content BLOB NOT NULL,
                    FOREIGN KEY(artifact_id) REFERENCES {SESSION_ARTIFACT_TABLE}(artifact_id)
                        ON DELETE CASCADE
                )
                """)
            columns = {
                str(row["name"])
                for row in connection.execute(
                    f"PRAGMA table_info({SESSION_ARTIFACT_TABLE})"
                ).fetchall()
            }
            if SESSION_ARTIFACT_SAVED_TO_COLUMN not in columns:
                connection.execute(
                    f"ALTER TABLE {SESSION_ARTIFACT_TABLE} "
                    f"ADD COLUMN {SESSION_ARTIFACT_SAVED_TO_COLUMN} TEXT"
                )
            connection.execute(
                f"CREATE INDEX IF NOT EXISTS idx_{SESSION_ARTIFACT_TABLE}_session "
                f"ON {SESSION_ARTIFACT_TABLE}(session_id, source_product_seq, artifact_id)"
            )
            connection.execute(
                f"CREATE INDEX IF NOT EXISTS idx_{SESSION_ARTIFACT_TABLE}_path "
                f"ON {SESSION_ARTIFACT_TABLE}(session_id, canonical_path)"
            )

    @classmethod
    def _create_table(cls, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
                CREATE TABLE IF NOT EXISTS {SESSION_ARTIFACT_TABLE} (
                    artifact_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    runtime_id TEXT NOT NULL,
                    vendor_thread_id TEXT NOT NULL,
                    vendor_turn_id TEXT,
                    vendor_item_id TEXT,
                    source_kind TEXT NOT NULL,
                    source_product_seq INTEGER NOT NULL,
                    original_path TEXT NOT NULL,
                    canonical_path TEXT NOT NULL,
                    role TEXT NOT NULL,
                    status TEXT NOT NULL,
                    mime_type TEXT,
                    content_sha256 TEXT,
                    size_bytes INTEGER,
                    saved_to TEXT,
                    metadata TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    UNIQUE(session_id, idempotency_key),
                    FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                        ON DELETE CASCADE,
                    FOREIGN KEY(session_id, source_product_seq)
                        REFERENCES {PRODUCT_EVENT_TABLE}(session_id, product_seq)
                        ON DELETE CASCADE
                )
                """)

    @staticmethod
    def _foreign_targets(connection: sqlite3.Connection, table: str) -> frozenset[str]:
        rows = connection.execute(f"PRAGMA foreign_key_list({table})").fetchall()
        return frozenset(str(row["table"]) for row in rows)

    @classmethod
    def _repair_foreign_keys(cls, connection: sqlite3.Connection) -> None:
        expected = frozenset((SESSION_CATALOG_TABLE, PRODUCT_EVENT_TABLE))
        if cls._foreign_targets(connection, SESSION_ARTIFACT_TABLE) == expected:
            return

        connection.commit()
        connection.execute("PRAGMA foreign_keys = OFF")
        migration = f"{SESSION_ARTIFACT_TABLE}{ARTIFACT_FOREIGN_KEY_MIGRATION_SUFFIX}"
        try:
            connection.execute(f"DROP TABLE IF EXISTS {migration}")
            connection.execute(f"ALTER TABLE {SESSION_ARTIFACT_TABLE} RENAME TO {migration}")
            cls._create_table(connection)
            columns = tuple(
                row["name"]
                for row in connection.execute(f"PRAGMA table_info({migration})").fetchall()
            )
            column_sql = ", ".join(columns)
            connection.execute(
                f"INSERT INTO {SESSION_ARTIFACT_TABLE} ({column_sql}) "
                f"SELECT {column_sql} FROM {migration}"
            )
            connection.execute(f"DROP TABLE {migration}")
        finally:
            connection.execute("PRAGMA foreign_keys = ON")

    @property
    def database(self) -> Path:
        return self._database

    def draft(self, artifact_id: str, *, connection=None) -> bytes | None:
        context = nullcontext(connection) if connection is not None else closing(self._connect())
        with context as current:
            row = current.execute(
                f"SELECT content FROM {SESSION_ARTIFACT_DRAFT_TABLE} WHERE artifact_id = ?",
                (artifact_id,),
            ).fetchone()
            return bytes(row["content"]) if row is not None else None

    def save_draft(self, artifact_id: str, content: bytes, *, connection) -> None:
        validate_transaction(connection, self._database)
        connection.execute(
            f"INSERT INTO {SESSION_ARTIFACT_DRAFT_TABLE} (artifact_id, content) VALUES (?, ?) "
            "ON CONFLICT(artifact_id) DO UPDATE SET content = excluded.content",
            (artifact_id, content),
        )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            str(self._database),
            check_same_thread=False,
            timeout=SQLITE_TIMEOUT_SECONDS,
        )
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            return connection
        except BaseException:
            connection.close()
            raise

    @staticmethod
    def _optional(row: sqlite3.Row, name: str) -> str | None:
        return str(row[name] or "").strip() or None

    @classmethod
    def _record(cls, row: sqlite3.Row) -> SessionArtifactRecord:
        try:
            decoded = json.loads(str(row["metadata"]))
        except (TypeError, ValueError):
            decoded = {}
        metadata = dict(decoded) if isinstance(decoded, dict) else {}
        return SessionArtifactRecord(
            artifact_id=str(row["artifact_id"]),
            session_id=str(row["session_id"]),
            runtime_id=str(row["runtime_id"]),
            vendor_thread_id=str(row["vendor_thread_id"]),
            vendor_turn_id=cls._optional(row, "vendor_turn_id"),
            vendor_item_id=cls._optional(row, "vendor_item_id"),
            source_kind=ArtifactSource(str(row["source_kind"])),
            source_product_seq=int(row["source_product_seq"]),
            original_path=str(row["original_path"]),
            canonical_path=str(row["canonical_path"]),
            role=str(row["role"]),
            status=ArtifactStatus(str(row["status"])),
            mime_type=cls._optional(row, "mime_type"),
            content_sha256=cls._optional(row, "content_sha256"),
            size_bytes=(int(row["size_bytes"]) if row["size_bytes"] is not None else None),
            saved_to=cls._optional(row, SESSION_ARTIFACT_SAVED_TO_COLUMN),
            metadata=metadata,
            idempotency_key=str(row["idempotency_key"]),
            created_at=float(row["created_at"]),
        )

    @staticmethod
    def _artifact_id(session_id: str, idempotency_key: str) -> str:
        identity = f"{session_id}\0{idempotency_key}".encode("utf-8")
        return sha256(identity).hexdigest()

    @staticmethod
    def _validate_terminal_source(
        source_kind: ArtifactSource,
        status: ArtifactStatus,
    ) -> None:
        if source_kind in {
            ArtifactSource.FILE_CHANGE,
            ArtifactSource.STRUCTURED_TOOL,
            ArtifactSource.ARTIFACT_DECLARATION,
        }:
            if status is not ArtifactStatus.COMPLETED:
                raise ValueError(f"{source_kind.value} artifacts require completed status")
        if (
            source_kind is ArtifactSource.ARTIFACT_PUBLISH
            and status is not ArtifactStatus.PUBLISHED
        ):
            raise ValueError("artifact.publish artifacts require published status")

    @staticmethod
    def _assert_idempotent(
        existing: SessionArtifactRecord,
        *,
        runtime_id: str,
        vendor_thread_id: str,
        vendor_turn_id: str | None,
        vendor_item_id: str | None,
        source_kind: ArtifactSource,
        source_product_seq: int,
        original_path: str,
        canonical_path: str,
        role: str,
        status: ArtifactStatus,
        mime_type: str | None,
        content_sha256: str | None,
        size_bytes: int | None,
        metadata: dict[str, Any],
    ) -> None:
        expected = (
            runtime_id,
            vendor_thread_id,
            (vendor_turn_id or "").strip() or None,
            (vendor_item_id or "").strip() or None,
            source_kind,
            source_product_seq,
            original_path,
            canonical_path,
            role,
            status,
            (mime_type or "").strip() or None,
            (content_sha256 or "").strip() or None,
            size_bytes,
            metadata,
        )
        actual = (
            existing.runtime_id,
            existing.vendor_thread_id,
            existing.vendor_turn_id,
            existing.vendor_item_id,
            existing.source_kind,
            existing.source_product_seq,
            existing.original_path,
            existing.canonical_path,
            existing.role,
            existing.status,
            existing.mime_type,
            existing.content_sha256,
            existing.size_bytes,
            existing.metadata,
        )
        if actual != expected:
            raise SessionStateConflictError(f"artifact key {existing.idempotency_key} was reused")

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def index(
        self,
        *,
        session_id: str,
        runtime_id: str,
        vendor_thread_id: str,
        vendor_turn_id: str | None,
        vendor_item_id: str | None,
        source_kind: ArtifactSource,
        source_product_seq: int,
        original_path: str,
        canonical_path: str,
        role: str,
        status: ArtifactStatus,
        mime_type: str | None,
        content_sha256: str | None,
        size_bytes: int | None,
        metadata: dict[str, Any],
        idempotency_key: str,
        saved_to: str | None = None,
        created_at: float | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> SessionArtifactRecord:
        """Index one terminal structured event and reject cross-session attribution."""

        source = ArtifactSource(source_kind)
        terminal_status = ArtifactStatus(status)
        self._validate_terminal_source(source, terminal_status)
        required = (
            session_id,
            runtime_id,
            vendor_thread_id,
            original_path,
            canonical_path,
            role,
            idempotency_key,
        )
        if any(not value.strip() for value in required):
            raise ValueError("artifact identity fields must not be empty")
        if not Path(canonical_path).is_absolute():
            raise ValueError("canonical artifact path must be absolute")
        if source_product_seq <= 0:
            raise ValueError("artifact source product sequence must be positive")
        if size_bytes is not None and size_bytes < 0:
            raise ValueError("artifact size must not be negative")
        timestamp = float(created_at if created_at is not None else time.time())
        artifact_id = self._artifact_id(session_id, idempotency_key)
        encoded = json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))
        if connection is not None:
            validate_transaction(connection, self._database)
        with (
            nullcontext(connection) if connection is not None else self._transaction()
        ) as connection:
            existing_row = connection.execute(
                f"""
                SELECT * FROM {SESSION_ARTIFACT_TABLE}
                WHERE session_id = ? AND idempotency_key = ?
                """,
                (session_id, idempotency_key),
            ).fetchone()
            if existing_row is not None:
                existing = self._record(existing_row)
                self._assert_idempotent(
                    existing,
                    runtime_id=runtime_id,
                    vendor_thread_id=vendor_thread_id,
                    vendor_turn_id=vendor_turn_id,
                    vendor_item_id=vendor_item_id,
                    source_kind=source,
                    source_product_seq=source_product_seq,
                    original_path=original_path,
                    canonical_path=canonical_path,
                    role=role,
                    status=terminal_status,
                    mime_type=mime_type,
                    content_sha256=content_sha256,
                    size_bytes=size_bytes,
                    metadata=metadata,
                )
                return existing
            binding = connection.execute(
                f"""
                SELECT runtime_id, vendor_thread_id FROM {SESSION_CATALOG_TABLE}
                WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
            if binding is None:
                raise SessionBindingConflictError(f"unknown product session {session_id}")
            actual_binding = (
                str(binding["runtime_id"]),
                str(binding["vendor_thread_id"] or ""),
            )
            expected_binding = (runtime_id, vendor_thread_id)
            if actual_binding != expected_binding:
                raise SessionBindingConflictError(
                    f"artifact runtime binding {expected_binding} does not match {actual_binding}"
                )
            event = connection.execute(
                f"""
                SELECT vendor_turn_id, vendor_item_id FROM {PRODUCT_EVENT_TABLE}
                WHERE session_id = ? AND product_seq = ?
                """,
                (session_id, source_product_seq),
            ).fetchone()
            if event is None:
                raise SessionStateConflictError("artifact source event does not exist")
            event_binding = (
                str(event["vendor_turn_id"] or "") or None,
                str(event["vendor_item_id"] or "") or None,
            )
            artifact_binding = (
                (vendor_turn_id or "").strip() or None,
                (vendor_item_id or "").strip() or None,
            )
            if event_binding != artifact_binding:
                raise SessionStateConflictError(
                    "artifact turn/item does not match its source product event"
                )
            connection.execute(
                f"""
                INSERT INTO {SESSION_ARTIFACT_TABLE} (
                    artifact_id, session_id, runtime_id, vendor_thread_id,
                    vendor_turn_id, vendor_item_id, source_kind, source_product_seq,
                    original_path, canonical_path, role, status, mime_type,
                    content_sha256, size_bytes, saved_to, metadata, idempotency_key, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    artifact_id,
                    session_id,
                    runtime_id,
                    vendor_thread_id,
                    artifact_binding[0],
                    artifact_binding[1],
                    source.value,
                    source_product_seq,
                    original_path,
                    canonical_path,
                    role,
                    terminal_status.value,
                    (mime_type or "").strip() or None,
                    (content_sha256 or "").strip() or None,
                    size_bytes,
                    (saved_to or "").strip() or None,
                    encoded,
                    idempotency_key,
                    timestamp,
                ),
            )
            row = connection.execute(
                f"SELECT * FROM {SESSION_ARTIFACT_TABLE} WHERE artifact_id = ?",
                (artifact_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("persisted artifact disappeared")
        return self._record(row)

    def by_key(self, session_id: str, idempotency_key: str) -> SessionArtifactRecord | None:
        connection = self._connect()
        try:
            row = connection.execute(
                f"SELECT * FROM {SESSION_ARTIFACT_TABLE} WHERE session_id = ? AND idempotency_key = ?",
                (session_id, idempotency_key),
            ).fetchone()
            return self._record(row) if row is not None else None
        finally:
            connection.close()

    def mark_saved(self, artifact_id: str, saved_to: str) -> SessionArtifactRecord:
        """Persist the resource-library destination for one indexed artifact occurrence."""

        destination = saved_to.strip()
        if not destination:
            raise ValueError("saved artifact destination must not be empty")
        with closing(self._connect()) as connection, connection:
            connection.execute(
                f"UPDATE {SESSION_ARTIFACT_TABLE} SET saved_to = ? WHERE artifact_id = ?",
                (destination, artifact_id),
            )
            row = connection.execute(
                f"SELECT * FROM {SESSION_ARTIFACT_TABLE} WHERE artifact_id = ?",
                (artifact_id,),
            ).fetchone()
        if row is None:
            raise ValueError("artifact does not exist")
        return self._record(row)

    def list_session(self, session_id: str) -> tuple[SessionArtifactRecord, ...]:
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {SESSION_ARTIFACT_TABLE}
                WHERE session_id = ? ORDER BY source_product_seq, artifact_id
                """,
                (session_id,),
            ).fetchall()
        return tuple(self._record(row) for row in rows)

    def get_by_key(self, session_id: str, idempotency_key: str) -> SessionArtifactRecord | None:
        """Read an immutable published artifact without resnapshotting current disk."""

        connection = self._connect()
        try:
            row = connection.execute(
                f"SELECT * FROM {SESSION_ARTIFACT_TABLE} WHERE session_id = ? AND idempotency_key = ?",
                (session_id, idempotency_key),
            ).fetchone()
        finally:
            connection.close()
        return self._record(row) if row is not None else None
