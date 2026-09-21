#!/usr/bin/env scholarseed-skill-python
"""Run upstream Balanced's two phases through the shared search contracts."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from io_utils import atomic_write_json, read_json
from validate_json import validate_data
from balance_policy import RetrievalBudgetExhausted, budget_status
import search_round
import state as state_tool


def run(args: argparse.Namespace) -> dict:
    work = args.work_dir.resolve()
    dispatch = read_json(work / "dispatch.json")
    if dispatch.get("profile") != "balance":
        raise ValueError("balance runner requires a saved balance dispatch")
    plan = read_json(work / "plan.json")
    validate_data("search-plan-current-balance", plan)
    request = read_json(work.parent / "request.json")
    validate_data("search-request", request)
    if (plan["run_id"] != request["run_id"] or plan["outer_round"] != request["round"]
            or plan["precise_intent"] != request["intent"]["precise_intent"]
            or plan["max_results"] != request["max_results"]
            or plan["exclude_ids"] != request["exclude_previous_ids"]):
        raise ValueError("balance plan does not match request")
    batch = read_json(args.batch)
    phase = batch.get("phase")
    if phase not in {"search", "citations"} or batch.get("iteration", 1) != 1:
        raise ValueError("balance uses one logical iteration with search and citation phases")
    queries = search_round._normalize_queries(batch)
    policy = dispatch["policy"]
    if phase == "search":
        counts = {mode: sum(q["mode"] == mode for q in queries) for mode in ("keyword", "title")}
        if (len(queries) > policy["max_search_queries"]
                or counts["keyword"] > policy["max_keyword_queries"]
                or counts["title"] > policy["max_title_queries"]):
            raise ValueError("balance search exceeds upstream query limits")
        expected = {(q["mode"], q["query"].strip().casefold()) for q in
                    [*plan["planned_queries"], *plan["concept_probes"], *plan["landmark_queries"]]
                    if q["mode"] in {"keyword", "title"}}
        if {(q["mode"], q["query"].strip().casefold()) for q in queries} != expected:
            raise ValueError("balance search batch must match the model-authored plan")
        if batch.get("finish_round") is not False:
            raise ValueError("balance search requires finish_round: false")
    else:
        ids = search_round._numeric_ids(batch.get("citation_ids", []), field="citation_ids", maximum=3)
        if queries or not 2 <= len(ids) <= policy["citation_anchor_count"]:
            raise ValueError("balance citation phase requires 2–3 model-selected anchors and no search queries")
        if batch.get("citation_limit", 30) != policy["citation_limit"]:
            raise ValueError("balance uses the upstream citation limit of 30")
        if batch.get("finish_round") is not True:
            raise ValueError("balance citations require finish_round: true")
    path = work / "balance-execution.json"
    execution = read_json(path) if path.exists() else {}
    if execution.get("completed"):
        raise ValueError("balance logical round is complete; finalize or explicitly start a new outer round")
    token = hashlib.sha256(json.dumps(batch, sort_keys=True).encode()).hexdigest()
    key = phase + "_batch_sha256"
    if key in execution and execution[key] != token:
        raise ValueError("cannot replace a saved balance phase; resume its exact batch")
    if phase == "citations" and not execution.get("search_finished"):
        raise ValueError("balance citations require the completed search phase")
    budget = budget_status(work)
    if budget["should_finalize"] or (phase == "citations" and budget["retrieval_headroom_seconds"] < 75):
        return {"budget": budget, "status": "ok", "budget_stop": True,
                "reason": "finalize current pool; insufficient retrieval headroom"}
    execution[key] = token
    atomic_write_json(path, execution)
    try:
        output = search_round.run_batch(args)
    except RetrievalBudgetExhausted as exc:
        output = {"status": "partial", "budget_stop": True, "reason": str(exc)}
    failures = [item for item in output.get("results", [])
                if item.get("status") != "success"]
    if any(item.get("status") == "execution_blocked" for item in failures):
        output["status"] = "execution_blocked"
    recoverable = output.get("status") in {"partial", "execution_blocked"} and not output.get("budget_stop")
    if recoverable:
        output["resumable"] = True
    if output.get("status") == "ok" or output.get("budget_stop"):
        if phase == "search":
            execution["search_finished"] = True
        else:
            execution["completed"] = True
            current = state_tool.initialize(work)
            current["iteration"] = 1
            atomic_write_json(work / "state.json", current)
        atomic_write_json(path, execution)
    # Keep budget first so it survives truncated tool output, as upstream does.
    return {"budget": budget_status(work), **output}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch", type=Path)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--budget", action="store_true")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--workers", type=int, choices=[1], default=1)
    args = parser.parse_args()
    try:
        if not args.budget and args.batch is None:
            raise ValueError("--batch is required unless --budget is selected")
        if not 1 <= args.timeout <= 600:
            raise ValueError("timeout must be between 1 and 600 seconds")
        output = budget_status(args.work_dir) if args.budget else run(args)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}))
        return 2
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if output.get("status", "ok") in {"ok", "partial"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
