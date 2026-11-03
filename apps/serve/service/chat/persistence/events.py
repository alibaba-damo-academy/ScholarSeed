"""Durable, session-scoped product event log."""

from __future__ import annotations

import heapq
import json
import shutil
import sqlite3
import time
from contextlib import closing, contextmanager
from dataclasses import dataclass, replace
from itertools import islice
from pathlib import Path
from typing import Any, Generator, Iterable, Iterator, Mapping, Sequence

from scholarseed_runtime.contract.history import HistoryEntry, MessagePhase
from service.chat.constants import (
    CANCELLED_MESSAGE_HISTORY_PREFIX,
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_REASONING_DELTA,
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_TOOL_OUTPUT_DELTA,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_EVENT_VERSION,
    PRODUCT_EVENT_VERSION_V1,
    USER_MESSAGE_BINDING_ADMITTED,
    USER_MESSAGE_BINDING_BOUND,
    USER_MESSAGE_BINDING_CANCELLED,
    USER_MESSAGE_ORIGIN_TURN,
)
from service.chat.persistence import attention, blocks, journal
from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SQLITE_TIMEOUT_SECONDS,
    SessionBindingConflictError,
    SessionCatalogRecord,
    SessionStateConflictError,
)
from service.chat.persistence.utils import begin_write, validate_transaction
from service.chat.provenance import MODEL_RUN_FIELD, ModelRun
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

PRODUCT_EVENT_TABLE = "product_event"
PRODUCT_EVENT_MIGRATION_TABLE = "product_event_migration"
PRODUCT_EVENT_SCHEMA_COLUMN = "schema_version"
MINIMUM_REPLAY_LIMIT = 1
MAXIMUM_REPLAY_LIMIT = 10_000
MAXIMUM_RECENT_EVENT_LIMIT = 20_000
RECLAIM_MIN_BYTES = 16 * 1024 * 1024
RECLAIM_FREE_DIVISOR = 4
VACUUM_SPACE_MULTIPLIER = 2
MAINTENANCE_PROGRESS_OPCODES = 1000
BODY_COLUMNS = {"payload_ref": "TEXT", "payload_bytes": "INTEGER", "client_turn_id": "TEXT"}
MIGRATION_BATCH_EVENTS = 128
MIGRATION_BATCH_BYTES = 1024 * 1024
BLOCK_EVENT_KINDS = frozenset(
    {PRODUCT_EVENT_MESSAGE_DELTA, PRODUCT_EVENT_REASONING_DELTA, PRODUCT_EVENT_TOOL_OUTPUT_DELTA}
)
WORKSPACE_BOUND_EVENT = "session.workspace.bound"
SESSION_FORK_EVENT = "session.fork.requested"
SESSION_FORK_KEY = "session:fork"
SESSION_FORK_IMPORTED_KEY = "session:fork:imported"
SESSION_FORK_IMPORTED_EVENT = "session.fork.imported"
SESSION_FORK_SOURCE_CHANGED = "session_fork_source_changed"
FORK_HISTORY_KINDS = frozenset(
    {PRODUCT_EVENT_USER_MESSAGE, PRODUCT_EVENT_MESSAGE_DELTA, PRODUCT_EVENT_TURN_COMPLETED}
)
WORKSPACE_INITIAL_SEQUENCE = 0
WORKSPACE_ORIGIN_UNAVAILABLE = "session_workspace_origin_unavailable"
CONTENT_REJECTION_CODES = frozenset(
    {
        "content_safety_blocked",
        "content_policy_violation",
        "content_filter",
    }
)


def cancelled_message_text(payload: dict[str, Any]) -> str:
    text = str(payload.get("text") or "")
    references = payload.get("refs")
    if isinstance(references, list):
        labels = [
            str(reference.get("title") or reference.get("id") or "")
            for reference in references
            if isinstance(reference, dict)
        ]
        if labels:
            text = f"{text}\nReferences: {json.dumps(labels, ensure_ascii=False)}"
    return text.strip()


@dataclass(frozen=True)
class ProductEventRecord:
    """One stable Service event envelope persisted before SSE publication."""

    event_id: int
    session_id: str
    runtime_id: str
    vendor_thread_id: str
    vendor_turn_id: str | None
    vendor_item_id: str | None
    kind: str
    payload: dict[str, Any]
    schema_version: int
    product_seq: int
    idempotency_key: str
    created_at: float


class ProductEventSchemaError(ValueError):
    """A durable product event cannot be projected to the negotiated schema."""


def _event_schema_version(value: object) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value not in (PRODUCT_EVENT_VERSION_V1, PRODUCT_EVENT_VERSION)
    ):
        raise ProductEventSchemaError("product event schema version is not a supported integer")
    return value


def upcast_product_event(
    record: ProductEventRecord,
    target_version: object = PRODUCT_EVENT_VERSION,
) -> ProductEventRecord:
    """Purely upgrade one durable event without rewriting the journal row.

    ProductEvent v2 makes the persisted schema version authoritative.  Its payload
    vocabulary is intentionally identical to v1, so the first upcast changes only
    the envelope version.  Future migrations extend this explicit step chain.
    """

    if (
        not isinstance(target_version, int)
        or isinstance(target_version, bool)
        or target_version != PRODUCT_EVENT_VERSION
    ):
        raise ProductEventSchemaError(f"unsupported product event target v{target_version}")
    version = _event_schema_version(record.schema_version)
    if version == PRODUCT_EVENT_VERSION:
        return record
    if version == PRODUCT_EVENT_VERSION_V1:
        return replace(record, schema_version=PRODUCT_EVENT_VERSION, payload=dict(record.payload))
    raise ProductEventSchemaError(
        f"product event v{record.schema_version} cannot be upgraded to v{target_version}"
    )


@dataclass(frozen=True)
class EventSchema:
    """Event-owned initialization requirements, not aggregate database approval."""

    create_table: bool
    add_schema_version: bool
    repair_foreign_key: bool
    create_indexes: tuple[str, ...]
    versions: tuple[int, ...]
    body_columns: tuple[str, ...] = ()
    drop_replay_index: bool = False
    initialize_blocks: bool = False
    initialize_attention: bool = False

    @property
    def needs_write(self) -> bool:
        return bool(
            self.create_table
            or self.add_schema_version
            or self.repair_foreign_key
            or self.create_indexes
            or self.body_columns
            or self.drop_replay_index
            or self.initialize_blocks
            or self.initialize_attention
        )


