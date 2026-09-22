"""Task- and source-scoped authorization for model-visible full text."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import uuid
from contextlib import closing
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Mapping

from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SQLITE_TIMEOUT_SECONDS,
    HilStatus,
    SessionCatalogStore,
)
from service.platform.context import ProductTaskType

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


class FulltextAuthorizer:
    """Persist challenges and derive grants only from confirmed durable HIL answers."""

    def __init__(self, database: Path, catalog: SessionCatalogStore) -> None:
        self._database = database
        self._catalog = catalog
        with closing(self._connect()) as connection, connection:
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
            if CONTINUATION_TURN_COLUMN not in columns:
                connection.execute(
                    f"ALTER TABLE {FULLTEXT_AUTHORIZATION_TABLE} "
                    f"ADD COLUMN {CONTINUATION_TURN_COLUMN} TEXT NOT NULL DEFAULT ''"
                )

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
    def _scope(refs: tuple[str, ...]) -> tuple[tuple[str, ...], str, str]:
        canonical = tuple(sorted(set(ref.strip() for ref in refs if ref.strip())))
        if not canonical:
            raise ValueError("fulltext_authorization_scope_required")
        encoded = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"))
        return canonical, encoded, hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def prepare(
        self,
        *,
        session_id: str,
        snapshot_id: str,
        turn_id: str,
        authorization_type: str,
        refs: tuple[str, ...],
    ) -> FulltextAuthorization:
        policy = authorization_policy(authorization_type)
        if not session_id or not snapshot_id or not turn_id:
            raise ValueError("fulltext_authorization_scope_unavailable")
        canonical, encoded, scope_digest = self._scope(refs)
        timestamp = time.time()
        authorization_id = uuid.uuid4().hex
        question_id = policy.question_prefix + authorization_id
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                f"""
                UPDATE {FULLTEXT_AUTHORIZATION_TABLE}
                SET state = ?
                WHERE session_id = ? AND snapshot_id = ? AND turn_id = ?
                  AND authorization_type = ? AND scope_digest <> ? AND state = ?
                """,
                (
                    AuthorizationState.SUPERSEDED.value,
                    session_id,
                    snapshot_id,
                    turn_id,
                    authorization_type,
                    scope_digest,
                    AuthorizationState.PENDING.value,
                ),
            )
            connection.execute(
                f"""
                INSERT INTO {FULLTEXT_AUTHORIZATION_TABLE} (
                    authorization_id, session_id, snapshot_id, turn_id,
                    authorization_type, scope_json, scope_digest, question_id,
                    state, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    ) -> None:
        """Allow one ref only through a durable grant of this turn or its product continuation."""

        authorization_policy(authorization_type)
        with closing(self._connect()) as connection, connection:
            rows = connection.execute(
                f"""
                SELECT * FROM {FULLTEXT_AUTHORIZATION_TABLE}
                WHERE session_id = ? AND state = ?
                  AND ((snapshot_id = ? AND turn_id = ?)
                       OR ({CONTINUATION_TURN_COLUMN} <> '' AND {CONTINUATION_TURN_COLUMN} = ?))
                ORDER BY created_at DESC
                """,
                (
                    session_id,
                    AuthorizationState.PENDING.value,
                    snapshot_id,
                    turn_id,
                    client_turn_id,
                ),
            ).fetchall()
        authorizations = tuple(self._record(row) for row in rows)
        for authorization in authorizations:
            if authorization.authorization_type != authorization_type:
                continue
            if ref_id not in authorization.refs:
                continue
            if self._is_granted(authorization):
                return
        raise ValueError(AUTHORIZATION_REQUIRED)

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

    def _is_granted(self, authorization: FulltextAuthorization) -> bool:
        policy = authorization_policy(authorization.authorization_type)
        for hil in self._catalog.turn_hil(authorization.session_id, authorization.turn_id):
            if hil.status is not HilStatus.RESOLVED or not hil.decision:
                continue
            questions = hil.payload.get("questions")
            if not isinstance(questions, list) or not any(
                isinstance(question, dict) and question.get("id") == authorization.question_id
                for question in questions
            ):
                continue
            answers = hil.decision.get("answers")
            if not isinstance(answers, dict):
                continue
            answer = answers.get(authorization.question_id)
            values = answer.get("answers") if isinstance(answer, dict) else answer
            if values == policy.authorize or (
                isinstance(values, list) and values == [policy.authorize]
            ):
                return True
        return False

    def granted(self, authorization: FulltextAuthorization) -> bool:
        """Return whether this exact persisted challenge has a durable allow."""

        return self._is_granted(authorization)

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
        )


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


def authorization_question(authorization: FulltextAuthorization) -> dict[str, object]:
    policy = authorization_policy(authorization.authorization_type)
    return {
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


__all__ = [
    "AUTHORIZATION_REQUIRED",
    "AuthorizationDisposition",
    "FULLTEXT_AUTHORIZATION_POLICIES",
    "FulltextAuthorization",
    "FulltextAuthorizationPolicy",
    "FulltextAuthorizer",
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
    "decision_disposition",
    "task_authorization_policy",
]
