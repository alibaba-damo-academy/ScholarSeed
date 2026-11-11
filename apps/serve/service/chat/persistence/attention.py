"""Durable reminder projection and visibility acknowledgements."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import uuid
from contextlib import closing
from enum import Enum
from typing import Any, Mapping

from service.chat.constants import (
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_INTERACTION_BLOCKING,
    PRODUCT_SESSION_STATE_FAILED,
)
from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SESSION_HIL_TABLE,
    HilStatus,
    SessionCatalogStore,
    SessionPrincipal,
)
from service.chat.persistence.utils import begin_write
from service.persistence.project import reader, sql_tokens, table_clauses

ATTENTION_TABLE = "session_attention"
ATTENTION_CLOCK_TABLE = "session_attention_clock"
ATTENTION_CLOCK_ID = 1
ATTENTION_PROJECTION_TRIGGERS = ("attention_title_changed", "attention_session_deleted")
ATTENTION_BODY_LIMIT = 240
ATTENTION_TITLE_LIMIT = 120
ATTENTION_ID_LIMIT = 500
ATTENTION_ADDITIVE_COLUMNS = {"incident_id": "TEXT"}
ATTENTION_UNREAD_INDEX = f"idx_{ATTENTION_TABLE}_unread"
ATTENTION_INDEX_SQL = (
    f"CREATE INDEX {ATTENTION_UNREAD_INDEX} ON {ATTENTION_TABLE}(session_id,revision) "
    "WHERE read_at IS NULL"
)
ATTENTION_REDACTION = "[redacted]"
ATTENTION_RECOVERY = "recovery"
ATTENTION_RECOVERY_PREFIX = f"{ATTENTION_RECOVERY}:"
ATTENTION_SUMMARY_FIELDS = (
    "intent",
    "reason",
    "body",
    "message",
    "description",
    "prompt",
    "command",
    "path",
    "title",
)
ATTENTION_SENSITIVE = re.compile(
    r"(?i)(?:bearer\s+[\w.\-]+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+)"
)


class AttentionKind(str, Enum):
    WAITING = "waiting"
    COMPLETED = "completed"
    FAILED = "failed"


ATTENTION_EVENT_KINDS = {
    PRODUCT_EVENT_HIL_REQUESTED: AttentionKind.WAITING,
    PRODUCT_EVENT_HIL_RESOLVED: AttentionKind.WAITING,
    PRODUCT_EVENT_TURN_COMPLETED: AttentionKind.COMPLETED,
    PRODUCT_EVENT_TURN_FAILED: AttentionKind.FAILED,
    PRODUCT_EVENT_SESSION_STATE: AttentionKind.FAILED,
}
ATTENTION_PENDING_STATES = frozenset((HilStatus.PENDING.value, HilStatus.UNKNOWN.value))


def recovery_blocked(payload: Mapping[str, Any]) -> bool:
    return (
        payload.get("state") == PRODUCT_SESSION_STATE_FAILED
        and payload.get("recovery_blocked") is True
        and payload.get("recovery_pending") is True
    )


def needs_initialization(connection: sqlite3.Connection) -> bool:
    objects = {
        row[0]: (row[1], row[2])
        for row in connection.execute(
            "SELECT name,type,sql FROM sqlite_master WHERE name IN (?,?,?)",
            (ATTENTION_TABLE, ATTENTION_CLOCK_TABLE, ATTENTION_UNREAD_INDEX),
        )
    }
    if not objects:
        return True
    if not {ATTENTION_TABLE, ATTENTION_CLOCK_TABLE}.issubset(objects):
        raise RuntimeError("incomplete attention schema")
    missing_columns: set[str] = set()
    with closing(sqlite3.connect(":memory:")) as reference:
        _initialize_tables(reference)
        for table in (ATTENTION_TABLE, ATTENTION_CLOCK_TABLE):
            kind, definition = objects[table]
            required = reference.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (table,)
            ).fetchone()[0]
            if table == ATTENTION_TABLE:
                columns = {row[1] for row in connection.execute(f"PRAGMA table_xinfo({table})")}
                missing_columns = ATTENTION_ADDITIVE_COLUMNS.keys() - columns
            required_clauses = {
                clause
                for clause in table_clauses(required, table)
                if table != ATTENTION_TABLE or clause[0] not in missing_columns
            }
            if kind != "table" or not required_clauses.issubset(table_clauses(definition, table)):
                raise RuntimeError("unsupported attention schema")
    if ATTENTION_UNREAD_INDEX not in objects:
        return True
    kind, definition = objects[ATTENTION_UNREAD_INDEX]
    if kind != "index" or sql_tokens(definition) != sql_tokens(ATTENTION_INDEX_SQL):
        raise RuntimeError("unsupported attention index")
    triggers = {
        row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='trigger'")
    }
    catalog_exists = (
        connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (SESSION_CATALOG_TABLE,)
        ).fetchone()
        is not None
    )
    return bool(missing_columns) or (
        catalog_exists and not set(ATTENTION_PROJECTION_TRIGGERS).issubset(triggers)
    )


def inspect_clock(connection: sqlite3.Connection) -> None:
    clock = connection.execute(
        f"SELECT epoch,revision FROM {ATTENTION_CLOCK_TABLE} WHERE singleton=?",
        (ATTENTION_CLOCK_ID,),
    ).fetchone()
    if clock is None or not clock[0] or not isinstance(clock[1], int) or clock[1] < 0:
        raise RuntimeError("invalid attention clock")


def _initialize_tables(connection: sqlite3.Connection) -> None:
    connection.execute(f"""CREATE TABLE IF NOT EXISTS {ATTENTION_CLOCK_TABLE} (
            singleton INTEGER PRIMARY KEY CHECK(singleton = {ATTENTION_CLOCK_ID}),
            epoch TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0
        )""")
    connection.execute(
        f"INSERT OR IGNORE INTO {ATTENTION_CLOCK_TABLE}(singleton,epoch) VALUES (?,?)",
        (ATTENTION_CLOCK_ID, str(uuid.uuid4())),
    )
    connection.execute(f"""CREATE TABLE IF NOT EXISTS {ATTENTION_TABLE} (
            attention_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES {SESSION_CATALOG_TABLE}(session_id) ON DELETE CASCADE,
            identity TEXT NOT NULL,
            kind TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            request_id TEXT,
            incident_id TEXT,
            item_id TEXT,
            body TEXT NOT NULL,
            source_seq INTEGER NOT NULL,
            created_at REAL NOT NULL,
            revision INTEGER NOT NULL,
            read_at REAL,
            UNIQUE(session_id, identity)
        )""")
    columns = {row[1] for row in connection.execute(f"PRAGMA table_xinfo({ATTENTION_TABLE})")}
    for name, definition in ATTENTION_ADDITIVE_COLUMNS.items():
        if name not in columns:
            connection.execute(f"ALTER TABLE {ATTENTION_TABLE} ADD COLUMN {name} {definition}")
    connection.execute(ATTENTION_INDEX_SQL.replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS", 1))


def initialize(connection: sqlite3.Connection) -> None:
    _initialize_tables(connection)
    if (
        connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (SESSION_CATALOG_TABLE,)
        ).fetchone()
        is None
    ):
        return
    connection.execute(
        f"CREATE TRIGGER IF NOT EXISTS {ATTENTION_PROJECTION_TRIGGERS[0]} "
        f"AFTER UPDATE OF title,title_fallback ON {SESSION_CATALOG_TABLE} "
        "WHEN (NEW.title IS NOT OLD.title OR NEW.title_fallback IS NOT OLD.title_fallback) "
        f"AND EXISTS (SELECT 1 FROM {ATTENTION_TABLE} WHERE session_id=NEW.session_id AND read_at IS NULL) "
        f"BEGIN UPDATE {ATTENTION_CLOCK_TABLE} SET revision=revision+1 "
        f"WHERE singleton={ATTENTION_CLOCK_ID}; END"
    )
    connection.execute(
        f"CREATE TRIGGER IF NOT EXISTS {ATTENTION_PROJECTION_TRIGGERS[1]} "
        f"BEFORE DELETE ON {SESSION_CATALOG_TABLE} "
        f"WHEN EXISTS (SELECT 1 FROM {ATTENTION_TABLE} WHERE session_id=OLD.session_id AND read_at IS NULL) "
        f"BEGIN UPDATE {ATTENTION_CLOCK_TABLE} SET revision=revision+1 "
        f"WHERE singleton={ATTENTION_CLOCK_ID}; END"
    )


def safe_text(value: object, limit: int = ATTENTION_BODY_LIMIT) -> str:
    if not isinstance(value, str):
        return ""
    value = ATTENTION_SENSITIVE.sub(ATTENTION_REDACTION, value)
    return " ".join(value.split())[:limit]


def request_summary(payload: Mapping[str, Any]) -> str:
    questions = payload.get("questions")
    if isinstance(questions, list):
        for question in questions:
            if isinstance(question, Mapping):
                summary = safe_text(question.get("question") or question.get("header"))
                if summary:
                    return summary
    for field in ATTENTION_SUMMARY_FIELDS:
        if payload.get(field) == payload.get("method"):
            continue
        summary = safe_text(payload.get(field))
        if summary:
            return summary
    return ""


def project(
    connection: sqlite3.Connection,
    *,
    session_id: str,
    kind: str,
    turn_id: str,
    item_id: str | None,
    payload: Mapping[str, Any],
    source_seq: int,
    created_at: float,
    summary: str = "",
    logical_turn_id: str | None = None,
) -> None:
    reminder_kind = ATTENTION_EVENT_KINDS.get(kind)
    if kind == PRODUCT_EVENT_HIL_REQUESTED and payload.get(PRODUCT_INTERACTION_BLOCKING) is False:
        return
    if reminder_kind is None:
        return
    blocked = kind == PRODUCT_EVENT_SESSION_STATE
    if blocked and not recovery_blocked(payload):
        return
    request_id = str(payload.get("request_id") or "").strip() or None
    if reminder_kind is AttentionKind.WAITING:
        if request_id is None:
            return
        stored = connection.execute(
            f"SELECT status FROM {SESSION_HIL_TABLE} WHERE session_id=? AND product_request_id=?",
            (session_id, request_id),
        ).fetchone()
        state = payload.get("state") or HilStatus.PENDING.value
        if (
            kind == PRODUCT_EVENT_HIL_RESOLVED
            or state not in ATTENTION_PENDING_STATES
            or (stored is not None and stored[0] not in ATTENTION_PENDING_STATES)
        ):
            changed = connection.execute(
                f"DELETE FROM {ATTENTION_TABLE} WHERE session_id=? AND request_id=? AND kind=?",
                (session_id, request_id, AttentionKind.WAITING.value),
            ).rowcount
            if changed:
                connection.execute(
                    f"UPDATE {ATTENTION_CLOCK_TABLE} SET revision=revision+1 WHERE singleton=?",
                    (ATTENTION_CLOCK_ID,),
                )
            return
        identity = f"request:{request_id}"
        summary = request_summary(payload)
    else:
        if not turn_id:
            return
        identity = (
            f"{ATTENTION_RECOVERY_PREFIX}{logical_turn_id or turn_id}:{payload.get('incident_id') or turn_id}"
            if blocked
            else f"terminal:{logical_turn_id or turn_id}"
        )
        if reminder_kind is AttentionKind.FAILED:
            summary = safe_text(payload.get("reason") if blocked else payload.get("message"))
    if connection.execute(
        f"SELECT 1 FROM {ATTENTION_TABLE} WHERE session_id=? AND identity=?",
        (session_id, identity),
    ).fetchone():
        return
    connection.execute(
        f"UPDATE {ATTENTION_CLOCK_TABLE} SET revision=revision+1 WHERE singleton=?",
        (ATTENTION_CLOCK_ID,),
    )
    revision = connection.execute(
        f"SELECT revision FROM {ATTENTION_CLOCK_TABLE} WHERE singleton=?", (ATTENTION_CLOCK_ID,)
    ).fetchone()[0]
    connection.execute(
        f"""INSERT INTO {ATTENTION_TABLE} (
            attention_id,session_id,identity,kind,turn_id,request_id,item_id,body,
            source_seq,created_at,revision,incident_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            str(uuid.uuid4()),
            session_id,
            identity,
            reminder_kind.value,
            turn_id,
            request_id,
            item_id,
            safe_text(summary),
            source_seq,
            created_at,
            revision,
            str(payload.get("incident_id") or turn_id) if blocked else None,
        ),
    )


