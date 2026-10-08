#!/usr/bin/env scholarseed-skill-python
"""Resolve an immutable round's strategy and prepare only its required files."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(SKILL_DIR / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from io_utils import atomic_write_json, read_json, utc_now
from filesystem import canonical_path, filesystem_path, path_exists
from validate_json import validate_data
from state import initialize
import prepare_fast_mock
from balance_policy import new_policy
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

DEFAULT_PROFILE = "balance"
MODES = {
    "fast_mock": ("SEARCH_AGENT.md", "search-plan-current", 1),
    "full": ("FULL_AGENT.md", "search-plan-current-full", 8),
    "balance": ("BALANCE_AGENT.md", "search-plan-current-balance", 1),
}



def prepare(request_path: Path, work_dir: Path) -> dict:
    if filesystem_path(request_path).is_symlink() or filesystem_path(work_dir).is_symlink():
        raise ValueError("request and work paths must not be symbolic links")
    request_path, work_dir = canonical_path(request_path), canonical_path(work_dir)
    if work_dir != canonical_path((request_path.parent / "work")):
        raise ValueError("work directory must be the request file's sibling work directory")
    request = read_json(request_path)
    validate_data("search-request", request)
    if request["intent"].get("confirmed") is not True:
        raise ValueError("search requires confirmed intent")
    plan_path, dispatch_path = work_dir / "plan.json", work_dir / "dispatch.json"
    plan = read_json(plan_path) if path_exists(plan_path) else None
    saved = read_json(dispatch_path) if path_exists(dispatch_path) else None
    mode = request["search_profile"]
    if mode not in MODES:
        raise ValueError("search supports fast_mock, full, or balance")
    prompt, contract, iterations = MODES[mode]
    if plan is not None:
        validate_data(contract, plan)
        if (plan["run_id"] != request["run_id"] or plan["outer_round"] != request["round"]
                or plan["precise_intent"] != request["intent"]["precise_intent"]
                or plan["max_results"] != request["max_results"]
                or plan["exclude_ids"] != request["exclude_previous_ids"]):
            raise ValueError("saved plan does not match request")
    dispatch = {
        "run_id": request["run_id"], "outer_round": request["round"], "profile": mode,
        "prompt": f"modules/search/{prompt}", "plan_contract": contract,
        "created_at": utc_now(),
    }
    if saved is not None:
        for field in ("run_id", "outer_round", "profile", "prompt", "plan_contract"):
            if saved.get(field) != dispatch[field]:
                raise ValueError(f"saved dispatch mismatch: {field}")
        dispatch = saved
    if mode == "balance":
        policy = new_policy(request.get("time_budget_seconds"))
        if saved is not None and saved.get("policy") != policy:
            raise ValueError("saved balance policy differs from request")
        dispatch["policy"] = policy
    # No model-authored plan is generated here for balance/full. Their executor
    # reads only the selected prompt and writes the real entity/query plan.
    filesystem_path(work_dir).mkdir(parents=True, exist_ok=True)
    filesystem_path((work_dir / "results")).mkdir(exist_ok=True)
    if mode == "fast_mock":
        prepare_fast_mock.prepare(request_path, work_dir, profile="fast_mock")
    state_exists = path_exists((work_dir / "state.json"))
    state = initialize(work_dir)
    if not state_exists:
        state["max_iterations"] = iterations
        atomic_write_json(work_dir / "state.json", state)
    validate_data("search-state", state)
    if saved is None:
        atomic_write_json(dispatch_path, dispatch)
    return {**dispatch, "status": "ready" if path_exists(plan_path) else "planning_required",
            "work_dir": str(work_dir)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = prepare(args.request, args.work_dir)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(f"search dispatch failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
