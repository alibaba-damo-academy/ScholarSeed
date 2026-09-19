"""Bounded versioned content blocks and the common content visibility boundary."""

from __future__ import annotations

import copy
import json
import time
from enum import Enum
from typing import Any, Mapping

from damoatrace.recording.redaction import REDACTION_VERSION, Redactor

CONTENT_VERSION = 1
CONTENT_FIELDS = ("inputs", "outputs")
BLOCK_LIMIT = 512 * 1024
TURN_LIMIT = 4 * 1024 * 1024
SESSION_LIMIT = 64 * 1024 * 1024
DISK_LIMIT = 1024 * 1024 * 1024
RETENTION_SECONDS = 14 * 24 * 60 * 60
CONTENT_MARKER = "diagnostic_content_version"
HIDDEN_MESSAGE = "content_not_requested"
BUDGET_EVICTED = "budget_evicted"
BUDGET_EXHAUSTED = "budget_exhausted"
EXPIRED = "expired"


class ContentCategory(str, Enum):
    USER = "user_message"
    CONTEXT = "product_context"
    SUBMISSION = "runtime_submission"
    ANSWER = "assistant_response"
    TOOL_INPUT = "tool_input"
    TOOL_OUTPUT = "tool_output"
    PERMISSION = "permission"


def content_block(
    category: ContentCategory,
    value: Any,
    *,
    source: str,
    revision: int,
    redactor: Redactor,
    budget: int = BLOCK_LIMIT,
    missing_reason: str = "",
) -> dict[str, Any]:
    encoded = json.dumps(value, ensure_ascii=False).encode()
    safe = redactor.value(value)
    safe_bytes = json.dumps(safe, ensure_ascii=False).encode()
    limit = max(0, min(BLOCK_LIMIT, budget))
    truncated = len(safe_bytes) > limit
    # Filter before truncating so a partial secret cannot evade the redactor.
    data = safe_bytes[:limit].decode("utf-8", errors="ignore") if truncated else safe
    captured_at = time.time()
    return {
        "category": category.value,
        "source": source,
        "data": data,
        "capture_revision": revision,
        "captured_bytes": len(data.encode()) if truncated else len(safe_bytes),
        "byte_start": 0,
        "byte_end": len(data.encode()) if truncated else len(safe_bytes),
        "original_bytes": len(encoded),
        "truncated": truncated,
        "missing_reason": "truncated" if truncated else missing_reason,
        "redacted": safe != value,
        "redaction_version": REDACTION_VERSION,
        "captured_at": captured_at,
        "expires_at": captured_at + RETENTION_SECONDS,
    }


def visible_content(
    record: Mapping[str, Any], *, include_content: bool = False, now: float | None = None
) -> dict[str, Any]:
    """Never expose expired/new-mode body data through a default query projection."""
    result = copy.deepcopy(dict(record))
    timestamp = time.time() if now is None else now
    detailed = result.get(CONTENT_MARKER) == CONTENT_VERSION
    for field in CONTENT_FIELDS:
        content = result.get(field)
        if not isinstance(content, dict) or "blocks" not in content:
            continue
        kept = []
        for block in content.get("blocks", []):
            if not isinstance(block, dict):
                continue
            deadline = block.get("expires_at")
            expired = not isinstance(deadline, (int, float)) or deadline <= timestamp
            item = dict(block)
            if expired or not include_content:
                item.pop("data", None)
                item.pop("text", None)
                if "data" in block or "text" in block:
                    item["missing_reason"] = "expired" if expired else HIDDEN_MESSAGE
            kept.append(item)
        result[field] = {"version": CONTENT_VERSION, "blocks": kept}
    if detailed and not include_content:
        error = result.get("error")
        if isinstance(error, dict) and "message" in error:
            error["message"] = HIDDEN_MESSAGE
    return result


def prepare_content(content: dict[str, Any] | None) -> dict[str, Any] | None:
    """Writer boundary: reject unschematized bodies and reapply credential filtering."""
    if content is None:
        return None
    if content.get("version") != CONTENT_VERSION or not isinstance(content.get("blocks"), list):
        raise ValueError("unsupported diagnostic content envelope")
    result = copy.deepcopy(content)
    for block in result["blocks"]:
        if (
            not isinstance(block, dict)
            or block.get("category") not in set(ContentCategory)
            or type(block.get("capture_revision")) is not int
            or not isinstance(block.get("source"), str)
            or not isinstance(block.get("expires_at"), (int, float))
        ):
            raise ValueError("invalid diagnostic content block")
        if "data" in block:
            safe = Redactor().value(block["data"])
            encoded = (
                safe.encode()
                if isinstance(safe, str)
                else json.dumps(safe, ensure_ascii=False).encode()
            )
            if len(encoded) > BLOCK_LIMIT:
                raise ValueError("diagnostic content block exceeds limit")
            block["data"] = safe
    return result


def has_content(record: Mapping[str, Any]) -> bool:
    return any(
        "data" in block
        for field in CONTENT_FIELDS
        for block in (
            record[field].get("blocks", []) if isinstance(record.get(field), dict) else []
        )
        if isinstance(block, dict)
    )
