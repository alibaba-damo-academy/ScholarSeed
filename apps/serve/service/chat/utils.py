"""Shared, stateless helpers for the chat domain."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from service.chat.constants import TURN_ERROR_PHASE, TURN_FAILED_CODE


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
