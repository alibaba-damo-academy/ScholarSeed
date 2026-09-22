"""Validation shared by stores composing one session transaction."""

import sqlite3
from pathlib import Path


def validate_transaction(connection: sqlite3.Connection, database: Path) -> None:
    """Reject accidental cross-database or autocommit composition."""
    databases = connection.execute("PRAGMA database_list").fetchall()
    main = next((row[2] for row in databases if row[1] == "main"), "")
    if not connection.in_transaction or not main or Path(main).resolve() != database.resolve():
        raise ValueError(
            "session transaction must use the store database and an active transaction"
        )
