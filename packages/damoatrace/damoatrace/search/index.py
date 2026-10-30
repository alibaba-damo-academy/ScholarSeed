"""Rebuildable FTS5 index for append-only trace JSONL records."""

from __future__ import annotations

import json
import math
import re
import sqlite3
import time
from collections.abc import Iterable, Mapping
from contextlib import closing
from dataclasses import asdict, dataclass
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

from damoatrace.contract.record import TraceEvent
from damoatrace.data.records import decode_object_line
from damoatrace.recording.content import CONTENT_FIELDS, CONTENT_MARKER, visible_content
from damoatrace.search.sqlite import (
    SqliteFtsStore,
    initialize_projection,
    inspect_projection,
    is_fts5_available,
    reset_projection,
)

SCOPE_COLUMNS = {
    "all": None,
    "text": "body",
    "tool_input": "tool_input",
    "error": "error_text",
}
MAX_FIELD_CHARS = 4000
INDEX_TABLE = "trace_events"
PROJECTION_VERSION = "diagnostic-metadata-v1"
VISIBILITY_FIELDS = (*CONTENT_FIELDS, CONTENT_MARKER, "error")
INDEX_CHECK_SECONDS = 0.1
INDEX_CHECK_PROGRESS_OPS = 1000
INDEX_PREVIEW_MAX_BYTES = 256 * 1024 * 1024
FTS5_DECLARATION = re.compile(r"\bUSING\s+fts5\s*\(", re.IGNORECASE)


class IndexCheck(StrEnum):
    COMPLETE = "complete"
    INCOMPLETE_BUDGET = "incomplete_budget"
    NOT_PRESENT = "not_present"


@dataclass(frozen=True)
class IndexInspection:
    current: bool
    sqlite_check: IndexCheck


@dataclass(frozen=True)
class ProjectionFormat:
    """Marker contract shared with the actual rebuildable projection writer."""

    readable: tuple[str, ...]
    written: str
    rebuild_unmarked: bool

    def require_readable(self, version: object) -> None:
        if type(version) is not str or version not in self.readable:
            raise ValueError("unsupported projection version")


PROJECTION_FORMAT = ProjectionFormat(
    readable=(PROJECTION_VERSION,), written=PROJECTION_VERSION, rebuild_unmarked=True
)


