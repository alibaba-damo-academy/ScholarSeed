"""Project immutable SLR checkpoints from skill-owned evidence files."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Literal, Mapping, cast

from pydantic import BaseModel, ConfigDict, Field

from service.literature.persistence.files import (
    read_scoped_file,
    scoped_workspace,
    scoped_workspace_path,
)
from service.literature.service.metadata import parse_bibtex
from service.literature.service.result import (
    AUTHORIZATION_ARTIFACT_PREFIX,
    LITERATURE_REVIEW_ORIGIN,
    SEARCH_AUTHORS,
    SEARCH_CARD_PAPERS,
    SEARCH_MAX_PAPERS,
    AuthorizationSource,
    SearchPaper,
    SearchPaperDetail,
    SearchResult,
    SearchSource,
    authorization_source,
)

logger = logging.getLogger(__name__)

REVIEW_CARD = "literature-review"
REVIEW_VERSION: Literal["1.1"] = "1.1"
REVIEW_RESULT_CHECKPOINT = "result"
REVIEW_INCOMPLETE_STATUS = "incomplete"
REVIEW_FILE_BYTES = 16 * 1024 * 1024
REVIEW_SECTIONS = 8
REVIEW_CHILDREN = 8
REVIEW_TEXT = 2000
REVIEW_TITLE = 256
REVIEW_CHECKS = 16
REVIEW_ISSUES = 32
REVIEW_CITATIONS = 100
FULLTEXT_LIMITATION_REASONS = {
    "not_in_paperhub": "全文来源暂未返回可下载文件，仅使用摘要证据",
    "auth_failed": "全文服务认证失败",
    "fetch_failed": "全文服务暂时不可用",
    "extract_failed": "全文解析失败",
    "too_large": "全文文件超过可处理大小限制",
    "not_a_pdf": "全文格式无法解析",
}
YEAR_RANGE = re.compile(r"(?<!\d)((?:19|20)\d{2})\s*[—–-]\s*((?:19|20)\d{2})(?!\d)")
QUERY = "01_input/query.json"
REQUIREMENTS = "01_input/requirements.json"
WRITING_REQUEST = "01_input/writing_request.json"
METADATA = "02_retrieval/metadata.json"
CORPUS = "02_retrieval/selected_paper.json"
RETRIEVAL = "02_retrieval/retrieval_report.json"
FULLTEXT = "02_retrieval/fulltext_report.json"
CHECKPOINT_FILE_BYTES = 64 * 1024
RETRIEVAL_CHECKPOINT_KIND = "literature_review.retrieval_ready"
RETRIEVAL_CHECKPOINT = "retrieval"
RETRIEVAL_STAGE = "retrieval_adapt"
RETRIEVAL_STAGE_STATUS = "_status/retrieval_adapt.json"
RETRIEVAL_USABLE_STATUSES = frozenset(("SUCCESS", "PARTIAL_SUCCESS"))
REVIEW_BINDING = ".slr-binding.json"
REVIEW_BINDING_RUN_ID = "run_id"
# Skill releases without a launcher run id are identified by their workspace path.
REVIEW_DERIVED_RUN_PREFIX = "slr-"
REVIEW_DERIVED_RUN_CHARS = 16
RETRIEVAL_CHECKPOINT_ARTIFACTS = {
    "metadata": METADATA,
    "selection": CORPUS,
    "report": RETRIEVAL,
}
PAPER_CARDS = "03_process/paper_cards.json"
SUMMARY = "03_process/corpus_summary.json"
OUTLINE = "04_outline/outline.json"
OUTPUT_SPEC = "04_outline/output_spec.json"
APPROVAL = "04_outline/approval.json"
GENERATION = "05_generation/generation_report.json"
QUALITY = "05_generation/quality_report.json"
CITATIONS = "05_generation/citations.bib"
POSTCHECK = "07_verifier/postcheck/report.json"
FAST_AUDIT = "07_verifier/fast_audit/output/aggregated_issues.json"
INCOMPLETE_EVIDENCE_WARNINGS = {
    (CORPUS,): "检索筛选产物缺失，无法统计最终纳入；请恢复检索与筛选流程。",
    (FULLTEXT, SUMMARY): "全文与材料处理统计缺失，无法区分全文和摘要级证据。",
    (GENERATION,): "生成报告缺失，当前正文不能作为已完成综述的证据。",
    (POSTCHECK,): "核验报告缺失，引用与待核对统计尚不可确认。",
}
JSON_FILES = (
    QUERY,
    REQUIREMENTS,
    WRITING_REQUEST,
    METADATA,
    CORPUS,
    RETRIEVAL,
    FULLTEXT,
    PAPER_CARDS,
    SUMMARY,
    OUTLINE,
    OUTPUT_SPEC,
    APPROVAL,
    GENERATION,
    QUALITY,
    POSTCHECK,
    FAST_AUDIT,
)
EVIDENCE_TITLES = {
    QUERY: "精确任务意图",
    REQUIREMENTS: "任务与材料范围",
    WRITING_REQUEST: "综述任务要求",
    METADATA: "检索候选",
    CORPUS: "检索筛选文献",
    RETRIEVAL: "检索筛选报告",
    FULLTEXT: "全文获取报告",
    PAPER_CARDS: "PaperCard",
    SUMMARY: "材料处理统计",
    OUTLINE: "大纲数据",
    OUTPUT_SPEC: "输出与引用格式",
    APPROVAL: "出版选择",
    GENERATION: "生成报告",
    QUALITY: "质量报告",
    POSTCHECK: "引用核对详情",
    FAST_AUDIT: "引用预核对问题",
}
DOCUMENT_FILES = {
    "02_retrieval/report.md": "检索报告",
    "04_outline/outline.md": "完整大纲",
    "04_outline/outline_rationale.md": "结构与证据缺口",
    CITATIONS: "实际引用书目",
    "06_output/survey.md": "综述正文",
    "06_output/survey.pdf": "综述 PDF",
    "06_output/survey_fallback.md": "编译降级稿",
    "07_verifier/fast_audit/output/final_report.md": "引用预核对报告",
    "07_verifier/postcheck/summary.md": "引用核对报告",
}
CHECK_LABELS = {
    "cite_sync": "引用与书目一致性",
    "citation_format": "引用格式完整性",
    "citation_fidelity": "引用样式一致性",
    "page_render": "页面渲染检查",
    "number_fidelity": "输出数字一致性",
    "req_special": "特殊要求检查",
    "deliverable": "交付文件检查",
}
POSTCHECK_SCHEMA = "slr/postcheck/1"
CHECK_VERDICTS = frozenset(("PASS", "WARN", "FAIL", "NOT_CHECKED", "NOT_APPLICABLE"))
GENERATION_PRESENTATION = {"SUCCESS": "generated", "PARTIAL_SUCCESS": "partial", "FAILED": "failed"}
GENERATION_STATUSES = frozenset(GENERATION_PRESENTATION)
PUBLICATION_REPORT_STATUSES = GENERATION_STATUSES | {"WARNING"}
PUBLICATION_CHECK_STATUSES = frozenset(("SUCCESS", "WARNING", "FAILED"))
PUBLICATION_CITATION_CHECK_IDS = frozenset(
    ("unknown_citations", "bibliography_ownership", "bibliography_definitions")
)
PUBLICATION_STATUS_PRIORITY = {"SUCCESS": 0, "WARNING": 1, "FAILED": 2}
PUBLICATION_PROJECTED_CHECKS = {
    "citation_metadata": "citation_format",
    "citation_fidelity": "citation_fidelity",
}
METADATA_MISSING_FIELDS = ("missing_required", "missing_recommended", "missing")
PUBLICATION_CHECK_IDS = frozenset(
    (
        "unknown_citations",
        "unresolved_references",
        "planned_chapters",
        "planned_tables",
        "plan_advice",
        "compilation",
        "bibliography_ownership",
        "bibliography_definitions",
        "visual_inspection_scope",
    )
) | frozenset(PUBLICATION_PROJECTED_CHECKS)
PUBLICATION_STRUCTURAL_CHECK_IDS = frozenset(
    ("unresolved_references", "planned_chapters", "planned_tables", "plan_advice")
)
PUBLICATION_VERDICTS = {"SUCCESS": "PASS", "WARNING": "WARN", "FAILED": "FAIL"}


class ReviewRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ReviewSection(ReviewRecord):
    id: str = Field(max_length=REVIEW_TITLE)
    title: str = Field(min_length=1, max_length=REVIEW_TITLE)
    description: str = Field(max_length=REVIEW_TEXT)
    papers: int = Field(ge=0)
    children: list[str] = Field(max_length=REVIEW_CHILDREN)
    comparison_tables: list[str] = Field(default_factory=list, max_length=REVIEW_CHILDREN)


class ReviewCheck(ReviewRecord):
    title: str = Field(max_length=REVIEW_TITLE)
    verdict: Literal["PASS", "WARN", "FAIL", "NOT_CHECKED", "NOT_APPLICABLE"]
    reason: str = Field(max_length=REVIEW_TEXT)


class ReviewScope(ReviewRecord):
    topic: str = Field(max_length=REVIEW_TEXT)
    time_range: str = Field(max_length=REVIEW_TITLE)
    focus: list[str] = Field(max_length=REVIEW_CHILDREN)
    requested_materials: list[str] = Field(default_factory=list, max_length=REVIEW_CHILDREN)
    project_materials: int | None = Field(default=None, ge=0)
    external_materials: int | None = Field(default=None, ge=0)


class ReviewCitation(ReviewRecord):
    title: str = Field(max_length=REVIEW_TEXT)
    authors: str = Field(max_length=REVIEW_TEXT)
    year: int | None = None
    venue: str = Field(max_length=REVIEW_TEXT)


class ReviewIssue(ReviewRecord):
    title: str = Field(max_length=REVIEW_TITLE)
    detail: str = Field(max_length=REVIEW_TEXT)
    paper_ids: list[str] = Field(default_factory=list, max_length=REVIEW_CHILDREN)
    affected_content: str = Field(default="", max_length=REVIEW_TEXT)


class ReviewEvidenceLimitation(ReviewRecord):
    paper_id: str = Field(max_length=REVIEW_TITLE)
    title: str = Field(max_length=REVIEW_TEXT)
    reason: str = Field(max_length=REVIEW_TEXT)


class ReviewOutput(ReviewRecord):
    format: Literal["latex_pdf", "markdown"] | None = None
    citation_style: Literal["numeric", "author_year", "ieee", "acm", "gbt7714_2025"] | None = None
    decided_by: Literal["user", "default"] | None = None


class ReviewSnapshot(ReviewRecord):
    schema_version: Literal["1.1"] = REVIEW_VERSION
    workspace: str
    checkpoint: Literal["outline", "result"]
    intent: str = Field(min_length=1, max_length=REVIEW_TEXT)
    title: str = Field(max_length=REVIEW_TITLE)
    status: Literal["outline", "generated", "partial", "incomplete", "failed"]
    generation_status: Literal["SUCCESS", "PARTIAL_SUCCESS", "FAILED"] | None = None
    scope: ReviewScope
    output: ReviewOutput
    included: int | None = Field(default=None, ge=0)
    fulltext: int | None = Field(default=None, ge=0)
    abstract_only: int | None = Field(default=None, ge=0)
    pending_checks: int | None = Field(default=None, ge=0)
    cited: int | None = Field(default=None, ge=0)
    section_count: int = Field(ge=0)
    sections: list[ReviewSection] = Field(max_length=REVIEW_SECTIONS)
    citations: list[ReviewCitation] = Field(max_length=REVIEW_CITATIONS)
    abstract_evidence: list[ReviewEvidenceLimitation] = Field(max_length=REVIEW_CITATIONS)
    checks: list[ReviewCheck] = Field(max_length=REVIEW_CHECKS)
    issues: list[ReviewIssue] = Field(max_length=REVIEW_ISSUES)
    issue_count: int | None = Field(default=None, ge=0)
    warnings: list[str]
    source_hashes: dict[str, str]
    session_id: str = ""
    artifacts: list[dict] = Field(default_factory=list)


@dataclass(frozen=True)
class ReviewFile:
    path: str
    digest: str
    title: str


@dataclass(frozen=True)
class PreparedReview:
    card: ReviewSnapshot
    files: tuple[ReviewFile, ...]


@dataclass(frozen=True)
class PreparedReviewSearch:
    card: SearchResult
    files: tuple[ReviewFile, ...]
    authorization_sources: tuple[AuthorizationSource, ...]
    corpus_sha256: str

    @property
    def authorization_refs(self) -> tuple[str, ...]:
        if not self.authorization_sources or not self.corpus_sha256:
            return ()
        return (
            *(source.ref_id for source in self.authorization_sources),
            f"{AUTHORIZATION_ARTIFACT_PREFIX}{self.corpus_sha256}",
        )


def validate_review_card(value: Mapping[str, Any]) -> dict[str, Any]:
    return ReviewSnapshot.model_validate(value).model_dump(mode="json")


def _text(value: object, limit: int | None = REVIEW_TEXT) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _count(value: object) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _fulltext_limitation_reason(row: Mapping[str, Any]) -> str:
    outcome = _text(row.get("outcome"))
    return FULLTEXT_LIMITATION_REASONS.get(outcome, "未取得全文，只能支持题录或摘要层判断")


def _strings(value: object, limit: int = REVIEW_CHILDREN) -> list[str]:
    return [_text(item) for item in value[:limit] if _text(item)] if isinstance(value, list) else []


def _load(
    workdir: Path, workspace: str, names: tuple[str, ...]
) -> tuple[dict[str, Any], dict[str, str], list[ReviewFile]]:
    values: dict[str, Any] = {}
    hashes: dict[str, str] = {}
    files: list[ReviewFile] = []
    for name in dict.fromkeys(names):
        relative = scoped_workspace_path(workspace, name)
        try:
            raw = read_scoped_file(workdir, relative, REVIEW_FILE_BYTES)
        except FileNotFoundError:
            continue
        if not raw.strip():
            raise ValueError("review_artifact_empty")
        digest = sha256(raw).hexdigest()
        hashes[relative] = digest
        if name in JSON_FILES:
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError("review_artifact_invalid")
            values[name] = value
        else:
            values[name] = raw.decode("utf-8", errors="replace")
        files.append(
            ReviewFile(relative, digest, DOCUMENT_FILES.get(name, EVIDENCE_TITLES.get(name, name)))
        )
    return values, hashes, files


def _authors(value: object, *, complete: bool = False) -> list[str]:
    if not isinstance(value, list):
        return []
    result = []
    for author in value:
        if isinstance(author, str) and author.strip():
            result.append(author.strip())
        elif isinstance(author, dict):
            name = _text(
                author.get("name") or author.get("display_name"), None if complete else REVIEW_TEXT
            )
            if not name:
                name = " ".join(
                    filter(
                        None,
                        (
                            _text(author.get("first"), None if complete else REVIEW_TEXT),
                            _text(author.get("last"), None if complete else REVIEW_TEXT),
                        ),
                    )
                )
            if name:
                result.append(name)
    return result[: None if complete else SEARCH_AUTHORS]


def _venue(value: object, limit: int | None = REVIEW_TEXT) -> str:
    return _text(value.get("name"), limit) if isinstance(value, dict) else _text(value, limit)


def _sections(outline: dict, corpus: dict | None) -> tuple[int, list[ReviewSection]]:
    tree = outline.get("outline_tree", [])
    if not isinstance(tree, list):
        raise ValueError("review_outline_invalid")
    result = []
    seen = set()
    for section in tree:
        if not isinstance(section, dict) or not _text(section.get("title")):
            raise ValueError("review_outline_invalid")
        sid = _text(section.get("section_id"), REVIEW_TITLE)
        if not sid or sid in seen:
            raise ValueError("review_outline_identity_invalid")
        seen.add(sid)
        children = section.get("subsections", [])
        if not isinstance(children, list):
            raise ValueError("review_outline_invalid")
        papers = set(_strings(section.get("paper_ids"), REVIEW_CITATIONS))
        titles = []
        for child in children:
            if not isinstance(child, dict) or not _text(child.get("title")):
                raise ValueError("review_outline_invalid")
            ids = child.get("paper_ids", [])
            if not isinstance(ids, list) or any(not isinstance(pid, str) for pid in ids):
                raise ValueError("review_outline_papers_invalid")
            papers.update(ids)
            titles.append(_text(child["title"], REVIEW_TITLE))
        if corpus is None or papers.difference(corpus):
            raise ValueError("review_outline_corpus_mismatch")
        tables = section.get("tables", [])
        if not isinstance(tables, list):
            raise ValueError("review_outline_tables_invalid")
        result.append(
            ReviewSection(
                id=sid,
                title=_text(section["title"], REVIEW_TITLE),
                description=_text(section.get("description")),
                papers=len(papers),
                children=titles[:REVIEW_CHILDREN],
                comparison_tables=[
                    _text(table.get("caption"), REVIEW_TITLE)
                    for table in tables
                    if isinstance(table, dict) and _text(table.get("caption"))
                ][:REVIEW_CHILDREN],
            )
        )
    return len(result), result[:REVIEW_SECTIONS]


def _scope(query: dict, requirements: dict, corpus: dict | None) -> ReviewScope:
    if "intent" in requirements:
        retrieval = requirements.get("retrieval", {})
        if not isinstance(retrieval, dict):
            retrieval = {}
        window = retrieval.get("time_range", {})
        if not isinstance(window, dict):
            window = {}
        start, end = window.get("start_year"), window.get("end_year")
        time_range = f"{start or '不限'}–{end or '不限'}"
        if retrieval.get("temporal_policy") == "soft_preference":
            time_range += "；允许早期基础文献"
        dimensions = retrieval.get("dimensions", {})
        focus = []
        if isinstance(dimensions, dict):
            for value in dimensions.values():
                focus.extend(_strings(value))
        constraints = requirements.get("constraints", [])
        if not isinstance(constraints, list):
            constraints = []
        focus.extend(
            _text(row.get("verbatim"))
            for row in constraints
            if isinstance(row, dict) and row.get("kind") in {"angle", "required_section", "other"}
        )
        requested_materials = [
            _text(row.get("value", {}).get("title"))
            for row in constraints
            if isinstance(row, dict)
            and row.get("kind") == "must_include_paper"
            and isinstance(row.get("value"), dict)
        ]
        project = external = 0
        for paper in (corpus or {}).values():
            if not isinstance(paper, dict):
                continue
            origin = _text(paper.get("source_kind") or paper.get("origin")).casefold()
            if (
                paper.get("literature_id")
                or paper.get("project_id")
                or origin in {"project", "library", "local"}
            ):
                project += 1
            else:
                external += 1
        return ReviewScope(
            topic=_text(requirements.get("effective_requirements"))
            or _text(requirements.get("intent")),
            time_range=time_range,
            focus=list(dict.fromkeys(filter(None, focus)))[:REVIEW_CHILDREN],
            requested_materials=list(dict.fromkeys(filter(None, requested_materials)))[
                :REVIEW_CHILDREN
            ],
            project_materials=project if corpus is not None else None,
            external_materials=external if corpus is not None else None,
        )
    normal = requirements.get("req_normal", {})
    if not isinstance(normal, dict):
        normal = {}
    window = normal.get("time_range", {})
    temporal = query.get("temporal_policy", {})
    start = window.get("start_year") if isinstance(window, dict) else None
    end = window.get("end_year") if isinstance(window, dict) else None
    if start is None:
        match = YEAR_RANGE.search(_text(normal.get("topic")) or _text(query.get("query")))
        if match:
            start, end = (int(value) for value in match.groups())
    if start is None and isinstance(temporal, dict):
        start = temporal.get("start_year") or temporal.get("from_year")
        end = temporal.get("end_year") or temporal.get("to_year")
        default_window = temporal.get("default_if_unspecified", {})
        if start is None and isinstance(default_window, dict):
            start = default_window.get("start_year")
            end = default_window.get("end_year")
    time_range = f"{start or '不限'}–{end or '不限'}"
    if isinstance(temporal, dict) and temporal.get("allow_earlier_foundational_work") is True:
        time_range += "；允许早期基础文献"
    dimensions = normal.get("dimensions", {})
    focus = []
    if isinstance(dimensions, dict):
        focus.extend(_strings(dimensions.get("analysis")))
        focus.extend(_strings(dimensions.get("custom")))
    for requirement in requirements.get("req_special", []):
        if isinstance(requirement, dict) and requirement.get("kind") in {
            "angle",
            "required_section",
            "other",
        }:
            wording = _text(requirement.get("verbatim"))
            if wording:
                focus.append(wording)
    requested_materials = []
    for requirement in requirements.get("req_special", []):
        if not isinstance(requirement, dict) or requirement.get("kind") != "must_include_paper":
            continue
        value = requirement.get("value", {})
        title = _text(value.get("title")) if isinstance(value, dict) else ""
        if title:
            requested_materials.append(title)
    project = external = 0
    known = corpus is not None
    for paper in (corpus or {}).values():
        if not isinstance(paper, dict):
            continue
        origin = _text(paper.get("source_kind") or paper.get("origin")).casefold()
        if (
            paper.get("literature_id")
            or paper.get("project_id")
            or origin in {"project", "library", "local"}
        ):
            project += 1
        else:
            external += 1
    return ReviewScope(
        topic=_text(normal.get("topic")) or _text(query.get("query")),
        time_range=time_range,
        focus=list(dict.fromkeys(focus))[:REVIEW_CHILDREN],
        requested_materials=list(dict.fromkeys(requested_materials))[:REVIEW_CHILDREN],
        project_materials=project if known else None,
        external_materials=external if known else None,
    )


def _issues(postcheck: dict, retrieval: dict, fast_audit: dict) -> list[ReviewIssue]:
    issues = []
    for row in retrieval.get("flagged_for_review", []):
        if isinstance(row, dict):
            issues.append(
                ReviewIssue(
                    title="检索筛选待核对",
                    detail=_text(row.get("reason")) or "筛选报告标记为待核对",
                    paper_ids=_strings([row.get("paper_id")]),
                    affected_content=_text(row.get("affected_content")),
                )
            )
    for check in postcheck.get("checks", []):
        if isinstance(check, dict) and check.get("verdict") in {"WARN", "FAIL", "NOT_CHECKED"}:
            issues.append(
                ReviewIssue(
                    title=_text(check.get("title"))
                    or CHECK_LABELS.get(_text(check.get("id"), REVIEW_TITLE), "核对问题"),
                    detail=_text(check.get("reason")),
                    paper_ids=_strings(check.get("paper_ids")),
                    affected_content=_text(check.get("affected_content") or check.get("section")),
                )
            )
            for entry in check.get("incomplete_entries", []) or []:
                if isinstance(entry, dict) and _text(entry.get("key")):
                    missing = list(
                        dict.fromkeys(
                            field
                            for name in METADATA_MISSING_FIELDS
                            for field in _strings(entry.get(name))
                        )
                    )
                    issues.append(
                        ReviewIssue(
                            title="引用元数据不完整",
                            detail=(
                                ("缺少字段：" + "、".join(missing))
                                if missing
                                else _text(check.get("reason"))
                            ),
                            paper_ids=[_text(entry.get("key"), REVIEW_TITLE)],
                            affected_content="参考文献表",
                        )
                    )
    for key in postcheck.get("hallucinated_keys", []):
        if isinstance(key, str):
            issues.append(
                ReviewIssue(
                    title="引用无法对应",
                    detail=f"引用键 {key} 未在实际书目中找到",
                    paper_ids=[_text(key, REVIEW_TITLE)],
                    affected_content="正文引用与参考文献表",
                )
            )
    raw_fast = fast_audit.get("issues", fast_audit.get("items", []))
    if isinstance(raw_fast, list):
        for row in raw_fast:
            if isinstance(row, dict):
                issues.append(
                    ReviewIssue(
                        title=_text(row.get("title") or row.get("kind")) or "引用预核对问题",
                        detail=_text(row.get("details") or row.get("reason")),
                        paper_ids=_strings(row.get("paper_ids")),
                        affected_content=_text(row.get("affected_content") or row.get("location")),
                    )
                )
    return issues


def _publication_reason(check: dict) -> str:
    for field, label in (("unknown", "未知引用键"), ("missing", "缺失项")):
        values = _strings(check.get(field))
        if values:
            return f"{label}：{'、'.join(values)}"
    message = _text(check.get("message"))
    if message:
        return message
    diagnosis = check.get("diagnosis")
    if isinstance(diagnosis, dict):
        fatal = _strings(diagnosis.get("fatal_errors"))
        if fatal:
            return "；".join(fatal)
    return ""


def _adapt_publication_postcheck(postcheck: dict, generation: dict) -> tuple[dict, bool]:
    """Adapt the bundled skill's raw publication audit at the product boundary."""
    if not postcheck:
        return postcheck, False
    schema = postcheck.get("schema")
    if schema is not None:
        if schema != POSTCHECK_SCHEMA:
            raise ValueError("review_postcheck_version_invalid")
        return postcheck, False
    if postcheck.get("status") not in PUBLICATION_REPORT_STATUSES:
        raise ValueError("review_postcheck_version_invalid")
    raw_checks = postcheck.get("checks")
    if not isinstance(raw_checks, list):
        raise ValueError("review_check_invalid")
    facts = postcheck.get("facts", {})
    if not isinstance(facts, dict):
        raise ValueError("review_facts_invalid")
    checks_by_id = {}
    for check in raw_checks:
        if not isinstance(check, dict) or check.get("status") not in PUBLICATION_CHECK_STATUSES:
            raise ValueError("review_check_invalid")
        identity = check.get("id")
        if identity not in PUBLICATION_CHECK_IDS or identity in checks_by_id:
            raise ValueError("review_check_identity_invalid")
        checks_by_id[identity] = check

    checks = []
    citation_checks = [
        check
        for identity, check in checks_by_id.items()
        if identity in PUBLICATION_CITATION_CHECK_IDS
    ]
    if citation_checks:
        citations = max(
            citation_checks, key=lambda check: PUBLICATION_STATUS_PRIORITY[check["status"]]
        )
        checks.append(
            {
                "id": "cite_sync",
                "verdict": PUBLICATION_VERDICTS[citations["status"]],
                "reason": _publication_reason(citations),
            }
        )
    for identity, projected_identity in PUBLICATION_PROJECTED_CHECKS.items():
        if identity in checks_by_id:
            check = checks_by_id[identity]
            checks.append(
                {
                    **check,
                    "id": projected_identity,
                    "verdict": PUBLICATION_VERDICTS[check["status"]],
                    "reason": _publication_reason(check),
                }
            )
    if "visual_review_required" in postcheck:
        if not postcheck.get("visual_review_required"):
            render_verdict = "NOT_APPLICABLE"
        elif (
            postcheck.get("render_error")
            or checks_by_id.get("visual_inspection_scope", {}).get("status", "SUCCESS") != "SUCCESS"
        ):
            render_verdict = "WARN"
        elif postcheck.get("pages_to_read"):
            render_verdict = "PASS"
        else:
            render_verdict = "NOT_CHECKED"
        checks.append(
            {
                "id": "page_render",
                "verdict": render_verdict,
                "reason": _text(postcheck.get("render_error")),
            }
        )
    generation_status = generation.get("status")
    if generation_status in GENERATION_STATUSES:
        structural_warnings = [
            check
            for identity, check in checks_by_id.items()
            if identity in PUBLICATION_STRUCTURAL_CHECK_IDS and check["status"] != "SUCCESS"
        ]
        if generation_status == "FAILED":
            deliverable_verdict = "FAIL"
        elif generation_status == "PARTIAL_SUCCESS" or structural_warnings:
            deliverable_verdict = "WARN"
        elif generation.get("deliverable"):
            deliverable_verdict = "PASS"
        else:
            deliverable_verdict = "WARN"
        checks.append(
            {
                "id": "deliverable",
                "verdict": deliverable_verdict,
                "reason": "；".join(
                    reason
                    for reason in (_publication_reason(check) for check in structural_warnings)
                    if reason
                )
                or _text(generation.get("status_reason") or generation.get("message")),
            }
        )
    return (
        {
            **postcheck,
            "schema": POSTCHECK_SCHEMA,
            "facts": facts,
            "checks": checks,
            "publication_checks": raw_checks,
        },
        True,
    )


