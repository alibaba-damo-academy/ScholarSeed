"""Match result identities to the actual library."""

from __future__ import annotations

import logging
import re
import sqlite3
import unicodedata
from typing import Literal

from pydantic import Field

from service.literature.domain.model import LiteratureError
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.result import (
    SEARCH_SHORT,
    SEARCH_STATUS_PAPERS,
    SEARCH_TEXT,
    SearchRecord,
)

DOI_PREFIX = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", re.IGNORECASE)
logger = logging.getLogger(__name__)

#: 「这篇文献是否已在文献库中」的完整答案集。库里命中多行同样是 matched:
#: 文献库按 proposal 91 不做重复判定, 同一篇论文重复入库就是多行, 那是库的整理
#: 问题, 不是这一问的第三种回答。
LibraryState = Literal["matched", "absent", "unavailable"]


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

    def resolve(
        self, papers: list[ResultIdentity], project_id: str = ""
    ) -> dict[str, dict[str, LibraryState]]:
        try:
            items = self._repository.view(project_id).items
            result: dict[str, dict[str, LibraryState]] = {}
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
                result[paper.id] = {"library": "matched" if matches else "absent"}
            return result
        except (sqlite3.Error, OSError, ValueError, LiteratureError) as error:
            logger.warning(
                "literature_result_status_unavailable project_id=%s paper_count=%s failure_type=%s",
                project_id,
                len(papers),
                type(error).__name__,
                exc_info=True,
            )
            return {paper.id: {"library": "unavailable"} for paper in papers}
