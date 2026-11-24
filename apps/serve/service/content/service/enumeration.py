"""Complete deterministic enumeration for background resource consumers."""

from __future__ import annotations

import os
import stat
from pathlib import Path, PurePosixPath
from typing import Callable

from service.content.domain.model import IGNORED_NAMES, ContentError, resolve_root
from service.content.service.space import ProjectSpace, normalize
from service.platform.content import ResourceEntry, ResourcePage, ResourceScanObserver, RootKind
from service.platform.storage import WINDOWS_PLATFORM

GITIGNORE_FILENAME = ".gitignore"
BIRTH_TIME_ATTRIBUTE = "st_birthtime"


def _created_at(file_stat: os.stat_result) -> float:
    """Return native creation time on macOS/Windows, with POSIX ctime fallback."""

    birth_time = getattr(file_stat, BIRTH_TIME_ATTRIBUTE, None)
    return float(birth_time if birth_time is not None else file_stat.st_ctime)


def _scan_name(name: str) -> bool:
    if name in IGNORED_NAMES:
        return False
    return name == GITIGNORE_FILENAME or not name.startswith(".")


def _inside(target: Path, roots: tuple[Path, ...]) -> bool:
    return any(target == root or root in target.parents for root in roots)


def entry_from_stat(path: str, file_stat: os.stat_result) -> ResourceEntry:
    return ResourceEntry(path=path, size=file_stat.st_size, created_at=_created_at(file_stat))


def _entry(
    space: ProjectSpace,
    target: Path,
    allowed_roots: tuple[Path, ...],
) -> tuple[ResourceEntry, Path] | None:
    try:
        resolved = target.resolve()
        file_stat = resolved.stat()
        logical = space.relative_resolved(resolved)
    except (ContentError, OSError):
        return None
    if (
        not _inside(resolved, allowed_roots)
        or not (
            resolved.is_file() if os.name == WINDOWS_PLATFORM else stat.S_ISREG(file_stat.st_mode)
        )
        or space.excluded(logical)
        or not all(_scan_name(part) for part in PurePosixPath(logical).parts)
    ):
        return None
    return entry_from_stat(logical, file_stat), resolved


def resource_scopes(space: ProjectSpace, paths: tuple[str, ...]) -> tuple[str, ...]:
    """Intersect logical changes with registered resource roots, including deletions."""

    roots = (
        resolve_root(space.project, RootKind.RESOURCES).relative,
        *(mount.mount_path for mount in space.mounts),
    )
    selected: set[str] = set()
    for raw in paths:
        path = normalize(raw)
        if space.excluded(path):
            continue
        for root in roots:
            if not root or path == root or path.startswith(f"{root}/"):
                selected.add(path)
            elif not path or root.startswith(f"{path}/"):
                selected.add(root)
    return tuple(sorted(selected))


def scan_files(
    space: ProjectSpace,
    observer: ResourceScanObserver | None = None,
    *,
    check: Callable[[], None] | None = None,
    paths: tuple[str, ...] | None = None,
    observe_resolved: Callable[[ResourceEntry, Path], None] | None = None,
    include_directory: Callable[[str, Path], bool] | None = None,
) -> tuple[ResourceEntry, ...]:
    """Enumerate authorized files, optionally pruning directories before listing them."""

    resource_root = resolve_root(space.project, RootKind.RESOURCES).absolute.resolve()
    linked_roots = tuple(mount.source.resolve() for mount in space.mounts)
    allowed_roots = (resource_root, *linked_roots)
    starts = (
        (resource_root, *linked_roots)
        if paths is None
        else tuple(
            space.absolute(path)
            for path in resource_scopes(space, paths)
            if all(_scan_name(part) for part in PurePosixPath(path).parts)
        )
    )
    found: dict[str, ResourceEntry] = {}
    visited: set[tuple[int, int]] = set()

    def descend(directory: Path) -> bool:
        if include_directory is None:
            return True
        try:
            resolved = directory.resolve()
            logical = space.relative_resolved(resolved)
        except (ContentError, OSError):
            return False
        return (
            _inside(resolved, allowed_roots)
            and not space.excluded(logical)
            and include_directory(logical, resolved)
        )

    def discover(target: Path) -> None:
        qualified = _entry(space, target, allowed_roots)
        if qualified is None:
            return
        entry, resolved = qualified
        discovered = entry.path not in found
        found[entry.path] = entry
        if observe_resolved is not None:
            observe_resolved(entry, resolved)
        if discovered and observer is not None:
            observer(entry)

    for start in starts:
        if check is not None:
            check()
        if start.is_file():
            if _scan_name(start.name):
                discover(start)
            continue
        if not start.is_dir() or not descend(start):
            continue
        for current, directories, filenames in os.walk(start, followlinks=True):
            if check is not None:
                check()
            current_path = Path(current)
            try:
                resolved_current = current_path.resolve()
                identity = resolved_current.stat()
                logical_current = space.relative_resolved(resolved_current)
            except (ContentError, OSError):
                directories[:] = []
                continue
            if not _inside(resolved_current, allowed_roots) or space.excluded(logical_current):
                directories[:] = []
                continue
            directory_key = (identity.st_dev, identity.st_ino)
            if directory_key in visited:
                directories[:] = []
                continue
            visited.add(directory_key)
            directories[:] = sorted(
                name for name in directories if _scan_name(name) and descend(current_path / name)
            )
            for name in sorted(name for name in filenames if _scan_name(name)):
                if check is not None:
                    check()
                discover(current_path / name)
    return tuple(found[path] for path in sorted(found))


def entries_for_paths(space: ProjectSpace, paths: tuple[str, ...]) -> tuple[ResourceEntry, ...]:
    """Inspect selected logical files without enumerating unrelated resources."""

    resource_root = resolve_root(space.project, RootKind.RESOURCES).absolute.resolve()
    linked_roots = tuple(mount.source.resolve() for mount in space.mounts)
    allowed_roots = (resource_root, *linked_roots)
    found: dict[str, ResourceEntry] = {}
    for path in dict.fromkeys(paths):
        try:
            target = space.absolute(path)
        except ContentError:
            continue
        qualified = _entry(space, target, allowed_roots)
        if qualified is not None:
            entry, _ = qualified
            found[entry.path] = entry
    return tuple(found[path] for path in sorted(found))


def enumerate_files(
    space: ProjectSpace,
    cursor: str | None,
    limit: int,
) -> ResourcePage:
    """Enumerate logical file paths without the UI tree's per-directory truncation."""

    ordered = [entry for entry in scan_files(space) if cursor is None or entry.path > cursor]
    entries = tuple(ordered[:limit])
    next_cursor = entries[-1].path if len(ordered) > limit else None
    return ResourcePage(entries=entries, next_cursor=next_cursor)


__all__ = [
    "GITIGNORE_FILENAME",
    "entries_for_paths",
    "entry_from_stat",
    "enumerate_files",
    "scan_files",
]
