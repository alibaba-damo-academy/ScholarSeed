"""Anonymous DOI/arXiv BibTeX retrieval without provider fallback."""

from __future__ import annotations

import re
from urllib.parse import quote

import httpx

from service.literature.schema import PublicationType
from service.literature.service.metadata import parse_bibtex

DOI = "doi"
ARXIV = "arxiv"
ENDPOINTS = {DOI: "https://doi.org/", ARXIV: "https://arxiv.org/bibtex/"}
IDENTIFIER_PATTERNS = {
    DOI: re.compile(r"10\.\d{4,9}/\S+", re.IGNORECASE),
    ARXIV: re.compile(r"(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?/\d{7})(?:v\d+)?", re.IGNORECASE),
}
IDENTIFIER_PREFIXES = {
    DOI: ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "doi:"),
    ARXIV: ("https://arxiv.org/abs/", "https://arxiv.org/pdf/", "arxiv:"),
}
BIBTEX_ACCEPT = "application/x-bibtex"
NETWORK_FAILED = "PAPER_META_NETWORK_FAILED"
NOT_FOUND = "PAPER_META_NOT_FOUND"
UPSTREAM_FAILED = "PAPER_META_UPSTREAM_FAILED"
INVALID_IDENTIFIER = "PAPER_META_IDENTIFIER_INVALID"
QUOTA_EXHAUSTED = "PAPER_META_QUOTA_EXHAUSTED"
HTTP_OK = 200
HTTP_NOT_FOUND = 404
HTTP_GONE = 410
HTTP_RATE_LIMITED = 429
HTTP_BAD_GATEWAY = 502
HTTP_BAD_REQUEST = 400
SINGLE_RECORD = 1
FIELD_MAPPING = {
    "title": "title",
    "authors": "authors",
    "journal": "publication",
    "year": "year",
    "doi": "doi",
    "arxiv": "arxiv",
    "abstract": "abstract",
    "url": "url",
    "citation_key": "citation_key",
    "publisher": "publisher",
    "address": "address",
    "volume": "volume",
    "number": "number",
    "pages": "pages",
    "isbn": "isbn",
}


class BibliographyError(ValueError):
    def __init__(self, code: str, status: int) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def _identifier(kind: str, value: str) -> str:
    identifier = value.strip()
    for prefix in IDENTIFIER_PREFIXES[kind]:
        if identifier.lower().startswith(prefix):
            identifier = identifier[len(prefix) :].strip()
            break
    if kind == ARXIV:
        identifier = identifier.removesuffix(".pdf")
    if not IDENTIFIER_PATTERNS[kind].fullmatch(identifier):
        raise BibliographyError(INVALID_IDENTIFIER, HTTP_BAD_REQUEST)
    return identifier


async def fetch_bibliography(
    kind: str,
    value: str,
    *,
    timeout: float,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    identifier = _identifier(kind, value)
    url = ENDPOINTS[kind] + quote(identifier, safe="/")
    try:
        async with httpx.AsyncClient(
            timeout=timeout, follow_redirects=True, transport=transport
        ) as client:
            response = await client.get(url, headers={"Accept": BIBTEX_ACCEPT})
    except httpx.HTTPError as error:
        raise BibliographyError(NETWORK_FAILED, HTTP_BAD_GATEWAY) from error
    if response.status_code in (HTTP_NOT_FOUND, HTTP_GONE) or (
        response.status_code == HTTP_OK and not response.text.strip()
    ):
        raise BibliographyError(NOT_FOUND, HTTP_NOT_FOUND)
    if response.status_code == HTTP_RATE_LIMITED:
        raise BibliographyError(QUOTA_EXHAUSTED, HTTP_RATE_LIMITED)
    if response.status_code != HTTP_OK:
        raise BibliographyError(UPSTREAM_FAILED, HTTP_BAD_GATEWAY)
    try:
        records = parse_bibtex(response.text)
    except ValueError as error:
        raise BibliographyError(UPSTREAM_FAILED, HTTP_BAD_GATEWAY) from error
    if len(records) != SINGLE_RECORD or not records[0].title.strip():
        raise BibliographyError(UPSTREAM_FAILED, HTTP_BAD_GATEWAY)
    record = records[0]
    fields = {
        target: getattr(record, source)
        for source, target in FIELD_MAPPING.items()
        if getattr(record, source) not in ("", None)
    }
    result = {"success": True, "fields": fields}
    if record.bib_type in {value.value for value in PublicationType}:
        result["bib_type"] = record.bib_type
    return result
