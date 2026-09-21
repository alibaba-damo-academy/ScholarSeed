"""Read a skill-owned search round into an immutable conversation result."""

from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from service.literature.persistence.files import read_scoped_file, scoped_parent, scoped_relative

SEARCH_CARD = "literature-search"
SEARCH_VERSION: Literal["1.0"] = "1.0"
PRECISE_SEARCH_ORIGIN: Literal["precise-search"] = "precise-search"
LITERATURE_REVIEW_ORIGIN: Literal["literature-review"] = "literature-review"
LEGACY_LITERATURE_REVIEW_ORIGIN: Literal["slr-codex"] = "slr-codex"
AGENTIC_SEARCH_ORIGIN: Literal["agentic-search"] = "agentic-search"
LITERATURE_REVIEW_ORIGINS = frozenset({LITERATURE_REVIEW_ORIGIN, LEGACY_LITERATURE_REVIEW_ORIGIN})
SEARCH_FILE_BYTES = 8 * 1024 * 1024
SEARCH_CARD_PAPERS = 3
SEARCH_STATUS_PAPERS = 20
SEARCH_MAX_PAPERS = 1000
SEARCH_TEXT = 2000
SEARCH_SHORT = 256
SEARCH_STATE_FILE = "state.json"
SEARCH_INTENT_FILE = "intent.json"
SEARCH_SELECTION_FILE = "selection.json"
SELECTION_NOT_PREPARED = "literature_result_selection_not_prepared"
SEARCH_WORK = "work"
FINAL_DELIVERY_STATUS = "COMPLETED"
FinalArtifactRole = Literal["final", "supporting"]
FINAL_ARTIFACT_ROLE: FinalArtifactRole = "final"
SUPPORTING_ARTIFACT_ROLE: FinalArtifactRole = "supporting"
FINAL_DELIVERY_PATHS: tuple[tuple[str, FinalArtifactRole], ...] = (
    ("final_report", FINAL_ARTIFACT_ROLE),
    ("paper_summary", SUPPORTING_ARTIFACT_ROLE),
    ("report", SUPPORTING_ARTIFACT_ROLE),
)
ARTIFACT_REFERENCE_FIELDS = ("artifact_id", "path", "name", "media_type", "size", "sha256")
AUTHORIZATION_PAPER_PREFIX = "paper:"
AUTHORIZATION_ARTIFACT_PREFIX = "artifact:"
SEARCH_SUCCESS = frozenset(("success", "partial"))
SearchStatus = Literal[
    "success",
    "partial",
    "no_confident_match",
    "execution_blocked",
    "source_failed",
    "invalid_result",
]
SEARCH_STATUSES = frozenset(
    (
        "success",
        "partial",
        "no_confident_match",
        "execution_blocked",
        "source_failed",
        "invalid_result",
    )
)
SOURCE_SUCCESS = frozenset(("success", "partial"))
SOURCE_STATUSES = frozenset(
    (
        "success",
        "partial",
        "failed",
        "unavailable",
        "execution_blocked",
        "transport_error",
        "authentication_error",
    )
)


class SearchRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class SearchPaper(SearchRecord):
    id: str = Field(min_length=1, max_length=SEARCH_SHORT)
    title: str = Field(min_length=1, max_length=SEARCH_TEXT)
    authors: list[str] = Field(default_factory=list, max_length=20)
    year: int | None = None
    venue: str | None = None
    doi: str | None = None
    url: str | None = None
    abstract: str | None = None
    reasons: list[str] = Field(default_factory=list, max_length=10)
    tier: int | None = Field(default=None, ge=1)
    citation_count: int | None = Field(default=None, ge=0)
    access: Literal["yes", "no", "unknown"] = "unknown"
    sources: list[str] = Field(default_factory=list, max_length=20)
    decision: Literal["included", "excluded", "candidate"] = "candidate"
    decision_reason: str | None = None
    fulltext: Literal["fulltext", "abstract", "unknown"] = "unknown"

    @field_validator("url")
    @classmethod
    def public_url(cls, value: str | None) -> str | None:
        if not value:
            return None
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"https", "http"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise ValueError("literature_result_url_invalid")
        return value


class SearchSource(SearchRecord):
    name: str
    status: str
    queries: int | None = None
    candidates: int | None = None


