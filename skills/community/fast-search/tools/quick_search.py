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
import shutil
import sys
import tempfile
import time
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import quick_finalize  # noqa: E402
import search_round  # noqa: E402
import search_policy  # noqa: E402
import publication_window  # noqa: E402
import query_syntax  # noqa: E402
import paper_identity  # noqa: E402
import external_metadata  # noqa: E402
import state as search_state  # noqa: E402


QUICK_MAX_KEYWORD_QUERIES = 4
QUICK_MAX_TITLE_QUERIES = 8


def _has_direct_identifier(query):
    """Recognize explicit identifiers, including those carried by paper URLs."""
    return any(paper_identity.identifiers(query).values())


def _looks_like_direct_lookup(query):
    """Conservatively detect requests for one explicitly named paper."""
    text = str(query or "")
    if _has_direct_identifier(text):
        return True
    if paper_identity.URL_PATTERN.fullmatch(text.strip()):
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
    if "required" in target and not isinstance(target["required"], bool):
        raise ValueError("plan.best_target.required must be a boolean")
    return str(target.get("title") or "").strip(), bool(target.get("required"))


def _load_plan_target(path):
    with open(path, encoding="utf-8") as handle:
        plan = json.load(handle)
    return _plan_target(plan)


def _plan_target(plan):
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


def _plan_text(plan, key):
    value = plan.get(key)
    return str(value or "").strip()


def _plan_concepts(plan):
    value = plan.get("inspect_concepts")
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return ",".join(
            str(item).strip() for item in value if str(item).strip()
        )
    return ""


def _bound_quick_plan(plan, best_title=""):
    """Keep the agent's highest-priority queries inside the Veryfast budget."""
    plan = dict(plan)
    normalized = search_round._normalize_queries(plan)
    keywords = [item for item in normalized if item["mode"] == "keyword"]
    titles = [item for item in normalized if item["mode"] == "title"]
    if best_title:
        key = best_title.casefold()
        titles.sort(key=lambda item: item["query"].casefold() != key)
    kept = (
        keywords[:QUICK_MAX_KEYWORD_QUERIES]
        + titles[:QUICK_MAX_TITLE_QUERIES]
    )
    plan["queries"] = [
        {key: value for key, value in item.items() if key != "key"}
        for item in kept
    ]
    return plan, {
        "received": len(normalized),
        "kept": len(kept),
        "dropped": len(normalized) - len(kept),
    }


