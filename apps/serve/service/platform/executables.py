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
import sys
import sysconfig
import tempfile
from pathlib import Path

_WINDOWS_OS_NAME = "nt"
_WINDOWS_EXECUTABLE_SUFFIX = ".exe"
SKILL_PYTHON_COMMAND = "scholarseed-skill-python"
BRIDGE_DIR_ENV = "SCHOLARSEED_BRIDGE_DIR"
COMMAND_PROBE_TIMEOUT_SECONDS = 5
# A fresh signed interpreter/launcher can spend tens of seconds in OS admission.
# Keep ordinary tool probes short; only the startup receipt gets this budget.
SKILL_PYTHON_PROBE_TIMEOUT_SECONDS = 60
COMMAND_PROBE_ERROR_LIMIT = 4096
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


def command_directories(*, inherit_path: bool = True) -> tuple[Path, ...]:
    """Prefer product launchers, then inherited PATH, then the active Python env."""
    entries = (
        os.environ.get(BRIDGE_DIR_ENV, ""),
        *(os.environ.get("PATH", "").split(os.pathsep) if inherit_path else ()),
        str(scripts_directory()),
    )
    unique: dict[str, Path] = {}
    for entry in entries:
        if entry:
            directory = Path(entry).expanduser().absolute()
            unique.setdefault(os.path.normcase(str(directory)), directory)
    return tuple(unique.values())


def probe_command(
    path: Path,
    arguments: tuple[str, ...] = COMMAND_HELP_ARGUMENTS,
    *,
    timeout_seconds: float | None = None,
) -> bool:
    """Probe a trusted local launcher with fixed, caller-owned arguments."""
    _LOGGER.info("Command probe starting at %s with arguments %s", path, arguments)
    error_message = ""
    error_truncated = False
    try:
        # Probes must not inherit Desktop's parent-control stdin. On Windows,
        # Python initialization can block on a pipe another thread is reading.
        # A file also avoids waiting for stderr EOF from a launcher's descendants
        # after subprocess.run kills the direct process on timeout.
        with tempfile.TemporaryFile() as diagnostics:
            try:
                result = subprocess.run(
                    [str(path), *arguments],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=diagnostics,
                    timeout=(
                        COMMAND_PROBE_TIMEOUT_SECONDS
                        if timeout_seconds is None
                        else timeout_seconds
                    ),
                    check=False,
                )
            finally:
                diagnostics.seek(0, os.SEEK_END)
                error_size = diagnostics.tell()
                error_truncated = error_size > COMMAND_PROBE_ERROR_LIMIT
                diagnostics.seek(max(0, error_size - COMMAND_PROBE_ERROR_LIMIT))
                error_message = diagnostics.read(COMMAND_PROBE_ERROR_LIMIT).decode(errors="replace")
    except (OSError, subprocess.SubprocessError) as error:
        _LOGGER.warning(
            "Command probe failed at %s (%s): %s; stderr_truncated=%s stderr=%s",
            path,
            type(error).__name__,
            error,
            error_truncated,
            error_message,
        )
        return False
    if result.returncode != 0:
        _LOGGER.warning(
            "Command probe at %s exited with code %s; stderr_truncated=%s stderr=%s",
            path,
            result.returncode,
            error_truncated,
            error_message,
        )
        return False
    _LOGGER.info("Command probe at %s exited with code 0", path)
    return True


def skill_python_probe(arguments: list[str]) -> int:
    if len(arguments) != 1:
        _LOGGER.warning(
            "Skill Python probe invalid argument count: expected 1, received %s", len(arguments)
        )
        return 2
    directory = Path(arguments[0])
    if not directory.is_absolute():
        _LOGGER.warning("Skill Python probe requires an absolute directory: %s", directory)
        return 2
    launcher = resolve_command(SKILL_PYTHON_COMMAND, directory)
    if launcher is None:
        _LOGGER.warning(
            "Skill Python probe launcher not found: %s in %s", SKILL_PYTHON_COMMAND, directory
        )
        return 1
    _LOGGER.info("Skill Python probe resolved launcher: %s", launcher)
    return (
        0
        if probe_command(
            launcher,
            SKILL_PYTHON_PROBE_ARGUMENTS,
            timeout_seconds=SKILL_PYTHON_PROBE_TIMEOUT_SECONDS,
        )
        else 1
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    raise SystemExit(skill_python_probe(sys.argv[1:]))
