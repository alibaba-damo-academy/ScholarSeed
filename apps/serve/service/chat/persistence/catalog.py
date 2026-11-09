"""Durable product-session catalog and human-interaction state."""

from __future__ import annotations

import dataclasses
import hashlib
import hmac
import json
import math
import secrets
import sqlite3
import time
from contextlib import ExitStack, closing, nullcontext
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Sequence

from scholarseed_runtime.contract import (
    ActorKind,
    CapabilitySet,
    CapabilityState,
    DeliveryClass,
    ModelThinking,
    RuntimeBinding,
    RuntimeCapability,
    RuntimeCapabilityName,
    RuntimeEvent,
    RuntimeEventKind,
)
from scholarseed_runtime.contract.command import EmptyThreadReplacementProof, ThreadReplacementProof
from scholarseed_runtime.contract.history import HistoryEntry, MessagePhase
from scholarseed_runtime.contract.incident import (
    INCIDENT_ID_KEY,
    INCIDENT_PAYLOAD_KEY,
    RESOLVED_AMBIGUOUS_INCIDENT_ID_KEY,
    RUNTIME_TURN_NOT_SUBMITTED,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.inventory import SkillPolicy
from service.chat.constants import (
    PRODUCT_INTERACTION_BLOCKING,
    PRODUCT_TURN_OUTCOME_INTERRUPTED,
    PRODUCT_TURN_OUTCOME_UNKNOWN,
    SessionTitleFallback,
)
from service.chat.persistence import journal
from service.chat.persistence.utils import begin_write, validate_transaction
from service.paths import SESSION_CATALOG_DB
from service.persistence.limits import SQLITE_VALUE_BYTES
from service.persistence.notifications import NotificationConnection
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
from service.platform.bridge import (
    BRIDGE_CALLBACK_REQUEST_CHARS,
    BRIDGE_CALLBACK_REQUEST_PATTERN,
)

SESSION_CATALOG_TABLE = "session_catalog"
CAPABILITY_SNAPSHOT_ENTRIES = "entries"
CAPABILITY_SNAPSHOT_OPTIONAL = "optional_capabilities"
CAPABILITY_SNAPSHOT_SKILL_POLICY = "skill_policy"
SESSION_HIL_TABLE = "session_hil"
SESSION_BROWSER_ACTION_TABLE = "session_browser_action"
SESSION_BROWSER_ACTION_WATERMARK_TABLE = "session_browser_action_watermark"
SESSION_UNCERTAINTY_TABLE = "session_uncertainty"
UNCERTAINTY_RUNTIME_EVENT_KEY = "runtime_event"
UNCERTAINTY_CONFIRMATION_KEY = "turn_confirmation"
UNCERTAINTY_THREAD_REPLACEMENT_KEY = "thread_replacement"
SESSION_MODEL_TABLE = "session_model_state"
# 开关/预算形态的思考选择按结构化 JSON 存这两列；NULL 表示「没选」。
SESSION_THINKING_COLUMNS = ("selected_thinking_json", "active_thinking_json")


SESSION_PORTABLE_HISTORY_TABLE = "session_portable_history"
SESSION_RUNTIME_BINDING_TABLE = "session_runtime_binding"
SESSION_MESSAGE_QUEUE_TABLE = "session_message_queue"
SESSION_ACTIVATION_TABLE = "session_activation"
SESSION_TASK_BINDING_TABLE = "session_task_binding"
SESSION_TURN_SETTLEMENT_TABLE = "session_turn_settlement"
SESSION_REPLACEMENT_TABLE = "session_runtime_replacement"
TURN_SETTLEMENT_RESOLUTION_KINDS = frozenset(
    {
        RuntimeEventKind.TURN_COMPLETED,
        RuntimeEventKind.TURN_FAILED,
        RuntimeEventKind.TURN_INTERRUPTED,
    }
)
TURN_SUBMISSION_UNKNOWN_KINDS = frozenset(
    {RuntimeIncidentKind.RPC_TIMEOUT.value, RuntimeIncidentKind.TRANSPORT_LOST.value}
)
TURN_SUBMISSION_RPC_METHOD = "turn/start"
QUEUE_PURPOSE_TURN = "turn"
QUEUE_PURPOSE_RECOVERY = "crash_recovery"
QUEUE_RECOVERY_UNKNOWN_ERROR = "runtime_submission_outcome_unknown"
QUEUE_RECOVERY_WAIT_INTERRUPTED = "runtime_resource_wait_interrupted"
INITIAL_ATTACHMENT_GENERATION = 0
PORTABLE_HISTORY_ROLES = frozenset(("user", "assistant"))
LEGACY_SESSION_TABLE = "session_access"
LEGACY_RUNTIME_ID = "legacy_damoagent"
SQLITE_TIMEOUT_SECONDS = 30.0
MAX_PERSISTED_TODOS = 200
MAX_QUEUED_MESSAGES_PER_SESSION = 100
MAX_BROWSER_ACTION_RECORDS = 262_144
MAX_BROWSER_ACTION_SIGNATURE_BYTES = 16_384
MAX_BROWSER_ACTION_ID_CHARS = 128
BROWSER_ACTION_OPERATIONS = frozenset(
    ("navigate", "snapshot", "read", "click", "fill", "submit", "history_search")
)
BROWSER_ACTION_SCOPE_FIELDS = frozenset(
    (
        "session_id",
        "instance_id",
        "product_turn_id",
        "turn_id",
        "generation",
        "interrupt_generation",
        "lifecycle_epoch",
    )
)
BROWSER_ACTION_ADDITIVE_COLUMNS = {
    "instance_id": "TEXT",
    "product_turn_id": "TEXT",
    "generation": "INTEGER",
    "interrupt_generation": "INTEGER",
    "lifecycle_epoch": "INTEGER",
}
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
        "pinned",
        "archived",
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
    "next_turn_mode": "TEXT",
    "status": f"TEXT NOT NULL DEFAULT '{SessionStatus.LEGACY_READONLY.value}'",
    "last_turn_id": "TEXT",
    "last_turn_status": "TEXT",
    "last_product_seq": "INTEGER NOT NULL DEFAULT 0",
    "title": "TEXT NOT NULL DEFAULT ''",
    "title_fallback": "TEXT",
    "pinned": "INTEGER NOT NULL DEFAULT 0",
    "archived": "INTEGER NOT NULL DEFAULT 0",
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


class BrowserActionStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DISPATCHING = "dispatching"
    SUCCEEDED = "succeeded"
    DENIED = "denied"
    UNKNOWN = "unknown"


BROWSER_ACTION_TRANSITIONS = {
    BrowserActionStatus.PENDING: frozenset(
        (BrowserActionStatus.APPROVED, BrowserActionStatus.DENIED, BrowserActionStatus.UNKNOWN)
    ),
    BrowserActionStatus.APPROVED: frozenset(
        (BrowserActionStatus.DISPATCHING, BrowserActionStatus.DENIED, BrowserActionStatus.UNKNOWN)
    ),
    BrowserActionStatus.DISPATCHING: frozenset(
        (BrowserActionStatus.SUCCEEDED, BrowserActionStatus.UNKNOWN)
    ),
}


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


class SubmissionMode(str, Enum):
    DIRECT = "direct"
    QUEUED = "queued"


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
    "safe_error_details": "TEXT NOT NULL DEFAULT '{}'",
    "deadline": "REAL",
    "purpose": f"TEXT NOT NULL DEFAULT '{QUEUE_PURPOSE_TURN}'",
    "native_turn_id": "TEXT NOT NULL DEFAULT ''",
    "submission_mode": f"TEXT NOT NULL DEFAULT '{SubmissionMode.QUEUED.value}'",
}


class OpenState(str, Enum):
    NEVER_STARTED = "never_started"
    OPENING = "opening"
    OPEN_UNKNOWN = "open_unknown"
    UNSUBMITTED = "unsubmitted"
    BOUND = "bound"


class ReplacementState(str, Enum):
    PROVEN = "proven"
    OPENING = "opening"
    BOUND = "bound"
    UNKNOWN = "unknown"
    NOT_APPLIED = "not_applied"


class ReplacementKind(str, Enum):
    EMPTY_THREAD = "empty_thread"
    HISTORY_REBUILD = "history_rebuild"


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
    submission_mode: SubmissionMode = SubmissionMode.QUEUED
    safe_error_details: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class PendingTurnSettlement:
    session_id: str
    client_turn_id: str
    native_turn_id: str
    event: RuntimeEvent
    created_at: float
    recovery_blocked: bool = False


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
    next_turn_mode: str | None = None
    pinned: bool = False
    archived: bool = False


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
class BrowserActionRecord:
    request_id: str
    session_id: str
    turn_id: str
    operation: str
    status: BrowserActionStatus
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class BrowserActionReservation:
    record: BrowserActionRecord
    created: bool


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


CATALOG_BODY_FIELDS = {
    SESSION_REPLACEMENT_TABLE: ("payload",),
    SESSION_PORTABLE_HISTORY_TABLE: ("text",),
    SESSION_MESSAGE_QUEUE_TABLE: ("body",),
    SESSION_HIL_TABLE: ("payload", "decision"),
    SESSION_UNCERTAINTY_TABLE: ("payload",),
    SESSION_TURN_SETTLEMENT_TABLE: ("event_json",),
}
CATALOG_BODY_KEYS = {
    SESSION_REPLACEMENT_TABLE: ("session_id",),
    SESSION_PORTABLE_HISTORY_TABLE: ("session_id", "ordinal"),
    SESSION_MESSAGE_QUEUE_TABLE: ("queued_message_id",),
    SESSION_HIL_TABLE: ("product_request_id",),
    SESSION_UNCERTAINTY_TABLE: ("session_id", "kind", "correlation_id"),
    SESSION_TURN_SETTLEMENT_TABLE: ("session_id",),
}
CATALOG_BODY_COLUMNS = frozenset(
    body_field for fields in CATALOG_BODY_FIELDS.values() for body_field in fields
)
CATALOG_BODY_BATCH_ROWS = 128
CATALOG_BODY_BATCH_BYTES = 1024 * 1024
BODY_REFERENCE_SUFFIX = "_ref"


def _browser_scope_integer(scope: Mapping[str, object], field: str) -> int:
    value = scope[field]
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("browser action scope invalid")
    return value


def _inline_body_condition(body_field: str) -> str:
    return f"{body_field}_ref IS NULL AND {body_field} IS NOT NULL AND {body_field} != ''"


def _body_database(connection: sqlite3.Connection, database: Path | None = None) -> Path:
    if database is not None:
        return database
    for row in connection.execute("PRAGMA database_list"):
        if row[1] == "main" and row[2]:
            return Path(row[2])
    raise RuntimeError("session body references require the original database path")


def _store_body(connection: sqlite3.Connection, text: str) -> str:
    if not connection.in_transaction:
        begin_write(connection, _body_database(connection))
    with journal.Journal(connection, _body_database(connection)) as bodies:
        return bodies.put(text)


def _materialize_rows(
    connection: sqlite3.Connection,
    rows: Sequence[sqlite3.Row],
    database: Path | None = None,
    *,
    bodies: journal.Journal | None = None,
) -> list[dict[str, Any]]:
    result = [dict(row) for row in rows]
    referenced = [
        (row, body_field)
        for row in result
        for body_field in CATALOG_BODY_COLUMNS
        if body_field + BODY_REFERENCE_SUFFIX in row
        and row[body_field + BODY_REFERENCE_SUFFIX] is not None
    ]
    if referenced:
        if bodies is not None and (
            bodies.connection is not connection
            or (database is not None and bodies.database != database)
        ):
            raise ValueError("session body reader does not match its qualified snapshot")
        scope = (
            nullcontext(bodies)
            if bodies is not None
            else journal.Journal(connection, _body_database(connection, database))
        )
        with scope as reader:
            for row, body_field in referenced:
                if row[body_field] != "":
                    raise RuntimeError("session body has both inline content and a reference")
                row[body_field] = reader.get(row[body_field + BODY_REFERENCE_SUFFIX])
    return result


def _materialize_row(
    connection: sqlite3.Connection, row: sqlite3.Row | None, database: Path | None = None
) -> Mapping[str, Any] | None:
    return _materialize_rows(connection, [row], database)[0] if row is not None else None


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


@dataclass(frozen=True)
class SessionSchema:
    """Session-owned initialization requirements, not whole-product admission."""

    create_tables: tuple[str, ...]
    add_columns: tuple[tuple[str, str], ...]
    create_indexes: tuple[str, ...]
    foreign_key_repairs: tuple[str, ...]
    rename_legacy: bool
    catalog_backfill: bool
    binding_backfill: bool
    activation_backfill: bool

    @property
    def needs_write(self) -> bool:
        return any(
            (
                self.create_tables,
                self.add_columns,
                self.create_indexes,
                self.foreign_key_repairs,
                self.rename_legacy,
                self.catalog_backfill,
                self.binding_backfill,
                self.activation_backfill,
            )
        )


class BrowserActionCapacityError(RuntimeError):
    """The durable browser action ledger cannot accept a new request."""


