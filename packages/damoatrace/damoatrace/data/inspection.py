"""Read production event projections without opening a store or writing an index."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from damoatrace.data.records import decode_event_record, decode_object_line
from damoatrace.data.store import TraceStore
from damoatrace.data.usage import _run_summary
from damoatrace.search.index import TraceIndex


def inspect_event_line(
    line: str, *, compaction: Callable[[str, dict[str, Any]], None] | None = None
) -> bool:
    """Exercise query, usage and search codecs; preserve opaque historical lines.

    False means the normal event reader skips this line. It does not mean the
    caller may discard it. Context ledgers and provider records are separate.
    """
    return inspect_event_record(decode_object_line(line), compaction=compaction)


def inspect_event_record(
    record: dict[str, Any] | None,
    *,
    compaction: Callable[[str, dict[str, Any]], None] | None = None,
) -> bool:
    """Exercise the actual codecs on one decoded object; never mutate it."""
    if record is None:
        return False
    TraceIndex.project_record(record)
    record = decode_event_record(record)
    if record is None:
        return False
    _run_summary([record], "")
    projected = TraceStore.project_compaction_events([record])
    session = record.get("session_id")
    if compaction is not None and isinstance(session, str) and session:
        for value in projected:
            compaction(session, value)
    return True
