"""Resource-owned read projections without observation or version capture."""

from __future__ import annotations

from urllib.parse import urlencode

from service.content.domain.model import ContentError
from service.platform.content import AssetKind, ContentPort
from service.platform.queries import (
    RESOURCE_SOURCE_ROUTE,
    ProjectQueryError,
    ResourceDiff,
    ResourceDiffResult,
    ResourceHitResult,
    ResourceSearch,
    ResourceSearchResult,
    ResourceStat,
    ResourceStatResult,
    ResourceVersionResult,
    ResourceVersions,
    ResourceVersionsResult,
)
from service.resources.service.history import ResourceVersionError, ResourceVersionService

RESOURCE_NOT_FOUND = "resource_not_found"


class ResourceQueries:
    def __init__(self, content: ContentPort, versions: ResourceVersionService) -> None:
        self._content = content
        self._versions = versions

    def _path(self, project_id: str, path: str) -> str:
        entries = self._content.resource_entries(project_id, (path,))
        if not entries:
            raise ProjectQueryError(RESOURCE_NOT_FOUND)
        return entries[0].path

    def search(self, project_id: str, command: ResourceSearch) -> ResourceSearchResult:
        try:
            found = self._content.search(project_id, command.query)
            for hit in found.hits[command.offset : command.offset + command.limit]:
                self._path(project_id, hit.path)
        except ContentError as error:
            raise ProjectQueryError(error.code) from error
        end = command.offset + command.limit
        return ResourceSearchResult(
            entries=[
                ResourceHitResult(
                    path=hit.path, name=hit.name, matched=hit.matched.value, snippet=hit.snippet
                )
                for hit in found.hits[command.offset : end]
            ],
            next_offset=end if end < len(found.hits) else None,
            truncated=found.truncated,
        )

    def stat(self, project_id: str, command: ResourceStat) -> ResourceStatResult:
        try:
            path = self._path(project_id, command.path)
            snapshot = self._content.snapshot(project_id, path)
            identity = self._versions.version_identity(project_id, path)
            self._path(project_id, path)
        except (ContentError, ResourceVersionError) as error:
            raise ProjectQueryError(error.code) from error
        return ResourceStatResult(
            source_url=f"{RESOURCE_SOURCE_ROUTE}?{urlencode({'project': project_id, 'path': path})}",
            path=path,
            kind=AssetKind.FILE.value,
            size=snapshot.size,
            media_type=snapshot.media_type,
            revision=snapshot.revision,
            file_id=identity[0] if identity else None,
            version_id=identity[2] if identity else None,
        )

    def versions(self, project_id: str, command: ResourceVersions) -> ResourceVersionsResult:
        try:
            path = self._path(project_id, command.path)
            identity = self._versions.version_identity(project_id, path)
            if identity is None:
                return ResourceVersionsResult(versions=[])
            versions, _total = self._versions.history_page(
                project_id,
                identity[0],
                before_sequence=command.before_sequence,
                limit=command.limit + 1,
            )
            self._path(project_id, path)
        except (ContentError, ResourceVersionError) as error:
            raise ProjectQueryError(error.code) from error
        selected = versions[: command.limit]
        return ResourceVersionsResult(
            file_id=identity[0],
            versions=[
                ResourceVersionResult(
                    id=version.id,
                    sequence=version.sequence,
                    path=version.path,
                    state=version.state.value,
                    origin=version.origin.value,
                    created_at_ms=version.created_at_ms,
                    alias=version.alias,
                )
                for version in selected
            ],
            next_sequence=selected[-1].sequence if len(versions) > command.limit else None,
        )

    def diff(self, project_id: str, command: ResourceDiff) -> ResourceDiffResult:
        try:
            version = self._versions.version(project_id, command.version_id)
            base = self._versions.version(project_id, command.base_version_id)
            path = self._versions.current_version_path(project_id, version.file_id)
            self._path(project_id, path)
            text = "".join(
                line if line.endswith("\n") else line + "\n"
                for line in self._versions.diff(project_id, version.id, base.id)
            )
            current_path = self._versions.current_version_path(project_id, version.file_id)
            self._path(project_id, current_path)
        except (ContentError, ResourceVersionError) as error:
            raise ProjectQueryError(error.code) from error
        end = command.offset + command.limit
        return ResourceDiffResult(
            version_id=version.id,
            base_version_id=base.id,
            diff=text[command.offset : end],
            next_offset=end if end < len(text) else None,
        )
