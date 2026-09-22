"""Durable, session-scoped product event log."""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import closing, contextmanager, nullcontext
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Iterator, Sequence

from scholarseed_runtime.contract.history import HistoryEntry, MessagePhase
from service.chat.constants import (
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_EVENT_VERSION,
    PRODUCT_EVENT_VERSION_V1,
)
from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SQLITE_TIMEOUT_SECONDS,
    SessionBindingConflictError,
    SessionCatalogRecord,
    SessionStateConflictError,
)
from service.chat.persistence.utils import validate_transaction
from service.chat.provenance import MODEL_RUN_FIELD, ModelRun
from service.paths import SESSION_CATALOG_DB

PRODUCT_EVENT_TABLE = "product_event"
PRODUCT_EVENT_MIGRATION_TABLE = "product_event_migration"
PRODUCT_EVENT_SCHEMA_COLUMN = "schema_version"
MINIMUM_REPLAY_LIMIT = 1
MAXIMUM_REPLAY_LIMIT = 10_000
MAXIMUM_RECENT_EVENT_LIMIT = 20_000
WORKSPACE_BOUND_EVENT = "session.workspace.bound"
WORKSPACE_INITIAL_SEQUENCE = 0
WORKSPACE_ORIGIN_UNAVAILABLE = "session_workspace_origin_unavailable"
CONTENT_REJECTION_CODES = frozenset(
    {"content_safety_blocked", "content_policy_violation", "content_filter"}
)


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


def upcast_product_event(
    record: ProductEventRecord,
    target_version: int = PRODUCT_EVENT_VERSION,
) -> ProductEventRecord:
    """Purely upgrade one durable event without rewriting the journal row.

    ProductEvent v2 makes the persisted schema version authoritative.  Its payload
    vocabulary is intentionally identical to v1, so the first upcast changes only
    the envelope version.  Future migrations extend this explicit step chain.
    """

    if target_version != PRODUCT_EVENT_VERSION:
        raise ProductEventSchemaError(f"unsupported product event target v{target_version}")
    if record.schema_version == PRODUCT_EVENT_VERSION:
        return record
    if record.schema_version == PRODUCT_EVENT_VERSION_V1:
        return replace(record, schema_version=PRODUCT_EVENT_VERSION, payload=dict(record.payload))
    raise ProductEventSchemaError(
        f"product event v{record.schema_version} cannot be upgraded to v{target_version}"
    )


