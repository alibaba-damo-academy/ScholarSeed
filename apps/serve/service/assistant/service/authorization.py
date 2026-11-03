"""Task- and source-scoped authorization for model-visible full text."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import uuid
from contextlib import closing
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping

from service.capabilities.service.plugins import PLUGIN_AUTHORIZATION_SLOT, PLUGIN_SELECTION_SLOT
from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SQLITE_TIMEOUT_SECONDS,
    HilStatus,
    SessionCatalogStore,
)
from service.persistence.project import (
    database_files,
    open_database,
    reader,
    reject_schema_residue,
    schema_transaction,
    sql_tokens,
    table_clauses,
)
from service.platform.activity import ActivityLease
from service.platform.context import FulltextBindingScope, FulltextTaskContext, ProductTaskType

FULLTEXT_AUTHORIZATION_TABLE = "assistant_fulltext_authorization"
RESEARCH_IDEA_FULLTEXT = "research_idea_fulltext"
PRECISE_SEARCH_FULLTEXT = "precise_search_fulltext"
LITERATURE_REVIEW_FULLTEXT = "literature_review_fulltext"
RESEARCH_IDEA_QUESTION_PREFIX = "research-idea-fulltext:"
PRECISE_SEARCH_QUESTION_PREFIX = "precise-search-fulltext:"
LITERATURE_REVIEW_QUESTION_PREFIX = "literature-review-fulltext:"
RESEARCH_IDEA_AUTHORIZATION_HEADER = "想法原文授权"
RESEARCH_IDEA_AUTHORIZATION_QUESTION = (
    "是否允许读取已展示文献的全文，用于生成有原文依据的研究想法？"
)
PRECISE_SEARCH_AUTHORIZATION_HEADER = "精准检索授权"
PRECISE_SEARCH_AUTHORIZATION_QUESTION = "是否允许下载、读取并使用已展示文献的全文作为证据？"
LITERATURE_REVIEW_AUTHORIZATION_HEADER = "综述检索授权"
LITERATURE_REVIEW_AUTHORIZATION_QUESTION = "是否允许读取已展示文献的全文，用于继续生成文献综述？"
RESEARCH_IDEA_AUTHORIZE = "一键授权"
RESEARCH_IDEA_AUTHORIZE_RECOMMENDED = f"{RESEARCH_IDEA_AUTHORIZE} (Recommended)"
RESEARCH_IDEA_REJECT = "拒绝"
AUTHORIZE_DESCRIPTION = "允许在本次任务和已展示文献范围内读取全文。"
REJECT_DESCRIPTION = "不读取全文，并停止本次全文处理。"
AUTHORIZATION_REQUIRED = "fulltext_authorization_required"
CONTINUATION_TURN_COLUMN = "continuation_turn_id"
TASK_KEY_COLUMN = "task_key"
SELECTED_PAPER_IDS_KEY = "selected_paper_ids"
DECISION_CANCELLED = "cancelled"
DECISION_TIMED_OUT = "timed_out"


class AuthorizationDisposition(str, Enum):
    AUTHORIZED = "authorized"
    REJECTED = "rejected"


@dataclass(frozen=True)
class FulltextAuthorizationPolicy:
    task_type: ProductTaskType
    authorization_type: str
    question_prefix: str
    header: str
    question: str
    authorize: str = RESEARCH_IDEA_AUTHORIZE
    reject: str = RESEARCH_IDEA_REJECT
    subset_selection: bool = False


FULLTEXT_AUTHORIZATION_POLICIES = (
    FulltextAuthorizationPolicy(
        ProductTaskType.RESEARCH_IDEA,
        RESEARCH_IDEA_FULLTEXT,
        RESEARCH_IDEA_QUESTION_PREFIX,
        RESEARCH_IDEA_AUTHORIZATION_HEADER,
        RESEARCH_IDEA_AUTHORIZATION_QUESTION,
    ),
    FulltextAuthorizationPolicy(
        ProductTaskType.PRECISE_SEARCH,
        PRECISE_SEARCH_FULLTEXT,
        PRECISE_SEARCH_QUESTION_PREFIX,
        PRECISE_SEARCH_AUTHORIZATION_HEADER,
        PRECISE_SEARCH_AUTHORIZATION_QUESTION,
        subset_selection=True,
    ),
    FulltextAuthorizationPolicy(
        ProductTaskType.LITERATURE_REVIEW,
        LITERATURE_REVIEW_FULLTEXT,
        LITERATURE_REVIEW_QUESTION_PREFIX,
        LITERATURE_REVIEW_AUTHORIZATION_HEADER,
        LITERATURE_REVIEW_AUTHORIZATION_QUESTION,
    ),
)
POLICIES_BY_AUTHORIZATION_TYPE = {
    policy.authorization_type: policy for policy in FULLTEXT_AUTHORIZATION_POLICIES
}
POLICIES_BY_TASK_TYPE = {
    policy.task_type.value: policy for policy in FULLTEXT_AUTHORIZATION_POLICIES
}
SUPPORTED_AUTHORIZATION_TYPES = frozenset(POLICIES_BY_AUTHORIZATION_TYPE)


def authorization_policy(authorization_type: str) -> FulltextAuthorizationPolicy:
    try:
        return POLICIES_BY_AUTHORIZATION_TYPE[authorization_type]
    except KeyError as exc:
        raise ValueError("fulltext_authorization_type_unknown") from exc


def task_authorization_policy(task_type: str) -> FulltextAuthorizationPolicy | None:
    return POLICIES_BY_TASK_TYPE.get(task_type)


class AuthorizationState(str, Enum):
    PENDING = "pending"
    SUPERSEDED = "superseded"


@dataclass(frozen=True)
class FulltextAuthorization:
    authorization_id: str
    session_id: str
    snapshot_id: str
    turn_id: str
    authorization_type: str
    refs: tuple[str, ...]
    scope_digest: str
    question_id: str
    state: AuthorizationState
    created_at: float
    task_key: str = ""


@dataclass(frozen=True)
class EffectiveFulltextScope:
    allowed: tuple[str, ...]
    denied: tuple[str, ...]
    unknown: tuple[str, ...]
    authorizations: tuple[FulltextAuthorization, ...]
    grants: Mapping[str, str] = field(default_factory=dict)


def fulltext_binding_scope(
    scope: EffectiveFulltextScope | None,
    ref_id: str,
    *,
    session_id: str,
    project_id: str,
    workspace: str = "",
    task_context: FulltextTaskContext | None = None,
) -> FulltextBindingScope:
    """Resolve version identity from a verified workspace or the effective source grant."""
    if task_context is not None:
        if (
            task_context.session_id != session_id
            or task_context.project_id != project_id
            or (workspace and workspace != task_context.workspace)
        ):
            raise ValueError("fulltext_authorization_task_mismatch")
        workspace = task_context.workspace
    if workspace:
        return FulltextBindingScope(session_id, project_id, workspace)
    if scope is None or ref_id not in scope.allowed or not scope.grants.get(ref_id):
        raise ValueError(AUTHORIZATION_REQUIRED)
    return FulltextBindingScope(session_id, project_id, "", scope.grants[ref_id])


@dataclass(frozen=True)
class AuthorizationSchema:
    create_table: bool
    create_index: bool
    add_continuation: bool
    add_task_key: bool
    create_task_index: bool

    @property
    def needs_write(self) -> bool:
        return any(
            (
                self.create_table,
                self.create_index,
                self.add_continuation,
                self.add_task_key,
                self.create_task_index,
            )
        )


class FulltextAuthorizer:
    """Persist challenges and derive grants only from confirmed durable HIL answers."""

    def __init__(self, database: Path, catalog: SessionCatalogStore) -> None:
        self._database = database
        self._catalog = catalog
        self.ensure_schema(database)

    @classmethod
    def ensure_schema(cls, database: Path) -> None:
        if not cls.inspect_schema(database).needs_write:
            return
        with closing(open_database(str(database), timeout=SQLITE_TIMEOUT_SECONDS)) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            with schema_transaction(connection):
                cls.initialize_schema(connection)

    @classmethod
    def initialize_schema(cls, connection: sqlite3.Connection) -> None:
        cls.inspect_connection(connection)
        cls._create_schema(connection)
        if cls.inspect_connection(connection).needs_write:
            raise RuntimeError("fulltext authorization schema initialization incomplete")

    @classmethod
    def inspect_schema(cls, database: Path) -> AuthorizationSchema:
        with database_files(database) as present:
            if not present:
                with closing(sqlite3.connect(":memory:")) as connection:
                    connection.row_factory = sqlite3.Row
                    return cls.inspect_connection(connection)
            with reader(database) as connection:
                connection.execute("BEGIN")
                return cls.inspect_connection(connection)

    @classmethod
    def inspect_connection(cls, connection: sqlite3.Connection) -> AuthorizationSchema:
        reject_schema_residue(connection, (FULLTEXT_AUTHORIZATION_TABLE,))
        objects = {
            row["name"]: row
            for row in connection.execute("SELECT name,type,tbl_name,sql FROM sqlite_master")
        }
        table = objects.get(FULLTEXT_AUTHORIZATION_TABLE)
        index_name = f"idx_{FULLTEXT_AUTHORIZATION_TABLE}_turn"
        index = objects.get(index_name)
        task_index_name = f"idx_{FULLTEXT_AUTHORIZATION_TABLE}_task"
        task_index = objects.get(task_index_name)
        with closing(sqlite3.connect(":memory:")) as reference:
            reference.row_factory = sqlite3.Row
            cls._create_schema(reference, continuation=False)
            legacy = reference.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (FULLTEXT_AUTHORIZATION_TABLE,)
            ).fetchone()[0]
            expected_index = reference.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (index_name,)
            ).fetchone()[0]
            cls._create_schema(reference, task_key=False)
            continuation_schema = reference.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (FULLTEXT_AUTHORIZATION_TABLE,)
            ).fetchone()[0]
            cls._create_schema(reference)
            current = reference.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (FULLTEXT_AUTHORIZATION_TABLE,)
            ).fetchone()[0]
            expected_task_index = reference.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (task_index_name,)
            ).fetchone()[0]
        add_column = False
        add_task_key = False
        if table is not None:
            if table["type"] != "table":
                raise RuntimeError("unsupported fulltext authorization table")
            actual = table_clauses(table["sql"], FULLTEXT_AUTHORIZATION_TABLE)
            if actual == table_clauses(legacy, FULLTEXT_AUTHORIZATION_TABLE):
                add_column = True
                add_task_key = True
            elif actual == table_clauses(continuation_schema, FULLTEXT_AUTHORIZATION_TABLE):
                add_task_key = True
            elif actual != table_clauses(current, FULLTEXT_AUTHORIZATION_TABLE):
                raise RuntimeError("unsupported fulltext authorization definition")
        if index is not None and (
            index["type"] != "index"
            or index["tbl_name"] != FULLTEXT_AUTHORIZATION_TABLE
            or sql_tokens(index["sql"]) != sql_tokens(expected_index)
        ):
            raise RuntimeError("unsupported fulltext authorization index")
        if task_index is not None and (
            task_index["type"] != "index"
            or task_index["tbl_name"] != FULLTEXT_AUTHORIZATION_TABLE
            or sql_tokens(task_index["sql"]) != sql_tokens(expected_task_index)
        ):
            raise RuntimeError("unsupported fulltext authorization task index")
        return AuthorizationSchema(
            table is None, index is None, add_column, add_task_key, task_index is None
        )

    @classmethod
    def inspect_rows(cls, connection: sqlite3.Connection) -> None:
        for row in connection.execute(f"SELECT * FROM {FULLTEXT_AUTHORIZATION_TABLE}"):
            cls._record(row)
            # Turn reuse queries consume this column independently of _record.
            if not isinstance(row[CONTINUATION_TURN_COLUMN], str):
                raise ValueError("invalid fulltext continuation turn")

    @staticmethod
    def _create_schema(
        connection: sqlite3.Connection, *, continuation: bool = True, task_key: bool = True
    ) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {FULLTEXT_AUTHORIZATION_TABLE} (
                authorization_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                snapshot_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                authorization_type TEXT NOT NULL,
                scope_json TEXT NOT NULL,
                scope_digest TEXT NOT NULL,
                question_id TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL,
                created_at REAL NOT NULL,
                UNIQUE(session_id, snapshot_id, turn_id, authorization_type, scope_digest),
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{FULLTEXT_AUTHORIZATION_TABLE}_turn "
            f"ON {FULLTEXT_AUTHORIZATION_TABLE}(session_id, snapshot_id, turn_id, state)"
        )
        columns = {
            str(row["name"])
            for row in connection.execute(
                f"PRAGMA table_info({FULLTEXT_AUTHORIZATION_TABLE})"
            ).fetchall()
        }
        if continuation and CONTINUATION_TURN_COLUMN not in columns:
            connection.execute(
                f"ALTER TABLE {FULLTEXT_AUTHORIZATION_TABLE} "
                f"ADD COLUMN {CONTINUATION_TURN_COLUMN} TEXT NOT NULL DEFAULT ''"
            )
        if continuation and task_key:
            if TASK_KEY_COLUMN not in columns:
                connection.execute(
                    f"ALTER TABLE {FULLTEXT_AUTHORIZATION_TABLE} "
                    f"ADD COLUMN {TASK_KEY_COLUMN} TEXT NOT NULL DEFAULT ''"
                )
            connection.execute(
                f"CREATE INDEX IF NOT EXISTS idx_{FULLTEXT_AUTHORIZATION_TABLE}_task "
                f"ON {FULLTEXT_AUTHORIZATION_TABLE}(session_id, {TASK_KEY_COLUMN}, "
                "authorization_type, state)"
            )

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

    @staticmethod
    def _scope(refs: tuple[str, ...], task_key: str = "") -> tuple[tuple[str, ...], str, str]:
        canonical = tuple(sorted(set(ref.strip() for ref in refs if ref.strip())))
        if not canonical:
            raise ValueError("fulltext_authorization_scope_required")
        encoded = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"))
        fingerprint = (
            json.dumps((task_key, canonical), ensure_ascii=False, separators=(",", ":"))
            if task_key
            else encoded
        )
        return canonical, encoded, hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()

    @staticmethod
    def task_key(
        session_id: str, authorization_type: str, task_context: FulltextTaskContext | None
    ) -> str:
        policy = authorization_policy(authorization_type)
        if task_context is None:
            return ""
        if (
            task_context.session_id != session_id
            or task_context.task_type is not policy.task_type
            or not isinstance(task_context.project_id, str)
            or not all(
                value for field, value in asdict(task_context).items() if field != "project_id"
            )
        ):
            raise ValueError("fulltext_authorization_task_mismatch")
        encoded = json.dumps(
            asdict(task_context), sort_keys=True, ensure_ascii=False, separators=(",", ":")
        )
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def prepare(
        self,
        *,
        session_id: str,
        snapshot_id: str,
        turn_id: str,
        authorization_type: str,
        refs: tuple[str, ...],
        task_context: FulltextTaskContext | None = None,
    ) -> FulltextAuthorization:
        policy = authorization_policy(authorization_type)
        if not session_id or not snapshot_id or not turn_id:
            raise ValueError("fulltext_authorization_scope_unavailable")
        task_key = self.task_key(session_id, authorization_type, task_context)
        canonical, encoded, scope_digest = self._scope(refs, task_key)
        timestamp = time.time()
        authorization_id = uuid.uuid4().hex
        question_id = policy.question_prefix + authorization_id
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            candidates = connection.execute(
                f"SELECT * FROM {FULLTEXT_AUTHORIZATION_TABLE} "
                f"WHERE session_id = ? AND authorization_type = ? AND {TASK_KEY_COLUMN} = ? "
                "AND state = ? AND (scope_digest = ? OR (snapshot_id = ? AND turn_id = ?)) "
                "ORDER BY created_at DESC",
                (
                    session_id,
                    authorization_type,
                    task_key,
                    AuthorizationState.PENDING.value,
                    scope_digest,
                    snapshot_id,
                    turn_id,
                ),
            ).fetchall()
            for candidate in candidates:
                authorization = self._record(candidate)
                decided = self.decided(authorization)
                same_turn = (
                    authorization.snapshot_id == snapshot_id and authorization.turn_id == turn_id
                )
                pending = any(
                    hil.status is HilStatus.PENDING
                    and any(
                        isinstance(question, dict)
                        and question.get("id") == authorization.question_id
                        for question in hil.payload.get("questions", [])
                    )
                    for hil in self._catalog.turn_hil(session_id, authorization.turn_id)
                )
                if authorization.scope_digest == scope_digest and (same_turn or task_key):
                    if decided or pending or (same_turn and not self._has_hil(authorization)):
                        return authorization
                if (
                    not decided
                    and not pending
                    and (same_turn or (task_key and authorization.scope_digest == scope_digest))
                ):
                    connection.execute(
                        f"UPDATE {FULLTEXT_AUTHORIZATION_TABLE} SET state = ? WHERE authorization_id = ?",
                        (AuthorizationState.SUPERSEDED.value, authorization.authorization_id),
                    )
            connection.execute(
                f"""
                INSERT INTO {FULLTEXT_AUTHORIZATION_TABLE} (
                    authorization_id, session_id, snapshot_id, turn_id,
                    authorization_type, scope_json, scope_digest, question_id,
                    state, created_at, {TASK_KEY_COLUMN}
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id, snapshot_id, turn_id, authorization_type, scope_digest)
                DO UPDATE SET
                    authorization_id = excluded.authorization_id,
                    question_id = excluded.question_id,
                    state = excluded.state,
                    created_at = excluded.created_at
                WHERE {FULLTEXT_AUTHORIZATION_TABLE}.state = ?
                """,
                (
                    authorization_id,
                    session_id,
                    snapshot_id,
                    turn_id,
                    authorization_type,
                    encoded,
                    scope_digest,
                    question_id,
                    AuthorizationState.PENDING.value,
                    timestamp,
                    task_key,
                    AuthorizationState.SUPERSEDED.value,
                ),
            )
            row = connection.execute(
                f"""
                SELECT * FROM {FULLTEXT_AUTHORIZATION_TABLE}
                WHERE session_id = ? AND snapshot_id = ? AND turn_id = ?
                  AND authorization_type = ? AND scope_digest = ?
                """,
                (session_id, snapshot_id, turn_id, authorization_type, scope_digest),
            ).fetchone()
        if row is None:
            raise RuntimeError("fulltext authorization disappeared")
        return self._record(row)

    def require(
        self,
        *,
        session_id: str,
        snapshot_id: str,
        turn_id: str,
        authorization_type: str,
        ref_id: str,
        client_turn_id: str = "",
        task_context: FulltextTaskContext | None = None,
    ) -> None:
        """Allow one ref only through a durable decision in the verified scope."""

        scope = self.effective_scope(
            session_id=session_id,
            snapshot_id=snapshot_id,
            turn_id=turn_id,
            authorization_type=authorization_type,
            client_turn_id=client_turn_id,
            task_context=task_context,
            refs=(ref_id,),
        )
        if ref_id in scope.allowed:
            return
        raise ValueError(AUTHORIZATION_REQUIRED)

    def turn_scope(
        self,
        *,
        session_id: str,
        snapshot_id: str,
        turn_id: str,
        authorization_type: str,
        client_turn_id: str = "",
        task_context: FulltextTaskContext | None = None,
    ) -> tuple[FulltextAuthorization, ...]:
        """Challenges of a verified task, otherwise only the turn or explicit continuation."""

        authorization_policy(authorization_type)
        task_key = self.task_key(session_id, authorization_type, task_context)
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {FULLTEXT_AUTHORIZATION_TABLE}
                WHERE session_id = ? AND state = ? AND authorization_type = ?
                  AND {TASK_KEY_COLUMN} = ?
                  AND (? <> '' OR (snapshot_id = ? AND turn_id = ?)
                       OR ({CONTINUATION_TURN_COLUMN} <> '' AND {CONTINUATION_TURN_COLUMN} = ?))
                ORDER BY created_at DESC
                """,
                (
                    session_id,
                    AuthorizationState.PENDING.value,
                    authorization_type,
                    task_key,
                    task_key,
                    snapshot_id,
                    turn_id,
                    client_turn_id,
                ),
            ).fetchall()
        return tuple(self._record(row) for row in rows)

    def effective_scope(
        self,
        *,
        session_id: str,
        snapshot_id: str,
        turn_id: str,
        authorization_type: str,
        refs: tuple[str, ...] = (),
        client_turn_id: str = "",
        task_context: FulltextTaskContext | None = None,
    ) -> EffectiveFulltextScope:
        authorizations = self.turn_scope(
            session_id=session_id,
            snapshot_id=snapshot_id,
            turn_id=turn_id,
            authorization_type=authorization_type,
            client_turn_id=client_turn_id,
            task_context=task_context,
        )
        allowed: set[str] = set()
        denied: set[str] = set()
        grants: dict[str, str] = {}
        for authorization in authorizations:
            if not self.decided(authorization):
                continue
            decided = allowed | denied
            granted = set(self.granted_refs(authorization))
            grants.update({ref: authorization.authorization_id for ref in granted - decided})
            allowed.update(granted - decided)
            denied.update(set(authorization.refs) - granted - decided)
        requested = refs or tuple(
            dict.fromkeys(ref for item in authorizations for ref in item.refs)
        )
        return EffectiveFulltextScope(
            allowed=tuple(ref for ref in requested if ref in allowed),
            denied=tuple(ref for ref in requested if ref in denied),
            unknown=tuple(ref for ref in requested if ref not in allowed | denied),
            authorizations=authorizations,
            grants=grants,
        )

    def session_scope(
        self, *, session_id: str, authorization_type: str, refs: tuple[str, ...]
    ) -> tuple[FulltextAuthorization, ...]:
        """Return this Session's challenges for one exact source set, newest first."""

        authorization_policy(authorization_type)
        _canonical, _encoded, scope_digest = self._scope(refs)
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {FULLTEXT_AUTHORIZATION_TABLE}
                WHERE session_id = ? AND authorization_type = ? AND scope_digest = ?
                ORDER BY created_at DESC
                """,
                (session_id, authorization_type, scope_digest),
            ).fetchall()
        return tuple(self._record(row) for row in rows)

    def granted_scope(
        self, *, session_id: str, authorization_type: str, refs: tuple[str, ...]
    ) -> bool:
        """Whether the user already allowed this exact source set in this Session."""

        return any(
            self._is_granted(authorization)
            for authorization in self.session_scope(
                session_id=session_id, authorization_type=authorization_type, refs=refs
            )
        )

    def bind_continuation(self, authorization: FulltextAuthorization, client_turn_id: str) -> None:
        """Extend one durable grant to the product turn that resumes its interrupted task."""

        if not client_turn_id.strip():
            raise ValueError("fulltext_authorization_continuation_required")
        if not self._is_granted(authorization):
            raise ValueError(AUTHORIZATION_REQUIRED)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                f"""
                UPDATE {FULLTEXT_AUTHORIZATION_TABLE}
                SET {CONTINUATION_TURN_COLUMN} = ?
                WHERE authorization_id = ? AND state = ?
                """,
                (client_turn_id, authorization.authorization_id, AuthorizationState.PENDING.value),
            )

    def _resolved_decision(self, authorization: FulltextAuthorization) -> Mapping[str, Any] | None:
        """The durable answer to this exact challenge, whatever it says."""

        for hil in self._catalog.turn_hil(authorization.session_id, authorization.turn_id):
            if hil.status is not HilStatus.RESOLVED or not hil.decision:
                continue
            if hil.decision.get(DECISION_CANCELLED) or hil.decision.get(DECISION_TIMED_OUT):
                continue
            questions = hil.payload.get("questions")
            if not isinstance(questions, list) or not any(
                isinstance(question, dict) and question.get("id") == authorization.question_id
                for question in questions
            ):
                continue
            answers = hil.decision.get("answers")
            if not isinstance(answers, dict) or authorization.question_id not in answers:
                continue
            answer = answers[authorization.question_id]
            if isinstance(answer, Mapping):
                answer = answer.get("answers")
            policy = authorization_policy(authorization.authorization_type)
            if answer in (policy.authorize, [policy.authorize], policy.reject, [policy.reject]):
                return hil.decision
        return None

    def _has_hil(self, authorization: FulltextAuthorization) -> bool:
        return any(
            any(
                isinstance(question, dict) and question.get("id") == authorization.question_id
                for question in hil.payload.get("questions", [])
            )
            for hil in self._catalog.turn_hil(authorization.session_id, authorization.turn_id)
        )

    def pending(self, authorization: FulltextAuthorization) -> bool:
        return any(
            hil.status is HilStatus.PENDING
            and any(
                isinstance(question, dict) and question.get("id") == authorization.question_id
                for question in hil.payload.get("questions", [])
            )
            for hil in self._catalog.turn_hil(authorization.session_id, authorization.turn_id)
        )

    def _granted_decision(self, authorization: FulltextAuthorization) -> Mapping[str, Any] | None:
        decision = self._resolved_decision(authorization)
        if decision is None:
            return None
        if decision_disposition(authorization, decision) is not AuthorizationDisposition.AUTHORIZED:
            return None
        return decision

    def _is_granted(self, authorization: FulltextAuthorization) -> bool:
        return self._granted_decision(authorization) is not None

    def decided(self, authorization: FulltextAuthorization) -> bool:
        """Whether the user already answered this challenge, allow or refuse."""

        return self._resolved_decision(authorization) is not None

    def granted(self, authorization: FulltextAuthorization) -> bool:
        """Return whether this exact persisted challenge has a durable allow."""

        return self._is_granted(authorization)

    def granted_refs(self, authorization: FulltextAuthorization) -> tuple[str, ...]:
        """The durable allow's effective source set, derived from its decision.

        The ledger row always keeps the candidate set it was challenged with; the
        subset the user actually picked lives only in the decision values, so a
        grant never widens beyond its challenge and never needs a schema change.
        """

        decision = self._granted_decision(authorization)
        if decision is None:
            return ()
        return derive_granted_scope(authorization, decision)

    def turn_granted_refs(
        self,
        *,
        session_id: str,
        snapshot_id: str,
        turn_id: str,
        authorization_type: str,
        refs: tuple[str, ...],
        client_turn_id: str = "",
        task_context: FulltextTaskContext | None = None,
    ) -> tuple[str, ...]:
        """The refs this verified execution scope may use, exactly as `require` allows."""

        return self.effective_scope(
            session_id=session_id,
            snapshot_id=snapshot_id,
            turn_id=turn_id,
            authorization_type=authorization_type,
            client_turn_id=client_turn_id,
            refs=refs,
            task_context=task_context,
        ).allowed

    @staticmethod
    def _record(row: sqlite3.Row) -> FulltextAuthorization:
        refs = json.loads(str(row["scope_json"]))
        return FulltextAuthorization(
            authorization_id=str(row["authorization_id"]),
            session_id=str(row["session_id"]),
            snapshot_id=str(row["snapshot_id"]),
            turn_id=str(row["turn_id"]),
            authorization_type=str(row["authorization_type"]),
            refs=tuple(str(ref) for ref in refs),
            scope_digest=str(row["scope_digest"]),
            question_id=str(row["question_id"]),
            state=AuthorizationState(str(row["state"])),
            created_at=float(row["created_at"]),
            task_key=str(row[TASK_KEY_COLUMN]),
        )


async def authorize_sources(
    live: Any,
    authorizer: FulltextAuthorizer,
    *,
    turn_id: str,
    snapshot_id: str,
    authorization_type: str,
    refs: tuple[str, ...],
    papers: tuple[Mapping[str, str], ...] = (),
    task_context: FulltextTaskContext | None = None,
    activity: ActivityLease | None = None,
) -> tuple[FulltextAuthorization, AuthorizationDisposition, Mapping[str, Any] | None]:
    """Ask only for undecided refs in the verified task or current turn.

    Returns the challenge, its disposition and the new decision when the user was asked now.
    """

    scope = authorizer.effective_scope(
        session_id=live.id,
        snapshot_id=snapshot_id,
        turn_id=turn_id,
        authorization_type=authorization_type,
        refs=refs,
        client_turn_id=getattr(live, "active_product_turn_id", ""),
        task_context=task_context,
    )
    if not scope.unknown:
        challenge = next(item for item in scope.authorizations if set(item.refs) & set(refs))
        disposition = (
            AuthorizationDisposition.AUTHORIZED
            if scope.allowed
            else AuthorizationDisposition.REJECTED
        )
        return challenge, disposition, None
    challenge = authorizer.prepare(
        session_id=live.id,
        snapshot_id=snapshot_id,
        turn_id=turn_id,
        authorization_type=authorization_type,
        refs=scope.unknown,
        task_context=task_context,
    )
    question = authorization_question(challenge, papers)
    reference = await live.component_for(
        (
            PLUGIN_SELECTION_SLOT
            if authorization_policy(authorization_type).subset_selection
            else PLUGIN_AUTHORIZATION_SLOT
        ),
        interaction_id=str(question["id"]),
    )
    if reference is not None:
        question["component"] = reference
        question["component_data"] = {
            "papers": [dict(paper) for paper in papers if paper.get("id") in challenge.refs],
            "scope_count": len(challenge.refs),
        }
    decision = await live.interactions.request_product_input(
        question, turn_id=challenge.turn_id, activity=activity
    )
    scope = authorizer.effective_scope(
        session_id=live.id,
        snapshot_id=snapshot_id,
        turn_id=turn_id,
        authorization_type=authorization_type,
        refs=refs,
        client_turn_id=getattr(live, "active_product_turn_id", ""),
        task_context=task_context,
    )
    disposition = (
        AuthorizationDisposition.AUTHORIZED if scope.allowed else AuthorizationDisposition.REJECTED
    )
    return challenge, disposition, decision


def decision_disposition(
    authorization: FulltextAuthorization, decision: Mapping[str, Any]
) -> AuthorizationDisposition:
    """Only the exact product authorize option for this challenge allows full text.

    The question is single-choice: a missing, cancelled, multi-valued or unknown answer is
    a rejection, so any unexpected decision shape fails closed.
    """

    policy = authorization_policy(authorization.authorization_type)
    answers = decision.get("answers")
    answer = answers.get(authorization.question_id) if isinstance(answers, Mapping) else None
    if isinstance(answer, Mapping):
        answer = answer.get("answers")
    return (
        AuthorizationDisposition.AUTHORIZED
        if answer == policy.authorize or answer == [policy.authorize]
        else AuthorizationDisposition.REJECTED
    )


def derive_granted_scope(
    authorization: FulltextAuthorization, decision: Mapping[str, Any]
) -> tuple[str, ...]:
    """Effective source set of one durable allow, derived without touching the row.

    Subset-capable policies read ``values.selected_paper_ids``; a missing value keeps
    the challenged candidate set (legacy clients), while a malformed or oversized
    selection fails closed to the empty set.
    """

    policy = authorization_policy(authorization.authorization_type)
    if decision_disposition(authorization, decision) is not AuthorizationDisposition.AUTHORIZED:
        return ()
    if not policy.subset_selection:
        return authorization.refs
    values = decision.get("values")
    if not isinstance(values, Mapping):
        return authorization.refs
    selected = values.get(SELECTED_PAPER_IDS_KEY)
    if selected is None:
        return authorization.refs
    if not isinstance(selected, list) or any(
        not isinstance(ref, str) or not ref for ref in selected
    ):
        return ()
    allowed = frozenset(authorization.refs)
    scope = tuple(ref for ref in selected if ref in allowed)
    return scope if len(scope) == len(set(selected)) else ()


def authorization_question(
    authorization: FulltextAuthorization,
    papers: tuple[Mapping[str, str], ...] = (),
) -> dict[str, object]:
    policy = authorization_policy(authorization.authorization_type)
    question: dict[str, object] = {
        "id": authorization.question_id,
        "header": policy.header,
        "question": policy.question,
        "options": [
            {
                "label": f"{policy.authorize} (Recommended)",
                "description": AUTHORIZE_DESCRIPTION,
            },
            {"label": policy.reject, "description": REJECT_DESCRIPTION},
        ],
    }
    if policy.subset_selection and papers:
        allowed = frozenset(authorization.refs)
        question["papers"] = [
            {
                "id": str(paper.get("id") or ""),
                "label": str(paper.get("label") or ""),
                "description": str(paper.get("description") or ""),
            }
            for paper in papers
            if str(paper.get("id") or "") in allowed
        ]
    return question


__all__ = [
    "AUTHORIZATION_REQUIRED",
    "SELECTED_PAPER_IDS_KEY",
    "AuthorizationDisposition",
    "FULLTEXT_AUTHORIZATION_POLICIES",
    "FulltextAuthorization",
    "FulltextAuthorizationPolicy",
    "FulltextAuthorizer",
    "derive_granted_scope",
    "LITERATURE_REVIEW_AUTHORIZATION_HEADER",
    "LITERATURE_REVIEW_AUTHORIZATION_QUESTION",
    "LITERATURE_REVIEW_FULLTEXT",
    "PRECISE_SEARCH_AUTHORIZATION_HEADER",
    "PRECISE_SEARCH_AUTHORIZATION_QUESTION",
    "PRECISE_SEARCH_FULLTEXT",
    "RESEARCH_IDEA_AUTHORIZATION_HEADER",
    "RESEARCH_IDEA_AUTHORIZATION_QUESTION",
    "RESEARCH_IDEA_AUTHORIZE",
    "RESEARCH_IDEA_AUTHORIZE_RECOMMENDED",
    "RESEARCH_IDEA_FULLTEXT",
    "RESEARCH_IDEA_REJECT",
    "authorization_policy",
    "authorization_question",
    "authorize_sources",
    "decision_disposition",
    "task_authorization_policy",
]
