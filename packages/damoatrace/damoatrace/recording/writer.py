"""Append-only Evidence Contract writer, independent of product and runtime protocols."""

from __future__ import annotations

import json
import math
import os
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import local
from types import TracebackType
from typing import Any, Iterator

from damoatrace.recording.budget import ContentBudget
from damoatrace.recording.content import CONTENT_MARKER, CONTENT_VERSION, prepare_content
from damoatrace.recording.storage import evidence_lock, make_private


class EvidenceWriter:
    """Append service-owned events in the DamoATrace Evidence Contract shape."""

    def __init__(self, path: Path, *, budget: ContentBudget | None = None) -> None:
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)
        make_private(self._path.parent, directory=True)
        self._closed = False
        self._budget = budget
        self._batch = local()

    def emit(
        self,
        *,
        session_id: str,
        kind: str,
        name: str,
        task_run_id: str,
        component_id: str,
        attributes: dict[str, Any],
        status: str = "ok",
        error: dict[str, str] | None = None,
        inputs: dict[str, Any] | None = None,
        outputs: dict[str, Any] | None = None,
        span_id: str | None = None,
        parent_span_id: str | None = None,
        started_at: datetime | None = None,
        duration_ms: float = 0,
    ) -> None:
        if not math.isfinite(duration_ms) or duration_ms < 0:
            raise ValueError("evidence duration must be finite and nonnegative")
        started = started_at if started_at is not None else datetime.now(timezone.utc)
        if started.utcoffset() is None:
            raise ValueError("evidence start must include a timezone")
        ended = started + timedelta(milliseconds=duration_ms)
        record: dict[str, Any] = {
            "id": uuid.uuid4().hex,
            "task_run_id": task_run_id,
            "span_id": span_id or uuid.uuid4().hex,
            "parent_span_id": parent_span_id,
            "kind": kind,
            "name": name,
            "started_at": started.isoformat(),
            "ended_at": ended.isoformat(),
            "duration_ms": duration_ms,
            "session_id": session_id,
            "component_id": component_id,
            "artifact_paths": [],
            "policy_decision_id": None,
            "hil_session_id": None,
            "attributes": attributes,
            "inputs": prepare_content(inputs),
            "outputs": prepare_content(outputs),
            "status": status,
            "error": error,
        }
        if self._closed:
            raise ValueError("evidence writer is closed")
        if inputs is not None or outputs is not None:
            record[CONTENT_MARKER] = CONTENT_VERSION
        records = getattr(self._batch, "records", None)
        if records is not None:
            records.append(record)
            return
        self._append_many([record])

    @contextmanager
    def batch(self) -> Iterator[None]:
        """Keep individual records, sharing only the current thread's write boundary."""
        if self._closed:
            raise ValueError("evidence writer is closed")
        if getattr(self._batch, "records", None) is not None:
            yield
            return
        records: list[dict[str, Any]] = []
        self._batch.records = records
        try:
            yield
            if records:
                self._append_many(records)
        finally:
            self._batch.records = None

    def _append_many(self, records: list[dict[str, Any]]) -> None:
        if self._closed:
            raise ValueError("evidence writer is closed")
        if self._budget is not None:
            self._budget.append_many(self._path, records)
            return
        # Reopen under the shared lock: a purge may have replaced the inode.
        with evidence_lock(self._path):
            with self._path.open("a", encoding="utf-8") as stream:
                make_private(self._path)
                stream.writelines(
                    json.dumps(record, ensure_ascii=False) + "\n" for record in records
                )
                stream.flush()

    def checkpoint(self) -> None:
        """Confirm preceding records reached the file before a producer releases resources."""
        if self._closed:
            raise ValueError("evidence writer is closed")
        with evidence_lock(self._path):
            with self._path.open("r+b") as stream:
                os.fsync(stream.fileno())

    def close(self) -> None:
        self._closed = True

    def __enter__(self) -> "EvidenceWriter":
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()
