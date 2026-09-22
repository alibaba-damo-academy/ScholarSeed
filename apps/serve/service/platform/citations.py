"""Versioned source fragments shared by Assistant and Workbench."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from service.platform.context import ContextRef
from service.platform.records import RecordTarget

CITATION_SCHEME = "scholarseed-cite:"
ATTACHMENT_SOURCE_KIND = "attachment"
PDF_MEDIA_TYPE = "application/pdf"
LITERATURE_STORAGE = "literature"
PDF_INDEX_STATE = "pdf_indexes"
LIBRARY_REF_PREFIX = "literature:"
LITERATURE_NOT_FOUND = "literature_not_found"
LITERATURE_PROJECT_REQUIRED = "literature_project_required"
PDF_CAPTION = "caption"
PDF_FIGURE = "figure"
PDF_FORMULA = "formula"
PDF_TABLE = "table"
PDF_TEXT_EXCLUDE = "exclude"
PDF_TEXT_RETAIN = "retain"

CitationAnswerFilter = Callable[[str, str, str], str]


@dataclass(frozen=True)
class CitationDocument:
    project_id: str
    path: str
    title: str
    revision: str
    payload: bytes
    session_id: str = ""
    reference_id: str = ""
    storage_scope: str = "project"
    # Annotation owner of these exact bytes; absent when the source has no PDF records.
    record_target: RecordTarget | None = None


@dataclass(frozen=True)
class CitationPage:
    page: int
    quads: tuple[tuple[float, float, float, float], ...]


@dataclass(frozen=True)
class PdfSpan:
    start: int
    end: int
    page: int
    quad: tuple[float, float, float, float]


@dataclass(frozen=True)
class PdfFragment:
    fragment_id: str
    text: str
    pages: tuple[CitationPage, ...]
    kind: str = "passage"
    spans: tuple[PdfSpan, ...] = ()
    continuity: int = 0


@dataclass(frozen=True)
class PdfOmission:
    kind: str
    reason: str
    pages: tuple[CitationPage, ...]


@dataclass(frozen=True)
class PdfVisualRegion:
    region_id: str
    kind: str
    reason: str
    text_policy: str
    page: int
    quad: tuple[float, float, float, float]


@dataclass(frozen=True)
class PdfIndex:
    index_id: str
    revision: str
    fragments: tuple[PdfFragment, ...]
    page_count: int
    unavailable_pages: tuple[int, ...] = ()
    omissions: tuple[PdfOmission, ...] = ()
    regions: tuple[PdfVisualRegion, ...] = ()


@dataclass(frozen=True)
class PdfPageContent:
    page: int
    fragments: tuple[PdfFragment, ...]
    unavailable: bool = False
    omissions: tuple[PdfOmission, ...] = ()
    regions: tuple[PdfVisualRegion, ...] = ()


@dataclass(frozen=True)
class LiteraturePageRead:
    document: CitationDocument
    total_pages: int
    pages: tuple[PdfPageContent, ...]


@dataclass(frozen=True)
class PdfMaterialization:
    payload: bytes
    revision: str
    page_count: int
    digest: str


class CitationDocumentProvider(Protocol):
    def citation_document(
        self, project_id: str, ref: ContextRef, *, scope: ContextRef | None = None
    ) -> CitationDocument: ...


class PdfIndexPort(Protocol):
    def prepare(self, document: CitationDocument, *, retry: bool = False) -> dict: ...
    def index(self, document: CitationDocument, *, wait: bool = False) -> PdfIndex | None: ...
    def page_count(self, document: CitationDocument) -> int: ...
    def pages(
        self, document: CitationDocument, start_page: int, end_page: int
    ) -> tuple[PdfPageContent, ...]: ...


class PdfIndexForgetPort(Protocol):
    """Drops cached full-text indexes whose source content no longer exists."""

    def forget_literature(self, revisions: tuple[str, ...]) -> int: ...


class PdfPreviewPort(Protocol):
    def render(self, document: CitationDocument, page: CitationPage, *, precise: bool) -> bytes: ...


class PdfMaterializerPort(Protocol):
    def prepare(self, document: CitationDocument) -> PdfMaterialization: ...
    def publish(self, prepared: PdfMaterialization, root: Path, target: str) -> dict: ...


class PdfAttachmentPort(Protocol):
    def pdf_references(self, session_id: str, turn_id: str) -> tuple[dict, ...]: ...
    def pdf_document(
        self, session_id: str, turn_id: str, reference_id: str
    ) -> CitationDocument: ...


class LiteratureEvidencePort(Protocol):
    def locate(self, document: CitationDocument, text: str) -> list[dict]: ...
    def discover(self, project_id: str, query: str, offset: int, limit: int) -> dict: ...
    def discover_metadata(self, project_id: str, query: str, offset: int, limit: int) -> dict: ...
    def catalog(self, project_id: str, offset: int, limit: int) -> dict: ...
    def metadata(self, project_id: str, source_id: str) -> dict: ...
    def read_pages(
        self, project_id: str, source_id: str, start_page: int, end_page: int
    ) -> LiteraturePageRead: ...
    def annotations(self, project_id: str, source_id: str, offset: int, limit: int) -> dict: ...
    def document(self, project_id: str, source_id: str) -> CitationDocument: ...
    def preferred(
        self, document: CitationDocument, source_id: str = "", *, retry: bool = False
    ) -> dict: ...
