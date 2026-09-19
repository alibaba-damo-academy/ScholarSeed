"""Rebuildable FTS5 index for append-only trace JSONL records."""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

from damoatrace.contract.record import TraceEvent
from damoatrace.recording.content import visible_content
from damoatrace.search.sqlite import SqliteFtsStore, is_fts5_available

SCOPE_COLUMNS = {
    "all": None,
    "text": "body",
    "tool_input": "tool_input",
    "error": "error_text",
}
MAX_FIELD_CHARS = 4000
INDEX_TABLE = "trace_events"
PROJECTION_VERSION = "diagnostic-metadata-v1"


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
        )
        self.projection_reset = self._fts.reset_projection(PROJECTION_VERSION)

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
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, Mapping):
                rows.append(_mapping_row(record))
        self._fts.upsert_many(rows)
        return len(rows)

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


def _value(record: TraceEvent | Mapping[str, Any], name: str, default: Any = None) -> Any:
    return (
        record.get(name, default) if isinstance(record, Mapping) else getattr(record, name, default)
    )


def _error_value(error: object, name: str) -> Any:
    return error.get(name, "") if isinstance(error, Mapping) else getattr(error, name, "")


def _record_row(record: TraceEvent | Mapping[str, Any]) -> dict[str, Any]:
    record = visible_content(dict(record) if isinstance(record, Mapping) else asdict(record))
    attributes = _value(record, "attributes", {}) or {}
    outputs = _value(record, "outputs")
    inputs = _value(record, "inputs")
    error = _value(record, "error") or {}
    body = [str(_value(record, "name", "") or "")]
    if outputs:
        body.append(_truncate(_serialize(outputs)))
    if isinstance(attributes, Mapping):
        visible = {key: value for key, value in attributes.items() if key != "usage"}
        if visible:
            body.append(_truncate(_serialize(visible)))
    started_at = _value(record, "started_at", "")
    if isinstance(started_at, datetime):
        started_at = started_at.isoformat()
    return {
        "id": str(_value(record, "id", "") or ""),
        "task_run_id": str(_value(record, "task_run_id", "") or ""),
        "session_id": str(_value(record, "session_id", "") or ""),
        "component_id": str(_value(record, "component_id", "") or ""),
        "kind": str(_value(record, "kind", "") or ""),
        "name": str(_value(record, "name", "") or ""),
        "status": str(_value(record, "status", "ok") or "ok"),
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
