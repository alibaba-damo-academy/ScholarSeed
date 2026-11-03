"""Durable idempotency and safe results for non-session Assistant actions."""

from __future__ import annotations

import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass, replace
from pathlib import Path

from service.assistant.persistence.utils import extensions
from service.chat.persistence.catalog import SQLITE_TIMEOUT_SECONDS
from service.persistence.project import (
    database_files,
    open_database,
    reader,
    reject_schema_residue,
    schema_transaction,
    sql_tokens,
    table_clauses,
)
from service.platform.inference import ModelInvocationStatus

ASSISTANT_INVOCATION_TABLE = "assistant_model_invocation"
INVOCATION_COLUMNS = (
    "invocation_id",
    "owner_id",
    "client_action_id",
    "client_attempt_id",
    "retry_of_attempt_id",
    "kind",
    "request_hash",
    "project_id",
    "source_id",
    "source_revision",
    "prompt_version",
    "status",
    "target_language",
    "detected_source_language",
    "model_key",
    "output_text",
    "error_code",
    "error_detail",
    "input_tokens",
    "output_tokens",
    "receipt_id",
    "created_at",
    "updated_at",
)


class AssistantInvocationConflictError(RuntimeError):
    """A client attempt id was reused with a different immutable request."""


@dataclass(frozen=True)
class AssistantInvocationRecord:
    """Safe product projection of one model attempt; no prompt, source text, or JWT."""

    invocation_id: str
    owner_id: str
    client_action_id: str
    client_attempt_id: str
    retry_of_attempt_id: str | None
    kind: str
    request_hash: str
    project_id: str
    source_id: str
    source_revision: str | None
    prompt_version: str
    status: ModelInvocationStatus
    target_language: str
    detected_source_language: str = ""
    model_key: str = ""
    output_text: str = ""
    error_code: str = ""
    error_detail: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    receipt_id: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0


@dataclass(frozen=True)
class InvocationSchema:
    """Owner initialization requirements, not whole-database admission."""

    create_table: bool
    create_index: bool

    @property
    def needs_write(self) -> bool:
        return self.create_table or self.create_index


