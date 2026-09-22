"""Resolve Literature-owned entries for Assistant turn tool scopes.

Literature owns entry identity and the optional PDF association. This provider validates
the selected stable ID, then exposes a tool locator without injecting bibliography or PDF
content into the model prompt. Assistant never reads literature storage or project files.
"""

from __future__ import annotations

import hashlib
import json

from service.content.domain.model import ContentError
from service.content.service.port import ContentService
from service.literature.domain.cards import LIBRARY_REF_PREFIX
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.literature.service.pdf import LiteraturePdf
from service.platform.citations import CitationDocument
from service.platform.context import (
    AssistantContextIssue,
    AssistantContextResolution,
    AssistantContextResolvedItem,
    AssistantContextResolveRequest,
    ContextItemRole,
    ContextRef,
    ContextRefKind,
    ContextResolutionState,
)
from service.platform.pdf import (
    PDF_LOCATOR,
    PdfSelectionError,
    pdf_selection_matches,
    resolve_pdf_selection,
)

SUPPORTED_KIND = ContextRefKind.LITERATURE
UTF8_ENCODING = "utf-8"
REASON_SOURCE_MISSING = "literature_item_missing"
REASON_SOURCE_UNAVAILABLE = "literature_source_unavailable"
REASON_SOURCE_STALE = "source_revision_changed"
REASON_SELECTION_STALE = "selection_text_changed"
REASON_LOCATOR_INVALID = "selection_locator_invalid"
PROVIDER_VERSION = "literature-context/v1"
REVISION_PREFIX = "sha256:"
TOOL_SCOPE_CONTENT_LEVEL = "tool_scope"
SELECTION_CONTENT_LEVEL = "selection"


def _metadata(item: LiteratureItem) -> dict[str, object]:
    return {
        "id": item.id,
        "title": item.title,
        "authors": item.authors,
        "journal": item.journal,
        "year": item.year,
        "doi": item.doi,
        "abstract": item.abstract,
        "tags": list(item.tags),
        "collection": item.collection,
        "notes": [note.text for note in item.notes],
        "has_pdf": item.has_pdf,
    }


