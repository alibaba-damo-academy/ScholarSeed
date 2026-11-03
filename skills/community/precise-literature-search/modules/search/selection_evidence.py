#!/usr/bin/env scholarseed-skill-python
"""Source-bound eligibility reviews and reusable entity evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from io_utils import atomic_write_json, read_json, utc_now
from filesystem import canonical_path
from validate_json import validate_data
from intent_constraints import assess_intent, intent_key
from normalize import normalize_paper

EVIDENCE_FIELDS = ("title", "abstract", "year", "language", "publication_type", "publication_types")


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode("utf-8")).hexdigest()


def scope_key(request: dict) -> str:
    return _digest({"intent_key": intent_key(request["intent"]),
                    "user_feedback": request.get("user_feedback") or None})


def paper_evidence_key(paper: dict) -> str:
    normalized = normalize_paper(paper)
    if normalized is None:
        raise ValueError("evidence needs a titled paper")
    return _digest({key: normalized.get(key) for key in
                    ("id", "doi", "arxiv_id", "source", "document_type", *EVIDENCE_FIELDS)})


def required_criteria(request: dict) -> dict[str, Any]:
    intent = request["intent"]
    result = {"precise_intent": intent["precise_intent"]}
    for field in ("research_questions", "include_criteria", "exclude_criteria"):
        result.update({f"{field}:{index}": value for index, value in enumerate(intent.get(field) or [])})
    for field in ("paper_types", "language"):
        if intent.get(field):
            result[field] = intent[field]
    if any(value is not None for value in (intent.get("time_range") or {}).values()):
        result["time_range"] = intent["time_range"]
    if request.get("user_feedback"):
        result["user_feedback"] = request["user_feedback"]
    return result


def evidence_matches(paper: dict, evidence: Any) -> bool:
    if not isinstance(evidence, list) or not 1 <= len(evidence) <= 8:
        return False
    for item in evidence:
        if not isinstance(item, dict) or item.get("field") not in EVIDENCE_FIELDS:
            return False
        quote = item.get("quote")
        if not isinstance(quote, str) or not quote.strip() or len(quote) > 2000:
            return False
        value = paper.get(item["field"])
        text = json.dumps(value, ensure_ascii=False) if isinstance(value, list) else str(value) if value is not None else ""
        if quote not in text:
            return False
    return True


def assess(paper: dict, request: dict) -> tuple[str, list[str]]:
    validate_data("search-request", request)
    if request["intent"].get("confirmed") is not True:
        return "pending", ["Eligibility requires confirmed intent."]
    normalized = normalize_paper(paper)
    if normalized is None:
        return "excluded", ["Paper identity is missing."]
    if paper.get("is_placeholder") is True or normalized.get("document_type") != "paper":
        return "excluded", ["Only evidenced scholarly papers are eligible."]
    status, reasons = assess_intent(normalized, request["intent"])
    if status != "eligible":
        return status, reasons
    review = normalized["intent_review"]
    if (review.get("schema_version") != "1.1" or review.get("scope_key") != scope_key(request)
            or review.get("evidence_key") != paper_evidence_key(normalized)):
        return "pending", ["Review must match the current intent, feedback, and paper evidence."]
    # Candidate selection is an agent assessment, not proof of every clue.
    # Keep optional observations for the reader; do not require metadata quotes.
    checks = review.get("criteria", [])
    required = required_criteria(request)
    if (not isinstance(checks, list) or len(checks) > 64
            or any(not isinstance(item, dict) for item in checks)):
        return "pending", ["Review criteria must be an array of at most 64 observations."]
    by_key = {item.get("criterion_key"): item for item in checks if isinstance(item.get("criterion_key"), str)}
    if len(by_key) != len(checks) or not set(by_key).issubset(required):
        return "pending", ["Review criteria must name unique current requirements."]
    for key, check in by_key.items():
        if check.get("verdict") == "contradicts":
            return "excluded", [f"Evidence contradicts criterion {key}."]
        if (check.get("verdict") not in ("supports", "clear", "unknown")
                or not isinstance(check.get("reason"), str)
                or not check["reason"].strip() or len(check["reason"]) > 2000):
            return "pending", [f"Criterion {key} needs a verdict and a concise reason."]
        observations = check.get("evidence", [])
        if not isinstance(observations, list) or len(observations) > 8:
            return "pending", [f"Criterion {key} evidence must be an array of at most eight entries."]
        for entry in observations:
            if (not isinstance(entry, dict)
                    or any(not isinstance(entry.get(field), str) or not entry[field].strip()
                           for field in ("field", "quote"))
                    or len(entry["quote"]) > 2000
                    or any(field in entry and not isinstance(entry[field], str)
                           for field in ("source", "locator"))):
                return "pending", [f"Criterion {key} evidence needs field/quote text and optional source/locator text."]
    return "eligible", reasons


def review_context(request: dict, paper: dict) -> dict:
    return {"id": str(paper["id"]), "intent_key": intent_key(request["intent"]),
            "scope_key": scope_key(request), "evidence_key": paper_evidence_key(paper),
            "required_criteria": required_criteria(request)}


def related_recommendations(request: dict, papers: dict, selection: dict) -> list[dict]:
    """Ground near matches without promoting them to eligible candidates."""
    items = selection.get("related_recommendations", [])
    if not items:
        return []
    if selection.get("selected"):
        raise ValueError("related recommendations require an empty strict selection")
    if len(items) > min(3, request["max_results"]):
        raise ValueError("at most three related recommendations, within the requested limit")
    excluded = {str(value) for value in request["exclude_previous_ids"]}
    seen = set()
    result = []
    for item in items:
        key = item["id"]
        paper = papers.get(key)
        if (paper is None or key in excluded or key in seen
                or paper.get("is_placeholder") or paper.get("document_type") != "paper"):
            raise ValueError("recommendations must be unique current scholarly papers, not excluded")
        if (item["scope_key"] != scope_key(request)
                or item["evidence_key"] != paper_evidence_key(paper)
                or any(not evidence_matches(paper, connection["evidence"])
                       for connection in item["confirmed_connections"])):
            raise ValueError("recommendation evidence is stale or does not quote the current paper")
        if any(gap["criterion_key"] not in required_criteria(request) for gap in item["unmet_criteria"]):
            raise ValueError("recommendation gaps must name current requirement keys")
        # These records are deliberately separate from metadata.papers and tiers.
        clean_paper = {k: v for k, v in paper.items()
                       if k not in {"tier", "intent_review", "selection_reason", "subtopics_covered"}}
        result.append({**item, "paper": clean_paper})
        seen.add(key)
    return result


def _pool(work_dir: Path) -> dict[str, dict]:
    result = {}
    for raw in read_json(work_dir / "pool.json")["papers"]:
        if isinstance(raw, dict) and (paper := normalize_paper(raw)) is not None:
            result[paper["id"]] = paper
    return result


def _hypothesis_current(item: dict, request: dict, papers: dict[str, dict]) -> bool:
    if item.get("scope_key") != scope_key(request):
        return False
    evidence = item.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        return False
    return all(isinstance(entry, dict) and isinstance(entry.get("paper_id"), str) and entry.get("paper_id") in papers
               and entry.get("evidence_key") == paper_evidence_key(papers[entry["paper_id"]])
               and evidence_matches(papers[entry["paper_id"]], [entry]) for entry in evidence)


def save_hypotheses(work_dir: Path, request: dict, hypotheses: list[dict]) -> list[dict]:
    from tools.execution_policy import require_search_worker
    require_search_worker(work_dir)
    if request["intent"].get("confirmed") is not True:
        raise ValueError("verified hypotheses require confirmed intent")
    if not isinstance(hypotheses, list) or len(hypotheses) > 24:
        raise ValueError("at most 24 verified hypotheses may be recorded")
    papers = _pool(work_dir)
    current = read_json(work_dir / "state.json")
    verified = [item for item in current.get("verified_hypotheses", [])
                if isinstance(item, dict) and _hypothesis_current(item, request, papers)]
    for item in hypotheses:
        if (not isinstance(item, dict) or not isinstance(item.get("name"), str)
                or not item["name"].strip() or len(item["name"]) > 200
                or not isinstance(item.get("rationale"), str) or not item["rationale"].strip()
                or len(item["rationale"]) > 2000):
            raise ValueError("hypothesis needs a bounded name and evidence rationale")
        raw_evidence = item.get("evidence")
        if not isinstance(raw_evidence, list) or not 1 <= len(raw_evidence) <= 8:
            raise ValueError("hypothesis needs one to eight source evidence entries")
        evidence = []
        for entry in raw_evidence:
            paper = papers.get(str(entry.get("paper_id"))) if isinstance(entry, dict) else None
            if paper is None or paper.get("is_placeholder") is True or not evidence_matches(paper, [entry]):
                raise ValueError("hypothesis evidence must quote a current pool paper")
            evidence.append({"paper_id": paper["id"], "field": entry["field"],
                             "quote": entry["quote"], "evidence_key": paper_evidence_key(paper)})
        record = {"name": item["name"], "rationale": item["rationale"],
                  "scope_key": scope_key(request), "evidence": evidence,
                  "verified_at": utc_now(), "verification": "source_quote_checked; semantic_assessment_by_agent"}
        verified = [prior for prior in verified if prior["name"].casefold() != item["name"].casefold()]
        verified.append(record)
    if len(verified) > 24:
        raise ValueError("at most 24 current verified hypotheses may be retained")
    current["verified_hypotheses"] = verified
    current["updated_at"] = utc_now()
    atomic_write_json(work_dir / "state.json", current)
    return verified


def read_hypotheses(work_dir: Path, request: dict) -> list[dict]:
    papers = _pool(work_dir)
    return [item for item in read_json(work_dir / "state.json").get("verified_hypotheses", [])
            if isinstance(item, dict) and _hypothesis_current(item, request, papers)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("context", "save-hypotheses", "read-hypotheses"))
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--id", action="append", default=[])
    args = parser.parse_args()
    try:
        request_path, work = canonical_path(args.request), canonical_path(args.work_dir)
        if work != request_path.parent / "work":
            raise ValueError("work must be the request's sibling work directory")
        request = read_json(request_path)
        validate_data("search-request", request)
        if args.action == "context":
            if not 1 <= len(args.id) <= 20:
                raise ValueError("context requires one to twenty --id values")
            papers = _pool(work)
            output = {"intent_key": intent_key(request["intent"]), "scope_key": scope_key(request),
                      "required_criterion_keys": list(required_criteria(request)),
                      "papers": [{"id": paper_id, "evidence_key": paper_evidence_key(papers[paper_id])}
                                 for paper_id in args.id]}
        elif args.action == "save-hypotheses":
            if args.input is None:
                raise ValueError("save-hypotheses requires --input")
            source = canonical_path(args.input)
            source.relative_to(work)
            output = save_hypotheses(work, request, read_json(source))
        else:
            output = read_hypotheses(work, request)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(f"selection evidence failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