def prepare_review(workdir: Path, workspace: str, checkpoint: str) -> PreparedReview:
    """Read a bounded allowlist, never change the survey or infer missing success."""

    if checkpoint not in {"outline", "result"}:
        raise ValueError("review_checkpoint_invalid")
    normalized_checkpoint = cast(Literal["outline", "result"], checkpoint)
    workspace = scoped_workspace(workspace)
    values, hashes, files = _load(workdir, workspace, (*JSON_FILES, *DOCUMENT_FILES))
    query = values.get(QUERY, {})
    requirements = values.get(REQUIREMENTS, {})
    writing_request = values.get(WRITING_REQUEST, {})
    intent = _text(writing_request.get("intent")) or _text(query.get("query"))
    if not intent:
        raise ValueError("review_intent_missing")
    corpus = values.get(CORPUS)
    if corpus is not None and any(
        not isinstance(paper, dict) or not _text(paper.get("title")) for paper in corpus.values()
    ):
        raise ValueError("review_corpus_invalid")
    outline = values.get(OUTLINE, {})
    total, sections = _sections(outline, corpus)
    if checkpoint == "outline" and not sections:
        raise ValueError("review_outline_missing")
    summary = values.get(SUMMARY, {})
    fulltext_report = values.get(FULLTEXT, {})
    fulltext = _count(fulltext_report.get("with_full_text"))
    if fulltext is None:
        fulltext = _count(summary.get("with_full_text"))
    if fulltext is None:
        fulltext = _count(summary.get("with_fulltext"))
    included = len(corpus) if corpus is not None else None
    if fulltext is not None and (included is None or fulltext > included):
        raise ValueError("review_coverage_invalid")
    abstract_only = included - fulltext if included is not None and fulltext is not None else None
    abstract_evidence = []
    for row in fulltext_report.get("papers", []):
        if not isinstance(row, dict) or row.get("paper_id") not in (corpus or {}):
            continue
        if (_count(row.get("chars")) or 0) > 0:
            continue
        paper_id = _text(row.get("paper_id"), REVIEW_TITLE)
        paper = (corpus or {}).get(paper_id, {})
        abstract_evidence.append(
            ReviewEvidenceLimitation(
                paper_id=paper_id,
                title=_text(paper.get("title")) if isinstance(paper, dict) else "",
                reason=_fulltext_limitation_reason(row),
            )
        )
    generation = values.get(GENERATION, {})
    postcheck, adapted_publication = _adapt_publication_postcheck(
        values.get(POSTCHECK, {}), generation
    )
    checks = []
    seen_checks = set()
    for check in postcheck.get("checks", []):
        if not isinstance(check, dict) or check.get("verdict") not in CHECK_VERDICTS:
            raise ValueError("review_check_invalid")
        identity = check.get("id")
        if not isinstance(identity, str) or identity not in CHECK_LABELS or identity in seen_checks:
            raise ValueError("review_check_identity_invalid")
        seen_checks.add(identity)
        checks.append(
            ReviewCheck(
                title=_text(check.get("title"), REVIEW_TITLE) or CHECK_LABELS[identity],
                verdict=check["verdict"],
                reason=_text(check.get("reason")),
            )
        )
    final = generation.get("final_status")
    if final is None and adapted_publication:
        final = generation.get("status")
    if final is not None and final not in GENERATION_STATUSES:
        raise ValueError("review_generation_status_invalid")
    status = (
        "outline"
        if checkpoint == "outline"
        else (
            GENERATION_PRESENTATION.get(final, REVIEW_INCOMPLETE_STATUS)
            if final is not None
            else REVIEW_INCOMPLETE_STATUS
        )
    )
    facts = postcheck.get("facts", {})
    if not isinstance(facts, dict):
        raise ValueError("review_facts_invalid")
    warnings: list[str] = []
    if checkpoint == REVIEW_RESULT_CHECKPOINT and status == REVIEW_INCOMPLETE_STATUS:
        warnings.extend(
            message
            for artifacts, message in INCOMPLETE_EVIDENCE_WARNINGS.items()
            if not any(artifact in values for artifact in artifacts)
        )
    for label, report in (("生成报告", generation), ("核验报告", postcheck)):
        reason = _text(report.get("status_reason") or report.get("reason"))
        if reason:
            warnings.append(f"{label}：{reason}")
    citations = []
    if isinstance(values.get(CITATIONS), str):
        citations = [
            ReviewCitation(title=row.title, authors=row.authors, year=row.year, venue=row.journal)
            for row in parse_bibtex(values[CITATIONS])
            if row.title
        ][:REVIEW_CITATIONS]
    issues = _issues(postcheck, values.get(RETRIEVAL, {}), values.get(FAST_AUDIT, {}))
    pending_checks = (
        len(issues)
        if issues or postcheck or values.get(FAST_AUDIT) or values.get(RETRIEVAL)
        else None
    )
    output = {
        **values.get(OUTPUT_SPEC, {}),
        **writing_request.get("publication", {}),
    }
    card = ReviewSnapshot(
        workspace=workspace,
        checkpoint=normalized_checkpoint,
        intent=intent,
        title=_text(outline.get("survey_title"), REVIEW_TITLE) or "文献综述",
        status=cast(Literal["outline", "generated", "partial", "incomplete", "failed"], status),
        generation_status=cast(Literal["SUCCESS", "PARTIAL_SUCCESS", "FAILED"] | None, final),
        scope=_scope(query, writing_request or requirements, corpus),
        output=ReviewOutput(
            format=output.get("format"),
            citation_style=output.get("citation_style"),
            decided_by=("user" if values.get(APPROVAL) else output.get("decided_by")),
        ),
        included=included,
        fulltext=fulltext,
        abstract_only=abstract_only,
        pending_checks=pending_checks,
        cited=(
            len(citations)
            if isinstance(values.get(CITATIONS), str)
            else _count(facts.get("distinct_cited"))
        ),
        section_count=total,
        sections=sections,
        citations=citations,
        abstract_evidence=abstract_evidence[:REVIEW_CITATIONS],
        checks=checks,
        issues=issues[:REVIEW_ISSUES],
        issue_count=len(issues),
        warnings=warnings,
        source_hashes=hashes,
    )
    return PreparedReview(card, tuple(files))