class AttentionStore:
    def __init__(self, catalog: SessionCatalogStore) -> None:
        self._catalog = catalog
        self._database = catalog.database

    def _scope(self, principal: SessionPrincipal) -> tuple[str, tuple[str, ...]]:
        return self._catalog.owned_session_query(principal)

    def _epoch(self, connection: sqlite3.Connection, principal: SessionPrincipal) -> str:
        epoch = connection.execute(
            f"SELECT epoch FROM {ATTENTION_CLOCK_TABLE} WHERE singleton=?", (ATTENTION_CLOCK_ID,)
        ).fetchone()[0]
        scope = json.dumps(self._scope(principal), ensure_ascii=False)
        return hashlib.sha256(f"{epoch}:{scope}".encode()).hexdigest()

    def _snapshot(
        self, connection: sqlite3.Connection, principal: SessionPrincipal
    ) -> dict[str, Any]:
        query, parameters = self._scope(principal)
        rows = connection.execute(
            f"""SELECT reminder.*, catalog.title, catalog.title_fallback FROM {ATTENTION_TABLE} reminder
                JOIN {SESSION_CATALOG_TABLE} catalog USING(session_id)
                WHERE reminder.read_at IS NULL AND reminder.session_id IN ({query})
                ORDER BY reminder.revision""",
            parameters,
        ).fetchall()
        items = [self._item(row) for row in rows]
        by_session: dict[str, int] = {}
        for item in items:
            session_id = item["session_id"]
            by_session[session_id] = by_session.get(session_id, 0) + 1
        revision = connection.execute(
            f"SELECT revision FROM {ATTENTION_CLOCK_TABLE} WHERE singleton=?", (ATTENTION_CLOCK_ID,)
        ).fetchone()[0]
        return {
            "epoch": self._epoch(connection, principal),
            "revision": revision,
            "unread_count": len(items),
            "by_session": by_session,
            "items": items,
        }

    @staticmethod
    def _item(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["attention_id"],
            "session_id": row["session_id"],
            "kind": row["kind"],
            "anchor_kind": (
                ATTENTION_RECOVERY
                if row["identity"].startswith(ATTENTION_RECOVERY_PREFIX)
                else row["kind"]
            ),
            "turn_id": row["turn_id"],
            "request_id": row["request_id"],
            "incident_id": row["incident_id"],
            "item_id": row["item_id"],
            "title": safe_text(row["title"], ATTENTION_TITLE_LIMIT),
            "body": row["body"],
            "title_fallback": row["title_fallback"],
            "created_at": row["created_at"],
            "revision": row["revision"],
            "source_seq": row["source_seq"],
        }

    def snapshot(self, principal: SessionPrincipal) -> dict[str, Any]:
        with reader(self._database) as connection:
            connection.execute("BEGIN")
            return self._snapshot(connection, principal)

    def get(self, principal: SessionPrincipal, identity: str) -> dict[str, Any] | None:
        query, parameters = self._scope(principal)
        with reader(self._database) as connection:
            row = connection.execute(
                f"""SELECT reminder.*, catalog.title, catalog.title_fallback FROM {ATTENTION_TABLE} reminder
                    JOIN {SESSION_CATALOG_TABLE} catalog USING(session_id)
                    WHERE reminder.attention_id=? AND reminder.session_id IN ({query})""",
                (identity, *parameters),
            ).fetchone()
            return self._item(row) if row else None

    def read(
        self,
        principal: SessionPrincipal,
        *,
        through_revision: int,
        epoch: str | None = None,
        ids: tuple[str, ...] | None = None,
    ) -> dict[str, Any]:
        if through_revision < 0 or (ids is not None and len(ids) > ATTENTION_ID_LIMIT):
            raise ValueError("invalid attention acknowledgement")
        query, parameters = self._scope(principal)
        with closing(self._catalog._connect()) as connection:
            connection.row_factory = sqlite3.Row
            begin_write(connection, self._database)
            if epoch is not None and epoch != self._epoch(connection, principal):
                raise ValueError("attention epoch changed")
            clauses = ["read_at IS NULL", "revision<=?", f"session_id IN ({query})"]
            values: list[Any] = [time.time(), through_revision, *parameters]
            if ids is not None:
                clauses.append(f"attention_id IN ({','.join('?' for _ in ids)})")
                values.extend(ids)
            changed = connection.execute(
                f"UPDATE {ATTENTION_TABLE} SET read_at=? WHERE {' AND '.join(clauses)}",
                values,
            ).rowcount
            if changed:
                connection.execute(
                    f"UPDATE {ATTENTION_CLOCK_TABLE} SET revision=revision+1 WHERE singleton=?",
                    (ATTENTION_CLOCK_ID,),
                )
            snapshot = self._snapshot(connection, principal)
            connection.commit()
            return snapshot
