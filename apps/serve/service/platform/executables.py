"""Locate installed console-script entry points inside the current Python env.

Console scripts are installed with platform-specific naming: POSIX writes an
extensionless text launcher with an absolute shebang; Windows writes a `.exe`
trampoline whose payload records the installer's Python path. Both flavors are
NOT relocatable — when the packaged Desktop bundle is moved to a different
absolute prefix, the trampoline fails to canonicalize its recorded path and the
POSIX shebang points at a non-existent interpreter.

The Desktop bundle mitigates this by generating product-owned relocatable
shells under `backend/bin/`. This module exposes the helpers used both by
callers that need to find those shells and by callers that need to consult the
installed console-script directory as a fallback.
"""

from __future__ import annotations

import os
import sysconfig
from pathlib import Path

_WINDOWS_OS_NAME = "nt"
_WINDOWS_EXECUTABLE_SUFFIX = ".exe"
_WINDOWS_SCRIPT_SUFFIXES = (".exe", ".cmd", ".bat")
SKILL_PYTHON_COMMAND = "scholarseed-skill-python"


def executable_suffix() -> str:
    """Suffix a bare command name needs to be resolvable on this platform."""

    return _WINDOWS_EXECUTABLE_SUFFIX if os.name == _WINDOWS_OS_NAME else ""


def scripts_directory() -> Path:
    """Directory where the active Python environment installs console scripts."""

    return Path(sysconfig.get_path("scripts"))


def resolve_command(name: str) -> Path | None:
    """Return the console-script installed by this env for ``name``, if any.

    Only returns a path when the file exists — callers may still probe it to
    confirm it can execute (e.g. Windows trampolines fail at runtime when the
    embedded Python path can no longer be canonicalized).
    """

    if not name:
        return None
    directory = scripts_directory()
    suffixes = _WINDOWS_SCRIPT_SUFFIXES if os.name == _WINDOWS_OS_NAME else ("",)
    for suffix in suffixes:
        candidate = directory / f"{name}{suffix}"
        if candidate.is_file():
            return candidate
    return None
