"""Download full-text PDF attachments from literature identifiers."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote

import httpx

from service.literature.domain.model import MAX_IMPORT_BYTES
from service.literature.schema import LiteratureItem
from service.literature.service.arxiv import fetch_arxiv_pdf
from service.literature.service.extractor import InvalidPdfError, extract_pdf_metadata

DOI_RESOLVER_ROOT = "https://doi.org"
DOI_DOWNLOAD_TIMEOUT_SECONDS = 60.0
DOI_USER_AGENT = "ScholarSeed/1.0"
DOI_PREFIX = "doi:"
DOI_URL_PREFIXES = (
    "https://doi.org/",
    "http://doi.org/",
    "https://dx.doi.org/",
    "http://dx.doi.org/",
)
DOI_REQUIRED_PREFIX = "10."
PDF_CONTENT_TYPE = "application/pdf"

FULLTEXT_IDENTIFIER_MISSING = "FULLTEXT_IDENTIFIER_MISSING"
DOI_INVALID = "DOI_INVALID"
DOI_NOT_FOUND = "DOI_NOT_FOUND"
DOI_DOWNLOAD_FAILED = "DOI_DOWNLOAD_FAILED"
DOI_TOO_LARGE = "DOI_TOO_LARGE"
DOI_NO_ACCESSIBLE_PDF = "DOI_NO_ACCESSIBLE_PDF"


class FulltextDownloadError(ValueError):
    """A stable failure raised by DOI/arXiv full-text download."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class FulltextDownload:
    """A fetched full-text PDF and normalized identifier updates."""

    content: bytes
    arxiv: str | None = None
    doi: str | None = None


def normalize_doi(value: str) -> str:
    """Return a bare DOI string from a DOI value or resolver URL."""

    candidate = value.strip()
    for prefix in DOI_URL_PREFIXES:
        if candidate.lower().startswith(prefix):
            candidate = candidate[len(prefix) :]
            break
    if candidate.lower().startswith(DOI_PREFIX):
        candidate = candidate[len(DOI_PREFIX) :]
    candidate = candidate.strip().strip("/")
    if not candidate.lower().startswith(DOI_REQUIRED_PREFIX) or "/" not in candidate:
        raise FulltextDownloadError(DOI_INVALID)
    return candidate


def fetch_doi_pdf(value: str) -> tuple[str, bytes]:
    """Resolve a DOI and keep the response only when it is a valid bounded PDF."""

    doi = normalize_doi(value)
    url = f"{DOI_RESOLVER_ROOT}/{quote(doi, safe='/')}"
    content = bytearray()
    try:
        with httpx.Client(
            timeout=DOI_DOWNLOAD_TIMEOUT_SECONDS,
            follow_redirects=True,
            headers={"Accept": PDF_CONTENT_TYPE, "User-Agent": DOI_USER_AGENT},
        ) as client:
            with client.stream("GET", url) as response:
                if response.status_code == 404:
                    raise FulltextDownloadError(DOI_NOT_FOUND)
                response.raise_for_status()
                media_type = (
                    response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                )
                if media_type != PDF_CONTENT_TYPE:
                    raise FulltextDownloadError(DOI_NO_ACCESSIBLE_PDF)
                for chunk in response.iter_bytes():
                    content.extend(chunk)
                    if len(content) > MAX_IMPORT_BYTES:
                        raise FulltextDownloadError(DOI_TOO_LARGE)
    except FulltextDownloadError:
        raise
    except (httpx.HTTPError, OSError) as error:
        raise FulltextDownloadError(DOI_DOWNLOAD_FAILED) from error
    try:
        extract_pdf_metadata(bytes(content))
    except InvalidPdfError as error:
        raise FulltextDownloadError(DOI_NO_ACCESSIBLE_PDF) from error
    return doi, bytes(content)


def fetch_identifier_pdf(item: LiteratureItem) -> FulltextDownload:
    """Fetch full text by arXiv when available, otherwise by DOI."""

    if item.arxiv.strip():
        identifier, content = fetch_arxiv_pdf(item.arxiv)
        return FulltextDownload(content=content, arxiv=identifier)
    if item.doi.strip():
        identifier, content = fetch_doi_pdf(item.doi)
        return FulltextDownload(content=content, doi=identifier)
    raise FulltextDownloadError(FULLTEXT_IDENTIFIER_MISSING)


__all__ = [
    "DOI_DOWNLOAD_FAILED",
    "DOI_INVALID",
    "DOI_NO_ACCESSIBLE_PDF",
    "DOI_NOT_FOUND",
    "DOI_TOO_LARGE",
    "FULLTEXT_IDENTIFIER_MISSING",
    "FulltextDownloadError",
    "fetch_identifier_pdf",
]
