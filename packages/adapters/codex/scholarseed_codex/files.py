"""Workspace file observations, independent of process and thread lifecycles."""

import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

from scholarseed_codex.git import worktree_status
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


def workspace_snapshot(
    cwd: Path, report_error: Callable[[OSError], None], *, directory: Path | None = None
) -> dict[str, FileStamp]:
    """Observe eligible regular files without reading contents or following directory links."""
    workspace = cwd.expanduser().resolve()
    result: dict[str, FileStamp] = {}
    start = directory if directory is not None else workspace
    for root, directories, names in os.walk(start, onerror=report_error, followlinks=False):
        parent = Path(root)
        directories[:] = [
            name
            for name in directories
            if is_artifact_candidate(str((parent / name).relative_to(workspace)))
            and not (parent / name).is_symlink()
            and not (parent / name).is_junction()
        ]
        for name in names:
            path = parent / name
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


@dataclass(frozen=True)
class TurnFiles:
    stamps: dict[str, FileStamp]
    git_paths: dict[str, bool] | None = None
    artifact_directory: Path | None = None

    def change_kind(self, path: str, current: "TurnFiles | None" = None) -> str:
        if path in self.stamps:
            return FILE_CHANGE_UPDATE
        if self.git_paths is None or path in self.git_paths:
            return FILE_CHANGE_ADD
        if self.artifact_directory and Path(path).is_relative_to(self.artifact_directory):
            return FILE_CHANGE_ADD
        if current and current.git_paths and current.git_paths.get(path):
            return FILE_CHANGE_ADD
        # Clean tracked files were omitted from the initial Git snapshot.
        return FILE_CHANGE_UPDATE


def turn_files(
    cwd: Path,
    report_error: Callable[[OSError], None],
    artifact_directory: Path | None = None,
    previous: TurnFiles | None = None,
) -> TurnFiles:
    workspace = cwd.expanduser().resolve()
    git_paths = (
        worktree_status(workspace) if previous is None or previous.git_paths is not None else None
    )
    if git_paths is None:
        if previous is None or previous.git_paths is None:
            return TurnFiles(workspace_snapshot(workspace, report_error))
        # Only recheck known paths. A full tree cannot be compared to a sparse baseline.
        report_error(OSError("Git status unavailable at turn completion"))
        git_paths = {}

    stamps = {}
    output = previous.artifact_directory if previous is not None else None
    if artifact_directory is not None and artifact_directory.is_relative_to(workspace):
        relative = artifact_directory.relative_to(workspace)
        if relative.parts and is_artifact_candidate(str(relative)):
            output = relative
    if output is not None:
        target = workspace / output
        try:
            if target.resolve(strict=True) == target and target.is_dir():
                stamps.update(workspace_snapshot(workspace, report_error, directory=target))
        except (FileNotFoundError, NotADirectoryError):
            pass
        except (OSError, RuntimeError) as error:
            report_error(OSError(str(error)))
    paths = set(git_paths)
    if previous is not None and previous.git_paths:
        # A previously dirty tracked file can return to clean during this turn.
        paths.update(previous.git_paths)
    for path in paths:
        if path in stamps or not is_artifact_candidate(path):
            continue
        target = workspace / path
        try:
            if target.resolve(strict=True) != target:
                continue
            metadata = target.stat(follow_symlinks=False)
            if stat.S_ISREG(metadata.st_mode):
                stamps[path] = FileStamp(
                    metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns
                )
        except (FileNotFoundError, NotADirectoryError):
            continue
        except (OSError, RuntimeError) as error:
            report_error(OSError(str(error)))
    return TurnFiles(stamps, git_paths, output)


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
    except (OSError, RuntimeError, ValueError):
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
