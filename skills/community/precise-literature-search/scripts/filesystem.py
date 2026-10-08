"""Filesystem path encoding; persisted skill paths remain platform-neutral."""

from __future__ import annotations

import ntpath
import os
from contextlib import contextmanager
from enum import Enum
from pathlib import Path, PureWindowsPath

WINDOWS = os.name == "nt"
EXTENDED_PREFIX = "\\\\?\\"
EXTENDED_UNC_PREFIX = EXTENDED_PREFIX + "UNC\\"
UNC_PREFIX = "\\\\"
DEVICE_PREFIX = "\\\\.\\"
WINDOWS_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
    | {f"COM{digit}" for digit in "123456789¹²³"}
    | {f"LPT{digit}" for digit in "123456789¹²³"}
)


class FileOperation(str, Enum):
    READ = "read"
    CREATE_DIRECTORY = "create_directory"
    CREATE_TEMPORARY = "create_temporary"
    WRITE = "write"
    REPLACE = "replace"


@contextmanager
def file_operation(operation):
    try:
        yield
    except OSError as error:
        error.filesystem_operation = operation.value
        raise


def ordinary_windows_path(value):
    value = os.fspath(value)
    if value.upper().startswith(EXTENDED_UNC_PREFIX.upper()):
        return UNC_PREFIX + value[len(EXTENDED_UNC_PREFIX) :]
    if value.startswith(EXTENDED_PREFIX):
        return value[len(EXTENDED_PREFIX) :]
    return value


def extended_windows_path(value):
    """Encode an absolute file path, never a Win32 device namespace."""
    value = ordinary_windows_path(value).replace("/", "\\")
    path = PureWindowsPath(value)
    if value.startswith(DEVICE_PREFIX) or not path.is_absolute():
        raise ValueError("expected an absolute Windows file path")
    drive = path.drive
    if not (drive.startswith(UNC_PREFIX) or len(drive) == 2 and drive[1] == ":"):
        raise ValueError("unsupported Windows path namespace")
    for part in path.parts[1:]:
        if part in (".", ".."):
            continue
        stem = part.partition(".")[0].rstrip(" ").upper()
        if part.endswith((".", " ")) or ":" in part or stem in WINDOWS_RESERVED_NAMES:
            raise ValueError("unsupported Windows file path component")
    normalized = ntpath.normpath(value)
    if normalized.startswith(UNC_PREFIX):
        return EXTENDED_UNC_PREFIX + normalized[len(UNC_PREFIX) :]
    return EXTENDED_PREFIX + normalized


def filesystem_path(path):
    """Use extended Windows paths only at filesystem boundaries."""
    path = Path(path)
    return Path(extended_windows_path(path.absolute())) if WINDOWS else path


def canonical_path(path):
    """Compare resolved identities without leaking Win32 prefixes into contracts."""
    resolved = filesystem_path(path).resolve()
    return Path(ordinary_windows_path(resolved)) if WINDOWS else resolved


def path_exists(path):
    return filesystem_path(path).exists()


#: Win32 visible-character budget when LongPathsEnabled is off: MAX_PATH (260)
#: includes the terminating NUL, so ordinary paths must stay below it. Only the
#: \\?\ extended prefix exceeds it, and extended forms never leave this module.
WINDOWS_PATH_BUDGET = 259
_WINDOWS_PID_CEILING = 4294967295


def windows_worst_path_length(directory: Path, name: str) -> int:
    """Length of the longest path ``directory/name`` could take on disk.

    Durable writers create sibling temp files named ``.<name>.tmp-<pid>`` before
    replacing the final name, and that form is longer than the final name, so it
    bounds the length any writer of this kind can require.
    """
    return len(str(directory / f".{name}.tmp-{_WINDOWS_PID_CEILING}"))


def error_details(error):
    """Retain OS diagnostics without returning paths or command arguments."""
    cause = error
    visited = set()
    while cause is not None and id(cause) not in visited:
        visited.add(id(cause))
        if isinstance(cause, OSError):
            filename = cause.filename
            return {
                "exception": type(cause).__name__,
                "operation": getattr(cause, "filesystem_operation", None),
                "errno": cause.errno,
                "winerror": getattr(cause, "winerror", None),
                "path_characters": len(os.fsdecode(filename)) if filename is not None else None,
            }
        cause = cause.__cause__
    return {}
