"""JSON normalization shared by Codex runtime boundary projections."""

import os
from dataclasses import asdict, is_dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Mapping

from scholarseed_runtime.contract import RuntimeValue

WINDOWS_PLATFORM = "nt"
WINDOWS_PATH_PREFIX = "\\\\?\\"
WINDOWS_UNC_PREFIX = "\\\\"
WINDOWS_EXTENDED_UNC = "UNC\\"


def path_identity(path: Path) -> str:
    """Compare native and host path spellings without changing protocol payloads."""
    expanded = path.expanduser()
    if os.name == WINDOWS_PLATFORM:
        absolute = os.path.abspath(expanded)
        if not absolute.startswith(WINDOWS_PATH_PREFIX):
            if absolute.startswith(WINDOWS_UNC_PREFIX):
                absolute = WINDOWS_EXTENDED_UNC + absolute[2:]
            absolute = WINDOWS_PATH_PREFIX + absolute
        expanded = Path(absolute)
    return os.path.normcase(str(expanded.resolve()))


def json_value(value: Any) -> RuntimeValue:
    if is_dataclass(value) and not isinstance(value, type):
        return json_value(asdict(value))
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [json_value(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"runtime inventory value is not JSON-safe: {type(value).__name__}")
