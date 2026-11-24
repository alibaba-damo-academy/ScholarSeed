"""Validated scalar fields at the product runtime wire boundary."""

import os
from contextlib import closing
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from service.platform.storage import canonical_root, open_directory


def inline_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Omit redundant display titles from an inline request declaration."""
    schema = model.model_json_schema()
    schema.pop("title", None)
    for field in schema.get("properties", {}).values():
        field.pop("title", None)
    return schema


def request_file(workdir: Path, value: object) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError("bridge_request_file_invalid")
    relative = Path(value)
    if relative.is_absolute():
        relative = relative.relative_to(workdir)
    if not relative.parts or ".." in relative.parts:
        raise ValueError("bridge_request_file_invalid")
    with closing(open_directory(canonical_root(workdir), relative.parts[:-1])) as directory:
        with os.fdopen(directory.open_regular(relative.name), "rb") as source:
            return source.read()


def text(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("wire text must be a string")
    return value


def integer(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("wire number must be an integer")
    return value


def optional_integer(value: object) -> int | None:
    return None if value is None else integer(value)


def boolean(value: object) -> bool:
    if not isinstance(value, bool):
        raise TypeError("wire flag must be a boolean")
    return value


FAILURE_CHAIN_LIMIT = 8
SAFE_RUNTIME_ERRORS = frozenset(
    (
        "codex_app_server_error",
        "codex_app_server_unavailable",
        "agent_runtime_failed",
        "agent_runtime_unavailable",
        "agent_runtime_closed",
        "generation_only_invalid_configuration",
        "generation_only_tool_rejected",
        "generation_only_turn_rejected",
        "runtime_session_not_found",
        "resource_reservation_invalid",
        "harness_runtime_not_ready",
    )
)
SAFE_RUNTIME_METHODS = frozenset(
    (
        "initialize",
        "thread/start",
        "thread/resume",
        "thread/fork",
        "turn/start",
        "turn/interrupt",
        "thread/unsubscribe",
        "model/list",
        "config/read",
    )
)


def runtime_failure(error: BaseException, *, phase: str) -> dict[str, object]:
    """Keep typed local RPC diagnostics; never serialize exception messages/args."""
    exception_types: list[str] = []
    diagnostic: dict[str, object] = {"phase": phase, "exception_types": exception_types}
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and len(seen) < FAILURE_CHAIN_LIMIT and id(current) not in seen:
        seen.add(id(current))
        exception_types.append(type(current).__name__)
        code = getattr(current, "safe_error", None)
        if isinstance(code, str) and code in SAFE_RUNTIME_ERRORS:
            diagnostic["safe_error"] = code
        method = getattr(current, "method", None)
        if isinstance(method, str) and method in SAFE_RUNTIME_METHODS:
            diagnostic["rpc_method"] = method
        for attribute in ("rpc_code", "rpc_latency_ms", "generation"):
            value = getattr(current, attribute, None)
            if isinstance(value, int) and not isinstance(value, bool):
                diagnostic[attribute] = value
        if isinstance(current, OSError):
            for attribute in ("errno", "winerror"):
                value = getattr(current, attribute, None)
                if isinstance(value, int) and not isinstance(value, bool):
                    diagnostic[attribute] = value
        current = current.__cause__ or current.__context__
    return diagnostic
