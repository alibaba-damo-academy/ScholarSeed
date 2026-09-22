"""Project an agentic-search candidate set into the saved literature-search card."""

from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal

from service.literature.persistence.files import read_scoped_file, scoped_parent, scoped_relative
from service.literature.service.result import (
    AGENTIC_SEARCH_ORIGIN,
    SEARCH_CARD_PAPERS,
    SEARCH_FILE_BYTES,
    SEARCH_MAX_PAPERS,
    SEARCH_SHORT,
    SEARCH_TEXT,
    AuthorizationSource,
    SearchPaper,
    SearchResult,
    SearchSource,
    authorization_source,
)

AGENTIC_REPORT_FILE = "report.md"
AGENTIC_OPEN_ACCESS = frozenset(("open", "yes", "true"))
AGENTIC_CLOSED_ACCESS = frozenset(("closed", "no", "false", "paywalled"))
AGENTIC_SOURCE_DEFAULT = "paperhub"


@dataclass(frozen=True)
class PreparedAgenticSearch:
    card: SearchResult
    metadata_path: str
    metadata_sha256: str
    report_path: str | None
    report_sha256: str | None
    authorization_sources: tuple[AuthorizationSource, ...]

    @property
    def authorization_refs(self) -> tuple[str, ...]:
        return tuple(source.ref_id for source in self.authorization_sources)


def _text(value: Any, limit: int = SEARCH_TEXT) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _count(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _access(value: Any) -> Literal["yes", "no", "unknown"]:
    normalized = _text(value, SEARCH_SHORT).lower()
    if normalized in AGENTIC_OPEN_ACCESS:
        return "yes"
    if normalized in AGENTIC_CLOSED_ACCESS:
        return "no"
    return "unknown"


def project_agentic_papers(metadata: object) -> list[SearchPaper]:
    """Validate the agentic-search `metadata.json` contract without inventing identities."""

    if not isinstance(metadata, dict):
        raise ValueError("agentic_search_metadata_invalid")
    raw_papers = metadata.get("papers")
    if not isinstance(raw_papers, list) or not raw_papers or len(raw_papers) > SEARCH_MAX_PAPERS:
        raise ValueError("agentic_search_metadata_invalid")
    papers: list[SearchPaper] = []
    identities: set[str] = set()
    for raw in raw_papers:
        if not isinstance(raw, dict):
            raise ValueError("agentic_search_paper_invalid")
        identity = _text(raw.get("paper_id") or raw.get("id"), SEARCH_SHORT)
        if not identity or identity in identities:
            raise ValueError("agentic_search_paper_identity_invalid")
        identities.add(identity)
        authors = raw.get("authors")
        reason = _text(raw.get("reason"))
        papers.append(
            SearchPaper(
                id=identity,
                title=_text(raw.get("title")) or identity,
                authors=(
                    [_text(author) for author in authors[:20] if _text(author)]
                    if isinstance(authors, list)
                    else []
                ),
                year=_count(raw.get("year")),
                venue=_text(raw.get("venue")) or None,
                doi=_text(raw.get("doi"), SEARCH_SHORT) or None,
                abstract=_text(raw.get("abstract")) or None,
                reasons=[reason] if reason else [],
                tier=_count(raw.get("tier")) or None,
                citation_count=_count(raw.get("citation_count")),
                access=_access(raw.get("access")),
                sources=[_text(raw.get("source"), SEARCH_SHORT) or AGENTIC_SOURCE_DEFAULT],
            )
        )
    return papers


def prepare_agentic_search(workdir: Path, metadata_path: str) -> PreparedAgenticSearch:
    """Read one agentic-search result directory named by its product-discovered metadata."""

    metadata_path = scoped_relative(metadata_path)
    raw = read_scoped_file(workdir, metadata_path, SEARCH_FILE_BYTES)
    metadata = json.loads(raw)
    papers = project_agentic_papers(metadata)
    summary = metadata.get("search_summary") if isinstance(metadata, dict) else None
    summary = summary if isinstance(summary, dict) else {}
    candidate_report_path = scoped_relative(scoped_parent(metadata_path), AGENTIC_REPORT_FILE)
    try:
        report = read_scoped_file(workdir, candidate_report_path, SEARCH_FILE_BYTES)
        report_sha256 = sha256(report).hexdigest() if report.strip() else None
    except (OSError, ValueError):
        report_sha256 = None
    report_path = candidate_report_path if report_sha256 is not None else None
    source_counts: dict[str, int] = {}
    for paper in papers:
        for source in paper.sources:
            source_counts[source] = source_counts.get(source, 0) + 1
    card = SearchResult(
        run_id=scoped_parent(metadata_path),
        round=max(_count(summary.get("total_rounds")) or 1, 1),
        criteria=[item for item in (_text(summary.get("query")),) if item],
        status="success",
        sources=[
            SearchSource(
                name=name,
                status="success",
                queries=_count(summary.get("total_queries")),
                candidates=count,
            )
            for name, count in source_counts.items()
        ],
        candidates=len(papers),
        deduplicated=_count(summary.get("pool_size")),
        retained=len(papers),
        papers=papers[:SEARCH_CARD_PAPERS],
        warnings=[],
        origin=AGENTIC_SEARCH_ORIGIN,
    )
    return PreparedAgenticSearch(
        card,
        metadata_path,
        sha256(raw).hexdigest(),
        report_path,
        report_sha256,
        tuple(authorization_source(paper) for paper in papers),
    )
