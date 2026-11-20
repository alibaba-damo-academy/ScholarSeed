"""Encode JSON payloads as server-sent events."""

from __future__ import annotations

import json
from typing import Any

SSE_DATA_PREFIX = "data: "
SSE_FRAME_SUFFIX = "\n\n"
SSE_HEARTBEAT_FRAME = "event: heartbeat\ndata: {}\n\n"


def sse_encode(event: dict[str, Any]) -> str:
    return f"{SSE_DATA_PREFIX}{json.dumps(event, ensure_ascii=False, separators=(',', ':'))}{SSE_FRAME_SUFFIX}"