class ProductEventStore:
    """Allocate monotonic per-session sequence numbers and retain replay history."""

    def __init__(self, database: Path | None = None) -> None:
        self._database = Path(database or SESSION_CATALOG_DB)
        self._database.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection, connection:
            self._create_event_table(connection)
            self._ensure_schema_version(connection)
            self._repair_event_foreign_key(connection)
            connection.execute(
                f"CREATE INDEX IF NOT EXISTS idx_{PRODUCT_EVENT_TABLE}_replay "
                f"ON {PRODUCT_EVENT_TABLE}(session_id, product_seq)"
            )
            connection.execute(
                f"CREATE INDEX IF NOT EXISTS idx_{PRODUCT_EVENT_TABLE}_kind_recent "
                f"ON {PRODUCT_EVENT_TABLE}(kind, created_at DESC, event_id DESC)"
            )

    @classmethod
    def _create_event_table(cls, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
                CREATE TABLE IF NOT EXISTS {PRODUCT_EVENT_TABLE} (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    runtime_id TEXT NOT NULL,
                    vendor_thread_id TEXT NOT NULL,
                    vendor_turn_id TEXT,
                    vendor_item_id TEXT,
                    kind TEXT NOT NULL,
                    payload TEXT NOT NULL,
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

    @classmethod
    def _repair_event_foreign_key(cls, connection: sqlite3.Connection) -> None:
        rows = connection.execute(f"PRAGMA foreign_key_list({PRODUCT_EVENT_TABLE})").fetchall()
        targets = {str(row["table"]) for row in rows}
        if not targets or targets == {SESSION_CATALOG_TABLE}:
            return
        connection.execute("PRAGMA foreign_keys = OFF")
        try:
            connection.execute(f"DROP TABLE IF EXISTS {PRODUCT_EVENT_MIGRATION_TABLE}")
            connection.execute(
                f"ALTER TABLE {PRODUCT_EVENT_TABLE} RENAME TO {PRODUCT_EVENT_MIGRATION_TABLE}"
            )
            cls._create_event_table(connection)
            connection.execute(f"""
                INSERT INTO {PRODUCT_EVENT_TABLE} (
                    event_id, session_id, runtime_id, vendor_thread_id, vendor_turn_id,
                    vendor_item_id, kind, payload, schema_version, product_seq,
                    idempotency_key, created_at
                )
                SELECT
                    event_id, session_id, runtime_id, vendor_thread_id, vendor_turn_id,
                    vendor_item_id, kind, payload, schema_version, product_seq,
                    idempotency_key, created_at
                FROM {PRODUCT_EVENT_MIGRATION_TABLE}
                """)
            connection.execute(f"DROP TABLE {PRODUCT_EVENT_MIGRATION_TABLE}")
        finally:
            connection.execute("PRAGMA foreign_keys = ON")

    @property
    def database(self) -> Path:
        return self._database

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
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

    @staticmethod
    def _optional(row: sqlite3.Row, name: str) -> str | None:
        return str(row[name] or "").strip() or None

    @classmethod
    def _record(cls, row: sqlite3.Row) -> ProductEventRecord:
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
            schema_version=int(row[PRODUCT_EVENT_SCHEMA_COLUMN]),
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
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def latest_kind(
        self, session_id: str, kind: str, *, connection: sqlite3.Connection | None = None
    ) -> ProductEventRecord | None:
        """Read a policy/state event without truncating a long session's replay."""
        owned = connection is None
        connection = connection if connection is not None else self._connect()
        try:
            row = connection.execute(
                f"SELECT * FROM {PRODUCT_EVENT_TABLE} WHERE session_id = ? AND kind = ? "
                "ORDER BY product_seq DESC LIMIT 1",
                (session_id, kind),
            ).fetchone()
            return self._record(row) if row is not None else None
        finally:
            if owned:
                connection.close()

    def sessions_with_kind(self, kind: str) -> tuple[str, ...]:
        """Enumerate explicit owners of an event category for lifecycle maintenance."""
        connection = self._connect()
        try:
            return tuple(
                str(row[0])
                for row in connection.execute(
                    f"SELECT DISTINCT session_id FROM {PRODUCT_EVENT_TABLE} WHERE kind = ?", (kind,)
                )
            )
        finally:
            connection.close()

    def recent_kinds(
        self,
        kinds: Sequence[str],
        *,
        limit: int = MAXIMUM_REPLAY_LIMIT,
    ) -> tuple[ProductEventRecord, ...]:
        """Read recent durable events across sessions for product-level analytics."""

        normalized = tuple(dict.fromkeys(kind.strip() for kind in kinds if kind.strip()))
        if not normalized:
            return ()
        bounded_limit = max(MINIMUM_REPLAY_LIMIT, min(int(limit), MAXIMUM_RECENT_EVENT_LIMIT))
        placeholders = ", ".join("?" for _ in normalized)
        with closing(self._connect()) as connection:
            rows = connection.execute(
                f"SELECT * FROM {PRODUCT_EVENT_TABLE} "
                f"WHERE kind IN ({placeholders}) ORDER BY created_at DESC, event_id DESC LIMIT ?",
                (*normalized, bounded_limit),
            ).fetchall()
        return tuple(reversed(tuple(self._record(row) for row in rows)))

    def workspace_for_sequence(
        self, session: SessionCatalogRecord, product_seq: int
    ) -> SessionCatalogRecord:
        """Resolve file authority at its originating event, never at today's cwd."""
        with closing(self._connect()) as connection:
            rows = connection.execute(
                f"SELECT * FROM {PRODUCT_EVENT_TABLE} WHERE session_id = ? AND kind = ? ORDER BY product_seq",
                (session.session_id, WORKSPACE_BOUND_EVENT),
            ).fetchall()
        if not rows:
            return session
        selected = None
        for row in rows:
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
        if connection is not None:
            validate_transaction(connection, self._database)
        connection = connection if connection is not None else self._connect()
        try:
            if owns_transaction:
                connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                f"""
                SELECT * FROM {PRODUCT_EVENT_TABLE}
                WHERE session_id = ? AND idempotency_key = ?
                """,
                (session_id, idempotency_key),
            ).fetchone()
            if row is not None:
                existing = self._record(row)
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
            cursor = connection.execute(
                f"""
                INSERT INTO {PRODUCT_EVENT_TABLE} (
                    session_id, runtime_id, vendor_thread_id, vendor_turn_id,
                    vendor_item_id, kind, payload, schema_version, product_seq,
                    idempotency_key, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    runtime_id,
                    vendor_thread_id,
                    (vendor_turn_id or "").strip() or None,
                    (vendor_item_id or "").strip() or None,
                    kind,
                    encoded,
                    PRODUCT_EVENT_VERSION,
                    product_seq,
                    idempotency_key,
                    timestamp,
                ),
            )
            connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET last_product_seq = ?, updated_at = ? WHERE session_id = ?
                """,
                (product_seq, timestamp, session_id),
            )
            row = connection.execute(
                f"SELECT * FROM {PRODUCT_EVENT_TABLE} WHERE event_id = ?",
                (cursor.lastrowid,),
            ).fetchone()
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
        """Read both turn identities and conflicting client bindings in one snapshot."""

        if not kinds:
            return ()
        if connection is not None:
            validate_transaction(connection, self._database)
        placeholders = ",".join("?" for _ in kinds)
        with (
            nullcontext(connection) if connection is not None else closing(self._connect())
        ) as read_connection:
            rows = read_connection.execute(
                f"""
                SELECT * FROM {PRODUCT_EVENT_TABLE}
                WHERE session_id = ? AND kind IN ({placeholders}) AND (
                    vendor_turn_id IN (?, ?) OR
                    (kind = ? AND json_extract(payload, '$.client_turn_id') = ?)
                ) ORDER BY product_seq
                """,
                (
                    session_id,
                    *kinds,
                    client_turn_id,
                    vendor_turn_id,
                    PRODUCT_EVENT_USER_MESSAGE,
                    client_turn_id,
                ),
            ).fetchall()
        return tuple(self._record(row) for row in rows)

    def by_key(
        self,
        session_id: str,
        idempotency_key: str,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> ProductEventRecord | None:
        """Read a committed event without reinterpreting its original runtime binding."""
        if connection is not None:
            validate_transaction(connection, self._database)
            row = connection.execute(
                f"SELECT * FROM {PRODUCT_EVENT_TABLE} WHERE session_id = ? AND idempotency_key = ?",
                (session_id, idempotency_key),
            ).fetchone()
            return self._record(row) if row is not None else None
        with closing(self._connect()) as owned_connection, owned_connection:
            row = owned_connection.execute(
                f"SELECT * FROM {PRODUCT_EVENT_TABLE} WHERE session_id = ? AND idempotency_key = ?",
                (session_id, idempotency_key),
            ).fetchone()
        return self._record(row) if row is not None else None

    def turn_kind_usage(
        self,
        session_id: str,
        turn_id: str,
        kind: str,
        *,
        connection: sqlite3.Connection,
    ) -> tuple[int, int]:
        """Return committed item count and UTF-8 payload bytes inside one transaction."""

        validate_transaction(connection, self._database)
        row = connection.execute(
            f"""
            SELECT COUNT(*) AS item_count,
                   COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS byte_count
            FROM {PRODUCT_EVENT_TABLE}
            WHERE session_id = ? AND vendor_turn_id = ? AND kind = ?
            """,
            (session_id, turn_id, kind),
        ).fetchone()
        return (int(row["item_count"]), int(row["byte_count"]))

    def replay(
        self,
        session_id: str,
        *,
        after_seq: int = 0,
        limit: int = MAXIMUM_REPLAY_LIMIT,
    ) -> tuple[ProductEventRecord, ...]:
        bounded_limit = min(MAXIMUM_REPLAY_LIMIT, max(MINIMUM_REPLAY_LIMIT, int(limit)))
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {PRODUCT_EVENT_TABLE}
                WHERE session_id = ? AND product_seq > ?
                ORDER BY product_seq LIMIT ?
                """,
                (session_id, max(0, int(after_seq)), bounded_limit),
            ).fetchall()
        return tuple(self._record(row) for row in rows)

    def by_sequence(self, session_id: str, product_seq: int) -> ProductEventRecord | None:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"""
                SELECT * FROM {PRODUCT_EVENT_TABLE}
                WHERE session_id = ? AND product_seq = ?
                """,
                (session_id, product_seq),
            ).fetchone()
        return self._record(row) if row is not None else None

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
        return self._record(row) if row is not None else None

    def item_events(
        self,
        session_id: str,
        *,
        vendor_item_id: str,
    ) -> tuple[ProductEventRecord, ...]:
        """Return every product event carrying the given vendor item id.

        Used by callers that identify a message by its stable item id (agent
        answer, reasoning, tool) instead of by a specific product delta seq.
        """
        if not vendor_item_id:
            return ()
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {PRODUCT_EVENT_TABLE}
                WHERE session_id = ? AND vendor_item_id = ?
                ORDER BY product_seq
                LIMIT ?
                """,
                (session_id, vendor_item_id, MAXIMUM_REPLAY_LIMIT),
            ).fetchall()
        return tuple(self._record(row) for row in rows)

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
        return self._record(row) if row is not None else None

    def answer_timeline(
        self,
        session_id: str,
        *,
        source_product_seq: int,
    ) -> tuple[ProductEventRecord, ...]:
        """Return the bounded item/turn timeline anchored by one product delta."""

        anchor = self.by_sequence(session_id, source_product_seq)
        if anchor is None or not anchor.vendor_turn_id or not anchor.vendor_item_id:
            return ()
        with closing(self._connect()) as connection, connection:
            first = connection.execute(
                f"""
                SELECT MIN(product_seq) AS product_seq FROM {PRODUCT_EVENT_TABLE}
                WHERE session_id = ? AND vendor_turn_id = ? AND vendor_item_id = ? AND kind = ?
                """,
                (
                    session_id,
                    anchor.vendor_turn_id,
                    anchor.vendor_item_id,
                    PRODUCT_EVENT_MESSAGE_DELTA,
                ),
            ).fetchone()
            if first is None or int(first["product_seq"] or 0) != source_product_seq:
                return ()
            rows = connection.execute(
                f"""
                SELECT * FROM {PRODUCT_EVENT_TABLE}
                WHERE session_id = ? AND vendor_turn_id = ? AND product_seq >= ?
                  AND (vendor_item_id = ? OR kind = ?)
                ORDER BY product_seq
                LIMIT ?
                """,
                (
                    session_id,
                    anchor.vendor_turn_id,
                    source_product_seq,
                    anchor.vendor_item_id,
                    PRODUCT_EVENT_TURN_COMPLETED,
                    MAXIMUM_REPLAY_LIMIT,
                ),
            ).fetchall()
        return tuple(self._record(row) for row in rows)

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
                    text = str(record.payload.get("text") or "").strip()
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
                        phase=MessagePhase.FINAL_ANSWER,
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
        for row in rows:
            payload = self._record(row).payload
            if payload.get("assistant_snapshot_id"):
                return payload
        return {}
