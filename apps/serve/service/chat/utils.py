"""Shared, stateless helpers for the chat domain."""

from __future__ import annotations

import base64
import json
import math
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from service.chat.constants import TURN_ERROR_PHASE, TURN_FAILED_CODE

SESSION_LIST_CURSOR_MAX_CHARS = 2048
SESSION_LIST_CURSOR_INVALID = "session_list_cursor_invalid"
SESSION_LIST_CURSOR_FIELDS = 2
SESSION_LIST_PINNED_CURSOR_FIELDS = 3


def session_list_cursor(updated_at: float, session_id: str, pinned: bool | None = None) -> str:
    values: list[float | str | bool] = [updated_at, session_id]
    if pinned is not None:
        values.append(pinned)
    return base64.urlsafe_b64encode(json.dumps(values, separators=(",", ":")).encode()).decode()


def parse_session_list_cursor(cursor: str) -> tuple[float, str, bool | None] | None:
    if not cursor:
        return None
    try:
        if len(cursor) > SESSION_LIST_CURSOR_MAX_CHARS:
            raise ValueError(SESSION_LIST_CURSOR_INVALID)
        values = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
        if (
            not isinstance(values, list)
            or len(values) not in (SESSION_LIST_CURSOR_FIELDS, SESSION_LIST_PINNED_CURSOR_FIELDS)
            or type(values[0]) not in (int, float)
            or not math.isfinite(values[0])
            or values[0] < 0
            or not isinstance(values[1], str)
            or not values[1]
            or (len(values) == SESSION_LIST_PINNED_CURSOR_FIELDS and type(values[2]) is not bool)
        ):
            raise ValueError(SESSION_LIST_CURSOR_INVALID)
        return (
            float(values[0]),
            values[1],
            values[2] if len(values) == SESSION_LIST_PINNED_CURSOR_FIELDS else None,
        )
    except (ValueError, TypeError, OverflowError) as error:
        raise ValueError(SESSION_LIST_CURSOR_INVALID) from error


def mapping(value: object) -> dict[str, Any]:
    """Copy a mapping into the chat-owned payload shape, or return an empty map."""
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in value.items()}


def optional_mapping(value: object) -> dict[str, Any] | None:
    """Copy a mapping when it is present; preserve absence as ``None``."""
    if not isinstance(value, Mapping):
        return None
    return {str(key): item for key, item in value.items()}


def items(value: object) -> list[Any]:
    """Return a list only for a list-shaped provider value."""
    return list(value) if isinstance(value, list) else []


def turn_error_payload(exc: Exception, *, workspace: Path | None = None) -> dict[str, str]:
    """Translate an execution failure into the stable chat error payload."""

    to_dict = getattr(exc, "to_dict", None)
    if callable(to_dict):
        data = to_dict()
        if isinstance(data, dict):
            return {str(key): str(value) for key, value in data.items()}
    payload = {
        "code": TURN_FAILED_CODE,
        "phase": TURN_ERROR_PHASE,
        "message": f"{type(exc).__name__}: {exc}",
    }
    if workspace is not None:
        payload["workspace"] = str(workspace)
    return payload
