"""Content-free diagnostics shared by invocation persistence and consumers."""

from __future__ import annotations

import re
from collections.abc import Mapping

from service.chat.runtime.timing import ActivationStage
from service.chat.runtime.utils import (
    FAILURE_CHAIN_LIMIT,
    SAFE_RUNTIME_ERRORS,
    SAFE_RUNTIME_METHODS,
)

INVOCATION_EXECUTION_PHASE = "invocation.execute"
DIAGNOSTIC_PHASES = frozenset(
    (*[stage.value for stage in ActivationStage], "turn.start", INVOCATION_EXECUTION_PHASE)
)
DIAGNOSTIC_NUMBERS = ("errno", "winerror", "rpc_code", "rpc_latency_ms", "generation")
DIAGNOSTIC_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]{0,127}\Z")


def diagnostic_code(value: object, fallback: str = "") -> str:
    return value if isinstance(value, str) and DIAGNOSTIC_IDENTIFIER.fullmatch(value) else fallback


def invocation_diagnostic(value: object) -> dict[str, object]:
    """Drop free text and unknown fields at both write and read boundaries."""
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, object] = {}
    phase = value.get("phase")
    if isinstance(phase, str) and phase in DIAGNOSTIC_PHASES:
        result["phase"] = phase
    exceptions = value.get("exception_types")
    if isinstance(exceptions, (list, tuple)):
        names = [name for name in exceptions[:FAILURE_CHAIN_LIMIT] if diagnostic_code(name)]
        if names:
            result["exception_types"] = names
    for key, allowed in (("safe_error", SAFE_RUNTIME_ERRORS), ("rpc_method", SAFE_RUNTIME_METHODS)):
        item = value.get(key)
        if isinstance(item, str) and item in allowed:
            result[key] = item
    for key in DIAGNOSTIC_NUMBERS:
        item = value.get(key)
        if isinstance(item, int) and not isinstance(item, bool):
            result[key] = item
    return result
