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
from service.chat.persistence.events import PRODUCT_EVENT_TABLE, ProductEventStore
from service.chat.persistence.utils import validate_transaction
from service.paths import SESSION_CATALOG_DB
from service.persistence.project import (
    database_files,
    open_database,
    reader,
    rebuild_table,
    reject_schema_residue,
    schema_transaction,
    sql_tokens,
    table_clauses,
)

SESSION_ARTIFACT_SOURCE_TABLE = "session_artifact_source"
SESSION_ARTIFACT_TABLE = "session_artifact"
SESSION_ARTIFACT_DRAFT_TABLE = "session_artifact_draft"
SESSION_ARTIFACT_SAVED_TO_COLUMN = "saved_to"
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


@dataclass(frozen=True)
class ArtifactSchema:
    """Artifact-owned initialization requirements, not whole-database admission."""

    create_tables: tuple[str, ...]
    add_saved_to: bool
    rebuild_tables: tuple[str, ...]
    create_indexes: tuple[str, ...]

    @property
    def needs_write(self) -> bool:
        return bool(
            self.create_tables or self.add_saved_to or self.rebuild_tables or self.create_indexes
        )


_LEGACY_FOREIGN_TARGETS = {
    SESSION_ARTIFACT_SOURCE_TABLE: {},
    SESSION_ARTIFACT_TABLE: {
        SESSION_CATALOG_TABLE + "_migration": SESSION_CATALOG_TABLE,
        PRODUCT_EVENT_TABLE: SESSION_ARTIFACT_SOURCE_TABLE,
        PRODUCT_EVENT_TABLE + "_migration": SESSION_ARTIFACT_SOURCE_TABLE,
    },
    SESSION_ARTIFACT_DRAFT_TABLE: {
        SESSION_ARTIFACT_TABLE + "_foreign_key_migration": SESSION_ARTIFACT_TABLE,
    },
}


