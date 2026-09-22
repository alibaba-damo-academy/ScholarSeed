"""Validated HTTP input for selected web-search candidates."""

from __future__ import annotations

from pydantic import BaseModel, Field

WEB_IMPORT_LIMIT = 10
WEB_CANDIDATE_TITLE_LIMIT = 512
WEB_CANDIDATE_URL_LIMIT = 4096
WEB_CANDIDATE_SNIPPET_LIMIT = 4096
WEB_SEARCH_QUERY_LIMIT = 4096
WEB_RESOURCE_PARENT_LIMIT = 4096


class WebCandidateRequest(BaseModel):
    """One selected search result waiting for a bounded HTML fetch."""

    title: str = Field(min_length=1, max_length=WEB_CANDIDATE_TITLE_LIMIT)
    url: str = Field(min_length=1, max_length=WEB_CANDIDATE_URL_LIMIT)
    snippet: str = Field(default="", max_length=WEB_CANDIDATE_SNIPPET_LIMIT)


class WebImportRequest(BaseModel):
    """`POST /api/resource/web-import` request."""

    project: str = Field(min_length=1)
    query: str = Field(min_length=1, max_length=WEB_SEARCH_QUERY_LIMIT)
    parent: str = Field(default="", max_length=WEB_RESOURCE_PARENT_LIMIT)
    candidates: list[WebCandidateRequest] = Field(
        min_length=1,
        max_length=WEB_IMPORT_LIMIT,
    )


__all__ = ["WEB_IMPORT_LIMIT", "WebCandidateRequest", "WebImportRequest"]
