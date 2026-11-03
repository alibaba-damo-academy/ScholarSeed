"""Private SQLite snapshots interpreted by the signed Desktop history owner.

Serve supplies qualified SQLite transport, never a second browser schema codec.
Only the verified Desktop reader supplies migration SQL and row-query contracts.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from service.cli.desktop_inspection import run_desktop_reader
from service.persistence.preview import (
    DatabasePreview,
    SchemaOwner,
    decode_previews,
    preview_database,
    projected_database,
)
from service.persistence.rows import rows_digest
from service.platform.domains import DataInspection, DomainChangedError

HISTORY_NAME = "browser-history"
HISTORY_DIRECTORY = "browser"
HISTORY_FILE = "history.sqlite3"
MAX_HISTORY_BATCH_ROWS = 1024
MAX_HISTORY_BATCH_BYTES = 1024 * 1024


def split_history_candidates(value: object) -> tuple[tuple[DatabasePreview, ...], list[dict]]:
    """Separate Desktop coverage while retaining the core private wire contract."""
    decoded = decode_previews(value)
    assert isinstance(value, list)  # Established by the closed decoder.
    history = tuple(row for row in decoded if row.name == HISTORY_NAME)
    if len(history) != 1:
        raise ValueError("Desktop history compatibility coverage differs")
    # asdict keeps tuple fields; feeding those back to the closed JSON decoder
    # would reject valid owners/row_readers. Preserve the validated wire values.
    return history, [row for row in value if row["name"] != HISTORY_NAME]


def history_directory(reader: DataInspection, home: Path) -> Path | None:
    """Discover only an existing directory while the home remains qualified."""
    kind = reader.entry_kind(str(home), HISTORY_DIRECTORY)
    if kind is None:
        return None
    if kind != "directory":
        raise ValueError("browser history parent is not a directory")
    return home / HISTORY_DIRECTORY


@dataclass(frozen=True)
class HistorySchema:
    needs_write: bool
    statements: tuple[str, ...]
    rows_query: str


def _call(mode: str, value: object) -> dict:
    raw = run_desktop_reader({"version": 1, "owner": HISTORY_NAME, "mode": mode, "value": value})
    report = json.loads(raw)
    if (
        not isinstance(report, dict)
        or not isinstance(report.get("version"), int)
        or isinstance(report.get("version"), bool)
        or report["version"] != 1
    ):
        raise ValueError("invalid Desktop history report")
    return report


def inspect_schema(connection: sqlite3.Connection) -> HistorySchema:
    rows = connection.execute(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    report = _call("schema", [dict(zip(("kind", "name", "tableName", "sql"), row)) for row in rows])
    if (
        set(report) != {"version", "needsWrite", "statements", "rowsQuery"}
        or not isinstance(report["needsWrite"], bool)
        or not isinstance(report["statements"], list)
        or not report["statements"]
        or any(not isinstance(sql, str) or not sql for sql in report["statements"])
        or not isinstance(report["rowsQuery"], str)
        or not report["rowsQuery"]
    ):
        raise ValueError("invalid Desktop history schema contract")
    return HistorySchema(report["needsWrite"], tuple(report["statements"]), report["rowsQuery"])


def initialize_schema(connection: sqlite3.Connection) -> None:
    for statement in inspect_schema(connection).statements:
        connection.execute(statement)


def inspect_rows(connection: sqlite3.Connection) -> None:
    state = inspect_schema(connection)
    cursor = connection.execute(state.rows_query)
    names = [item[0] for item in cursor.description]
    batch: list[dict[str, Any]] = []
    size = 0

    def verify() -> None:
        report = _call("rows", batch)
        if (
            set(report) != {"version", "count"}
            or not isinstance(report["count"], int)
            or isinstance(report["count"], bool)
            or report["count"] != len(batch)
        ):
            raise ValueError("Desktop history row coverage differs")

    for row in cursor:
        value = dict(zip(names, row))
        length = len(json.dumps(value, ensure_ascii=True).encode("ascii"))
        if length > MAX_HISTORY_BATCH_BYTES:
            raise ValueError("Desktop history row exceeds budget")
        if batch and (
            len(batch) >= MAX_HISTORY_BATCH_ROWS or size + length > MAX_HISTORY_BATCH_BYTES
        ):
            verify()
            batch, size = [], 0
        batch.append(value)
        size += length
    verify()


HISTORY_OWNERS = (SchemaOwner(HISTORY_NAME, inspect_schema, initialize_schema, inspect_rows),)


def export_history(reader: DataInspection, home: Path, wanted, emit) -> None:
    directory = history_directory(reader, home)
    scope: AbstractContextManager[str | None]
    if directory is None:
        scope = nullcontext()
        database = None
    else:
        scope = reader.inspection(str(directory))
        database = directory / HISTORY_FILE
    with (
        scope,
        projected_database(database, HISTORY_NAME, HISTORY_OWNERS) as (
            preview,
            connection,
            deadline,
        ),
    ):
        if preview != wanted:
            raise DomainChangedError("browser history changed before row export")
        if rows_digest(connection, deadline=deadline, emit=emit) != wanted.rows_digest:
            raise DomainChangedError("browser history changed during row export")


def preview_history(reader: DataInspection, home: Path):
    directory = history_directory(reader, home)
    if directory is None:
        return preview_database(None, HISTORY_NAME, HISTORY_OWNERS)
    if not reader.selected(str(directory)):
        raise DomainChangedError("browser history root is not qualified")
    with reader.inspection(str(directory)):
        return preview_database(directory / HISTORY_FILE, HISTORY_NAME, HISTORY_OWNERS)
