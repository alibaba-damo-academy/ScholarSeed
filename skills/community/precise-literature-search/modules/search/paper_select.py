#!/usr/bin/env scholarseed-skill-python
"""Deterministically select a relevant and diverse bounded paper set."""

from __future__ import annotations

import argparse
import json
import math
import sys
import re
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from validate_json import validate_intent
from normalize import normalize_paper
from intent_constraints import assess_intent, intent_key
import selection_evidence


def _words(paper: dict[str, Any]) -> set[str]:
    text = f"{paper.get('title') or ''} {(paper.get('abstract') or '')[:500]}".casefold()
    return set(re.findall(r"[a-z]{3,}", text))


def _similarity(left: dict[str, Any], right: dict[str, Any]) -> float:
    left_words = _words(left)
    right_words = _words(right)
    if not left_words or not right_words:
        return 0.0
    return len(left_words & right_words) / min(len(left_words), len(right_words))


def _score(paper: dict[str, Any]) -> float:
    relevance = paper.get("relevance")
    value = relevance.get("score") if isinstance(relevance, dict) else None
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return 0.0


def _tier_counts(count: int) -> dict[str, int]:
    if count <= 0:
        return {"1": 0, "2": 0, "3": 0}
    tier_one = min(5, count)
    remaining = count - tier_one
    tier_two = min(20, remaining)
    return {"1": tier_one, "2": tier_two, "3": count - tier_one - tier_two}


def select_papers(
    papers: list[dict[str, Any]],
    *,
    max_results: int,
    intent: dict[str, Any],
    exclude_ids: set[str] | None = None,
    diversity_weight: float = 0.3,
    request: dict[str, Any],
) -> dict[str, Any]:
    if isinstance(max_results, bool) or not isinstance(max_results, int) or max_results < 1:
        raise ValueError("max_results must be an integer >= 1")
    validate_intent(intent)
    if request["intent"] != intent:
        raise ValueError("selection intent must match the execution request")
    if intent["max_results"] is not None and max_results > intent["max_results"]:
        raise ValueError("max_results cannot exceed the user intent limit")
    excluded = {str(value) for value in (exclude_ids or set())}
    normalized: dict[str, dict[str, Any]] = {}
    assessments = {}
    warnings = []
    for raw in papers:
        if not isinstance(raw, dict):
            continue
        paper = normalize_paper(raw)
        if paper is not None and paper["id"] not in excluded:
            status, reasons = selection_evidence.assess(paper, request)
            assessments[paper["id"]] = (status, reasons)
            if status != "eligible":
                warnings.append(f"{paper['id']}: {' '.join(reasons)}")
                continue
            normalized.setdefault(paper["id"], paper)

    remaining = sorted(normalized.values(), key=lambda paper: (-_score(paper), paper["id"]))
    chosen: list[dict[str, Any]] = []
    while remaining and len(chosen) < max_results:
        ranked: list[tuple[float, str, dict[str, Any]]] = []
        eligible_remaining = [paper for paper in remaining if assessments[paper["id"]][0] == "eligible"]
        for paper in eligible_remaining or remaining:
            redundancy = max((_similarity(paper, selected) for selected in chosen), default=0.0)
            adjusted = _score(paper) - diversity_weight * redundancy * 10
            ranked.append((-adjusted, paper["id"], paper))
        ranked.sort(key=lambda item: (item[0], item[1]))
        selected = ranked[0][2]
        chosen.append(selected)
        remaining = [paper for paper in remaining if paper["id"] != selected["id"]]

    counts = _tier_counts(len(chosen))
    boundaries = (counts["1"], counts["1"] + counts["2"])
    selected_items: list[dict[str, Any]] = []
    for index, paper in enumerate(chosen):
        tier = 1 if index < boundaries[0] else (2 if index < boundaries[1] else 3)
        if paper.get("tier") in {1, 2, 3}:
            tier = paper["tier"]
        status, reasons = assessments[paper["id"]]
        raw_score = paper.get("relevance", {}).get("score")
        scored = isinstance(raw_score, (int, float)) and not isinstance(raw_score, bool) and math.isfinite(raw_score)
        if status != "eligible" or not scored:
            tier = 3
            warnings.append(f"{paper['id']}: {' '.join(reasons) if status != 'eligible' else 'Relevance is unscored; citations are not a relevance score.'}")
        selected_items.append({
            "id": paper["id"],
            "tier": tier,
            "relevance_score": round(_score(paper), 4) if scored and status == "eligible" else None,
            "intent_status": status,
            "selection_reason": reasons[0],
            "subtopics_covered": list(paper.get("subtopics_covered") or []),
        })
    return {
        "schema_version": "1.0",
        "selected": selected_items,
        "tier_counts": {str(tier): sum(item["tier"] == tier for item in selected_items) for tier in (1, 2, 3)},
        "intent_key": intent_key(intent),
        "coverage_assessment": "Coverage must be assessed by the search agent.",
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--intent", required=True, type=Path)
    parser.add_argument("--pool", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--max-results", required=True, type=int)
    parser.add_argument("--exclude-id", action="append", default=[])
    parser.add_argument("--diversity-weight", type=float, default=0.3)
    parser.add_argument("--request", required=True, type=Path)
    args = parser.parse_args()
    data = json.loads(args.pool.read_text(encoding="utf-8"))
    papers = data.get("papers", []) if isinstance(data, dict) else data
    result = select_papers(
        papers,
        max_results=args.max_results,
        intent=json.loads(args.intent.read_text(encoding="utf-8-sig")),
        exclude_ids=set(args.exclude_id),
        diversity_weight=args.diversity_weight,
        request=json.loads(args.request.read_text(encoding="utf-8-sig")),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"selected": len(result["selected"]), "output": str(args.output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
