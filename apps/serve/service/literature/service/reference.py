"""Resolve literature entries for provenance-bearing resource excerpts."""

from __future__ import annotations

from service.content.domain.model import ContentError
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.pdf import LiteraturePdf
from service.platform.content import ContentPort
from service.platform.excerpts import (
    ExcerptSourceError,
    ExcerptSourceKind,
    ExcerptSourceRef,
)

LITERATURE_NOT_FOUND = "literature_not_found"
LITERATURE_PDF_MISSING = "literature_pdf_missing"
LITERATURE_REVISION_CONFLICT = "literature_revision_conflict"


class LiteratureReferenceService:
    """Validate a stable literature id and resolve its current PDF revision."""

    def __init__(
        self,
        content: ContentPort,
        repository: LiteratureRepository | None = None,
    ) -> None:
        self._content = content
        self._repository = repository or LiteratureRepository()
        self._pdf = LiteraturePdf(self._repository)

    def resolve(
        self,
        project_id: str,
        source_id: str,
        expected_document_revision: str | None = None,
    ) -> ExcerptSourceRef:
        item = next(
            (entry for entry in self._repository.view(project_id).items if entry.id == source_id),
            None,
        )
        if item is None:
            raise ExcerptSourceError(LITERATURE_NOT_FOUND)
        if not item.has_pdf:
            raise ExcerptSourceError(LITERATURE_PDF_MISSING)
        try:
            payload, _media = self._pdf.read(item)
            revision = self._content.revision(payload)
        except ContentError as error:
            raise ExcerptSourceError(LITERATURE_PDF_MISSING) from error
        if expected_document_revision and expected_document_revision != revision:
            raise ExcerptSourceError(LITERATURE_REVISION_CONFLICT)
        return ExcerptSourceRef(
            kind=ExcerptSourceKind.LITERATURE,
            source_id=item.id,
            title=item.title,
            document_revision=revision,
        )


__all__ = [
    "LITERATURE_NOT_FOUND",
    "LITERATURE_PDF_MISSING",
    "LITERATURE_REVISION_CONFLICT",
    "LiteratureReferenceService",
]
