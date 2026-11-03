from __future__ import annotations

import re

from service.literature.service.arxiv import arxiv_id_from_doi, normalize_arxiv_id
from service.literature.service.fulltext import normalize_doi

SOURCE_ARXIV = "arxiv"
SOURCE_DOI = "doi"
VERSION_SUFFIX = re.compile(r"v\d+$", re.IGNORECASE)


def source_identity(kind: str, identifier: str) -> tuple[str, str]:
    if kind == SOURCE_DOI:
        identifier = normalize_doi(identifier).casefold()
        arxiv = arxiv_id_from_doi(identifier)
        if arxiv:
            return SOURCE_ARXIV, normalize_arxiv_id(arxiv).casefold()
        return SOURCE_DOI, identifier
    if kind == SOURCE_ARXIV:
        return SOURCE_ARXIV, normalize_arxiv_id(identifier).casefold()
    return kind, identifier.strip()


def paper_identity(kind: str, identifier: str) -> tuple[str, str]:
    source, value = source_identity(kind, identifier)
    return source, VERSION_SUFFIX.sub("", value) if source == SOURCE_ARXIV else value


def pinned_source(kind: str, identifier: str) -> bool:
    source, value = source_identity(kind, identifier)
    return source == SOURCE_ARXIV and VERSION_SUFFIX.search(value) is not None