def _slr_papers(
    metadata: dict, corpus: dict, report: dict, fulltext: dict, *, complete: bool = False
) -> list[SearchPaper]:
    paper_type = SearchPaperDetail if complete else SearchPaper
    text_limit = None if complete else REVIEW_TEXT
    raw_papers = metadata.get("papers")
    if not isinstance(raw_papers, list) or len(raw_papers) > SEARCH_MAX_PAPERS:
        raise ValueError("review_metadata_invalid")
    dropped = {
        row.get("paper_id"): row for row in report.get("dropped", []) if isinstance(row, dict)
    }
    fulltext_rows = {
        row.get("paper_id"): row for row in fulltext.get("papers", []) if isinstance(row, dict)
    }
    papers = []
    seen = set()
    for raw in raw_papers:
        if not isinstance(raw, dict):
            raise ValueError("review_metadata_invalid")
        identity = _text(raw.get("paper_id") or raw.get("id"), REVIEW_TITLE)
        title = _text(raw.get("title"), text_limit)
        if not identity or not title or identity in seen:
            raise ValueError("review_metadata_invalid")
        seen.add(identity)
        selected = corpus.get(identity) if isinstance(corpus, dict) else None
        decision: Literal["included", "excluded", "candidate"] = (
            "included" if isinstance(selected, dict) else "excluded"
        )
        dropped_row = dropped.get(identity, {})
        selected_reason = (
            _text((selected or {}).get("selection_reason"), text_limit)
            if isinstance(selected, dict)
            else ""
        )
        reason = (
            selected_reason
            or _text(raw.get("reason"), text_limit)
            or _text(dropped_row.get("reason"), text_limit)
        )
        row = fulltext_rows.get(identity, {})
        has_text = (_count(row.get("chars")) or 0) > 0
        record = selected if isinstance(selected, dict) else raw
        external_ids = (
            record.get("external_ids", {}) if isinstance(record.get("external_ids"), dict) else {}
        )
        papers.append(
            paper_type(
                id=identity,
                title=title,
                authors=_authors(record.get("authors"), complete=complete),
                year=record.get("year") if type(record.get("year")) is int else None,
                venue=_venue(record.get("venue"), text_limit) or None,
                doi=_text(
                    record.get("doi") or external_ids.get("DOI"), None if complete else REVIEW_TITLE
                )
                or None,
                url=_text(record.get("url"), text_limit) or None,
                abstract=_text(record.get("abstract"), text_limit) or None,
                reasons=[reason] if reason else [],
                tier=_count(record.get("tier")),
                citation_count=_count(record.get("citation_count")),
                access="unknown",
                sources=(
                    [_text(record.get("source"), None if complete else REVIEW_TITLE)]
                    if _text(record.get("source"))
                    else []
                ),
                decision=decision,
                decision_reason=reason or None,
                fulltext=(
                    "fulltext"
                    if has_text
                    else ("abstract" if decision == "included" else "unknown")
                ),
            )
        )
    return papers