class SearchResult(SearchRecord):
    schema_version: Literal["1.0"] = SEARCH_VERSION
    run_id: str
    round: int = Field(ge=1)
    criteria: list[str]
    status: Literal[
        "success",
        "partial",
        "no_confident_match",
        "execution_blocked",
        "source_failed",
        "invalid_result",
    ]
    sources: list[SearchSource]
    candidates: int | None
    deduplicated: int | None
    retained: int
    papers: list[SearchPaper] = Field(max_length=SEARCH_CARD_PAPERS)
    warnings: list[str]
    session_id: str = ""
    report: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    origin: Literal["precise-search", "literature-review", "slr-codex", "agentic-search"] = (
        PRECISE_SEARCH_ORIGIN
    )
    selection: dict[str, Any] = Field(default_factory=dict)
    fulltext: dict[str, Any] = Field(default_factory=dict)


def validate_search_card(value: Any) -> dict[str, Any]:
    return SearchResult.model_validate(value).model_dump(mode="json")


def _count(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _text(value: Any, limit: int = SEARCH_TEXT) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _strings(value: Any, limit: int = 20) -> list[str]:
    return [_text(item) for item in value[:limit] if _text(item)] if isinstance(value, list) else []


def _object(root: Path, path: str) -> dict:
    value = json.loads(read_scoped_file(root, path, SEARCH_FILE_BYTES))
    if not isinstance(value, dict):
        raise ValueError("literature_result_object_required")
    return value


def _relative(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("literature_result_path_required")
    try:
        return scoped_relative(value)
    except ValueError as error:
        raise ValueError("literature_result_path_invalid") from error


def _criteria(intent: dict) -> list[str]:
    result = [_text(intent.get("precise_intent"))]
    time = intent.get("time_range") or {}
    if isinstance(time, dict) and (time.get("from_year") or time.get("to_year")):
        result.append(f"年份：{time.get('from_year') or '不限'}–{time.get('to_year') or '不限'}")
    if _count(intent.get("max_results")):
        result.append(f"本轮结果上限：{intent['max_results']} 篇")
    for field, label in (
        ("paper_types", "文献类型"),
        ("include_criteria", "关键条件"),
        ("exclude_criteria", "排除条件"),
    ):
        values = _strings(intent.get(field))
        if values:
            result.append(f"{label}：{'；'.join(values)}")
    return [item for item in result if item]


@dataclass(frozen=True)
class AuthorizationSource:
    """One product-validated paper identity presented for full-text authorization."""

    id: str
    ref_id: str
    title: str


def authorization_source(paper: SearchPaper) -> AuthorizationSource:
    identity = paper.id
    return AuthorizationSource(
        id=identity,
        ref_id=f"{AUTHORIZATION_PAPER_PREFIX}{identity}",
        title=paper.title,
    )


@dataclass(frozen=True)
class PreparedSearchResult:
    card: SearchResult
    report_path: str
    report_sha256: str
    metadata_path: str
    metadata_sha256: str
    selection_path: str | None = None
    selection_sha256: str | None = None
    authorization_sources: tuple[AuthorizationSource, ...] = ()

    @property
    def authorization_refs(self) -> tuple[str, ...]:
        if not self.authorization_sources or not self.selection_sha256:
            return ()
        return (
            *(source.ref_id for source in self.authorization_sources),
            f"{AUTHORIZATION_ARTIFACT_PREFIX}{self.selection_sha256}",
        )


@dataclass(frozen=True)
class PreparedDeliveryArtifact:
    path: str
    sha256: str
    role: FinalArtifactRole


@dataclass(frozen=True)
class PreparedFinalDelivery:
    artifacts: tuple[PreparedDeliveryArtifact, ...]


def prepare_final_delivery(workdir: Path, run: str) -> PreparedFinalDelivery:
    """Bind terminal skill outputs to immutable product publication inputs."""

    root = _relative(run)
    state = _object(workdir, scoped_relative(root, SEARCH_STATE_FILE))
    if state.get("status") != FINAL_DELIVERY_STATUS:
        raise ValueError("literature_result_run_incomplete")
    paths = state.get("paths")
    if not isinstance(paths, dict):
        raise ValueError("literature_result_paths_missing")
    artifacts = []
    seen_paths = set()
    for key, role in FINAL_DELIVERY_PATHS:
        path = scoped_relative(root, _relative(paths.get(key)))
        if path in seen_paths:
            raise ValueError("literature_result_artifact_duplicate")
        payload = read_scoped_file(workdir, path, SEARCH_FILE_BYTES)
        if not payload.strip():
            raise ValueError("literature_result_artifact_empty")
        artifacts.append(PreparedDeliveryArtifact(path, sha256(payload).hexdigest(), role))
        seen_paths.add(path)
    return PreparedFinalDelivery(tuple(artifacts))


def project_papers(raw_papers: list[dict]) -> list[SearchPaper]:
    papers = []
    identities = set()
    for raw in raw_papers:
        if not isinstance(raw, dict) or raw.get("is_placeholder") is not False:
            raise ValueError("literature_result_invalid_paper")
        relevance = raw.get("relevance") or {}
        reasons = _strings(relevance.get("reasons"), 10) if isinstance(relevance, dict) else []
        identity = _text(raw.get("id"), SEARCH_SHORT)
        title = _text(raw.get("title"))
        if not identity or not title:
            raise ValueError("literature_result_invalid_paper")
        paper = SearchPaper(
            id=identity,
            title=title,
            authors=_strings(raw.get("authors")),
            year=raw.get("year"),
            venue=_text(raw.get("venue")) or None,
            doi=_text(raw.get("doi"), SEARCH_SHORT) or None,
            url=raw.get("url"),
            abstract=_text(raw.get("abstract") or raw.get("abstract_summary")) or None,
            reasons=reasons,
            tier=_count(raw.get("tier")),
            citation_count=_count(raw.get("citation_count")),
            access=raw.get("open_access", "unknown"),
            sources=list(
                dict.fromkeys(
                    [_text(raw.get("source"), SEARCH_SHORT), *_strings(raw.get("also_found_by"))]
                )
            ),
        )
        if paper.id in identities:
            raise ValueError("literature_result_duplicate_id")
        identities.add(paper.id)
        papers.append(paper)
    return papers


def project_selected_papers(
    papers: list[SearchPaper], selection: object, expected_run_id: str
) -> list[SearchPaper]:
    if not isinstance(selection, dict):
        raise ValueError("literature_result_selection_invalid")
    selected_ids = selection.get("selected_paper_ids")
    if (
        selection.get("run_id") != expected_run_id
        or selection.get("confirmed_by_user") is not True
        or not isinstance(selected_ids, list)
        or not selected_ids
        or len(selected_ids) > SEARCH_MAX_PAPERS
        or any(not isinstance(paper_id, str) or not paper_id for paper_id in selected_ids)
        or len(selected_ids) != len(set(selected_ids))
    ):
        raise ValueError("literature_result_selection_invalid")
    by_id = {paper.id: paper for paper in papers}
    if any(paper_id not in by_id for paper_id in selected_ids):
        raise ValueError("literature_result_selection_unknown_paper")
    return [
        by_id[paper_id].model_copy(update={"decision": "included"}) for paper_id in selected_ids
    ]


def prepare_result(
    workdir: Path, run: str, checkpoint: Literal["search", "selection"] = "search"
) -> PreparedSearchResult:
    """Consume explicit run pointers; never discover or rewrite skill artifacts."""
    root = _relative(run)
    state = _object(workdir, scoped_relative(root, SEARCH_STATE_FILE))
    paths = state.get("paths")
    if not isinstance(paths, dict):
        raise ValueError("literature_result_paths_missing")
    metadata_path = scoped_relative(root, _relative(paths.get("latest_metadata")))
    report_path = scoped_relative(root, _relative(paths.get("latest_search_report")))
    if scoped_parent(metadata_path) != scoped_parent(report_path):
        raise ValueError("literature_result_round_mismatch")
    metadata_bytes = read_scoped_file(workdir, metadata_path, SEARCH_FILE_BYTES)
    metadata = json.loads(metadata_bytes)
    if not isinstance(metadata, dict):
        raise ValueError("literature_result_metadata_invalid")
    intent = _object(
        workdir, scoped_relative(root, _relative(paths.get("intent", SEARCH_INTENT_FILE)))
    )
    if intent.get("confirmed") is not True:
        raise ValueError("literature_result_intent_unconfirmed")
    if (
        not metadata.get("run_id")
        or metadata.get("run_id") != state.get("run_id")
        or metadata.get("round") != state.get("search_round")
    ):
        raise ValueError("literature_result_round_mismatch")
    raw_papers = metadata.get("papers")
    if (
        metadata.get("is_placeholder") is not False
        or not isinstance(raw_papers, list)
        or len(raw_papers) > SEARCH_MAX_PAPERS
    ):
        raise ValueError("literature_result_invalid")
    status_value = metadata.get("status")
    if not isinstance(status_value, str) or status_value not in SEARCH_STATUSES:
        raise ValueError("literature_result_status_invalid")
    status = cast(SearchStatus, status_value)
    if (status in SEARCH_SUCCESS) != bool(raw_papers):
        raise ValueError("literature_result_status_mismatch")
    warnings = _strings(metadata.get("warnings"))
    sources: list[SearchSource] = []
    pool_count = None
    try:
        search_state = _object(
            workdir,
            scoped_relative(scoped_parent(metadata_path), SEARCH_WORK, SEARCH_STATE_FILE),
        )
        details = search_state.get("source_details", {})
        if isinstance(details, dict):
            for name, detail in details.items():
                if not isinstance(detail, dict):
                    continue
                source_status = detail.get("status")
                sources.append(
                    SearchSource(
                        name=_text(name, SEARCH_SHORT),
                        status=(
                            source_status
                            if isinstance(source_status, str) and source_status in SOURCE_STATUSES
                            else "unknown"
                        ),
                        queries=_count(detail.get("queries")),
                        candidates=_count(detail.get("candidates")),
                    )
                )
        pool_count = _count(search_state.get("pool_size"))
    except (OSError, ValueError):
        warnings.append("本轮来源或候选池统计未记录，无法核对完整检索过程。")
    if sources and not any(source.status in SOURCE_SUCCESS for source in sources) and raw_papers:
        raise ValueError("literature_result_no_successful_source")
    if status == "success" and any(source.status not in SOURCE_SUCCESS for source in sources):
        status = "partial"
    if not sources:
        warnings.append("检索来源统计未记录。")
    candidate_count = (
        sum(source.candidates for source in sources if source.candidates is not None)
        if sources and all(source.candidates is not None for source in sources)
        else None
    )
    if candidate_count is not None and pool_count is not None and candidate_count < pool_count:
        candidate_count = None
        warnings.append("来源候选数与候选池口径不一致，候选总数无法核对。")
    papers = project_papers(raw_papers)
    selection_path = None
    selection_sha256 = None
    authorization_sources: tuple[AuthorizationSource, ...] = ()
    if checkpoint == "selection":
        selection_pointer = paths.get("selection", SEARCH_SELECTION_FILE)
        if selection_pointer is None:
            raise ValueError(SELECTION_NOT_PREPARED)
        selection_path = scoped_relative(root, _relative(selection_pointer))
        selection_bytes = read_scoped_file(workdir, selection_path, SEARCH_FILE_BYTES)
        selection = json.loads(selection_bytes)
        if not isinstance(selection, dict):
            raise ValueError("literature_result_selection_invalid")
        selection_metadata_path = scoped_relative(root, _relative(selection.get("metadata_path")))
        if selection_metadata_path != metadata_path:
            raise ValueError("literature_result_selection_round_mismatch")
        papers = project_selected_papers(papers, selection, str(state.get("run_id", "")))
        selection_sha256 = sha256(selection_bytes).hexdigest()
        authorization_sources = tuple(authorization_source(paper) for paper in papers)
    if pool_count is not None and pool_count < len(papers):
        pool_count = None
        warnings.append("候选池统计少于最终保留数量，去重数量无法核对。")
    report_bytes = read_scoped_file(workdir, str(report_path), SEARCH_FILE_BYTES)
    if not report_bytes.strip():
        raise ValueError("literature_result_report_empty")
    card = SearchResult(
        run_id=metadata["run_id"],
        round=metadata["round"],
        criteria=_criteria(intent),
        status=status,
        sources=sources,
        candidates=candidate_count,
        deduplicated=pool_count,
        retained=len(papers),
        papers=papers[:SEARCH_CARD_PAPERS],
        warnings=list(dict.fromkeys(warnings)),
    )
    return PreparedSearchResult(
        card,
        report_path,
        sha256(report_bytes).hexdigest(),
        metadata_path,
        sha256(metadata_bytes).hexdigest(),
        selection_path,
        selection_sha256,
        authorization_sources,
    )
