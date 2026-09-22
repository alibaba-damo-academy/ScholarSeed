#!/usr/bin/env scholarseed-skill-python
"""Read and write the bounded state used by one Veryfast search.

Usage:
    scholarseed-skill-python state.py init --dir ./search_session
    scholarseed-skill-python state.py read --dir ./search_session
    scholarseed-skill-python state.py add-papers --dir ./search_session --input new_papers.json
    scholarseed-skill-python state.py add-query --dir ./search_session --query "search query text"
    scholarseed-skill-python state.py add-queries --dir ./search_session --input queries.json
    scholarseed-skill-python state.py record-round --dir ./search_session --input round.json
    scholarseed-skill-python state.py update-coverage --dir ./search_session --subtopic "method_A" --covered true
    scholarseed-skill-python state.py finish-round --dir ./search_session --new-papers 7
    scholarseed-skill-python state.py summary --dir ./search_session
    scholarseed-skill-python state.py budget --dir ./search_session
"""

import argparse
import copy
import json
import os
import re
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import search_policy  # noqa: E402
import privacy  # noqa: E402


DEFAULT_STATE = {
    "query": "",
    "subtopics": [],
    "subtopic_coverage": {},
    "pool": {},
    "searched_queries": [],
    "rounds_completed": 0,
    "dry_rounds": 0,
    "round_pending_new_papers": 0,
    "last_round_auto_citation_count": 0,
    "mode": "quick",
    "policy": None,
    "budget": None,
    "created_at": "",
    "updated_at": "",
}


def _title_key(title):
    return re.sub(r"[^a-z0-9]+", "", (title or "").lower())


def state_path(session_dir):
    return os.path.join(session_dir, "search_state.json")


def pool_path(session_dir):
    return os.path.join(session_dir, "pool.json")


def read_state(session_dir):
    sp = state_path(session_dir)
    if os.path.exists(sp):
        with open(sp) as f:
            return json.load(f)
    return None


def write_state(session_dir, state):
    state["updated_at"] = datetime.now().isoformat()
    _atomic_json_write(state_path(session_dir), state)


def read_pool(session_dir):
    pp = pool_path(session_dir)
    if os.path.exists(pp):
        with open(pp) as f:
            return json.load(f)
    return {}


def write_pool(session_dir, pool):
    _atomic_json_write(pool_path(session_dir), pool)


def _atomic_json_write(path, value):
    """Replace JSON atomically after removing non-persistable abstracts."""
    privacy.atomic_json_write(path, value)


def _budget_profile(total_seconds):
    """Compatibility wrapper for callers that predate explicit modes."""
    return search_policy.mode_for_budget(float(total_seconds) / 60.0)


def _default_selection_reserve(total_seconds):
    """Compatibility wrapper for budget-only session initialization."""
    mode = search_policy.mode_for_budget(float(total_seconds) / 60.0)
    return search_policy.default_selection_reserve(total_seconds, mode)


def budget_status(session_dir, now=None):
    """Return a stable deadline snapshot for a Veryfast session."""
    state = read_state(session_dir)
    if state is None:
        return {"error": "State not initialized"}
    policy = search_policy.from_state(state)
    mode = policy["mode"]
    budget = state.get("budget")
    if not isinstance(budget, dict) or not budget.get("enabled"):
        return {
            "enabled": False,
            "profile": mode,
            "mode": mode,
            "policy": policy,
            "should_finalize": False,
            "deadline_exceeded": False,
        }
    now_epoch = time.time() if now is None else float(now)
    started = float(budget["started_at_epoch"])
    deadline = float(budget["deadline_epoch"])
    reserve = float(budget["selection_reserve_seconds"])
    remaining = max(0.0, deadline - now_epoch)
    retrieval_headroom = max(0.0, remaining - reserve)
    return {
        "enabled": True,
        "profile": mode,
        "mode": mode,
        "policy": policy,
        "total_seconds": round(float(budget["total_seconds"]), 3),
        "elapsed_seconds": round(max(0.0, now_epoch - started), 3),
        "remaining_seconds": round(remaining, 3),
        "selection_reserve_seconds": round(reserve, 3),
        "retrieval_headroom_seconds": round(retrieval_headroom, 3),
        "should_finalize": remaining <= reserve,
        "deadline_exceeded": now_epoch >= deadline,
    }