def _remap_published_path(value, staging_dir, output_dir):
    if not isinstance(value, str):
        return value
    staging = os.path.abspath(staging_dir)
    absolute = os.path.abspath(value)
    if absolute == staging:
        return os.path.abspath(output_dir)
    prefix = staging + os.sep
    if absolute.startswith(prefix):
        return os.path.join(os.path.abspath(output_dir), absolute[len(prefix):])
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run one Veryfast paper search")
    parser.add_argument("--query")
    parser.add_argument("--plan", help="JSON plan path (alternative to inline query flags)")
    parser.add_argument(
        "--consume-plan", action="store_true",
        help="remove an external plan after copying it into a successful result",
    )
    parser.add_argument("--keyword", action="append", default=[])
    parser.add_argument("--title", action="append", default=[])
    parser.add_argument(
        "--best-title",
        help=(
            "agent-declared best paper title; automatically becomes the first "
            "exact title query; a required verified target is reserved first"
        ),
    )
    parser.add_argument(
        "--require-best-target",
        action="store_true",
        help=(
            "fail instead of returning unrelated results when --best-title is "
            "absent from the eligible candidate pool"
        ),
    )
    parser.add_argument("--year-end", type=int)
    parser.add_argument("--year-start", type=int)
    parser.add_argument("--date-start", help="inclusive publication date (YYYY-MM-DD)")
    parser.add_argument("--date-end", help="inclusive publication date (YYYY-MM-DD)")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--concepts", help="comma-separated English concepts")
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--time-budget-minutes", type=float, default=1.0)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=45)
    # Compatibility-only no-op. Abstract persistence is prohibited.
    parser.add_argument(
        "--include-abstract", action="store_true", help=argparse.SUPPRESS,
    )
    args = parser.parse_args(argv)

    if args.plan and (args.keyword or args.title):
        parser.error("use either --plan or inline --keyword/--title flags, not both")
    if args.consume_plan and not args.plan:
        parser.error("--consume-plan requires --plan")
    if not args.plan and not (args.keyword or args.title):
        parser.error("provide --plan or at least one --keyword/--title")

    source_plan = None
    if args.plan:
        try:
            with open(args.plan, encoding="utf-8") as handle:
                source_plan = json.load(handle)
            if not isinstance(source_plan, dict):
                raise ValueError("plan must be a JSON object")
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
            parser.error("invalid plan: %s" % exc)

    query = str(args.query or "").strip()
    if source_plan is not None:
        planned_query = _plan_text(source_plan, "query")
        if query and planned_query and query != planned_query:
            parser.error("--query conflicts with plan.query")
        query = query or planned_query
    if not query:
        parser.error("provide --query or plan.query")

    concepts = str(args.concepts or "").strip()
    if source_plan is not None:
        planned_concepts = _plan_concepts(source_plan)
        concepts = concepts or planned_concepts
    if not concepts:
        parser.error("provide --concepts or plan.inspect_concepts")

    best_title = str(args.best_title or "").strip()
    required_best_target = bool(args.require_best_target)
    if source_plan is not None:
        try:
            plan_best_title, plan_requires_target = _plan_target(source_plan)
        except (TypeError, ValueError) as exc:
            parser.error("invalid plan target: %s" % exc)
        if best_title and plan_best_title and best_title.casefold() != plan_best_title.casefold():
            parser.error("--best-title conflicts with plan.best_target.title")
        if best_title and not plan_best_title:
            parser.error("--best-title with --plan requires plan.best_target.title")
        best_title = best_title or plan_best_title
        required_best_target = required_best_target or plan_requires_target

    related_lookup = (
        source_plan is not None
        and isinstance(source_plan.get("best_target"), dict)
        and source_plan["best_target"].get("required") is False
    )
    if _looks_like_direct_lookup(query) and not related_lookup:
        required_best_target = True
    if required_best_target and not best_title and not (
        _has_direct_identifier(query) or len(paper_identity.urls(query)) == 1
    ):
        parser.error(
            "a direct paper lookup requires --best-title resolved from web-search"
        )

    if source_plan is None:
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
        source_plan = {
            "phase": "quick",
            "finish_round": True,
            "query": query,
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
                value.strip() for value in concepts.split(",") if value.strip()
            ],
        }
    else:
        source_plan = dict(source_plan)
        source_plan["query"] = query
        source_plan.setdefault(
            "inspect_concepts",
            [value.strip() for value in concepts.split(",") if value.strip()],
        )
    try:
        for field in ("date_start", "date_end", "year_start", "year_end"):
            value = getattr(args, field)
            if value is not None:
                if source_plan.get(field) is not None and str(source_plan[field]) != str(value):
                    raise ValueError("--%s conflicts with plan.%s" % (field.replace('_', '-'), field))
                source_plan[field] = value
        source_plan, syntax_repairs = query_syntax.normalize_plan(source_plan)
        source_plan, window = publication_window.apply_to_plan(source_plan)
        # Older experimental plans must not reinstate a lexical eligibility
        # gate. Topic relevance belongs to the existing ranker, not literal
        # presence of agent-inferred phrases in every candidate.
        ignored_fields = [field for field in ('required_term_groups', 'required_method')
                          if field in source_plan]
        for field in ignored_fields:
            source_plan.pop(field)
        plan, query_guard = _bound_quick_plan(source_plan, best_title)
        external_requests = external_metadata.requests_for_plan(
            plan, query, best_title, required_best_target,
        )
        if syntax_repairs:
            query_guard['boolean_queries_normalized'] = syntax_repairs
        if ignored_fields:
            query_guard['ignored_plan_fields'] = ignored_fields
        preview_queries = search_round._normalize_queries(plan)
        preview_state = {
            "mode": "quick",
            "rounds_completed": 0,
            "policy": search_policy.resolve(
                mode="quick",
                time_budget_minutes=args.time_budget_minutes,
            ),
        }
        search_round._apply_policy(plan, preview_queries, preview_state)
    except (TypeError, ValueError) as exc:
        parser.error("invalid quick plan: %s" % exc)

    output_dir = os.path.abspath(args.output_dir)
    if os.path.exists(output_dir):
        parser.error("output directory already exists; choose a fresh output directory")
    output_parent = os.path.dirname(output_dir)
    os.makedirs(output_parent, exist_ok=True)
    staging_dir = tempfile.mkdtemp(
        prefix=".%s.staging-" % os.path.basename(output_dir),
        dir=output_parent,
    )
    session_dir = os.path.join(staging_dir, "session")
    published = False
    started = time.monotonic()
    try:
        current = search_state.init_state(
            session_dir,
            query,
            mode="quick",
            time_budget_minutes=args.time_budget_minutes,
        )
        if window:
            current["publication_window"] = window
            search_state.write_state(session_dir, current)
        plan_path = os.path.join(staging_dir, "quick_plan.json")
        search_state._atomic_json_write(plan_path, plan)
        round_args = types.SimpleNamespace(
            plan=plan_path,
            session=session_dir,
            workers=args.workers,
            timeout=args.timeout,
            titles_per_query=0,
            retain_papers_in_memory=True,
        )
        verification = external_metadata.start(external_requests)
        round_result, status = search_round.run_round(round_args)
        papers_in_memory = round_result.pop("_in_memory_papers", None)
        verified, verification_audit = external_metadata.finish(verification)
        eligible_verified, _ = publication_window.filter_papers(verified, window)
        # Preserve a verified answer during service failure, not during a
        # malformed plan, state failure or other execution error.
        service_failure = bool(status and round_result.get("failed_operations")
                               and not round_result.get("error"))
        if (status and not (service_failure and eligible_verified)) or round_result.get("error") or round_result.get("budget_stop"):
            raise ValueError("Veryfast retrieval failed: %s" % json.dumps(
                round_result, ensure_ascii=False,
            ))
        if papers_in_memory is None:
            papers_in_memory = list(search_state.read_pool(session_dir).values())
        papers_in_memory, added = external_metadata.merge_missing(papers_in_memory, verified)
        final_result = quick_finalize.finalize_quick(
            session_dir,
            staging_dir,
            concepts_text=concepts,
            count=args.count,
            best_title=best_title,
            require_best_target=required_best_target,
            papers_override=papers_in_memory,
            external_audit={"checks": verification_audit, "added_count": added,
                            "paperhub_failed_operations": round_result.get("failed_operations", 0)},
        )
        os.replace(staging_dir, output_dir)
        published = True
        if args.consume_plan:
            try:
                os.unlink(args.plan)
            except OSError:
                pass
        final_result["output"] = _remap_published_path(
            final_result.get("output"), staging_dir, output_dir,
        )
        if round_result.get("raw_results_file"):
            round_result["raw_results_file"] = _remap_published_path(
                round_result["raw_results_file"], staging_dir, output_dir,
            )
    except (OSError, ValueError) as exc:
        if isinstance(exc, quick_finalize.DirectTargetNotFound):
            # Publish only a typed failure, never a partial abstract-bearing pool.
            failure_dir = tempfile.mkdtemp(prefix=".fast-search-failure-", dir=output_parent)
            try:
                search_state._atomic_json_write(os.path.join(failure_dir, "search_failure.json"), {
                    "schema": "fast_search.failure.v1",
                    "error": "fast_search_target_not_found",
                })
                os.replace(failure_dir, output_dir)
            finally:
                if os.path.isdir(failure_dir):
                    shutil.rmtree(failure_dir)
        parser.error(str(exc))
    finally:
        if not published:
            shutil.rmtree(staging_dir, ignore_errors=True)
    output = {
        "mode": "quick",
        "wall_elapsed_seconds": round(time.monotonic() - started, 3),
        "retrieval": {
            key: round_result.get(key) for key in (
                "planned_queries", "executed_operations", "pool_size",
                "round_wall_elapsed", "failed_operations", "retry_attempts",
            )
        } | {"query_guard": query_guard},
        "result": final_result,
    }
    json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