class AssistantInvocationStore:
    """Own the non-Session action table inside the product aggregate database."""

    def __init__(self, database: Path) -> None:
        self._database = database
        if not self.inspect_schema(self._database).needs_write:
            return
        with closing(self._connect()) as connection, schema_transaction(connection):
            self.initialize_schema(connection)

    @classmethod
    def initialize_schema(cls, connection: sqlite3.Connection) -> None:
        """Apply owned startup migrations inside the caller's transaction.

        Uses the same code for qualified startup and isolated compatibility
        projection; this method neither opens files nor grants write access.
        """
        if cls.inspect_connection(connection).needs_write:
            cls._create_table(connection)
        if cls.inspect_connection(connection).needs_write:
            raise RuntimeError("initialization did not reach supported format")

    @classmethod
    def inspect_schema(cls, database: Path) -> InvocationSchema:
        """Read a guarded WAL snapshot; callers retain directory qualification.

        SQLite can touch SHM. This is neither atomic VFS binding nor row validation.
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
    def inspect_connection(cls, connection: sqlite3.Connection) -> InvocationSchema:
        reject_schema_residue(connection, (ASSISTANT_INVOCATION_TABLE,))
        objects = {
            row["name"]: row
            for row in connection.execute("SELECT name,type,tbl_name,sql FROM sqlite_master")
        }
        with closing(sqlite3.connect(":memory:")) as reference:
            cls._create_table(reference)
            expected = reference.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (ASSISTANT_INVOCATION_TABLE,)
            ).fetchone()[0]
            actual = objects.get(ASSISTANT_INVOCATION_TABLE)
            if actual is not None:
                try:
                    known = {
                        row[1]
                        for row in reference.execute(
                            f"PRAGMA table_xinfo({ASSISTANT_INVOCATION_TABLE})"
                        )
                    }
                    extra = extensions(connection, ASSISTANT_INVOCATION_TABLE, known)
                    valid = actual["type"] == "table" and tuple(
                        clause
                        for clause in table_clauses(actual["sql"], ASSISTANT_INVOCATION_TABLE)
                        if clause[0] not in extra
                    ) == table_clauses(expected, ASSISTANT_INVOCATION_TABLE)
                except ValueError as error:
                    raise RuntimeError("unsupported invocations table definition") from error
                if not valid:
                    raise RuntimeError("unsupported invocations table definition")
            name, definition = reference.execute(
                "SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
            ).fetchone()
            owned_index = objects.get(name)
            if owned_index is not None and (
                owned_index["type"] != "index"
                or owned_index["tbl_name"] != ASSISTANT_INVOCATION_TABLE
                or sql_tokens(owned_index["sql"]) != sql_tokens(definition)
            ):
                raise RuntimeError("unsupported invocation owned index")
            return InvocationSchema(actual is None, owned_index is None)

    def _connect(self) -> sqlite3.Connection:
        connection = open_database(
            str(self._database),
            check_same_thread=False,
            timeout=SQLITE_TIMEOUT_SECONDS,
            isolation_level=None,
        )
        try:
            connection.row_factory = sqlite3.Row
            return connection
        except BaseException:
            connection.close()
            raise

    @staticmethod
    def _create_table(connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {ASSISTANT_INVOCATION_TABLE} (
                invocation_id TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                client_action_id TEXT NOT NULL,
                client_attempt_id TEXT NOT NULL,
                retry_of_attempt_id TEXT,
                kind TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                project_id TEXT NOT NULL,
                source_id TEXT NOT NULL,
                source_revision TEXT,
                prompt_version TEXT NOT NULL,
                status TEXT NOT NULL,
                target_language TEXT NOT NULL,
                detected_source_language TEXT NOT NULL DEFAULT '',
                model_key TEXT NOT NULL DEFAULT '',
                output_text TEXT NOT NULL DEFAULT '',
                error_code TEXT NOT NULL DEFAULT '',
                error_detail TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                receipt_id TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE(owner_id, client_attempt_id)
            )
            """)
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{ASSISTANT_INVOCATION_TABLE}_owner_updated "
            f"ON {ASSISTANT_INVOCATION_TABLE}(owner_id, updated_at DESC)"
        )

    @classmethod
    def inspect_rows(cls, connection: sqlite3.Connection) -> None:
        """Use the normal invocation decoder on every projected record."""
        for row in connection.execute(f"SELECT * FROM {ASSISTANT_INVOCATION_TABLE}"):
            cls._record(row)

    @staticmethod
    def _record(row: sqlite3.Row) -> AssistantInvocationRecord:
        return AssistantInvocationRecord(
            invocation_id=str(row["invocation_id"]),
            owner_id=str(row["owner_id"]),
            client_action_id=str(row["client_action_id"]),
            client_attempt_id=str(row["client_attempt_id"]),
            retry_of_attempt_id=(
                str(row["retry_of_attempt_id"]) if row["retry_of_attempt_id"] else None
            ),
            kind=str(row["kind"]),
            request_hash=str(row["request_hash"]),
            project_id=str(row["project_id"]),
            source_id=str(row["source_id"]),
            source_revision=(str(row["source_revision"]) if row["source_revision"] else None),
            prompt_version=str(row["prompt_version"]),
            status=ModelInvocationStatus(str(row["status"])),
            target_language=str(row["target_language"]),
            detected_source_language=str(row["detected_source_language"]),
            model_key=str(row["model_key"]),
            output_text=str(row["output_text"]),
            error_code=str(row["error_code"]),
            error_detail=str(row["error_detail"]),
            input_tokens=int(row["input_tokens"]),
            output_tokens=int(row["output_tokens"]),
            receipt_id=str(row["receipt_id"]),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
        )

    def claim(self, record: AssistantInvocationRecord) -> tuple[AssistantInvocationRecord, bool]:
        """Create an attempt or return the exact existing attempt without re-executing it."""

        now = record.created_at or time.time()
        candidate = replace(record, created_at=now, updated_at=record.updated_at or now)
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute(
                    f"""
                    SELECT * FROM {ASSISTANT_INVOCATION_TABLE}
                    WHERE owner_id = ? AND client_attempt_id = ?
                    """,
                    (candidate.owner_id, candidate.client_attempt_id),
                ).fetchone()
                if row is not None:
                    existing = self._record(row)
                    if existing.request_hash != candidate.request_hash:
                        raise AssistantInvocationConflictError(
                            "assistant action attempt id was reused"
                        )
                    connection.execute("COMMIT")
                    return existing, False
                connection.execute(
                    f"""
                    INSERT INTO {ASSISTANT_INVOCATION_TABLE} ({", ".join(INVOCATION_COLUMNS)})
                    VALUES ({", ".join("?" for _ in INVOCATION_COLUMNS)})
                    """,
                    (
                        candidate.invocation_id,
                        candidate.owner_id,
                        candidate.client_action_id,
                        candidate.client_attempt_id,
                        candidate.retry_of_attempt_id,
                        candidate.kind,
                        candidate.request_hash,
                        candidate.project_id,
                        candidate.source_id,
                        candidate.source_revision,
                        candidate.prompt_version,
                        candidate.status.value,
                        candidate.target_language,
                        candidate.detected_source_language,
                        candidate.model_key,
                        candidate.output_text,
                        candidate.error_code,
                        candidate.error_detail,
                        candidate.input_tokens,
                        candidate.output_tokens,
                        candidate.receipt_id,
                        candidate.created_at,
                        candidate.updated_at,
                    ),
                )
                connection.execute("COMMIT")
                return candidate, True
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def save(self, record: AssistantInvocationRecord) -> AssistantInvocationRecord:
        """Persist the latest safe status for one already-claimed attempt."""

        updated = replace(record, updated_at=time.time())
        with closing(self._connect()) as connection, connection:
            changed = connection.execute(
                f"""
                UPDATE {ASSISTANT_INVOCATION_TABLE}
                SET status = ?, detected_source_language = ?, model_key = ?, output_text = ?,
                    error_code = ?, error_detail = ?, input_tokens = ?, output_tokens = ?,
                    receipt_id = ?, updated_at = ?
                WHERE invocation_id = ? AND owner_id = ?
                """,
                (
                    updated.status.value,
                    updated.detected_source_language,
                    updated.model_key,
                    updated.output_text,
                    updated.error_code,
                    updated.error_detail,
                    updated.input_tokens,
                    updated.output_tokens,
                    updated.receipt_id,
                    updated.updated_at,
                    updated.invocation_id,
                    updated.owner_id,
                ),
            ).rowcount
        if changed != 1:
            raise LookupError("assistant invocation not found")
        return updated

    def get(self, invocation_id: str, owner_id: str) -> AssistantInvocationRecord | None:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"""
                SELECT * FROM {ASSISTANT_INVOCATION_TABLE}
                WHERE invocation_id = ? AND owner_id = ?
                """,
                (invocation_id, owner_id),
            ).fetchone()
        return self._record(row) if row is not None else None

    def get_attempt(
        self, client_attempt_id: str, owner_id: str
    ) -> AssistantInvocationRecord | None:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"""
                SELECT * FROM {ASSISTANT_INVOCATION_TABLE}
                WHERE client_attempt_id = ? AND owner_id = ?
                """,
                (client_attempt_id, owner_id),
            ).fetchone()
        return self._record(row) if row is not None else None


__all__ = [
    "ASSISTANT_INVOCATION_TABLE",
    "AssistantInvocationConflictError",
    "AssistantInvocationRecord",
    "AssistantInvocationStore",
]
