"""Validation shared by stores composing one session transaction."""

import sqlite3
from pathlib import Path

SQLITE_PRIMARY_CODE_MASK = 0xFF


class WriteBusy(RuntimeError):
    def __init__(self, database: Path, code: int) -> None:
        super().__init__("session write transaction has not acquired its lock")
        self.database = database
        self.code = code


def begin_write(connection: sqlite3.Connection, database: Path) -> None:
    if connection.in_transaction:
        raise ValueError("session write admission requires an idle connection")
    try:
        connection.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError as error:
        code = getattr(error, "sqlite_errorcode", None)
        if (
            isinstance(code, int)
            and code & SQLITE_PRIMARY_CODE_MASK == sqlite3.SQLITE_BUSY
            and not connection.in_transaction
        ):
            raise WriteBusy(database, code) from error
        raise


def validate_transaction(connection: sqlite3.Connection, database: Path) -> None:
    """Reject accidental cross-database or autocommit composition."""
    databases = connection.execute("PRAGMA database_list").fetchall()
    main = next((row[2] for row in databases if row[1] == "main"), "")
    if not connection.in_transaction or not main or Path(main).resolve() != database.resolve():
        raise ValueError(
            "session transaction must use the store database and an active transaction"
        )
