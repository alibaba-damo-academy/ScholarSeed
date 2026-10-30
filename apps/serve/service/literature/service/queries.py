"""Project bibliography projections that never read full text or shared notes."""

from __future__ import annotations

from urllib.parse import quote, urlencode

from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.platform.citations import LITERATURE_NOT_FOUND
from service.platform.queries import (
    LITERATURE_SOURCE_ROUTE,
    PROJECT_REQUIRED,
    LiteratureAttachmentSummary,
    LiteratureDetail,
    LiteratureDetailResult,
    LiteratureMetadata,
    LiteratureSearch,
    LiteratureSearchResult,
    ProjectQueryError,
)


class LiteratureQueries:
    def __init__(self, repository: LiteratureRepository) -> None:
        self._repository = repository

    @staticmethod
    def _metadata(item: LiteratureItem) -> LiteratureMetadata:
        return LiteratureMetadata(
            id=item.id,
            title=item.title,
            authors=item.authors,
            year=item.year,
            publication=item.journal or item.venue,
            doi=item.doi,
            version=item.version,
        )

    def _require_member(self, project_id: str, literature_id: str) -> None:
        if not project_id:
            raise ProjectQueryError(PROJECT_REQUIRED)
        if project_id not in self._repository.projects(literature_id):
            raise ProjectQueryError(LITERATURE_NOT_FOUND)

    def search(self, project_id: str, command: LiteratureSearch) -> LiteratureSearchResult:
        if not project_id:
            raise ProjectQueryError(PROJECT_REQUIRED)
        items = self._repository.list(
            project_id=project_id,
            q=command.query,
            offset=command.offset,
            limit=command.limit + 1,
        )
        selected = items[: command.limit]
        for item in selected:
            self._require_member(project_id, item.id)
        return LiteratureSearchResult(
            items=[self._metadata(item) for item in selected],
            next_offset=command.offset + command.limit if len(items) > command.limit else None,
        )

    def detail(self, project_id: str, command: LiteratureDetail) -> LiteratureDetailResult:
        self._require_member(project_id, command.literature_id)
        item = self._repository.get(command.literature_id)
        if item is None:
            raise ProjectQueryError(LITERATURE_NOT_FOUND)
        attachments = self._repository.attachments(item.id)
        self._require_member(project_id, item.id)
        return LiteratureDetailResult(
            source_url=f"{LITERATURE_SOURCE_ROUTE}/{quote(item.id, safe='')}?{urlencode({'project_id': project_id})}",
            item=self._metadata(item),
            abstract=item.abstract,
            attachments=[
                LiteratureAttachmentSummary(
                    id=attachment["id"],
                    name=attachment["name"],
                    media_type=attachment["media_type"],
                    role=attachment["role"],
                )
                for attachment in attachments
            ],
        )