class SessionArtifactStore:
    """Index artifacts without observing or diffing a shared workspace."""

    def __init__(self, database: Path | None = None) -> None:
        self._database = Path(database or SESSION_CATALOG_DB)
        if not self.inspect_schema(self._database).needs_write:
            return
        self._database.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection, schema_transaction(connection):
            self.initialize_schema(connection)

    @classmethod
    def initialize_schema(cls, connection: sqlite3.Connection) -> None:
        """Apply owned startup migrations inside the caller's transaction.

        Uses the same code for qualified startup and isolated compatibility
        projection; this method neither opens files nor grants write access.
        """
        schema = cls.inspect_connection(connection)
        if schema.needs_write:
            cls._create_source_table(connection)
            if SESSION_ARTIFACT_TABLE in schema.rebuild_tables:
                cls._backfill_sources(connection)
            cls._create_table(connection)
            cls._create_draft_table(connection)
            if schema.add_saved_to:
                connection.execute(
                    f"ALTER TABLE {SESSION_ARTIFACT_TABLE} ADD COLUMN {SESSION_ARTIFACT_SAVED_TO_COLUMN} TEXT"
                )
            for table, create in (
                (SESSION_ARTIFACT_TABLE, cls._create_table),
                (SESSION_ARTIFACT_DRAFT_TABLE, cls._create_draft_table),
            ):
                if table in schema.rebuild_tables:
                    rebuild_table(connection, table, create)
            cls._create_indexes(connection)
        if cls.inspect_connection(connection).needs_write:
            raise RuntimeError("artifact initialization did not reach the supported format")

    @classmethod
    def inspect_schema(cls, database: Path) -> ArtifactSchema:
        """Read a WAL snapshot under the caller's directory qualification.

        SQLite may touch SHM. File checks are not atomic VFS binding and this
        structural classification neither validates every row nor grants access.
        """
        with database_files(database) as present:
            if not present:
                with closing(sqlite3.connect(":memory:")) as connection:
                    connection.row_factory = sqlite3.Row
                    return cls.inspect_connection(connection)
            with reader(database) as connection:
                connection.execute("BEGIN")
                return cls.inspect_connection(connection)

    @classmethod
    def inspect_connection(cls, connection: sqlite3.Connection) -> ArtifactSchema:
        reject_schema_residue(connection, _LEGACY_FOREIGN_TARGETS)
        objects = {
            row["name"]: row
            for row in connection.execute("SELECT name,type,tbl_name,sql FROM sqlite_master")
        }
        create_tables, rebuild_tables, indexes = [], [], []
        add_saved_to = False
        with closing(sqlite3.connect(":memory:")) as reference:
            cls._create_source_table(reference)
            cls._create_table(reference)
            cls._create_draft_table(reference)
            cls._create_indexes(reference)
            for table, definition in reference.execute(
                "SELECT name,sql FROM sqlite_master WHERE type='table'"
            ):
                if table not in objects:
                    create_tables.append(table)
                    continue
                if objects[table]["type"] != "table":
                    raise RuntimeError("unsupported artifact table object")
                actual_columns = {
                    row["name"] for row in connection.execute(f"PRAGMA table_xinfo({table})")
                }
                missing_saved_to = (
                    table == SESSION_ARTIFACT_TABLE
                    and SESSION_ARTIFACT_SAVED_TO_COLUMN not in actual_columns
                )
                add_saved_to |= missing_saved_to
                required = {
                    clause
                    for clause in table_clauses(definition, table)
                    if not (missing_saved_to and clause[0] == SESSION_ARTIFACT_SAVED_TO_COLUMN)
                }
                try:
                    clauses = table_clauses(objects[table]["sql"], table)
                except ValueError as error:
                    raise RuntimeError("unsupported artifact table definition") from error
                actual, repair = set(), False
                for clause in clauses:
                    normalized = clause
                    if clause[:2] == ("foreign", "key") and "references" in clause:
                        position = clause.index("references") + 1
                        target = _LEGACY_FOREIGN_TARGETS[table].get(
                            clause[position], clause[position]
                        )
                        normalized = (*clause[:position], target, *clause[position + 1 :])
                        repair |= normalized != clause
                    if normalized in actual or normalized not in required:
                        raise RuntimeError("unsupported artifact schema declaration")
                    actual.add(normalized)
                if actual != required:
                    raise RuntimeError("unsupported artifact missing constraints or columns")
                if repair:
                    rebuild_tables.append(table)
            for name, table, sql in reference.execute(
                "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
            ):
                if name not in objects:
                    indexes.append(name)
                elif (
                    objects[name]["type"] != "index"
                    or objects[name]["tbl_name"] != table
                    or sql_tokens(objects[name]["sql"]) != sql_tokens(sql)
                ):
                    raise RuntimeError("unsupported artifact owned index")
        return ArtifactSchema(
            tuple(sorted(create_tables)),
            add_saved_to,
            tuple(sorted(rebuild_tables)),
            tuple(sorted(indexes)),
        )

    @staticmethod
    def _create_source_table(
        connection: sqlite3.Connection, table: str = SESSION_ARTIFACT_SOURCE_TABLE
    ) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {table} (
                session_id TEXT NOT NULL,
                product_seq INTEGER NOT NULL CHECK(product_seq > 0),
                runtime_id TEXT NOT NULL,
                vendor_thread_id TEXT,
                vendor_turn_id TEXT,
                vendor_item_id TEXT,
                PRIMARY KEY(session_id, product_seq),
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
        """)

    @staticmethod
    def _backfill_sources(connection: sqlite3.Connection) -> None:
        # Only the old event-table FK grants migration provenance. Current
        # anchors are checked, never reconstructed from unqualified records.
        targets = {
            row["table"]
            for row in connection.execute(f"PRAGMA foreign_key_list({SESSION_ARTIFACT_TABLE})")
        }
        if not targets.intersection({PRODUCT_EVENT_TABLE, PRODUCT_EVENT_TABLE + "_migration"}):
            return
        invalid = connection.execute(f"""
            SELECT 1 FROM {SESSION_ARTIFACT_TABLE} AS artifact
            LEFT JOIN {PRODUCT_EVENT_TABLE} AS event
                ON event.session_id=artifact.session_id
                AND event.product_seq=artifact.source_product_seq
            WHERE event.product_seq IS NULL
                OR event.vendor_turn_id IS NOT artifact.vendor_turn_id
                OR event.vendor_item_id IS NOT artifact.vendor_item_id
            LIMIT 1
        """).fetchone()
        if invalid is not None:
            raise RuntimeError("artifact source event missing or identity mismatch")
        connection.execute(f"""
            INSERT INTO {SESSION_ARTIFACT_SOURCE_TABLE}
                (session_id, product_seq, runtime_id, vendor_thread_id, vendor_turn_id, vendor_item_id)
            SELECT DISTINCT event.session_id, event.product_seq, event.runtime_id,
                event.vendor_thread_id, event.vendor_turn_id, event.vendor_item_id
            FROM {PRODUCT_EVENT_TABLE} AS event
            JOIN {SESSION_ARTIFACT_TABLE} AS artifact
                ON artifact.session_id=event.session_id
                AND artifact.source_product_seq=event.product_seq
            WHERE NOT EXISTS (
                SELECT 1 FROM {SESSION_ARTIFACT_SOURCE_TABLE} AS source
                WHERE source.session_id=event.session_id AND source.product_seq=event.product_seq
            )
        """)
        if connection.execute(f"""
            SELECT 1 FROM {SESSION_ARTIFACT_SOURCE_TABLE} AS source
            JOIN {PRODUCT_EVENT_TABLE} AS event
                ON source.session_id=event.session_id AND source.product_seq=event.product_seq
            WHERE source.runtime_id IS NOT event.runtime_id
                OR source.vendor_thread_id IS NOT event.vendor_thread_id
                OR source.vendor_turn_id IS NOT event.vendor_turn_id
                OR source.vendor_item_id IS NOT event.vendor_item_id
            LIMIT 1
        """).fetchone() is not None:
            raise RuntimeError("artifact source anchor identity mismatch")

    @staticmethod
    def _create_draft_table(
        connection: sqlite3.Connection, table: str = SESSION_ARTIFACT_DRAFT_TABLE
    ) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {table} (
                artifact_id TEXT PRIMARY KEY,
                content BLOB NOT NULL,
                FOREIGN KEY(artifact_id) REFERENCES {SESSION_ARTIFACT_TABLE}(artifact_id)
                    ON DELETE CASCADE
            )
        """)

    @staticmethod
    def _create_indexes(connection: sqlite3.Connection) -> None:
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{SESSION_ARTIFACT_TABLE}_session "
            f"ON {SESSION_ARTIFACT_TABLE}(session_id, source_product_seq, artifact_id)"
        )
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{SESSION_ARTIFACT_TABLE}_path "
            f"ON {SESSION_ARTIFACT_TABLE}(session_id, canonical_path)"
        )

    @classmethod
    def _create_table(
        cls, connection: sqlite3.Connection, table: str = SESSION_ARTIFACT_TABLE
    ) -> None:
        connection.execute(f"""
                CREATE TABLE IF NOT EXISTS {table} (
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
                        REFERENCES {SESSION_ARTIFACT_SOURCE_TABLE}(session_id, product_seq)
                        ON DELETE CASCADE
                )
                """)

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
            return self._draft(row) if row is not None else None

    @staticmethod
    def _draft(row: sqlite3.Row) -> bytes:
        content = row["content"]
        if not isinstance(content, bytes):
            # SQLite affinity does not guarantee a BLOB. In particular,
            # bytes(integer) would allocate an attacker-controlled size.
            raise RuntimeError("unsupported artifact draft content")
        return content

    def save_draft(self, artifact_id: str, content: bytes, *, connection) -> None:
        validate_transaction(connection, self._database)
        connection.execute(
            f"INSERT INTO {SESSION_ARTIFACT_DRAFT_TABLE} (artifact_id, content) VALUES (?, ?) "
            "ON CONFLICT(artifact_id) DO UPDATE SET content = excluded.content",
            (artifact_id, content),
        )

    def _connect(self) -> sqlite3.Connection:
        connection = open_database(
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

    @classmethod
    def inspect_rows(cls, connection: sqlite3.Connection) -> None:
        """Decode durable records and draft bytes without opening their paths.

        Files and content-domain reservation/recovery records have separate
        owners; reading this index is not approval of those stores.
        """
        for row in connection.execute(f"SELECT * FROM {SESSION_ARTIFACT_SOURCE_TABLE}"):
            if (
                not isinstance(row["session_id"], str)
                or not row["session_id"].strip()
                or not isinstance(row["product_seq"], int)
                or isinstance(row["product_seq"], bool)
                or row["product_seq"] <= 0
                or not isinstance(row["runtime_id"], str)
                or not row["runtime_id"].strip()
                or any(
                    row[name] is not None and not isinstance(row[name], str)
                    for name in ("vendor_thread_id", "vendor_turn_id", "vendor_item_id")
                )
            ):
                raise RuntimeError("unsupported artifact source identity")
        if connection.execute(f"""
            SELECT 1 FROM {SESSION_ARTIFACT_TABLE} AS artifact
            LEFT JOIN {SESSION_ARTIFACT_SOURCE_TABLE} AS source
                ON source.session_id=artifact.session_id
                AND source.product_seq=artifact.source_product_seq
            WHERE source.product_seq IS NULL
                OR source.vendor_turn_id IS NOT artifact.vendor_turn_id
                OR source.vendor_item_id IS NOT artifact.vendor_item_id
            LIMIT 1
        """).fetchone() is not None:
            raise RuntimeError("artifact source anchor missing or identity mismatch")
        for row in connection.execute(f"SELECT * FROM {SESSION_ARTIFACT_TABLE}"):
            cls._record(row)
        for row in connection.execute(f"SELECT content FROM {SESSION_ARTIFACT_DRAFT_TABLE}"):
            cls._draft(row)

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
                connection.execute("BEGIN IMMEDIATE")
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
        with nullcontext(connection) if connection is not None else self._transaction() as current:
            existing_row = current.execute(
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
                source_event = ProductEventStore(self._database).by_sequence(
                    session_id, source_product_seq, connection=current
                )
                source_row = current.execute(
                    f"SELECT session_id,product_seq,runtime_id,vendor_thread_id,vendor_turn_id,vendor_item_id "
                    f"FROM {SESSION_ARTIFACT_SOURCE_TABLE} WHERE session_id=? AND product_seq=?",
                    (session_id, source_product_seq),
                ).fetchone()
                if (
                    source_event is None
                    or source_row is None
                    or tuple(source_row)
                    != (
                        source_event.session_id,
                        source_event.product_seq,
                        source_event.runtime_id,
                        source_event.vendor_thread_id,
                        source_event.vendor_turn_id,
                        source_event.vendor_item_id,
                    )
                ):
                    raise SessionStateConflictError("artifact source anchor identity mismatch")
                return existing
            binding = current.execute(
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
            event = ProductEventStore(self._database).by_sequence(
                session_id, source_product_seq, connection=current
            )
            if event is None:
                raise SessionStateConflictError("artifact source event does not exist")
            event_binding = (
                event.vendor_turn_id or None,
                event.vendor_item_id or None,
            )
            artifact_binding = (
                (vendor_turn_id or "").strip() or None,
                (vendor_item_id or "").strip() or None,
            )
            if event_binding != artifact_binding:
                raise SessionStateConflictError(
                    "artifact turn/item does not match its source product event"
                )
            anchor = (
                event.session_id,
                event.product_seq,
                event.runtime_id,
                event.vendor_thread_id,
                event.vendor_turn_id,
                event.vendor_item_id,
            )
            current.execute(
                f"INSERT INTO {SESSION_ARTIFACT_SOURCE_TABLE} "
                "(session_id,product_seq,runtime_id,vendor_thread_id,vendor_turn_id,vendor_item_id) "
                "VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,product_seq) DO NOTHING",
                anchor,
            )
            persisted = current.execute(
                f"SELECT session_id,product_seq,runtime_id,vendor_thread_id,vendor_turn_id,vendor_item_id "
                f"FROM {SESSION_ARTIFACT_SOURCE_TABLE} WHERE session_id=? AND product_seq=?",
                (session_id, source_product_seq),
            ).fetchone()
            if persisted is None or tuple(persisted) != anchor:
                raise SessionStateConflictError("artifact source anchor identity mismatch")
            current.execute(
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
            row = current.execute(
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
