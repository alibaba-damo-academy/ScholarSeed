#!/usr/bin/env scholarseed-skill-python
"""Run the deterministic tail of a Veryfast academic search.

The agent supplies one high-information search plan.  This runner initializes
state, executes the single bounded PaperHub graph (including automatic citation
tracking), and writes the ranked paper-only response in one tool call.
"""

import argparse
import json
import os
import re
import sys
import time
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import quick_finalize  # noqa: E402
import search_round  # noqa: E402
import state as search_state  # noqa: E402


ARXIV_ID_PATTERN = re.compile(r"(?<!\d)\d{4}\.\d{4,5}(?:v\d+)?(?!\d)", re.I)
DOI_PATTERN = re.compile(r"10\.\d{4,9}/[-._;()/:a-z0-9]+", re.I)


def _has_direct_identifier(query):
    """Return whether a user query names one paper by arXiv ID or DOI."""
    text = str(query or "")
    return bool(ARXIV_ID_PATTERN.search(text) or DOI_PATTERN.search(text))


def _looks_like_direct_lookup(query):
    """Conservatively detect requests for one explicitly named paper."""
    text = str(query or "")
    if _has_direct_identifier(text):
        return True
    if re.search(r"这篇(?:论文|文章)", text):
        return True
    lowered = text.casefold()
    return bool(re.search(
        r"\b(?:find|locate|retrieve)\b.{2,200}\b(?:this|the)\s+(?:paper|article)\b",
        lowered,
    ))


def _target_from_plan(plan):
    target = plan.get("best_target") or {}
    if not isinstance(target, dict):
        raise ValueError("plan.best_target must be an object")
    return str(target.get("title") or "").strip(), bool(target.get("required"))


def _load_plan_target(path):
    with open(path, encoding="utf-8") as handle:
        plan = json.load(handle)
    if not isinstance(plan, dict):
        raise ValueError("plan must be a JSON object")
    best_title, required = _target_from_plan(plan)
    if best_title:
        planned_titles = [
            str(item.get("query") or "").strip().casefold()
            for item in plan.get("queries", [])
            if isinstance(item, dict) and item.get("mode") == "title"
        ]
        if best_title.casefold() not in planned_titles:
            raise ValueError(
                "plan.best_target.title must also be an exact title query"
            )
    return best_title, required


def main():
    parser = argparse.ArgumentParser(description="Run one Veryfast paper search")
    parser.add_argument("--query", required=True)
    parser.add_argument("--plan", help="JSON plan path (alternative to inline query flags)")
    parser.add_argument("--keyword", action="append", default=[])
    parser.add_argument("--title", action="append", default=[])
    parser.add_argument(
        "--best-title",
        help=(
            "agent-declared best paper title; automatically becomes the first "
            "exact title query and is promoted only when already in Tier 1"
        ),
    )
    parser.add_argument(
        "--require-best-target",
        action="store_true",
        help=(
            "fail instead of returning unrelated results when --best-title is "
            "absent from the candidate pool or does not enter Tier 1"
        ),
    )
    parser.add_argument("--year-end", type=int)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--concepts", required=True, help="comma-separated English concepts")
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--time-budget-minutes", type=float, default=1.0)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=45)
    # Compatibility-only no-op. Abstract persistence is prohibited.
    parser.add_argument(
        "--include-abstract", action="store_true", help=argparse.SUPPRESS,
    )
    args = parser.parse_args()

    if args.plan and (args.keyword or args.title):
        parser.error("use either --plan or inline --keyword/--title flags, not both")
    if not args.plan and not (args.keyword or args.title):
        parser.error("provide --plan or at least one --keyword/--title")

    best_title = str(args.best_title or "").strip()
    required_best_target = bool(args.require_best_target)
    if args.plan:
        try:
            plan_best_title, plan_requires_target = _load_plan_target(args.plan)
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
            parser.error("invalid plan target: %s" % exc)
        if best_title and plan_best_title and best_title.casefold() != plan_best_title.casefold():
            parser.error("--best-title conflicts with plan.best_target.title")
        if best_title and not plan_best_title:
            parser.error("--best-title with --plan requires plan.best_target.title")
        best_title = best_title or plan_best_title
        required_best_target = required_best_target or plan_requires_target

    if _looks_like_direct_lookup(args.query):
        required_best_target = True
    if required_best_target and not best_title:
        parser.error(
            "a direct paper lookup requires --best-title resolved from web-search"
        )

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
            title_queries = []
            if best_title:
                title_queries.append(best_title)
            title_queries.extend(
                value for value in args.title
                if value.strip().casefold() != best_title.casefold()
            )
            plan = {
                "phase": "quick",
                "finish_round": True,
                "best_target": {
                    "title": best_title,
                    "required": required_best_target,
                } if best_title else None,
                "queries": [
                    {"mode": "keyword", "query": value, "limit": 20, **query_options}
                    for value in args.keyword
                ] + [
                    {"mode": "title", "query": value, "limit": 5, **query_options}
                    for value in title_queries
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
            retain_papers_in_memory=True,
        )
        round_result, status = search_round.run_round(round_args)
        papers_in_memory = round_result.pop("_in_memory_papers", None)
        if status or round_result.get("error") or round_result.get("budget_stop"):
            raise ValueError("Veryfast retrieval failed: %s" % json.dumps(
                round_result, ensure_ascii=False,
            ))
        final_result = quick_finalize.finalize_quick(
            session_dir,
            args.output_dir,
            concepts_text=args.concepts,
            count=args.count,
            best_title=best_title,
            require_best_target=required_best_target,
            papers_override=papers_in_memory,
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