def validate_review_checkpoint(
    workdir: Path,
    workspace: str,
    run_id: str,
    manifest: str,
    manifest_sha256: str,
) -> dict[str, str]:
    """Bind one retrieval checkpoint to its launcher, status and exact artifacts."""

    workspace = scoped_workspace(workspace)
    raw = read_scoped_file(
        workdir, scoped_workspace_path(workspace, manifest), CHECKPOINT_FILE_BYTES
    )
    if sha256(raw).hexdigest() != manifest_sha256:
        raise ValueError("review_checkpoint_manifest_changed")
    value = json.loads(raw)
    binding = json.loads(
        read_scoped_file(
            workdir, scoped_workspace_path(workspace, REVIEW_BINDING), CHECKPOINT_FILE_BYTES
        )
    )
    if (
        not isinstance(value, dict)
        or value.get("schema_version") != 1
        or value.get("kind") != RETRIEVAL_CHECKPOINT_KIND
        or value.get("checkpoint") != RETRIEVAL_CHECKPOINT
        or value.get("workspace") != workspace
        or value.get("run_id") != run_id
        or binding.get("schema_version") != 1
        or binding.get("run_id") != run_id
    ):
        raise ValueError("review_checkpoint_identity_invalid")
    stage_path = value.get("stage_status_path")
    if stage_path != RETRIEVAL_STAGE_STATUS:
        raise ValueError("review_checkpoint_status_invalid")
    stage = json.loads(
        read_scoped_file(
            workdir, scoped_workspace_path(workspace, stage_path), CHECKPOINT_FILE_BYTES
        )
    )
    if (
        stage.get("stage") != RETRIEVAL_STAGE
        or stage.get("status") not in RETRIEVAL_USABLE_STATUSES
    ):
        raise ValueError("review_checkpoint_status_invalid")
    artifacts = value.get("artifacts")
    if not isinstance(artifacts, list):
        raise ValueError("review_checkpoint_artifacts_invalid")
    by_role = {
        item.get("role"): item
        for item in artifacts
        if isinstance(item, dict) and isinstance(item.get("role"), str)
    }
    if set(by_role) != set(RETRIEVAL_CHECKPOINT_ARTIFACTS):
        raise ValueError("review_checkpoint_artifacts_invalid")
    expected_hashes: dict[str, str] = {}
    for role, expected_path in RETRIEVAL_CHECKPOINT_ARTIFACTS.items():
        item = by_role[role]
        if item.get("path") != expected_path:
            raise ValueError("review_checkpoint_artifacts_invalid")
        artifact = read_scoped_file(
            workdir, scoped_workspace_path(workspace, expected_path), REVIEW_FILE_BYTES
        )
        digest = sha256(artifact).hexdigest()
        if digest != item.get("sha256"):
            raise ValueError("review_checkpoint_artifact_changed")
        expected_hashes[scoped_workspace_path(workspace, expected_path)] = digest
    return expected_hashes


