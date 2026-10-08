"""Managed full-text objects acquired on behalf of authorized precise searches.

Acquisition-side PEP (proposal 116 G1): bytes fetched by serve live in the managed
store, and this table is the only map from an authorization ``paper:`` ref to those
bytes. Reading stays behind ``FulltextAuthorizer.require``; the table grants
nothing by itself.
"""

from __future__ import annotations

import sqlite3
import time
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


def ensure_fulltext_schema(connection: sqlite3.Connection) -> None:
    connection.execute(FULLTEXT_OBJECTS_DDL)


def record_fulltext_object(connection: sqlite3.Connection, obj: FulltextObject) -> None:
    connection.execute(
        f"INSERT OR REPLACE INTO {FULLTEXT_OBJECTS_TABLE}"
        " (paper_id, object_name, title, revision, source_kind, acquired_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (
            obj.paper_id,
            obj.object_name,
            obj.title,
            obj.revision,
            obj.source_kind,
            obj.acquired_at,
        ),
    )


def find_fulltext_object(paper_id: str) -> FulltextObject | None:
    with connect() as connection:
        ensure_fulltext_schema(connection)
        row = connection.execute(
            f"SELECT paper_id, object_name, title, revision, source_kind, acquired_at"
            f" FROM {FULLTEXT_OBJECTS_TABLE} WHERE paper_id = ?",
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
    )


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