def init_state(
    session_dir,
    query="",
    mode=None,
    time_budget_minutes=None,
    selection_reserve_seconds=None,
):
    state = copy.deepcopy(DEFAULT_STATE)
    state["query"] = query
    state["created_at"] = datetime.now().isoformat()
    policy = search_policy.resolve(
        mode=mode,
        time_budget_minutes=time_budget_minutes,
        selection_reserve_seconds=selection_reserve_seconds,
    )
    state["mode"] = policy["mode"]
    state["policy"] = policy
    if policy["time_budget_minutes"] is not None:
        total_seconds = float(policy["time_budget_minutes"]) * 60.0
        reserve = float(policy["selection_reserve_seconds"])
        started = time.time()
        state["budget"] = {
            "enabled": True,
            "profile": policy["mode"],
            "total_seconds": round(total_seconds, 3),
            "started_at_epoch": started,
            "deadline_epoch": started + total_seconds,
            "selection_reserve_seconds": round(reserve, 3),
        }
    write_state(session_dir, state)
    write_pool(session_dir, {})
    return state


def _merge_papers(pool, papers):
    added = 0
    for p in papers:
        if not isinstance(p, dict):
            continue
        key = _title_key(p.get("title", ""))
        if key and key not in pool:
            pool[key] = p
            added += 1
        elif key:
            existing = pool[key]
            # Prefer the richer record, but preserve provenance from both paths.
            if not existing.get("abstract") and p.get("abstract"):
                pool[key] = p
            sources = set(existing.get("found_by", [])) | set(p.get("found_by", []))
            if sources:
                pool[key]["found_by"] = sorted(sources)
    return added


def add_papers(session_dir, papers):
    pool = read_pool(session_dir)
    added = _merge_papers(pool, papers)
    write_pool(session_dir, pool)
    return {"added": added, "total_pool": len(pool)}


def add_query(session_dir, query):
    return add_queries(session_dir, [query])


def add_queries(session_dir, queries):
    state = read_state(session_dir)
    if state is None:
        return {"error": "State not initialized"}
    added = 0
    for query in queries:
        query = str(query).strip()
        if query and query not in state["searched_queries"]:
            state["searched_queries"].append(query)
            added += 1
    write_state(session_dir, state)
    return {"added": added, "total_queries": len(state["searched_queries"])}


def record_round(session_dir, payload):
    """Persist a search batch; optionally mark its logical round complete."""
    state = read_state(session_dir)
    if state is None:
        return {"error": "State not initialized"}
    pool = read_pool(session_dir)

    papers = payload.get("papers", [])
    queries = payload.get("queries", [])
    coverage = payload.get("coverage", {})
    if not isinstance(papers, list) or not isinstance(queries, list):
        return {"error": "record-round requires list fields: queries and papers"}
    if coverage is not None and not isinstance(coverage, dict):
        return {"error": "record-round coverage must be an object"}

    added_papers = _merge_papers(pool, papers)
    added_queries = 0
    for query in queries:
        query = str(query).strip()
        if query and query not in state["searched_queries"]:
            state["searched_queries"].append(query)
            added_queries += 1
    for subtopic, covered in (coverage or {}).items():
        state.setdefault("subtopic_coverage", {})[str(subtopic)] = bool(covered)
    supplied_subtopics = payload.get("subtopics")
    if isinstance(supplied_subtopics, list):
        state["subtopics"] = [str(item) for item in supplied_subtopics]

    target_round = state.get("rounds_completed", 0) + 1
    round_new_papers = state.get("round_pending_new_papers", 0) + added_papers
    finish = bool(payload.get("finish_round", True))
    if finish:
        state["rounds_completed"] = target_round
        valuable = payload.get("new_valuable_papers")
        is_dry = (valuable == 0) if valuable is not None else (round_new_papers == 0)
        state["dry_rounds"] = state.get("dry_rounds", 0) + 1 if is_dry else 0
        state["round_pending_new_papers"] = 0
        state["last_round_auto_citation_count"] = int(
            payload.get("auto_citation_count", 0) or 0
        )
    else:
        state["round_pending_new_papers"] = round_new_papers

    write_pool(session_dir, pool)
    write_state(session_dir, state)
    return {
        "round": target_round,
        "round_finished": finish,
        "added_papers": added_papers,
        "round_new_papers": round_new_papers,
        "pool_size": len(pool),
        "added_queries": added_queries,
        "total_queries": len(state["searched_queries"]),
        "dry_rounds": state["dry_rounds"],
    }


