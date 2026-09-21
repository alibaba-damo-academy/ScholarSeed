"""Identify a PDF's own paper identifiers using first-page geometry and XMP."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from service.platform.pdf import PdfRect, pdf_document_info, pdf_metadata, pdf_page_layout

LOGGER = logging.getLogger(__name__)
BODY_MIN_LENGTH = 20
HORIZONTAL_TOLERANCE = 0.01
VERTICAL_THRESHOLD = 0.5
BOX_TOLERANCE = 2
MIN_BODY_LINES = 3
FIRST_PAGE = 1
MIN_MONTH = 1
MAX_MONTH = 12
LINK_SCHEMES = ("http://", "https://")
ARXIV = "arxiv"
DOI = "doi"
ARXIV_PATTERNS = (
    re.compile(r"arXiv\s*[:\-]?\s*(?P<id>\d{4}\s*\.\s*\d{4,5})\s*(?P<version>v\d+)?", re.I),
    re.compile(
        r"arXiv\s*[:\-]?\s*(?P<id>[a-z\-]+(?:\.[A-Za-z]{2})?/\d{7})\s*(?P<version>v\d+)?",
        re.I,
    ),
    re.compile(r"arxiv\.org/(?:abs|pdf)/(?P<id>\d{4}\.\d{4,5})(?P<version>v\d+)?", re.I),
)
ARXIV_MONTH = re.compile(r"\d{2}(\d{2})\.\d{4,5}")
DOI_PATTERN = re.compile(r'(?<!\d)(?P<id>10\s*\.\s*\d{4,9}\s*/\s*[^\s"<>{}\[\]|]+)', re.I)
DOI_URL_PATTERN = re.compile(r'doi\.org/(?P<id>10\.\d{4,9}/[^\s"<>]+)', re.I)
DOI_CONTINUATION = re.compile(r"\s+([A-Za-z0-9][A-Za-z0-9.\-;()/_:]*)")
DOI_WRAP_ENDINGS = "./-;:"
DOI_TRAILING_PUNCTUATION = ".,;:)]}>"


@dataclass(frozen=True)
class _Identifier:
    kind: str
    value: str
    version: str = ""


def _clean_doi(value: str) -> str:
    return re.sub(r"\s+", "", value).rstrip(DOI_TRAILING_PUNCTUATION)


def _matches(text: str, *, stitch: bool = False) -> list[_Identifier]:
    found: list[_Identifier] = []
    for pattern in ARXIV_PATTERNS:
        for match in pattern.finditer(text):
            value = re.sub(r"\s+", "", match.group("id"))
            month = ARXIV_MONTH.fullmatch(value)
            if month is None or MIN_MONTH <= int(month.group(1)) <= MAX_MONTH:
                found.append(_Identifier(ARXIV, value, match.group("version") or ""))
    for match in DOI_PATTERN.finditer(text):
        value = _clean_doi(match.group("id"))
        if stitch and value[-1:] in DOI_WRAP_ENDINGS:
            tail = DOI_CONTINUATION.match(text[match.end() :])
            if tail:
                value += tail.group(1).rstrip(".,;:")
        found.append(_Identifier(DOI, value))
    return found


def _outside(box: PdfRect, body: list[PdfRect], direction: tuple | None = None) -> bool:
    if direction is not None and abs(direction[1]) > VERTICAL_THRESHOLD:
        return True
    others = [
        rect
        for rect in body
        if not (
            rect.x0 >= box.x0 - BOX_TOLERANCE
            and rect.x1 <= box.x1 + BOX_TOLERANCE
            and rect.top >= box.top - BOX_TOLERANCE
            and rect.bottom <= box.bottom + BOX_TOLERANCE
        )
    ]
    if len(others) < MIN_BODY_LINES:
        return True
    return (
        box.x1 <= min(rect.x0 for rect in others) + BOX_TOLERANCE
        or box.x0 >= max(rect.x1 for rect in others) - BOX_TOLERANCE
        or box.bottom <= min(rect.top for rect in others) + BOX_TOLERANCE
        or box.top >= max(rect.bottom for rect in others) - BOX_TOLERANCE
    )


def extract_identifiers(payload: bytes) -> tuple[str, str]:
    lines_found: list[_Identifier] = []
    blocks_found: list[_Identifier] = []
    links_found: list[_Identifier] = []
    if pdf_document_info(payload).page_count:
        page = pdf_page_layout(payload, FIRST_PAGE)
        body = [
            line.bounds
            for line in page.lines
            if len(line.text) >= BODY_MIN_LENGTH and not line.vertical
        ]
        for line in page.lines:
            direction = (0, 1) if line.vertical else (1, 0)
            if _outside(line.bounds, body, direction):
                lines_found.extend(_matches(line.text))
        for block in page.blocks:
            if "\n" in block.text and _outside(block.bounds, body):
                blocks_found.extend(_matches(block.text, stitch=True))
        for link in page.links:
            uri = link.uri
            if not uri.lower().startswith(LINK_SCHEMES):
                continue
            if not _outside(link.bounds, body):
                continue
            for match in ARXIV_PATTERNS[-1].finditer(uri):
                links_found.append(
                    _Identifier(ARXIV, match.group("id"), match.group("version") or "")
                )
            for match in DOI_URL_PATTERN.finditer(uri):
                links_found.append(_Identifier(DOI, _clean_doi(match.group("id"))))
    candidates = lines_found + blocks_found + links_found
    xmp = pdf_metadata(payload).xmp
    candidates.extend(
        _Identifier(DOI, _clean_doi(match.group("id"))) for match in DOI_PATTERN.finditer(xmp)
    )
    arxiv_ids = {candidate.value for candidate in candidates if candidate.kind == ARXIV}
    dois = {candidate.value for candidate in candidates if candidate.kind == DOI}
    arxiv = ""
    if len(arxiv_ids) == 1:
        chosen = next(candidate for candidate in candidates if candidate.kind == ARXIV)
        arxiv = chosen.value + chosen.version
    return arxiv, next(iter(dois)) if len(dois) == 1 else ""
