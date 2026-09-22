"""Durable product-session catalog and human-interaction state."""

from __future__ import annotations

import dataclasses
import json
import math
import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Sequence

from scholarseed_runtime.contract import (
    CapabilitySet,
    CapabilityState,
    ModelThinking,
    RuntimeBinding,
    RuntimeCapability,
    RuntimeCapabilityName,
)
from scholarseed_runtime.contract.history import HistoryEntry, MessagePhase
from service.chat.constants import PRODUCT_TURN_OUTCOME_INTERRUPTED, SessionTitleFallback
from service.chat.persistence.utils import validate_transaction
from service.paths import SESSION_CATALOG_DB

SESSION_CATALOG_TABLE = "session_catalog"
SESSION_HIL_TABLE = "session_hil"
SESSION_UNCERTAINTY_TABLE = "session_uncertainty"
SESSION_MODEL_TABLE = "session_model_state"
# 开关/预算形态的思考选择按结构化 JSON 存这两列；NULL 表示「没选」。
SESSION_THINKING_COLUMNS = ("selected_thinking_json", "active_thinking_json")


SESSION_PORTABLE_HISTORY_TABLE = "session_portable_history"
SESSION_RUNTIME_BINDING_TABLE = "session_runtime_binding"
SESSION_MESSAGE_QUEUE_TABLE = "session_message_queue"
SESSION_ACTIVATION_TABLE = "session_activation"
QUEUE_PURPOSE_TURN = "turn"
QUEUE_RECOVERY_UNKNOWN_ERROR = "runtime_submission_outcome_unknown"
QUEUE_RECOVERY_WAIT_INTERRUPTED = "runtime_resource_wait_interrupted"
INITIAL_ATTACHMENT_GENERATION = 0
PORTABLE_HISTORY_ROLES = frozenset(("user", "assistant"))
LEGACY_SESSION_TABLE = "session_access"
LEGACY_RUNTIME_ID = "legacy_damoagent"
SQLITE_TIMEOUT_SECONDS = 30.0
MAX_PERSISTED_TODOS = 200
MAX_QUEUED_MESSAGES_PER_SESSION = 100
INITIAL_PRODUCT_SEQUENCE = 0
# 共享归属下归属谓词退化成恒真。用它而不是拼接空串, 是为了让所有归属 SQL 保持同一种
# "WHERE ... AND {condition}" 形状, 不必为每处再写一遍分支。
SQL_CONDITION_ALWAYS_TRUE = "1 = 1"

CATALOG_COLUMNS = frozenset(
    {
        "session_id",
        "principal_id",
        "runtime_id",
        "vendor_thread_id",
        "vendor_session_id",
        "runtime_workdir",
        "project_path",
        "output_root",
        "codex_version",
        "model_id",
        "policy_id",
        "status",
        "last_turn_id",
        "last_turn_status",
        "last_product_seq",
        "title",
        "todos",
        "todo_turn_id",
        "todo_product_seq",
        "todo_explanation",
        "created_at",
        "updated_at",
    }
)


class SessionStatus(str, Enum):
    """Persisted product-session lifecycle states."""

    READY = "ready"
    RUNNING = "running"
    WAITING_HIL = "waiting_hil"
    COMPLETED = "completed"
    INTERRUPTED = "interrupted"
    ERROR = "error"
    CLOSED = "closed"
    LEGACY_READONLY = "legacy_readonly"


CATALOG_ADDITIVE_COLUMNS = {
    "runtime_id": f"TEXT NOT NULL DEFAULT '{LEGACY_RUNTIME_ID}'",
    "vendor_thread_id": "TEXT",
    "vendor_session_id": "TEXT",
    "runtime_workdir": "TEXT NOT NULL DEFAULT ''",
    "project_path": "TEXT",
    "output_root": "TEXT NOT NULL DEFAULT ''",
    "codex_version": "TEXT",
    "model_id": "TEXT",
    "policy_id": "TEXT",
    "status": f"TEXT NOT NULL DEFAULT '{SessionStatus.LEGACY_READONLY.value}'",
    "last_turn_id": "TEXT",
    "last_turn_status": "TEXT",
    "last_product_seq": "INTEGER NOT NULL DEFAULT 0",
    "title": "TEXT NOT NULL DEFAULT ''",
    "title_fallback": "TEXT",
    "todos": "TEXT NOT NULL DEFAULT '[]'",
    "todo_turn_id": "TEXT",
    "todo_product_seq": "INTEGER NOT NULL DEFAULT 0",
    "todo_explanation": "TEXT",
    "updated_at": "REAL NOT NULL DEFAULT 0",
}


class SessionListScope(str, Enum):
    """Project membership boundary applied before catalog pagination."""

    ALL = "all"
    PROJECT = "project"
    UNASSIGNED = "unassigned"


class HilStatus(str, Enum):
    """Durable HIL request states."""

    PENDING = "pending"
    RESOLVED = "resolved"
    EXPIRED = "expired"
    UNKNOWN = "unknown"
    STALE = "stale"


class UncertaintyKind(str, Enum):
    """Durable correlations whose write outcome must never be guessed."""

    TURN = "turn"
    HIL_RESPONSE = "hil_response"
    TOOL_RESPONSE = "tool_response"


class UncertaintyState(str, Enum):
    """Monotonic delivery/reconciliation state for one uncertain operation."""

    EXECUTING = "executing"
    UNKNOWN = "unknown"
    STALE = "stale"
    RECONCILED = "reconciled"
    CONFIRMED = "confirmed"


class QueuedMessageState(str, Enum):
    QUEUED = "queued"
    WAITING_RESOURCES = "waiting_resources"
    SUBMITTING = "submitting"
    RUNNING = "running"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"
    OUTCOME_UNKNOWN = "outcome_unknown"


QUEUE_PENDING_STATES = (
    QueuedMessageState.QUEUED,
    QueuedMessageState.WAITING_RESOURCES,
    QueuedMessageState.SUBMITTING,
    QueuedMessageState.FAILED,
    QueuedMessageState.OUTCOME_UNKNOWN,
)
QUEUE_CAPACITY_STATES = (*QUEUE_PENDING_STATES, QueuedMessageState.RUNNING)
QUEUE_SUBMITTABLE_STATES = (
    QueuedMessageState.QUEUED,
    QueuedMessageState.WAITING_RESOURCES,
    QueuedMessageState.FAILED,
)
QUEUE_COMPLETABLE_STATES = (QueuedMessageState.SUBMITTING, QueuedMessageState.RUNNING)
QUEUE_REJECTABLE_STATES = (
    QueuedMessageState.QUEUED,
    QueuedMessageState.WAITING_RESOURCES,
    QueuedMessageState.SUBMITTING,
)
QUEUE_ADDITIVE_COLUMNS = {
    "deadline": "REAL",
    "purpose": f"TEXT NOT NULL DEFAULT '{QUEUE_PURPOSE_TURN}'",
    "native_turn_id": "TEXT NOT NULL DEFAULT ''",
}
CATALOG_FOREIGN_KEY_MIGRATION_SUFFIX = "_foreign_key_migration"


class OpenState(str, Enum):
    NEVER_STARTED = "never_started"
    OPENING = "opening"
    OPEN_UNKNOWN = "open_unknown"
    BOUND = "bound"


@dataclass(frozen=True)
class ActivationRecord:
    session_id: str
    open_state: OpenState
    open_attempt_id: str
    generation: int
    required_capabilities: tuple[RuntimeCapabilityName, ...]


@dataclass(frozen=True)
class QueuedMessageRecord:
    queued_message_id: str
    session_id: str
    enqueue_seq: int
    operation_seq: int | None
    state: QueuedMessageState
    body: dict[str, Any]
    safe_error: str
    created_at: float
    updated_at: float
    deadline: float | None = None
    purpose: str = QUEUE_PURPOSE_TURN
    native_turn_id: str = ""


@dataclass(frozen=True)
class SessionPrincipal:
    """Authenticated identity allowed to address one product session."""

    user_id: str

    def __post_init__(self) -> None:
        if not self.user_id.strip():
            raise ValueError("session principal must not be empty")


@dataclass(frozen=True)
class SessionCatalogRecord:
    """Service-owned binding between a product session and one runtime thread."""

    session_id: str
    principal_id: str
    runtime_id: str
    vendor_thread_id: str | None
    vendor_session_id: str | None
    runtime_workdir: str
    project_path: str | None
    output_root: str
    codex_version: str | None
    model_id: str | None
    policy_id: str | None
    status: SessionStatus
    last_turn_id: str | None
    last_turn_status: str | None
    last_product_seq: int
    title: str
    created_at: float
    updated_at: float
    todos: tuple[dict[str, Any], ...] = field(default_factory=tuple)
    todo_turn_id: str | None = None
    todo_product_seq: int = INITIAL_PRODUCT_SEQUENCE
    todo_explanation: str | None = None
    title_fallback: SessionTitleFallback | None = None


def encode_thinking(thinking: ModelThinking | None) -> str | None:
    """把开关/预算意图编码成列值；``None`` 保持 SQL NULL（「没选」≠「选了空值」）。"""

    if thinking is None:
        return None
    payload: dict[str, bool | int] = {}
    if thinking.enabled is not None:
        payload["enabled"] = bool(thinking.enabled)
    if thinking.budget is not None:
        payload["budget"] = int(thinking.budget)
    return json.dumps(payload, ensure_ascii=False, sort_keys=True) if payload else None


def decode_thinking(value: object) -> ModelThinking | None:
    """读回开关/预算意图；空值与不可解析的历史值都按「没选」处理。"""

    text = str(value or "").strip()
    if not text:
        return None
    try:
        payload = json.loads(text)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    enabled = payload.get("enabled")
    budget = payload.get("budget")
    normalized = ModelThinking(
        enabled=enabled if isinstance(enabled, bool) else None,
        budget=budget if isinstance(budget, int) and not isinstance(budget, bool) else None,
    )
    # 与 encode 严格互逆：两个键都不可用时归一成「没选」，否则空对象与 None 不等值，
    # 每次准入都会被判定成「选中态与生效态不一致」而反复重发同一选择。
    if normalized.enabled is None and normalized.budget is None:
        return None
    return normalized


@dataclass(frozen=True)
class SessionModelState:
    """Durable selected model and the model bound to the current vendor thread."""

    session_id: str
    selected_model_id: str
    active_model_id: str
    updated_at: float
    selected_reasoning_effort: str = ""
    active_reasoning_effort: str = ""
    selected_thinking: ModelThinking | None = None
    active_thinking: ModelThinking | None = None

    @property
    def deferred(self) -> bool:
        return (
            self.selected_model_id,
            self.selected_reasoning_effort,
            self.selected_thinking,
        ) != (
            self.active_model_id,
            self.active_reasoning_effort,
            self.active_thinking,
        )


@dataclass(frozen=True)
class SessionHilRecord:
    """One durable vendor RPC to product HIL request mapping."""

    product_request_id: str
    session_id: str
    vendor_request_id: str
    vendor_turn_id: str | None
    vendor_item_id: str | None
    method: str
    payload: dict[str, Any]
    status: HilStatus
    decision: dict[str, Any] | None
    created_at: float
    resolved_at: float | None


@dataclass(frozen=True)
class SessionUncertaintyRecord:
    """One durable at-most-once operation or ambiguous turn correlation."""

    session_id: str
    kind: UncertaintyKind
    correlation_id: str
    incident_id: str | None
    process_generation: int
    state: UncertaintyState
    payload: dict[str, Any]
    created_at: float
    resolved_at: float | None


class SessionAccessError(PermissionError):
    """The requested session is not visible to this principal."""


class SessionAccessConflictError(RuntimeError):
    """A product session id was assigned to two principals."""


class SessionBindingConflictError(RuntimeError):
    """A product session and vendor thread binding is not one-to-one."""


