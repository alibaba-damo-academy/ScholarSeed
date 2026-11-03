"""Managed full-text objects acquired on behalf of authorized precise searches.

Acquisition-side PEP (proposal 116 G1): bytes fetched by serve live in the managed
store, and this table is the only map from an authorization ``paper:`` ref to those
bytes. Reading stays behind ``FulltextAuthorizer.require``; the table grants
nothing by itself.
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass

from service.literature.persistence.store import connect

FULLTEXT_OBJECTS_TABLE = "literature_fulltext_objects"

FULLTEXT_OBJECTS_DDL = f"""
CREATE TABLE IF NOT EXISTS {FULLTEXT_OBJECTS_TABLE} (
    paper_id TEXT PRIMARY KEY,
    object_name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    revision TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    acquired_at REAL NOT NULL
)
"""


@dataclass(frozen=True)
class FulltextObject:
    paper_id: str
    object_name: str
    revision: str
    source_kind: str
    acquired_at: float
    title: str = ""
    identifier_kind: str = ""
    identifier: str = ""


def ensure_fulltext_schema(connection: sqlite3.Connection) -> None:
    connection.execute(FULLTEXT_OBJECTS_DDL)
    columns = {
        row["name"] for row in connection.execute(f"PRAGMA table_info({FULLTEXT_OBJECTS_TABLE})")
    }
    for column in ("identifier_kind", "identifier"):
        if column not in columns:
            connection.execute(
                f"ALTER TABLE {FULLTEXT_OBJECTS_TABLE} ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"
            )


def record_fulltext_object(connection: sqlite3.Connection, obj: FulltextObject) -> None:
    connection.execute(
        f"INSERT OR REPLACE INTO {FULLTEXT_OBJECTS_TABLE}"
        " (paper_id, object_name, title, revision, source_kind, acquired_at, identifier_kind, identifier)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            obj.paper_id,
            obj.object_name,
            obj.title,
            obj.revision,
            obj.source_kind,
            obj.acquired_at,
            obj.identifier_kind,
            obj.identifier,
        ),
    )


def find_fulltext_object(paper_id: str) -> FulltextObject | None:
    with closing(connect()) as connection, connection:
        ensure_fulltext_schema(connection)
        row = connection.execute(
            f"SELECT *" f" FROM {FULLTEXT_OBJECTS_TABLE} WHERE paper_id = ?",
            (paper_id,),
        ).fetchone()
    if row is None:
        return None
    return FulltextObject(
        paper_id=row["paper_id"],
        object_name=row["object_name"],
        title=row["title"],
        revision=row["revision"],
        source_kind=row["source_kind"],
        acquired_at=row["acquired_at"],
        identifier_kind=row["identifier_kind"],
        identifier=row["identifier"],
    )


def fulltext_candidates() -> tuple[dict, ...]:
    with closing(connect()) as connection, connection:
        ensure_fulltext_schema(connection)
        rows = connection.execute(
            f"SELECT * FROM {FULLTEXT_OBJECTS_TABLE} ORDER BY acquired_at DESC"
        ).fetchall()
    return tuple(dict(row) for row in rows)


def acquired_at() -> float:
    return time.time()


__all__ = [
    "FULLTEXT_OBJECTS_DDL",
    "FULLTEXT_OBJECTS_TABLE",
    "FulltextObject",
    "acquired_at",
    "ensure_fulltext_schema",
    "find_fulltext_object",
    "record_fulltext_object",
]
