#!/usr/bin/env scholarseed-skill-python
"""Maintain recoverable file-backed state for one outer search round."""

from __future__ import annotations

import argparse
from collections import Counter
import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

SKILL_DIR = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

from io_utils import atomic_write_json, read_json, utc_now  # noqa: E402


QUERY_STATUSES = {
    "success", "partial", "failed", "unavailable",
    "execution_blocked", "transport_error", "authentication_error",
}


def canonical_source(value: str) -> str:
    normalized = value.strip().casefold().replace("-", "_").replace(" ", "_")
    if normalized in {
        "agent_web", "agentweb", "search_agent_web", "host_web", "hostweb",
        "web", "web_search",
    }:
        return "agent_web"
    if "paperhub" in normalized:
        return "paperhub"
    return normalized or "unknown"


def safe_endpoint(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = urlsplit(value.strip())
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    netloc = f"{host}:{port}" if port else host
    return urlunsplit((parsed.scheme, netloc, parsed.path, "", ""))


def state_path(work_dir: Path) -> Path:
    return work_dir / "state.json"


def initial_state() -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "iteration": 0,
        "max_iterations": 8,
        "searched_queries": [],
        "subtopic_coverage": {},
        "dry_iterations": 0,
        "pool_size": 0,
        "source_counts": {},
        "source_details": {},
        "errors": [],
        "stop_reason": None,
        "updated_at": utc_now(),
    }


def initialize(work_dir: Path) -> dict[str, Any]:
    work_dir.mkdir(parents=True, exist_ok=True)
    path = state_path(work_dir)
    if path.exists():
        return read_json(path)
    value = initial_state()
    atomic_write_json(path, value)
    if not (work_dir / "pool.json").exists():
        atomic_write_json(work_dir / "pool.json", {"schema_version": "1.0", "papers": []})
    if not (work_dir / "query-log.json").exists():
        atomic_write_json(work_dir / "query-log.json", {"schema_version": "1.0", "queries": []})
    return value


def update(work_dir: Path, action: str, **values: Any) -> dict[str, Any]:
    state = initialize(work_dir)
    if action == "set-subtopics":
        subtopics = values.get("subtopics") or []
        state["subtopic_coverage"] = {str(item): False for item in subtopics}
    elif action == "complete-iteration":
        state["iteration"] += 1
        added = int(values.get("added") or 0)
        raw_valuable = values.get("valuable_added")
        valuable_added = added if raw_valuable is None else int(raw_valuable)
        state["dry_iterations"] = (
            0 if valuable_added > 0 else state["dry_iterations"] + 1
        )
        state["pool_size"] = int(values.get("pool_size") or state["pool_size"])
    elif action == "add-query":
        query = str(values.get("query") or "").strip()
        if query and query not in state["searched_queries"]:
            state["searched_queries"].append(query)
    elif action == "set-coverage":
        subtopic = str(values.get("subtopic") or "").strip()
        if subtopic:
            state["subtopic_coverage"][subtopic] = bool(values.get("covered"))
    elif action == "add-error":
        message = str(values.get("message") or "").strip()
        if message:
            state["errors"].append(message)
            if "unresolved_errors" in state:
                state["unresolved_errors"].append(message)
    elif action == "stop":
        state["stop_reason"] = str(values.get("reason") or "").strip() or "not recorded"
    else:
        raise ValueError(f"unknown state action: {action}")
    state["updated_at"] = utc_now()
    atomic_write_json(state_path(work_dir), state)
    return state


