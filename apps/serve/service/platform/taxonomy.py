"""Typed literature taxonomy management contracts."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

TAXONOMY_DEFAULT_LIMIT = 20
TAXONOMY_MAX_LIMIT = 100
TAXONOMY_MAX_BATCH = 100
TAXONOMY_MAX_OFFSET = (1 << 63) - 1
TAXONOMY_NAME_CHARS = 256
TAXONOMY_ID_CHARS = 128
TAXONOMY_REVISION_CHARS = 64
TAXONOMY_REVISION_PATTERN = r"^[0-9a-f]{64}$"
COLLECTION_LIST = "collection.list"
COLLECTION_CREATE = "collection.create"
COLLECTION_UPDATE = "collection.update"
COLLECTION_DELETE = "collection.delete"
TAG_LIST = "tag.list"
TAG_CREATE = "tag.create"
TAG_UPDATE = "tag.update"
TAG_DELETE = "tag.delete"
ORGANIZE = "organize"


class TaxonomyCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, strict=True)


class TaxonomyList(TaxonomyCommand):
    limit: int = Field(default=TAXONOMY_DEFAULT_LIMIT, ge=1, le=TAXONOMY_MAX_LIMIT)
    offset: int = Field(default=0, ge=0, le=TAXONOMY_MAX_OFFSET)


class CollectionCreate(TaxonomyCommand):
    name: str = Field(
        min_length=1,
        max_length=TAXONOMY_NAME_CHARS,
        description="Reuse an existing same-name sibling in the session project.",
    )
    parent_id: str | None = Field(default=None, min_length=1, max_length=TAXONOMY_ID_CHARS)


class CollectionUpdate(TaxonomyCommand):
    id: str = Field(min_length=1, max_length=TAXONOMY_ID_CHARS)
    name: str | None = Field(default=None, min_length=1, max_length=TAXONOMY_NAME_CHARS)
    parent_id: str | None = Field(default=None, min_length=1, max_length=TAXONOMY_ID_CHARS)

    @model_validator(mode="after")
    def require_change(self) -> CollectionUpdate:
        if not self.model_fields_set.intersection({"name", "parent_id"}):
            raise ValueError("name or parent_id is required")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("name cannot be null")
        return self


class TaxonomyDelete(TaxonomyCommand):
    id: str = Field(min_length=1, max_length=TAXONOMY_ID_CHARS)
    expected_revision: str | None = Field(
        default=None,
        min_length=TAXONOMY_REVISION_CHARS,
        max_length=TAXONOMY_REVISION_CHARS,
        pattern=TAXONOMY_REVISION_PATTERN,
        description="Omit for impact preview; after user confirmation, supply its revision to delete.",
    )


class TagCreate(TaxonomyCommand):
    name: str = Field(
        min_length=1,
        max_length=TAXONOMY_NAME_CHARS,
        description="Global tag name; existing names are reused across projects.",
    )


class TagUpdate(TagCreate):
    id: str = Field(
        min_length=1,
        max_length=TAXONOMY_ID_CHARS,
        description="Renaming changes this global tag in all projects; relationships are preserved.",
    )


class Organize(TaxonomyCommand):
    literature_ids: list[str] = Field(
        min_length=1,
        max_length=TAXONOMY_MAX_BATCH,
        description="Every literature ID must already belong to the session project.",
    )
    collection_ids: list[str] = Field(default_factory=list, max_length=TAXONOMY_MAX_BATCH)
    tag_ids: list[str] = Field(default_factory=list, max_length=TAXONOMY_MAX_BATCH)
    action: Literal["add", "remove"] = Field(
        default="add",
        description="Only change selected relationships; preserve all other memberships.",
    )

    @model_validator(mode="after")
    def require_relationships(self) -> Organize:
        if not self.collection_ids and not self.tag_ids:
            raise ValueError("collection_ids or tag_ids is required")
        for identifiers in (self.literature_ids, self.collection_ids, self.tag_ids):
            if any(
                not identifier.strip() or len(identifier) > TAXONOMY_ID_CHARS
                for identifier in identifiers
            ):
                raise ValueError("invalid identifier")
        return self


class TaxonomyEntry(BaseModel):
    id: str
    name: str
    parent_id: str | None = None
    project_id: str | None = None
    count: int | None = None
    color: str | None = None


class TaxonomyImpact(BaseModel):
    definitions: int = 0
    memberships: int = 0
    literature: int = 0
    projects: int = 0


class TaxonomyResult(BaseModel):
    ok: Literal[True] = True
    project_id: str
    operation: str
    items: list[TaxonomyEntry] = Field(default_factory=list)
    literature_ids: list[str] = Field(default_factory=list)
    next_offset: int | None = None
    affected: int = 0
    preview: bool = False
    revision: str | None = None
    impact: TaxonomyImpact = Field(default_factory=TaxonomyImpact)
    reused: bool = False


TAXONOMY_REQUESTS: dict[str, type[BaseModel]] = {
    COLLECTION_LIST: TaxonomyList,
    COLLECTION_CREATE: CollectionCreate,
    COLLECTION_UPDATE: CollectionUpdate,
    COLLECTION_DELETE: TaxonomyDelete,
    TAG_LIST: TaxonomyList,
    TAG_CREATE: TagCreate,
    TAG_UPDATE: TagUpdate,
    TAG_DELETE: TaxonomyDelete,
    ORGANIZE: Organize,
}
