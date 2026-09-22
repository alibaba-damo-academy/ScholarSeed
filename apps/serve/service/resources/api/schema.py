"""Validated HTTP input for provenance-bearing resource excerpts."""

from __future__ import annotations

import math

from pydantic import BaseModel, Field, field_validator, model_validator

from service.platform.content import ImportMode
from service.platform.excerpts import ExcerptLocatorKind, ExcerptSourceKind
from service.resources.domain.model import LITERATURE_EXCERPT_DIR, ImportDecisionAction

MAX_SELECTIONS_PER_REQUEST = 200
MAX_SELECTION_TEXT_CHARS = 100_000


class ResourceImportDecisionRequest(BaseModel):
    """One explicit decision for a conflict returned by import preflight."""

    source_index: int = Field(ge=0)
    action: ImportDecisionAction


class ResourceImportRequest(BaseModel):
    """Both phases of `POST /api/resource/import`."""

    project: str | None = None
    mode: ImportMode = ImportMode.COPY
    sources: list[str] = Field(min_length=1)
    target_dir: str = ""
    plan_token: str | None = Field(default=None, min_length=1)
    decisions: list[ResourceImportDecisionRequest] = Field(default_factory=list)

    @model_validator(mode="after")
    def require_complete_resolution(self) -> "ResourceImportRequest":
        if (self.plan_token is None) != (not self.decisions):
            raise ValueError("import_decisions_invalid")
        return self


class ResourceExcerptLocationRequest(BaseModel):
    """Requested location relative to the resources root."""

    parent: str = LITERATURE_EXCERPT_DIR
    name: str | None = None


class LiteratureExcerptSourceRequest(BaseModel):
    """Stable literature identity; paths and metadata are resolved server-side."""

    kind: ExcerptSourceKind
    literature_id: str = Field(min_length=1)
    document_revision: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def require_literature_kind(self) -> "LiteratureExcerptSourceRequest":
        if self.kind is not ExcerptSourceKind.LITERATURE:
            raise ValueError("unsupported_excerpt_source")
        return self


class PdfExcerptLocatorRequest(BaseModel):
    """One-based PDF page and optional normalized highlight rectangles."""

    kind: ExcerptLocatorKind
    page: int = Field(ge=1)
    quads: list[tuple[float, float, float, float]] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_pdf_locator(self) -> "PdfExcerptLocatorRequest":
        if self.kind is not ExcerptLocatorKind.PDF:
            raise ValueError("invalid_locator")
        for left, top, right, bottom in self.quads:
            values = (left, top, right, bottom)
            if (
                not all(math.isfinite(value) and 0 <= value <= 1 for value in values)
                or right <= left
                or bottom <= top
            ):
                raise ValueError("invalid_locator")
        return self


class PdfExcerptSelectionRequest(BaseModel):
    """Selected text plus its PDF locator."""

    text: str = Field(min_length=1, max_length=MAX_SELECTION_TEXT_CHARS)
    locator: PdfExcerptLocatorRequest

    @field_validator("text")
    @classmethod
    def require_visible_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("excerpt_text_required")
        return value


class ResourceExcerptsRequest(BaseModel):
    """`POST /api/resource/excerpts` request."""

    project: str = Field(min_length=1)
    location: ResourceExcerptLocationRequest = Field(default_factory=ResourceExcerptLocationRequest)
    source: LiteratureExcerptSourceRequest
    selections: list[PdfExcerptSelectionRequest] = Field(
        min_length=1,
        max_length=MAX_SELECTIONS_PER_REQUEST,
    )


__all__ = [
    "MAX_SELECTIONS_PER_REQUEST",
    "MAX_SELECTION_TEXT_CHARS",
    "LiteratureExcerptSourceRequest",
    "PdfExcerptLocatorRequest",
    "PdfExcerptSelectionRequest",
    "ResourceExcerptLocationRequest",
    "ResourceExcerptsRequest",
    "ResourceImportDecisionRequest",
    "ResourceImportRequest",
]
