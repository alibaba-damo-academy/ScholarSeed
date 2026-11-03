"""Immutable, turn-bound receipts for PDF fragments delivered through the bridge."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from service.assistant.persistence.store import ASSISTANT_SNAPSHOT_TABLE
from service.assistant.persistence.utils import extend, extensions
from service.chat.persistence.catalog import SQLITE_TIMEOUT_SECONDS
from service.persistence.project import (
    database_files,
    open_database,
    reader,
    rebuild_table,
    reject_schema_residue,
    schema_transaction,
    table_clauses,
)

CITATIONS_TABLE = "assistant_pdf_citations"


@dataclass(frozen=True)
class CitationSchema:
    """Owner initialization requirements, not whole-database admission."""

    create_table: bool
    repair_foreign_key: bool

    @property
    def needs_write(self) -> bool:
        return self.create_table or self.repair_foreign_key


class CitationStore:
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
        schema = cls.inspect_connection(connection)
        if schema.create_table:
            cls._create_table(connection)
        if schema.repair_foreign_key:
            with closing(sqlite3.connect(":memory:")) as reference:
                cls._create_table(reference)
                known = {
                    row[1] for row in reference.execute(f"PRAGMA table_xinfo({CITATIONS_TABLE})")
                }
            extra = extensions(connection, CITATIONS_TABLE, known)

            def create(target: sqlite3.Connection, temporary: str) -> None:
                cls._create_table(target, temporary)
                extend(target, temporary, extra)

            rebuild_table(connection, CITATIONS_TABLE, create)
        if cls.inspect_connection(connection).needs_write:
            raise RuntimeError("initialization did not reach supported format")

    @classmethod
    def inspect_schema(cls, database: Path) -> CitationSchema:
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
    def inspect_connection(cls, connection: sqlite3.Connection) -> CitationSchema:
        reject_schema_residue(connection, (CITATIONS_TABLE,))
        objects = {
            row["name"]: row
            for row in connection.execute("SELECT name,type,tbl_name,sql FROM sqlite_master")
        }
        with closing(sqlite3.connect(":memory:")) as reference:
            cls._create_table(reference)
            expected = reference.execute(
                "SELECT sql FROM sqlite_master WHERE name=?", (CITATIONS_TABLE,)
            ).fetchone()[0]
            actual = objects.get(CITATIONS_TABLE)
            repair = False
            if actual is not None:
                try:
                    if actual["type"] != "table":
                        raise ValueError("not a table")
                    clauses = table_clauses(actual["sql"], CITATIONS_TABLE)
                    known = {
                        row[1]
                        for row in reference.execute(f"PRAGMA table_xinfo({CITATIONS_TABLE})")
                    }
                    extra = extensions(connection, CITATIONS_TABLE, known)
                    normalized = []
                    for clause in clauses:
                        if clause[0] in extra:
                            continue
                        resolved = clause
                        if clause[:2] == ("foreign", "key") and "references" in clause:
                            position = clause.index("references") + 1
                            if clause[position] == ASSISTANT_SNAPSHOT_TABLE + "_migration":
                                resolved = (
                                    *clause[:position],
                                    ASSISTANT_SNAPSHOT_TABLE,
                                    *clause[position + 1 :],
                                )
                                repair = True
                        normalized.append(resolved)
                    valid = tuple(normalized) == table_clauses(expected, CITATIONS_TABLE)
                except ValueError as error:
                    raise RuntimeError("unsupported citations table definition") from error
                if not valid:
                    raise RuntimeError("unsupported citations table definition")
            return CitationSchema(actual is None, repair)

    def _connect(self) -> sqlite3.Connection:
        connection = open_database(str(self._database), timeout=SQLITE_TIMEOUT_SECONDS)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            return connection
        except BaseException:
            connection.close()
            raise

    @staticmethod
    def _create_table(connection: sqlite3.Connection, table: str = CITATIONS_TABLE) -> None:
        connection.execute(
            f"CREATE TABLE IF NOT EXISTS {table} (handle TEXT PRIMARY KEY, session_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, source_key TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(session_id,snapshot_id,source_key), FOREIGN KEY(snapshot_id) REFERENCES {ASSISTANT_SNAPSHOT_TABLE}(snapshot_id) ON DELETE CASCADE)"
        )

    def record(self, session_id: str, snapshot_id: str, source_key: str, payload: dict) -> dict:
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    f"INSERT OR IGNORE INTO {CITATIONS_TABLE} (handle, session_id, snapshot_id, source_key, payload) VALUES (?,?,?,?,?)",
                    (
                        payload["handle"],
                        session_id,
                        snapshot_id,
                        source_key,
                        json.dumps(payload, ensure_ascii=False),
                    ),
                )
                row = connection.execute(
                    f"SELECT payload FROM {CITATIONS_TABLE} WHERE session_id=? AND snapshot_id=? AND source_key=?",
                    (session_id, snapshot_id, source_key),
                ).fetchone()
            return self._payload(row)
        finally:
            connection.close()

    def get(self, session_id: str, snapshot_id: str, handle: str) -> dict | None:
        connection = self._connect()
        try:
            row = connection.execute(
                f"SELECT payload FROM {CITATIONS_TABLE} WHERE session_id=? AND snapshot_id=? AND handle=?",
                (session_id, snapshot_id, handle),
            ).fetchone()
            return self._payload(row) if row else None
        finally:
            connection.close()

    def handles(self, session_id: str, snapshot_id: str) -> tuple[str, ...]:
        connection = self._connect()
        try:
            rows = connection.execute(
                f"SELECT handle FROM {CITATIONS_TABLE} WHERE session_id=? AND snapshot_id=?",
                (session_id, snapshot_id),
            ).fetchall()
            return tuple(str(row[0]) for row in rows)
        finally:
            connection.close()

    @staticmethod
    def _payload(row: sqlite3.Row) -> dict:
        return json.loads(row["payload"])

    @classmethod
    def inspect_rows(cls, connection: sqlite3.Connection) -> None:
        """Use the same receipt reader without following external PDF handles."""
        for row in connection.execute(f"SELECT payload FROM {CITATIONS_TABLE}"):
            cls._payload(row)
