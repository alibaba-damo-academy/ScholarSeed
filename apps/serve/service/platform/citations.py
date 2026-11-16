"""Versioned source fragments shared by Assistant and Workbench."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Annotated, Callable, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from service.platform.context import ContextRef, FulltextBindingScope, FulltextTaskContext
from service.platform.records import RecordTarget

CITATION_SCHEME = "scholarseed-cite:"
CITATION_PRESENTATION_NOTICE = (
    "For generated Markdown reports, these presentation rules do not change existing citation "
    "requirements. Citation links may use [1](citation_url), copying the full returned "
    "citation_url exactly into the link destination. Optional citation comparison tables or "
    "source lists may show paper titles, page numbers, original excerpts and clickable citations. "
    "In reader-facing answers and reports, keep scholarseed-cite: addresses in Markdown link "
    "destinations rather than displaying bare addresses. Do not expose internal source identifiers "
    "such as ref_id or fragment_ids in the answer, unless the user explicitly requests "
    "raw addresses or debugging information."
)
ATTACHMENT_SOURCE_KIND = "attachment"
PDF_MEDIA_TYPE = "application/pdf"
LITERATURE_STORAGE = "literature"
PDF_INDEX_STATE = "pdf_indexes"
LIBRARY_REF_PREFIX = "literature:"
LIBRARY_COLLECTION_REF_PREFIX = "literature_collection:"
LITERATURE_NOT_FOUND = "literature_not_found"
LITERATURE_PROJECT_REQUIRED = "literature_project_required"
PDF_CAPTION = "caption"
PDF_FIGURE = "figure"
PDF_FORMULA = "formula"
PDF_TABLE = "table"
PDF_TEXT_EXCLUDE = "exclude"
PDF_TEXT_RETAIN = "retain"

CitationAnswerFilter = Callable[[str, str, str], str]


class CitationReference(BaseModel):
    model_config = ConfigDict(extra="forbid", str_min_length=1)
    handle: str


class AnswerCitationReference(CitationReference):
    kind: Literal["answer"]
    session_id: str
    answer_id: str
    answer_revision: str


class SavedCitationReference(CitationReference):
    kind: Literal["saved"]
    project_id: str
    path: str


class ArtifactCitationReference(CitationReference):
    kind: Literal["artifact"]
    session_id: str
    artifact_id: str
    revision: str


PdfCitationSource = Annotated[
    AnswerCitationReference | SavedCitationReference | ArtifactCitationReference,
    Field(discriminator="kind"),
]
PdfCitationReader = Callable[[PdfCitationSource, str], tuple[bytes, str]]


class CitationSourceChanged(ValueError):
    """The provider rejects bytes that no longer match the retained source version."""


@dataclass(frozen=True)
class WebEvidencePage:
    url: str
    final_url: str
    text: str
    revision: str
    fetched_at: str
    origin: str = "page"


class WebEvidenceReader(Protocol):
    async def fetch_page(self, url: str) -> WebEvidencePage: ...


#: Bytes serve holds on the product's behalf (acquired full texts). Readable through
#: the bridge only; never copied whole into an agent workspace.
MANAGED_STORAGE_SCOPE = "managed"


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
    def status(self, document: CitationDocument) -> dict: ...
    def index(self, document: CitationDocument, *, wait: bool = False) -> PdfIndex | None: ...
    def page_count(self, document: CitationDocument) -> int: ...
    def pages(
        self, document: CitationDocument, start_page: int, end_page: int
    ) -> tuple[PdfPageContent, ...]: ...


class PdfIndexForgetPort(Protocol):
    """Drops cached full-text indexes whose source content no longer exists."""

    def forget_literature(self, revisions: tuple[str, ...]) -> int: ...


class PdfPreviewPort(Protocol):
    def render(
        self, document: CitationDocument, citation_page: CitationPage, *, precise: bool
    ) -> bytes: ...


class PdfMaterializerPort(Protocol):
    def prepare(self, document: CitationDocument) -> PdfMaterialization: ...
    def publish(self, prepared: PdfMaterialization, session_id: str, target: str) -> dict: ...


class PdfAttachmentPort(Protocol):
    def pdf_references(self, session_id: str, turn_id: str) -> tuple[dict, ...]: ...
    def pdf_document(
        self, session_id: str, turn_id: str, reference_id: str
    ) -> CitationDocument: ...


class ManagedFulltextPort(Protocol):
    """Bytes acquired by the product on behalf of an authorized precise search."""

    def managed_fulltext_document(
        self,
        project_id: str,
        paper_id: str,
        *,
        task_context: FulltextTaskContext | FulltextBindingScope | None = None,
    ) -> CitationDocument | None: ...

    def citation_document(
        self, project_id: str, paper_id: str, *, session_id: str, revision: str
    ) -> CitationDocument | None: ...


class LiteratureEvidencePort(Protocol):
    def locate(self, document: CitationDocument, text: str) -> list[dict]: ...
    def discover(self, project_id: str, query: str, offset: int, limit: int) -> dict: ...
    def discover_metadata(self, project_id: str, query: str, offset: int, limit: int) -> dict: ...
    def catalog(
        self, project_id: str, offset: int, limit: int, query: str = "", view: str = "catalog"
    ) -> dict: ...
    def metadata(self, project_id: str, source_id: str) -> dict: ...
    def is_primary_attachment(
        self, project_id: str, source_id: str, attachment_id: str
    ) -> bool: ...
    def read_attachment(
        self, project_id: str, source_id: str, attachment_id: str, offset: int, limit: int
    ) -> dict | None: ...
    def read_pages(
        self,
        project_id: str,
        source_id: str,
        start_page: int,
        end_page: int,
        attachment_id: str | None = None,
    ) -> LiteraturePageRead: ...
    def knowledge(
        self,
        document: CitationDocument,
        sections: list[str],
        offset: int,
        limit: int,
        query: str = "",
        fields: list[str] | None = None,
        question: str = "",
    ) -> dict: ...
    def annotations(self, project_id: str, source_id: str, offset: int, limit: int) -> dict: ...
    def document(
        self, project_id: str, source_id: str, attachment_id: str | None = None
    ) -> CitationDocument: ...
    def preferred(
        self, document: CitationDocument, source_id: str = "", *, retry: bool = False
    ) -> dict: ...


EVIDENCE_BLOCK_CHARACTERS = 2_400
EVIDENCE_LINE_TOLERANCE = 0.2
PDF_FRAGMENT_SEPARATOR = "\n"


FORMULA_OPERATOR = re.compile(
    r"[=≤≥∈∑∫]|\\(?:frac|sum|le|ge)\b|\b(?:min|max|lim|sup|inf)\b|\(cid:\d+\)"
)
FORMULA_WORD_LIMIT = 12
FORMULA_HORIZONTAL_GAP = 0.06
FORMULA_DEFINITION = re.compile(r"^\s*(?:where\b|with\b|其中)", re.I)
FORMULA_DEFINITION_LINE_GAP = 1.0
FORMULA_DELIMITERS = (("(", ")"), ("[", "]"), ("{", "}"))
FORMULA_AGGREGATE = re.compile(r"[∑∫∏]|\\(?:sum|int|prod)\b|\b(?:min|max|lim|sup|inf)\b")
FORMULA_NATIVE_GLYPH = re.compile(r"\(cid:\d+\)")
FORMULA_WORD = re.compile(r"[A-Za-z]+")
FORMULA_PROSE = re.compile(r"[\u3400-\u9fff。！？]")
FORMULA_IDENTIFIER_LENGTH = 3
FORMULA_SCRIPT_HEIGHT = 1.0


def _math_piece(text: str) -> bool:
    """Short symbols/identifiers or function calls, not neighboring prose."""
    text = FORMULA_NATIVE_GLYPH.sub("", text)
    return not FORMULA_PROSE.search(text) and all(
        len(word[0]) <= FORMULA_IDENTIFIER_LENGTH
        or (word.start() > 0 and text[word.start() - 1].isalpha())
        or text[word.end() :].lstrip().startswith("(")
        or (word.start() > 0 and text[word.start() - 1] == "\\")
        for word in FORMULA_WORD.finditer(text)
    )


def _top_level_relation(text: str) -> bool:
    depth = 0
    for char in text:
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth = max(0, depth - 1)
        elif depth == 0 and char in "=≤≥∈":
            return True
    return False


def source_box(fragment: dict) -> tuple | None:
    pages = fragment.get("pages", [])
    if len(pages) != 1 or not pages[0].get("quads"):
        return None
    quads = pages[0]["quads"]
    return (
        pages[0]["page"],
        min(q[0] for q in quads),
        min(q[1] for q in quads),
        max(q[2] for q in quads),
        max(q[3] for q in quads),
    )


def _formula_continuation(members: list[dict], fragment: dict) -> bool:
    """Join short formula pieces on a shared equation band, including fractions."""
    candidates = [*members, fragment]
    if (
        any(part.get("kind") not in {"sentence", "passage"} for part in candidates)
        or not any(part.get("kind") == "passage" for part in candidates)
        or any(len(part["text"].split()) > FORMULA_WORD_LIMIT for part in candidates)
        or not any(FORMULA_OPERATOR.search(part["text"]) for part in candidates)
    ):
        return False
    left, right = source_box(members[-1]), source_box(fragment)
    if not left or not right:
        return False
    same_continuity = members[-1].get("continuity") is not None and members[-1].get(
        "continuity"
    ) == fragment.get("continuity")
    text = PDF_FRAGMENT_SEPARATOR.join(part["text"] for part in members)
    open_expression = any(
        text.count(left) > text.count(right) for left, right in FORMULA_DELIMITERS
    )
    passage_pieces = all(part.get("kind") == "passage" for part in candidates)
    same_band = (
        min(left[4], right[4]) > max(left[2], right[2])
        and 0 <= right[1] - left[3] <= FORMULA_HORIZONTAL_GAP
    )
    definition_line = (
        bool(FORMULA_DEFINITION.match(fragment["text"]))
        and bool(FORMULA_OPERATOR.search(fragment["text"]))
        and 0
        <= right[2] - left[4]
        <= min(left[4] - left[2], right[4] - right[2]) * FORMULA_DEFINITION_LINE_GAP
        and min(left[3], right[3]) > max(left[1], right[1])
    )
    # Layout engines give fractions and sum limits separate paragraph IDs.
    # Keep the equation's main band fixed; a subscript must not become the next
    # piece's baseline, nor may successive scripts expand the region unboundedly.
    root = source_box(members[0])
    equation = False
    script = False
    if root and passage_pieces and _math_piece(members[0]["text"]):
        boxes = [box for part in members if (box := source_box(part)) is not None]
        if len(boxes) == len(members):
            edge = max(box[3] for box in boxes)
            height = root[4] - root[2]
            in_band = min(root[4], right[4]) > max(root[2], right[2])
            extends_right = (
                -height * EVIDENCE_LINE_TOLERANCE <= right[1] - edge <= FORMULA_HORIZONTAL_GAP
            )
            # An equation is a two-dimensional region, not a sequence whose
            # first fragment must end in an operator or an unmatched bracket.
            # Relations in a new main-band piece still delimit independent equations.
            has_operator = bool(FORMULA_OPERATOR.search(text))
            script = any(
                (_math_piece(fragment["text"]) or FORMULA_AGGREGATE.search(part["text"]))
                and min(box[3], right[3]) > max(box[1], right[1])
                and right[3] - right[1] <= max(box[3] - box[1], root[3] - root[1], height)
                and (
                    not _top_level_relation(fragment["text"])
                    or FORMULA_AGGREGATE.search(part["text"])
                )
                and root[2] - height * FORMULA_SCRIPT_HEIGHT <= right[2]
                and right[4] <= root[4] + height * FORMULA_SCRIPT_HEIGHT
                and max(right[2] - box[4], box[2] - right[4], 0) <= height
                for part, box in zip(members, boxes)
            )
            equation = has_operator and (
                (
                    in_band
                    and extends_right
                    and _math_piece(fragment["text"])
                    and not _top_level_relation(fragment["text"])
                )
                or script
            )
    if (
        passage_pieces
        and _top_level_relation(fragment["text"])
        and not (open_expression or script or definition_line)
    ):
        return False
    return (
        equation
        or (same_band and (same_continuity or (passage_pieces and open_expression)))
        or (definition_line and (same_continuity or passage_pieces))
    )


def _source_groups(fragments: list[dict], *, prose: bool) -> list[list[dict]]:
    blocks: list[list[dict]] = []
    for fragment in sorted(fragments, key=lambda item: item.get("source_order", 0)):
        previous = blocks[-1][-1] if blocks else None
        join = False
        if (
            previous is not None
            and "source_order" in previous
            and "source_order" in fragment
            and fragment["source_order"] == previous["source_order"] + 1
            and previous.get("continuity") is not None
            and fragment.get("continuity") is not None
            and len(fragment.get("pages", [])) == len(previous.get("pages", [])) == 1
            and fragment["pages"][0]["page"] == previous["pages"][0]["page"]
            and sum(len(item["text"]) + 1 for item in blocks[-1]) + len(fragment["text"])
            <= EVIDENCE_BLOCK_CHARACTERS
        ):
            left = previous["pages"][0].get("quads", [])
            right = fragment["pages"][0].get("quads", [])
            if (
                prose
                and left
                and right
                and fragment.get("kind") == previous.get("kind") == "sentence"
                and fragment.get("continuity") == previous.get("continuity")
            ):
                tail, head = left[-1], right[0]
                height = min(tail[3] - tail[1], head[3] - head[1])
                join = (
                    height > 0
                    and abs(tail[1] - head[1]) <= height * EVIDENCE_LINE_TOLERANCE
                    and abs(tail[3] - head[3]) <= height * EVIDENCE_LINE_TOLERANCE
                    and 0 <= head[0] - tail[2] <= height
                )
            join = join or _formula_continuation(blocks[-1], fragment)
        if join:
            blocks[-1].append(fragment)
        else:
            blocks.append([fragment])
    return blocks


def formula_groups(fragments: list[dict]) -> list[list[dict]]:
    """Shared equation membership for evidence completion and citation binding."""
    return _source_groups(fragments, prose=False)


def evidence_blocks(fragments: list[dict]) -> list[dict]:
    """Coalesce adjacent evidence, retaining all text, member IDs and quads.

    Prose keeps native continuity. Equations include their two-dimensional
    fractions and sum limits across native IDs, with page/order/type boundaries.
    """
    blocks = _source_groups(fragments, prose=True)
    result = []
    for members in blocks:
        if len(members) == 1:
            result.append(members[0])
            continue
        identities = [item["fragment_id"] for item in members]
        result.append(
            {
                "fragment_id": ":".join(identities),
                "fragment_ids": identities,
                "sentence_ids": [
                    item["fragment_id"] for item in members if item.get("kind") == "sentence"
                ],
                "kind": "window",
                "text": PDF_FRAGMENT_SEPARATOR.join(item["text"] for item in members),
                "pages": [
                    {
                        "page": members[0]["pages"][0]["page"],
                        "quads": [quad for item in members for quad in item["pages"][0]["quads"]],
                    }
                ],
            }
        )
    return result
