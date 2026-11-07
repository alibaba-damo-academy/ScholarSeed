"""Read side of managed full texts: ``paper:`` refs resolve to managed bytes."""

from __future__ import annotations

from service.literature.domain.delivery import (
    FULLTEXT_BINDING_INTEGRITY_FAILED,
    FULLTEXT_BINDING_REQUIRED,
)
from service.literature.persistence.delivery import DeliveryStore
from service.literature.persistence.files import (
    SERVICE_LITERATURE_FILES_DIR,
    payload_revision,
    read_attachment,
)
from service.platform.citations import (
    MANAGED_STORAGE_SCOPE,
    CitationDocument,
    CitationSourceChanged,
)
from service.platform.context import FulltextBindingScope, FulltextTaskContext

PAPER_REF_PREFIX = "paper:"
MANAGED_FULLTEXT_SOURCE_KIND = "managed_fulltext"


class ManagedFulltexts:
    """Resolve an authorized ``paper:`` ref to its managed PDF bytes."""

    def managed_fulltext_document(
        self,
        project_id: str,
        paper_id: str,
        *,
        task_context: FulltextTaskContext | FulltextBindingScope | None = None,
    ) -> CitationDocument | None:
        if task_context is None or task_context.project_id != project_id:
            raise ValueError(FULLTEXT_BINDING_REQUIRED)
        obj = (
            DeliveryStore()
            .bindings(
                task_context.session_id,
                project_id,
                task_context.workspace,
                authorization_id=getattr(task_context, "authorization_id", ""),
            )
            .get(paper_id)
        )
        if obj is None:
            return None
        return self._document(project_id, paper_id, task_context.session_id, obj)

    def citation_document(
        self, project_id: str, paper_id: str, *, session_id: str, revision: str
    ) -> CitationDocument | None:
        """Reopen the exact acquisition named by a retained citation receipt."""
        obj = next(
            (
                source
                for batch in DeliveryStore().for_session(session_id, project_id)
                for paper in batch["papers"]
                for source in DeliveryStore.sources(paper)
                if source["paper_id"] == paper_id and source["revision"] == revision
            ),
            None,
        )
        if obj is None:
            return None
        return self._document(project_id, paper_id, session_id, obj)

    @staticmethod
    def _document(project_id: str, paper_id: str, session_id: str, obj: dict) -> CitationDocument:
        location = str(SERVICE_LITERATURE_FILES_DIR / obj["object_name"])
        payload = read_attachment(location)
        if payload_revision(payload) != obj["revision"]:
            raise CitationSourceChanged(f"{FULLTEXT_BINDING_INTEGRITY_FAILED}: {paper_id}")
        return CitationDocument(
            project_id=project_id,
            path=location,
            title=obj.get("title") or paper_id,
            revision=obj["revision"],
            payload=payload,
            session_id=session_id,
            reference_id=PAPER_REF_PREFIX + paper_id,
            storage_scope=MANAGED_STORAGE_SCOPE,
        )


__all__ = [
    "MANAGED_FULLTEXT_SOURCE_KIND",
    "PAPER_REF_PREFIX",
    "ManagedFulltexts",
]