class SessionStateConflictError(RuntimeError):
    """An idempotency key was reused for different product state."""


class SessionQueueCapacityError(RuntimeError):
    """A product session already has the maximum number of queued messages."""


class SessionCatalogStore:
    """Single Service authority for session binding, projection, and HIL state."""

    def __init__(self, database: Path | None = None, *, shared_ownership: bool = False) -> None:
        self._database = Path(database or SESSION_CATALOG_DB)
        self._database.parent.mkdir(parents=True, exist_ok=True)
        # 共享归属只改**读写谓词**, 不改列: principal_id 始终如实记录建会话的那个账号。
        # 因此轴改回按账号隔离时每行的原主还在, 全程不需要任何不可逆的数据迁移。
        self._shared_ownership = bool(shared_ownership)
        with closing(self._connect()) as connection, connection:
            self._initialize(connection)

    @property
    def shared_ownership(self) -> bool:
        return self._shared_ownership

    def _owner_condition(self, principal: SessionPrincipal) -> tuple[str, tuple[str, ...]]:
        """归属谓词及其绑定参数。共享归属下退化为恒真。"""

        if self._shared_ownership:
            return SQL_CONDITION_ALWAYS_TRUE, ()
        return "principal_id = ?", (principal.user_id,)

    @property
    def database(self) -> Path:
        return self._database

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            str(self._database),
            check_same_thread=False,
            timeout=SQLITE_TIMEOUT_SECONDS,
        )
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
        except BaseException:
            connection.close()
            raise
        return connection

    @classmethod
    def _initialize(cls, connection: sqlite3.Connection) -> None:
        tables = cls._tables(connection)
        if LEGACY_SESSION_TABLE in tables and SESSION_CATALOG_TABLE not in tables:
            connection.execute(
                f"ALTER TABLE {LEGACY_SESSION_TABLE} RENAME TO {SESSION_CATALOG_TABLE}"
            )
        if SESSION_CATALOG_TABLE in cls._tables(connection):
            columns = cls._columns(connection, SESSION_CATALOG_TABLE)
            if not CATALOG_COLUMNS.issubset(columns):
                cls._migrate_catalog(connection, columns)
            else:
                cls._add_catalog_columns(connection, columns)
        cls._create_catalog(connection)
        cls._repair_catalog_foreign_keys(connection)
        cls._create_model_state(connection)
        cls._create_portable_history(connection)
        cls._create_hil(connection)
        cls._create_uncertainty(connection)
        cls._create_runtime_binding(connection)
        cls._create_activation(connection)
        cls._create_message_queue(connection)

    @staticmethod
    def _tables(connection: sqlite3.Connection) -> frozenset[str]:
        rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
        return frozenset(str(row["name"]) for row in rows)

    @staticmethod
    def _columns(connection: sqlite3.Connection, table: str) -> frozenset[str]:
        rows = connection.execute(f"PRAGMA table_info({table})").fetchall()
        return frozenset(str(row["name"]) for row in rows)

    @staticmethod
    def _foreign_targets(connection: sqlite3.Connection, table: str) -> frozenset[str]:
        rows = connection.execute(f"PRAGMA foreign_key_list({table})").fetchall()
        return frozenset(str(row["table"]) for row in rows)

    @classmethod
    def _repair_catalog_foreign_keys(cls, connection: sqlite3.Connection) -> None:
        """Repair stale session foreign keys left by the old catalog rename migration."""

        tables = cls._tables(connection)
        expected = {
            SESSION_HIL_TABLE: frozenset((SESSION_CATALOG_TABLE,)),
            SESSION_UNCERTAINTY_TABLE: frozenset((SESSION_CATALOG_TABLE,)),
        }
        existing = tuple(table for table in expected if table in tables)
        broken = tuple(
            table
            for table in existing
            if cls._foreign_targets(connection, table) != expected[table]
        )
        if not broken:
            return

        connection.commit()
        connection.execute("PRAGMA foreign_keys = OFF")
        try:
            for table in broken:
                migration = f"{table}{CATALOG_FOREIGN_KEY_MIGRATION_SUFFIX}"
                connection.execute(f"DROP TABLE IF EXISTS {migration}")
                connection.execute(f"ALTER TABLE {table} RENAME TO {migration}")

            if SESSION_HIL_TABLE in broken:
                cls._create_hil(connection)
            if SESSION_UNCERTAINTY_TABLE in broken:
                cls._create_uncertainty(connection)

            for table in broken:
                migration = f"{table}{CATALOG_FOREIGN_KEY_MIGRATION_SUFFIX}"
                columns = tuple(
                    row["name"]
                    for row in connection.execute(f"PRAGMA table_info({migration})").fetchall()
                )
                column_sql = ", ".join(columns)
                connection.execute(
                    f"INSERT INTO {table} ({column_sql}) " f"SELECT {column_sql} FROM {migration}"
                )
                connection.execute(f"DROP TABLE {migration}")
        finally:
            connection.execute("PRAGMA foreign_keys = ON")

    @classmethod
    def _create_catalog(cls, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_CATALOG_TABLE} (
                session_id TEXT PRIMARY KEY,
                principal_id TEXT NOT NULL,
                runtime_id TEXT NOT NULL,
                vendor_thread_id TEXT,
                vendor_session_id TEXT,
                runtime_workdir TEXT NOT NULL,
                project_path TEXT,
                output_root TEXT NOT NULL,
                codex_version TEXT,
                model_id TEXT,
                policy_id TEXT,
                status TEXT NOT NULL,
                last_turn_id TEXT,
                last_turn_status TEXT,
                last_product_seq INTEGER NOT NULL DEFAULT 0,
                title TEXT NOT NULL DEFAULT '',
                title_fallback TEXT,
                todos TEXT NOT NULL DEFAULT '[]',
                todo_turn_id TEXT,
                todo_product_seq INTEGER NOT NULL DEFAULT 0,
                todo_explanation TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE(runtime_id, vendor_thread_id)
            )
            """)
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{SESSION_CATALOG_TABLE}_principal_updated "
            f"ON {SESSION_CATALOG_TABLE}(principal_id, updated_at DESC)"
        )
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{SESSION_CATALOG_TABLE}_runtime_project_updated "
            f"ON {SESSION_CATALOG_TABLE}(runtime_id, project_path, updated_at DESC)"
        )

    @classmethod
    def _create_model_state(cls, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_MODEL_TABLE} (
                session_id TEXT PRIMARY KEY,
                selected_model_id TEXT NOT NULL,
                active_model_id TEXT NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        columns = {
            row["name"] for row in connection.execute(f"PRAGMA table_info({SESSION_MODEL_TABLE})")
        }
        for column in ("selected_reasoning_effort", "active_reasoning_effort"):
            if column not in columns:
                connection.execute(
                    f"ALTER TABLE {SESSION_MODEL_TABLE} ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"
                )
        # 开关/预算形态没有档位名可用，值按结构化 JSON 存；**可空且默认 NULL** 才能把
        # 「没选」与「选了」区分开（本表的 *_json 列已是同一写法）。
        for column in SESSION_THINKING_COLUMNS:
            if column not in columns:
                connection.execute(
                    f"ALTER TABLE {SESSION_MODEL_TABLE} ADD COLUMN {column} TEXT NULL"
                )

    @classmethod
    def _create_portable_history(cls, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_PORTABLE_HISTORY_TABLE} (
                session_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                role TEXT NOT NULL,
                text TEXT NOT NULL,
                turn_id TEXT NOT NULL DEFAULT '',
                item_id TEXT NOT NULL DEFAULT '',
                phase TEXT,
                PRIMARY KEY(session_id, ordinal),
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)

    @classmethod
    def _create_hil(cls, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_HIL_TABLE} (
                product_request_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                vendor_request_id TEXT NOT NULL,
                vendor_turn_id TEXT,
                vendor_item_id TEXT,
                method TEXT NOT NULL,
                payload TEXT NOT NULL,
                status TEXT NOT NULL,
                decision TEXT,
                created_at REAL NOT NULL,
                resolved_at REAL,
                UNIQUE(session_id, vendor_request_id),
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{SESSION_HIL_TABLE}_pending "
            f"ON {SESSION_HIL_TABLE}(session_id, status, created_at)"
        )

    @classmethod
    def _create_uncertainty(cls, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_UNCERTAINTY_TABLE} (
                session_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                correlation_id TEXT NOT NULL,
                incident_id TEXT,
                process_generation INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL,
                payload TEXT NOT NULL DEFAULT '{{}}',
                created_at REAL NOT NULL,
                resolved_at REAL,
                PRIMARY KEY(session_id, kind, correlation_id),
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{SESSION_UNCERTAINTY_TABLE}_active "
            f"ON {SESSION_UNCERTAINTY_TABLE}(session_id, kind, state, created_at)"
        )

    @classmethod
    def _create_runtime_binding(cls, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_RUNTIME_BINDING_TABLE} (
                product_session_id TEXT PRIMARY KEY,
                runtime_id TEXT NOT NULL,
                adapter_version TEXT NOT NULL DEFAULT '',
                runtime_version TEXT NOT NULL DEFAULT '',
                protocol_version TEXT NOT NULL DEFAULT '',
                protocol_schema_hash TEXT NOT NULL DEFAULT '',
                opaque_session_ref TEXT NOT NULL,
                profile TEXT NOT NULL DEFAULT '',
                capability_snapshot_json TEXT NOT NULL DEFAULT '[]',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY(product_session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE,
                UNIQUE(runtime_id, opaque_session_ref)
            )
            """)
        connection.execute(
            f"""
            INSERT INTO {SESSION_RUNTIME_BINDING_TABLE} (
                product_session_id, runtime_id, runtime_version, opaque_session_ref,
                created_at, updated_at
            )
            SELECT session_id, runtime_id, COALESCE(codex_version, ''),
                   COALESCE(vendor_thread_id, vendor_session_id), created_at, updated_at
            FROM {SESSION_CATALOG_TABLE}
            WHERE status != ?
              AND COALESCE(vendor_thread_id, vendor_session_id, '') != ''
            ON CONFLICT(product_session_id) DO NOTHING
            """,
            (SessionStatus.LEGACY_READONLY.value,),
        )

    @classmethod
    def _create_activation(cls, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_ACTIVATION_TABLE} (
                session_id TEXT PRIMARY KEY,
                open_state TEXT NOT NULL,
                open_attempt_id TEXT NOT NULL DEFAULT '',
                generation INTEGER NOT NULL DEFAULT {INITIAL_ATTACHMENT_GENERATION},
                required_capabilities TEXT NOT NULL DEFAULT '[]',
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        # An existing native binding is positive evidence of a completed open.
        # Missing bindings are not evidence that an old session never executed.
        connection.execute(
            f"INSERT INTO {SESSION_ACTIVATION_TABLE} (session_id, open_state) "
            f"SELECT product_session_id, ? FROM {SESSION_RUNTIME_BINDING_TABLE} "
            "WHERE opaque_session_ref != '' ON CONFLICT(session_id) DO NOTHING",
            (OpenState.BOUND.value,),
        )

    @classmethod
    def _create_message_queue(cls, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_MESSAGE_QUEUE_TABLE} (
                queued_message_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                enqueue_seq INTEGER NOT NULL,
                operation_seq INTEGER,
                state TEXT NOT NULL,
                body TEXT NOT NULL,
                safe_error TEXT NOT NULL DEFAULT '',
                deadline REAL,
                purpose TEXT NOT NULL DEFAULT '{QUEUE_PURPOSE_TURN}',
                native_turn_id TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE(session_id, enqueue_seq),
                UNIQUE(session_id, operation_seq),
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        columns = cls._columns(connection, SESSION_MESSAGE_QUEUE_TABLE)
        for column, definition in QUEUE_ADDITIVE_COLUMNS.items():
            if column not in columns:
                connection.execute(
                    f"ALTER TABLE {SESSION_MESSAGE_QUEUE_TABLE} ADD COLUMN {column} {definition}"
                )
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{SESSION_MESSAGE_QUEUE_TABLE}_session_state "
            f"ON {SESSION_MESSAGE_QUEUE_TABLE}(session_id, state, enqueue_seq)"
        )

    @staticmethod
    def _queued_message(row: sqlite3.Row | None) -> QueuedMessageRecord | None:
        if row is None:
            return None
        return QueuedMessageRecord(
            queued_message_id=str(row["queued_message_id"]),
            session_id=str(row["session_id"]),
            enqueue_seq=int(row["enqueue_seq"]),
            operation_seq=(int(row["operation_seq"]) if row["operation_seq"] is not None else None),
            state=QueuedMessageState(str(row["state"])),
            body=dict(json.loads(str(row["body"]))),
            safe_error=str(row["safe_error"] or ""),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
            deadline=float(row["deadline"]) if row["deadline"] is not None else None,
            purpose=str(row["purpose"]),
            native_turn_id=str(row["native_turn_id"]),
        )

    def enqueue_message(
        self,
        session_id: str,
        queued_message_id: str,
        body: Mapping[str, Any],
        *,
        deadline: float | None = None,
        purpose: str = QUEUE_PURPOSE_TURN,
    ) -> QueuedMessageRecord:
        if not queued_message_id.strip() or not purpose.strip():
            raise ValueError("queued request id and purpose must not be empty")
        if deadline is not None and (not math.isfinite(deadline) or deadline <= 0):
            raise ValueError("queued request deadline must be a positive finite timestamp")
        now = time.time()
        encoded = json.dumps(dict(body), ensure_ascii=False, sort_keys=True)
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} WHERE queued_message_id = ?",
                (queued_message_id,),
            ).fetchone()
            if existing is not None:
                record = self._queued_message(existing)
                if (
                    record is None
                    or record.session_id != session_id
                    or json.dumps(record.body, ensure_ascii=False, sort_keys=True) != encoded
                    or record.purpose != purpose
                ):
                    raise SessionStateConflictError("queued message idempotency conflict")
                connection.commit()
                return record
            depth_row = connection.execute(
                f"SELECT COUNT(*) AS value FROM {SESSION_MESSAGE_QUEUE_TABLE} "
                f"WHERE session_id = ? AND state IN ({','.join('?' for _ in QUEUE_CAPACITY_STATES)})",
                (session_id, *(state.value for state in QUEUE_CAPACITY_STATES)),
            ).fetchone()
            if int(depth_row["value"]) >= MAX_QUEUED_MESSAGES_PER_SESSION:
                connection.rollback()
                raise SessionQueueCapacityError("queued message capacity reached")
            row = connection.execute(
                f"SELECT COALESCE(MAX(enqueue_seq), 0) AS value FROM {SESSION_MESSAGE_QUEUE_TABLE} "
                "WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            enqueue_seq = int(row["value"]) + 1
            connection.execute(
                f"INSERT INTO {SESSION_MESSAGE_QUEUE_TABLE} "
                "(queued_message_id, session_id, enqueue_seq, state, body, created_at, updated_at, "
                "deadline, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    queued_message_id,
                    session_id,
                    enqueue_seq,
                    QueuedMessageState.QUEUED.value,
                    encoded,
                    now,
                    now,
                    deadline,
                    purpose,
                ),
            )
            connection.commit()
        record = self.queued_message(session_id, queued_message_id)
        if record is None:
            raise RuntimeError("queued message disappeared after insert")
        return record

    def queued_message(self, session_id: str, queued_message_id: str) -> QueuedMessageRecord | None:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} "
                "WHERE session_id = ? AND queued_message_id = ?",
                (session_id, queued_message_id),
            ).fetchone()
        return self._queued_message(row)

    def queued_messages(self, session_id: str) -> tuple[QueuedMessageRecord, ...]:
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} WHERE session_id = ? "
                f"AND state IN ({','.join('?' for _ in QUEUE_PENDING_STATES)}) "
                "ORDER BY enqueue_seq",
                (session_id, *(state.value for state in QUEUE_PENDING_STATES)),
            ).fetchall()
        return tuple(record for row in rows if (record := self._queued_message(row)) is not None)

    def begin_resource_wait(
        self,
        session_id: str,
        queued_message_id: str,
        *,
        purpose: str,
        deadline: float | None = None,
    ) -> QueuedMessageRecord | None:
        """Persist resource admission before starting any native operation."""

        if not purpose.strip():
            raise ValueError("resource wait purpose must not be empty")
        if deadline is not None and (not math.isfinite(deadline) or deadline <= 0):
            raise ValueError("resource wait deadline must be a positive finite timestamp")
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} "
                "WHERE session_id = ? AND queued_message_id = ?",
                (session_id, queued_message_id),
            ).fetchone()
            record = self._queued_message(row)
            if record is None or record.state not in QUEUE_SUBMITTABLE_STATES:
                return None
            if record.purpose != purpose:
                raise SessionStateConflictError("resource wait purpose changed")
            if record.state is QueuedMessageState.WAITING_RESOURCES:
                return record
            connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, "
                "deadline = ?, safe_error = '', updated_at = ? "
                "WHERE session_id = ? AND queued_message_id = ?",
                (
                    QueuedMessageState.WAITING_RESOURCES.value,
                    (
                        deadline
                        if record.state is QueuedMessageState.FAILED
                        else record.deadline or deadline
                    ),
                    time.time(),
                    session_id,
                    queued_message_id,
                ),
            )
        return self.queued_message(session_id, queued_message_id)

    def mark_queue_running(
        self, session_id: str, queued_message_id: str, native_turn_id: str
    ) -> QueuedMessageRecord | None:
        """Bind a confirmed native turn without losing the durable request."""

        if not native_turn_id.strip():
            raise ValueError("native turn id must not be empty")
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} "
                "WHERE session_id = ? AND queued_message_id = ?",
                (session_id, queued_message_id),
            ).fetchone()
            record = self._queued_message(row)
            if record is None or record.state not in QUEUE_COMPLETABLE_STATES:
                return None
            if record.native_turn_id and record.native_turn_id != native_turn_id:
                raise SessionStateConflictError("queued request belongs to another native turn")
            if record.state is QueuedMessageState.RUNNING:
                return record
            connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, native_turn_id = ?, "
                "safe_error = '', updated_at = ? WHERE session_id = ? AND queued_message_id = ?",
                (
                    QueuedMessageState.RUNNING.value,
                    native_turn_id,
                    time.time(),
                    session_id,
                    queued_message_id,
                ),
            )
        return self.queued_message(session_id, queued_message_id)

    def complete_queued_message(self, session_id: str, queued_message_id: str) -> bool:
        """Retain confirmed terminal requests so transport retries cannot run them again."""

        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, updated_at = ? "
                "WHERE session_id = ? AND queued_message_id = ? "
                f"AND state IN ({','.join('?' for _ in QUEUE_COMPLETABLE_STATES)})",
                (
                    QueuedMessageState.COMPLETED.value,
                    time.time(),
                    session_id,
                    queued_message_id,
                    *(state.value for state in QUEUE_COMPLETABLE_STATES),
                ),
            )
        return cursor.rowcount == 1

    def begin_queued_submission(
        self, session_id: str, queued_message_id: str
    ) -> QueuedMessageRecord | None:
        now = time.time()
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                f"SELECT COALESCE(MAX(operation_seq), 0) AS value FROM {SESSION_MESSAGE_QUEUE_TABLE} "
                "WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            operation_seq = int(row["value"]) + 1
            cursor = connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, operation_seq = ?, "
                "safe_error = '', updated_at = ? WHERE session_id = ? AND queued_message_id = ? "
                f"AND state IN ({','.join('?' for _ in QUEUE_SUBMITTABLE_STATES)})",
                (
                    QueuedMessageState.SUBMITTING.value,
                    operation_seq,
                    now,
                    session_id,
                    queued_message_id,
                    *(state.value for state in QUEUE_SUBMITTABLE_STATES),
                ),
            )
            connection.commit()
            if cursor.rowcount != 1:
                return None
        return self.queued_message(session_id, queued_message_id)

    def update_queued_message(
        self,
        session_id: str,
        queued_message_id: str,
        body: Mapping[str, Any],
    ) -> QueuedMessageRecord | None:
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET body = ?, safe_error = '', updated_at = ? "
                "WHERE session_id = ? AND queued_message_id = ? "
                f"AND state IN ({','.join('?' for _ in QUEUE_SUBMITTABLE_STATES)})",
                (
                    json.dumps(dict(body), ensure_ascii=False, sort_keys=True),
                    time.time(),
                    session_id,
                    queued_message_id,
                    *(state.value for state in QUEUE_SUBMITTABLE_STATES),
                ),
            )
        return self.queued_message(session_id, queued_message_id) if cursor.rowcount == 1 else None

    def delete_queued_message(self, session_id: str, queued_message_id: str) -> bool:
        """Cancel unsent work while retaining its idempotency identity."""

        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, updated_at = ? "
                "WHERE session_id = ? AND queued_message_id = ? "
                f"AND state IN ({','.join('?' for _ in QUEUE_SUBMITTABLE_STATES)})",
                (
                    QueuedMessageState.CANCELLED.value,
                    time.time(),
                    session_id,
                    queued_message_id,
                    *(state.value for state in QUEUE_SUBMITTABLE_STATES),
                ),
            )
        return cursor.rowcount == 1

    def fail_queued_submission(
        self,
        session_id: str,
        queued_message_id: str,
        *,
        unknown: bool,
        safe_error: str,
    ) -> None:
        state = QueuedMessageState.OUTCOME_UNKNOWN if unknown else QueuedMessageState.FAILED
        allowed = QUEUE_COMPLETABLE_STATES if unknown else QUEUE_REJECTABLE_STATES
        with closing(self._connect()) as connection, connection:
            connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, safe_error = ?, updated_at = ? "
                "WHERE session_id = ? AND queued_message_id = ? "
                f"AND state IN ({','.join('?' for _ in allowed)})",
                (
                    state.value,
                    safe_error,
                    time.time(),
                    session_id,
                    queued_message_id,
                    *(state.value for state in allowed),
                ),
            )

    def remove_queued_message(self, session_id: str, queued_message_id: str) -> bool:
        """Record confirmed submission without deleting the request identity."""

        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, updated_at = ? "
                "WHERE session_id = ? "
                "AND queued_message_id = ? AND state = ?",
                (
                    QueuedMessageState.COMPLETED.value,
                    time.time(),
                    session_id,
                    queued_message_id,
                    QueuedMessageState.SUBMITTING.value,
                ),
            )
        return cursor.rowcount == 1

    def remove_reconciled_unknown_message(
        self,
        session_id: str,
        queued_message_id: str,
        operation_seq: int,
    ) -> bool:
        """Settle one exact unknown operation after durable applied evidence exists."""

        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, updated_at = ? "
                "WHERE session_id = ? "
                "AND queued_message_id = ? AND state = ? AND operation_seq = ?",
                (
                    QueuedMessageState.COMPLETED.value,
                    time.time(),
                    session_id,
                    queued_message_id,
                    QueuedMessageState.OUTCOME_UNKNOWN.value,
                    operation_seq,
                ),
            )
        return cursor.rowcount == 1

    @staticmethod
    def _capability_json(binding: RuntimeBinding) -> str:
        return json.dumps(
            [
                {"name": row.name, "state": row.state.value, "detail": row.detail}
                for row in binding.capabilities.entries
            ],
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    @classmethod
    def _store_runtime_binding(
        cls, connection: sqlite3.Connection, binding: RuntimeBinding, timestamp: float
    ) -> None:
        cursor = connection.execute(
            f"""
            INSERT INTO {SESSION_RUNTIME_BINDING_TABLE} (
                product_session_id, runtime_id, adapter_version,
                runtime_version, protocol_version, protocol_schema_hash,
                opaque_session_ref, profile, capability_snapshot_json,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(product_session_id) DO UPDATE SET
                adapter_version = excluded.adapter_version,
                runtime_version = excluded.runtime_version,
                protocol_version = excluded.protocol_version,
                protocol_schema_hash = excluded.protocol_schema_hash,
                profile = excluded.profile,
                capability_snapshot_json = excluded.capability_snapshot_json,
                updated_at = excluded.updated_at
            WHERE runtime_id = excluded.runtime_id
              AND opaque_session_ref = excluded.opaque_session_ref
            """,
            (
                binding.product_session_id,
                binding.runtime_id,
                binding.adapter_version,
                binding.runtime_version,
                binding.protocol_version,
                binding.protocol_schema_hash,
                binding.opaque_session_ref,
                binding.profile,
                cls._capability_json(binding),
                timestamp,
                timestamp,
            ),
        )
        if cursor.rowcount != 1:
            raise SessionBindingConflictError("session is already bound to another runtime thread")

    @classmethod
    def _runtime_binding(cls, row: sqlite3.Row | None) -> RuntimeBinding | None:
        if row is None:
            return None
        raw = json.loads(str(row["capability_snapshot_json"] or "[]"))
        capabilities = CapabilitySet(
            tuple(
                RuntimeCapability(
                    name=str(item["name"]),
                    state=CapabilityState(str(item["state"])),
                    detail=str(item.get("detail") or ""),
                )
                for item in raw
                if isinstance(item, dict) and item.get("name") and item.get("state")
            )
        )
        return RuntimeBinding(
            product_session_id=str(row["product_session_id"]),
            runtime_id=str(row["runtime_id"]),
            adapter_version=str(row["adapter_version"]),
            runtime_version=str(row["runtime_version"]),
            protocol_version=str(row["protocol_version"]),
            protocol_schema_hash=str(row["protocol_schema_hash"]),
            opaque_session_ref=str(row["opaque_session_ref"]),
            capabilities=capabilities,
            profile=str(row["profile"]),
        )

    @classmethod
    def _migrate_catalog(
        cls,
        connection: sqlite3.Connection,
        old_columns: frozenset[str],
    ) -> None:
        """Add missing fields without rebuilding or discarding user session rows."""

        immutable_required = {"session_id", "principal_id", "created_at"}
        missing_required = immutable_required - old_columns
        if missing_required:
            names = ", ".join(sorted(missing_required))
            raise RuntimeError(f"session catalog lacks identity columns: {names}")
        cls._add_catalog_columns(connection, old_columns)
        connection.execute(
            f"UPDATE {SESSION_CATALOG_TABLE} SET output_root = runtime_workdir "
            "WHERE output_root = ''"
        )
        connection.execute(
            f"UPDATE {SESSION_CATALOG_TABLE} SET updated_at = created_at WHERE updated_at = 0"
        )

    @staticmethod
    def _add_catalog_columns(connection: sqlite3.Connection, old_columns: frozenset[str]) -> None:
        for name, definition in CATALOG_ADDITIVE_COLUMNS.items():
            if name not in old_columns:
                connection.execute(
                    f"ALTER TABLE {SESSION_CATALOG_TABLE} ADD COLUMN {name} {definition}"
                )

    @staticmethod
    def _decode_mapping(raw: Any) -> dict[str, Any] | None:
        text = str(raw or "").strip()
        if not text:
            return None
        try:
            value = json.loads(text)
        except (TypeError, ValueError):
            return None
        return dict(value) if isinstance(value, dict) else None

    @staticmethod
    def _decode_todos(raw: Any) -> tuple[dict[str, Any], ...]:
        text = str(raw or "").strip()
        if not text:
            return ()
        try:
            value = json.loads(text)
        except (TypeError, ValueError):
            return ()
        if not isinstance(value, list):
            return ()
        return tuple(dict(item) for item in value if isinstance(item, dict))

    @staticmethod
    def _optional(row: sqlite3.Row, name: str) -> str | None:
        return str(row[name] or "").strip() or None

    @classmethod
    def _record(cls, row: sqlite3.Row | None) -> SessionCatalogRecord | None:
        if row is None:
            return None
        return SessionCatalogRecord(
            session_id=str(row["session_id"]),
            principal_id=str(row["principal_id"]),
            runtime_id=str(row["runtime_id"]),
            vendor_thread_id=cls._optional(row, "vendor_thread_id"),
            vendor_session_id=cls._optional(row, "vendor_session_id"),
            runtime_workdir=str(row["runtime_workdir"]),
            project_path=cls._optional(row, "project_path"),
            output_root=str(row["output_root"]),
            codex_version=cls._optional(row, "codex_version"),
            model_id=cls._optional(row, "model_id"),
            policy_id=cls._optional(row, "policy_id"),
            status=SessionStatus(str(row["status"])),
            last_turn_id=cls._optional(row, "last_turn_id"),
            last_turn_status=cls._optional(row, "last_turn_status"),
            last_product_seq=int(row["last_product_seq"]),
            title=str(row["title"] or ""),
            title_fallback=next(
                (value for value in SessionTitleFallback if value.value == row["title_fallback"]),
                None,
            ),
            todos=cls._decode_todos(row["todos"]),
            todo_turn_id=cls._optional(row, "todo_turn_id"),
            todo_product_seq=int(row["todo_product_seq"]),
            todo_explanation=cls._optional(row, "todo_explanation"),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
        )

    @classmethod
    def _hil_record(cls, row: sqlite3.Row | None) -> SessionHilRecord | None:
        if row is None:
            return None
        return SessionHilRecord(
            product_request_id=str(row["product_request_id"]),
            session_id=str(row["session_id"]),
            vendor_request_id=str(row["vendor_request_id"]),
            vendor_turn_id=cls._optional(row, "vendor_turn_id"),
            vendor_item_id=cls._optional(row, "vendor_item_id"),
            method=str(row["method"]),
            payload=cls._decode_mapping(row["payload"]) or {},
            status=HilStatus(str(row["status"])),
            decision=cls._decode_mapping(row["decision"]),
            created_at=float(row["created_at"]),
            resolved_at=(float(row["resolved_at"]) if row["resolved_at"] is not None else None),
        )

    @classmethod
    def _uncertainty_record(
        cls,
        row: sqlite3.Row | None,
    ) -> SessionUncertaintyRecord | None:
        if row is None:
            return None
        return SessionUncertaintyRecord(
            session_id=str(row["session_id"]),
            kind=UncertaintyKind(str(row["kind"])),
            correlation_id=str(row["correlation_id"]),
            incident_id=cls._optional(row, "incident_id"),
            process_generation=int(row["process_generation"]),
            state=UncertaintyState(str(row["state"])),
            payload=cls._decode_mapping(row["payload"]) or {},
            created_at=float(row["created_at"]),
            resolved_at=(float(row["resolved_at"]) if row["resolved_at"] is not None else None),
        )

    @staticmethod
    def _activation(row: sqlite3.Row | None) -> ActivationRecord | None:
        if row is None:
            return None
        return ActivationRecord(
            session_id=str(row["session_id"]),
            open_state=OpenState(str(row["open_state"])),
            open_attempt_id=str(row["open_attempt_id"]),
            generation=int(row["generation"]),
            required_capabilities=tuple(
                RuntimeCapabilityName(value)
                for value in json.loads(str(row["required_capabilities"]))
            ),
        )

    def activation(self, session_id: str) -> ActivationRecord | None:
        """Return explicit lifecycle evidence, never infer an unbound session is new."""

        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"SELECT * FROM {SESSION_ACTIVATION_TABLE} WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        return self._activation(row)

    def allocate(
        self,
        session_id: str,
        creator: SessionPrincipal,
        *,
        runtime_id: str,
        runtime_workdir: str,
        project_path: str | None,
        output_root: str,
        codex_version: str | None = None,
        model_id: str | None = None,
        policy_id: str | None = None,
        status: SessionStatus = SessionStatus.READY,
        title: str = "",
        created_at: float | None = None,
        required_capabilities: tuple[RuntimeCapabilityName, ...] = (),
        reasoning_effort: str = "",
        thinking: ModelThinking | None = None,
        title_fallback: SessionTitleFallback | None = None,
    ) -> SessionCatalogRecord:
        """Allocate a durable product identity before creating a native thread."""

        required = {
            "session_id": session_id,
            "runtime_id": runtime_id,
            "runtime_workdir": runtime_workdir,
            "output_root": output_root,
        }
        empty = [name for name, value in required.items() if not value.strip()]
        if empty:
            raise ValueError(f"required session fields are empty: {', '.join(empty)}")
        capabilities = tuple(RuntimeCapabilityName(value) for value in required_capabilities)
        if title_fallback is not None:
            title_fallback = SessionTitleFallback(title_fallback)
        if len(set(capabilities)) != len(capabilities):
            raise ValueError("required capabilities must be unique")
        timestamp = time.time() if created_at is None else float(created_at)
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = self._record(
                connection.execute(
                    f"SELECT * FROM {SESSION_CATALOG_TABLE} WHERE session_id = ?", (session_id,)
                ).fetchone()
            )
            if existing is not None:
                if not self._shared_ownership and existing.principal_id != creator.user_id:
                    raise SessionAccessConflictError("session is assigned to another principal")
                activation = self._activation(
                    connection.execute(
                        f"SELECT * FROM {SESSION_ACTIVATION_TABLE} WHERE session_id = ?",
                        (session_id,),
                    ).fetchone()
                )
                if (
                    activation is None
                    or existing.runtime_id != runtime_id.strip()
                    or existing.runtime_workdir != runtime_workdir
                    or existing.project_path != project_path
                    or existing.output_root != output_root
                    or activation.required_capabilities != capabilities
                ):
                    raise SessionStateConflictError("session allocation idempotency conflict")
                return existing
            connection.execute(
                f"INSERT INTO {SESSION_CATALOG_TABLE} "
                "(session_id, principal_id, runtime_id, runtime_workdir, project_path, "
                "output_root, codex_version, model_id, policy_id, status, title, title_fallback, created_at, "
                "updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    session_id,
                    creator.user_id,
                    runtime_id.strip(),
                    runtime_workdir,
                    project_path,
                    output_root,
                    (codex_version or "").strip() or None,
                    (model_id or "").strip() or None,
                    (policy_id or "").strip() or None,
                    status.value,
                    title.strip(),
                    title_fallback,
                    timestamp,
                    timestamp,
                ),
            )
            connection.execute(
                f"INSERT INTO {SESSION_MODEL_TABLE} "
                "(session_id, selected_model_id, active_model_id, selected_reasoning_effort, "
                "selected_thinking_json, updated_at) VALUES (?, ?, '', ?, ?, ?)",
                (
                    session_id,
                    (model_id or "").strip(),
                    reasoning_effort.strip(),
                    encode_thinking(thinking),
                    timestamp,
                ),
            )
            connection.execute(
                f"INSERT INTO {SESSION_ACTIVATION_TABLE} "
                "(session_id, open_state, required_capabilities) VALUES (?, ?, ?)",
                (
                    session_id,
                    OpenState.NEVER_STARTED.value,
                    json.dumps([value.value for value in capabilities]),
                ),
            )
        record = self.get(session_id)
        if record is None:
            raise SessionAccessError("session disappeared after allocation")
        return record

    def begin_open(self, session_id: str, attempt_id: str) -> ActivationRecord | None:
        """Claim the only permitted first-open attempt before calling the provider."""

        if not attempt_id.strip():
            raise ValueError("open attempt id must not be empty")
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"UPDATE {SESSION_ACTIVATION_TABLE} SET open_state = ?, open_attempt_id = ? "
                "WHERE session_id = ? AND open_state = ?",
                (
                    OpenState.OPENING.value,
                    attempt_id,
                    session_id,
                    OpenState.NEVER_STARTED.value,
                ),
            )
        return self.activation(session_id) if cursor.rowcount == 1 else None

    def bind_open(
        self, session_id: str, attempt_id: str, binding: RuntimeBinding
    ) -> SessionCatalogRecord:
        """Commit positive native-open evidence and its exact attempt atomically."""

        if not attempt_id.strip() or not binding.opaque_session_ref.strip():
            raise ValueError("open attempt and native thread ids must not be empty")
        timestamp = time.time()
        try:
            with closing(self._connect()) as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                record = self._record(
                    connection.execute(
                        f"SELECT * FROM {SESSION_CATALOG_TABLE} WHERE session_id = ?",
                        (session_id,),
                    ).fetchone()
                )
                activation = self._activation(
                    connection.execute(
                        f"SELECT * FROM {SESSION_ACTIVATION_TABLE} WHERE session_id = ?",
                        (session_id,),
                    ).fetchone()
                )
                if record is None or activation is None:
                    raise SessionAccessError("allocated session not found")
                if (
                    binding.product_session_id != session_id
                    or binding.runtime_id != record.runtime_id
                    or activation.open_attempt_id != attempt_id
                    or activation.open_state is OpenState.NEVER_STARTED
                    or (
                        record.vendor_thread_id
                        and record.vendor_thread_id != binding.opaque_session_ref
                    )
                ):
                    raise SessionBindingConflictError(
                        "native binding differs from its open attempt"
                    )
                existing_binding = self._runtime_binding(
                    connection.execute(
                        f"SELECT * FROM {SESSION_RUNTIME_BINDING_TABLE} "
                        "WHERE product_session_id = ?",
                        (session_id,),
                    ).fetchone()
                )
                if activation.open_state is OpenState.BOUND:
                    if existing_binding != binding:
                        raise SessionBindingConflictError("completed open binding changed")
                    return record
                self._store_runtime_binding(connection, binding, timestamp)
                connection.execute(
                    f"UPDATE {SESSION_CATALOG_TABLE} SET vendor_thread_id = ?, codex_version = ?, "
                    "updated_at = ? WHERE session_id = ?",
                    (binding.opaque_session_ref, binding.runtime_version, timestamp, session_id),
                )
                connection.execute(
                    f"UPDATE {SESSION_MODEL_TABLE} SET active_model_id = selected_model_id, "
                    "updated_at = ? WHERE session_id = ?",
                    (timestamp, session_id),
                )
                connection.execute(
                    f"UPDATE {SESSION_ACTIVATION_TABLE} SET open_state = ? WHERE session_id = ?",
                    (OpenState.BOUND.value, session_id),
                )
        except sqlite3.IntegrityError as exc:
            raise SessionBindingConflictError("native thread is already bound") from exc
        record = self.get(session_id)
        if record is None:
            raise SessionAccessError("session disappeared after native binding")
        return record

    def mark_open_unknown(self, session_id: str, attempt_id: str) -> bool:
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"UPDATE {SESSION_ACTIVATION_TABLE} SET open_state = ? "
                "WHERE session_id = ? AND open_attempt_id = ? AND open_state = ?",
                (OpenState.OPEN_UNKNOWN.value, session_id, attempt_id, OpenState.OPENING.value),
            )
        return cursor.rowcount == 1

    def begin_attachment(self, session_id: str) -> int:
        """Persist a unique generation before attaching a new observation consumer."""

        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                f"UPDATE {SESSION_ACTIVATION_TABLE} SET generation = generation + 1 "
                "WHERE session_id = ? AND open_state IN (?, ?)",
                (session_id, OpenState.OPENING.value, OpenState.BOUND.value),
            )
            if cursor.rowcount != 1:
                raise SessionStateConflictError(
                    "session cannot attach without a known open attempt"
                )
            row = connection.execute(
                f"SELECT generation FROM {SESSION_ACTIVATION_TABLE} WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            return int(row["generation"])

    def recover_inflight(self) -> tuple[int, int]:
        """Mark interrupted process-local operations unknown only at explicit startup."""

        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            openings = connection.execute(
                f"UPDATE {SESSION_ACTIVATION_TABLE} SET open_state = ? WHERE open_state = ?",
                (OpenState.OPEN_UNKNOWN.value, OpenState.OPENING.value),
            ).rowcount
            connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, safe_error = ?, "
                "updated_at = ? WHERE state = ?",
                (
                    QueuedMessageState.FAILED.value,
                    QUEUE_RECOVERY_WAIT_INTERRUPTED,
                    time.time(),
                    QueuedMessageState.WAITING_RESOURCES.value,
                ),
            )
            submissions = connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, safe_error = ?, "
                "updated_at = ? WHERE state IN (?, ?)",
                (
                    QueuedMessageState.OUTCOME_UNKNOWN.value,
                    QUEUE_RECOVERY_UNKNOWN_ERROR,
                    time.time(),
                    QueuedMessageState.SUBMITTING.value,
                    QueuedMessageState.RUNNING.value,
                ),
            ).rowcount
            # A crash can precede TURN_STARTED. Preserve its client correlation so
            # the existing human confirmation flow can settle it without replay.
            connection.execute(
                f"INSERT INTO {SESSION_UNCERTAINTY_TABLE} "
                "(session_id, kind, correlation_id, state, payload, created_at) "
                f"SELECT session_id, ?, COALESCE(NULLIF(native_turn_id, ''), queued_message_id), "
                f"?, ?, ? FROM {SESSION_MESSAGE_QUEUE_TABLE} WHERE state = ? "
                "ON CONFLICT(session_id, kind, correlation_id) DO NOTHING",
                (
                    UncertaintyKind.TURN.value,
                    UncertaintyState.UNKNOWN.value,
                    json.dumps({"outcome": QueuedMessageState.OUTCOME_UNKNOWN.value}),
                    time.time(),
                    QueuedMessageState.OUTCOME_UNKNOWN.value,
                ),
            )
        return openings, submissions

    def register(
        self,
        session_id: str,
        creator: SessionPrincipal,
        *,
        runtime_id: str,
        vendor_thread_id: str,
        vendor_session_id: str | None,
        runtime_workdir: str,
        project_path: str | None,
        output_root: str,
        codex_version: str | None,
        model_id: str | None,
        policy_id: str | None,
        status: SessionStatus,
        title: str,
        created_at: float,
        runtime_binding: RuntimeBinding | None = None,
    ) -> SessionCatalogRecord:
        """Atomically bind one immutable product id to one vendor thread.

        `creator` 是**建会话的那个账号**, 落进 principal_id 列作为历史事实。它不等于
        "谁能寻址这个会话" —— 后者由归属轴决定 (见 _owner_condition)。共享归属下仍如实
        记录真实账号, 正是这一点让轴可以随时改回按账号隔离而不丢原主。
        """

        required = {
            "session_id": session_id,
            "runtime_id": runtime_id,
            "vendor_thread_id": vendor_thread_id,
            "runtime_workdir": runtime_workdir,
            "output_root": output_root,
        }
        empty = [name for name, value in required.items() if not value.strip()]
        if empty:
            raise ValueError(f"required session fields are empty: {', '.join(empty)}")
        timestamp = float(created_at)
        try:
            with closing(self._connect()) as connection, connection:
                connection.execute(
                    f"""
                    INSERT INTO {SESSION_CATALOG_TABLE} (
                        session_id, principal_id, runtime_id, vendor_thread_id,
                        vendor_session_id, runtime_workdir, project_path, output_root,
                        codex_version, model_id, policy_id, status, title,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(session_id) DO NOTHING
                    """,
                    (
                        session_id,
                        creator.user_id,
                        runtime_id.strip(),
                        vendor_thread_id.strip(),
                        (vendor_session_id or "").strip() or None,
                        runtime_workdir,
                        project_path,
                        output_root,
                        (codex_version or "").strip() or None,
                        (model_id or "").strip() or None,
                        (policy_id or "").strip() or None,
                        SessionStatus(status).value,
                        title.strip(),
                        timestamp,
                        timestamp,
                    ),
                )
                selected_model_id = (model_id or "").strip()
                if selected_model_id:
                    connection.execute(
                        f"""
                        INSERT INTO {SESSION_MODEL_TABLE} (
                            session_id, selected_model_id, active_model_id, updated_at
                        ) VALUES (?, ?, ?, ?)
                        ON CONFLICT(session_id) DO NOTHING
                        """,
                        (session_id, selected_model_id, selected_model_id, timestamp),
                    )
                if runtime_binding is not None:
                    if (
                        runtime_binding.product_session_id != session_id
                        or runtime_binding.runtime_id != runtime_id.strip()
                        or runtime_binding.opaque_session_ref != vendor_thread_id.strip()
                    ):
                        raise SessionBindingConflictError(
                            "runtime binding differs from the product session catalog"
                        )
                    self._store_runtime_binding(connection, runtime_binding, timestamp)
                connection.execute(
                    f"INSERT INTO {SESSION_ACTIVATION_TABLE} (session_id, open_state) VALUES (?, ?) "
                    "ON CONFLICT(session_id) DO NOTHING",
                    (session_id, OpenState.BOUND.value),
                )
        except sqlite3.IntegrityError as exc:
            raise SessionBindingConflictError(
                f"vendor thread {runtime_id}:{vendor_thread_id} is already bound"
            ) from exc
        record = self.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        if not self._shared_ownership and record.principal_id != creator.user_id:
            raise SessionAccessConflictError(
                f"session {session_id} is already assigned to another principal"
            )
        if (record.runtime_id, record.vendor_thread_id) != (
            runtime_id.strip(),
            vendor_thread_id.strip(),
        ):
            raise SessionBindingConflictError(
                f"session {session_id} is already bound to another runtime thread"
            )
        return record

    def replace_runtime_binding(
        self, previous: RuntimeBinding, replacement: RuntimeBinding
    ) -> None:
        """CAS a fully initialized replacement; retain all product messages and decisions."""
        if (
            previous.product_session_id != replacement.product_session_id
            or previous.runtime_id != replacement.runtime_id
            or previous.opaque_session_ref == replacement.opaque_session_ref
        ):
            raise SessionBindingConflictError("invalid runtime replacement identity")
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                f"UPDATE {SESSION_RUNTIME_BINDING_TABLE} SET opaque_session_ref = ? "
                "WHERE product_session_id = ? AND runtime_id = ? AND opaque_session_ref = ?",
                (
                    replacement.opaque_session_ref,
                    previous.product_session_id,
                    previous.runtime_id,
                    previous.opaque_session_ref,
                ),
            )
            if cursor.rowcount != 1:
                raise SessionBindingConflictError("runtime replacement lost its source binding")
            timestamp = time.time()
            self._store_runtime_binding(connection, replacement, timestamp)
            cursor = connection.execute(
                f"UPDATE {SESSION_CATALOG_TABLE} SET vendor_thread_id = ?, updated_at = ? "
                "WHERE session_id = ? AND vendor_thread_id = ?",
                (
                    replacement.opaque_session_ref,
                    timestamp,
                    previous.product_session_id,
                    previous.opaque_session_ref,
                ),
            )
            if cursor.rowcount != 1:
                raise SessionBindingConflictError("runtime replacement lost its product binding")
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def runtime_binding(self, session_id: str) -> RuntimeBinding | None:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"SELECT * FROM {SESSION_RUNTIME_BINDING_TABLE} WHERE product_session_id = ?",
                (session_id,),
            ).fetchone()
        return self._runtime_binding(row)

    def update_status(
        self,
        session_id: str,
        status: SessionStatus,
        *,
        turn_id: str | None = None,
        turn_status: str | None = None,
        updated_at: float | None = None,
    ) -> SessionCatalogRecord:
        timestamp = float(updated_at if updated_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET status = ?,
                    last_turn_id = COALESCE(?, last_turn_id),
                    last_turn_status = COALESCE(?, last_turn_status),
                    updated_at = ?
                WHERE session_id = ?
                """,
                (
                    SessionStatus(status).value,
                    (turn_id or "").strip() or None,
                    (turn_status or "").strip() or None,
                    timestamp,
                    session_id,
                ),
            )
        if cursor.rowcount != 1:
            raise SessionAccessError("session not found")
        record = self.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        return record

    def rename(
        self,
        session_id: str,
        principal: SessionPrincipal,
        title: str,
        *,
        updated_at: float | None = None,
    ) -> SessionCatalogRecord:
        self.require(session_id, principal)
        timestamp = float(updated_at if updated_at is not None else time.time())
        condition, owner_params = self._owner_condition(principal)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET title = ?, title_fallback = NULL, updated_at = ?
                WHERE session_id = ? AND {condition}
                """,
                (title.strip(), timestamp, session_id, *owner_params),
            )
        record = self.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        return record

    def set_policy(
        self,
        session_id: str,
        principal: SessionPrincipal,
        policy_id: str,
        *,
        updated_at: float | None = None,
    ) -> SessionCatalogRecord:
        self.require(session_id, principal)
        timestamp = float(updated_at if updated_at is not None else time.time())
        condition, owner_params = self._owner_condition(principal)
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET policy_id = ?, updated_at = ?
                WHERE session_id = ? AND {condition}
                """,
                ((policy_id or "").strip() or None, timestamp, session_id, *owner_params),
            )
        if cursor.rowcount != 1:
            raise SessionAccessError("session not found")
        record = self.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        return record

    def set_model(
        self,
        session_id: str,
        principal: SessionPrincipal,
        model_id: str,
        *,
        reasoning_effort: str = "",
        thinking: ModelThinking | None = None,
        updated_at: float | None = None,
    ) -> SessionCatalogRecord:
        """Persist a selected model without changing the active vendor binding."""

        self.require(session_id, principal)
        selected = model_id.strip()
        if not selected:
            raise ValueError("session model must not be empty")
        timestamp = float(updated_at if updated_at is not None else time.time())
        condition, owner_params = self._owner_condition(principal)
        with closing(self._connect()) as connection, connection:
            current = connection.execute(
                f"SELECT model_id FROM {SESSION_CATALOG_TABLE} "
                f"WHERE session_id = ? AND {condition}",
                (session_id, *owner_params),
            ).fetchone()
            active = str(current["model_id"] or "").strip() if current is not None else ""
            cursor = connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET model_id = ?, updated_at = ?
                WHERE session_id = ? AND {condition}
                """,
                (selected, timestamp, session_id, *owner_params),
            )
            if cursor.rowcount == 1:
                connection.execute(
                    f"""
                    INSERT INTO {SESSION_MODEL_TABLE} (
                        session_id, selected_model_id, active_model_id, updated_at
                    ) VALUES (?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        selected_model_id = excluded.selected_model_id,
                        updated_at = excluded.updated_at
                    """,
                    (session_id, selected, active or selected, timestamp),
                )
                connection.execute(
                    f"UPDATE {SESSION_MODEL_TABLE} "
                    "SET selected_reasoning_effort = ?, selected_thinking_json = ? "
                    "WHERE session_id = ?",
                    (reasoning_effort, encode_thinking(thinking), session_id),
                )
        if cursor.rowcount != 1:
            raise SessionAccessError("session not found")
        record = self.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        return record

    def apply_model(
        self,
        session_id: str,
        model_id: str,
        *,
        reasoning_effort: str = "",
        thinking: ModelThinking | None = None,
        updated_at: float | None = None,
        preserve_selection: bool = False,
    ) -> SessionModelState:
        """Persist one model intent after the bound runtime confirms it is applied."""

        active = model_id.strip()
        if not active:
            raise ValueError("session model must not be empty")
        timestamp = float(updated_at if updated_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            if preserve_selection:
                cursor = connection.execute(
                    f"UPDATE {SESSION_MODEL_TABLE} "
                    "SET active_model_id = ?, active_reasoning_effort = ?, active_thinking_json = ?, "
                    "updated_at = ? WHERE session_id = ?",
                    (
                        active,
                        reasoning_effort,
                        encode_thinking(thinking),
                        timestamp,
                        session_id,
                    ),
                )
                if cursor.rowcount != 1:
                    raise SessionAccessError("session model not found")
                row = connection.execute(
                    f"SELECT * FROM {SESSION_MODEL_TABLE} WHERE session_id = ?", (session_id,)
                ).fetchone()
                return SessionModelState(
                    session_id=session_id,
                    selected_model_id=str(row["selected_model_id"]),
                    active_model_id=active,
                    updated_at=timestamp,
                    selected_reasoning_effort=str(row["selected_reasoning_effort"]),
                    active_reasoning_effort=reasoning_effort,
                    selected_thinking=decode_thinking(row["selected_thinking_json"]),
                    active_thinking=thinking,
                )
            cursor = connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET model_id = ?, updated_at = ?
                WHERE session_id = ?
                """,
                (active, timestamp, session_id),
            )
            if cursor.rowcount == 1:
                connection.execute(
                    f"""
                    INSERT INTO {SESSION_MODEL_TABLE} (
                        session_id, selected_model_id, active_model_id, updated_at
                    ) VALUES (?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        selected_model_id = excluded.selected_model_id,
                        active_model_id = excluded.active_model_id,
                        updated_at = excluded.updated_at
                    """,
                    (session_id, active, active, timestamp),
                )
                connection.execute(
                    f"UPDATE {SESSION_MODEL_TABLE} "
                    "SET selected_reasoning_effort = ?, active_reasoning_effort = ?, "
                    "selected_thinking_json = ?, active_thinking_json = ? WHERE session_id = ?",
                    (
                        reasoning_effort,
                        reasoning_effort,
                        encode_thinking(thinking),
                        encode_thinking(thinking),
                        session_id,
                    ),
                )
        if cursor.rowcount != 1:
            raise SessionAccessError("session not found")
        return self.model_state(session_id)

    def model_state(
        self,
        session_id: str,
        *,
        default_model_id: str = "",
    ) -> SessionModelState:
        """Return model intent and active binding, backfilling pre-feature sessions."""

        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"SELECT * FROM {SESSION_MODEL_TABLE} WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            if row is None:
                catalog = connection.execute(
                    f"SELECT model_id, updated_at FROM {SESSION_CATALOG_TABLE} WHERE session_id = ?",
                    (session_id,),
                ).fetchone()
                if catalog is None:
                    raise SessionAccessError("session not found")
                selected = str(catalog["model_id"] or "").strip() or default_model_id.strip()
                if not selected:
                    raise ValueError("session model must not be empty")
                timestamp = float(catalog["updated_at"])
                connection.execute(
                    f"UPDATE {SESSION_CATALOG_TABLE} SET model_id = ? WHERE session_id = ?",
                    (selected, session_id),
                )
                connection.execute(
                    f"""
                    INSERT INTO {SESSION_MODEL_TABLE} (
                        session_id, selected_model_id, active_model_id, updated_at
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (session_id, selected, selected, timestamp),
                )
                row = connection.execute(
                    f"SELECT * FROM {SESSION_MODEL_TABLE} WHERE session_id = ?",
                    (session_id,),
                ).fetchone()
        if row is None:
            raise SessionAccessError("session not found")
        return SessionModelState(
            session_id=str(row["session_id"]),
            selected_model_id=str(row["selected_model_id"]),
            active_model_id=str(row["active_model_id"]),
            updated_at=float(row["updated_at"]),
            selected_reasoning_effort=str(row["selected_reasoning_effort"]),
            active_reasoning_effort=str(row["active_reasoning_effort"]),
            selected_thinking=decode_thinking(row["selected_thinking_json"]),
            active_thinking=decode_thinking(row["active_thinking_json"]),
        )

    def portable_history(self, session_id: str) -> tuple[HistoryEntry, ...]:
        """Return the durable provider-neutral prefix carried across model threads."""

        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT role, text, turn_id, item_id, phase
                FROM {SESSION_PORTABLE_HISTORY_TABLE}
                WHERE session_id = ?
                ORDER BY ordinal
                """,
                (session_id,),
            ).fetchall()
        return tuple(
            HistoryEntry(
                role=str(row["role"]),
                text=str(row["text"]),
                turn_id=str(row["turn_id"]),
                item_id=str(row["item_id"]),
                phase=(MessagePhase(str(row["phase"])) if row["phase"] is not None else None),
            )
            for row in rows
        )

    @staticmethod
    def _replace_portable_history(
        connection: sqlite3.Connection,
        session_id: str,
        history: Sequence[HistoryEntry],
    ) -> None:
        connection.execute(
            f"DELETE FROM {SESSION_PORTABLE_HISTORY_TABLE} WHERE session_id = ?",
            (session_id,),
        )
        rows = [
            (
                session_id,
                ordinal,
                entry.role,
                entry.text,
                entry.turn_id,
                entry.item_id,
                entry.phase.value if entry.phase is not None else None,
            )
            for ordinal, entry in enumerate(history)
            if entry.role in PORTABLE_HISTORY_ROLES and entry.text
        ]
        connection.executemany(
            f"""
            INSERT INTO {SESSION_PORTABLE_HISTORY_TABLE} (
                session_id, ordinal, role, text, turn_id, item_id, phase
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )

    def transition_model_thread(
        self,
        session_id: str,
        *,
        runtime_id: str,
        previous_vendor_thread_id: str,
        vendor_thread_id: str,
        model_id: str,
        selected_model_id: str = "",
        portable_history: Sequence[HistoryEntry] | None = None,
        updated_at: float | None = None,
    ) -> SessionModelState:
        """Atomically advance one product session to a forked model-bound thread."""

        previous = previous_vendor_thread_id.strip()
        target = vendor_thread_id.strip()
        active = model_id.strip()
        selected = selected_model_id.strip() or active
        if not runtime_id.strip() or not previous or not target or not active or not selected:
            raise ValueError("model thread transition fields must not be empty")
        if previous == target:
            raise SessionBindingConflictError("model switch requires a new vendor thread")
        timestamp = float(updated_at if updated_at is not None else time.time())
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET vendor_thread_id = ?, model_id = ?, updated_at = ?
                WHERE session_id = ? AND runtime_id = ? AND vendor_thread_id = ?
                """,
                (target, active, timestamp, session_id, runtime_id.strip(), previous),
            )
            if cursor.rowcount != 1:
                raise SessionBindingConflictError(
                    f"session {session_id} is not bound to {runtime_id}:{previous}"
                )
            connection.execute(
                f"""
                INSERT INTO {SESSION_MODEL_TABLE} (
                    session_id, selected_model_id, active_model_id, updated_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    selected_model_id = excluded.selected_model_id,
                    active_model_id = excluded.active_model_id,
                    updated_at = excluded.updated_at
                """,
                (session_id, selected, active, timestamp),
            )
            if portable_history is not None:
                self._replace_portable_history(connection, session_id, portable_history)
            connection.commit()
        except sqlite3.IntegrityError as exc:
            connection.rollback()
            raise SessionBindingConflictError(
                f"vendor thread {runtime_id}:{target} is already bound"
            ) from exc
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        return self.model_state(session_id)

    def relocate(
        self,
        session_id: str,
        principal: SessionPrincipal,
        *,
        runtime_workdir: str,
        project_path: str,
        output_root: str,
        updated_at: float | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> SessionCatalogRecord:
        """Atomically persist the three roots that define a session location."""

        roots = (runtime_workdir.strip(), project_path.strip(), output_root.strip())
        if any(not root for root in roots):
            raise ValueError("session relocation roots must not be empty")
        timestamp = float(updated_at if updated_at is not None else time.time())
        condition, owner_params = self._owner_condition(principal)
        owned = connection is None
        if connection is not None:
            validate_transaction(connection, self._database)
        connection = connection if connection is not None else self._connect()
        try:
            result = connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET runtime_workdir = ?, project_path = ?, output_root = ?, updated_at = ?
                WHERE session_id = ? AND {condition}
                """,
                (*roots, timestamp, session_id, *owner_params),
            )
            if result.rowcount != 1:
                raise SessionAccessError("session not found")
            record = self._record(
                connection.execute(
                    f"SELECT * FROM {SESSION_CATALOG_TABLE} WHERE session_id = ?", (session_id,)
                ).fetchone()
            )
            if record is None:
                raise SessionAccessError("session not found")
            if owned:
                connection.commit()
            return record
        except Exception:
            if owned:
                connection.rollback()
            raise
        finally:
            if owned:
                connection.close()

    def adopt_generated_title(
        self,
        session_id: str,
        title: str,
        *,
        replaceable_titles: Sequence[str],
        updated_at: float | None = None,
    ) -> SessionCatalogRecord:
        """Adopt a runtime-generated title without overwriting a user rename."""

        timestamp = float(updated_at if updated_at is not None else time.time())
        allowed = tuple(value.strip() for value in replaceable_titles if value.strip())
        if allowed:
            placeholders = ", ".join("?" for _ in allowed)
            with closing(self._connect()) as connection, connection:
                connection.execute(
                    f"""
                    UPDATE {SESSION_CATALOG_TABLE}
                    SET title = ?, title_fallback = NULL, updated_at = ?
                    WHERE session_id = ? AND title IN ({placeholders})
                    """,
                    (title.strip(), timestamp, session_id, *allowed),
                )
        record = self.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        return record

    def save_todos(
        self,
        session_id: str,
        todos: Sequence[dict[str, Any]],
        *,
        vendor_turn_id: str,
        product_seq: int,
        explanation: str | None,
        connection: sqlite3.Connection | None = None,
    ) -> tuple[dict[str, Any], ...]:
        """Persist one authoritative plan snapshot in its event transaction."""

        if product_seq <= INITIAL_PRODUCT_SEQUENCE:
            raise ValueError("todo product sequence must be positive")
        incoming = tuple(dict(item) for item in list(todos)[:MAX_PERSISTED_TODOS])
        payload = json.dumps(incoming, ensure_ascii=False, separators=(",", ":"))
        owned = connection is None
        if connection is not None:
            validate_transaction(connection, self._database)
        connection = connection if connection is not None else self._connect()
        try:
            row = connection.execute(
                f"""
                SELECT todos, todo_turn_id, todo_product_seq, todo_explanation
                FROM {SESSION_CATALOG_TABLE} WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
            if row is None:
                raise SessionAccessError("session not found")
            current_seq = int(row["todo_product_seq"])
            if product_seq < current_seq:
                return self._decode_todos(row["todos"])
            if product_seq == current_seq:
                current = self._decode_todos(row["todos"])
                current_turn = str(row["todo_turn_id"] or "")
                current_explanation = str(row["todo_explanation"] or "") or None
                if (
                    current != incoming
                    or current_turn != vendor_turn_id
                    or current_explanation != explanation
                ):
                    raise SessionStateConflictError(
                        f"todo sequence {product_seq} was reused with different content"
                    )
                return current
            connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET todos = ?, todo_turn_id = ?, todo_product_seq = ?,
                    todo_explanation = ?, updated_at = ?
                WHERE session_id = ?
                """,
                (
                    payload,
                    vendor_turn_id,
                    product_seq,
                    explanation,
                    time.time(),
                    session_id,
                ),
            )
            if owned:
                connection.commit()
            return incoming
        except Exception:
            if owned:
                connection.rollback()
            raise
        finally:
            if owned:
                connection.close()

    def todos(self, session_id: str) -> tuple[dict[str, Any], ...]:
        record = self.get(session_id)
        return record.todos if record is not None else ()

    def record_hil(
        self,
        *,
        product_request_id: str,
        session_id: str,
        vendor_request_id: str,
        vendor_turn_id: str | None,
        vendor_item_id: str | None,
        method: str,
        payload: dict[str, Any],
        created_at: float | None = None,
    ) -> SessionHilRecord:
        required = (product_request_id, session_id, vendor_request_id, method)
        if any(not value.strip() for value in required):
            raise ValueError("HIL identity fields must not be empty")
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        timestamp = float(created_at if created_at is not None else time.time())
        try:
            with closing(self._connect()) as connection, connection:
                connection.execute(
                    f"""
                    INSERT INTO {SESSION_HIL_TABLE} (
                        product_request_id, session_id, vendor_request_id,
                        vendor_turn_id, vendor_item_id, method, payload, status, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(product_request_id) DO NOTHING
                    """,
                    (
                        product_request_id,
                        session_id,
                        vendor_request_id,
                        (vendor_turn_id or "").strip() or None,
                        (vendor_item_id or "").strip() or None,
                        method,
                        encoded,
                        HilStatus.PENDING.value,
                        timestamp,
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise SessionStateConflictError(
                f"vendor HIL request {vendor_request_id} is already mapped"
            ) from exc
        record = self.hil(product_request_id)
        expected = (
            session_id,
            vendor_request_id,
            (vendor_turn_id or "").strip() or None,
            (vendor_item_id or "").strip() or None,
            method,
            payload,
        )
        actual = (
            record.session_id,
            record.vendor_request_id,
            record.vendor_turn_id,
            record.vendor_item_id,
            record.method,
            record.payload,
        )
        if actual != expected:
            raise SessionStateConflictError(f"product HIL request {product_request_id} was reused")
        return record

    def hil(self, product_request_id: str) -> SessionHilRecord:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"SELECT * FROM {SESSION_HIL_TABLE} WHERE product_request_id = ?",
                (product_request_id,),
            ).fetchone()
        record = self._hil_record(row)
        if record is None:
            raise SessionAccessError("HIL request not found")
        return record

    def pending_hil(self, session_id: str) -> tuple[SessionHilRecord, ...]:
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {SESSION_HIL_TABLE}
                WHERE session_id = ? AND status = ? ORDER BY created_at, product_request_id
                """,
                (session_id, HilStatus.PENDING.value),
            ).fetchall()
        return tuple(record for row in rows if (record := self._hil_record(row)) is not None)

    def turn_hil(self, session_id: str, vendor_turn_id: str) -> tuple[SessionHilRecord, ...]:
        """Return durable HIL decisions for one native turn, including terminal states."""

        if not session_id.strip() or not vendor_turn_id.strip():
            return ()
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {SESSION_HIL_TABLE}
                WHERE session_id = ? AND vendor_turn_id = ?
                ORDER BY created_at, product_request_id
                """,
                (session_id, vendor_turn_id),
            ).fetchall()
        return tuple(record for row in rows if (record := self._hil_record(row)) is not None)

    def pending_hil_for_principal(
        self, principal: SessionPrincipal
    ) -> tuple[SessionHilRecord, ...]:
        """Return pending callbacks across every session visible to one owner."""

        condition, owner_params = self._owner_condition(principal)
        qualified_condition = condition.replace("principal_id", "catalog.principal_id")
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT hil.* FROM {SESSION_HIL_TABLE} AS hil
                JOIN {SESSION_CATALOG_TABLE} AS catalog
                  ON catalog.session_id = hil.session_id
                WHERE {qualified_condition} AND hil.status = ?
                ORDER BY hil.created_at, hil.product_request_id
                """,
                (*owner_params, HilStatus.PENDING.value),
            ).fetchall()
        return tuple(record for row in rows if (record := self._hil_record(row)) is not None)

    def acknowledge_hil(
        self,
        product_request_id: str,
        *,
        resolved_at: float | None = None,
    ) -> SessionHilRecord:
        """Record a native acknowledgement without replacing the product decision."""

        timestamp = float(resolved_at if resolved_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            connection.execute(
                f"""
                UPDATE {SESSION_HIL_TABLE}
                SET status = ?, resolved_at = COALESCE(resolved_at, ?)
                WHERE product_request_id = ? AND status IN (?, ?)
                """,
                (
                    HilStatus.RESOLVED.value,
                    timestamp,
                    product_request_id,
                    HilStatus.PENDING.value,
                    HilStatus.UNKNOWN.value,
                ),
            )
        return self.hil(product_request_id)

    def resolve_hil(
        self,
        product_request_id: str,
        decision: dict[str, Any],
        *,
        resolved_at: float | None = None,
    ) -> bool:
        timestamp = float(resolved_at if resolved_at is not None else time.time())
        encoded = json.dumps(decision, ensure_ascii=False, separators=(",", ":"))
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"""
                UPDATE {SESSION_HIL_TABLE}
                SET status = ?, decision = ?, resolved_at = ?
                WHERE product_request_id = ? AND status IN (?, ?)
                """,
                (
                    HilStatus.RESOLVED.value,
                    encoded,
                    timestamp,
                    product_request_id,
                    HilStatus.PENDING.value,
                    HilStatus.UNKNOWN.value,
                ),
            )
        return cursor.rowcount == 1

    def seal_hil_uncertainty(
        self,
        product_request_id: str,
        decision: dict[str, Any],
        kind: UncertaintyKind,
        *,
        payload: dict[str, Any],
        process_generation: int = 0,
        created_at: float | None = None,
    ) -> bool:
        """Atomically seal a HIL response and claim its at-most-once delivery."""

        if kind not in {UncertaintyKind.HIL_RESPONSE, UncertaintyKind.TOOL_RESPONSE}:
            raise ValueError("HIL delivery requires a response uncertainty kind")
        timestamp = float(created_at if created_at is not None else time.time())
        decision_json = json.dumps(decision, ensure_ascii=False, separators=(",", ":"))
        payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"""
                SELECT session_id FROM {SESSION_HIL_TABLE}
                WHERE product_request_id = ? AND status = ?
                """,
                (product_request_id, HilStatus.PENDING.value),
            ).fetchone()
            if row is None:
                return False
            session_id = str(row["session_id"])
            claimed = connection.execute(
                f"""
                INSERT INTO {SESSION_UNCERTAINTY_TABLE} (
                    session_id, kind, correlation_id, process_generation,
                    state, payload, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id, kind, correlation_id) DO NOTHING
                """,
                (
                    session_id,
                    kind.value,
                    product_request_id,
                    int(process_generation),
                    UncertaintyState.EXECUTING.value,
                    payload_json,
                    timestamp,
                ),
            )
            if claimed.rowcount != 1:
                return False
            sealed = connection.execute(
                f"""
                UPDATE {SESSION_HIL_TABLE}
                SET status = ?, decision = ?
                WHERE product_request_id = ? AND status = ?
                """,
                (
                    HilStatus.UNKNOWN.value,
                    decision_json,
                    product_request_id,
                    HilStatus.PENDING.value,
                ),
            )
            if sealed.rowcount != 1:
                raise SessionStateConflictError("HIL seal lost its pending precondition")
        return True

    def confirm_turn_uncertainty(
        self,
        session_id: str,
        correlation_id: str,
        *,
        turn_status: str,
        resolution: str,
        resolved_at: float | None = None,
    ) -> bool:
        """Atomically persist human confirmation and reopen session admission."""

        timestamp = float(resolved_at if resolved_at is not None else time.time())
        payload = json.dumps({"resolution": resolution}, separators=(",", ":"))
        with closing(self._connect()) as connection, connection:
            transitioned = connection.execute(
                f"""
                UPDATE {SESSION_UNCERTAINTY_TABLE}
                SET state = ?, payload = ?, resolved_at = ?
                WHERE session_id = ? AND kind = ? AND correlation_id = ?
                  AND state IN (?, ?)
                """,
                (
                    UncertaintyState.CONFIRMED.value,
                    payload,
                    timestamp,
                    session_id,
                    UncertaintyKind.TURN.value,
                    correlation_id,
                    UncertaintyState.EXECUTING.value,
                    UncertaintyState.UNKNOWN.value,
                ),
            )
            if transitioned.rowcount != 1:
                return False
            reopened = connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET status = ?, last_turn_id = ?, last_turn_status = ?, updated_at = ?
                WHERE session_id = ?
                """,
                (
                    SessionStatus.READY.value,
                    correlation_id,
                    turn_status,
                    timestamp,
                    session_id,
                ),
            )
            if reopened.rowcount != 1:
                raise SessionAccessError("session not found")
        return True

    def reconcile_interrupted_turn_uncertainty(
        self,
        session_id: str,
        correlation_id: str,
        *,
        resolution: str,
        resolved_at: float | None = None,
    ) -> bool:
        """Atomically resolve an uncertain turn after a verified product interrupt."""

        timestamp = float(resolved_at if resolved_at is not None else time.time())
        payload = json.dumps({"resolution": resolution}, separators=(",", ":"))
        with closing(self._connect()) as connection, connection:
            transitioned = connection.execute(
                f"""
                UPDATE {SESSION_UNCERTAINTY_TABLE}
                SET state = ?, payload = ?, resolved_at = ?
                WHERE session_id = ? AND kind = ? AND correlation_id = ?
                  AND state IN (?, ?)
                """,
                (
                    UncertaintyState.RECONCILED.value,
                    payload,
                    timestamp,
                    session_id,
                    UncertaintyKind.TURN.value,
                    correlation_id,
                    UncertaintyState.EXECUTING.value,
                    UncertaintyState.UNKNOWN.value,
                ),
            )
            if transitioned.rowcount != 1:
                return False
            reopened = connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET status = ?, last_turn_id = ?, last_turn_status = ?, updated_at = ?
                WHERE session_id = ?
                """,
                (
                    SessionStatus.INTERRUPTED.value,
                    correlation_id,
                    PRODUCT_TURN_OUTCOME_INTERRUPTED,
                    timestamp,
                    session_id,
                ),
            )
            if reopened.rowcount != 1:
                raise SessionAccessError("session not found")
        return True

    def stale_hil(
        self,
        product_request_id: str,
        *,
        resolved_at: float | None = None,
    ) -> bool:
        timestamp = float(resolved_at if resolved_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"""
                UPDATE {SESSION_HIL_TABLE}
                SET status = ?, resolved_at = ?
                WHERE product_request_id = ? AND status IN (?, ?)
                """,
                (
                    HilStatus.STALE.value,
                    timestamp,
                    product_request_id,
                    HilStatus.PENDING.value,
                    HilStatus.UNKNOWN.value,
                ),
            )
        return cursor.rowcount == 1

    def claim_uncertainty(
        self,
        session_id: str,
        kind: UncertaintyKind,
        correlation_id: str,
        *,
        incident_id: str | None = None,
        process_generation: int = 0,
        state: UncertaintyState = UncertaintyState.EXECUTING,
        payload: dict[str, Any] | None = None,
        created_at: float | None = None,
    ) -> bool:
        """Claim one at-most-once operation; false means an earlier attempt owns it."""

        if not session_id.strip() or not correlation_id.strip():
            raise ValueError("uncertainty identity fields must not be empty")
        encoded = json.dumps(payload or {}, ensure_ascii=False, separators=(",", ":"))
        timestamp = float(created_at if created_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"""
                INSERT INTO {SESSION_UNCERTAINTY_TABLE} (
                    session_id, kind, correlation_id, incident_id,
                    process_generation, state, payload, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id, kind, correlation_id) DO NOTHING
                """,
                (
                    session_id,
                    UncertaintyKind(kind).value,
                    correlation_id,
                    (incident_id or "").strip() or None,
                    int(process_generation),
                    UncertaintyState(state).value,
                    encoded,
                    timestamp,
                ),
            )
        return cursor.rowcount == 1

    def transition_uncertainty(
        self,
        session_id: str,
        kind: UncertaintyKind,
        correlation_id: str,
        state: UncertaintyState,
        *,
        incident_id: str | None = None,
        process_generation: int | None = None,
        payload: dict[str, Any] | None = None,
        resolved_at: float | None = None,
    ) -> bool:
        terminal = state in {
            UncertaintyState.RECONCILED,
            UncertaintyState.CONFIRMED,
            UncertaintyState.STALE,
        }
        encoded = (
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            if payload is not None
            else None
        )
        timestamp = float(resolved_at if resolved_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"""
                UPDATE {SESSION_UNCERTAINTY_TABLE}
                SET state = ?,
                    incident_id = COALESCE(?, incident_id),
                    process_generation = COALESCE(?, process_generation),
                    payload = COALESCE(?, payload),
                    resolved_at = ?
                WHERE session_id = ? AND kind = ? AND correlation_id = ?
                """,
                (
                    UncertaintyState(state).value,
                    (incident_id or "").strip() or None,
                    process_generation,
                    encoded,
                    timestamp if terminal else None,
                    session_id,
                    UncertaintyKind(kind).value,
                    correlation_id,
                ),
            )
        return cursor.rowcount == 1

    def uncertainty(
        self,
        session_id: str,
        kind: UncertaintyKind,
        correlation_id: str,
    ) -> SessionUncertaintyRecord | None:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"""
                SELECT * FROM {SESSION_UNCERTAINTY_TABLE}
                WHERE session_id = ? AND kind = ? AND correlation_id = ?
                """,
                (session_id, UncertaintyKind(kind).value, correlation_id),
            ).fetchone()
        return self._uncertainty_record(row)

    def uncertainties(
        self,
        session_id: str,
        *,
        unresolved_only: bool = False,
    ) -> tuple[SessionUncertaintyRecord, ...]:
        conditions = ""
        parameters: list[Any] = [session_id]
        if unresolved_only:
            conditions = " AND state IN (?, ?, ?)"
            parameters.extend(
                (
                    UncertaintyState.EXECUTING.value,
                    UncertaintyState.UNKNOWN.value,
                    UncertaintyState.STALE.value,
                )
            )
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {SESSION_UNCERTAINTY_TABLE}
                WHERE session_id = ?{conditions}
                ORDER BY created_at, kind, correlation_id
                """,
                parameters,
            ).fetchall()
        return tuple(
            record for row in rows if (record := self._uncertainty_record(row)) is not None
        )

    def expire_pending_hil(
        self,
        session_id: str,
        *,
        resolved_at: float | None = None,
    ) -> tuple[SessionHilRecord, ...]:
        """Mark pending HIL as expired and return the freshly-updated records so
        the runtime can broadcast a matching `hil_resolved` event. Front-ends key
        their permission overlays on that event; expiring only the DB row would
        leave the overlay floating after an interrupt."""
        timestamp = float(resolved_at if resolved_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {SESSION_HIL_TABLE}
                WHERE session_id = ? AND status = ?
                """,
                (session_id, HilStatus.PENDING.value),
            ).fetchall()
            if not rows:
                return ()
            connection.execute(
                f"""
                UPDATE {SESSION_HIL_TABLE}
                SET status = ?, resolved_at = ?
                WHERE session_id = ? AND status = ?
                """,
                (
                    HilStatus.EXPIRED.value,
                    timestamp,
                    session_id,
                    HilStatus.PENDING.value,
                ),
            )
        expired: list[SessionHilRecord] = []
        for row in rows:
            record = self._hil_record(row)
            if record is None:
                continue
            expired.append(
                dataclasses.replace(record, status=HilStatus.EXPIRED, resolved_at=timestamp)
            )
        return tuple(expired)

    def expire_hil(
        self,
        product_request_id: str,
        *,
        resolved_at: float | None = None,
    ) -> bool:
        timestamp = float(resolved_at if resolved_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"""
                UPDATE {SESSION_HIL_TABLE}
                SET status = ?, resolved_at = ?
                WHERE product_request_id = ? AND status = ?
                """,
                (
                    HilStatus.EXPIRED.value,
                    timestamp,
                    product_request_id,
                    HilStatus.PENDING.value,
                ),
            )
        return cursor.rowcount == 1

    def require(self, session_id: str, principal: SessionPrincipal) -> None:
        condition, owner_params = self._owner_condition(principal)
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"""
                SELECT 1 FROM {SESSION_CATALOG_TABLE}
                WHERE session_id = ? AND {condition}
                """,
                (session_id, *owner_params),
            ).fetchone()
        if row is None:
            raise SessionAccessError("session not found")

    def get(self, session_id: str) -> SessionCatalogRecord | None:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"SELECT * FROM {SESSION_CATALOG_TABLE} WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        return self._record(row)

    def principal(self, session_id: str) -> SessionPrincipal:
        record = self.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        return SessionPrincipal(user_id=record.principal_id)

    def owned(self, principal: SessionPrincipal) -> dict[str, SessionCatalogRecord]:
        condition, owner_params = self._owner_condition(principal)
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {SESSION_CATALOG_TABLE}
                WHERE {condition} ORDER BY updated_at DESC, session_id
                """,
                owner_params,
            ).fetchall()
        return {
            record.session_id: record for row in rows if (record := self._record(row)) is not None
        }

    def listed(
        self,
        principal: SessionPrincipal,
        *,
        runtime_id: str | None,
        scope: SessionListScope,
        project_path: str | None,
        limit: int | None,
        exclude_session_id: str = "",
        created_before: float | None = None,
    ) -> tuple[SessionCatalogRecord, ...]:
        """List one catalog scope with all filters applied before ``LIMIT``."""

        condition, owner_params = self._owner_condition(principal)
        clauses = [condition]
        params: list[str | int | float] = [*owner_params]
        if runtime_id is not None:
            clauses.append("runtime_id = ?")
            params.append(runtime_id)
        if exclude_session_id:
            clauses.append("session_id != ?")
            params.append(exclude_session_id)
        if created_before is not None:
            clauses.append("created_at <= ?")
            params.append(created_before)
        if scope is SessionListScope.PROJECT:
            clauses.append("project_path = ?")
            params.append(project_path or "")
        elif scope is SessionListScope.UNASSIGNED:
            clauses.append("project_path IS NULL")
        limit_clause = ""
        if limit is not None:
            limit_clause = "LIMIT ?"
            params.append(limit)
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {SESSION_CATALOG_TABLE}
                WHERE {' AND '.join(clauses)}
                ORDER BY updated_at DESC, session_id
                {limit_clause}
                """,
                tuple(params),
            ).fetchall()
        return tuple(record for row in rows if (record := self._record(row)) is not None)

    def owned_session_ids(self, principal: SessionPrincipal) -> frozenset[str]:
        return frozenset(self.owned(principal))

    def session_ids(self) -> tuple[str, ...]:
        """Return product session ids for local aggregate read models."""

        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"SELECT session_id FROM {SESSION_CATALOG_TABLE} ORDER BY created_at, session_id"
            ).fetchall()
        return tuple(str(row["session_id"]) for row in rows)

    def release(self, session_id: str, principal: SessionPrincipal) -> None:
        condition, owner_params = self._owner_condition(principal)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                f"""
                DELETE FROM {SESSION_CATALOG_TABLE}
                WHERE session_id = ? AND {condition}
                """,
                (session_id, *owner_params),
            )
