"""Fast PDF text materialization, deliberately separate from citation indexing."""

from __future__ import annotations

import hashlib
from pathlib import PurePosixPath

from service.content.domain.model import WORKING_CONTENT_CONFLICT, ContentError
from service.platform.citations import CitationDocument, PdfMaterialization
from service.platform.content import ArtifactScope, ArtifactScopeKind, ContentPort
from service.platform.pdf import PdfDocumentError, PdfPasswordError, pdf_document_text

MATERIALIZER_VERSION = "pdfium-text-v2"
MAX_DOCUMENT_BYTES = 100_000_000
MAX_DOCUMENT_PAGES = 2_000
MAX_TEXT_BYTES = 16_000_000
MIN_TEXT_CHARACTERS = 32
PAGE_SEPARATOR = "\n\f\n"
TEXT_ENCODING = "utf-8"


def _target_parts(target: str) -> tuple[str, ...]:
    path = PurePosixPath(target)
    if (
        path.is_absolute()
        or not path.parts
        or ".." in path.parts
        or "\\" in target
        or ":" in target
        or path.suffix.casefold() != ".txt"
    ):
        raise ValueError("pdf_materialize_target_invalid")
    return path.parts


def _extract(document: CitationDocument) -> tuple[bytes, int]:
    if not document.payload:
        raise ValueError("pdf_materialize_source_unavailable")
    if len(document.payload) > MAX_DOCUMENT_BYTES:
        raise ValueError("pdf_materialize_source_too_large")
    try:
        pages = pdf_document_text(document.payload)
        if len(pages) > MAX_DOCUMENT_PAGES:
            raise ValueError("pdf_materialize_too_many_pages")
    except PdfPasswordError as error:
        raise ValueError("pdf_materialize_encrypted") from error
    except PdfDocumentError as error:
        raise ValueError("pdf_materialize_invalid_pdf") from error
    except ValueError:
        raise
    text = PAGE_SEPARATOR.join(page.rstrip("\n") for page in pages).strip()
    if len(text) < MIN_TEXT_CHARACTERS:
        raise ValueError("pdf_materialize_text_layer_missing")
    payload = (text + "\n").encode(TEXT_ENCODING)
    if len(payload) > MAX_TEXT_BYTES:
        raise ValueError("pdf_materialize_text_too_large")
    return payload, len(pages)


class PdfMaterializer:
    def __init__(self, content: ContentPort) -> None:
        self._content = content

    def prepare(self, document: CitationDocument) -> PdfMaterialization:
        payload, page_count = _extract(document)
        return PdfMaterialization(
            payload=payload,
            revision=document.revision,
            page_count=page_count,
            digest=hashlib.sha256(payload).hexdigest(),
        )

    def publish(self, prepared: PdfMaterialization, session_id: str, target: str) -> dict:
        _target_parts(target)
        try:
            reused = self._content.publish_working_bytes(
                ArtifactScope(ArtifactScopeKind.SESSION, session_id), target, prepared.payload
            )
        except ContentError as error:
            if error.code == WORKING_CONTENT_CONFLICT:
                raise ValueError("pdf_materialize_target_conflict") from error
            raise
        return {
            "ok": True,
            "state": "ready",
            "target": target,
            "revision": prepared.revision,
            "materializer_version": MATERIALIZER_VERSION,
            "page_count": prepared.page_count,
            "text_bytes": len(prepared.payload),
            "digest": prepared.digest,
            "reused": reused,
        }

    def materialize(self, document: CitationDocument, session_id: str, target: str) -> dict:
        return self.publish(self.prepare(document), session_id, target)
