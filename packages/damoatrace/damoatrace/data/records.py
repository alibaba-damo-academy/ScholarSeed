"""Common JSONL decoders used by Trace queries and read-only inspection."""

from __future__ import annotations

import json
from typing import Any


def decode_object_line(line: str) -> dict[str, Any] | None:
    try:
        record = json.loads(line)
    except json.JSONDecodeError:
        return None
    return record if isinstance(record, dict) else None


def decode_event_line(line: str) -> dict[str, Any] | None:
    return decode_event_record(decode_object_line(line))


def decode_event_record(record: dict[str, Any] | None) -> dict[str, Any] | None:
    """Apply the event reader's object contract without decoding JSON again."""
    if record is None or not isinstance(record.get("attributes", {}), dict):
        return None
    return record
