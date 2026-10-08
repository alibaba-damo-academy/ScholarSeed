"""Read side of managed full texts: ``paper:`` refs resolve to managed bytes."""

from __future__ import annotations

from service.literature.persistence import fulltexts
from service.literature.persistence.files import SERVICE_LITERATURE_FILES_DIR, read_attachment
from service.platform.citations import MANAGED_STORAGE_SCOPE, CitationDocument

PAPER_REF_PREFIX = "paper:"
MANAGED_FULLTEXT_SOURCE_KIND = "managed_fulltext"


class ManagedFulltexts:
    """Resolve an authorized ``paper:`` ref to its managed PDF bytes."""

    def managed_fulltext_document(self, project_id: str, paper_id: str) -> CitationDocument | None:
        obj = fulltexts.find_fulltext_object(paper_id)
        if obj is None:
            return None
        location = str(SERVICE_LITERATURE_FILES_DIR / obj.object_name)
        return CitationDocument(
            project_id=project_id,
            path=location,
            title=obj.title or paper_id,
            revision=obj.revision,
            payload=read_attachment(location),
            reference_id=PAPER_REF_PREFIX + paper_id,
            storage_scope=MANAGED_STORAGE_SCOPE,
        )


__all__ = [
    "MANAGED_FULLTEXT_SOURCE_KIND",
    "PAPER_REF_PREFIX",
    "ManagedFulltexts",
]