def log_query(
    work_dir: Path,
    *,
    source: str,
    mode: str,
    query: str,
    result_path: str | None,
    returned_ids: list[str],
    new_ids: list[str],
    elapsed_seconds: float | None,
    error: str | None,
    endpoint: str | None = None,
    status: str | None = None,
    parameters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    state = initialize(work_dir)
    endpoint = safe_endpoint(endpoint)
    log_path = work_dir / "query-log.json"
    log = read_json(log_path)
    queries = log.get("queries", []) if isinstance(log, dict) else []
    queries.append({
        "iteration": state["iteration"] + 1,
        "source": source,
        "mode": mode,
        "query": query,
        "result_path": result_path,
        "returned_ids": returned_ids,
        "new_ids": new_ids,
        "elapsed_seconds": elapsed_seconds,
        "error": error,
        "endpoint": endpoint,
        "status": status,
        "parameters": parameters or {},
        "recorded_at": utc_now(),
    })
    atomic_write_json(log_path, {"schema_version": "1.0", "queries": queries})
    source_key = canonical_source(source)
    details = state.setdefault("source_details", {})
    detail = details.setdefault(source_key, {
        "status": "success",
        "queries": 0,
        "candidates": 0,
        "endpoint": None,
        "errors": [],
    })
    if endpoint:
        detail["endpoint"] = endpoint

    if status != "execution_blocked":
        if query and query not in state["searched_queries"]:
            state["searched_queries"].append(query)
        state["source_counts"][source_key] = state["source_counts"].get(source_key, 0) + len(returned_ids)
        detail["queries"] = int(detail.get("queries") or 0) + 1
        detail["candidates"] = int(detail.get("candidates") or 0) + len(returned_ids)
    if error:
        state["errors"].append(error)

    # Keep append-only errors/query-log for audit; derive current failures from
    # the latest attempt of each exact operation. A different query or filter
    # cannot recover this query. Legacy untracked errors remain unresolved.
    latest = {}
    for attempt in queries:
        key = json.dumps([canonical_source(attempt.get("source", "")),
                          attempt.get("mode"), attempt.get("query"),
                          attempt.get("parameters") or {}], sort_keys=True)
        latest[key] = attempt
    logged_errors = Counter(item.get("error") for item in queries if item.get("error"))
    untracked = []
    for message in state["errors"]:
        if logged_errors[message]:
            logged_errors[message] -= 1
        else:
            untracked.append(message)
    failed = [item for item in latest.values()
              if item.get("error") or item.get("status") not in {None, "success"}]
    state["unresolved_errors"] = untracked + [
        item.get("error") or f"{item.get('source')} {item.get('mode')} {item.get('query')}: {item.get('status')}"
        for item in failed
    ]
    for key, source_detail in details.items():
        attempts = [item for item in latest.values() if canonical_source(item.get("source", "")) == key]
        if not attempts:
            continue  # No query history: retain non-query source failures.
        failures = [item for item in failed if canonical_source(item.get("source", "")) == key]
        logged_source_errors = {
            item.get("error") or str(item.get("status")) for item in queries
            if canonical_source(item.get("source", "")) == key
            and (item.get("error") or item.get("status") not in {None, "success"})
        }
        unlogged_errors = [message for message in source_detail.get("errors", [])
                         if message not in logged_source_errors]
        source_detail["errors"] = unlogged_errors + [item.get("error") or str(item.get("status")) for item in failures]
        for message in unlogged_errors:
            if message not in state["unresolved_errors"]:
                state["unresolved_errors"].append(message)
        statuses = {item.get("status") for item in failures}
        if unlogged_errors:
            statuses.add(source_detail.get("status", "failed"))
        has_failures = bool(failures or unlogged_errors)
        source_detail["status"] = (
            "execution_blocked" if "execution_blocked" in statuses else
            "partial" if has_failures and source_detail.get("candidates") else
            next((value for value in ("authentication_error", "transport_error", "unavailable", "failed")
                  if value in statuses), "failed") if has_failures else "success"
        )
    state["updated_at"] = utc_now()
    atomic_write_json(state_path(work_dir), state)
    return {"queries": len(queries), "new": len(new_ids), "error": error,
            "status": status or ("failed" if error else "success")}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=[
        "init", "read", "set-subtopics", "complete-iteration", "add-query",
        "set-coverage", "add-error", "stop", "log-query", "summary",
    ])
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--subtopic", action="append", default=[])
    parser.add_argument("--covered", choices=["true", "false"])
    parser.add_argument("--query")
    parser.add_argument("--message")
    parser.add_argument("--reason")
    parser.add_argument("--added", type=int, default=0)
    parser.add_argument("--valuable-added", type=int)
    parser.add_argument("--pool-size", type=int, default=0)
    parser.add_argument("--source")
    parser.add_argument("--mode")
    parser.add_argument("--result-path")
    parser.add_argument("--returned-id", action="append", default=[])
    parser.add_argument("--new-id", action="append", default=[])
    parser.add_argument("--elapsed-seconds", type=float)
    parser.add_argument("--endpoint")
    parser.add_argument("--status", choices=sorted(QUERY_STATUSES))
    args = parser.parse_args()
    if args.action == "init":
        value = initialize(args.work_dir)
    elif args.action in {"read", "summary"}:
        value = initialize(args.work_dir)
        if args.action == "summary":
            value = {
                "iteration": value["iteration"], "queries": len(value["searched_queries"]),
                "pool_size": value["pool_size"], "dry_iterations": value["dry_iterations"],
                "coverage": value["subtopic_coverage"], "stop_reason": value["stop_reason"],
            }
    elif args.action == "log-query":
        if not args.source or not args.mode or not args.query:
            parser.error("log-query requires --source, --mode, and --query")
        value = log_query(
            args.work_dir,
            source=args.source,
            mode=args.mode,
            query=args.query,
            result_path=args.result_path,
            returned_ids=args.returned_id,
            new_ids=args.new_id,
            elapsed_seconds=args.elapsed_seconds,
            error=args.message,
            endpoint=args.endpoint,
            status=args.status,
        )
    else:
        mapping = {
            "subtopics": args.subtopic, "subtopic": args.subtopic[0] if args.subtopic else None,
            "covered": args.covered == "true", "query": args.query, "message": args.message,
            "reason": args.reason, "added": args.added,
            "valuable_added": args.valuable_added, "pool_size": args.pool_size,
        }
        value = update(args.work_dir, args.action, **mapping)
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
