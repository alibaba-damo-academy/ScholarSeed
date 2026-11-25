"""Repository ownership within Content-authorized resource boundaries."""

from __future__ import annotations

import os
import stat
from pathlib import Path

from service.content.domain.model import OUTSIDE_GRANT_ERRORS, ContentError, resolve_root
from service.content.service.space import Mount, ProjectSpace
from service.platform.content import AssetKind, AssetOrigin, RootKind
from service.platform.storage import WINDOWS_PLATFORM

GIT_MARKER = ".git"
REPOSITORY_UNAVAILABLE_ERROR = "repository_unavailable"


class RepositoryLookup:
    """Resolve Git ownership within one authorized Content traversal or batch."""

    def __init__(self, scope: ProjectSpace) -> None:
        self._scope = scope
        self._resource_root = resolve_root(scope.project, RootKind.RESOURCES).absolute.resolve()
        self._cache: dict[tuple[Path, Path], Path | None] = {}
        self._logical_roots: dict[Path, str] = {}

    def for_entry(
        self,
        path: str,
        directory: Path,
        entry: os.DirEntry[str] | Mount,
        origin: AssetOrigin,
    ) -> str | None:
        """Use the qualified physical parent only for an ordinary local file.

        Windows entries use full resolution for junctions and other reparse points.
        """

        if (
            origin is AssetOrigin.LOCAL
            and not isinstance(entry, Mount)
            and os.name != WINDOWS_PLATFORM
            and "\\" not in path
        ):
            try:
                plain_file = entry.is_file(follow_symlinks=False)
            except OSError:
                plain_file = False
            if plain_file:
                return self._for_directory(directory, self._resource_root)
        return self.for_path(path)

    def for_path(self, path: str) -> str | None:
        mount = self._scope.mount_for(path)
        if mount is not None and mount.kind is AssetKind.FILE:
            return None
        boundary = mount.source.resolve() if mount is not None else self._resource_root
        try:
            target = self._scope.absolute(path)
        except ContentError as exc:
            if exc.code not in OUTSIDE_GRANT_ERRORS:
                raise
            return None

        return self._for_target(target, boundary)

    def for_resolved_local_path(self, target: Path, *, is_directory: bool) -> str | None:
        """Use a local target already resolved and inspected by the traversal."""

        return self._for_target(target, self._resource_root, is_directory=is_directory)

    def for_scanned_path(self, path: str, target: Path, *, is_directory: bool) -> str | None:
        """Reuse a checked local path, and keep live resolution for mount aliases."""

        if "\\" in path or self._scope.mount_for(path) is not None:
            return self.for_path(path)
        return self.for_resolved_local_path(target, is_directory=is_directory)

    def _for_target(
        self, target: Path, boundary: Path, *, is_directory: bool | None = None
    ) -> str | None:
        if target != boundary and boundary not in target.parents:
            return None
        if is_directory is None:
            is_directory = target.is_dir()
        return self._for_directory(target if is_directory else target.parent, boundary)

    def _for_directory(self, directory: Path, boundary: Path) -> str | None:
        key = (boundary, directory)
        if key not in self._cache:
            self._find_ancestors(directory, boundary)
        root = self._cache.get(key)
        if root is None:
            return None
        if root not in self._logical_roots:
            self._logical_roots[root] = self._scope.relative(root)
        return self._logical_roots[root]

    def _find_ancestors(self, current: Path, boundary: Path) -> None:
        visited: list[tuple[Path, Path]] = []
        root = None
        while current == boundary or boundary in current.parents:
            key = (boundary, current)
            if key in self._cache:
                root = self._cache[key]
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
            self._cache[key] = root


def repository_roots(scope: ProjectSpace, paths: tuple[str, ...]) -> dict[str, str | None]:
    """Locate nearest Git markers without following gitfiles or leaving a grant."""

    lookup = RepositoryLookup(scope)
    return {path: lookup.for_path(path) for path in dict.fromkeys(paths)}