class SessionCatalogStore:
    """Single Service authority for session binding, projection, and HIL state."""

    def __init__(self, database: Path | None = None, *, shared_ownership: bool = False) -> None:
        self.observe: Callable[[NotificationConnection], None] | None = None
        self._database = Path(database or SESSION_CATALOG_DB)
        self._browser_action_key = secrets.token_bytes(32)
        self._browser_action_epoch = secrets.token_hex(16)
        # 共享归属只改**读写谓词**, 不改列: principal_id 始终如实记录建会话的那个账号。
        # 因此轴改回按账号隔离时每行的原主还在, 全程不需要任何不可逆的数据迁移。
        self._shared_ownership = bool(shared_ownership)
        if not self.inspect_schema(self._database).needs_write:
            return
        self._database.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection, schema_transaction(connection):
            self.initialize_schema(connection)
            if self.inspect_connection(connection).needs_write:
                raise RuntimeError("session initialization did not reach the supported format")

    @property
    def shared_ownership(self) -> bool:
        return self._shared_ownership

    @classmethod
    def inspect_schema(cls, database: Path) -> SessionSchema:
        """Inspect one WAL snapshot; the caller must protect its bearing directory.

        No source DDL/DML is executed. SQLite mode=ro may still touch SHM; this
        method does not qualify filesystem objects or grant maintenance access.
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
    def inspect_connection(cls, connection: sqlite3.Connection) -> SessionSchema:
        objects = {
            row["name"]: row
            for row in connection.execute("SELECT name,type,tbl_name,sql FROM sqlite_master")
        }
        if LEGACY_SESSION_TABLE in objects and SESSION_CATALOG_TABLE in objects:
            raise RuntimeError("session catalogs coexist; recovery required")
        source = SESSION_CATALOG_TABLE if SESSION_CATALOG_TABLE in objects else LEGACY_SESSION_TABLE
        rename = source == LEGACY_SESSION_TABLE and source in objects
        additions = {
            SESSION_CATALOG_TABLE: set(CATALOG_ADDITIVE_COLUMNS),
            SESSION_MODEL_TABLE: {
                "selected_reasoning_effort",
                "active_reasoning_effort",
                *SESSION_THINKING_COLUMNS,
            },
            SESSION_MESSAGE_QUEUE_TABLE: set(QUEUE_ADDITIVE_COLUMNS),
            SESSION_BROWSER_ACTION_TABLE: set(BROWSER_ACTION_ADDITIVE_COLUMNS),
            SESSION_TURN_SETTLEMENT_TABLE: {"recovery_blocked"},
        }
        for table, fields in CATALOG_BODY_FIELDS.items():
            additions.setdefault(table, set()).update(
                field + BODY_REFERENCE_SUFFIX for field in fields
            )
        create_tables: list[str] = []
        add_columns: list[tuple[str, str]] = []
        create_indexes: list[str] = []
        repairs = cls._foreign_key_repairs(connection)
        with closing(sqlite3.connect(":memory:")) as reference:
            reference.row_factory = sqlite3.Row
            cls._create_schema(reference)
            owned = dict(reference.execute("SELECT name,sql FROM sqlite_master WHERE type='table'"))
            reject_schema_residue(connection, (*owned, LEGACY_SESSION_TABLE))
            if any(table + "_migration" in objects for table in (*owned, LEGACY_SESSION_TABLE)):
                raise RuntimeError("session migration residue requires recovery")
            for table, definition in owned.items():
                actual_name = source if table == SESSION_CATALOG_TABLE else table
                if actual_name not in objects:
                    create_tables.append(table)
                    continue
                if objects[actual_name]["type"] != "table":
                    raise RuntimeError("unsupported session table object")
                expected = table_clauses(definition, table)
                try:
                    observed = table_clauses(objects[actual_name]["sql"], actual_name)
                except ValueError as error:
                    raise RuntimeError("unsupported session table definition") from error
                declared = {row[1] for row in reference.execute(f"PRAGMA table_xinfo({table})")}
                actual = {
                    row["name"] for row in connection.execute(f"PRAGMA table_xinfo({actual_name})")
                }
                missing = declared - actual
                if missing - additions.get(table, set()):
                    raise RuntimeError("unsupported session missing columns")
                add_columns.extend((table, column) for column in sorted(missing))
                allowed = set(expected)
                historical = set()
                if table == SESSION_CATALOG_TABLE:
                    for name, value in CATALOG_ADDITIVE_COLUMNS.items():
                        allowed.update(
                            table_clauses(f"CREATE TABLE {table} ({name} {value})", table)
                        )
                    historical = set(
                        table_clauses(
                            f"CREATE TABLE {table} (work TEXT NOT NULL DEFAULT '', assignment_known INTEGER NOT NULL DEFAULT 0, todos TEXT NOT NULL DEFAULT '')",
                            table,
                        )
                    )
                    allowed.update(historical)
                corrected = []
                for clause in observed:
                    normalized = clause
                    if table in repairs and clause[:2] == ("foreign", "key"):
                        position = clause.index("references") + 1
                        normalized = (
                            *clause[:position],
                            SESSION_CATALOG_TABLE,
                            *clause[position + 1 :],
                        )
                    if normalized not in allowed or normalized in corrected:
                        raise RuntimeError("unsupported session schema declaration")
                    corrected.append(normalized)
                constraints = {clause for clause in expected if clause[0] not in declared}
                # Known additive legacy catalogs never acquired the newer UNIQUE.
                legacy_default = table_clauses(
                    f"CREATE TABLE {table} (runtime_id {CATALOG_ADDITIVE_COLUMNS['runtime_id']})",
                    table,
                )[0]
                if table == SESSION_CATALOG_TABLE and (rename or legacy_default in corrected):
                    constraints = {clause for clause in constraints if clause[0] != "unique"}
                if not constraints <= set(corrected):
                    raise RuntimeError("unsupported session missing constraints")
            for name, table, sql in reference.execute(
                "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
            ):
                if name not in objects:
                    create_indexes.append(name)
                elif (
                    objects[name]["type"] != "index"
                    or objects[name]["tbl_name"] != table
                    or sql_tokens(objects[name]["sql"]) != sql_tokens(sql)
                ):
                    raise RuntimeError("unsupported session owned index")
        columns = cls._columns(connection, source) if source in objects else frozenset()
        catalog_backfill = bool(columns and not CATALOG_COLUMNS <= columns)
        binding_backfill = False
        if (
            source in objects
            and "status" in columns
            and {"vendor_thread_id", "vendor_session_id"} & columns
        ):
            vendor = [
                name if name in columns else "NULL"
                for name in ("vendor_thread_id", "vendor_session_id")
            ]
            absent = (
                f"AND NOT EXISTS (SELECT 1 FROM {SESSION_RUNTIME_BINDING_TABLE} b WHERE b.product_session_id=s.session_id)"
                if SESSION_RUNTIME_BINDING_TABLE in objects
                else ""
            )
            binding_backfill = (
                connection.execute(
                    f"SELECT 1 FROM {source} s WHERE status != ? AND COALESCE({','.join(vendor)},'') != '' {absent} LIMIT 1",
                    (SessionStatus.LEGACY_READONLY.value,),
                ).fetchone()
                is not None
            )
        activation_backfill = binding_backfill
        if SESSION_RUNTIME_BINDING_TABLE in objects:
            absent = (
                f"AND NOT EXISTS (SELECT 1 FROM {SESSION_ACTIVATION_TABLE} a WHERE a.session_id=b.product_session_id)"
                if SESSION_ACTIVATION_TABLE in objects
                else ""
            )
            activation_backfill |= (
                connection.execute(
                    f"SELECT 1 FROM {SESSION_RUNTIME_BINDING_TABLE} b WHERE opaque_session_ref != '' {absent} LIMIT 1"
                ).fetchone()
                is not None
            )
        return SessionSchema(
            tuple(sorted(create_tables)),
            tuple(sorted(add_columns)),
            tuple(sorted(create_indexes)),
            repairs,
            rename,
            catalog_backfill,
            binding_backfill,
            activation_backfill,
        )

    def _owner_condition(self, principal: SessionPrincipal) -> tuple[str, tuple[str, ...]]:
        """归属谓词及其绑定参数。共享归属下退化为恒真。"""

        if self._shared_ownership:
            return SQL_CONDITION_ALWAYS_TRUE, ()
        return "principal_id = ?", (principal.user_id,)

    @property
    def database(self) -> Path:
        return self._database

    def owned_session_query(self, principal: SessionPrincipal) -> tuple[str, tuple[str, ...]]:
        condition, parameters = self._owner_condition(principal)
        return f"SELECT session_id FROM {SESSION_CATALOG_TABLE} WHERE {condition}", parameters

    def _connect(self) -> sqlite3.Connection:
        connection = open_database(
            str(self._database),
            check_same_thread=False,
            timeout=SQLITE_TIMEOUT_SECONDS,
            factory=NotificationConnection,
        )
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            if self.observe is not None:
                self.observe(connection)
        except BaseException:
            connection.close()
            raise
        return connection

    @classmethod
    def initialize_schema(cls, connection: sqlite3.Connection) -> None:
        schema = cls.inspect_connection(connection)
        if journal.inspect_connection(connection).needs_write:
            journal.initialize(connection)
        if not schema.needs_write:
            return
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
        cls._create_schema(connection)
        cls._repair_catalog_foreign_keys(connection)
        if schema.binding_backfill:
            cls._backfill_runtime_binding(connection)
        if schema.activation_backfill:
            cls._backfill_activation(connection)

    @classmethod
    def _create_schema(cls, connection: sqlite3.Connection) -> None:
        """Actual owned DDL, also used for an empty reference schema."""
        cls._create_catalog(connection)
        cls._create_model_state(connection)
        cls._create_portable_history(connection)
        cls._create_hil(connection)
        cls._create_browser_action(connection)
        cls._create_uncertainty(connection)
        cls._create_runtime_binding(connection)
        cls._create_activation(connection)
        cls._create_message_queue(connection)
        cls._create_turn_settlement(connection)
        cls._create_replacement(connection)
        for table, fields in CATALOG_BODY_FIELDS.items():
            columns = cls._columns(connection, table)
            for body_field in fields:
                reference = body_field + BODY_REFERENCE_SUFFIX
                if reference not in columns:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN {reference} TEXT")
                connection.execute(
                    f"CREATE INDEX IF NOT EXISTS idx_{table}_{body_field}_inline "
                    f"ON {table} ({','.join(CATALOG_BODY_KEYS[table])}) "
                    f"WHERE {_inline_body_condition(body_field)}"
                )
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_TASK_BINDING_TABLE} (
                session_id TEXT PRIMARY KEY,
                binding_json TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)

    def task_binding(self, session_id: str) -> dict[str, Any] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                f"SELECT binding_json FROM {SESSION_TASK_BINDING_TABLE} WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        return self._task_binding(row)

    @staticmethod
    def _task_binding(row: sqlite3.Row | Mapping[str, Any] | None) -> dict[str, Any] | None:
        return json.loads(row["binding_json"]) if row is not None else None

    @classmethod
    def inspect_rows(cls, connection: sqlite3.Connection, *, database: Path | None = None) -> None:
        """Read owned records through the production codecs without recovery.

        In particular, model-state backfill, queued submission, activation and
        turn settlement remain disabled. This checks persisted representations,
        not provider execution or external artifacts referenced by a record.
        """
        readers = (
            (SESSION_CATALOG_TABLE, cls._record),
            (SESSION_HIL_TABLE, cls._hil_record),
            (SESSION_UNCERTAINTY_TABLE, cls._uncertainty_record),
            (SESSION_MODEL_TABLE, cls._model_state),
            (SESSION_PORTABLE_HISTORY_TABLE, cls._history_entry),
            (SESSION_RUNTIME_BINDING_TABLE, cls._runtime_binding),
            (SESSION_MESSAGE_QUEUE_TABLE, cls._queued_message),
            (SESSION_ACTIVATION_TABLE, cls._activation),
            (SESSION_TASK_BINDING_TABLE, cls._task_binding),
            (SESSION_TURN_SETTLEMENT_TABLE, cls._turn_settlement),
            (SESSION_REPLACEMENT_TABLE, cls._replacement),
            (SESSION_BROWSER_ACTION_TABLE, cls._browser_action_record),
        )
        # Retain one pinned reader for this snapshot, opened only on the first
        # referenced body. Legacy/empty in-memory projections need no file path.
        # ExitStack propagates final file-identity and close failures as well.
        with ExitStack() as stack:
            bodies = None
            for table, decode in readers:
                with closing(connection.execute(f"SELECT * FROM {table}")) as rows:
                    for row in rows:
                        if bodies is None and any(
                            row[field + BODY_REFERENCE_SUFFIX] is not None
                            for field in CATALOG_BODY_FIELDS.get(table, ())
                        ):
                            bodies = stack.enter_context(
                                journal.Journal(connection, _body_database(connection, database))
                            )
                        decode(_materialize_rows(connection, [row], database, bodies=bodies)[0])
            with closing(
                connection.execute(f"SELECT * FROM {SESSION_BROWSER_ACTION_WATERMARK_TABLE}")
            ) as rows:
                for row in rows:
                    cls._validate_browser_action_scope(
                        {field: row[field] for field in BROWSER_ACTION_SCOPE_FIELDS}
                    )

    @staticmethod
    def body_references(connection: sqlite3.Connection) -> Iterator[str]:
        """All live body references, streamed for exclusive scheduled collection."""
        for table, fields in CATALOG_BODY_FIELDS.items():
            for body_field in fields:
                column = body_field + BODY_REFERENCE_SUFFIX
                with closing(
                    connection.execute(f"SELECT {column} FROM {table} WHERE {column} IS NOT NULL")
                ) as rows:
                    for row in rows:
                        yield row[0]

    @staticmethod
    def migrate_bodies(
        connection: sqlite3.Connection,
        database: Path,
        *,
        limit: int = CATALOG_BODY_BATCH_ROWS,
        byte_limit: int = CATALOG_BODY_BATCH_BYTES,
    ) -> int:
        """Move a bounded batch in the caller's exclusive maintenance transaction."""
        validate_transaction(connection, database)
        if (
            not 0 < limit <= CATALOG_BODY_BATCH_ROWS
            or not 0 < byte_limit <= CATALOG_BODY_BATCH_BYTES
        ):
            raise ValueError("invalid session body migration budget")
        batch: list[tuple[str, str, int, str]] = []
        consumed = 0
        full = False
        for table, fields in CATALOG_BODY_FIELDS.items():
            for body_field in fields:
                candidates = connection.execute(
                    f"SELECT rowid, length(CAST({body_field} AS BLOB)) AS body_bytes FROM {table} "
                    f"WHERE {_inline_body_condition(body_field)} "
                    f"ORDER BY {','.join(CATALOG_BODY_KEYS[table])} LIMIT ?",
                    (limit - len(batch),),
                ).fetchall()
                for candidate in candidates:
                    size = int(candidate["body_bytes"])
                    if size > SQLITE_VALUE_BYTES:
                        raise RuntimeError("session body exceeds supported scalar limit")
                    if batch and consumed + size > byte_limit:
                        full = True
                        break
                    row = connection.execute(
                        f"SELECT {body_field} FROM {table} WHERE rowid = ?", (candidate["rowid"],)
                    ).fetchone()
                    if row is None:
                        raise RuntimeError("session body migration row disappeared")
                    batch.append((table, body_field, candidate["rowid"], row[body_field]))
                    consumed += size
                    if len(batch) >= limit or consumed >= byte_limit:
                        full = True
                        break
                if full:
                    break
            if full:
                break
        if not batch:
            return 0
        with journal.Journal(connection, database) as bodies:
            references = bodies.put_many(item[3] for item in batch)
            for (table, body_field, rowid, text), reference in zip(batch, references, strict=True):
                if bodies.get(reference) != text:
                    raise RuntimeError("session body migration verification failed")
                connection.execute(
                    f"UPDATE {table} SET {body_field} = '', {body_field}_ref = ? WHERE rowid = ?",
                    (reference, rowid),
                )
        return len(batch)

    def remember_task_binding(self, session_id: str, binding: Mapping[str, Any]) -> None:
        encoded = json.dumps(dict(binding), ensure_ascii=False, sort_keys=True)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                f"INSERT INTO {SESSION_TASK_BINDING_TABLE} (session_id, binding_json) VALUES (?, ?) "
                "ON CONFLICT(session_id) DO UPDATE SET binding_json = excluded.binding_json",
                (session_id, encoded),
            )

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
    def _foreign_key_repairs(cls, connection: sqlite3.Connection) -> tuple[str, ...]:
        """Inspect every affected definition before any destructive repair."""

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
            return ()

        with closing(sqlite3.connect(":memory:")) as reference:
            cls._create_hil(reference)
            cls._create_uncertainty(reference)
            definitions = dict(
                reference.execute("SELECT name,sql FROM sqlite_master WHERE type='table'")
            )
        for table in broken:
            actual = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (table,)
            ).fetchone()[0]
            try:
                clauses = table_clauses(actual, table)
            except ValueError as error:
                raise RuntimeError("unsupported session table definition") from error
            corrected = []
            for clause in clauses:
                normalized = clause
                if clause[:2] == ("foreign", "key") and "references" in clause:
                    position = clause.index("references") + 1
                    if clause[position] not in {
                        SESSION_CATALOG_TABLE,
                        SESSION_CATALOG_TABLE + "_migration",
                    }:
                        raise RuntimeError("unsupported session foreign key target")
                    normalized = (
                        *clause[:position],
                        SESSION_CATALOG_TABLE,
                        *clause[position + 1 :],
                    )
                corrected.append(normalized)
            expected_clauses = table_clauses(definitions[table], table)
            optional_refs = {field + BODY_REFERENCE_SUFFIX for field in CATALOG_BODY_FIELDS[table]}
            expected_present = {
                clause
                for clause in expected_clauses
                if clause[0] not in optional_refs or clause in corrected
            }
            if len(corrected) != len(expected_present) or set(corrected) != expected_present:
                raise RuntimeError("unsupported session rebuild definition")
        return broken

    @classmethod
    def _repair_catalog_foreign_keys(cls, connection: sqlite3.Connection) -> None:
        """Repair only known stale foreign keys, retaining external dependents."""
        creators = {
            SESSION_HIL_TABLE: cls._create_hil,
            SESSION_UNCERTAINTY_TABLE: cls._create_uncertainty,
        }
        for table in cls._foreign_key_repairs(connection):
            rebuild_table(connection, table, creators[table])

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
                next_turn_mode TEXT,
                status TEXT NOT NULL,
                last_turn_id TEXT,
                last_turn_status TEXT,
                last_product_seq INTEGER NOT NULL DEFAULT 0,
                title TEXT NOT NULL DEFAULT '',
                title_fallback TEXT,
                pinned INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
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
                text_ref TEXT,
                turn_id TEXT NOT NULL DEFAULT '',
                item_id TEXT NOT NULL DEFAULT '',
                phase TEXT,
                PRIMARY KEY(session_id, ordinal),
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)

    @classmethod
    def _create_hil(cls, connection: sqlite3.Connection, table: str = SESSION_HIL_TABLE) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {table} (
                product_request_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                vendor_request_id TEXT NOT NULL,
                vendor_turn_id TEXT,
                vendor_item_id TEXT,
                method TEXT NOT NULL,
                payload TEXT NOT NULL,
                payload_ref TEXT,
                status TEXT NOT NULL,
                decision TEXT,
                decision_ref TEXT,
                created_at REAL NOT NULL,
                resolved_at REAL,
                UNIQUE(session_id, vendor_request_id),
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        if table != SESSION_HIL_TABLE:
            return
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{SESSION_HIL_TABLE}_pending "
            f"ON {SESSION_HIL_TABLE}(session_id, status, created_at)"
        )

    @staticmethod
    def _create_browser_action(connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_BROWSER_ACTION_TABLE} (
                request_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                instance_id TEXT,
                product_turn_id TEXT,
                generation INTEGER,
                interrupt_generation INTEGER,
                lifecycle_epoch INTEGER,
                operation TEXT NOT NULL,
                signature_epoch TEXT NOT NULL,
                signature_mac TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """)
        columns = SessionCatalogStore._columns(connection, SESSION_BROWSER_ACTION_TABLE)
        for column, definition in BROWSER_ACTION_ADDITIVE_COLUMNS.items():
            if column not in columns:
                connection.execute(
                    f"ALTER TABLE {SESSION_BROWSER_ACTION_TABLE} ADD COLUMN {column} {definition}"
                )
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{SESSION_BROWSER_ACTION_TABLE}_session "
            f"ON {SESSION_BROWSER_ACTION_TABLE}(session_id)"
        )
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_BROWSER_ACTION_WATERMARK_TABLE} (
                session_id TEXT PRIMARY KEY,
                instance_id TEXT NOT NULL,
                product_turn_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                generation INTEGER NOT NULL,
                interrupt_generation INTEGER NOT NULL,
                lifecycle_epoch INTEGER NOT NULL
            )
            """)

    @staticmethod
    def _validate_browser_action_scope(scope: Mapping[str, object]) -> None:
        if not isinstance(scope, Mapping) or frozenset(scope) != BROWSER_ACTION_SCOPE_FIELDS:
            raise ValueError("browser action scope invalid")
        for field_name in ("session_id", "instance_id", "product_turn_id", "turn_id"):
            field_value = scope[field_name]
            if (
                not isinstance(field_value, str)
                or not 1 <= len(field_value) <= MAX_BROWSER_ACTION_ID_CHARS
            ):
                raise ValueError("browser action scope invalid")
        for field_name in ("generation", "interrupt_generation", "lifecycle_epoch"):
            _browser_scope_integer(scope, field_name)
        if scope["generation"] == 0 or scope["lifecycle_epoch"] == 0:
            raise ValueError("browser action scope invalid")

    @staticmethod
    def _browser_action_scope_closed(row: sqlite3.Row | None, scope: Mapping[str, object]) -> bool:
        if row is None:
            return False
        previous_epoch = int(row["lifecycle_epoch"])
        epoch = _browser_scope_integer(scope, "lifecycle_epoch")
        if epoch < previous_epoch:
            return True
        if epoch > previous_epoch:
            return False
        if scope["instance_id"] != row["instance_id"]:
            return True
        return _browser_scope_integer(scope, "generation") <= int(
            row["generation"]
        ) or _browser_scope_integer(scope, "interrupt_generation") < int(
            row["interrupt_generation"]
        )

    def archive_browser_action_scope(self, scope: Mapping[str, object]) -> int:
        self._validate_browser_action_scope(scope)
        session_id = str(scope["session_id"])
        with closing(self._connect()) as connection:
            begin_write(connection, _body_database(connection))
            try:
                if (
                    connection.execute(
                        f"SELECT 1 FROM {SESSION_CATALOG_TABLE} WHERE session_id = ?", (session_id,)
                    ).fetchone()
                    is None
                ):
                    raise SessionAccessError("browser action session not found")
                previous = connection.execute(
                    f"SELECT * FROM {SESSION_BROWSER_ACTION_WATERMARK_TABLE} WHERE session_id = ?",
                    (session_id,),
                ).fetchone()
                if previous is not None:
                    same_scope = all(
                        previous[field] == scope[field] for field in BROWSER_ACTION_SCOPE_FIELDS
                    )
                    if not same_scope and self._browser_action_scope_closed(previous, scope):
                        raise SessionStateConflictError("browser action scope is already closed")
                    if (
                        not same_scope
                        and _browser_scope_integer(scope, "lifecycle_epoch")
                        == int(previous["lifecycle_epoch"])
                        and (
                            scope["instance_id"] != previous["instance_id"]
                            or _browser_scope_integer(scope, "generation")
                            <= int(previous["generation"])
                        )
                    ):
                        raise SessionStateConflictError("browser action scope cannot advance")
                connection.execute(
                    f"""INSERT INTO {SESSION_BROWSER_ACTION_WATERMARK_TABLE} (
                        session_id, instance_id, product_turn_id, turn_id, generation,
                        interrupt_generation, lifecycle_epoch
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        instance_id = excluded.instance_id,
                        product_turn_id = excluded.product_turn_id,
                        turn_id = excluded.turn_id,
                        generation = excluded.generation,
                        interrupt_generation = excluded.interrupt_generation,
                        lifecycle_epoch = excluded.lifecycle_epoch""",
                    tuple(
                        scope[field]
                        for field in (
                            "session_id",
                            "instance_id",
                            "product_turn_id",
                            "turn_id",
                            "generation",
                            "interrupt_generation",
                            "lifecycle_epoch",
                        )
                    ),
                )
                identity = (
                    session_id,
                    scope["instance_id"],
                    scope["product_turn_id"],
                    scope["turn_id"],
                    scope["generation"],
                    scope["interrupt_generation"],
                    scope["lifecycle_epoch"],
                )
                where_scope = (
                    "session_id = ? AND instance_id = ? AND product_turn_id = ? AND "
                    "turn_id = ? AND generation = ? AND interrupt_generation = ? AND lifecycle_epoch = ?"
                )
                connection.execute(
                    f"UPDATE {SESSION_BROWSER_ACTION_TABLE} SET status = ?, updated_at = ? "
                    f"WHERE {where_scope} AND status IN (?, ?, ?)",
                    (
                        BrowserActionStatus.UNKNOWN.value,
                        time.time(),
                        *identity,
                        BrowserActionStatus.PENDING.value,
                        BrowserActionStatus.APPROVED.value,
                        BrowserActionStatus.DISPATCHING.value,
                    ),
                )
                removed = connection.execute(
                    f"DELETE FROM {SESSION_BROWSER_ACTION_TABLE} WHERE {where_scope} "
                    "AND status IN (?, ?)",
                    (
                        *identity,
                        BrowserActionStatus.SUCCEEDED.value,
                        BrowserActionStatus.DENIED.value,
                    ),
                ).rowcount
                connection.commit()
                return removed
            except BaseException:
                connection.rollback()
                raise

    @staticmethod
    def _browser_action_record(
        row: sqlite3.Row | Mapping[str, Any] | None,
    ) -> BrowserActionRecord | None:
        if row is None:
            return None
        return BrowserActionRecord(
            request_id=str(row["request_id"]),
            session_id=str(row["session_id"]),
            turn_id=str(row["turn_id"]),
            operation=str(row["operation"]),
            status=BrowserActionStatus(str(row["status"])),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
        )

    def reserve_browser_action(
        self,
        *,
        request_id: str,
        scope: Mapping[str, object],
        operation: str,
        payload: Mapping[str, object],
    ) -> BrowserActionReservation:
        if (
            not isinstance(request_id, str)
            or not 1 <= len(request_id) <= BRIDGE_CALLBACK_REQUEST_CHARS
            or BRIDGE_CALLBACK_REQUEST_PATTERN.fullmatch(request_id) is None
        ):
            raise ValueError("browser action request id invalid")
        self._validate_browser_action_scope(scope)
        if operation not in BROWSER_ACTION_OPERATIONS or not isinstance(payload, Mapping):
            raise ValueError("browser action operation or payload invalid")
        try:
            encoded = json.dumps(
                {
                    "request_id": request_id,
                    "scope": dict(scope),
                    "operation": operation,
                    "payload": dict(payload),
                },
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise ValueError("browser action signature invalid") from exc
        if len(encoded) > MAX_BROWSER_ACTION_SIGNATURE_BYTES:
            raise ValueError("browser action signature too large")
        signature_mac = hmac.new(self._browser_action_key, encoded, hashlib.sha256).hexdigest()
        with closing(self._connect()) as connection:
            begin_write(connection, _body_database(connection))
            try:
                watermark = connection.execute(
                    f"SELECT * FROM {SESSION_BROWSER_ACTION_WATERMARK_TABLE} WHERE session_id = ?",
                    (str(scope["session_id"]),),
                ).fetchone()
                if self._browser_action_scope_closed(watermark, scope):
                    raise SessionStateConflictError("browser action scope is already closed")
                row = connection.execute(
                    f"SELECT * FROM {SESSION_BROWSER_ACTION_TABLE} WHERE request_id = ?",
                    (request_id,),
                ).fetchone()
                if row is not None:
                    if row[
                        "signature_epoch"
                    ] != self._browser_action_epoch or not hmac.compare_digest(
                        str(row["signature_mac"]), signature_mac
                    ):
                        raise SessionStateConflictError("browser action request id was reused")
                    record = self._browser_action_record(row)
                    assert record is not None
                    connection.commit()
                    return BrowserActionReservation(record=record, created=False)
                session_id = str(scope["session_id"])
                if (
                    connection.execute(
                        f"SELECT 1 FROM {SESSION_CATALOG_TABLE} WHERE session_id = ?", (session_id,)
                    ).fetchone()
                    is None
                ):
                    raise SessionAccessError("browser action session not found")
                count = connection.execute(
                    f"SELECT COUNT(*) FROM {SESSION_BROWSER_ACTION_TABLE}"
                ).fetchone()[0]
                if count >= MAX_BROWSER_ACTION_RECORDS:
                    raise BrowserActionCapacityError("browser action capacity reached")
                timestamp = time.time()
                connection.execute(
                    f"""INSERT INTO {SESSION_BROWSER_ACTION_TABLE} (
                        request_id, session_id, turn_id, instance_id, product_turn_id,
                        generation, interrupt_generation, lifecycle_epoch, operation,
                        signature_epoch, signature_mac, status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        request_id,
                        session_id,
                        str(scope["turn_id"]),
                        str(scope["instance_id"]),
                        str(scope["product_turn_id"]),
                        _browser_scope_integer(scope, "generation"),
                        _browser_scope_integer(scope, "interrupt_generation"),
                        _browser_scope_integer(scope, "lifecycle_epoch"),
                        operation,
                        self._browser_action_epoch,
                        signature_mac,
                        BrowserActionStatus.PENDING.value,
                        timestamp,
                        timestamp,
                    ),
                )
                row = connection.execute(
                    f"SELECT * FROM {SESSION_BROWSER_ACTION_TABLE} WHERE request_id = ?",
                    (request_id,),
                ).fetchone()
                record = self._browser_action_record(row)
                assert record is not None
                connection.commit()
                return BrowserActionReservation(record=record, created=True)
            except BaseException:
                connection.rollback()
                raise

    def browser_action(self, request_id: str) -> BrowserActionRecord | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                f"SELECT * FROM {SESSION_BROWSER_ACTION_TABLE} WHERE request_id = ?", (request_id,)
            ).fetchone()
        return self._browser_action_record(row)

    def transition_browser_action(
        self, request_id: str, expected: str, next_status: str
    ) -> BrowserActionRecord | None:
        try:
            expected_state = BrowserActionStatus(expected)
            target_state = BrowserActionStatus(next_status)
        except ValueError as exc:
            raise ValueError("browser action status invalid") from exc
        if target_state not in BROWSER_ACTION_TRANSITIONS.get(expected_state, frozenset()):
            return None
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"""UPDATE {SESSION_BROWSER_ACTION_TABLE}
                SET status = ?, updated_at = ?
                WHERE request_id = ? AND status = ? AND signature_epoch = ?""",
                (
                    target_state.value,
                    time.time(),
                    request_id,
                    expected_state.value,
                    self._browser_action_epoch,
                ),
            )
            if cursor.rowcount != 1:
                return None
            row = connection.execute(
                f"SELECT * FROM {SESSION_BROWSER_ACTION_TABLE} WHERE request_id = ?", (request_id,)
            ).fetchone()
        return self._browser_action_record(row)

    @classmethod
    def _create_uncertainty(
        cls, connection: sqlite3.Connection, table: str = SESSION_UNCERTAINTY_TABLE
    ) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {table} (
                session_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                correlation_id TEXT NOT NULL,
                incident_id TEXT,
                process_generation INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL,
                payload TEXT NOT NULL DEFAULT '{{}}',
                payload_ref TEXT,
                created_at REAL NOT NULL,
                resolved_at REAL,
                PRIMARY KEY(session_id, kind, correlation_id),
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        if table != SESSION_UNCERTAINTY_TABLE:
            return
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

    @classmethod
    def _backfill_runtime_binding(cls, connection: sqlite3.Connection) -> None:
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

    @classmethod
    def _backfill_activation(cls, connection: sqlite3.Connection) -> None:
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
                body_ref TEXT,
                safe_error TEXT NOT NULL DEFAULT '',
                deadline REAL,
                purpose TEXT NOT NULL DEFAULT '{QUEUE_PURPOSE_TURN}',
                native_turn_id TEXT NOT NULL DEFAULT '',
                submission_mode TEXT NOT NULL DEFAULT '{SubmissionMode.QUEUED.value}',
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
    def _create_replacement(connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_REPLACEMENT_TABLE} (
                session_id TEXT PRIMARY KEY,
                proof_id TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL,
                payload TEXT NOT NULL,
                payload_ref TEXT,
                updated_at REAL NOT NULL,
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
        """)

    @staticmethod
    def _replacement(row: sqlite3.Row | Mapping[str, Any] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        state = ReplacementState(row["state"])
        payload = json.loads(row["payload"])
        if (
            not isinstance(payload, dict)
            or payload.get("proof_id") != row["proof_id"]
            or not payload.get("call_id")
            or not payload.get("command_id")
            or type(payload.get("operation_seq")) is not int
            or type(payload.get("generation")) is not int
            or not isinstance(payload.get("binding"), str)
            or not isinstance(payload.get("revision"), str)
        ):
            raise ValueError("invalid runtime replacement record")
        return {
            **payload,
            "kind": ReplacementKind(payload.get("kind", ReplacementKind.EMPTY_THREAD.value)),
            "state": state,
        }

    def replacement(self, session_id: str) -> dict[str, Any] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                f"SELECT * FROM {SESSION_REPLACEMENT_TABLE} WHERE session_id = ?", (session_id,)
            ).fetchone()
            return self._replacement(_materialize_row(connection, row))

    @staticmethod
    def _binding_fingerprint(binding: RuntimeBinding) -> str:
        encoded = json.dumps(dataclasses.asdict(binding), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(encoded.encode()).hexdigest()

    @staticmethod
    def _replacement_configuration(connection: sqlite3.Connection, session_id: str) -> str:
        product = connection.execute(
            f"SELECT policy_id, runtime_workdir, project_path, output_root, runtime_id FROM {SESSION_CATALOG_TABLE} WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        model = connection.execute(
            f"SELECT selected_model_id, selected_reasoning_effort, selected_thinking_json FROM {SESSION_MODEL_TABLE} WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        encoded = json.dumps(
            [dict(product) if product else None, dict(model) if model else None], sort_keys=True
        )
        return hashlib.sha256(encoded.encode()).hexdigest()

    @classmethod
    def _rebuilding_blocked(
        cls,
        connection: sqlite3.Connection,
        session_id: str,
        command_id: str,
        operation_seq: int,
    ) -> bool:
        return (
            connection.execute(
                f"SELECT 1 FROM {SESSION_MESSAGE_QUEUE_TABLE} WHERE session_id = ? AND queued_message_id != ? "
                "AND (state IN (?, ?, ?, ?, ?) OR operation_seq > ?) UNION ALL "
                f"SELECT 1 FROM {SESSION_HIL_TABLE} WHERE session_id = ? AND status IN (?, ?, ?) UNION ALL "
                f"SELECT 1 FROM {SESSION_TASK_BINDING_TABLE} WHERE session_id = ? UNION ALL "
                f"SELECT 1 FROM {SESSION_CATALOG_TABLE} WHERE session_id = ? AND archived != 0 LIMIT 1",
                (
                    session_id,
                    command_id,
                    QueuedMessageState.QUEUED.value,
                    QueuedMessageState.WAITING_RESOURCES.value,
                    QueuedMessageState.SUBMITTING.value,
                    QueuedMessageState.RUNNING.value,
                    QueuedMessageState.OUTCOME_UNKNOWN.value,
                    operation_seq,
                    session_id,
                    HilStatus.PENDING.value,
                    HilStatus.UNKNOWN.value,
                    HilStatus.STALE.value,
                    session_id,
                    session_id,
                ),
            ).fetchone()
            is not None
        )

    @classmethod
    def _rebuilding_source(
        cls,
        connection: sqlite3.Connection,
        proof: ThreadReplacementProof,
    ) -> tuple[int, int]:
        session_id = proof.binding.product_session_id
        binding = cls._runtime_binding(
            connection.execute(
                f"SELECT * FROM {SESSION_RUNTIME_BINDING_TABLE} WHERE product_session_id = ?",
                (session_id,),
            ).fetchone()
        )
        queue = connection.execute(
            f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} WHERE session_id = ? AND queued_message_id = ?",
            (session_id, proof.command_id),
        ).fetchone()
        activation = cls._activation(
            connection.execute(
                f"SELECT * FROM {SESSION_ACTIVATION_TABLE} WHERE session_id = ?", (session_id,)
            ).fetchone()
        )
        uncertainties = connection.execute(
            f"SELECT * FROM {SESSION_UNCERTAINTY_TABLE} WHERE session_id = ? AND state IN (?, ?, ?)",
            (
                session_id,
                UncertaintyState.EXECUTING.value,
                UncertaintyState.UNKNOWN.value,
                UncertaintyState.STALE.value,
            ),
        ).fetchall()
        pending = cls._turn_settlement(
            _materialize_row(
                connection,
                connection.execute(
                    f"SELECT * FROM {SESSION_TURN_SETTLEMENT_TABLE} WHERE session_id = ?",
                    (session_id,),
                ).fetchone(),
            )
        )
        blocked = cls._rebuilding_blocked(
            connection, session_id, proof.command_id, queue["operation_seq"] if queue else 0
        )
        source_ids = {proof.command_id, queue["native_turn_id"] if queue is not None else ""}
        if (
            binding != proof.binding
            or not proof.proof_id
            or not proof.incident_id
            or not 0 < proof.failed_generation < proof.absence_generation
            or queue is None
            or queue["state"] != QueuedMessageState.OUTCOME_UNKNOWN.value
            or queue["operation_seq"] is None
            or activation is None
            or activation.open_state is not OpenState.BOUND
            or blocked
            or any(
                row["kind"] != UncertaintyKind.TURN.value
                or row["state"] != UncertaintyState.UNKNOWN.value
                or row["correlation_id"] not in source_ids
                or row["process_generation"] != proof.failed_generation
                for row in uncertainties
            )
            or (
                pending is not None
                and (
                    pending.client_turn_id != proof.command_id
                    or pending.event.kind is not RuntimeEventKind.TURN_UNKNOWN
                    or pending.event.native_session_id != proof.binding.opaque_session_ref
                    or pending.event.runtime_id != proof.binding.runtime_id
                    or pending.event.process_generation != proof.failed_generation
                    or pending.native_turn_id not in source_ids
                )
            )
        ):
            raise SessionBindingConflictError(
                "thread replacement source is not the failed operation"
            )
        return int(queue["operation_seq"]), activation.generation

    @staticmethod
    def _replacement_identity(
        proof: EmptyThreadReplacementProof | ThreadReplacementProof,
    ) -> tuple[ReplacementKind, str]:
        if isinstance(proof, ThreadReplacementProof):
            return ReplacementKind.HISTORY_REBUILD, proof.proof_id
        return ReplacementKind.EMPTY_THREAD, proof.call_id

    @classmethod
    def _replacement_matches(
        cls,
        payload: Mapping[str, Any],
        proof: EmptyThreadReplacementProof | ThreadReplacementProof,
    ) -> bool:
        kind, call_id = cls._replacement_identity(proof)
        return (
            payload["kind"] is kind
            and payload["proof_id"] == proof.proof_id
            and payload["call_id"] == call_id
            and payload["command_id"] == proof.command_id
            and payload["binding"] == cls._binding_fingerprint(proof.binding)
            and payload["failed_generation"] == proof.failed_generation
            and payload["absence_generation"] == proof.absence_generation
            and payload["watermark"] == proof.watermark
            and payload["event_id"]
            == (proof.incident_id if isinstance(proof, ThreadReplacementProof) else proof.event_id)
        )

    @classmethod
    def _replacement_source(
        cls,
        connection: sqlite3.Connection,
        proof: EmptyThreadReplacementProof | ThreadReplacementProof,
        *,
        manual: bool = False,
    ) -> tuple[int, int]:
        if isinstance(proof, ThreadReplacementProof):
            if manual:
                raise SessionBindingConflictError("thread rebuilding is not an unsubmitted retry")
            return cls._rebuilding_source(connection, proof)
        session_id = proof.binding.product_session_id
        binding_row = connection.execute(
            f"SELECT * FROM {SESSION_RUNTIME_BINDING_TABLE} WHERE product_session_id = ?",
            (session_id,),
        ).fetchone()
        queue = connection.execute(
            f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} WHERE session_id = ? AND queued_message_id = ?",
            (session_id, proof.command_id),
        ).fetchone()
        activation = cls._activation(
            connection.execute(
                f"SELECT * FROM {SESSION_ACTIVATION_TABLE} WHERE session_id = ?", (session_id,)
            ).fetchone()
        )
        blocked = connection.execute(
            f"SELECT 1 FROM {SESSION_UNCERTAINTY_TABLE} WHERE session_id = ? AND state IN (?, ?, ?) UNION ALL "
            f"SELECT 1 FROM {SESSION_MESSAGE_QUEUE_TABLE} WHERE session_id = ? AND (native_turn_id != '' OR state IN (?, ?, ?)) UNION ALL "
            f"SELECT 1 FROM {SESSION_TURN_SETTLEMENT_TABLE} WHERE session_id = ? UNION ALL "
            f"SELECT 1 FROM {SESSION_TASK_BINDING_TABLE} WHERE session_id = ? LIMIT 1",
            (
                session_id,
                UncertaintyState.EXECUTING.value,
                UncertaintyState.UNKNOWN.value,
                UncertaintyState.STALE.value,
                session_id,
                QueuedMessageState.RUNNING.value,
                QueuedMessageState.OUTCOME_UNKNOWN.value,
                QueuedMessageState.COMPLETED.value,
                session_id,
                session_id,
            ),
        ).fetchone()
        other_work = connection.execute(
            f"SELECT 1 FROM {SESSION_MESSAGE_QUEUE_TABLE} WHERE session_id = ? AND queued_message_id != ? "
            "AND (state = ? OR operation_seq > ?) UNION ALL "
            f"SELECT 1 FROM {SESSION_HIL_TABLE} WHERE session_id = ? AND status IN (?, ?, ?) LIMIT 1",
            (
                session_id,
                proof.command_id,
                QueuedMessageState.SUBMITTING.value,
                queue["operation_seq"] if queue is not None else 0,
                session_id,
                HilStatus.PENDING.value,
                HilStatus.UNKNOWN.value,
                HilStatus.STALE.value,
            ),
        ).fetchone()
        if (
            cls._runtime_binding(binding_row) != proof.binding
            or queue is None
            or queue["state"]
            != (
                QueuedMessageState.WAITING_RESOURCES.value
                if manual
                else QueuedMessageState.SUBMITTING.value
            )
            or queue["native_turn_id"]
            or queue["operation_seq"] is None
            or activation is None
            or activation.open_state is not OpenState.BOUND
            or blocked is not None
            or other_work is not None
        ):
            raise SessionBindingConflictError("empty replacement source is not unsubmitted")
        return int(queue["operation_seq"]), activation.generation

    def record_replacement(
        self, proof: EmptyThreadReplacementProof | ThreadReplacementProof, revision: str
    ) -> None:
        with closing(self._connect()) as connection, connection:
            begin_write(connection, self._database)
            operation_seq, generation = self._replacement_source(connection, proof)
            kind, call_id = self._replacement_identity(proof)
            payload: dict[str, Any] = {
                "kind": kind.value,
                "proof_id": proof.proof_id,
                "command_id": proof.command_id,
                "call_id": call_id,
                "event_id": (
                    proof.incident_id
                    if isinstance(proof, ThreadReplacementProof)
                    else proof.event_id
                ),
                "watermark": proof.watermark,
                "failed_generation": proof.failed_generation,
                "absence_generation": proof.absence_generation,
                "operation_seq": operation_seq,
                "generation": generation,
                "binding": self._binding_fingerprint(proof.binding),
                "revision": revision,
                "configuration": self._replacement_configuration(
                    connection, proof.binding.product_session_id
                ),
            }
            if isinstance(proof, EmptyThreadReplacementProof):
                payload.update(
                    submission_attempts=proof.submission_attempts,
                    submission_deadline=proof.submission_deadline,
                )
            previous = self._replacement(
                _materialize_row(
                    connection,
                    connection.execute(
                        f"SELECT * FROM {SESSION_REPLACEMENT_TABLE} WHERE session_id = ?",
                        (proof.binding.product_session_id,),
                    ).fetchone(),
                )
            )
            if previous is not None:
                if (
                    previous["state"] is not ReplacementState.BOUND
                    or previous["proof_id"] == proof.proof_id
                    or previous["command_id"] == proof.command_id
                    or previous["operation_seq"] >= operation_seq
                    or previous.get("candidate")
                    != json.loads(json.dumps(dataclasses.asdict(proof.binding)))
                ):
                    raise SessionBindingConflictError("runtime replacement is already fenced")
                payload["previous"] = previous
            connection.execute(
                f"INSERT INTO {SESSION_REPLACEMENT_TABLE} (session_id, proof_id, state, payload, payload_ref, updated_at) "
                "VALUES (?, ?, ?, '', ?, ?) ON CONFLICT(session_id) DO UPDATE SET "
                "proof_id = excluded.proof_id, state = excluded.state, payload = '', "
                "payload_ref = excluded.payload_ref, updated_at = excluded.updated_at",
                (
                    proof.binding.product_session_id,
                    proof.proof_id,
                    ReplacementState.PROVEN.value,
                    _store_body(connection, json.dumps(payload, sort_keys=True)),
                    time.time(),
                ),
            )

    def begin_replacement(
        self,
        proof: EmptyThreadReplacementProof | ThreadReplacementProof,
        revision: str,
        reservation_id: str,
        *,
        manual: bool = False,
    ) -> None:
        with closing(self._connect()) as connection, connection:
            begin_write(connection, self._database)
            operation_seq, generation = self._replacement_source(connection, proof, manual=manual)
            row = connection.execute(
                f"SELECT * FROM {SESSION_REPLACEMENT_TABLE} WHERE session_id = ?",
                (proof.binding.product_session_id,),
            ).fetchone()
            payload = self._replacement(_materialize_row(connection, row))
            if (
                payload is None
                or payload.pop("state") is not ReplacementState.PROVEN
                or not self._replacement_matches(payload, proof)
                or (not manual and payload["revision"] != revision)
                or payload["generation"] != generation
                or payload["operation_seq"] != operation_seq
                or not reservation_id
                or payload["configuration"]
                != self._replacement_configuration(connection, proof.binding.product_session_id)
                or bool(payload.get("manual_retry")) != manual
            ):
                raise SessionBindingConflictError(
                    "runtime replacement proof was consumed or changed"
                )
            payload["reservation_id"] = reservation_id
            payload["revision"] = revision
            connection.execute(
                f"UPDATE {SESSION_REPLACEMENT_TABLE} SET state = ?, payload = '', payload_ref = ?, updated_at = ? WHERE session_id = ?",
                (
                    ReplacementState.OPENING.value,
                    _store_body(connection, json.dumps(payload, sort_keys=True)),
                    time.time(),
                    proof.binding.product_session_id,
                ),
            )

    def authorize_replacement_retry(self, session_id: str, command_id: str) -> None:
        with closing(self._connect()) as connection, connection:
            begin_write(connection, self._database)
            row = connection.execute(
                f"SELECT * FROM {SESSION_REPLACEMENT_TABLE} WHERE session_id = ?", (session_id,)
            ).fetchone()
            payload = self._replacement(_materialize_row(connection, row))
            if (
                payload is None
                or payload.pop("state") is not ReplacementState.NOT_APPLIED
                or payload["kind"] is not ReplacementKind.EMPTY_THREAD
            ):
                return
            queued = connection.execute(
                f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} WHERE session_id = ? AND queued_message_id = ?",
                (session_id, command_id),
            ).fetchone()
            binding = self._runtime_binding(
                connection.execute(
                    f"SELECT * FROM {SESSION_RUNTIME_BINDING_TABLE} WHERE product_session_id = ?",
                    (session_id,),
                ).fetchone()
            )
            if (
                payload["command_id"] != command_id
                or queued is None
                or binding is None
                or payload.get("candidate") is not None
                or payload["binding"] != self._binding_fingerprint(binding)
                or queued["state"] != QueuedMessageState.FAILED.value
                or queued["safe_error"] != RUNTIME_TURN_NOT_SUBMITTED
                or queued["native_turn_id"]
            ):
                raise SessionBindingConflictError(
                    "manual retry lacks a confirmed unsubmitted replacement"
                )
            attempts = list(payload.get("attempts", []))
            attempts.append(
                {
                    "reservation_id": payload.pop("reservation_id"),
                    "state": ReplacementState.NOT_APPLIED.value,
                }
            )
            payload.update(
                manual_retry=True,
                attempts=attempts,
                operation_seq=int(queued["operation_seq"]),
                configuration=self._replacement_configuration(connection, session_id),
            )
            connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, deadline = NULL, updated_at = ? WHERE session_id = ? AND queued_message_id = ?",
                (QueuedMessageState.WAITING_RESOURCES.value, time.time(), session_id, command_id),
            )
            connection.execute(
                f"UPDATE {SESSION_REPLACEMENT_TABLE} SET state = ?, payload = '', payload_ref = ?, updated_at = ? WHERE session_id = ?",
                (
                    ReplacementState.PROVEN.value,
                    _store_body(connection, json.dumps(payload, sort_keys=True)),
                    time.time(),
                    session_id,
                ),
            )

    def manual_replacement_proof(
        self, session_id: str, command_id: str
    ) -> EmptyThreadReplacementProof | None:
        payload = self.replacement(session_id)
        binding = self.runtime_binding(session_id)
        if (
            payload is None
            or payload["state"] is not ReplacementState.PROVEN
            or payload["kind"] is not ReplacementKind.EMPTY_THREAD
            or not payload.get("manual_retry")
            or payload["command_id"] != command_id
            or binding is None
        ):
            return None
        return EmptyThreadReplacementProof(
            payload["proof_id"],
            binding,
            command_id,
            payload["call_id"],
            payload["failed_generation"],
            payload["absence_generation"],
            payload["event_id"],
            payload["watermark"],
            payload["submission_deadline"],
            payload["submission_attempts"],
        )

    def settle_replacement(
        self,
        session_id: str,
        proof_id: str,
        state: ReplacementState,
        candidate: RuntimeBinding | None = None,
    ) -> None:
        if state not in {
            ReplacementState.OPENING,
            ReplacementState.UNKNOWN,
            ReplacementState.NOT_APPLIED,
        }:
            raise ValueError("invalid replacement settlement")
        with closing(self._connect()) as connection, connection:
            begin_write(connection, self._database)
            row = connection.execute(
                f"SELECT * FROM {SESSION_REPLACEMENT_TABLE} WHERE session_id = ? AND proof_id = ?",
                (session_id, proof_id),
            ).fetchone()
            payload = self._replacement(_materialize_row(connection, row))
            previous_state = payload.pop("state") if payload is not None else None
            if payload is None or (
                previous_state is not ReplacementState.OPENING
                and not (
                    previous_state is ReplacementState.PROVEN and state is ReplacementState.UNKNOWN
                )
            ):
                return
            if candidate is not None:
                payload["candidate"] = dataclasses.asdict(candidate)
            connection.execute(
                f"UPDATE {SESSION_REPLACEMENT_TABLE} SET state = ?, payload = '', payload_ref = ?, updated_at = ? WHERE session_id = ?",
                (
                    state.value,
                    _store_body(connection, json.dumps(payload, sort_keys=True)),
                    time.time(),
                    session_id,
                ),
            )

    def confirm_thread_replacement(self, proof: ThreadReplacementProof) -> bool:
        session_id = proof.binding.product_session_id
        with closing(self._connect()) as connection, connection:
            begin_write(connection, self._database)
            record = self._replacement(
                _materialize_row(
                    connection,
                    connection.execute(
                        f"SELECT * FROM {SESSION_REPLACEMENT_TABLE} WHERE session_id = ?",
                        (session_id,),
                    ).fetchone(),
                )
            )
            current = self._runtime_binding(
                connection.execute(
                    f"SELECT * FROM {SESSION_RUNTIME_BINDING_TABLE} WHERE product_session_id = ?",
                    (session_id,),
                ).fetchone()
            )
            queue = connection.execute(
                f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} WHERE session_id = ? AND queued_message_id = ?",
                (session_id, proof.command_id),
            ).fetchone()
            activation = self._activation(
                connection.execute(
                    f"SELECT * FROM {SESSION_ACTIVATION_TABLE} WHERE session_id = ?", (session_id,)
                ).fetchone()
            )
            if (
                record is None
                or record["state"] is not ReplacementState.BOUND
                or not self._replacement_matches(record, proof)
                or current is None
                or record.get("candidate") != json.loads(json.dumps(dataclasses.asdict(current)))
                or current.opaque_session_ref == proof.binding.opaque_session_ref
                or queue is None
                or queue["state"] != QueuedMessageState.OUTCOME_UNKNOWN.value
                or queue["operation_seq"] != record["operation_seq"]
                or activation is None
                or activation.generation != record["generation"] + 1
                or record["configuration"]
                != self._replacement_configuration(connection, session_id)
                or self._rebuilding_blocked(
                    connection, session_id, proof.command_id, record["operation_seq"]
                )
            ):
                return False
            pending = self._turn_settlement(
                _materialize_row(
                    connection,
                    connection.execute(
                        f"SELECT * FROM {SESSION_TURN_SETTLEMENT_TABLE} WHERE session_id = ?",
                        (session_id,),
                    ).fetchone(),
                )
            )
            source_ids = {proof.command_id, str(queue["native_turn_id"] or "")}
            if pending is not None and (
                pending.client_turn_id != proof.command_id
                or pending.native_turn_id not in source_ids
                or pending.event.kind is not RuntimeEventKind.TURN_UNKNOWN
                or pending.event.native_session_id != proof.binding.opaque_session_ref
                or pending.event.runtime_id != proof.binding.runtime_id
                or pending.event.process_generation != proof.failed_generation
            ):
                return False
            rows = connection.execute(
                f"SELECT * FROM {SESSION_UNCERTAINTY_TABLE} WHERE session_id = ? AND "
                "(state IN (?, ?, ?) OR (kind = ? AND correlation_id IN (?, ?)))",
                (
                    session_id,
                    UncertaintyState.EXECUTING.value,
                    UncertaintyState.UNKNOWN.value,
                    UncertaintyState.STALE.value,
                    UncertaintyKind.TURN.value,
                    proof.command_id,
                    str(queue["native_turn_id"] or ""),
                ),
            ).fetchall()
            uncertainties = []
            for row in rows:
                uncertainty = self._uncertainty_record(_materialize_row(connection, row))
                if uncertainty is None:
                    return False
                uncertainties.append(uncertainty)
            provenance = json.loads(json.dumps(dataclasses.asdict(proof)))
            if any(
                uncertainty.kind is not UncertaintyKind.TURN
                or uncertainty.correlation_id not in source_ids
                or uncertainty.process_generation != proof.failed_generation
                or uncertainty.state not in (UncertaintyState.UNKNOWN, UncertaintyState.CONFIRMED)
                or (
                    uncertainty.state is UncertaintyState.CONFIRMED
                    and uncertainty.payload.get(UNCERTAINTY_THREAD_REPLACEMENT_KEY) != provenance
                )
                for uncertainty in uncertainties
            ):
                return False
            for uncertainty in uncertainties:
                values = {
                    **uncertainty.payload,
                    "resolution": ReplacementKind.HISTORY_REBUILD.value,
                    UNCERTAINTY_THREAD_REPLACEMENT_KEY: provenance,
                }
                connection.execute(
                    f"UPDATE {SESSION_UNCERTAINTY_TABLE} SET state = ?, payload = '', payload_ref = ?, resolved_at = ? "
                    "WHERE session_id = ? AND kind = ? AND correlation_id = ?",
                    (
                        UncertaintyState.CONFIRMED.value,
                        _store_body(connection, json.dumps(values, ensure_ascii=False)),
                        time.time(),
                        session_id,
                        UncertaintyKind.TURN.value,
                        uncertainty.correlation_id,
                    ),
                )
            if pending is not None:
                connection.execute(
                    f"DELETE FROM {SESSION_TURN_SETTLEMENT_TABLE} WHERE session_id = ? AND client_turn_id = ? AND native_turn_id = ?",
                    (session_id, proof.command_id, pending.native_turn_id),
                )
            return True

    @classmethod
    def _create_turn_settlement(cls, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {SESSION_TURN_SETTLEMENT_TABLE} (
                session_id TEXT PRIMARY KEY,
                client_turn_id TEXT NOT NULL,
                native_turn_id TEXT NOT NULL,
                event_json TEXT NOT NULL,
                event_json_ref TEXT,
                created_at REAL NOT NULL,
                recovery_blocked INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        if "recovery_blocked" not in cls._columns(connection, SESSION_TURN_SETTLEMENT_TABLE):
            connection.execute(
                f"ALTER TABLE {SESSION_TURN_SETTLEMENT_TABLE} "
                "ADD COLUMN recovery_blocked INTEGER NOT NULL DEFAULT 0"
            )

    @staticmethod
    def _turn_settlement(
        row: sqlite3.Row | Mapping[str, Any] | None,
    ) -> PendingTurnSettlement | None:
        if row is None:
            return None
        return PendingTurnSettlement(
            session_id=str(row["session_id"]),
            client_turn_id=str(row["client_turn_id"]),
            native_turn_id=str(row["native_turn_id"]),
            event=SessionCatalogStore._runtime_event(json.loads(str(row["event_json"]))),
            created_at=float(row["created_at"]),
            recovery_blocked=bool(row["recovery_blocked"]),
        )

    @staticmethod
    def _runtime_event(values: Mapping[str, Any]) -> RuntimeEvent:
        payload = dict(values)
        payload["kind"] = RuntimeEventKind(payload["kind"])
        payload["delivery"] = DeliveryClass(payload["delivery"])
        payload["actor_kind"] = ActorKind(payload["actor_kind"])
        return RuntimeEvent(**payload)

    def record_turn_settlement(
        self, session_id: str, client_turn_id: str, event: RuntimeEvent
    ) -> PendingTurnSettlement:
        if (
            not client_turn_id.strip()
            or not event.native_turn_id.strip()
            or event.product_session_id != session_id
        ):
            raise ValueError("turn settlement requires matching session and turn ids")
        encoded = json.dumps(dataclasses.asdict(event), ensure_ascii=False, sort_keys=True)
        with closing(self._connect()) as connection, connection:
            begin_write(connection, _body_database(connection))
            row = connection.execute(
                f"SELECT * FROM {SESSION_TURN_SETTLEMENT_TABLE} WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            row = _materialize_row(connection, row)
            existing = self._turn_settlement(row)
            if existing is not None:
                replacement = (
                    event
                    if self._resolves_unknown_settlement(existing, client_turn_id, event)
                    else (
                        self._coalesce_unknown_settlement(existing.event, client_turn_id, event)
                        if existing.client_turn_id == client_turn_id
                        else None
                    )
                )
                if replacement is not None:
                    if replacement == existing.event:
                        return existing
                    encoded = json.dumps(
                        dataclasses.asdict(replacement), ensure_ascii=False, sort_keys=True
                    )
                    connection.execute(
                        f"UPDATE {SESSION_TURN_SETTLEMENT_TABLE} "
                        "SET native_turn_id = ?, event_json = '', event_json_ref = ? "
                        "WHERE session_id = ?",
                        (replacement.native_turn_id, _store_body(connection, encoded), session_id),
                    )
                    return PendingTurnSettlement(
                        session_id,
                        client_turn_id,
                        replacement.native_turn_id,
                        replacement,
                        existing.created_at,
                        existing.recovery_blocked,
                    )
                if (
                    existing.client_turn_id != client_turn_id
                    or existing.native_turn_id != event.native_turn_id
                    or existing.event.event_id != event.event_id
                    or existing.event != event
                ):
                    raise SessionStateConflictError("pending turn settlement conflict")
                return existing
            now = time.time()
            connection.execute(
                f"INSERT INTO {SESSION_TURN_SETTLEMENT_TABLE} "
                "(session_id, client_turn_id, native_turn_id, event_json, event_json_ref, created_at) "
                "VALUES (?, ?, ?, '', ?, ?)",
                (
                    session_id,
                    client_turn_id,
                    event.native_turn_id,
                    _store_body(connection, encoded),
                    now,
                ),
            )
            return PendingTurnSettlement(
                session_id, client_turn_id, event.native_turn_id, event, now
            )

    @staticmethod
    def _coalesce_unknown_settlement(
        prior: RuntimeEvent, client_turn_id: str, event: RuntimeEvent
    ) -> RuntimeEvent | None:
        if not (
            prior.kind is event.kind is RuntimeEventKind.TURN_UNKNOWN
            and prior.event_id != event.event_id
            and prior.correlation_id == event.correlation_id == client_turn_id
            and prior.runtime_id == event.runtime_id
            and prior.product_session_id == event.product_session_id
            and prior.native_session_id == event.native_session_id
            and prior.native_turn_id == event.native_turn_id
            and prior.actor_kind is event.actor_kind is ActorKind.MAIN
            and prior.delivery is event.delivery is DeliveryClass.MUST_PERSIST
            and prior.process_generation == event.process_generation > 0
        ):
            return None
        classified: dict[str, RuntimeEvent] = {}
        for observation in (prior, event):
            payload = observation.payload if isinstance(observation.payload, Mapping) else {}
            incident = payload.get(INCIDENT_PAYLOAD_KEY)
            if not isinstance(incident, Mapping) or not incident.get(INCIDENT_ID_KEY):
                return None
            if (
                not isinstance(incident.get("process_generation"), int)
                or isinstance(incident.get("process_generation"), bool)
                or incident.get("process_generation") != observation.process_generation
                or incident.get("native_session_id", "") not in ("", observation.native_session_id)
                or incident.get("native_turn_id", "")
                not in ("", observation.native_turn_id, client_turn_id)
            ):
                return None
            if (
                incident.get("scope") == RuntimeIncidentScope.TURN.value
                and incident.get("kind") in TURN_SUBMISSION_UNKNOWN_KINDS
                and incident.get("retryability") == RuntimeRetryability.UNKNOWN_OUTCOME.value
                and incident.get("ambiguous_commit") is True
                and incident.get("rpc_method") == TURN_SUBMISSION_RPC_METHOD
            ):
                classified[RuntimeIncidentScope.TURN.value] = observation
            elif (
                incident.get("scope") == RuntimeIncidentScope.PROCESS.value
                and incident.get("kind") == RuntimeIncidentKind.PROCESS_EXIT.value
            ):
                classified[RuntimeIncidentScope.PROCESS.value] = observation
            else:
                return None
        if len(classified) != 2:
            return None
        return classified[RuntimeIncidentScope.TURN.value]

    @staticmethod
    def _resolves_unknown_settlement(
        existing: PendingTurnSettlement, client_turn_id: str, event: RuntimeEvent
    ) -> bool:
        prior = existing.event
        prior_payload = prior.payload if isinstance(prior.payload, Mapping) else {}
        incident = prior_payload.get(INCIDENT_PAYLOAD_KEY)
        incident_values = incident if isinstance(incident, Mapping) else {}
        resolved_payload = event.payload if isinstance(event.payload, Mapping) else {}
        incident_id = str(incident_values.get(INCIDENT_ID_KEY) or "")
        return bool(
            incident_id
            and prior.kind is RuntimeEventKind.TURN_UNKNOWN
            and event.kind in TURN_SETTLEMENT_RESOLUTION_KINDS
            and existing.client_turn_id == client_turn_id
            and prior.runtime_id == event.runtime_id
            and prior.product_session_id == event.product_session_id
            and prior.native_session_id == event.native_session_id
            and prior.correlation_id == event.correlation_id == client_turn_id
            and event.process_generation >= prior.process_generation
            and str(resolved_payload.get(RESOLVED_AMBIGUOUS_INCIDENT_ID_KEY) or "") == incident_id
        )

    def pending_turn_settlement(self, session_id: str) -> PendingTurnSettlement | None:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"SELECT * FROM {SESSION_TURN_SETTLEMENT_TABLE} WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            row = _materialize_row(connection, row)
        return self._turn_settlement(row)

    def mark_turn_recovery_blocked(self, session_id: str, blocked: bool) -> bool:
        with closing(self._connect()) as connection, connection:
            begin_write(connection, self._database)
            cursor = connection.execute(
                f"UPDATE {SESSION_TURN_SETTLEMENT_TABLE} SET recovery_blocked = ? "
                "WHERE session_id = ?",
                (int(blocked), session_id),
            )
            return cursor.rowcount == 1

    def clear_turn_settlement(self, session_id: str, native_turn_id: str) -> bool:
        with closing(self._connect()) as connection, connection:
            begin_write(connection, self._database)
            cursor = connection.execute(
                f"DELETE FROM {SESSION_TURN_SETTLEMENT_TABLE} "
                "WHERE session_id = ? AND native_turn_id = ?",
                (session_id, native_turn_id),
            )
            return cursor.rowcount == 1

    @staticmethod
    def _queued_message(row: sqlite3.Row | Mapping[str, Any] | None) -> QueuedMessageRecord | None:
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
            safe_error_details=dict(json.loads(str(row["safe_error_details"]))),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
            deadline=float(row["deadline"]) if row["deadline"] is not None else None,
            purpose=str(row["purpose"]),
            native_turn_id=str(row["native_turn_id"]),
            submission_mode=SubmissionMode(str(row["submission_mode"])),
        )

    def enqueue_message(
        self,
        session_id: str,
        queued_message_id: str,
        body: Mapping[str, Any],
        *,
        deadline: float | None = None,
        purpose: str = QUEUE_PURPOSE_TURN,
        submission_mode: SubmissionMode = SubmissionMode.QUEUED,
    ) -> QueuedMessageRecord:
        if not queued_message_id.strip() or not purpose.strip():
            raise ValueError("queued request id and purpose must not be empty")
        if deadline is not None and (not math.isfinite(deadline) or deadline <= 0):
            raise ValueError("queued request deadline must be a positive finite timestamp")
        now = time.time()
        encoded = json.dumps(dict(body), ensure_ascii=False, sort_keys=True)
        with closing(self._connect()) as connection, connection:
            begin_write(connection, _body_database(connection))
            existing = connection.execute(
                f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} WHERE queued_message_id = ?",
                (queued_message_id,),
            ).fetchone()
            existing = _materialize_row(connection, existing)
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
                "(queued_message_id, session_id, enqueue_seq, state, body, body_ref, created_at, updated_at, "
                "deadline, purpose, submission_mode) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)",
                (
                    queued_message_id,
                    session_id,
                    enqueue_seq,
                    QueuedMessageState.QUEUED.value,
                    _store_body(connection, encoded),
                    now,
                    now,
                    deadline,
                    purpose,
                    submission_mode.value,
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
            row = _materialize_row(connection, row)
        return self._queued_message(row)

    def queued_messages(self, session_id: str) -> tuple[QueuedMessageRecord, ...]:
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} WHERE session_id = ? "
                f"AND state IN ({','.join('?' for _ in QUEUE_PENDING_STATES)}) "
                "ORDER BY enqueue_seq",
                (session_id, *(state.value for state in QUEUE_PENDING_STATES)),
            ).fetchall()
            rows = _materialize_rows(connection, rows)
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
            begin_write(connection, _body_database(connection))
            row = connection.execute(
                f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} "
                "WHERE session_id = ? AND queued_message_id = ?",
                (session_id, queued_message_id),
            ).fetchone()
            row = _materialize_row(connection, row)
            record = self._queued_message(row)
            if record is None or record.state not in QUEUE_SUBMITTABLE_STATES:
                return None
            if record.purpose != purpose:
                raise SessionStateConflictError("resource wait purpose changed")
            if record.state is QueuedMessageState.WAITING_RESOURCES:
                return record
            connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, "
                "deadline = ?, safe_error = '', safe_error_details = '{}', updated_at = ? "
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
            begin_write(connection, _body_database(connection))
            row = connection.execute(
                f"SELECT * FROM {SESSION_MESSAGE_QUEUE_TABLE} "
                "WHERE session_id = ? AND queued_message_id = ?",
                (session_id, queued_message_id),
            ).fetchone()
            row = _materialize_row(connection, row)
            record = self._queued_message(row)
            if record is None or record.state not in QUEUE_COMPLETABLE_STATES:
                return None
            if record.native_turn_id and record.native_turn_id != native_turn_id:
                raise SessionStateConflictError("queued request belongs to another native turn")
            if record.state is QueuedMessageState.RUNNING:
                return record
            connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, native_turn_id = ?, "
                "safe_error = '', safe_error_details = '{}', updated_at = ? "
                "WHERE session_id = ? AND queued_message_id = ?",
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
            begin_write(connection, self._database)
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
            begin_write(connection, _body_database(connection))
            row = connection.execute(
                f"SELECT COALESCE(MAX(operation_seq), 0) AS value FROM {SESSION_MESSAGE_QUEUE_TABLE} "
                "WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            operation_seq = int(row["value"]) + 1
            cursor = connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, operation_seq = ?, "
                "safe_error = '', safe_error_details = '{}', updated_at = ? "
                "WHERE session_id = ? AND queued_message_id = ? "
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
            if cursor.rowcount != 1:
                return None
            connection.execute(
                f"UPDATE {SESSION_ACTIVATION_TABLE} SET open_state = ? "
                "WHERE session_id = ? AND open_state = ?",
                (OpenState.BOUND.value, session_id, OpenState.UNSUBMITTED.value),
            )
            connection.commit()
        return self.queued_message(session_id, queued_message_id)

    def update_queued_message(
        self,
        session_id: str,
        queued_message_id: str,
        body: Mapping[str, Any],
    ) -> QueuedMessageRecord | None:
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET body = '', body_ref = ?, safe_error = '', "
                "safe_error_details = '{}', updated_at = ? "
                "WHERE session_id = ? AND queued_message_id = ? "
                f"AND state IN ({','.join('?' for _ in QUEUE_SUBMITTABLE_STATES)})",
                (
                    _store_body(
                        connection, json.dumps(dict(body), ensure_ascii=False, sort_keys=True)
                    ),
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
        safe_error_details: Mapping[str, str] | None = None,
    ) -> None:
        state = QueuedMessageState.OUTCOME_UNKNOWN if unknown else QueuedMessageState.FAILED
        allowed = QUEUE_COMPLETABLE_STATES if unknown else QUEUE_REJECTABLE_STATES
        with closing(self._connect()) as connection, connection:
            begin_write(connection, self._database)
            connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, safe_error = ?, "
                "safe_error_details = ?, updated_at = ? "
                "WHERE session_id = ? AND queued_message_id = ? "
                f"AND state IN ({','.join('?' for _ in allowed)})",
                (
                    state.value,
                    safe_error,
                    json.dumps(dict(safe_error_details or {}), ensure_ascii=False, sort_keys=True),
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
        entries = [
            {"name": row.name, "state": row.state.value, "detail": row.detail}
            for row in binding.capabilities.entries
        ]
        payload = (
            {
                CAPABILITY_SNAPSHOT_ENTRIES: entries,
                CAPABILITY_SNAPSHOT_SKILL_POLICY: binding.skill_policy.value,
                CAPABILITY_SNAPSHOT_OPTIONAL: [
                    item.value for item in binding.optional_capabilities
                ],
            }
            if binding.optional_capabilities or binding.skill_policy is SkillPolicy.DENY
            else entries
        )
        return json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    @classmethod
    def _store_runtime_binding(
        cls, connection: sqlite3.Connection, binding: RuntimeBinding, timestamp: float
    ) -> None:
        previous = cls._runtime_binding(
            connection.execute(
                f"SELECT * FROM {SESSION_RUNTIME_BINDING_TABLE} WHERE product_session_id = ?",
                (binding.product_session_id,),
            ).fetchone()
        )
        if (
            previous is not None
            and previous.skill_policy is SkillPolicy.DENY
            and binding.skill_policy is not SkillPolicy.DENY
        ):
            raise SessionBindingConflictError("runtime skill policy cannot be relaxed")
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
    def _runtime_binding(cls, row: sqlite3.Row | Mapping[str, Any] | None) -> RuntimeBinding | None:
        if row is None:
            return None
        raw = json.loads(str(row["capability_snapshot_json"] or "[]"))
        optional: tuple[RuntimeCapabilityName, ...] = ()
        skill_policy = SkillPolicy.INHERIT
        if isinstance(raw, dict):
            skill_policy = SkillPolicy(
                raw.get(CAPABILITY_SNAPSHOT_SKILL_POLICY, SkillPolicy.INHERIT.value)
            )
            optional = tuple(
                RuntimeCapabilityName(item) for item in raw.get(CAPABILITY_SNAPSHOT_OPTIONAL, [])
            )
            raw = raw[CAPABILITY_SNAPSHOT_ENTRIES]
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
            optional_capabilities=optional,
            skill_policy=skill_policy,
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
    def _optional(row: sqlite3.Row | Mapping[str, Any], name: str) -> str | None:
        return str(row[name] or "").strip() or None

    @classmethod
    def _record(cls, row: sqlite3.Row | Mapping[str, Any] | None) -> SessionCatalogRecord | None:
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
            next_turn_mode=cls._optional(row, "next_turn_mode"),
            status=SessionStatus(str(row["status"])),
            last_turn_id=cls._optional(row, "last_turn_id"),
            last_turn_status=cls._optional(row, "last_turn_status"),
            last_product_seq=int(row["last_product_seq"]),
            title=str(row["title"] or ""),
            pinned=bool(row["pinned"]),
            archived=bool(row["archived"]),
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
    def _hil_record(cls, row: sqlite3.Row | Mapping[str, Any] | None) -> SessionHilRecord | None:
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
        row: sqlite3.Row | Mapping[str, Any] | None,
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
    def _activation(row: sqlite3.Row | Mapping[str, Any] | None) -> ActivationRecord | None:
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
            begin_write(connection, _body_database(connection))
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
        self,
        session_id: str,
        attempt_id: str,
        binding: RuntimeBinding,
        *,
        unsubmitted: bool = False,
    ) -> SessionCatalogRecord:
        """Commit positive native-open evidence and its exact attempt atomically."""

        if not attempt_id.strip() or not binding.opaque_session_ref.strip():
            raise ValueError("open attempt and native thread ids must not be empty")
        timestamp = time.time()
        try:
            with closing(self._connect()) as connection, connection:
                begin_write(connection, _body_database(connection))
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
                if activation.open_state in {OpenState.BOUND, OpenState.UNSUBMITTED}:
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
                    (
                        (
                            OpenState.UNSUBMITTED
                            if unsubmitted and activation.open_state is OpenState.OPENING
                            else OpenState.BOUND
                        ).value,
                        session_id,
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise SessionBindingConflictError("native thread is already bound") from exc
        record = self.get(session_id)
        if record is None:
            raise SessionAccessError("session disappeared after native binding")
        return record

    def reset_open_not_applied(self, session_id: str, attempt_id: str) -> bool:
        """Consume a provider's settled negative proof for exactly one first open."""
        if not attempt_id.strip():
            raise ValueError("negative open proof requires an attempt identity")
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"UPDATE {SESSION_ACTIVATION_TABLE} SET open_state = ? "
                "WHERE session_id = ? AND open_attempt_id = ? AND open_state = ? "
                f"AND NOT EXISTS (SELECT 1 FROM {SESSION_RUNTIME_BINDING_TABLE} "
                "WHERE product_session_id = ?) "
                f"AND EXISTS (SELECT 1 FROM {SESSION_CATALOG_TABLE} WHERE session_id = ? "
                "AND (vendor_thread_id IS NULL OR vendor_thread_id = ''))",
                (
                    OpenState.NEVER_STARTED.value,
                    session_id,
                    attempt_id,
                    OpenState.OPENING.value,
                    session_id,
                    session_id,
                ),
            )
        return cursor.rowcount == 1

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
            begin_write(connection, _body_database(connection))
            cursor = connection.execute(
                f"UPDATE {SESSION_ACTIVATION_TABLE} SET generation = generation + 1 "
                "WHERE session_id = ? AND open_state IN (?, ?, ?)",
                (
                    session_id,
                    OpenState.OPENING.value,
                    OpenState.UNSUBMITTED.value,
                    OpenState.BOUND.value,
                ),
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

    def recover_inflight(self, *, now: float | None = None) -> tuple[int, int]:
        """Recover once using the update transaction's clock when supplied."""
        with closing(self._connect()) as connection, connection:
            begin_write(connection, _body_database(connection))
            return self.recover_inflight_rows(
                connection, now=time.time() if now is None else now, database=self._database
            )

    @staticmethod
    def recover_inflight_rows(
        connection: sqlite3.Connection, *, now: float, database: Path | None = None
    ) -> tuple[int, int]:
        """Shared by actual startup and private update projection; caller owns IO."""
        if (
            not isinstance(now, (int, float))
            or isinstance(now, bool)
            or not math.isfinite(now)
            or now <= 0
        ):
            raise ValueError("invalid session recovery timestamp")
        connection.execute(
            f"UPDATE {SESSION_REPLACEMENT_TABLE} SET state = ?, updated_at = ? WHERE state IN (?, ?)",
            (
                ReplacementState.UNKNOWN.value,
                now,
                ReplacementState.OPENING.value,
                ReplacementState.PROVEN.value,
            ),
        )
        connection.execute(
            f"UPDATE {SESSION_BROWSER_ACTION_TABLE} SET status = ?, updated_at = ? "
            "WHERE status IN (?, ?, ?)",
            (
                BrowserActionStatus.UNKNOWN.value,
                now,
                BrowserActionStatus.PENDING.value,
                BrowserActionStatus.APPROVED.value,
                BrowserActionStatus.DISPATCHING.value,
            ),
        )
        openings = connection.execute(
            f"UPDATE {SESSION_ACTIVATION_TABLE} SET open_state = ? WHERE open_state = ?",
            (OpenState.OPEN_UNKNOWN.value, OpenState.OPENING.value),
        ).rowcount
        connection.execute(
            f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, safe_error = ?, "
            "safe_error_details = '{}', updated_at = ? WHERE state = ?",
            (
                QueuedMessageState.FAILED.value,
                QUEUE_RECOVERY_WAIT_INTERRUPTED,
                now,
                QueuedMessageState.WAITING_RESOURCES.value,
            ),
        )
        settlements = connection.execute(
            "SELECT settlement.*, catalog.runtime_id AS expected_runtime_id, "
            "catalog.vendor_thread_id AS expected_native_session_id "
            f"FROM {SESSION_TURN_SETTLEMENT_TABLE} AS settlement "
            f"JOIN {SESSION_CATALOG_TABLE} AS catalog ON catalog.session_id = settlement.session_id "
            f"JOIN {SESSION_MESSAGE_QUEUE_TABLE} AS queue ON queue.session_id = settlement.session_id "
            "AND queue.queued_message_id = settlement.client_turn_id "
            "WHERE queue.state = ? AND queue.native_turn_id = '' "
            f"AND NOT EXISTS (SELECT 1 FROM {SESSION_UNCERTAINTY_TABLE} AS uncertainty "
            "WHERE uncertainty.session_id = queue.session_id AND uncertainty.kind = ? "
            "AND uncertainty.correlation_id = queue.queued_message_id)",
            (QueuedMessageState.SUBMITTING.value, UncertaintyKind.TURN.value),
        ).fetchall()
        for row in settlements:
            pending = SessionCatalogStore._turn_settlement(
                _materialize_row(connection, row, database)
            )
            if pending is None:
                continue
            event = pending.event
            payload = event.payload if isinstance(event.payload, Mapping) else {}
            if (
                event.kind is RuntimeEventKind.TURN_FAILED
                and event.product_session_id == pending.session_id
                and event.runtime_id == row["expected_runtime_id"]
                and event.native_session_id == row["expected_native_session_id"]
                and event.correlation_id == pending.client_turn_id
                and event.native_turn_id == pending.client_turn_id
                and pending.native_turn_id == pending.client_turn_id
                and payload.get("safe_error") == RUNTIME_TURN_NOT_SUBMITTED
                and payload.get("error_code") == RUNTIME_TURN_NOT_SUBMITTED
            ):
                connection.execute(
                    f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, safe_error = ?, "
                    "safe_error_details = '{}', updated_at = ? "
                    "WHERE session_id = ? AND queued_message_id = ? AND state = ? "
                    "AND native_turn_id = ''",
                    (
                        QueuedMessageState.FAILED.value,
                        RUNTIME_TURN_NOT_SUBMITTED,
                        now,
                        pending.session_id,
                        pending.client_turn_id,
                        QueuedMessageState.SUBMITTING.value,
                    ),
                )
        submissions = connection.execute(
            f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, safe_error = ?, "
            "safe_error_details = '{}', updated_at = ? WHERE state IN (?, ?)",
            (
                QueuedMessageState.OUTCOME_UNKNOWN.value,
                QUEUE_RECOVERY_UNKNOWN_ERROR,
                now,
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
                now,
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
        self,
        previous: RuntimeBinding,
        replacement: RuntimeBinding,
        *,
        proof: EmptyThreadReplacementProof | ThreadReplacementProof | None = None,
        revision: str = "",
        manual: bool = False,
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
            begin_write(connection, _body_database(connection))
            source = self._runtime_binding(
                connection.execute(
                    f"SELECT * FROM {SESSION_RUNTIME_BINDING_TABLE} WHERE product_session_id = ?",
                    (previous.product_session_id,),
                ).fetchone()
            )
            if source != previous:
                raise SessionBindingConflictError("runtime replacement binding changed")
            if proof is not None:
                operation_seq, generation = self._replacement_source(
                    connection, proof, manual=manual
                )
                record = self._replacement(
                    _materialize_row(
                        connection,
                        connection.execute(
                            f"SELECT * FROM {SESSION_REPLACEMENT_TABLE} WHERE session_id = ?",
                            (previous.product_session_id,),
                        ).fetchone(),
                    )
                )
                if (
                    proof.binding != previous
                    or record is None
                    or record["state"] is not ReplacementState.OPENING
                    or not self._replacement_matches(record, proof)
                    or record["revision"] != revision
                    or record["generation"] != generation
                    or record["operation_seq"] != operation_seq
                    or record["binding"] != self._binding_fingerprint(previous)
                    or record["configuration"]
                    != self._replacement_configuration(connection, previous.product_session_id)
                    or bool(record.get("manual_retry")) != manual
                    or record.get("candidate")
                    != json.loads(json.dumps(dataclasses.asdict(replacement)))
                ):
                    raise SessionBindingConflictError(
                        "runtime replacement lost its current operation"
                    )
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
            if proof is not None:
                connection.execute(
                    f"UPDATE {SESSION_REPLACEMENT_TABLE} SET state = ?, updated_at = ? WHERE session_id = ?",
                    (ReplacementState.BOUND.value, timestamp, previous.product_session_id),
                )
                connection.execute(
                    f"UPDATE {SESSION_ACTIVATION_TABLE} SET generation = generation + 1 WHERE session_id = ?",
                    (previous.product_session_id,),
                )
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
            begin_write(connection, self._database)
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

    def set_archived(
        self,
        session_id: str,
        principal: SessionPrincipal,
        archived: bool,
    ) -> SessionCatalogRecord:
        self.require(session_id, principal)
        if not isinstance(archived, bool):
            raise ValueError("archived must be a boolean")
        condition, owner_params = self._owner_condition(principal)
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"UPDATE {SESSION_CATALOG_TABLE} SET archived = ? "
                f"WHERE session_id = ? AND {condition}",
                (int(archived), session_id, *owner_params),
            )
            if cursor.rowcount != 1:
                raise SessionAccessError("session not found")
            record = self._record(
                connection.execute(
                    f"SELECT * FROM {SESSION_CATALOG_TABLE} WHERE session_id = ? AND {condition}",
                    (session_id, *owner_params),
                ).fetchone()
            )
        if record is None:
            raise SessionAccessError("session not found")
        return record

    def set_pinned(
        self,
        session_id: str,
        principal: SessionPrincipal,
        pinned: bool,
    ) -> SessionCatalogRecord:
        self.require(session_id, principal)
        if not isinstance(pinned, bool):
            raise ValueError("pinned must be a boolean")
        condition, owner_params = self._owner_condition(principal)
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"UPDATE {SESSION_CATALOG_TABLE} SET pinned = ? "
                f"WHERE session_id = ? AND {condition}",
                (int(pinned), session_id, *owner_params),
            )
            if cursor.rowcount != 1:
                raise SessionAccessError("session not found")
            record = self._record(
                connection.execute(
                    f"SELECT * FROM {SESSION_CATALOG_TABLE} "
                    f"WHERE session_id = ? AND {condition}",
                    (session_id, *owner_params),
                ).fetchone()
            )
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
        next_turn: bool = False,
    ) -> SessionCatalogRecord:
        self.require(session_id, principal)
        timestamp = float(updated_at if updated_at is not None else time.time())
        condition, owner_params = self._owner_condition(principal)
        with closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"""
                UPDATE {SESSION_CATALOG_TABLE}
                SET policy_id = ?, next_turn_mode = ?, updated_at = ?
                WHERE session_id = ? AND {condition}
                """,
                (
                    (policy_id or "").strip() or None,
                    policy_id if next_turn else None,
                    timestamp,
                    session_id,
                    *owner_params,
                ),
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

    def continuation_state(self, session_id: str) -> tuple[str, bool]:
        """Read selected intent and safety gates without materializing private bodies."""

        queue_states = (
            QueuedMessageState.QUEUED,
            QueuedMessageState.WAITING_RESOURCES,
            QueuedMessageState.SUBMITTING,
            QueuedMessageState.RUNNING,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )
        unresolved = (
            UncertaintyState.EXECUTING,
            UncertaintyState.UNKNOWN,
            UncertaintyState.STALE,
        )
        with closing(self._connect()) as connection:
            connection.execute("BEGIN")
            model = connection.execute(
                f"SELECT selected_model_id FROM {SESSION_MODEL_TABLE} WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            gates = (
                (
                    SESSION_MESSAGE_QUEUE_TABLE,
                    "state",
                    tuple(state.value for state in queue_states),
                ),
                (SESSION_HIL_TABLE, "status", (HilStatus.PENDING.value,)),
                (SESSION_UNCERTAINTY_TABLE, "state", tuple(state.value for state in unresolved)),
                (
                    SESSION_ACTIVATION_TABLE,
                    "open_state",
                    (OpenState.OPENING.value, OpenState.OPEN_UNKNOWN.value),
                ),
                (
                    SESSION_REPLACEMENT_TABLE,
                    "state",
                    (ReplacementState.OPENING.value, ReplacementState.UNKNOWN.value),
                ),
            )
            blocked = any(
                connection.execute(
                    f"SELECT 1 FROM {table} WHERE session_id = ? AND {column} IN ({','.join('?' for _ in values)}) LIMIT 1",
                    (session_id, *values),
                ).fetchone()
                is not None
                for table, column, values in gates
            )
            blocked = (
                blocked
                or connection.execute(
                    f"SELECT 1 FROM {SESSION_TURN_SETTLEMENT_TABLE} WHERE session_id = ? LIMIT 1",
                    (session_id,),
                ).fetchone()
                is not None
            )
        return (str(model["selected_model_id"] or "").strip() if model else "", blocked)

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
        return self._model_state(row)

    @staticmethod
    def _model_state(row: sqlite3.Row | Mapping[str, Any]) -> SessionModelState:
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
                SELECT role, text, text_ref, turn_id, item_id, phase
                FROM {SESSION_PORTABLE_HISTORY_TABLE}
                WHERE session_id = ?
                ORDER BY ordinal
                """,
                (session_id,),
            ).fetchall()
            rows = _materialize_rows(connection, rows)
        return tuple(self._history_entry(row) for row in rows)

    @staticmethod
    def _history_entry(row: sqlite3.Row | Mapping[str, Any]) -> HistoryEntry:
        return HistoryEntry(
            role=str(row["role"]),
            text=str(row["text"]),
            turn_id=str(row["turn_id"]),
            item_id=str(row["item_id"]),
            phase=(MessagePhase(str(row["phase"])) if row["phase"] is not None else None),
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
                _store_body(connection, entry.text),
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
                session_id, ordinal, role, text, text_ref, turn_id, item_id, phase
            ) VALUES (?, ?, ?, '', ?, ?, ?, ?)
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
            begin_write(connection, _body_database(connection))
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
                    WHERE session_id = ? AND title IN ({placeholders}) AND title_fallback = ?
                    """,
                    (
                        title.strip(),
                        timestamp,
                        session_id,
                        *allowed,
                        SessionTitleFallback.NEW_SESSION,
                    ),
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
                begin_write(connection, self._database)
                connection.execute(
                    f"""
                    INSERT INTO {SESSION_HIL_TABLE} (
                        product_request_id, session_id, vendor_request_id,
                        vendor_turn_id, vendor_item_id, method, payload, payload_ref, status, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
                    ON CONFLICT(product_request_id) DO NOTHING
                    """,
                    (
                        product_request_id,
                        session_id,
                        vendor_request_id,
                        (vendor_turn_id or "").strip() or None,
                        (vendor_item_id or "").strip() or None,
                        method,
                        _store_body(connection, encoded),
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

    def record_browser_hil(
        self,
        *,
        connection: sqlite3.Connection,
        request_id: str,
        session_id: str,
        turn_id: str,
        payload: dict[str, Any],
        method: str,
    ) -> SessionHilRecord:
        validate_transaction(connection, self._database)
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        timestamp = time.time()
        cursor = connection.execute(
            f"""
            INSERT INTO {SESSION_HIL_TABLE} (
                product_request_id, session_id, vendor_request_id, vendor_turn_id,
                vendor_item_id, method, payload, payload_ref, status, created_at
            ) VALUES (?, ?, ?, ?, NULL, ?, '', ?, ?, ?)
            ON CONFLICT(product_request_id) DO NOTHING
            """,
            (
                request_id,
                session_id,
                request_id,
                turn_id,
                method,
                _store_body(connection, encoded),
                HilStatus.PENDING.value,
                timestamp,
            ),
        )
        row = connection.execute(
            f"SELECT * FROM {SESSION_HIL_TABLE} WHERE product_request_id = ?", (request_id,)
        ).fetchone()
        row = _materialize_row(connection, row)
        record = self._hil_record(row)
        if (
            cursor.rowcount != 1
            or record is None
            or (
                record.session_id != session_id
                or record.vendor_turn_id != turn_id
                or record.method != method
                or record.payload != payload
            )
        ):
            raise SessionStateConflictError("browser approval request identity was reused")
        return record

    def transition_browser_hil(
        self,
        *,
        connection: sqlite3.Connection,
        request_id: str,
        session_id: str,
        turn_id: str,
        method: str,
        decision: dict[str, Any],
    ) -> SessionHilRecord | None:
        validate_transaction(connection, self._database)
        timestamp = time.time()
        cursor = connection.execute(
            f"""
            UPDATE {SESSION_HIL_TABLE}
            SET status = ?, decision = '', decision_ref = ?, resolved_at = ?
            WHERE product_request_id = ? AND session_id = ? AND vendor_turn_id = ?
              AND method = ? AND status = ?
            """,
            (
                HilStatus.RESOLVED.value,
                _store_body(
                    connection, json.dumps(decision, ensure_ascii=False, separators=(",", ":"))
                ),
                timestamp,
                request_id,
                session_id,
                turn_id,
                method,
                HilStatus.PENDING.value,
            ),
        )
        if cursor.rowcount != 1:
            return None
        row = connection.execute(
            f"SELECT * FROM {SESSION_HIL_TABLE} WHERE product_request_id = ?", (request_id,)
        ).fetchone()
        row = _materialize_row(connection, row)
        return self._hil_record(row)

    def hil(self, product_request_id: str) -> SessionHilRecord:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"SELECT * FROM {SESSION_HIL_TABLE} WHERE product_request_id = ?",
                (product_request_id,),
            ).fetchone()
            row = _materialize_row(connection, row)
        record = self._hil_record(row)
        if record is None:
            raise SessionAccessError("HIL request not found")
        return record

    def installation_state(self, request_id: str, state: dict[str, Any]) -> None:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"SELECT * FROM {SESSION_HIL_TABLE} WHERE product_request_id = ?", (request_id,)
            ).fetchone()
            record = self._hil_record(_materialize_row(connection, row))
            if record is None:
                raise SessionAccessError("HIL request not found")
            payload = {**record.payload, "installation_state": state}
            connection.execute(
                f"UPDATE {SESSION_HIL_TABLE} SET payload = '', payload_ref = ? WHERE product_request_id = ?",
                (_store_body(connection, json.dumps(payload, ensure_ascii=False)), request_id),
            )

    def pending_hil(
        self, session_id: str, *, blocking_only: bool = True
    ) -> tuple[SessionHilRecord, ...]:
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {SESSION_HIL_TABLE}
                WHERE session_id = ? AND status = ? ORDER BY created_at, product_request_id
                """,
                (session_id, HilStatus.PENDING.value),
            ).fetchall()
            rows = _materialize_rows(connection, rows)
        return tuple(
            record
            for row in rows
            if (record := self._hil_record(row)) is not None
            and (not blocking_only or record.payload.get(PRODUCT_INTERACTION_BLOCKING, True))
        )

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
            rows = _materialize_rows(connection, rows)
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
            rows = _materialize_rows(connection, rows)
        return tuple(
            record
            for row in rows
            if (record := self._hil_record(row)) is not None
            and record.payload.get(PRODUCT_INTERACTION_BLOCKING, True)
        )

    def acknowledge_hil(
        self,
        product_request_id: str,
        *,
        resolved_at: float | None = None,
    ) -> SessionHilRecord:
        """Record a native acknowledgement without replacing the product decision."""

        timestamp = float(resolved_at if resolved_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            begin_write(connection, self._database)
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
            begin_write(connection, self._database)
            cursor = connection.execute(
                f"""
                UPDATE {SESSION_HIL_TABLE}
                SET status = ?, decision = '', decision_ref = ?, resolved_at = ?
                WHERE product_request_id = ? AND status IN (?, ?)
                """,
                (
                    HilStatus.RESOLVED.value,
                    _store_body(connection, encoded),
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
                    state, payload, payload_ref, created_at
                ) VALUES (?, ?, ?, ?, ?, '', ?, ?)
                ON CONFLICT(session_id, kind, correlation_id) DO NOTHING
                """,
                (
                    session_id,
                    kind.value,
                    product_request_id,
                    int(process_generation),
                    UncertaintyState.EXECUTING.value,
                    _store_body(connection, payload_json),
                    timestamp,
                ),
            )
            if claimed.rowcount != 1:
                return False
            sealed = connection.execute(
                f"""
                UPDATE {SESSION_HIL_TABLE}
                SET status = ?, decision = '', decision_ref = ?
                WHERE product_request_id = ? AND status = ?
                """,
                (
                    HilStatus.UNKNOWN.value,
                    _store_body(connection, decision_json),
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
        expected_uncertainty: tuple[int, str] | None = None,
        runtime_confirmation: Mapping[str, Any] | None = None,
    ) -> bool:
        """Atomically persist human confirmation and reopen session admission."""

        timestamp = float(resolved_at if resolved_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            begin_write(connection, self._database)
            row = connection.execute(
                f"SELECT * FROM {SESSION_UNCERTAINTY_TABLE} "
                "WHERE session_id = ? AND kind = ? AND correlation_id = ?",
                (session_id, UncertaintyKind.TURN.value, correlation_id),
            ).fetchone()
            current = self._uncertainty_record(_materialize_row(connection, row))
            if current is None or (
                expected_uncertainty is not None
                and expected_uncertainty != (current.process_generation, current.incident_id or "")
            ):
                return False
            values = {**current.payload, "resolution": resolution}
            if runtime_confirmation is not None:
                values[UNCERTAINTY_CONFIRMATION_KEY] = dict(runtime_confirmation)
            payload = json.dumps(values, separators=(",", ":"))
            if current.state is UncertaintyState.CONFIRMED and runtime_confirmation is not None:
                connection.execute(
                    f"UPDATE {SESSION_UNCERTAINTY_TABLE} SET payload = '', payload_ref = ? "
                    "WHERE session_id = ? AND kind = ? AND correlation_id = ? AND state = ?",
                    (
                        _store_body(connection, payload),
                        session_id,
                        UncertaintyKind.TURN.value,
                        correlation_id,
                        UncertaintyState.CONFIRMED.value,
                    ),
                )
                return True
            transitioned = connection.execute(
                f"""
                UPDATE {SESSION_UNCERTAINTY_TABLE}
                SET state = ?, payload = '', payload_ref = ?, resolved_at = ?
                WHERE session_id = ? AND kind = ? AND correlation_id = ?
                  AND state IN (?, ?)
                """,
                (
                    UncertaintyState.CONFIRMED.value,
                    _store_body(connection, payload),
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
                SET state = ?, payload = '', payload_ref = ?, resolved_at = ?
                WHERE session_id = ? AND kind = ? AND correlation_id = ?
                  AND state IN (?, ?)
                """,
                (
                    UncertaintyState.RECONCILED.value,
                    _store_body(connection, payload),
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

    def record_unknown_turn(
        self, session_id: str, correlation_id: str, event: RuntimeEvent, *, safe_error: str
    ) -> SessionUncertaintyRecord:
        if (
            event.kind is not RuntimeEventKind.TURN_UNKNOWN
            or event.product_session_id != session_id
            or event.native_turn_id != correlation_id
        ):
            raise ValueError("unknown turn evidence requires matching identity")
        with closing(self._connect()) as connection, connection:
            begin_write(connection, self._database)
            row = connection.execute(
                f"SELECT * FROM {SESSION_UNCERTAINTY_TABLE} "
                "WHERE session_id = ? AND kind = ? AND correlation_id = ?",
                (session_id, UncertaintyKind.TURN.value, correlation_id),
            ).fetchone()
            current = self._uncertainty_record(_materialize_row(connection, row))
            canonical = event
            if current is not None:
                if current.state not in {UncertaintyState.EXECUTING, UncertaintyState.UNKNOWN}:
                    return current
                previous = current.payload.get(UNCERTAINTY_RUNTIME_EVENT_KEY)
                if isinstance(previous, Mapping):
                    prior = self._runtime_event(previous)
                    prior_values = prior.payload if isinstance(prior.payload, Mapping) else {}
                    prior_incident = prior_values.get(INCIDENT_PAYLOAD_KEY)
                    if (
                        current.process_generation != prior.process_generation
                        or not isinstance(prior_incident, Mapping)
                        or (current.incident_id or "") != prior_incident.get(INCIDENT_ID_KEY, "")
                    ):
                        return current
                    if prior == event:
                        return current
                    refined = self._coalesce_unknown_settlement(prior, event.correlation_id, event)
                    if refined is None or refined == prior:
                        return current
                    canonical = refined
                elif (
                    current.state is UncertaintyState.UNKNOWN
                    or current.process_generation not in (0, event.process_generation)
                ):
                    return current
            values = canonical.payload if isinstance(canonical.payload, Mapping) else {}
            incident = values.get(INCIDENT_PAYLOAD_KEY)
            incident_id = (
                str(incident.get(INCIDENT_ID_KEY) or "") if isinstance(incident, Mapping) else ""
            )
            if (
                current is not None
                and not isinstance(current.payload.get(UNCERTAINTY_RUNTIME_EVENT_KEY), Mapping)
                and current.incident_id
                and current.incident_id != incident_id
            ):
                return current
            payload = {
                **(current.payload if current is not None else {}),
                "outcome": PRODUCT_TURN_OUTCOME_UNKNOWN,
                "safe_error": safe_error,
                UNCERTAINTY_RUNTIME_EVENT_KEY: dataclasses.asdict(canonical),
            }
            created_at = current.created_at if current is not None else time.time()
            connection.execute(
                f"INSERT INTO {SESSION_UNCERTAINTY_TABLE} "
                "(session_id, kind, correlation_id, incident_id, process_generation, state, "
                "payload, payload_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?) "
                "ON CONFLICT(session_id, kind, correlation_id) DO UPDATE SET "
                "incident_id = excluded.incident_id, process_generation = excluded.process_generation, "
                "state = excluded.state, payload = '', payload_ref = excluded.payload_ref",
                (
                    session_id,
                    UncertaintyKind.TURN.value,
                    correlation_id,
                    incident_id or None,
                    canonical.process_generation,
                    UncertaintyState.UNKNOWN.value,
                    _store_body(connection, json.dumps(payload, ensure_ascii=False)),
                    created_at,
                ),
            )
            row = connection.execute(
                f"SELECT * FROM {SESSION_UNCERTAINTY_TABLE} "
                "WHERE session_id = ? AND kind = ? AND correlation_id = ?",
                (session_id, UncertaintyKind.TURN.value, correlation_id),
            ).fetchone()
            recorded = self._uncertainty_record(_materialize_row(connection, row))
            if recorded is None:
                raise SessionStateConflictError("unknown turn evidence was not recorded")
            return recorded

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
            begin_write(connection, self._database)
            cursor = connection.execute(
                f"""
                INSERT INTO {SESSION_UNCERTAINTY_TABLE} (
                    session_id, kind, correlation_id, incident_id,
                    process_generation, state, payload, payload_ref, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)
                ON CONFLICT(session_id, kind, correlation_id) DO NOTHING
                """,
                (
                    session_id,
                    UncertaintyKind(kind).value,
                    correlation_id,
                    (incident_id or "").strip() or None,
                    int(process_generation),
                    UncertaintyState(state).value,
                    _store_body(connection, encoded),
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
            begin_write(connection, self._database)
            cursor = connection.execute(
                f"""
                UPDATE {SESSION_UNCERTAINTY_TABLE}
                SET state = ?,
                    incident_id = COALESCE(?, incident_id),
                    process_generation = COALESCE(?, process_generation),
                    payload = CASE WHEN ? IS NULL THEN payload ELSE '' END,
                    payload_ref = COALESCE(?, payload_ref),
                    resolved_at = ?
                WHERE session_id = ? AND kind = ? AND correlation_id = ?
                """,
                (
                    UncertaintyState(state).value,
                    (incident_id or "").strip() or None,
                    process_generation,
                    encoded,
                    _store_body(connection, encoded) if encoded is not None else None,
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
            row = _materialize_row(connection, row)
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
            rows = _materialize_rows(connection, rows)
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
            rows = _materialize_rows(connection, rows)
            rows = [
                row
                for row in rows
                if (record := self._hil_record(row)) is not None
                and record.payload.get(PRODUCT_INTERACTION_BLOCKING, True)
            ]
            if not rows:
                return ()
            begin_write(connection, self._database)
            connection.executemany(
                f"""
                UPDATE {SESSION_HIL_TABLE}
                SET status = ?, resolved_at = ?
                WHERE product_request_id = ? AND status = ?
                """,
                [
                    (
                        HilStatus.EXPIRED.value,
                        timestamp,
                        row["product_request_id"],
                        HilStatus.PENDING.value,
                    )
                    for row in rows
                ],
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
        after: tuple[float, str, bool | None] | None = None,
        archived: bool | None = None,
    ) -> tuple[SessionCatalogRecord, ...]:
        """List one catalog scope with all filters applied before ``LIMIT``."""

        condition, owner_params = self._owner_condition(principal)
        clauses = [condition]
        params: list[str | int | float] = [*owner_params]
        if archived is not None:
            clauses.append("archived = ?")
            params.append(int(archived))
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
        if after is not None:
            activity_after = "(updated_at < ? OR (updated_at = ? AND session_id > ?))"
            if scope is SessionListScope.PROJECT and after[2] is not None:
                clauses.append(f"(pinned < ? OR (pinned = ? AND {activity_after}))")
                params.extend((int(after[2]), int(after[2])))
            else:
                clauses.append(activity_after)
            params.extend((after[0], after[0], after[1]))
        limit_clause = ""
        if limit is not None:
            limit_clause = "LIMIT ?"
            params.append(limit)
        order = "updated_at DESC, session_id"
        if scope is SessionListScope.PROJECT:
            order = f"pinned DESC, {order}"
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {SESSION_CATALOG_TABLE}
                WHERE {" AND ".join(clauses)}
                ORDER BY {order}
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
            cursor = connection.execute(
                f"""
                DELETE FROM {SESSION_CATALOG_TABLE}
                WHERE session_id = ? AND {condition}
                """,
                (session_id, *owner_params),
            )
            if cursor.rowcount == 1:
                connection.execute(
                    f"DELETE FROM {SESSION_BROWSER_ACTION_TABLE} WHERE session_id = ?",
                    (session_id,),
                )
                connection.execute(
                    f"DELETE FROM {SESSION_BROWSER_ACTION_WATERMARK_TABLE} WHERE session_id = ?",
                    (session_id,),
                )
