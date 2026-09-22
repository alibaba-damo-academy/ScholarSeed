"""Immutable, turn-bound receipts for PDF fragments delivered through the bridge."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from service.assistant.persistence.store import ASSISTANT_SNAPSHOT_TABLE
from service.chat.persistence.catalog import SQLITE_TIMEOUT_SECONDS

CITATIONS_TABLE = "assistant_pdf_citations"


class CitationStore:
    def __init__(self, database: Path) -> None:
        self._database = database
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    f"CREATE TABLE IF NOT EXISTS {CITATIONS_TABLE} (handle TEXT PRIMARY KEY, session_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, source_key TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(session_id,snapshot_id,source_key), FOREIGN KEY(snapshot_id) REFERENCES {ASSISTANT_SNAPSHOT_TABLE}(snapshot_id) ON DELETE CASCADE)"
                )
        finally:
            connection.close()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self._database), timeout=SQLITE_TIMEOUT_SECONDS)
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def record(self, session_id: str, snapshot_id: str, source_key: str, payload: dict) -> dict:
        connection = self._connect()
        try:
            with connection:
                connection.execute(
                    f"INSERT OR IGNORE INTO {CITATIONS_TABLE} VALUES (?,?,?,?,?)",
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
            return json.loads(row[0])
        finally:
            connection.close()

    def get(self, session_id: str, snapshot_id: str, handle: str) -> dict | None:
        connection = self._connect()
        try:
            row = connection.execute(
                f"SELECT payload FROM {CITATIONS_TABLE} WHERE session_id=? AND snapshot_id=? AND handle=?",
                (session_id, snapshot_id, handle),
            ).fetchone()
            return json.loads(row[0]) if row else None
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
