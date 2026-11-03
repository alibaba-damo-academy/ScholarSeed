#!/usr/bin/env scholarseed-skill-python
"""Finalize file-backed agentic search artifacts into metadata and a search report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

SKILL_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

from io_utils import atomic_write_json, atomic_write_text, read_json, utc_now  # noqa: E402
from filesystem import canonical_path, path_exists
from validate_json import validate_data  # noqa: E402
from normalize import normalize_paper  # noqa: E402
from intent_constraints import assess_intent
import selection_evidence
from paper_select import select_papers  # noqa: E402


SOURCE_LABELS = {
    "paperhub": "PaperHub",
    "agent_web": "Search agent web",
}

TIER_LABELS = {
    1: "Core matches / 核心相关",
    2: "Broader matches / 拓展相关",
    3: "Supporting references / 补充参考",
}

DEGRADED_SOURCE_STATUSES = {
    "partial", "failed", "unavailable", "execution_blocked", "transport_error",
    "authentication_error",
}


def _canonical_source(value: Any) -> str:
    normalized = str(value or "").strip().casefold().replace("-", "_").replace(" ", "_")
    if normalized in {
        "agent_web", "agentweb", "search_agent_web", "host_web", "hostweb",
        "web", "web_search",
    }:
        return "agent_web"
    if "paperhub" in normalized:
        return "paperhub"
    return normalized


def _safe_endpoint(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = urlsplit(value.strip())
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    netloc = f"{host}:{port}" if port else host
    return urlunsplit((parsed.scheme, netloc, parsed.path, "", ""))


def _source_details(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    details: dict[str, dict[str, Any]] = {}
    raw_details = state.get("source_details", {})
    if isinstance(raw_details, dict):
        for source, raw in raw_details.items():
            key = _canonical_source(source)
            if not key or not isinstance(raw, dict):
                continue
            details[key] = {
                "status": str(raw.get("status") or "success"),
                "queries": int(raw.get("queries") or 0),
                "candidates": int(raw.get("candidates") or 0),
                "endpoint": _safe_endpoint(raw.get("endpoint")),
                "errors": [
                    str(item) for item in raw.get("errors", [])
                    if str(item).strip()
                ] if isinstance(raw.get("errors", []), list) else [],
            }
    counts = state.get("source_counts", {})
    if isinstance(counts, dict):
        for source, count in counts.items():
            key = _canonical_source(source)
            if not key:
                continue
            try:
                candidate_count = max(0, int(count))
            except (TypeError, ValueError):
                continue
            detail = details.setdefault(key, {
                "status": "success", "queries": 0, "candidates": 0,
                "endpoint": None, "errors": [],
            })
            detail["candidates"] = max(detail["candidates"], candidate_count)
    return details


def _source_report_lines(state: dict[str, Any]) -> list[str]:
    details = _source_details(state)
    lines = ["## Search Sources", ""]
    for key, label in SOURCE_LABELS.items():
        detail = details.get(key)
        if detail is None:
            lines.append(f"- {label}: not attempted")
            continue
        count = detail["candidates"]
        queries = detail["queries"]
        candidate_word = "candidate" if count == 1 else "candidates"
        query_suffix = ""
        if queries:
            query_word = "query" if queries == 1 else "queries"
            query_suffix = f" from {queries} {query_word}"
        lines.append(
            f"- {label}: {detail['status']}, {count} {candidate_word}{query_suffix}"
        )
        if detail.get("endpoint"):
            lines.append(f"  - Endpoint: `{detail['endpoint']}`")
        for error in detail.get("errors", []):
            lines.append(f"  - Error: {error}")
    if "unresolved_errors" in state and state.get("errors"):
        lines.append("- Historical errors (including recovered attempts) remain in work/state.json and work/query-log.json; source errors above are unresolved attempts.")
    explicit_fallback = state.get("fallback_used")
    fallback_used = bool(explicit_fallback) if isinstance(explicit_fallback, bool) else any(
        key in details and (
            details[key].get("queries", 0) > 0
            or details[key].get("candidates", 0) > 0
            or details[key].get("status") in {"success", "partial", "failed", "unavailable"}
        )
        for key in ("agent_web",)
    )
    lines.extend([f"- Fallback used: {'yes' if fallback_used else 'no'}", ""])
    return lines


def _paper_by_id(pool: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw_papers = pool.get("papers", []) if isinstance(pool, dict) else []
    result: dict[str, dict[str, Any]] = {}
    for raw in raw_papers:
        if not isinstance(raw, dict):
            continue
        paper = normalize_paper(raw)
        if paper is not None:
            result.setdefault(paper["id"], paper)
    return result


def determine_result_status(
    state: dict[str, Any],
    *,
    valid_candidates: int,
    invalid_candidates: int,
) -> str:
    """Classify one completed search round without conflating failure with no match."""
    details = _source_details(state)
    source_statuses = {detail["status"] for detail in details.values()}
    errors = state.get("unresolved_errors", state.get("errors", []))
    has_errors = isinstance(errors, list) and bool(errors)

    if valid_candidates:
        if invalid_candidates or has_errors or source_statuses & DEGRADED_SOURCE_STATUSES:
            return "partial"
        return "success"
    if invalid_candidates:
        return "invalid_result"
    if "execution_blocked" in source_statuses:
        return "execution_blocked"
    if has_errors or source_statuses & (DEGRADED_SOURCE_STATUSES - {"execution_blocked"}):
        return "source_failed"
    return "no_confident_match"


def _invalid_candidate_count(pool: dict[str, Any]) -> int:
    raw_papers = pool.get("papers", []) if isinstance(pool, dict) else []
    return sum(
        1
        for raw in raw_papers
        if not isinstance(raw, dict) or normalize_paper(raw) is None
    )


def _result_summary(papers: list[dict[str, Any]], coverage: str) -> str:
    if not papers:
        return "No eligible candidate papers were found; consult the search report for source errors and coverage gaps."
    groups = "; ".join(
        f"{label}: {sum(1 for paper in papers if paper.get('tier') == tier)}"
        for tier, label in TIER_LABELS.items()
    )
    return f"Selected {len(papers)} candidate papers: {groups}. Full texts not read / 未读取原文. {coverage}".strip()


def render_report(
    request: dict[str, Any],
    plan: dict[str, Any],
    state: dict[str, Any],
    metadata: dict[str, Any],
    coverage_assessment: str,
) -> str:
    intent = request.get("intent", {})
    precise_intent = intent.get("precise_intent", "") if isinstance(intent, dict) else ""
    lines = [
        "# Search Report",
        "",
        "> Search candidates selected by agent assessment. Selection does not confirm every requirement; full-text verification belongs to the reading stage.",
        "",
        "## Search Summary",
        "",
        f"- Run ID: `{request.get('run_id', '')}`",
        f"- Outer search round: {request.get('round', '')}",
        f"- Request: {precise_intent}",
        f"- Internal iterations: {state.get('iteration', 0)}",
        f"- Queries executed: {len(state.get('searched_queries', []))}",
        f"- Candidate pool: {state.get('pool_size', 0)}",
        f"- Selected candidates: {len(metadata.get('papers', []))}",
        f"- Result: {metadata.get('result_summary', '')}",
        f"- Stop reason: {state.get('stop_reason') or 'not recorded'}",
        "",
    ]
    lines.extend(_source_report_lines(state))
    lines.extend([
        "## Coverage Assessment",
        "",
        coverage_assessment or "Coverage was not assessed.",
        "",
    ])
    coverage = state.get("subtopic_coverage", {})
    if isinstance(coverage, dict) and coverage:
        for subtopic in plan.get("subtopics", []):
            marker = "covered" if coverage.get(subtopic) else "partial or missing"
            lines.append(f"- {subtopic}: {marker}")
        lines.append("")
    papers = metadata.get("papers", [])
    paper_number = 0
    for tier, label in TIER_LABELS.items():
        tier_papers = [paper for paper in papers if paper.get("tier") == tier]
        lines.extend([f"## {label} ({len(tier_papers)})", ""])
        if not tier_papers:
            lines.extend(["No papers selected for this group.", ""])
            continue
        for paper in tier_papers:
            paper_number += 1
            reasons = paper.get("relevance", {}).get("reasons", [])
            lines.extend([
                f"### {paper_number}. {paper.get('title', 'Untitled')}",
                "",
                f"- Paper ID: `{paper.get('id', '')}`",
                f"- Year / venue: {paper.get('year') or 'unknown'} / {paper.get('venue') or 'unknown'}",
                f"- DOI: {paper.get('doi') or 'unknown'}",
                f"- Open access: {paper.get('open_access', 'unknown')}",
                f"- Source: {paper.get('source', 'unknown')}",
                f"- Selection reason: {reasons[0] if reasons else 'not recorded'}",
                "- Verification status: candidate — pending full-text verification",
                f"- Abstract summary: {paper.get('abstract_summary', 'No abstract summary available.')}",
                "",
            ])
    related = metadata.get("related_recommendations", [])
    if related:
        lines.extend(["## Closest Related Papers — Not Confirmed Matches", "",
                      "These metadata recommendations do not satisfy all confirmed requirements. "
                      "They are not in-scope matches or authorized downloads; confirm a revised scope before selecting them. "
                      "Connections are agent assessments; source quotes are checked for provenance, not semantic entailment.", ""])
        for index, item in enumerate(related, start=1):
            paper = item["paper"]
            lines.extend([f"### {index}. {paper['title']}", "",
                          f"- Paper ID: `{paper['id']}`",
                          f"- Year / source: {paper.get('year') or 'unknown'} / {paper['source']}"])
            for connection in item["confirmed_connections"]:
                lines.append(f"- Source-supported connection (agent assessment): {connection['statement']}")
                lines.extend(f"  - {entry['field']}: {entry['quote']}" for entry in connection["evidence"])
            lines.extend(f"- {gap['status'].capitalize()} requirement ({gap['criterion_key']}): {gap['reason']}"
                         for gap in item["unmet_criteria"])
            lines.append("")
    lines.extend(["## Warnings and Limitations", ""])
    warnings = metadata.get("warnings", [])
    if warnings:
        lines.extend(f"- {warning}" for warning in warnings)
    else:
        lines.append("- No search warnings were recorded.")
    lines.extend([
        "- Relevance and coverage judgments are search-stage assessments, not conclusions from full papers.",
        "",
    ])
    return "\n".join(lines)


def finalize_search(
    request: dict[str, Any],
    plan: dict[str, Any] | None,
    state: dict[str, Any],
    pool: dict[str, Any],
    selection: dict[str, Any],
    *,
    metadata_path: Path,
    report_path: Path,
) -> dict[str, Any]:
    run_id = request.get("run_id")
    round_number = request.get("round")
    max_results = request.get("max_results")
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("search request needs a non-empty run_id")
    if not isinstance(round_number, int) or isinstance(round_number, bool) or round_number < 1:
        raise ValueError("search request round must be an integer >= 1")
    if not isinstance(max_results, int) or isinstance(max_results, bool) or max_results < 1:
        raise ValueError("search request max_results must be an integer >= 1")
    validate_data("search-request", request)
    no_plan = plan is None
    if no_plan:
        if not (request.get("search_profile") == "balance"
                and state.get("planning_outcome") == "budget_exhausted_before_plan"
                and state.get("stop_reason") and not selection.get("selected")
                and not state.get("source_details", {}).get("paperhub", {}).get("queries")):
            raise ValueError("missing plan is allowed only for an explicit empty pre-plan budget stop")
        # No invented retrieval plan. This identity shell is used only by the
        # common report renderer; no plan artifact is written or executable.
        plan = {"run_id": run_id, "outer_round": round_number, "max_results": max_results,
                "exclude_ids": request["exclude_previous_ids"],
                "precise_intent": request["intent"]["precise_intent"], "subtopics": []}
    else:
        validate_data("search-plan", plan)
    validate_data("search-state", state)
    validate_data("search-pool", pool)
    validate_data("search-selection", selection)
    if plan.get("run_id") != run_id or plan.get("outer_round") != round_number:
        raise ValueError("search plan identity does not match request run_id and round")
    if plan.get("max_results") != max_results:
        raise ValueError("search plan max_results does not match request")
    if {str(value) for value in plan.get("exclude_ids", [])} != {
        str(value) for value in request.get("exclude_previous_ids", [])
    }:
        raise ValueError("search plan exclude_ids do not match request")
    intent = request.get("intent", {})
    request_intent = intent.get("precise_intent") if isinstance(intent, dict) else None
    if plan.get("precise_intent") != request_intent:
        raise ValueError("search plan precise_intent does not match request")
    excluded = {str(value) for value in request.get("exclude_previous_ids", [])}
    by_id = _paper_by_id(pool)
    related = selection_evidence.related_recommendations(request, by_id, selection)
    invalid_candidates = _invalid_candidate_count(pool)
    selection_items = selection.get("selected", []) if isinstance(selection, dict) else []


    warnings = [str(item) for item in selection.get("warnings", []) if str(item).strip()]
    papers: list[dict[str, Any]] = []
    seen: set[str] = set()
    for selected in selection_items:
        if len(papers) >= max_results or not isinstance(selected, dict):
            break
        paper_id = str(selected.get("id", ""))
        if not paper_id or paper_id in excluded or paper_id in seen:
            continue
        paper = by_id.get(paper_id)
        if paper is None:
            warnings.append(f"Selected paper {paper_id!r} was not present in the normalized pool.")
            invalid_candidates += 1
            continue
        paper = dict(paper)
        if "intent_review" in selected:
            paper["intent_review"] = selected["intent_review"]
        intent_status, intent_reasons = selection_evidence.assess(paper, request)
        if intent_status != "eligible":
            warnings.append(f"{paper_id}: {' '.join(intent_reasons)}")
            if intent_status == "pending":
                invalid_candidates += 1
            continue
        paper["intent_review"] = {**paper["intent_review"], "verification_status": "candidate"}
        if paper.get("year") is None and paper["intent_review"].get("year") is not None:
            paper["year"] = paper["intent_review"]["year"]
        tier = selected.get("tier")
        paper["tier"] = tier if tier in {1, 2, 3} else 3
        paper["subtopics_covered"] = list(selected.get("subtopics_covered") or [])
        reason = selected.get("selection_reason")
        score = selected.get("relevance_score")
        relevance = dict(paper.get("relevance") or {})
        if isinstance(score, (int, float)) and not isinstance(score, bool):
            relevance["score"] = score
        if isinstance(reason, str) and reason.strip():
            relevance["reasons"] = [reason.strip()]
            paper["selection_reason"] = reason.strip()
        paper["relevance"] = relevance
        papers.append(paper)
        seen.add(paper_id)

    errors = state.get("unresolved_errors", state.get("errors", []))
    if isinstance(errors, list):
        warnings.extend(str(error) for error in errors if str(error).strip())
    coverage = str(selection.get("coverage_assessment") or "Coverage was not assessed.")
    precise = intent.get("precise_intent", "") if isinstance(intent, dict) else ""
    feedback = request.get("user_feedback")
    query_summary = f"Agentic literature search for {precise!r}"
    if isinstance(feedback, str) and feedback.strip():
        query_summary += f" refined by {feedback.strip()!r}"
    metadata = {
        "schema_version": "1.0",
        "run_id": run_id,
        "round": round_number,
        "query_summary": query_summary,
        "status": determine_result_status(
            state,
            valid_candidates=len(papers),
            invalid_candidates=invalid_candidates,
        ),
        "result_summary": _result_summary(papers, coverage),
        "generated_at": utc_now(),
        "is_placeholder": False,
        "papers": papers,
        "related_recommendations": related,
        "warnings": list(dict.fromkeys(warnings)),
    }
    if related:
        metadata["result_summary"] += f" {len(related)} closest related paper(s) are listed separately with unmet or uncertain criteria; they are not confirmed matches."
    validate_data("metadata", metadata)
    report = render_report(request, plan, state, metadata, coverage)
    atomic_write_json(metadata_path, metadata)
    atomic_write_text(report_path, report)
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="search request.json")
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="metadata.json")
    parser.add_argument("--report-output", type=Path)
    parser.add_argument("--run-dir", type=Path)
    args = parser.parse_args()
    report_path = args.report_output or args.output.with_name("search_report.md")
    try:
        if args.run_dir is not None:
            from stage_guard import require_worker
            require_worker(canonical_path(args.run_dir), "search")
        finalize_search(
            read_json(args.input),
            read_json(args.work_dir / "plan.json") if path_exists(args.work_dir / "plan.json") else None,
            read_json(args.work_dir / "state.json"),
            read_json(args.work_dir / "pool.json"),
            read_json(args.work_dir / "selection.json"),
            metadata_path=args.output,
            report_path=report_path,
        )
    except (OSError, ValueError) as exc:
        print(f"search finalization failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"metadata": str(args.output), "report": str(report_path)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