def review_retrieval_run(workdir: Path, workspace: str) -> str:
    """Identify a bound survey workspace whose retrieval stage finished usably.

    The launcher's run id is used when the installed skill writes one; otherwise the
    workspace itself is the identity, so a skill refresh cannot silently disable the gate.
    """

    workspace = scoped_workspace(workspace)
    stage = json.loads(
        read_scoped_file(
            workdir, scoped_workspace_path(workspace, RETRIEVAL_STAGE_STATUS), CHECKPOINT_FILE_BYTES
        )
    )
    if (
        not isinstance(stage, dict)
        or stage.get("stage") != RETRIEVAL_STAGE
        or stage.get("status") not in RETRIEVAL_USABLE_STATUSES
    ):
        raise ValueError("review_checkpoint_status_invalid")
    binding = json.loads(
        read_scoped_file(
            workdir, scoped_workspace_path(workspace, REVIEW_BINDING), CHECKPOINT_FILE_BYTES
        )
    )
    if not isinstance(binding, dict):
        raise ValueError("review_checkpoint_identity_invalid")
    run_id = binding.get(REVIEW_BINDING_RUN_ID)
    if isinstance(run_id, str) and run_id:
        return run_id
    digest = sha256(workspace.encode("utf-8")).hexdigest()
    return REVIEW_DERIVED_RUN_PREFIX + digest[:REVIEW_DERIVED_RUN_CHARS]


