"""Repository ownership within Content-authorized resource boundaries."""

from __future__ import annotations

import stat
from pathlib import Path

from service.content.domain.model import ContentError, resolve_root
from service.content.service.space import ProjectSpace
from service.platform.content import AssetKind, RootKind

GIT_MARKER = ".git"
REPOSITORY_UNAVAILABLE_ERROR = "repository_unavailable"
OUTSIDE_GRANT_ERRORS = frozenset({"path_outside_project", "path_outside_root"})


def repository_roots(scope: ProjectSpace, paths: tuple[str, ...]) -> dict[str, str | None]:
    """Locate nearest Git marker without following gitfiles or leaving a grant.

    A marker retains Git ownership even when its metadata is unavailable or
    damaged. Detection performs no Git operation and needs no Git installation.
    The per-call cache never survives an authorization or filesystem change.
    """

    resource_root = resolve_root(scope.project, RootKind.RESOURCES).absolute.resolve()
    cache: dict[tuple[Path, Path], Path | None] = {}
    found: dict[str, str | None] = {}
    for path in dict.fromkeys(paths):
        mount = scope.mount_for(path)
        if mount is not None and mount.kind is AssetKind.FILE:
            found[path] = None
            continue
        boundary = mount.source.resolve() if mount is not None else resource_root
        try:
            target = scope.absolute(path)
        except ContentError as exc:
            if exc.code not in OUTSIDE_GRANT_ERRORS:
                raise
            found[path] = None
            continue
        if target != boundary and boundary not in target.parents:
            found[path] = None
            continue
        current = target if target.is_dir() else target.parent
        visited: list[tuple[Path, Path]] = []
        root = None
        while current == boundary or boundary in current.parents:
            key = (boundary, current)
            if key in cache:
                root = cache[key]
                break
            visited.append(key)
            try:
                marker_mode = (current / GIT_MARKER).lstat().st_mode
            except FileNotFoundError:
                marker_mode = None
            except OSError as exc:
                raise ContentError(REPOSITORY_UNAVAILABLE_ERROR) from exc
            if marker_mode is not None and (
                stat.S_ISDIR(marker_mode) or stat.S_ISREG(marker_mode) or stat.S_ISLNK(marker_mode)
            ):
                root = current
                break
            if current == boundary:
                break
            current = current.parent
        for key in visited:
            cache[key] = root
        found[path] = scope.relative(root) if root is not None else None
    return found