class TraceIndex:
    """Disposable full-text projection; JSONL remains the source of truth."""

    COLUMNS = (
        "id",
        "task_run_id",
        "session_id",
        "component_id",
        "kind",
        "name",
        "status",
        "error_class",
        "started_at",
        "body",
        "tool_input",
        "error_text",
    )
    FTS_COLUMNS = ("body", "tool_input", "error_text")

    def __init__(self, db_path: Path | str) -> None:
        self._fts = SqliteFtsStore(
            db_path,
            table=INDEX_TABLE,
            columns=self.COLUMNS,
            fts_columns=self.FTS_COLUMNS,
            id_column="id",
            projection_version=PROJECTION_FORMAT.written,
        )
        try:
            self.projection_reset = self._fts.reset_projection(PROJECTION_FORMAT.written)
        except BaseException:
            self._fts.close()
            raise

    @staticmethod
    def inspect_projection(connection: sqlite3.Connection) -> bool:
        """Use the same marker check as the writer, without opening or migrating."""
        return inspect_projection(connection, INDEX_TABLE, PROJECTION_FORMAT.written)

    @classmethod
    def inspect_readonly(
        cls,
        source: sqlite3.Connection | None,
        *,
        budget_seconds: float = INDEX_CHECK_SECONDS,
    ) -> IndexInspection:
        """Check runtime schema and bounded SQLite integrity, not full FTS consistency.

        The caller owns qualification and the read transaction, and lends an
        otherwise unused progress handler. Only our budget interruption is partial
        evidence; schema, version, IO and confirmed corruption errors still fail.
        """
        if source is None:
            cls.inspect_startup(None, deadline=math.inf)
            return IndexInspection(False, IndexCheck.NOT_PRESENT)
        trusted_schema = source.getconfig(sqlite3.SQLITE_DBCONFIG_TRUSTED_SCHEMA)
        source.setconfig(sqlite3.SQLITE_DBCONFIG_TRUSTED_SCHEMA, False)
        try:
            if source.execute(
                "SELECT 1 FROM sqlite_master WHERE type IN ('trigger', 'view') LIMIT 1"
            ).fetchone():
                raise ValueError("unsupported Trace index schema")
            current = cls.inspect_projection(source)
            table = source.execute(
                "SELECT sql FROM sqlite_master WHERE name = ?", (INDEX_TABLE,)
            ).fetchone()
            if table is not None:
                columns = tuple(
                    row[1] for row in source.execute(f"PRAGMA table_info({INDEX_TABLE})")
                )
                if columns != cls.COLUMNS:
                    raise ValueError("unsupported Trace index columns")
                kind = source.execute(
                    "SELECT type FROM pragma_table_list WHERE schema = 'main' AND name = ?",
                    (INDEX_TABLE,),
                ).fetchone()
                if (
                    kind is None
                    or kind[0] != "virtual"
                    or not FTS5_DECLARATION.search(table[0] or "")
                ):
                    raise ValueError("unsupported Trace index table")
                source.execute(
                    f"SELECT {', '.join(cls.COLUMNS)} FROM {INDEX_TABLE} LIMIT 1"
                ).fetchone()
            return IndexInspection(current, cls._check_sqlite(source, budget_seconds))
        finally:
            source.setconfig(sqlite3.SQLITE_DBCONFIG_TRUSTED_SCHEMA, trusted_schema)

    @staticmethod
    def _check_sqlite(source: sqlite3.Connection, budget_seconds: float) -> IndexCheck:
        deadline = time.monotonic() + budget_seconds
        interrupted = False

        def progress() -> int:
            nonlocal interrupted
            interrupted = time.monotonic() >= deadline
            return int(interrupted)

        if progress():
            return IndexCheck.INCOMPLETE_BUDGET
        source.set_progress_handler(progress, INDEX_CHECK_PROGRESS_OPS)
        try:
            result = source.execute("PRAGMA quick_check(1)").fetchone()
            if result is None or result[0] != "ok":
                raise ValueError("Trace index SQLite integrity check failed")
            return IndexCheck.COMPLETE
        except sqlite3.OperationalError as error:
            if interrupted and error.sqlite_errorcode == sqlite3.SQLITE_INTERRUPT:
                return IndexCheck.INCOMPLETE_BUDGET
            raise
        finally:
            source.set_progress_handler(None, INDEX_CHECK_PROGRESS_OPS)

    @classmethod
    def inspect_startup(
        cls,
        source: sqlite3.Connection | None,
        *,
        deadline: float,
        max_bytes: int = INDEX_PREVIEW_MAX_BYTES,
    ) -> bool:
        """Exercise startup on a bounded private snapshot, never on source bytes.

        The caller owns the source's read transaction and filesystem qualification.
        The returned bool is its original marker state, not cross-version approval.
        """
        current = False if source is None else cls.inspect_projection(source)
        with closing(sqlite3.connect(":memory:")) as projected:
            projected.execute("PRAGMA temp_store=MEMORY")
            projected.execute("PRAGMA trusted_schema=OFF")
            if source is not None:
                page_size = int(source.execute("PRAGMA page_size").fetchone()[0])

                def progress(_status: int, _remaining: int, total: int) -> None:
                    if total * page_size > max_bytes or time.monotonic() >= deadline:
                        raise ValueError("Trace index preview exceeds budget")

                pages = int(source.execute("PRAGMA page_count").fetchone()[0])
                progress(0, pages, pages)
                source.backup(projected, pages=256, progress=progress)
            page_size = int(projected.execute("PRAGMA page_size").fetchone()[0])
            projected.execute(f"PRAGMA max_page_count={max_bytes // page_size}")
            projected.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            # FTS owns no triggers or views. Reject them before running migrations.
            if (
                projected.execute(
                    "SELECT 1 FROM sqlite_master WHERE type IN ('trigger', 'view') LIMIT 1"
                ).fetchone()
                is not None
            ):
                raise ValueError("unsupported Trace index schema")
            initialize_projection(
                projected,
                table=INDEX_TABLE,
                columns=cls.COLUMNS,
                fts_columns=cls.FTS_COLUMNS,
                version=PROJECTION_FORMAT.written,
            )
            reset_projection(projected, INDEX_TABLE, PROJECTION_FORMAT.written)
            columns = tuple(
                row[1] for row in projected.execute(f"PRAGMA table_info({INDEX_TABLE})")
            )
            if columns != cls.COLUMNS:
                raise ValueError("unsupported Trace index columns")
            # Unlike the optional UI search, do not swallow SQLite errors here.
            # This command verifies FTS shadow structures and the content index.
            projected.execute(
                f"INSERT INTO {INDEX_TABLE}({INDEX_TABLE}) VALUES ('integrity-check')"
            )
            projected.execute(
                f"SELECT {', '.join(cls.COLUMNS)} FROM {INDEX_TABLE} LIMIT 1"
            ).fetchall()
            if time.monotonic() >= deadline:
                raise ValueError("Trace index preview exceeds budget")
        return current

    @classmethod
    def try_open(cls, db_path: Path | str) -> TraceIndex | None:
        if not is_fts5_available():
            return None
        try:
            return cls(db_path)
        except Exception:  # noqa: BLE001 - FTS is an optional acceleration path
            return None

    def ingest(self, event: TraceEvent) -> None:
        self._fts.upsert(_event_row(event))

    def ingest_many(self, events: Iterable[TraceEvent]) -> int:
        rows = [_event_row(event) for event in events]
        self._fts.upsert_many(rows)
        return len(rows)

    def ingest_jsonl(self, path: Path | str) -> int:
        source = Path(path)
        if not source.exists():
            return 0
        rows: list[dict[str, Any]] = []
        for line in source.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            record = decode_object_line(line)
            if record is not None:
                rows.append(self.project_record(record))
        self._fts.upsert_many(rows)
        return len(rows)

    @staticmethod
    def project_record(record: Mapping[str, Any]) -> dict[str, Any]:
        """Use the actual index projection without opening or mutating SQLite."""
        return _mapping_row(record)

    def search(
        self,
        query: str,
        *,
        scope: str = "all",
        limit: int = 50,
        kind: str | None = None,
        status: str | None = None,
        error_class: str | None = None,
        task_run_id: str | None = None,
        session_id: str | None = None,
        component_id: str | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        parameters: list[Any] = []
        for column, value in (
            ("kind", kind),
            ("status", status),
            ("error_class", error_class),
            ("task_run_id", task_run_id),
            ("session_id", session_id),
            ("component_id", component_id),
        ):
            if value is not None:
                clauses.append(f"{column} = ?")
                parameters.append(value)
        if since is not None:
            clauses.append("started_at >= ?")
            parameters.append(since)
        if until is not None:
            clauses.append("started_at < ?")
            parameters.append(until)
        return self._fts.search(
            query,
            limit=limit,
            column=SCOPE_COLUMNS.get(scope),
            where=" AND ".join(clauses) if clauses else None,
            where_params=parameters,
        )

    def count(self) -> int:
        return self._fts.count()

    def close(self) -> None:
        self._fts.close()


def _event_row(event: TraceEvent) -> dict[str, Any]:
    return _record_row(event)


def _mapping_row(record: Mapping[str, Any]) -> dict[str, Any]:
    return _record_row(record)


def _error_value(error: object, name: str) -> Any:
    return error.get(name, "") if isinstance(error, Mapping) else getattr(error, name, "")


def _record_row(record: TraceEvent | Mapping[str, Any]) -> dict[str, Any]:
    record = dict(record) if isinstance(record, Mapping) else asdict(record)
    # Only these fields have visibility transformations. Other fields are read
    # directly into scalar index columns; no caller-owned references escape.
    projected = visible_content({key: record[key] for key in VISIBILITY_FIELDS if key in record})
    attributes = record.get("attributes", {}) or {}
    outputs = projected.get("outputs")
    inputs = projected.get("inputs")
    error = projected.get("error") or {}
    body = [str(record.get("name", "") or "")]
    if outputs:
        body.append(_truncate(_serialize(outputs)))
    if isinstance(attributes, Mapping):
        visible = {key: value for key, value in attributes.items() if key != "usage"}
        if visible:
            body.append(_truncate(_serialize(visible)))
    started_at = record.get("started_at", "")
    if isinstance(started_at, datetime):
        started_at = started_at.isoformat()
    return {
        "id": str(record.get("id", "") or ""),
        "task_run_id": str(record.get("task_run_id", "") or ""),
        "session_id": str(record.get("session_id", "") or ""),
        "component_id": str(record.get("component_id", "") or ""),
        "kind": str(record.get("kind", "") or ""),
        "name": str(record.get("name", "") or ""),
        "status": str(record.get("status", "ok") or "ok"),
        "error_class": str(
            _error_value(error, "error_class")
            or (attributes.get("error_class", "") if isinstance(attributes, Mapping) else "")
        ),
        "started_at": str(started_at or ""),
        "body": " ".join(part for part in body if part),
        "tool_input": _truncate(_serialize(inputs)) if inputs else "",
        "error_text": _truncate(
            f"{_error_value(error, 'code')} {_error_value(error, 'message')}"
        ).strip(),
    }


def _serialize(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001 - indexing must tolerate arbitrary trace payloads
        return str(value)


def _truncate(value: str) -> str:
    return value if len(value) <= MAX_FIELD_CHARS else value[:MAX_FIELD_CHARS]


__all__ = ["TraceIndex"]
