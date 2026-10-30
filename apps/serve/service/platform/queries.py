"""Bounded contracts for project-only product discovery and reads."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

QUERY_CHARS = 512
PATH_CHARS = 4096
IDENTITY_CHARS = 128
PAGE_DEFAULT = 20
PAGE_MAX = 50
OFFSET_MAX = 10000
DIFF_CHARS = 8192
PROJECT_SCOPE = "current_project"
READ_EFFECT = "read"
WRITE_EFFECT = "write"
EXTERNAL_EFFECT = "external"
DESTRUCTIVE_EFFECT = "destructive"
DOMAIN_CHECKED = "domain_checked"
PROJECT_REQUIRED = "project_required"
REGISTERED = "registered"
NOT_DECLARED = "not_declared"
NO_APPROVAL = "none"
USER_CONFIRM = "user_confirm"
UNAVAILABLE = "unavailable"
METADATA_NOTICE = "Untrusted bibliography, not full-text evidence or an authorization receipt."
LITERATURE_SOURCE_ROUTE = "/api/v1/literatures"
RESOURCE_SOURCE_ROUTE = "/api/resource/raw"


class ProjectQueryError(ValueError):
    pass


class QueryModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ContractList(QueryModel):
    capability: str = Field(default="", max_length=IDENTITY_CHARS)
    offset: int = Field(default=0, ge=0, le=OFFSET_MAX)
    limit: int = Field(default=PAGE_DEFAULT, ge=1, le=PAGE_MAX)


class ContractAvailability(QueryModel):
    status: Literal["domain_checked", "unavailable"]
    reason: str


class ContractSummary(QueryModel):
    capability: str
    operation: str
    summary: str
    scope: str
    effect: str
    approval: str
    availability: ContractAvailability


class ContractListResult(QueryModel):
    ok: Literal[True] = True
    entries: list[ContractSummary]
    next_offset: int | None = None


class ResourceSearch(QueryModel):
    query: str = Field(min_length=1, max_length=QUERY_CHARS)
    offset: int = Field(default=0, ge=0, le=OFFSET_MAX)
    limit: int = Field(default=PAGE_DEFAULT, ge=1, le=PAGE_MAX)


class ResourceStat(QueryModel):
    path: str = Field(min_length=1, max_length=PATH_CHARS)


class ResourceVersions(ResourceStat):
    before_sequence: int | None = Field(default=None, ge=1)
    limit: int = Field(default=PAGE_DEFAULT, ge=1, le=PAGE_MAX)


class ResourceDiff(QueryModel):
    version_id: str = Field(min_length=1, max_length=IDENTITY_CHARS)
    base_version_id: str = Field(min_length=1, max_length=IDENTITY_CHARS)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=DIFF_CHARS, ge=1, le=DIFF_CHARS)


class LiteratureSearch(QueryModel):
    query: str = Field(default="", max_length=QUERY_CHARS)
    offset: int = Field(default=0, ge=0, le=OFFSET_MAX)
    limit: int = Field(default=PAGE_DEFAULT, ge=1, le=PAGE_MAX)


class LiteratureDetail(QueryModel):
    literature_id: str = Field(min_length=1, max_length=IDENTITY_CHARS)


class ResourceHitResult(QueryModel):
    path: str
    name: str
    matched: str
    snippet: str


class ResourceSearchResult(QueryModel):
    ok: bool = True
    scope: str = PROJECT_SCOPE
    entries: list[ResourceHitResult]
    next_offset: int | None = None
    truncated: bool


class ResourceStatResult(QueryModel):
    ok: bool = True
    scope: str = PROJECT_SCOPE
    path: str
    kind: str
    size: int
    media_type: str
    revision: str
    source_url: str = Field(
        description="Project-scoped source navigation URL, not proof of reading."
    )
    file_id: str | None = None
    version_id: str | None = Field(
        default=None,
        description="Latest recorded version, not necessarily the current disk revision.",
    )


class ResourceVersionResult(QueryModel):
    id: str
    sequence: int
    path: str
    state: str
    origin: str
    created_at_ms: int
    alias: str | None = None


class ResourceVersionsResult(QueryModel):
    ok: bool = True
    scope: str = PROJECT_SCOPE
    file_id: str | None = None
    versions: list[ResourceVersionResult]
    next_sequence: int | None = None


class ResourceDiffResult(QueryModel):
    ok: bool = True
    scope: str = PROJECT_SCOPE
    version_id: str
    base_version_id: str
    diff: str
    next_offset: int | None = None


class LiteratureMetadata(QueryModel):
    id: str
    title: str
    authors: str
    year: int | None
    publication: str
    doi: str
    version: int


class LiteratureSearchResult(QueryModel):
    ok: bool = True
    scope: str = PROJECT_SCOPE
    notice: str = METADATA_NOTICE
    items: list[LiteratureMetadata]
    next_offset: int | None = None


class LiteratureAttachmentSummary(QueryModel):
    id: str
    name: str
    media_type: str
    role: str


class LiteratureDetailResult(QueryModel):
    ok: bool = True
    scope: str = PROJECT_SCOPE
    notice: str = METADATA_NOTICE
    item: LiteratureMetadata
    abstract: str
    attachments: list[LiteratureAttachmentSummary]
    source_url: str = Field(
        description="Project-scoped bibliography navigation URL, not full-text evidence."
    )
