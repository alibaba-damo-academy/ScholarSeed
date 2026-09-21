"""Resolve Content-owned files and directories for Assistant turn snapshots.

The Assistant domain owns queue state and admission. Content owns path resolution and
file decoding, so this adapter lives here and is registered only by the composition
root. Project references remain project-relative. A file may also use an absolute path
when the composition root supplies an owner-validated reader; directories remain relative.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping
from io import BytesIO
from pathlib import Path
from types import MappingProxyType

from pypdf import PdfReader
from pypdf.errors import PyPdfError

from service.content.domain.model import ContentError
from service.content.service.extract import DOCX_SUFFIX, ContentExtractionError, decode_docx
from service.content.service.port import ContentService
from service.content.service.spreadsheet import decode_csv
from service.content.service.xlsx import decode as decode_xlsx
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

SUPPORTED_KINDS = frozenset((ContextRefKind.FILE, ContextRefKind.DIR))
PDF_MEDIA_TYPE = "application/pdf"
DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
TEXT_MEDIA_PREFIX = "text/"
PDF_SUFFIX = ".pdf"
CSV_SUFFIX = ".csv"
XLSX_SUFFIX = ".xlsx"
UTF8_ENCODING = "utf-8"
REASON_SOURCE_MISSING = "source_missing"
REASON_SOURCE_FORBIDDEN = "source_forbidden"
REASON_SOURCE_UNSUPPORTED = "source_type_unsupported"
REASON_SOURCE_UNAVAILABLE = "source_unavailable"
REASON_SOURCE_STALE = "source_revision_changed"
PROVIDER_VERSION = "content-context/v2"
REVISION_PREFIX = "sha256:"

ContextDecoder = Callable[[bytes], str]
AbsoluteFileReader = Callable[[str], tuple[bytes, str]]


def _decode_pdf(payload: bytes) -> str:
    try:
        reader = PdfReader(BytesIO(payload))
        text = "\n\n".join((page.extract_text() or "").strip() for page in reader.pages)
    except PyPdfError as exc:
        raise ContentError(REASON_SOURCE_UNSUPPORTED) from exc
    if not text.strip():
        raise ContentError(REASON_SOURCE_UNSUPPORTED)
    return text


def _decode_docx(payload: bytes) -> str:
    try:
        return decode_docx(payload)
    except ContentExtractionError as exc:
        raise ContentError(REASON_SOURCE_UNSUPPORTED) from exc


def _decode_csv(payload: bytes) -> str:
    try:
        return decode_csv(payload)
    except (UnicodeDecodeError, ValueError) as exc:
        raise ContentError(REASON_SOURCE_UNSUPPORTED) from exc


def _decode_xlsx(payload: bytes) -> str:
    try:
        return decode_xlsx(payload)
    except (UnicodeDecodeError, ValueError) as exc:
        raise ContentError(REASON_SOURCE_UNSUPPORTED) from exc


DEFAULT_DECODERS: Mapping[str, ContextDecoder] = MappingProxyType(
    {
        PDF_MEDIA_TYPE: _decode_pdf,
        PDF_SUFFIX: _decode_pdf,
        DOCX_MEDIA_TYPE: _decode_docx,
        DOCX_SUFFIX: _decode_docx,
        CSV_SUFFIX: _decode_csv,
        XLSX_SUFFIX: _decode_xlsx,
    }
)


class ContentContextProvider:
    """Assistant provider for project files and owner-validated absolute files."""

    def __init__(
        self,
        content: ContentService,
        *,
        decoders: Mapping[str, ContextDecoder] | None = None,
        absolute_file_reader: AbsoluteFileReader | None = None,
    ) -> None:
        self._content = content
        self._decoders = dict(decoders or DEFAULT_DECODERS)
        self._absolute_file_reader = absolute_file_reader

    def citation_document(
        self, project_id: str, ref: ContextRef, *, scope: ContextRef | None = None
    ) -> CitationDocument:
        if not project_id:
            raise ValueError(REASON_SOURCE_FORBIDDEN)
        if scope is not None:
            payload, media_type = self._content.read_scoped_bytes(
                project_id, ref.source_id, scope.source_id
            )
        else:
            payload, media_type = self._bytes(project_id, ref.source_id)
        if media_type != PDF_MEDIA_TYPE and Path(ref.source_id).suffix.lower() != PDF_SUFFIX:
            raise ValueError(REASON_SOURCE_UNSUPPORTED)
        revision = self._revision(payload)
        if ref.source_revision and ref.source_revision != revision:
            raise ValueError(REASON_SOURCE_STALE)
        return CitationDocument(project_id, ref.source_id, ref.label, revision, payload)

    def resolve(self, request: AssistantContextResolveRequest) -> AssistantContextResolution:
        ref = request.ref
        if ref.kind not in SUPPORTED_KINDS:
            return self._failure(ContextResolutionState.UNSUPPORTED, REASON_SOURCE_UNSUPPORTED)
        if not request.project_id:
            return self._failure(ContextResolutionState.FORBIDDEN, REASON_SOURCE_FORBIDDEN)
        try:
            if ref.kind is ContextRefKind.FILE:
                text, revision, media_type = self._file(request.project_id, ref.source_id)
                if (
                    ref.anchor is not None
                    and ref.source_revision
                    and ref.source_revision != revision
                ):
                    return self._failure(ContextResolutionState.STALE, REASON_SOURCE_STALE)
                excerpt = text[: request.budget.max_chars]
                truncated = len(excerpt) < len(text)
                return AssistantContextResolution(
                    state=(
                        ContextResolutionState.TRUNCATED
                        if truncated
                        else ContextResolutionState.READY
                    ),
                    provider_version=PROVIDER_VERSION,
                    source_revision=revision,
                    items=(
                        AssistantContextResolvedItem(
                            item_id=ref.source_id,
                            source_id=ref.source_id,
                            label=ref.label,
                            source_revision=revision,
                            text=excerpt,
                            content_hash=self._revision(excerpt.encode(UTF8_ENCODING)),
                            media_type=media_type,
                            truncated=truncated,
                        ),
                    ),
                )
            return self._directory(request)
        except ContentError as exc:
            state, reason = self._content_failure(exc)
            return self._failure(state, reason)
        except (OSError, ValueError):
            return self._failure(ContextResolutionState.UNAVAILABLE, REASON_SOURCE_UNAVAILABLE)

    def _file(self, project_id: str, source_id: str) -> tuple[str, str, str]:
        payload, media_type = self._bytes(project_id, source_id)
        revision = self._revision(payload)
        return self._decode(payload, media_type, source_id), revision, media_type

    def _bytes(self, project_id: str, source_id: str) -> tuple[bytes, str]:
        if not Path(source_id).is_absolute():
            return self._content.read_bytes(project_id, source_id)
        project = self._content.project_for_path(source_id)
        if project is not None and project.id == project_id:
            relative = self._content.project_relative(project.id, source_id)
            return self._content.read_bytes(project.id, relative)
        if self._absolute_file_reader is None:
            raise ContentError("path_not_authorized")
        return self._absolute_file_reader(source_id)

    def _decode(self, payload: bytes, media_type: str, source_id: str) -> str:
        suffix = Path(source_id).suffix.lower()
        decoder = self._decoders.get(media_type) or self._decoders.get(suffix)
        if decoder is not None:
            return decoder(payload)
        if media_type.startswith(TEXT_MEDIA_PREFIX):
            return payload.decode(UTF8_ENCODING)
        try:
            return payload.decode(UTF8_ENCODING)
        except UnicodeDecodeError as exc:
            raise ContentError(REASON_SOURCE_UNSUPPORTED) from exc

    def _directory(
        self,
        request: AssistantContextResolveRequest,
    ) -> AssistantContextResolution:
        ref = request.ref
        root = Path(self._content.resolve(request.project_id, ref.source_id))
        if not root.is_dir():
            raise ContentError("file_not_found")
        # A directory is an authorized search scope, not eagerly admitted material.  Its
        # revision identifies the logical scope and its current resolved locator; child
        # membership is deliberately not scanned or frozen here.
        locator = str(root.resolve())
        revision = self._revision(f"{ref.source_id}\n{locator}".encode(UTF8_ENCODING))
        if ref.source_revision and ref.source_revision != revision:
            return self._failure(ContextResolutionState.STALE, REASON_SOURCE_STALE)
        return AssistantContextResolution(
            state=ContextResolutionState.READY,
            provider_version=PROVIDER_VERSION,
            source_revision=revision,
            items=(
                AssistantContextResolvedItem(
                    item_id=ref.source_id,
                    source_id=ref.source_id,
                    label=ref.label,
                    source_revision=revision,
                    text="",
                    role=ContextItemRole.SCOPE,
                    model_locator=locator,
                ),
            ),
        )

    @staticmethod
    def _failure(
        state: ContextResolutionState,
        reason: str,
    ) -> AssistantContextResolution:
        return AssistantContextResolution(
            state=state,
            provider_version=PROVIDER_VERSION,
            issues=(AssistantContextIssue(code=reason),),
        )

    @staticmethod
    def _revision(payload: bytes) -> str:
        return f"{REVISION_PREFIX}{hashlib.sha256(payload).hexdigest()}"

    @staticmethod
    def _content_failure(exc: ContentError) -> tuple[ContextResolutionState, str]:
        reason = str(exc)
        if reason in ("file_not_found", "unknown_project"):
            return ContextResolutionState.MISSING, REASON_SOURCE_MISSING
        if reason in ("path_outside_project", "path_not_authorized"):
            return ContextResolutionState.FORBIDDEN, REASON_SOURCE_FORBIDDEN
        if reason in ("not_text_file", REASON_SOURCE_UNSUPPORTED):
            return ContextResolutionState.UNSUPPORTED, REASON_SOURCE_UNSUPPORTED
        return ContextResolutionState.UNAVAILABLE, reason or REASON_SOURCE_UNAVAILABLE


__all__ = ["ContentContextProvider"]
