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

import logging
import os
import shutil
import subprocess
import sysconfig
from pathlib import Path

_WINDOWS_OS_NAME = "nt"
_WINDOWS_EXECUTABLE_SUFFIX = ".exe"
SKILL_PYTHON_COMMAND = "scholarseed-skill-python"
BRIDGE_DIR_ENV = "SCHOLARSEED_BRIDGE_DIR"
COMMAND_PROBE_TIMEOUT_SECONDS = 5
COMMAND_PROBE_ERROR_LIMIT = 200
COMMAND_HELP_ARGUMENTS = ("--help",)
SKILL_PYTHON_PROBE_ARGUMENTS = ("--version",)
_LOGGER = logging.getLogger(__name__)


def executable_suffix() -> str:
    """Suffix a bare command name needs to be resolvable on this platform."""

    return _WINDOWS_EXECUTABLE_SUFFIX if os.name == _WINDOWS_OS_NAME else ""


def scripts_directory() -> Path:
    """Directory where the active Python environment installs console scripts."""

    return Path(sysconfig.get_path("scripts"))


def resolve_command(name: str, directory: Path | None = None) -> Path | None:
    """Resolve a directory-local command using native executable/PATHEXT rules."""
    if not name:
        return None
    root = (directory if directory is not None else scripts_directory()).expanduser().absolute()
    resolved = shutil.which(str(root / name))
    return Path(resolved) if resolved else None


def command_directories() -> tuple[Path, ...]:
    """Prefer product launchers, then inherited PATH, then the active Python env."""
    entries = (
        os.environ.get(BRIDGE_DIR_ENV, ""),
        *os.environ.get("PATH", "").split(os.pathsep),
        str(scripts_directory()),
    )
    unique: dict[str, Path] = {}
    for entry in entries:
        if entry:
            directory = Path(entry).expanduser().absolute()
            unique.setdefault(os.path.normcase(str(directory)), directory)
    return tuple(unique.values())


def probe_command(path: Path, arguments: tuple[str, ...] = COMMAND_HELP_ARGUMENTS) -> bool:
    """Probe a trusted local launcher with fixed, caller-owned arguments."""
    try:
        result = subprocess.run(
            [str(path), *arguments],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=COMMAND_PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        _LOGGER.warning("Command probe failed at %s: %s", path, error)
        return False
    if result.returncode != 0:
        _LOGGER.warning(
            "Command probe at %s exited with code %s: %s",
            path,
            result.returncode,
            result.stderr.decode(errors="replace")[:COMMAND_PROBE_ERROR_LIMIT]
            if result.stderr else "",
        )
        return False
    return True
