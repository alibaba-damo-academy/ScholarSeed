"""Identify a PDF's own paper identifiers using first-page geometry and XMP."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import pymupdf

LOGGER = logging.getLogger(__name__)
BODY_MIN_LENGTH = 20
HORIZONTAL_TOLERANCE = 0.01
VERTICAL_THRESHOLD = 0.5
BOX_TOLERANCE = 2
MIN_BODY_LINES = 3
FIRST_PAGE = 0
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


def _outside(box: pymupdf.Rect, body: list[pymupdf.Rect], direction: tuple | None = None) -> bool:
    if direction is not None and abs(direction[1]) > VERTICAL_THRESHOLD:
        return True
    others = [
        rect
        for rect in body
        if not (
            rect.x0 >= box.x0 - BOX_TOLERANCE
            and rect.x1 <= box.x1 + BOX_TOLERANCE
            and rect.y0 >= box.y0 - BOX_TOLERANCE
            and rect.y1 <= box.y1 + BOX_TOLERANCE
        )
    ]
    if len(others) < MIN_BODY_LINES:
        return True
    return (
        box.x1 <= min(rect.x0 for rect in others) + BOX_TOLERANCE
        or box.x0 >= max(rect.x1 for rect in others) - BOX_TOLERANCE
        or box.y1 <= min(rect.y0 for rect in others) + BOX_TOLERANCE
        or box.y0 >= max(rect.y1 for rect in others) - BOX_TOLERANCE
    )


def extract_identifiers(document: pymupdf.Document) -> tuple[str, str]:
    lines_found: list[_Identifier] = []
    blocks_found: list[_Identifier] = []
    links_found: list[_Identifier] = []
    if document.page_count:
        page = document[FIRST_PAGE]
        blocks = [block for block in page.get_text("dict")["blocks"] if block["type"] == 0]
        body = [
            pymupdf.Rect(line["bbox"])
            for block in blocks
            for line in block["lines"]
            if len("".join(span["text"] for span in line["spans"]).strip()) >= BODY_MIN_LENGTH
            and abs(line["dir"][1]) < HORIZONTAL_TOLERANCE
        ]
        for block in blocks:
            texts = []
            for line in block["lines"]:
                text = "".join(span["text"] for span in line["spans"])
                texts.append(text)
                if _outside(pymupdf.Rect(line["bbox"]), body, tuple(line["dir"])):
                    lines_found.extend(_matches(text))
            if len(texts) > 1 and _outside(pymupdf.Rect(block["bbox"]), body):
                blocks_found.extend(_matches("\n".join(texts), stitch=True))
        for link in page.get_links():
            uri = link.get("uri") or ""
            if not uri.lower().startswith(LINK_SCHEMES):
                continue
            if not _outside(pymupdf.Rect(link["from"]), body):
                continue
            for match in ARXIV_PATTERNS[-1].finditer(uri):
                links_found.append(
                    _Identifier(ARXIV, match.group("id"), match.group("version") or "")
                )
            for match in DOI_URL_PATTERN.finditer(uri):
                links_found.append(_Identifier(DOI, _clean_doi(match.group("id"))))
    candidates = lines_found + blocks_found + links_found
    try:
        xmp = document.get_xml_metadata() or ""
    except RuntimeError:
        LOGGER.warning("PDF XMP metadata could not be read; retaining page identifiers")
        xmp = ""
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
