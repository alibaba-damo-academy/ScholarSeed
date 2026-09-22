"""Literature-owned conversation card contract."""

from __future__ import annotations

from typing import Any, Literal, Mapping
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, ValidationInfo, field_validator

LITERATURE_REFERENCES_CARD = "literature-references"
LITERATURE_REFERENCES_SCHEMA_VERSION: Literal["1.0"] = "1.0"
LITERATURE_TEXT_CHARS = 2_000
LITERATURE_SHORT_TEXT_CHARS = 256
LITERATURE_URL_CHARS = 2_048
LITERATURE_YEAR_MIN = 1_000
LITERATURE_YEAR_MAX = 3_000
LITERATURE_ALLOWED_URL_SCHEMES = frozenset(("http", "https"))


class LiteratureReference(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    ref_id: str = Field(default="", min_length=1, max_length=LITERATURE_SHORT_TEXT_CHARS)
    paper_id: str = Field(default="", max_length=LITERATURE_SHORT_TEXT_CHARS)
    id_source: Literal["paperhub", "doi", "arxiv", "url", "title_key", "none"] = "none"
    title_key: str | None = Field(default=None, max_length=LITERATURE_TEXT_CHARS)
    doi: str | None = Field(default=None, max_length=LITERATURE_SHORT_TEXT_CHARS)
    arxiv_id: str | None = Field(default=None, max_length=LITERATURE_SHORT_TEXT_CHARS)
    url: str | None = Field(default=None, max_length=LITERATURE_URL_CHARS)
    title: str = Field(min_length=1)
    authors: list[str] = Field(default_factory=list)
    year: int | None = Field(default=None, ge=LITERATURE_YEAR_MIN, le=LITERATURE_YEAR_MAX)
    venue: str | None = Field(default=None, max_length=LITERATURE_SHORT_TEXT_CHARS)
    cited_by: list[str] = Field(default_factory=list)
    claim: str | None = Field(default=None, max_length=LITERATURE_TEXT_CHARS)
    verification: Literal["verified", "unverified", "unverifiable-in-scope"] = "unverified"
    evidence: str | None = Field(default=None, max_length=LITERATURE_TEXT_CHARS)
    has_fulltext: bool | None = None

    @field_validator("title")
    @classmethod
    def readable_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("literature_reference_title_empty")
        return value

    @field_validator("authors", "cited_by")
    @classmethod
    def validate_text_list(cls, values: list[str]) -> list[str]:
        if any(not value.strip() or len(value) > LITERATURE_SHORT_TEXT_CHARS for value in values):
            raise ValueError("literature_reference_text_invalid")
        return values

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = urlsplit(value)
        if parsed.scheme not in LITERATURE_ALLOWED_URL_SCHEMES or not parsed.netloc:
            raise ValueError("literature_reference_url_invalid")
        return value

    @field_validator("*", mode="wrap")
    @classmethod
    def optional_metadata(cls, value: Any, handler: Any, info: ValidationInfo) -> Any:
        """Invalid optional metadata must not hide an otherwise readable paper."""
        try:
            return handler(value)
        except ValidationError:
            if info.field_name is None:
                raise
            field = cls.model_fields[info.field_name]
            if field.is_required():
                raise
            return field.get_default(call_default_factory=True)


class LiteratureReferences(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    schema_version: Literal["1.0"] = LITERATURE_REFERENCES_SCHEMA_VERSION
    project: str = Field(default="", min_length=1, max_length=LITERATURE_SHORT_TEXT_CHARS)
    generated_at: str | None = Field(default=None, max_length=LITERATURE_SHORT_TEXT_CHARS)
    references: list[LiteratureReference]

    @field_validator("schema_version", mode="before")
    @classmethod
    def normalize_version(cls, _value: Any) -> Literal["1.0"]:
        return LITERATURE_REFERENCES_SCHEMA_VERSION

    @field_validator("project", "generated_at", mode="wrap")
    @classmethod
    def optional_metadata(cls, value: Any, handler: Any, info: ValidationInfo) -> Any:
        try:
            return handler(value)
        except ValidationError:
            if info.field_name is None:
                raise
            return cls.model_fields[info.field_name].get_default()

    @field_validator("references")
    @classmethod
    def unique_references(cls, values: list[LiteratureReference]) -> list[LiteratureReference]:
        # Preserve supplied citation labels; synthesize only missing/colliding handles.
        reserved = {value.ref_id for value in values if value.ref_id}
        seen: set[str] = set()
        for index, value in enumerate(values, start=1):
            if not value.ref_id or value.ref_id in seen:
                candidate = f"R{index}"
                while candidate in reserved or candidate in seen:
                    candidate += "_"
                value.ref_id = candidate
            seen.add(value.ref_id)
        return values


def validate_references_card(value: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the public v1 literature payload and return JSON values."""

    return LiteratureReferences.model_validate(value).model_dump(mode="json")
