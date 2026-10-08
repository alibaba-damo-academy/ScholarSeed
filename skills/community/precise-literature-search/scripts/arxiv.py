"""Parse arXiv identifiers consistently across search and download."""

from __future__ import annotations

import re
import urllib.parse
from typing import Any

ARXIV_PREFIX = "arxiv:"
ARXIV_HOST = "arxiv.org"
ARXIV_SCHEMES = frozenset({"http", "https"})
ARXIV_PORTS = frozenset({None, 80, 443})
ARXIV_ROUTES = frozenset({"abs", "pdf", "html"})
PDF_SUFFIX = ".pdf"
ARXIV_IDENTIFIER = re.compile(
    r"(?:[0-9]{4}\.[0-9]{4,5}|[A-Za-z][A-Za-z.-]*/[0-9]{7})(?:v[1-9][0-9]*)?"
)


def normalize_arxiv_id(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip()
    if normalized.casefold().startswith(ARXIV_PREFIX):
        normalized = normalized[len(ARXIV_PREFIX):].strip()
    if any(character.isspace() for character in normalized):
        return None
    try:
        parsed = urllib.parse.urlsplit(normalized)
        if parsed.scheme or parsed.netloc:
            if (
                parsed.scheme not in ARXIV_SCHEMES
                or parsed.hostname != ARXIV_HOST
                or parsed.username is not None
                or parsed.password is not None
                or parsed.port not in ARXIV_PORTS
            ):
                return None
            route, separator, identifier = parsed.path.strip("/").partition("/")
            if not separator or route.casefold() not in ARXIV_ROUTES:
                return None
            normalized = identifier
    except ValueError:
        return None
    if normalized.casefold().endswith(PDF_SUFFIX):
        normalized = normalized[:-len(PDF_SUFFIX)]
    return normalized if ARXIV_IDENTIFIER.fullmatch(normalized) else None
