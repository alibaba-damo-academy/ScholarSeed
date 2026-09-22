"""Download PDF attachments from normalized arXiv identifiers."""

from __future__ import annotations

import re

import httpx

from service.literature.domain.model import MAX_IMPORT_BYTES
from service.literature.service.extractor import InvalidPdfError, extract_pdf_metadata

ARXIV_PDF_ROOT = "https://arxiv.org/pdf"
ARXIV_DOWNLOAD_TIMEOUT_SECONDS = 60.0
ARXIV_USER_AGENT = "ScholarSeed/1.0"
ARXIV_IDENTIFIER = re.compile(
    r"^(?:[a-z-]+(?:\.[A-Z]{2})?/\d{7}|(?:\d{4}\.\d{4,5}))(?:v\d+)?$",
    re.IGNORECASE,
)
ARXIV_PREFIX = re.compile(r"^arxiv:\s*", re.IGNORECASE)
ARXIV_URL = re.compile(
    r"^https?://(?:www\.)?(?:arxiv|export\.arxiv)\.org/(?:abs|pdf)/([^?#]+?)(?:\.pdf)?/?$",
    re.IGNORECASE,
)

ARXIV_INVALID = "ARXIV_INVALID"
ARXIV_NOT_FOUND = "ARXIV_NOT_FOUND"
ARXIV_DOWNLOAD_FAILED = "ARXIV_DOWNLOAD_FAILED"
ARXIV_TOO_LARGE = "ARXIV_TOO_LARGE"
ARXIV_INVALID_PDF = "ARXIV_INVALID_PDF"


class ArxivDownloadError(ValueError):
    """A stable failure raised by the arXiv attachment service."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def normalize_arxiv_id(value: str) -> str:
    """Return an arXiv identifier without accepting an arbitrary remote URL."""

    candidate = value.strip()
    match = ARXIV_URL.fullmatch(candidate)
    if match:
        candidate = match.group(1)
    else:
        candidate = ARXIV_PREFIX.sub("", candidate)
    candidate = candidate.removesuffix(".pdf").strip("/")
    if not ARXIV_IDENTIFIER.fullmatch(candidate):
        raise ArxivDownloadError(ARXIV_INVALID)
    return candidate


def fetch_arxiv_pdf(value: str) -> tuple[str, bytes]:
    """Fetch one bounded, valid PDF from arXiv's fixed PDF endpoint."""

    identifier = normalize_arxiv_id(value)
    url = f"{ARXIV_PDF_ROOT}/{identifier}.pdf"
    content = bytearray()
    try:
        with httpx.Client(
            timeout=ARXIV_DOWNLOAD_TIMEOUT_SECONDS,
            # arXiv commonly redirects its PDF endpoint to a nearby export
            # host.  The URL is still constructed from the validated ID; do
            # not follow a caller-provided URL.
            follow_redirects=True,
            headers={"User-Agent": ARXIV_USER_AGENT},
        ) as client:
            with client.stream("GET", url) as response:
                # A 404 means arXiv has no PDF for this identifier, which the
                # user can act on (fix the identifier or attach a local PDF);
                # folding it into the transport failure would blame the network.
                if response.status_code == 404:
                    raise ArxivDownloadError(ARXIV_NOT_FOUND)
                response.raise_for_status()
                for chunk in response.iter_bytes():
                    content.extend(chunk)
                    if len(content) > MAX_IMPORT_BYTES:
                        raise ArxivDownloadError(ARXIV_TOO_LARGE)
    except ArxivDownloadError:
        raise
    except (httpx.HTTPError, OSError) as error:
        raise ArxivDownloadError(ARXIV_DOWNLOAD_FAILED) from error
    try:
        extract_pdf_metadata(bytes(content))
    except InvalidPdfError as error:
        raise ArxivDownloadError(ARXIV_INVALID_PDF) from error
    return identifier, bytes(content)


__all__ = [
    "ARXIV_DOWNLOAD_FAILED",
    "ARXIV_INVALID",
    "ARXIV_INVALID_PDF",
    "ARXIV_NOT_FOUND",
    "ARXIV_TOO_LARGE",
    "ArxivDownloadError",
    "fetch_arxiv_pdf",
    "normalize_arxiv_id",
]