class ProductEventStore:
    """Allocate monotonic per-session sequence numbers and retain replay history."""

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
            journal.initialize(connection)
            blocks.initialize(connection)
            cls._create_event_table(connection)
            attention.initialize(connection)
            for name in schema.body_columns:
                connection.execute(
                    f"ALTER TABLE {PRODUCT_EVENT_TABLE} ADD COLUMN {name} {BODY_COLUMNS[name]}"
                )
            cls._ensure_schema_version(connection)
            if schema.repair_foreign_key:
                rebuild_table(connection, PRODUCT_EVENT_TABLE, cls._create_event_table)
            if schema.drop_replay_index:
                connection.execute(f"DROP INDEX idx_{PRODUCT_EVENT_TABLE}_replay")
            cls._create_indexes(connection)
        if cls.inspect_connection(connection).needs_write:
            raise RuntimeError("event initialization did not reach the supported format")
        attention.inspect_clock(connection)

    @classmethod
    def inspect_schema(cls, database: Path) -> EventSchema:
        """Read a WAL snapshot within the caller's directory qualification.

        File checks are not atomic VFS binding. SQLite mode=ro may touch SHM;
        this inspection checks persisted envelope versions but neither grants
        maintenance nor validates every event payload or other database owner.
        """
        with database_files(database) as present:
            if not present:
                with closing(sqlite3.connect(":memory:")) as connection:
                    connection.row_factory = sqlite3.Row
                    return cls.inspect_connection(connection)
            with reader(database) as connection:
                connection.execute("BEGIN")
                schema = cls.inspect_connection(connection)
                if not schema.initialize_attention:
                    attention.inspect_clock(connection)
                return schema

    @staticmethod
    def _reclaim_needed(connection: sqlite3.Connection) -> bool:
        # VACUUM may renumber implicit rowids in unkeyed foreign tables. The
        # reviewed runtime is gated by full typed-row equality for keyed owner
        # tables (including hidden rowids). A primary key alone is not a
        # portable SQLite rowid guarantee. Retain unknown unkeyed assets.
        for table in connection.execute("PRAGMA main.table_list"):
            if table[0] != "main":
                continue
            if table[1] == "sqlite_sequence":
                # This internal table has no primary key. VACUUM preserves its
                # values but renumbers sparse rowids, which the typed-row
                # compatibility contract also observes.
                sequence_rows = connection.execute(
                    "SELECT rowid FROM sqlite_sequence ORDER BY rowid"
                )
                if any(row[0] != ordinal for ordinal, row in enumerate(sequence_rows, 1)):
                    return False
                continue
            if str(table[1]).startswith("sqlite_"):
                continue
            quoted = '"' + str(table[1]).replace('"', '""') + '"'
            if table[2] != "table" or not any(
                row[5] for row in connection.execute(f"PRAGMA main.table_xinfo({quoted})")
            ):
                return False
        pages = int(connection.execute("PRAGMA page_count").fetchone()[0])
        free = int(connection.execute("PRAGMA freelist_count").fetchone()[0])
        size = int(connection.execute("PRAGMA page_size").fetchone()[0])
        unused = int(
            connection.execute("SELECT COALESCE(SUM(unused),0) FROM dbstat('main',1)").fetchone()[0]
        )
        reclaimable = free * size + unused
        return (
            reclaimable >= RECLAIM_MIN_BYTES and reclaimable * RECLAIM_FREE_DIVISOR >= pages * size
        )

    @classmethod
    def reclaim(cls, database: Path, *, deadline: float | None = None) -> bool:
        """Reclaim under scheduled exclusive maintenance, with cooperative SQL budget.

        VM interruption rolls back VACUUM atomically. Filesystem/checkpoint I/O
        may outlast the budget, so callers must still wait for this owner to exit.
        """
        if deadline is not None and time.monotonic() >= deadline:
            return False
        with closing(cls(database)._connect()) as connection:
            connection.execute("PRAGMA busy_timeout=0")
            vacuumed = False
            if deadline is not None:
                connection.set_progress_handler(
                    lambda: int(time.monotonic() >= deadline), MAINTENANCE_PROGRESS_OPCODES
                )
            try:
                if not cls._reclaim_needed(connection):
                    return False
                pages = int(connection.execute("PRAGMA page_count").fetchone()[0])
                size = int(connection.execute("PRAGMA page_size").fetchone()[0])
                if shutil.disk_usage(database.parent).free < pages * size * VACUUM_SPACE_MULTIPLIER:
                    raise RuntimeError("insufficient disk space for session storage maintenance")
                if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]:
                    raise RuntimeError("session storage maintenance is busy")
                connection.execute("VACUUM")
                vacuumed = True
                if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]:
                    raise RuntimeError("session storage checkpoint is busy")
                return True
            except sqlite3.OperationalError as error:
                if (
                    error.sqlite_errorcode == sqlite3.SQLITE_INTERRUPT
                    and deadline is not None
                    and time.monotonic() >= deadline
                ):
                    return vacuumed
                raise
            finally:
                connection.set_progress_handler(None, 0)

    @classmethod
    def inspect_connection(cls, connection: sqlite3.Connection) -> EventSchema:
        reject_schema_residue(connection, (PRODUCT_EVENT_TABLE,))
        objects = {
            row["name"]: row
            for row in connection.execute("SELECT name,type,tbl_name,sql FROM sqlite_master")
        }
        if PRODUCT_EVENT_MIGRATION_TABLE in objects:
            raise RuntimeError("event repair staging object already exists; recovery required")
        create_table = PRODUCT_EVENT_TABLE not in objects
        add_schema_version = repair_foreign_key = False
        indexes = []
        missing_bodies: tuple[str, ...] = ()
        drop_replay = False
        with closing(sqlite3.connect(":memory:")) as reference:
            cls._create_event_table(reference)
            cls._create_indexes(reference)
            if not create_table:
                current = objects[PRODUCT_EVENT_TABLE]
                if current["type"] != "table":
                    raise RuntimeError("unsupported event table object")
                columns = connection.execute(
                    f"PRAGMA table_xinfo({PRODUCT_EVENT_TABLE})"
                ).fetchall()
                if any(row["hidden"] for row in columns):
                    raise RuntimeError("unsupported event generated columns")
                add_schema_version = PRODUCT_EVENT_SCHEMA_COLUMN not in {
                    row["name"] for row in columns
                }
                missing_bodies = tuple(
                    name for name in BODY_COLUMNS if name not in {row["name"] for row in columns}
                )
                if missing_bodies and len(missing_bodies) != len(BODY_COLUMNS):
                    raise RuntimeError("incomplete event body schema")
                definition = reference.execute(
                    "SELECT sql FROM sqlite_master WHERE name=?", (PRODUCT_EVENT_TABLE,)
                ).fetchone()[0]
                required = {
                    clause
                    for clause in table_clauses(definition, PRODUCT_EVENT_TABLE)
                    if not (add_schema_version and clause[0] == PRODUCT_EVENT_SCHEMA_COLUMN)
                    and clause[0] not in missing_bodies
                }
                try:
                    clauses = table_clauses(current["sql"], PRODUCT_EVENT_TABLE)
                except ValueError as error:
                    raise RuntimeError("unsupported event table definition") from error
                actual = set()
                for clause in clauses:
                    normalized = clause
                    if clause[:2] == ("foreign", "key") and "references" in clause:
                        position = clause.index("references") + 1
                        if clause[position] not in {
                            SESSION_CATALOG_TABLE,
                            SESSION_CATALOG_TABLE + "_migration",
                        }:
                            raise RuntimeError("unsupported event foreign key target")
                        normalized = (
                            *clause[:position],
                            SESSION_CATALOG_TABLE,
                            *clause[position + 1 :],
                        )
                        repair_foreign_key |= normalized != clause
                    if normalized in actual or normalized not in required:
                        raise RuntimeError("unsupported event schema declaration")
                    actual.add(normalized)
                if actual != required:
                    raise RuntimeError("unsupported event missing constraints or columns")
            replay_name = f"idx_{PRODUCT_EVENT_TABLE}_replay"
            if replay_name in objects:
                index = objects[replay_name]
                expected = (
                    f"CREATE INDEX {replay_name} ON {PRODUCT_EVENT_TABLE}(session_id, product_seq)"
                )
                if (
                    index["type"] != "index"
                    or index["tbl_name"] != PRODUCT_EVENT_TABLE
                    or sql_tokens(index["sql"]) != sql_tokens(expected)
                ):
                    raise RuntimeError("unsupported redundant event index")
                drop_replay = True
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
                    raise RuntimeError("unsupported event owned index")
        versions = set()
        if not create_table:
            if add_schema_version:
                # Historical rows without the version column are v1. Inspection
                # must not add the column or rewrite their payloads to prove it.
                if connection.execute(f"SELECT 1 FROM {PRODUCT_EVENT_TABLE} LIMIT 1").fetchone():
                    versions.add(PRODUCT_EVENT_VERSION_V1)
            else:
                for row in connection.execute(
                    f"SELECT DISTINCT {PRODUCT_EVENT_SCHEMA_COLUMN} FROM {PRODUCT_EVENT_TABLE}"
                ):
                    versions.add(_event_schema_version(row[0]))
        return EventSchema(
            create_table,
            add_schema_version,
            repair_foreign_key,
            tuple(sorted(indexes)),
            tuple(sorted(versions)),
            missing_bodies,
            drop_replay,
            blocks.inspect_connection(connection).needs_write,
            attention.needs_initialization(connection),
        )

    @staticmethod
    def _create_indexes(connection: sqlite3.Connection) -> None:
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{PRODUCT_EVENT_TABLE}_kind_recent "
            f"ON {PRODUCT_EVENT_TABLE}(kind, created_at DESC, event_id DESC)"
        )

        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{PRODUCT_EVENT_TABLE}_pending_body "
            f"ON {PRODUCT_EVENT_TABLE}(event_id) WHERE payload_ref IS NULL"
        )

    @classmethod
    def _create_event_table(
        cls, connection: sqlite3.Connection, table: str = PRODUCT_EVENT_TABLE
    ) -> None:
        connection.execute(f"""
                CREATE TABLE IF NOT EXISTS {table} (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    runtime_id TEXT NOT NULL,
                    vendor_thread_id TEXT NOT NULL,
                    vendor_turn_id TEXT,
                    vendor_item_id TEXT,
                    kind TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    payload_ref TEXT,
                    client_turn_id TEXT,
                    payload_bytes INTEGER,
                    schema_version INTEGER NOT NULL DEFAULT {PRODUCT_EVENT_VERSION_V1},
                    product_seq INTEGER NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    UNIQUE(session_id, product_seq),
                    UNIQUE(session_id, idempotency_key),
                    FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                        ON DELETE CASCADE
                )
                """)

    @staticmethod
    def _ensure_schema_version(connection: sqlite3.Connection) -> None:
        columns = {
            str(row["name"])
            for row in connection.execute(f"PRAGMA table_info({PRODUCT_EVENT_TABLE})").fetchall()
        }
        if PRODUCT_EVENT_SCHEMA_COLUMN not in columns:
            connection.execute(
                f"ALTER TABLE {PRODUCT_EVENT_TABLE} ADD COLUMN "
                f"{PRODUCT_EVENT_SCHEMA_COLUMN} INTEGER NOT NULL DEFAULT {PRODUCT_EVENT_VERSION_V1}"
            )

    @property
    def database(self) -> Path:
        return self._database

    def _connect(self) -> sqlite3.Connection:
        connection = open_database(
            str(self._database),
            check_same_thread=False,
            timeout=SQLITE_TIMEOUT_SECONDS,
            isolation_level=None,
        )
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            return connection
        except BaseException:
            connection.close()
            raise

    @classmethod
    def inspect_rows(cls, connection: sqlite3.Connection, *, database: Path | None = None) -> None:
        """Read every committed event and its canonical body in the qualified snapshot."""
        attention.inspect_clock(connection)
        source_table = "session_artifact_source"
        anchors = {}
        if connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (source_table,)
        ).fetchone():
            anchors = {
                (row["session_id"], row["product_seq"]): dict(row)
                for row in connection.execute(f"SELECT * FROM {source_table}")
            }

        # Retain only identities, never payloads. One SQL scan and the existing
        # block decode pass establish cross-authority uniqueness without a
        # per-event SQL lookup (large histories also use this updater reader).
        event_ids: set[int] = set()
        session_sequences: dict[str, set[int]] = {}
        session_keys: dict[str, set[str]] = {}
        catalog_cursors = {
            row[0]: row[1]
            for row in connection.execute(
                f"SELECT session_id,last_product_seq FROM {SESSION_CATALOG_TABLE}"
            )
        }
        high_water_row = connection.execute(
            "SELECT seq FROM sqlite_sequence WHERE name=?", (PRODUCT_EVENT_TABLE,)
        ).fetchone()
        high_water = high_water_row[0] if high_water_row is not None else 0

        def validate(row: Mapping[str, Any]) -> None:
            upcast_product_event(cls._record(row))
            event_id = row["event_id"]
            sequence = row["product_seq"]
            session = row["session_id"]
            key = row["idempotency_key"]
            if (
                not isinstance(event_id, int)
                or event_id < 1
                or not isinstance(sequence, int)
                or sequence < 1
            ):
                raise ValueError("invalid logical event identity")
            if event_id in event_ids:
                raise ValueError("duplicate logical event id")
            sequences = session_sequences.setdefault(session, set())
            keys = session_keys.setdefault(session, set())
            if sequence in sequences:
                raise ValueError("duplicate logical event sequence")
            if key in keys:
                raise ValueError("duplicate logical event idempotency key")
            event_ids.add(event_id)
            sequences.add(sequence)
            keys.add(key)
            if event_id > high_water:
                raise ValueError("event autoincrement high water is behind history")
            if session not in catalog_cursors or sequence > catalog_cursors[session]:
                raise ValueError("session catalog cursor is behind event history")
            anchor = anchors.pop((row["session_id"], row["product_seq"]), None)
            if anchor is not None and any(
                (anchor[name] or None) != (row[name] or None)
                for name in ("runtime_id", "vendor_thread_id", "vendor_turn_id", "vendor_item_id")
            ):
                raise ValueError("artifact source anchor does not match its event")

        with closing(
            connection.execute(f"SELECT * FROM {PRODUCT_EVENT_TABLE} ORDER BY event_id")
        ) as rows:
            with closing(cls._materialize(connection, rows, database=database)) as materialized:
                for row in materialized:
                    validate(row)
        blocks.inspect_rows(connection, database, visit=validate)
        if anchors:
            raise ValueError("artifact source anchor has no logical event")

    @classmethod
    def _materialize(
        cls,
        connection: sqlite3.Connection,
        rows: Iterable[sqlite3.Row],
        *,
        database: Path | None = None,
    ) -> Generator[dict[str, Any], None, None]:
        bodies = None
        try:
            for row in rows:
                if row["payload_ref"] is None:
                    if row["payload_bytes"] is not None or row["client_turn_id"] is not None:
                        raise ValueError("invalid inline event body metadata")
                    yield dict(row)
                    continue
                if row["payload"] != "{}":
                    raise ValueError("event has duplicate authoritative bodies")
                if bodies is None:
                    if database is None:
                        raise ValueError(
                            "event body inspection requires its qualified database location"
                        )
                    bodies = journal.Journal(connection, database)
                payload = bodies.get(row["payload_ref"])
                if len(payload.encode("utf-8")) != row["payload_bytes"]:
                    raise ValueError("event body length mismatch")
                decoded = json.loads(payload)
                if not isinstance(decoded, dict):
                    raise ValueError("event body must be an object")
                client = (
                    decoded.get("client_turn_id")
                    if row["kind"] == PRODUCT_EVENT_USER_MESSAGE
                    else None
                )
                if row["client_turn_id"] != client:
                    raise ValueError("event body query identity mismatch")
                yield {**dict(row), "payload": payload}
        finally:
            if bodies is not None:
                bodies.close()

    @classmethod
    def _one(
        cls,
        connection: sqlite3.Connection,
        row: sqlite3.Row | None,
        *,
        database: Path,
    ) -> dict[str, Any] | None:
        if row is None:
            return None
        return tuple(cls._materialize(connection, (row,), database=database))[0]

    @staticmethod
    def body_references(connection: sqlite3.Connection) -> Iterator[str]:
        """Stream event references without decoding history or collecting a set."""
        with closing(
            connection.execute(
                f"SELECT payload_ref FROM {PRODUCT_EVENT_TABLE} WHERE payload_ref IS NOT NULL"
            )
        ) as rows:
            for row in rows:
                yield row[0]

    @staticmethod
    def _movable_delta(connection: sqlite3.Connection) -> str:
        """Preserve legacy Artifact foreign keys until their owner installs anchors."""
        if any(
            row[2] == PRODUCT_EVENT_TABLE
            for row in connection.execute("PRAGMA foreign_key_list(session_artifact)")
        ):
            return "NOT EXISTS (SELECT 1 FROM session_artifact a WHERE a.session_id = product_event.session_id AND a.source_product_seq = product_event.product_seq)"
        return "1"

    @classmethod
    def migrate_blocks(
        cls,
        connection: sqlite3.Connection,
        database: Path,
        *,
        limit: int = MIGRATION_BATCH_EVENTS,
        byte_limit: int = MIGRATION_BATCH_BYTES,
    ) -> int:
        """Publish a bounded legacy batch and remove its old rows in one transaction."""
        validate_transaction(connection, database)
        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or limit <= 0
            or not isinstance(byte_limit, int)
            or isinstance(byte_limit, bool)
            or byte_limit <= 0
        ):
            raise ValueError("event block migration requires positive limits")
        if cls._movable_delta(connection) != "1":
            # Wait for Artifact's sparse anchor migration; skipping individual
            # rows would create holes that a later block could span.
            return 0
        placeholders = ",".join("?" for _ in BLOCK_EVENT_KINDS)
        # The kind/recent index requires sorting every remaining delta before
        # applying LIMIT. Walk the integer primary key instead; prior batches
        # remove their rows, so the scan stops at the next bounded batch.
        cursor = connection.execute(
            f"SELECT * FROM {PRODUCT_EVENT_TABLE} NOT INDEXED WHERE kind IN ({placeholders}) AND {cls._movable_delta(connection)} ORDER BY event_id LIMIT ?",
            (*sorted(BLOCK_EVENT_KINDS), min(limit, MIGRATION_BATCH_EVENTS)),
        )
        pending: list[dict[str, Any]] = []
        size = 0
        with (
            closing(cursor),
            closing(cls._materialize(connection, cursor, database=database)) as rows,
        ):
            for row in rows:
                cost = len(row["payload"].encode("utf-8"))
                if pending and size + cost > byte_limit:
                    break
                upcast_product_event(cls._record(row))
                pending.append(
                    {name: row[name] for name in ProductEventRecord.__dataclass_fields__}
                )
                size += cost
        if not pending:
            return 0
        connection.execute("SAVEPOINT session_event_block_migration")
        try:
            with blocks.BlockStore(connection, database) as store:
                store.append_many(pending)
                by_session: dict[str, dict[int, dict[str, Any]]] = {}
                for row in pending:
                    by_session.setdefault(row["session_id"], {})[row["product_seq"]] = row
                for session, expected in by_session.items():
                    remaining = set(expected)
                    last_sequence = max(expected)
                    # Seek directly to this batch, decoding each containing
                    # block once rather than reopening it for every key.
                    with closing(
                        store.rows(session_id=session, after_seq=min(expected) - 1)
                    ) as published_rows:
                        for published in published_rows:
                            sequence = published["product_seq"]
                            if sequence > last_sequence:
                                break
                            original = expected.get(sequence)
                            if original is None:
                                continue
                            if sequence not in remaining or any(
                                published[name] != value for name, value in original.items()
                            ):
                                raise ValueError(
                                    "event block publication changed its logical record"
                                )
                            remaining.remove(sequence)
                    if remaining:
                        raise ValueError("event block publication is missing logical records")
                connection.executemany(
                    f"DELETE FROM {PRODUCT_EVENT_TABLE} WHERE event_id = ?",
                    ((row["event_id"],) for row in pending),
                )
        except BaseException:
            connection.execute("ROLLBACK TO session_event_block_migration")
            connection.execute("RELEASE session_event_block_migration")
            raise
        else:
            connection.execute("RELEASE session_event_block_migration")
        return len(pending)

    @classmethod
    def migrate_bodies(
        cls,
        connection: sqlite3.Connection,
        database: Path,
        *,
        limit: int = MIGRATION_BATCH_EVENTS,
    ) -> int:
        """One bounded scheduled batch; callers retain writer admission and transaction."""
        validate_transaction(connection, database)
        if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
            raise ValueError("event body migration requires a positive limit")
        pending: list[tuple[int, str, str, dict[str, Any], int]] = []
        size = 0
        with closing(
            connection.execute(
                f"SELECT event_id,kind,payload FROM {PRODUCT_EVENT_TABLE} WHERE payload_ref IS NULL AND (kind NOT IN (?, ?, ?) OR NOT ({cls._movable_delta(connection)})) ORDER BY event_id LIMIT ?",
                (*sorted(BLOCK_EVENT_KINDS), min(limit, MIGRATION_BATCH_EVENTS)),
            )
        ) as rows:
            for row in rows:
                encoded = row["payload"]
                cost = len(encoded.encode("utf-8"))
                if pending and size + cost > MIGRATION_BATCH_BYTES:
                    break
                decoded = json.loads(encoded)
                if not isinstance(decoded, dict):
                    raise ValueError("legacy event body must be an object")
                pending.append((row["event_id"], row["kind"], encoded, decoded, cost))
                size += cost
        if not pending:
            return 0
        with journal.Journal(connection, database) as bodies:
            references = bodies.put_many(row[2] for row in pending)
            for (event_id, kind, encoded, decoded, cost), reference in zip(
                pending, references, strict=True
            ):
                if bodies.get(reference) != encoded:
                    raise ValueError("event body publication changed")
                connection.execute(
                    f"UPDATE {PRODUCT_EVENT_TABLE} SET payload='{{}}',payload_ref=?,payload_bytes=?,client_turn_id=? WHERE event_id=? AND payload_ref IS NULL",
                    (
                        reference,
                        cost,
                        (
                            decoded.get("client_turn_id")
                            if kind == PRODUCT_EVENT_USER_MESSAGE
                            else None
                        ),
                        event_id,
                    ),
                )
        return len(pending)

    @staticmethod
    def _optional(row: Mapping[str, Any], name: str) -> str | None:
        return str(row[name] or "").strip() or None

    @classmethod
    def _record(cls, row: Mapping[str, Any]) -> ProductEventRecord:
        version = _event_schema_version(row[PRODUCT_EVENT_SCHEMA_COLUMN])
        try:
            decoded = json.loads(str(row["payload"]))
        except (TypeError, ValueError):
            decoded = {}
        payload = dict(decoded) if isinstance(decoded, dict) else {}
        return ProductEventRecord(
            event_id=int(row["event_id"]),
            session_id=str(row["session_id"]),
            runtime_id=str(row["runtime_id"]),
            vendor_thread_id=str(row["vendor_thread_id"]),
            vendor_turn_id=cls._optional(row, "vendor_turn_id"),
            vendor_item_id=cls._optional(row, "vendor_item_id"),
            kind=str(row["kind"]),
            payload=payload,
            schema_version=version,
            product_seq=int(row["product_seq"]),
            idempotency_key=str(row["idempotency_key"]),
            created_at=float(row["created_at"]),
        )

    @staticmethod
    def _assert_idempotent(
        existing: ProductEventRecord,
        *,
        runtime_id: str,
        vendor_thread_id: str,
        vendor_turn_id: str | None,
        vendor_item_id: str | None,
        kind: str,
        payload: dict[str, Any],
    ) -> None:
        expected = (
            runtime_id,
            vendor_thread_id,
            (vendor_turn_id or "").strip() or None,
            (vendor_item_id or "").strip() or None,
            kind,
            payload,
        )
        actual = (
            existing.runtime_id,
            existing.vendor_thread_id,
            existing.vendor_turn_id,
            existing.vendor_item_id,
            existing.kind,
            existing.payload,
        )
        if actual != expected:
            raise SessionStateConflictError(
                f"product event key {existing.idempotency_key} was reused"
            )

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Compose session events and indexes under one cursor-owning transaction."""

        connection = self._connect()
        try:
            begin_write(connection, self._database)
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    @contextmanager
    def batch(self, connection: sqlite3.Connection) -> Iterator[blocks.BlockStore]:
        validate_transaction(connection, self._database)
        with blocks.BlockStore(connection, self._database) as store, store.batch():
            yield store

    @contextmanager
    def _snapshot(
        self, connection: sqlite3.Connection | None = None
    ) -> Iterator[sqlite3.Connection]:
        if connection is not None:
            validate_transaction(connection, self._database)
            yield connection
            return
        with closing(self._connect()) as owned:
            owned.execute("BEGIN")
            yield owned

    def _rows(
        self,
        connection: sqlite3.Connection,
        *,
        session_id: str | None = None,
        kinds: Sequence[str] | None = None,
        after_seq: int = 0,
        vendor_turn_id: str | None = None,
        vendor_item_id: str | None = None,
    ) -> Generator[dict[str, Any], None, None]:
        """Merge both physical forms, retaining every logical sequence exactly once."""
        clauses = ["product_seq > ?"]
        values: list[Any] = [after_seq]
        for column, value in (
            ("session_id", session_id),
            ("vendor_turn_id", vendor_turn_id),
            ("vendor_item_id", vendor_item_id),
        ):
            if value is not None:
                clauses.append(f"{column} = ?")
                values.append(value)
        if kinds is not None:
            if not kinds:
                return
            clauses.append("kind IN (" + ",".join("?" for _ in kinds) + ")")
            values.extend(kinds)
        key = "product_seq" if session_id is not None else "event_id"
        with (
            closing(
                connection.execute(
                    f"SELECT * FROM {PRODUCT_EVENT_TABLE} WHERE {' AND '.join(clauses)} ORDER BY {key}",
                    values,
                )
            ) as cursor,
            closing(self._materialize(connection, cursor, database=self._database)) as ordinary,
        ):
            if kinds is not None and not BLOCK_EVENT_KINDS.intersection(kinds):
                yield from ordinary
                return
            with blocks.BlockStore(connection, self._database) as store:
                with closing(
                    store.rows(
                        session_id=session_id,
                        after_seq=after_seq,
                        kinds=frozenset(kinds) if kinds is not None else None,
                    )
                ) as stored:
                    selected = (
                        row
                        for row in stored
                        if (vendor_turn_id is None or row["vendor_turn_id"] == vendor_turn_id)
                        and (vendor_item_id is None or row["vendor_item_id"] == vendor_item_id)
                    )
                    if session_id is None:
                        yield from ordinary
                        yield from selected
                        return
                    previous = None
                    for row in heapq.merge(ordinary, selected, key=lambda row: row[key]):
                        identity = row[key]
                        if identity == previous:
                            raise ValueError("duplicate event authority across row and block")
                        previous = identity
                        yield row

    def latest_kind(
        self,
        session_id: str,
        kind: str,
        *,
        connection: sqlite3.Connection | None = None,
        vendor_turn_id: str | None = None,
        vendor_item_id: str | None = None,
    ) -> ProductEventRecord | None:
        """Read the latest logical event, including compacted deltas."""
        if kind not in BLOCK_EVENT_KINDS:
            clauses = ["session_id=?", "kind=?"]
            values = [session_id, kind]
            for name, value in (
                ("vendor_turn_id", vendor_turn_id),
                ("vendor_item_id", vendor_item_id),
            ):
                if value is not None:
                    clauses.append(f"{name}=?")
                    values.append(value)
            with self._snapshot(connection) as current:
                row = current.execute(
                    f"SELECT * FROM {PRODUCT_EVENT_TABLE} WHERE {' AND '.join(clauses)} ORDER BY product_seq DESC LIMIT 1",
                    values,
                ).fetchone()
                found = self._one(current, row, database=self._database)
                return self._record(found) if found is not None else None
        with (
            self._snapshot(connection) as current,
            closing(
                self._rows(
                    current,
                    session_id=session_id,
                    kinds=(kind,),
                    vendor_turn_id=vendor_turn_id,
                    vendor_item_id=vendor_item_id,
                )
            ) as rows,
        ):
            row = max(rows, key=lambda row: row["product_seq"], default=None)
            return self._record(row) if row is not None else None

    def latest_answer(
        self, session_id: str, turn_id: str, *, connection: sqlite3.Connection | None = None
    ) -> ProductEventRecord | None:
        with (
            self._snapshot(connection) as current,
            closing(
                self._rows(
                    current,
                    session_id=session_id,
                    kinds=(PRODUCT_EVENT_MESSAGE_DELTA,),
                    vendor_turn_id=turn_id,
                )
            ) as rows,
        ):
            answers = (
                record
                for row in rows
                if (record := self._record(row)).payload.get("phase")
                in {None, "", MessagePhase.FINAL_ANSWER.value}
            )
            return max(answers, key=lambda record: record.product_seq, default=None)

    def last_agent_reply_at(self, session_id: str) -> float | None:
        """Timestamp of the latest nonempty user-visible assistant message."""

        with (
            self._snapshot() as connection,
            closing(
                self._rows(
                    connection,
                    session_id=session_id,
                    kinds=(PRODUCT_EVENT_MESSAGE_DELTA,),
                )
            ) as rows,
        ):
            return max(
                (
                    record.created_at
                    for row in rows
                    if str((record := self._record(row)).payload.get("delta") or "").strip()
                ),
                default=None,
            )

    def recovery_snapshot(self, session_id: str, turn_id: str) -> dict[str, Any]:
        with (
            self._snapshot() as connection,
            closing(
                self._rows(
                    connection,
                    session_id=session_id,
                    kinds=(PRODUCT_EVENT_SESSION_STATE,),
                    vendor_turn_id=turn_id,
                )
            ) as rows,
        ):
            candidates = (
                record
                for row in rows
                if attention.recovery_blocked((record := self._record(row)).payload)
            )
            latest = max(candidates, key=lambda record: record.product_seq, default=None)
            return {
                "recovery_incident_id": (
                    str(latest.payload.get("incident_id") or turn_id) if latest else None
                ),
                "recovery_source_seq": latest.product_seq if latest else 0,
            }

    def sessions_with_kind(self, kind: str) -> tuple[str, ...]:
        """Enumerate owners in both physical event forms."""
        if kind not in BLOCK_EVENT_KINDS:
            with self._snapshot() as connection:
                return tuple(
                    str(row[0])
                    for row in connection.execute(
                        f"SELECT DISTINCT session_id FROM {PRODUCT_EVENT_TABLE} WHERE kind=?",
                        (kind,),
                    )
                )
        with self._snapshot() as connection, closing(self._rows(connection, kinds=(kind,))) as rows:
            return tuple(sorted({str(row["session_id"]) for row in rows}))

    def recent_kinds(
        self, kinds: Sequence[str], *, limit: int = MAXIMUM_REPLAY_LIMIT
    ) -> tuple[ProductEventRecord, ...]:
        """Return the same global chronological page with bounded selection memory."""
        normalized = tuple(dict.fromkeys(kind.strip() for kind in kinds if kind.strip()))
        if not normalized:
            return ()
        bounded_limit = max(MINIMUM_REPLAY_LIMIT, min(int(limit), MAXIMUM_RECENT_EVENT_LIMIT))
        if not BLOCK_EVENT_KINDS.intersection(normalized):
            placeholders = ",".join("?" for _ in normalized)
            with (
                self._snapshot() as connection,
                closing(
                    connection.execute(
                        f"SELECT * FROM {PRODUCT_EVENT_TABLE} WHERE kind IN ({placeholders}) ORDER BY created_at DESC,event_id DESC LIMIT ?",
                        (*normalized, bounded_limit),
                    )
                ) as cursor,
                closing(self._materialize(connection, cursor, database=self._database)) as rows,
            ):
                return tuple(reversed(tuple(self._record(row) for row in rows)))
        with (
            self._snapshot() as connection,
            closing(self._rows(connection, kinds=normalized)) as rows,
        ):
            selected = heapq.nlargest(
                bounded_limit, rows, key=lambda row: (row["created_at"], row["event_id"])
            )
            return tuple(self._record(row) for row in reversed(selected))

    def workspace_for_sequence(
        self, session: SessionCatalogRecord, product_seq: int
    ) -> SessionCatalogRecord:
        """Resolve file authority at its originating event, never at today's cwd."""
        with closing(self._connect()) as connection:
            rows = connection.execute(
                f"SELECT * FROM {PRODUCT_EVENT_TABLE} WHERE session_id = ? AND kind = ? ORDER BY product_seq",
                (session.session_id, WORKSPACE_BOUND_EVENT),
            ).fetchall()
            materialized_rows = tuple(self._materialize(connection, rows, database=self._database))
        if not materialized_rows:
            return session
        selected = None
        for row in materialized_rows:
            event = self._record(row)
            boundary = event.payload.get("applies_from_product_seq", event.product_seq)
            if boundary <= product_seq:
                selected = event.payload
        if selected is None:
            raise ValueError(WORKSPACE_ORIGIN_UNAVAILABLE)
        return replace(
            session,
            runtime_workdir=selected["runtime_workdir"],
            project_path=selected["project_path"],
            output_root=selected["output_root"],
        )

    def bind_workspace(
        self,
        session: SessionCatalogRecord,
        *,
        initial: bool = False,
        connection: sqlite3.Connection | None = None,
    ) -> ProductEventRecord:
        payload: dict[str, Any] = {
            "runtime_workdir": session.runtime_workdir,
            "project_path": session.project_path,
            "output_root": session.output_root,
        }
        if initial:
            payload["applies_from_product_seq"] = WORKSPACE_INITIAL_SEQUENCE
        return self.append(
            session_id=session.session_id,
            runtime_id=session.runtime_id,
            vendor_thread_id=session.vendor_thread_id or "",
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=WORKSPACE_BOUND_EVENT,
            payload=payload,
            idempotency_key=f"{WORKSPACE_BOUND_EVENT}:{session.last_product_seq}:{initial}",
            connection=connection,
        )

    def append(
        self,
        *,
        session_id: str,
        runtime_id: str,
        vendor_thread_id: str,
        vendor_turn_id: str | None,
        vendor_item_id: str | None,
        kind: str,
        payload: dict[str, Any],
        idempotency_key: str,
        created_at: float | None = None,
        connection: sqlite3.Connection | None = None,
        block_store: blocks.BlockStore | None = None,
    ) -> ProductEventRecord:
        """Commit an event once and advance the catalog cursor in one transaction."""

        # Logical session events exist before the first native thread is allocated.
        # The catalog comparison below still requires the exact binding, including
        # an empty reference only while that session has never been bound.
        required = (session_id, runtime_id, kind, idempotency_key)
        if any(not value.strip() for value in required):
            raise ValueError("product event identity fields must not be empty")
        if (vendor_turn_id or vendor_item_id) and not vendor_thread_id:
            raise ValueError("native turn and item events require a native thread binding")
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        timestamp = float(created_at if created_at is not None else time.time())
        owns_transaction = connection is None
        if block_store is not None and (
            connection is None or block_store.connection is not connection
        ):
            raise ValueError("event block batch must share the event transaction")
        if connection is not None:
            validate_transaction(connection, self._database)
        connection = connection if connection is not None else self._connect()
        row: dict[str, Any] | None
        try:
            if owns_transaction:
                begin_write(connection, self._database)
            existing = self.by_key(session_id, idempotency_key, connection=connection)
            if existing is not None:
                self._assert_idempotent(
                    existing,
                    runtime_id=runtime_id,
                    vendor_thread_id=vendor_thread_id,
                    vendor_turn_id=vendor_turn_id,
                    vendor_item_id=vendor_item_id,
                    kind=kind,
                    payload=payload,
                )
                if owns_transaction:
                    connection.commit()
                return existing
            binding = connection.execute(
                f"""
                SELECT runtime_id, vendor_thread_id, last_product_seq
                FROM {SESSION_CATALOG_TABLE} WHERE session_id = ?
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
                    f"event runtime binding {expected_binding} does not match {actual_binding}"
                )
            product_seq = int(binding["last_product_seq"]) + 1
            if kind in BLOCK_EVENT_KINDS:
                sequence = connection.execute(
                    "SELECT seq FROM sqlite_sequence WHERE name=?", (PRODUCT_EVENT_TABLE,)
                ).fetchone()
                event_id = int(sequence[0]) + 1 if sequence is not None else 1
                if sequence is None:
                    connection.execute(
                        "INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)",
                        (PRODUCT_EVENT_TABLE, event_id),
                    )
                else:
                    connection.execute(
                        "UPDATE sqlite_sequence SET seq=? WHERE name=?",
                        (event_id, PRODUCT_EVENT_TABLE),
                    )
                row = dict(
                    event_id=event_id,
                    session_id=session_id,
                    runtime_id=runtime_id,
                    vendor_thread_id=vendor_thread_id,
                    vendor_turn_id=(vendor_turn_id or "").strip() or None,
                    vendor_item_id=(vendor_item_id or "").strip() or None,
                    kind=kind,
                    payload=encoded,
                    schema_version=PRODUCT_EVENT_VERSION,
                    product_seq=product_seq,
                    idempotency_key=idempotency_key,
                    created_at=timestamp,
                )
                if block_store is not None:
                    block_store.append(row)
                else:
                    with blocks.BlockStore(connection, self._database) as store:
                        store.append(row)
            else:
                with journal.Journal(connection, self._database) as bodies:
                    body_ref = bodies.put(encoded)
                cursor = connection.execute(
                    f"""
                    INSERT INTO {PRODUCT_EVENT_TABLE} (
                        session_id, runtime_id, vendor_thread_id, vendor_turn_id,
                        vendor_item_id, kind, payload, schema_version, product_seq,
                        idempotency_key, created_at, payload_ref, payload_bytes, client_turn_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        session_id,
                        runtime_id,
                        vendor_thread_id,
                        (vendor_turn_id or "").strip() or None,
                        (vendor_item_id or "").strip() or None,
                        kind,
                        "{}",
                        PRODUCT_EVENT_VERSION,
                        product_seq,
                        idempotency_key,
                        timestamp,
                        body_ref,
                        len(encoded.encode("utf-8")),
                        (
                            payload.get("client_turn_id")
                            if kind == PRODUCT_EVENT_USER_MESSAGE
                            else None
                        ),
                    ),
                )
                persisted_row = connection.execute(
                    f"SELECT * FROM {PRODUCT_EVENT_TABLE} WHERE event_id = ?", (cursor.lastrowid,)
                ).fetchone()
                row = self._one(connection, persisted_row, database=self._database)
            connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET last_product_seq = ?, updated_at = ? WHERE session_id = ?
                """,
                (product_seq, timestamp, session_id),
            )
            if kind in attention.ATTENTION_EVENT_KINDS:
                binding_event = (
                    self.latest_kind(
                        session_id,
                        PRODUCT_EVENT_USER_MESSAGE,
                        vendor_turn_id=vendor_turn_id,
                        connection=connection,
                    )
                    if vendor_turn_id
                    else None
                )
                message = (
                    self.latest_answer(session_id, vendor_turn_id, connection=connection)
                    if kind == PRODUCT_EVENT_TURN_COMPLETED and vendor_turn_id
                    else None
                )
                attention.project(
                    connection,
                    session_id=session_id,
                    kind=kind,
                    turn_id=str(vendor_turn_id or payload.get("client_turn_id") or ""),
                    item_id=message.vendor_item_id if message else vendor_item_id,
                    payload=payload,
                    source_seq=product_seq,
                    created_at=timestamp,
                    summary=str(message.payload.get("delta") or "") if message else "",
                    logical_turn_id=(
                        str(binding_event.payload.get("client_turn_id") or vendor_turn_id or "")
                        if binding_event
                        else None
                    ),
                )
            if owns_transaction:
                connection.commit()
        except Exception:
            if owns_transaction:
                connection.rollback()
            raise
        finally:
            if owns_transaction:
                connection.close()
        if row is None:
            raise RuntimeError("persisted product event disappeared")
        return self._record(row)

    def turn_records(
        self,
        session_id: str,
        client_turn_id: str,
        vendor_turn_id: str | None,
        *,
        kinds: tuple[str, ...],
        connection: sqlite3.Connection | None = None,
    ) -> tuple[ProductEventRecord, ...]:
        """Read both turn identities in the caller's transaction snapshot."""
        if not kinds:
            return ()
        with (
            self._snapshot(connection) as current,
            closing(self._rows(current, session_id=session_id, kinds=kinds)) as rows,
        ):
            return tuple(
                self._record(row)
                for row in rows
                if row["vendor_turn_id"] == client_turn_id
                or (vendor_turn_id is not None and row["vendor_turn_id"] == vendor_turn_id)
                or (
                    row["kind"] == PRODUCT_EVENT_USER_MESSAGE
                    and json.loads(row["payload"]).get("client_turn_id") == client_turn_id
                )
            )

    def by_key(
        self, session_id: str, idempotency_key: str, *, connection: sqlite3.Connection | None = None
    ) -> ProductEventRecord | None:
        """Resolve the exact original key; block summaries never establish equality."""
        with self._snapshot(connection) as current:
            row = current.execute(
                f"SELECT * FROM {PRODUCT_EVENT_TABLE} WHERE session_id=? AND idempotency_key=?",
                (session_id, idempotency_key),
            ).fetchone()
            ordinary = self._one(current, row, database=self._database)
            with blocks.BlockStore(current, self._database) as store:
                blocked = store.by_key(session_id, idempotency_key)
            if ordinary is not None and blocked is not None:
                raise ValueError("duplicate event authority across row and block")
            found = ordinary if ordinary is not None else blocked
            return self._record(found) if found is not None else None

    def turn_kind_usage(
        self,
        session_id: str,
        turn_id: str,
        kind: str,
        *,
        connection: sqlite3.Connection,
        item_slot: str | None = None,
    ) -> tuple[int, int]:
        """Count distinct logical slots and original payload bytes in one transaction."""
        validate_transaction(connection, self._database)
        slots: set[str | int] = set()
        size = 0
        with closing(
            self._rows(connection, session_id=session_id, kinds=(kind,), vendor_turn_id=turn_id)
        ) as rows:
            for row in rows:
                item = row["vendor_item_id"]
                if item is None or item != item_slot:
                    slots.add(item if item is not None else row["event_id"])
                size += len(row["payload"].encode("utf-8"))
        return len(slots), size

    def replay(
        self, session_id: str, *, after_seq: int = 0, limit: int = MAXIMUM_REPLAY_LIMIT
    ) -> tuple[ProductEventRecord, ...]:
        bounded_limit = min(MAXIMUM_REPLAY_LIMIT, max(MINIMUM_REPLAY_LIMIT, int(limit)))
        with (
            self._snapshot() as connection,
            closing(
                self._rows(connection, session_id=session_id, after_seq=max(0, int(after_seq)))
            ) as rows,
        ):
            return tuple(self._record(row) for row in islice(rows, bounded_limit))

    def by_sequence(
        self, session_id: str, product_seq: int, *, connection: sqlite3.Connection | None = None
    ) -> ProductEventRecord | None:
        with (
            self._snapshot(connection) as current,
            closing(self._rows(current, session_id=session_id, after_seq=product_seq - 1)) as rows,
        ):
            row = next(rows, None)
            return (
                self._record(row) if row is not None and row["product_seq"] == product_seq else None
            )

    def original_user_message_for_turn(
        self, session_id: str, turn_id: str
    ) -> ProductEventRecord | None:
        if not turn_id.strip():
            return None
        with (
            self._snapshot() as connection,
            closing(
                self._rows(
                    connection,
                    session_id=session_id,
                    kinds=(PRODUCT_EVENT_USER_MESSAGE,),
                    vendor_turn_id=turn_id,
                )
            ) as rows,
        ):
            records = tuple(self._record(row) for row in rows)
        for binding in (USER_MESSAGE_BINDING_BOUND, USER_MESSAGE_BINDING_ADMITTED):
            originals = [
                record
                for record in records
                if record.payload.get("origin") == USER_MESSAGE_ORIGIN_TURN
                and record.payload.get("binding") == binding
            ]
            if originals:
                return originals[0] if len(originals) == 1 else None
        return None

    def user_message_for_turn(
        self,
        session_id: str,
        vendor_turn_id: str,
    ) -> ProductEventRecord | None:
        """Return the product-owned user message bound to one vendor turn."""

        if not vendor_turn_id.strip():
            return None
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"""
                SELECT * FROM {PRODUCT_EVENT_TABLE}
                WHERE session_id = ? AND vendor_turn_id = ? AND kind = ?
                ORDER BY product_seq DESC LIMIT 1
                """,
                (session_id, vendor_turn_id, PRODUCT_EVENT_USER_MESSAGE),
            ).fetchone()
            row = self._one(connection, row, database=self._database)
        return self._record(row) if row is not None else None

    def item_events(
        self, session_id: str, *, vendor_item_id: str
    ) -> tuple[ProductEventRecord, ...]:
        """Read every bounded logical event belonging to the stable item identity."""
        if not vendor_item_id:
            return ()
        with (
            self._snapshot() as connection,
            closing(
                self._rows(connection, session_id=session_id, vendor_item_id=vendor_item_id)
            ) as rows,
        ):
            return tuple(self._record(row) for row in islice(rows, MAXIMUM_REPLAY_LIMIT))

    def turn_completed(
        self,
        session_id: str,
        *,
        vendor_turn_id: str,
    ) -> ProductEventRecord | None:
        """Return the terminal turn_completed event for a given vendor turn id."""
        if not vendor_turn_id:
            return None
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"""
                SELECT * FROM {PRODUCT_EVENT_TABLE}
                WHERE session_id = ? AND vendor_turn_id = ? AND kind = ?
                ORDER BY product_seq DESC LIMIT 1
                """,
                (session_id, vendor_turn_id, PRODUCT_EVENT_TURN_COMPLETED),
            ).fetchone()
            row = self._one(connection, row, database=self._database)
        return self._record(row) if row is not None else None

    def answer_timeline(
        self, session_id: str, *, source_product_seq: int
    ) -> tuple[ProductEventRecord, ...]:
        """Resolve the original first-delta anchor and timeline in one snapshot."""
        with self._snapshot() as connection:
            anchor = self.by_sequence(session_id, source_product_seq, connection=connection)
            if anchor is None or not anchor.vendor_turn_id or not anchor.vendor_item_id:
                return ()
            with closing(
                self._rows(
                    connection,
                    session_id=session_id,
                    kinds=(PRODUCT_EVENT_MESSAGE_DELTA,),
                    vendor_turn_id=anchor.vendor_turn_id,
                    vendor_item_id=anchor.vendor_item_id,
                )
            ) as deltas:
                first = next(deltas, None)
                if first is None or first["product_seq"] != source_product_seq:
                    return ()
            with closing(
                self._rows(
                    connection,
                    session_id=session_id,
                    after_seq=source_product_seq - 1,
                    vendor_turn_id=anchor.vendor_turn_id,
                )
            ) as rows:
                selected = (
                    row
                    for row in rows
                    if row["vendor_item_id"] == anchor.vendor_item_id
                    or row["kind"] == PRODUCT_EVENT_TURN_COMPLETED
                )
                return tuple(self._record(row) for row in islice(selected, MAXIMUM_REPLAY_LIMIT))

    def model_runs(self, session_id: str) -> dict[str, ModelRun]:
        """Recover only identities recorded during the original execution."""
        runs: dict[str, ModelRun] = {}
        sequence = 0
        while True:
            page = self.replay(session_id, after_seq=sequence, limit=MAXIMUM_REPLAY_LIMIT)
            for record in page:
                run = ModelRun.restore(record.payload.get(MODEL_RUN_FIELD))
                if run is not None and record.vendor_turn_id:
                    runs[record.vendor_turn_id] = run
            if len(page) < MAXIMUM_REPLAY_LIMIT:
                return runs
            sequence = page[-1].product_seq

    def rejected_turns(self, session_id: str, vendor_thread_id: str = "") -> frozenset[str]:
        """Read durable rejection decisions; transient service failures are not rejections."""
        rejected: set[str] = set()
        sequence = 0
        while True:
            page = self.replay(session_id, after_seq=sequence, limit=MAXIMUM_REPLAY_LIMIT)
            for record in page:
                if (
                    record.kind == PRODUCT_EVENT_TURN_FAILED
                    and str(record.payload.get("code") or "").lower() in CONTENT_REJECTION_CODES
                    and (not vendor_thread_id or record.vendor_thread_id == vendor_thread_id)
                    and record.vendor_turn_id
                ):
                    rejected.add(record.vendor_turn_id)
            if len(page) < MAXIMUM_REPLAY_LIMIT:
                return frozenset(rejected)
            sequence = page[-1].product_seq

    def inherit_history(
        self,
        source_session_id: str,
        target: SessionCatalogRecord,
        through_seq: int,
    ) -> None:
        with self.transaction() as connection:
            with closing(self._rows(connection, session_id=source_session_id)) as rows:
                for row in rows:
                    record = self._record(row)
                    if record.product_seq > through_seq:
                        break
                    if record.kind not in FORK_HISTORY_KINDS:
                        continue
                    if record.kind == PRODUCT_EVENT_USER_MESSAGE:
                        if record.payload.get("binding") == USER_MESSAGE_BINDING_CANCELLED:
                            continue
                        payload = {
                            "text": str(record.payload.get("text") or ""),
                            "client_turn_id": str(
                                record.payload.get("client_turn_id") or record.product_seq
                            ),
                            "binding": USER_MESSAGE_BINDING_BOUND,
                        }
                    elif record.kind == PRODUCT_EVENT_MESSAGE_DELTA:
                        payload = {
                            "delta": str(record.payload.get("delta") or ""),
                            "phase": record.payload.get("phase"),
                        }
                    else:
                        payload = {"status": record.payload.get("status")}
                    self.append(
                        session_id=target.session_id,
                        runtime_id=target.runtime_id,
                        vendor_thread_id=target.vendor_thread_id or "",
                        vendor_turn_id=record.vendor_turn_id,
                        vendor_item_id=record.vendor_item_id,
                        kind=record.kind,
                        payload=payload,
                        idempotency_key=f"{SESSION_FORK_KEY}:{record.product_seq}",
                        created_at=record.created_at,
                        connection=connection,
                    )

            self.append(
                session_id=target.session_id,
                runtime_id=target.runtime_id,
                vendor_thread_id=target.vendor_thread_id or "",
                vendor_turn_id=None,
                vendor_item_id=None,
                kind=SESSION_FORK_IMPORTED_EVENT,
                payload={"source_session_id": source_session_id, "source_product_seq": through_seq},
                idempotency_key=SESSION_FORK_IMPORTED_KEY,
                connection=connection,
            )

    def _continuation_budget(
        self,
        connection: sqlite3.Connection,
        session_id: str,
        *,
        remaining_events: int,
        remaining_bytes: int,
    ) -> None:
        """Bound physical reads and prefix expansion before opening body storage."""

        with closing(
            connection.execute(
                "SELECT length(CAST(event.payload AS BLOB)) AS inline_bytes, "
                "length(CAST(event.payload_ref AS BLOB)) AS reference_bytes, "
                "event.payload_ref IS NOT NULL AS referenced, "
                "event.payload_bytes IS NULL AS no_payload_size, "
                "event.client_turn_id IS NULL AS no_client_id, "
                "body.offset AS body_offset, body.length AS body_bytes, "
                "state.committed_bytes AS committed_bytes, "
                "event.payload_ref = ? || body.digest AS valid_reference "
                f"FROM {PRODUCT_EVENT_TABLE} AS event "
                f"LEFT JOIN {journal.BODY_TABLE} AS body "
                "ON body.digest = substr(event.payload_ref, length(?) + 1) "
                f"LEFT JOIN {journal.JOURNAL_TABLE} AS state ON state.singleton = ? "
                "WHERE event.session_id = ? AND event.product_seq > 0 "
                "AND event.kind IN (?, ?)",
                (
                    journal.REFERENCE_PREFIX,
                    journal.REFERENCE_PREFIX,
                    journal.SINGLETON,
                    session_id,
                    PRODUCT_EVENT_USER_MESSAGE,
                    PRODUCT_EVENT_MESSAGE_DELTA,
                ),
            )
        ) as rows:
            for metadata in rows:
                inline_bytes = metadata["inline_bytes"]
                if not isinstance(inline_bytes, int) or inline_bytes < 0:
                    raise ValueError("invalid continuation body metadata")
                body_bytes = inline_bytes
                if metadata["referenced"]:
                    physical_bytes = metadata["body_bytes"]
                    offset = metadata["body_offset"]
                    committed_bytes = metadata["committed_bytes"]
                    reference_bytes = metadata["reference_bytes"]
                    if (
                        not metadata["valid_reference"]
                        or not isinstance(physical_bytes, int)
                        or physical_bytes <= 0
                        or not isinstance(offset, int)
                        or offset < 0
                        or not isinstance(committed_bytes, int)
                        or offset + physical_bytes > committed_bytes
                        or not isinstance(reference_bytes, int)
                        or reference_bytes <= 0
                    ):
                        raise ValueError("invalid continuation journal metadata")
                    body_bytes += physical_bytes + reference_bytes
                elif not metadata["no_payload_size"] or not metadata["no_client_id"]:
                    raise ValueError("invalid continuation inline metadata")
                remaining_events -= 1
                remaining_bytes -= body_bytes
                if remaining_events < 0 or remaining_bytes < 0:
                    raise ValueError("continuation source budget exceeded")
        with closing(
            connection.execute(
                f"SELECT offset, committed_end, count FROM {blocks.TABLE} WHERE session_id = ?",
                (session_id,),
            )
        ) as rows:
            for metadata in rows:
                offset = metadata["offset"]
                committed_end = metadata["committed_end"]
                count = metadata["count"]
                if (
                    not isinstance(offset, int)
                    or offset < 0
                    or not isinstance(committed_end, int)
                    or committed_end <= offset
                    or not isinstance(count, int)
                    or not 0 < count <= blocks.MAX_EVENTS
                ):
                    raise ValueError("invalid continuation block metadata")
                remaining_events -= count
                remaining_bytes -= (committed_end - offset) * count
                if remaining_events < 0 or remaining_bytes < 0:
                    raise ValueError("continuation source budget exceeded")

    def continuation_records(
        self, session_id: str, *, through_seq: int, limit: int, byte_limit: int
    ) -> tuple[ProductEventRecord, ...]:
        """Read only product user/message bodies and completed-turn identities."""

        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or limit <= 0
            or not isinstance(byte_limit, int)
            or isinstance(byte_limit, bool)
            or byte_limit <= 0
        ):
            raise ValueError("continuation requires positive resource limits")
        with self._snapshot() as connection:
            completed = connection.execute(
                f"SELECT event_id, session_id, runtime_id, vendor_thread_id, vendor_turn_id, "
                "vendor_item_id, kind, schema_version, product_seq, idempotency_key, created_at "
                f"FROM {PRODUCT_EVENT_TABLE} WHERE session_id = ? AND kind = ? AND product_seq <= ? "
                "ORDER BY product_seq LIMIT ?",
                (session_id, PRODUCT_EVENT_TURN_COMPLETED, through_seq, limit + 1),
            ).fetchall()
            result = [self._record({**dict(row), "payload": "{}"}) for row in completed]
            if len(result) > limit:
                raise ValueError("continuation event limit exceeded")
            self._continuation_budget(
                connection,
                session_id,
                remaining_events=limit - len(result),
                remaining_bytes=byte_limit,
            )
            body_bytes = 0
            with closing(
                self._rows(
                    connection,
                    session_id=session_id,
                    kinds=(PRODUCT_EVENT_USER_MESSAGE, PRODUCT_EVENT_MESSAGE_DELTA),
                )
            ) as rows:
                for row in rows:
                    if row["product_seq"] > through_seq:
                        break
                    if len(result) >= limit:
                        raise ValueError("continuation event limit exceeded")
                    body_bytes += len(str(row["payload"]).encode("utf-8"))
                    if body_bytes > byte_limit:
                        raise ValueError("continuation body limit exceeded")
                    result.append(self._record(row))
            return tuple(sorted(result, key=lambda record: record.product_seq))

    def continuation_terminal(self, session_id: str, *, through_seq: int) -> str:
        """Read the latest terminal identity without opening any error payload."""

        kinds = (
            PRODUCT_EVENT_TURN_COMPLETED,
            PRODUCT_EVENT_TURN_FAILED,
            PRODUCT_EVENT_TURN_INTERRUPTED,
            PRODUCT_EVENT_TURN_UNKNOWN,
        )
        with self._snapshot() as connection:
            row = connection.execute(
                f"SELECT vendor_turn_id FROM {PRODUCT_EVENT_TABLE} WHERE session_id = ? "
                f"AND kind IN ({','.join('?' for _ in kinds)}) AND product_seq <= ? "
                "ORDER BY product_seq DESC LIMIT 1",
                (session_id, *kinds, through_seq),
            ).fetchone()
        return str(row["vendor_turn_id"] or "") if row is not None else ""

    def portable_history(
        self, session_id: str, *, exclude_rejected: bool = False
    ) -> tuple[HistoryEntry, ...]:
        """Project durable product messages without reading vendor-private history."""

        projected: dict[tuple[str, str, str], tuple[int, HistoryEntry]] = {}
        last_sequence = 0
        while True:
            page = self.replay(
                session_id,
                after_seq=last_sequence,
                limit=MAXIMUM_REPLAY_LIMIT,
            )
            for record in page:
                if record.kind == PRODUCT_EVENT_USER_MESSAGE:
                    binding = str(record.payload.get("binding") or "")
                    source_text = cancelled_message_text(record.payload)
                    text = (
                        CANCELLED_MESSAGE_HISTORY_PREFIX
                        + json.dumps(source_text, ensure_ascii=False)
                        if binding == USER_MESSAGE_BINDING_CANCELLED
                        else str(record.payload.get("text") or "").strip()
                    )
                    if binding == USER_MESSAGE_BINDING_CANCELLED and not source_text:
                        continue
                    client_turn_id = str(
                        record.payload.get("client_turn_id")
                        or record.vendor_item_id
                        or record.vendor_turn_id
                        or record.product_seq
                    )
                    if not text:
                        continue
                    key = ("user", client_turn_id, "")
                    existing = projected.get(key)
                    projected[key] = (
                        existing[0] if existing is not None else record.product_seq,
                        HistoryEntry(
                            role="user",
                            text=text,
                            turn_id=record.vendor_turn_id
                            or (existing[1].turn_id if existing else ""),
                            item_id=record.vendor_item_id or client_turn_id,
                        ),
                    )
                    continue
                if record.kind != PRODUCT_EVENT_MESSAGE_DELTA:
                    continue
                text = str(record.payload.get("delta") or "").strip()
                if not text:
                    continue
                turn_id = str(record.vendor_turn_id or "")
                message_id = str(record.vendor_item_id or turn_id or record.product_seq)
                key = ("assistant", turn_id, message_id)
                existing = projected.get(key)
                projected[key] = (
                    existing[0] if existing is not None else record.product_seq,
                    HistoryEntry(
                        role="assistant",
                        text=text,
                        turn_id=record.vendor_turn_id or "",
                        item_id=record.vendor_item_id or message_id,
                        phase=(
                            MessagePhase(str(record.payload["phase"]))
                            if record.payload.get("phase")
                            in {phase.value for phase in MessagePhase}
                            else MessagePhase.FINAL_ANSWER
                        ),
                    ),
                )
            if not page or len(page) < MAXIMUM_REPLAY_LIMIT:
                break
            last_sequence = page[-1].product_seq
        rejected = self.rejected_turns(session_id) if exclude_rejected else frozenset()
        return tuple(
            entry
            for _, entry in sorted(
                projected.values(),
                key=lambda item: item[0],
            )
            if entry.turn_id not in rejected
        )

    def cancelled_messages_since_bound(self, session_id: str) -> tuple[HistoryEntry, ...]:
        pending: list[HistoryEntry] = []
        sequence = 0
        while True:
            page = self.replay(session_id, after_seq=sequence, limit=MAXIMUM_REPLAY_LIMIT)
            for record in page:
                if record.kind != PRODUCT_EVENT_USER_MESSAGE:
                    continue
                binding = str(record.payload.get("binding") or "")
                if binding == USER_MESSAGE_BINDING_BOUND:
                    pending.clear()
                elif binding == USER_MESSAGE_BINDING_CANCELLED:
                    text = cancelled_message_text(record.payload)
                    if text:
                        pending.append(HistoryEntry(role="user", text=text))
            if not page or len(page) < MAXIMUM_REPLAY_LIMIT:
                return tuple(pending)
            sequence = page[-1].product_seq

    def turn_context(self, session_id: str, vendor_turn_id: str) -> dict[str, Any]:
        """Recover the context admitted for this exact native turn, never the latest selection."""

        if not vendor_turn_id:
            return {}
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"SELECT * FROM {PRODUCT_EVENT_TABLE} "
                "WHERE session_id = ? AND vendor_turn_id = ? AND kind = ? ORDER BY product_seq DESC",
                (session_id, vendor_turn_id, PRODUCT_EVENT_USER_MESSAGE),
            ).fetchall()
            materialized_rows = tuple(self._materialize(connection, rows, database=self._database))
        for row in materialized_rows:
            payload = self._record(row).payload
            if payload.get("assistant_snapshot_id"):
                return payload
        return {}
