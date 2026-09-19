"""Workspace file observations, independent of process and thread lifecycles."""

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

from scholarseed_codex.protocol.mcp import JsonValue

CODEX_IGNORED_ARTIFACT_DIRECTORIES = frozenset({"node_modules", "__pycache__", ".venv", "venv"})
CODEX_IGNORED_ARTIFACT_SUFFIXES = frozenset({".swp", ".swo", ".tmp", ".temp"})
# Platform convention for agent scratch space: a directory whose name starts with
# this prefix holds working state (LLM call logs, partial drafts, stage status) and
# never a deliverable. Skills opt in by naming the directory, so a new skill needs
# no change here. Only directory segments are matched — a user file such as
# `_notes.md` stays observable.
WORKING_STATE_DIRECTORY_PREFIX = "_"
FILE_CHANGE_ADD = "add"
FILE_CHANGE_UPDATE = "update"


@dataclass(frozen=True)
class FileStamp:
    size: int
    modified_ns: int
    changed_ns: int


def workspace_snapshot(cwd: Path, report_error: Callable[[OSError], None]) -> dict[str, FileStamp]:
    """Observe eligible regular files without reading contents or following directory links."""
    workspace = cwd.expanduser().resolve()
    result: dict[str, FileStamp] = {}
    for root, directories, names in os.walk(workspace, onerror=report_error, followlinks=False):
        directory = Path(root)
        directories[:] = [
            name
            for name in directories
            if is_artifact_candidate(str((directory / name).relative_to(workspace)))
            and not (directory / name).is_symlink()
        ]
        for name in names:
            path = directory / name
            relative = str(path.relative_to(workspace))
            if not is_artifact_candidate(relative) or path.is_symlink():
                continue
            try:
                if path.is_file():
                    stat = path.stat()
                    result[relative] = FileStamp(stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
            except FileNotFoundError:
                continue  # A concurrently removed file is not a deliverable.
            except OSError as error:
                report_error(error)
    return result


def is_artifact_candidate(relative: str) -> bool:
    """Exclude private, transient and working-state paths from observed artifacts."""
    path = Path(relative)
    if any(part.startswith(".") for part in path.parts):
        return False
    if any(part in CODEX_IGNORED_ARTIFACT_DIRECTORIES for part in path.parts):
        return False
    if any(part.startswith(WORKING_STATE_DIRECTORY_PREFIX) for part in path.parts[:-1]):
        return False
    return path.suffix.lower() not in CODEX_IGNORED_ARTIFACT_SUFFIXES


def workspace_relative_path(cwd: Path, value: object) -> str:
    raw_path = str(value or "").strip()
    if not raw_path:
        return ""
    workspace = cwd.expanduser().resolve()
    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = workspace / candidate
    try:
        return str(candidate.resolve().relative_to(workspace))
    except (OSError, ValueError):
        return ""


def observed_changes(
    cwd: Path, watched_paths: Mapping[str, str], explicit_paths: set[str]
) -> list[Mapping[str, JsonValue]]:
    """Collect existing files not already reported by native fileChange."""
    workspace = cwd.expanduser().resolve()
    return [
        {"path": relative, "kind": change, "diff": ""}
        for relative, change in watched_paths.items()
        if relative not in explicit_paths and (workspace / relative).is_file()
    ]