class LiteratureContextProvider:
    """Assistant provider for a stable, tool-readable Literature item id."""

    def __init__(
        self,
        content: ContentService,
        repository: LiteratureRepository | None = None,
    ) -> None:
        self._content = content
        self._repository = repository or LiteratureRepository()
        self._pdf = LiteraturePdf(self._repository)

    def _document(self, item: LiteratureItem, ref: ContextRef) -> tuple[bytes, str, str, str]:
        document_id = ref.anchor.document_id if ref.anchor is not None else None
        if document_id:
            attachment = self._pdf.attachment(item.id, document_id)
            payload, media_type, revision = self._pdf.read_attachment(item.id, document_id)
            return payload, media_type, revision, self._pdf.location_attachment(attachment)
        payload, media_type = self._pdf.read(item)
        revision = f"{REVISION_PREFIX}{hashlib.sha256(payload).hexdigest()}"
        return payload, media_type, revision, self._pdf.location(item)

    def citation_document(
        self, project_id: str, ref: ContextRef, *, scope: ContextRef | None = None
    ) -> CitationDocument:
        item = next(
            (
                entry
                for entry in self._repository.view(project_id).items
                if entry.id == ref.source_id
            ),
            None,
        )
        if item is None or not item.has_pdf:
            raise ValueError(REASON_SOURCE_MISSING)
        payload, _media_type, document_revision, location = self._document(item, ref)
        if ref.anchor is not None:
            if ref.source_revision and ref.source_revision != document_revision:
                raise ValueError(REASON_SOURCE_STALE)
        else:
            metadata = json.dumps(
                _metadata(item), ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode(UTF8_ENCODING)
            revision = f"{REVISION_PREFIX}{hashlib.sha256(metadata).hexdigest()}"
            if ref.source_revision and ref.source_revision != revision:
                raise ValueError(REASON_SOURCE_STALE)
        return CitationDocument(
            project_id,
            location,
            item.title,
            document_revision,
            payload,
        )

    def resolve(self, request: AssistantContextResolveRequest) -> AssistantContextResolution:
        ref = request.ref
        if ref.kind is not SUPPORTED_KIND:
            return self._failure(ref, ContextResolutionState.UNSUPPORTED, REASON_SOURCE_UNAVAILABLE)
        item = next(
            (
                entry
                for entry in self._repository.view(request.project_id).items
                if entry.id == ref.source_id
            ),
            None,
        )
        if item is None:
            return self._failure(ref, ContextResolutionState.MISSING, REASON_SOURCE_MISSING)

        if ref.anchor is not None:
            try:
                payload, media_type, revision, _location = self._document(item, ref)
            except (ContentError, OSError, ValueError):
                return self._failure(
                    ref,
                    ContextResolutionState.UNAVAILABLE,
                    REASON_SOURCE_UNAVAILABLE,
                )
            if not ref.source_revision or ref.source_revision != revision:
                return self._failure(ref, ContextResolutionState.STALE, REASON_SOURCE_STALE)
            locator = ref.anchor.locator
            if locator.get("kind") != PDF_LOCATOR:
                return self._failure(
                    ref,
                    ContextResolutionState.UNSUPPORTED,
                    REASON_LOCATOR_INVALID,
                )
            try:
                selected = resolve_pdf_selection(
                    payload,
                    locator,
                    ref.anchor.selected_text_hash,
                )
            except PdfSelectionError:
                return self._failure(
                    ref,
                    ContextResolutionState.UNSUPPORTED,
                    REASON_LOCATOR_INVALID,
                )
            selected_hash = (
                f"{REVISION_PREFIX}{hashlib.sha256(selected.encode(UTF8_ENCODING)).hexdigest()}"
            )
            if not selected or not pdf_selection_matches(
                selected,
                locator,
                ref.anchor.selected_text_hash,
            ):
                return self._failure(
                    ref,
                    ContextResolutionState.STALE,
                    REASON_SELECTION_STALE,
                )
            if request.budget.max_items < 1 or len(selected) > request.budget.max_chars:
                return self._failure(
                    ref,
                    ContextResolutionState.TOO_LARGE,
                    "selection_budget_exceeded",
                )
            return AssistantContextResolution(
                state=ContextResolutionState.READY,
                provider_version=PROVIDER_VERSION,
                source_revision=revision,
                items=(
                    AssistantContextResolvedItem(
                        item_id=ref.ref_id,
                        source_id=item.id,
                        label=item.title,
                        selection_source_label=(
                            item.title if ref.selection_source_label is not None else None
                        ),
                        source_revision=revision,
                        text=selected,
                        anchor=ref.anchor,
                        model_locator=f"{LIBRARY_REF_PREFIX}{item.id}",
                        content_hash=selected_hash,
                        media_type=media_type,
                        content_level=SELECTION_CONTENT_LEVEL,
                    ),
                ),
            )

        metadata_payload = json.dumps(
            _metadata(item),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode(UTF8_ENCODING)
        revision = f"{REVISION_PREFIX}{hashlib.sha256(metadata_payload).hexdigest()}"
        if ref.source_revision and ref.source_revision != revision:
            return self._failure(ref, ContextResolutionState.STALE, REASON_SOURCE_STALE)
        return AssistantContextResolution(
            state=ContextResolutionState.READY,
            provider_version=PROVIDER_VERSION,
            source_revision=revision,
            items=(
                AssistantContextResolvedItem(
                    item_id=item.id,
                    source_id=item.id,
                    label=item.title,
                    source_revision=revision,
                    text="",
                    role=ContextItemRole.SCOPE,
                    model_locator=f"{LIBRARY_REF_PREFIX}{item.id}",
                    content_level=TOOL_SCOPE_CONTENT_LEVEL,
                ),
            ),
        )

    @staticmethod
    def _failure(
        _ref: object,
        state: ContextResolutionState,
        reason: str,
    ) -> AssistantContextResolution:
        return AssistantContextResolution(
            state=state,
            provider_version=PROVIDER_VERSION,
            issues=(AssistantContextIssue(code=reason),),
        )


__all__ = ["LiteratureContextProvider"]
