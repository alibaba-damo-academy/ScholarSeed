"""Append-only Evidence Contract writer, independent of product and runtime protocols."""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import TracebackType
from typing import Any

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
    ) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        record: dict[str, Any] = {
            "id": uuid.uuid4().hex,
            "task_run_id": task_run_id,
            "span_id": uuid.uuid4().hex,
            "parent_span_id": None,
            "kind": kind,
            "name": name,
            "started_at": timestamp,
            "ended_at": timestamp,
            "duration_ms": 0,
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
        if self._budget is not None:
            self._budget.append(self._path, record)
            return
        encoded = json.dumps(record, ensure_ascii=False) + "\n"
        # Reopen under the shared lock: a purge may have replaced the inode.
        with evidence_lock(self._path):
            with self._path.open("a", encoding="utf-8") as stream:
                make_private(self._path)
                stream.write(encoded)
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
