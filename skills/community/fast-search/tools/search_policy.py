#!/usr/bin/env scholarseed-skill-python
"""Canonical execution policy for the Veryfast academic-search workflow.

The persisted internal mode remains ``quick`` for output-schema compatibility,
but this branch exposes only the Veryfast product behavior.
"""

import argparse
import copy
import json


MODE_ALIASES = {
    "quick": "quick",
    "fast": "quick",
    "veryfast": "quick",
}


POLICIES = {
    "quick": {
        "mode": "quick",
        "product_target": "interactive search bar",
        "default_time_budget_minutes": 1.0,
        "target_wall_minutes": "<1",
        "recommended_model": "gpt-5.6-luna",
        "recommended_reasoning_effort": "low",
        "recommended_service_tier": None,
        "max_logical_rounds": 1,
        "max_search_queries": 12,
        "max_keyword_queries": 4,
        "max_title_queries": 8,
        "native_web_batches": 1,
        "citation_strategy": "automatic",
        "citation_anchor_count": 2,
        "citation_limit": 20,
        "selection_strategy": "deterministic_provenance",
        "selected_count": 20,
        "tier_budget": [4, 9, 7],
        "output": "metadata_json_only",
    },
}


def canonical_mode(value):
    """Normalize a public mode name and reject silent fallbacks."""
    key = str(value or "").strip().lower().replace("_", "-")
    if key not in MODE_ALIASES:
        choices = ", ".join(sorted(POLICIES))
        raise ValueError("unsupported search mode %r; choose %s" % (value, choices))
    return MODE_ALIASES[key]


def mode_for_budget(time_budget_minutes):
    """Validate an optional budget and resolve the only supported policy."""
    if time_budget_minutes is not None and float(time_budget_minutes) <= 0:
        raise ValueError("time_budget_minutes must be positive")
    return "quick"


def default_selection_reserve(total_seconds, mode):
    """Protect deterministic/model selection from retrieval overruns."""
    canonical_mode(mode)
    return max(12.0, total_seconds * 0.25)


def resolve(mode=None, time_budget_minutes=None, selection_reserve_seconds=None):
    """Return a self-contained policy snapshot for a new search session."""
    resolved_mode = canonical_mode(mode) if mode else mode_for_budget(time_budget_minutes)
    policy = copy.deepcopy(POLICIES[resolved_mode])

    minutes = time_budget_minutes
    if minutes is None:
        minutes = policy["default_time_budget_minutes"]
    if minutes is not None:
        minutes = float(minutes)
        if minutes <= 0:
            raise ValueError("time_budget_minutes must be positive")
        total_seconds = minutes * 60.0
        reserve = (
            default_selection_reserve(total_seconds, resolved_mode)
            if selection_reserve_seconds is None
            else float(selection_reserve_seconds)
        )
        if reserve < 0 or reserve >= total_seconds:
            raise ValueError(
                "selection_reserve_seconds must be non-negative and below the total budget"
            )
        policy["time_budget_minutes"] = minutes
        policy["selection_reserve_seconds"] = round(reserve, 3)
    else:
        if selection_reserve_seconds is not None:
            raise ValueError("selection reserve requires a time budget")
        policy["time_budget_minutes"] = None
        policy["selection_reserve_seconds"] = None
    return policy


def from_state(state):
    """Read a policy snapshot, including sessions created by older versions."""
    if isinstance(state, dict) and isinstance(state.get("policy"), dict):
        return copy.deepcopy(state["policy"])
    mode = state.get("mode") if isinstance(state, dict) else None
    budget = state.get("budget") if isinstance(state, dict) else None
    minutes = None
    if isinstance(budget, dict) and budget.get("enabled"):
        minutes = float(budget.get("total_seconds", 0)) / 60.0
    return resolve(mode=mode, time_budget_minutes=minutes)


def main():
    parser = argparse.ArgumentParser(description="Inspect the Veryfast search policy")
    parser.add_argument("mode", nargs="?", choices=sorted(POLICIES))
    parser.add_argument("--time-budget-minutes", type=float)
    args = parser.parse_args()
    if args.mode:
        output = resolve(args.mode, args.time_budget_minutes)
    else:
        output = {name: resolve(name) for name in POLICIES}
    json.dump(output, __import__("sys").stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
