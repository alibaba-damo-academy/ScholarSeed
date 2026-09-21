"""Match result identities to the actual library."""

from __future__ import annotations

import re
import sqlite3
import unicodedata

from pydantic import Field

from service.literature.persistence.store import LiteratureRepository
from service.literature.service.result import (
    SEARCH_SHORT,
    SEARCH_STATUS_PAPERS,
    SEARCH_TEXT,
    SearchRecord,
)

DOI_PREFIX = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", re.IGNORECASE)


class ResultIdentity(SearchRecord):
    id: str = Field(min_length=1, max_length=SEARCH_SHORT)
    title: str = Field(min_length=1, max_length=SEARCH_TEXT)
    doi: str | None = Field(default=None, max_length=SEARCH_SHORT)
    year: int | None = None


class ResultStatusRequest(SearchRecord):
    papers: list[ResultIdentity] = Field(max_length=SEARCH_STATUS_PAPERS)
    project_id: str = Field(default="", max_length=SEARCH_SHORT)


def doi_key(value: str | None) -> str:
    return DOI_PREFIX.sub("", (value or "").strip()).strip().casefold()


def title_key(value: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", value).casefold() if c.isalnum())


class ResultStatusService:
    def __init__(self, repository: LiteratureRepository | None = None) -> None:
        self._repository = repository or LiteratureRepository()

    def resolve(self, papers: list[ResultIdentity], project_id: str = "") -> dict:
        try:
            items = self._repository.view(project_id).items
            result = {}
            for paper in papers:
                doi = doi_key(paper.doi)
                title = title_key(paper.title)
                matches = [item for item in items if doi and doi_key(item.doi) == doi]
                if not matches and title:
                    matches = [
                        item
                        for item in items
                        if title_key(item.title) == title
                        and not (doi and item.doi and doi_key(item.doi) != doi)
                        and not (paper.year and item.year and paper.year != item.year)
                    ]
                status = {"library": "absent"}
                if len(matches) > 1:
                    status["library"] = "ambiguous"
                elif matches:
                    status["library"] = "matched"
                result[paper.id] = status
            return result
        except (sqlite3.Error, OSError, ValueError):
            return {paper.id: {"library": "unavailable"} for paper in papers}
