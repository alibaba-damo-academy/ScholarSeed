"""Cited-paper snapshots for the shared literature result surface."""

from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal, Mapping
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, ValidationInfo, field_validator

from service.literature.persistence.files import read_scoped_file, scoped_relative
from service.literature.service.result import (
    SEARCH_FILE_BYTES,
    SEARCH_MAX_PAPERS,
    PreparedSearchResult,
    SearchPaper,
    SearchResult,
    project_papers,
)

CITATIONS_ORIGIN: Literal["research-idea-citations"] = "research-idea-citations"
CITATIONS_CHECKPOINT = "citations"
CITATIONS_FILE = "references.json"
CITATIONS_REPORT = "literature_report.md"
CITATIONS_ROUND = 1
CITATIONS_CARD_PAPERS = 3
CITED_SCHEMA_VERSION: Literal["1.0"] = "1.0"
LITERATURE_TEXT_CHARS = 2_000
LITERATURE_SHORT_TEXT_CHARS = 256
LITERATURE_URL_CHARS = 2_048
LITERATURE_YEAR_MIN = 1_000
LITERATURE_YEAR_MAX = 3_000
LITERATURE_ALLOWED_URL_SCHEMES = frozenset(("http", "https"))


class CitedPaper(BaseModel):
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


class CitedLiterature(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    schema_version: Literal["1.0"] = CITED_SCHEMA_VERSION
    project: str = Field(default="", min_length=1, max_length=LITERATURE_SHORT_TEXT_CHARS)
    generated_at: str | None = Field(default=None, max_length=LITERATURE_SHORT_TEXT_CHARS)
    references: list[CitedPaper]

    @field_validator("schema_version", mode="before")
    @classmethod
    def normalize_version(cls, _value: Any) -> Literal["1.0"]:
        return CITED_SCHEMA_VERSION

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
    def unique_references(cls, values: list[CitedPaper]) -> list[CitedPaper]:
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


def validate_citations(value: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the public v1 literature payload and return JSON values."""

    return CitedLiterature.model_validate(value).model_dump(mode="json")


def project_citations(value: Any, *, complete: bool = False) -> list[SearchPaper]:
    citations = CitedLiterature.model_validate(value)
    if len(citations.references) > SEARCH_MAX_PAPERS:
        raise ValueError("literature_result_too_many_papers")
    return project_papers(
        [
            {
                "id": reference.ref_id,
                "title": reference.title,
                "authors": reference.authors,
                "year": reference.year,
                "venue": reference.venue,
                "doi": reference.doi,
                "url": (
                    reference.url
                    or (f"https://doi.org/{reference.doi}" if reference.doi else None)
                    or (
                        f"https://arxiv.org/abs/{reference.arxiv_id}"
                        if reference.arxiv_id
                        else None
                    )
                ),
                "relevance": {
                    "reasons": [text for text in (reference.claim, reference.evidence) if text]
                },
                "is_placeholder": False,
            }
            for reference in citations.references
        ],
        complete=complete,
    )


def prepare_citations(workdir: Path, run: str) -> PreparedSearchResult:
    root = scoped_relative(run)
    metadata_path = scoped_relative(root, CITATIONS_FILE)
    report_path = scoped_relative(root, CITATIONS_REPORT)
    metadata = read_scoped_file(workdir, metadata_path, SEARCH_FILE_BYTES)
    report = read_scoped_file(workdir, report_path, SEARCH_FILE_BYTES)
    papers = project_citations(json.loads(metadata))
    card = SearchResult(
        run_id=root,
        round=CITATIONS_ROUND,
        origin=CITATIONS_ORIGIN,
        status="success" if papers else "no_confident_match",
        criteria=[],
        sources=[],
        candidates=None,
        deduplicated=None,
        retained=len(papers),
        papers=papers[:CITATIONS_CARD_PAPERS],
        warnings=[],
    )
    return PreparedSearchResult(
        card=card,
        report_path=report_path,
        report_sha256=sha256(report).hexdigest(),
        metadata_path=metadata_path,
        metadata_sha256=sha256(metadata).hexdigest(),
    )
