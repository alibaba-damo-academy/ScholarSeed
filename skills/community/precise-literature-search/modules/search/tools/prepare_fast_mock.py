#!/usr/bin/env scholarseed-skill-python
"""Prepare a search plan before delegation; for the single-paper quick mode."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


SKILL_DIR = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(SKILL_DIR / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from io_utils import atomic_write_json, read_json, utc_now  # noqa: E402
from filesystem import canonical_path, filesystem_path, path_exists
from state import initialize  # noqa: E402
from validate_json import validate_data  # noqa: E402


DEFAULT_PROFILE = "fast_mock"
PROFILE_CONTRACTS = {"fast_mock": "search-plan-current"}
PROFILE_ITERATIONS = {"fast_mock": 1}


_TOKEN = re.compile(r"\d+(?:\.\d+)?|[^\W_]+(?:-[^\W_]+)*", re.UNICODE)
_QUOTED = re.compile(r"['\"]([^'\"]{1,80})['\"]")
_STOPWORDS = {
    "a", "an", "and", "approach", "authors", "before", "collected", "contains",
    "evaluation", "find", "following", "for", "from", "identify", "in", "initial",
    "into", "is", "its", "location", "matching", "name", "of", "on", "paper",
    "performed", "produced", "reports", "requested", "study", "tested", "that", "the",
    "their", "this", "title", "to", "using", "where", "whose", "with", "work",
}


def _query_source(request: dict[str, Any]) -> str:
    intent = request["intent"]
    parts: list[str] = []
    for field in ("include_criteria", "research_questions"):
        values = intent.get(field) or []
        parts.extend(str(value) for value in values)
    parts.append(str(intent["precise_intent"]))
    return " ".join(parts)


def _text_candidate_tokens(source: str) -> list[str]:
    candidates: list[str] = []
    for quoted in _QUOTED.findall(source):
        candidates.extend(_TOKEN.findall(quoted))
    candidates.extend(re.findall(r"\d+(?:\.\d+)?", source))
    candidates.extend(_TOKEN.findall(source))

    selected: list[str] = []
    seen: set[str] = set()
    for token in candidates:
        key = token.casefold()
        if key in seen or key in _STOPWORDS or len(token) == 1 and not token.isdigit():
            continue
        seen.add(key)
        selected.append(token)
    return selected


def _candidate_tokens(request: dict[str, Any]) -> list[str]:
    base = _text_candidate_tokens(_query_source(request))
    feedback = _text_candidate_tokens(str(request.get("user_feedback") or ""))
    # Reserve query space for the latest feedback and the confirmed topic,
    # including when the original intent contains many quoted/numeric clues.
    ordered = feedback[:5] + base[:3] + feedback[5:] + base[3:]
    unique: dict[str, str] = {}
    for token in ordered:
        unique.setdefault(token.casefold(), token)
    return list(unique.values())


def derive_keyword_queries(request: dict[str, Any], count: int = 1) -> list[str]:
    """Return distinct bounded queries without another model call."""
    tokens = _candidate_tokens(request)
    if not tokens:
        return ["scholarly literature"]
    primary = tokens[:8]
    queries = [" ".join(primary)]
    feedback_count = len(_text_candidate_tokens(str(request.get("user_feedback") or "")))
    anchors = tokens[:max(3, min(5, feedback_count))]
    if count > 1:
        secondary = anchors + [token for token in tokens if token not in primary]
        secondary = secondary[:8]
        if secondary == primary or not secondary:
            secondary = tokens[3:11] or list(reversed(primary))
        query = " ".join(secondary[:8])
        if query and query.casefold() != queries[0].casefold():
            queries.append(query)
    if count > 2:
        used = {token.casefold() for query in queries for token in query.split()}
        retry = anchors + [token for token in tokens if token.casefold() not in used]
        retry_query = " ".join(retry[:8])
        if retry_query and retry_query.casefold() not in {item.casefold() for item in queries}:
            queries.append(retry_query)
    return queries[:count]


def derive_keyword_query(request: dict[str, Any]) -> str:
    return derive_keyword_queries(request, 1)[0]


def build_plan(request: dict[str, Any], profile: str | None = None) -> dict[str, Any]:
    profile = profile or request.get("search_profile") or DEFAULT_PROFILE
    if profile not in PROFILE_CONTRACTS:
        raise ValueError("unknown search profile")
    keyword_queries = derive_keyword_queries(request, 1)
    keyword_query = keyword_queries[0]
    precise_intent = request["intent"]["precise_intent"]
    angle = "confirmed intent"
    web_query = f"{keyword_query} research paper"
    plan = {
        "schema_version": "2.0",
        "strategy_version": "search-skill-fast-mock-v1",
        "run_id": request["run_id"],
        "outer_round": request["round"],
        "precise_intent": precise_intent,
        "entity_analysis": (
            f"{profile} uses no speculative entity hypothesis; the confirmed intent "
            "is queried directly."
        ),
        "entity_hypotheses": [],
        # A derived keyword phrase is not evidence of a paper title. Actual
        # titles discovered by Web may use the existing reconciliation path.
        "concept_probes": [],
        "subtopics": [keyword_query],
        "candidate_angles": [angle],
        "search_angles": [angle],
        "landmark_queries": [],
        "planned_queries": [
            *[{
                "angle": angle,
                "source": "paperhub",
                "mode": "keyword",
                "query": query,
                "purpose": "single quick retrieval",
            } for query in keyword_queries],
            {
                "angle": angle,
                "source": "web",
                "mode": "web",
                "query": web_query,
                "purpose": "single quick retrieval",
            },
        ],
        "max_results": min(1, request["max_results"]),
        "exclude_ids": list(request["exclude_previous_ids"]),
        "created_at": utc_now(),
    }
    return plan


def _validate_existing_plan(
    plan: dict[str, Any], request: dict[str, Any], profile: str
) -> None:
    contract = PROFILE_CONTRACTS[profile]
    validate_data(contract, plan)
    if plan["run_id"] != request["run_id"] or plan["outer_round"] != request["round"]:
        raise ValueError("existing plan identity does not match request")
    limit = 1
    if plan["max_results"] != min(limit, request["max_results"]):
        raise ValueError("existing plan result budget does not match request")
    if plan["exclude_ids"] != request["exclude_previous_ids"]:
        raise ValueError("existing plan exclusions do not match request")


def prepare(request_path: Path, work_dir: Path, profile: str | None = None) -> dict[str, Any]:
    if filesystem_path(request_path).is_symlink() or filesystem_path(work_dir).is_symlink():
        raise ValueError("request and work paths must not be symbolic links")
    request_path = canonical_path(request_path)
    work_dir = canonical_path(work_dir)
    if work_dir != canonical_path((request_path.parent / "work")):
        raise ValueError("work directory must be the request file's sibling work directory")

    request = read_json(request_path)
    validate_data("search-request", request)
    plan_path = work_dir / "plan.json"
    plan_exists = path_exists(plan_path)
    existing_plan = read_json(plan_path) if plan_exists else None
    request_profile = request.get("search_profile")
    profile = profile or request_profile
    if profile != "fast_mock":
        raise ValueError("this preparer only supports fast_mock")
    if request.get("search_profile") and profile != request_profile:
        raise ValueError("requested search profile does not match preparation profile")
    if request["intent"].get("confirmed") is not True:
        raise ValueError("search preparation requires a confirmed intent")

    filesystem_path(work_dir).mkdir(parents=True, exist_ok=True)
    filesystem_path((work_dir / "results")).mkdir(parents=True, exist_ok=True)
    status = "ready"
    if plan_exists:
        plan = existing_plan
        _validate_existing_plan(plan, request, profile)
    else:
        plan = build_plan(request, profile)
        contract = PROFILE_CONTRACTS[profile]
        validate_data(contract, plan)
        atomic_write_json(plan_path, plan)
        status = "created"

    state = initialize(work_dir)
    max_iterations = PROFILE_ITERATIONS[profile]
    if state.get("iteration", 0) > max_iterations:
        raise ValueError(f"{profile} state already exceeds its iteration budget")
    state["max_iterations"] = max_iterations
    if not state.get("subtopic_coverage"):
        state["subtopic_coverage"] = {plan["subtopics"][0]: False}
    state["updated_at"] = utc_now()
    atomic_write_json(work_dir / "state.json", state)
    validate_data("search-state", state)
    validate_data("search-pool", read_json(work_dir / "pool.json"))

    return {
        "status": status,
        "profile": profile,
        "plan_path": str(plan_path),
        "keyword_query": plan["planned_queries"][0]["query"],
        "keyword_queries": [
            item["query"] for item in plan["planned_queries"]
            if item["mode"] == "keyword"
        ],
        "web_query": next(
            item["query"] for item in plan["planned_queries"]
            if item["mode"] == "web"
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--work-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        request = read_json(args.request)
        result = prepare(args.request, args.work_dir)
    except (ValueError, OSError) as exc:
        print(f"search preparation failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