def prepare_review_search(workdir: Path, workspace: str, run_id: str) -> PreparedReviewSearch:
    """Project SLR retrieval artifacts into the existing saved-search card contract."""
    workspace = scoped_workspace(workspace)
    names = (QUERY, REQUIREMENTS, METADATA, CORPUS, RETRIEVAL, FULLTEXT)
    values, hashes, files = _load(workdir, workspace, names)
    query = values.get(QUERY, {})
    metadata = values.get(METADATA)
    corpus = values.get(CORPUS)
    report = values.get(RETRIEVAL)
    if (
        not isinstance(metadata, dict)
        or not isinstance(corpus, dict)
        or not isinstance(report, dict)
    ):
        raise ValueError("review_retrieval_missing")
    if not isinstance(query, dict):
        query = {}
    papers = _slr_papers(metadata, corpus, report, values.get(FULLTEXT, {}))
    papers.sort(
        key=lambda paper: (
            paper.decision != "included",
            paper.tier or SEARCH_MAX_PAPERS,
        )
    )
    source_counts: dict[str, int] = {}
    for paper in papers:
        for source in paper.sources:
            source_counts[source] = source_counts.get(source, 0) + 1
    warnings = _strings(report.get("degradations"), REVIEW_CHECKS)
    if warnings:
        logger.warning(
            "literature_retrieval_diagnostics run_id=%s diagnostics=%s",
            run_id,
            json.dumps(warnings, ensure_ascii=False),
        )
    card = SearchResult(
        run_id=run_id,
        round=1,
        criteria=[_text(query.get("query"))],
        status="success" if papers else "no_confident_match",
        sources=[
            SearchSource(name=name, status="success", candidates=count)
            for name, count in source_counts.items()
        ],
        candidates=len(papers),
        deduplicated=_count(report.get("input_count")),
        retained=len(corpus),
        papers=papers[:SEARCH_CARD_PAPERS],
        warnings=warnings,
        origin=LITERATURE_REVIEW_ORIGIN,
    )
    included = tuple(
        authorization_source(paper) for paper in papers if paper.decision == "included"
    )
    corpus_path = scoped_workspace_path(workspace, CORPUS)
    return PreparedReviewSearch(card, tuple(files), included, hashes[corpus_path])


def project_review_search_artifacts(values: dict[str, bytes]) -> list[SearchPaper]:
    """Rebuild the full SLR candidate list from immutable session artifacts."""
    parsed = {name: json.loads(raw) for name, raw in values.items()}
    return _slr_papers(
        parsed[METADATA], parsed[CORPUS], parsed[RETRIEVAL], parsed.get(FULLTEXT, {}), complete=True
    )