def finish_round(session_dir, new_papers):
    """Record a completed round and maintain the consecutive dry-round count."""
    state = read_state(session_dir)
    if state is None:
        return {"error": "State not initialized"}
    state["rounds_completed"] = state.get("rounds_completed", 0) + 1
    state["dry_rounds"] = state.get("dry_rounds", 0) + 1 if new_papers == 0 else 0
    state["last_round_auto_citation_count"] = 0
    write_state(session_dir, state)
    return {
        "rounds_completed": state["rounds_completed"],
        "dry_rounds": state["dry_rounds"],
        "new_papers": new_papers,
    }


def summary(session_dir):
    state = read_state(session_dir)
    pool = read_pool(session_dir)
    if state is None:
        return {"error": "State not initialized"}
    covered = sum(1 for v in state.get("subtopic_coverage", {}).values() if v)
    total_st = len(state.get("subtopics", []))
    return {
        "query": state.get("query", ""),
        "pool_size": len(pool),
        "queries_searched": len(state.get("searched_queries", [])),
        "rounds_completed": state.get("rounds_completed", 0),
        "subtopics": total_st,
        "subtopics_covered": covered,
        "coverage_ratio": round(covered / total_st, 2) if total_st > 0 else 0,
        "dry_rounds": state.get("dry_rounds", 0),
        "budget": budget_status(session_dir),
    }


def main():
    parser = argparse.ArgumentParser(description="Search state manager")
    parser.add_argument("action", choices=["init", "read", "add-papers", "add-query",
                                           "add-queries", "record-round", "update-coverage",
                                           "finish-round", "summary", "budget"])
    parser.add_argument("--dir", "-d", required=True, help="Session directory")
    parser.add_argument("--query", "-q", default="", help="Query text (for init/add-query)")
    parser.add_argument("--input", "-i", help="Input JSON file (for add-papers)")
    parser.add_argument("--subtopic", help="Subtopic name (for update-coverage)")
    parser.add_argument("--covered", choices=["true", "false"], help="Coverage status")
    parser.add_argument("--new-papers", type=int, help="New papers added in a completed round")
    parser.add_argument(
        "--time-budget-minutes", type=float,
        help="optional end-to-end budget recorded when initializing the session",
    )
    parser.add_argument(
        "--mode", choices=sorted(search_policy.POLICIES),
        help="internal execution policy; this branch supports only quick/Veryfast",
    )
    parser.add_argument(
        "--selection-reserve-seconds", type=float,
        help="seconds protected for selection/finalization in a budgeted session",
    )
    args = parser.parse_args()

    if args.action == "init":
        try:
            result = init_state(
                args.dir,
                args.query,
                mode=args.mode,
                time_budget_minutes=args.time_budget_minutes,
                selection_reserve_seconds=args.selection_reserve_seconds,
            )
        except ValueError as exc:
            parser.error(str(exc))
    elif args.action == "read":
        result = read_state(args.dir)
        if result is None:
            result = {"error": "No state found"}
    elif args.action == "add-papers":
        if args.input:
            with open(args.input) as f:
                data = json.load(f)
        else:
            data = json.load(sys.stdin)
        papers = data if isinstance(data, list) else data.get("papers", data.get("results", []))
        result = add_papers(args.dir, papers)
    elif args.action == "add-query":
        result = add_query(args.dir, args.query)
    elif args.action == "add-queries":
        if not args.input:
            parser.error("add-queries requires --input")
        with open(args.input) as f:
            data = json.load(f)
        queries = data if isinstance(data, list) else data.get("queries", [])
        result = add_queries(args.dir, queries)
    elif args.action == "record-round":
        if not args.input:
            parser.error("record-round requires --input")
        with open(args.input) as f:
            result = record_round(args.dir, json.load(f))
    elif args.action == "update-coverage":
        state = read_state(args.dir)
        if state and args.subtopic:
            state["subtopic_coverage"][args.subtopic] = (args.covered == "true")
            write_state(args.dir, state)
            result = {"updated": args.subtopic, "covered": args.covered == "true"}
        else:
            result = {"error": "State not found or subtopic missing"}
    elif args.action == "finish-round":
        if args.new_papers is None or args.new_papers < 0:
            parser.error("finish-round requires --new-papers with a non-negative integer")
        result = finish_round(args.dir, args.new_papers)
    elif args.action == "summary":
        result = summary(args.dir)
    elif args.action == "budget":
        result = budget_status(args.dir)

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
