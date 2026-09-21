#!/usr/bin/env scholarseed-skill-python
"""Run the complete deterministic tail of a Quick academic search.

The agent supplies one high-information search plan.  This runner initializes
state, executes the single bounded PaperHub graph (including automatic citation
tracking), and writes the ranked paper-only response in one tool call.
"""

import argparse
import json
import os
import sys
import time
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import quick_finalize  # noqa: E402
import search_round  # noqa: E402
import state as search_state  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="Run one Quick-mode paper search")
    parser.add_argument("--query", required=True)
    parser.add_argument("--plan", help="JSON plan path (alternative to inline query flags)")
    parser.add_argument("--keyword", action="append", default=[])
    parser.add_argument("--title", action="append", default=[])
    parser.add_argument("--year-end", type=int)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--concepts", required=True, help="comma-separated English concepts")
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--time-budget-minutes", type=float, default=1.0)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--include-abstract", action="store_true")
    args = parser.parse_args()

    if args.plan and (args.keyword or args.title):
        parser.error("use either --plan or inline --keyword/--title flags, not both")
    if not args.plan and not (args.keyword or args.title):
        parser.error("provide --plan or at least one --keyword/--title")

    # Do not make the agent spend a separate tool turn on credential probing.
    # Missing product credentials are a capability signal, not a request for
    # the user to supply a token. The caller can reuse its existing $web-search
    # results with web_fallback.py.
    if not os.environ.get("SCHOLARSEED_API_KEY", "").strip():
        json.dump({
            "mode": "quick",
            "status": "fallback_required",
            "fallback_required": True,
            "fallback_source": "web_search_skill",
            "paperhub_error_code": "PAPERHUB_AUTH_MISSING",
            "message": (
                "PaperHub credential unavailable; continue with the bundled "
                "Web-only fallback without asking the user for a token."
            ),
        }, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    session_dir = os.path.join(args.output_dir, "session")
    if os.path.exists(search_state.state_path(session_dir)):
        parser.error("output session already exists; choose a fresh output directory")
    started = time.monotonic()
    try:
        search_state.init_state(
            session_dir,
            args.query,
            mode="quick",
            time_budget_minutes=args.time_budget_minutes,
        )
        plan_path = args.plan
        if plan_path is None:
            plan_path = os.path.join(args.output_dir, "quick_plan.json")
            query_options = {}
            if args.year_end is not None:
                query_options["year_end"] = args.year_end
            plan = {
                "phase": "quick",
                "finish_round": True,
                "queries": [
                    {"mode": "keyword", "query": value, "limit": 20, **query_options}
                    for value in args.keyword
                ] + [
                    {"mode": "title", "query": value, "limit": 5, **query_options}
                    for value in args.title
                ],
                "inspect_concepts": [
                    value.strip() for value in args.concepts.split(",") if value.strip()
                ],
            }
            search_state._atomic_json_write(plan_path, plan)
        round_args = types.SimpleNamespace(
            plan=plan_path,
            session=session_dir,
            workers=args.workers,
            timeout=args.timeout,
            titles_per_query=0,
            inspect=False,
            inspect_limit=20,
            inspect_abstract_chars=0,
            inspect_diversity_weight=0.2,
        )
        round_result, status = search_round.run_round(round_args)
        if round_result.get("fallback_required"):
            json.dump(round_result, sys.stdout, ensure_ascii=False, indent=2)
            print()
            return 0
        if status or round_result.get("error") or round_result.get("budget_stop"):
            raise ValueError("Quick retrieval failed: %s" % json.dumps(
                round_result, ensure_ascii=False,
            ))
        final_result = quick_finalize.finalize_quick(
            session_dir,
            args.output_dir,
            concepts_text=args.concepts,
            count=args.count,
            include_abstract=args.include_abstract,
        )
    except ValueError as exc:
        parser.error(str(exc))
    output = {
        "mode": "quick",
        "wall_elapsed_seconds": round(time.monotonic() - started, 3),
        "retrieval": {
            key: round_result.get(key) for key in (
                "planned_queries", "executed_operations", "pool_size",
                "round_wall_elapsed", "failed_operations", "retry_attempts",
            )
        },
        "result": final_result,
    }
    json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
