#!/usr/bin/env scholarseed-skill-python
"""Run one batched PaperHub search or citation phase with bounded stdout."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

TOOLS_DIR = Path(__file__).resolve().parent
SEARCH_DIR = TOOLS_DIR.parent
SKILL_DIR = TOOLS_DIR.parents[2]
sys.path.insert(0, str(TOOLS_DIR))
sys.path.insert(0, str(SEARCH_DIR))
sys.path.insert(0, str(SKILL_DIR / "scripts"))

import pool as pool_tool  # noqa: E402
import pool_inspect  # noqa: E402
import state as state_tool  # noqa: E402
from platform_support import WINDOWS, utf8_environment
from io_utils import atomic_write_json, read_json  # noqa: E402
from filesystem import path_exists
from execution_policy import request_timeout, validate_batch, allows_transport_retry, require_search_worker
from balance_policy import RetrievalBudgetExhausted


PAPERHUB = TOOLS_DIR / "paperhub.py"
SEARCH_MODES = {"keyword", "title"}
RATE_WINDOW_BATCH_SIZE = 15
RATE_WINDOW_COOLDOWN_SECONDS = 5.0
TRANSIENT_RETRY_COOLDOWN_SECONDS = 10.0
MAX_BATCH_QUERIES = 100


class RequestPacer:
    """Apply a fixed cooldown after every bounded group of API attempts."""

    def __init__(self) -> None:
        self.attempts = 0

    def before_attempt(self) -> None:
        if self.attempts and self.attempts % RATE_WINDOW_BATCH_SIZE == 0:
            time.sleep(RATE_WINDOW_COOLDOWN_SECONDS)
        self.attempts += 1


def _load_batch(path: Path) -> dict[str, Any]:
    value = read_json(path)
    if not isinstance(value, dict):
        raise ValueError("batch must be a JSON object")
    return value


def _normalize_queries(batch: dict[str, Any]) -> list[dict[str, Any]]:
    raw = batch.get("queries", [])
    if not isinstance(raw, list):
        raise ValueError("batch.queries must be a list")
    if len(raw) > MAX_BATCH_QUERIES:
        raise ValueError(f"a batch may contain at most {MAX_BATCH_QUERIES} queries")
    normalized = []
    seen: set[tuple[str, str, int, int | None, int | None]] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("each query must be an object")
        mode = str(item.get("mode") or "keyword").strip().casefold()
        query = str(item.get("query") or "").strip()
        if mode not in SEARCH_MODES:
            raise ValueError(f"unsupported query mode: {mode}")
        if not query:
            raise ValueError("query text cannot be empty")
        if len(query) > 1000:
            raise ValueError("query text may contain at most 1000 characters")
        default_limit = 5 if mode == "title" else 20
        limit = int(item.get("limit", default_limit))
        if not 1 <= limit <= 100:
            raise ValueError("query limit must be between 1 and 100")
        years: dict[str, int | None] = {}
        for field in ("year_start", "year_end"):
            raw_year = item.get(field)
            if raw_year is None:
                years[field] = None
                continue
            year = int(raw_year)
            if not 1800 <= year <= 2100:
                raise ValueError(f"{field} must be between 1800 and 2100")
            years[field] = year
        if (
            years["year_start"] is not None and years["year_end"] is not None
            and years["year_start"] > years["year_end"]
        ):
            raise ValueError("year_start cannot be greater than year_end")
        key = (mode, query, limit, years["year_start"], years["year_end"])
        if key in seen:
            continue
        seen.add(key)
        normalized.append({
            "mode": mode, "query": query, "limit": limit,
            "_index": len(normalized) + 1, **years,
        })
    return normalized


def _numeric_ids(values: Any, *, field: str, maximum: int) -> list[str]:
    if not isinstance(values, list):
        raise ValueError(f"batch.{field} must be a list")
    result = []
    seen = set()
    for raw in values:
        value = str(raw).strip()
        if not value.isdigit():
            raise ValueError(f"batch.{field} must contain only numeric PaperHub IDs")
        if value not in seen:
            seen.add(value)
            result.append(value)
    if len(result) > maximum:
        raise ValueError(f"batch.{field} may contain at most {maximum} IDs")
    return result


def _parse_cli_json(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return {"status": "error", "error": "PaperHub returned invalid JSON"}
    return parsed if isinstance(parsed, dict) else {
        "status": "error", "error": "PaperHub returned invalid JSON"
    }


def _batch_token(value: dict[str, Any]) -> str:
    """Return a stable, filesystem-safe identity for one logical runner batch."""
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:12]


def _result_path(
    work_dir: Path,
    iteration: int,
    phase: str,
    batch_token: str,
    index: int,
) -> Path:
    return work_dir / "results" / (
        f"iteration-{iteration:03d}-{phase}-{batch_token}-{index:03d}.json"
    )


def _attempt(
    *,
    mode: str,
    value: str,
    limit: int | None,
    year_start: int | None,
    year_end: int | None,
    output_path: Path,
    timeout: int,
    pacer: RequestPacer,
) -> dict[str, Any]:
    require_search_worker(output_path.parent.parent)
    pacer.before_attempt()
    timeout = request_timeout(output_path.parent.parent, timeout)
    command = [
        sys.executable,
        str(PAPERHUB),
        mode,
        value,
        "--output",
        str(output_path),
        "--summary-only",
        "--single-attempt",
    ]
    if limit is not None:
        command.extend(["--limit", str(limit)])
    if year_start is not None:
        command.extend(["--year-start", str(year_start)])
    if year_end is not None:
        command.extend(["--year-end", str(year_end)])
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            text=True,
            **({"encoding": "utf-8", "env": utf8_environment()} if WINDOWS else {}),
            capture_output=True,
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {
            "status": "transport_error",
            "error": f"PaperHub {mode} operation timed out after {timeout}s",
            "retryable": True,
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }
    elapsed = round(time.monotonic() - started, 3)
    if completed.returncode == 0 and path_exists(output_path):
        payload = read_json(output_path)
        return {
            "status": "success",
            "payload": payload,
            "elapsed_seconds": elapsed,
        }
    failure = _parse_cli_json(completed.stderr or completed.stdout)
    failure["elapsed_seconds"] = elapsed
    return failure


def _returned_ids(payload: dict[str, Any]) -> list[str]:
    papers = payload.get("papers")
    if isinstance(papers, list):
        return [
            str(item.get("id")) for item in papers
            if isinstance(item, dict) and item.get("id") is not None
        ]
    references = payload.get("references")
    if isinstance(references, dict):
        result = []
        seen = set()
        for values in references.values():
            if not isinstance(values, list):
                continue
            for raw in values:
                value = str(raw)
                if value not in seen:
                    seen.add(value)
                    result.append(value)
        return result
    return []


def _persist_operation(
    work_dir: Path,
    *,
    mode: str,
    query: str,
    result_path: Path,
    result: dict[str, Any],
    parameters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    status = str(result.get("status") or "error")
    elapsed = result.get("elapsed_seconds")
    if status == "success":
        payload = result.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        returned_ids = _returned_ids(payload)
        papers = payload.get("papers")
        merge = (
            pool_tool.merge_papers(
                work_dir,
                [item for item in papers if isinstance(item, dict)],
            )
            if isinstance(papers, list)
            else {"added": 0, "new_ids": [], "pool_size": _pool_size(work_dir)}
        )
        relative_path = result_path.relative_to(work_dir).as_posix()
        state_tool.log_query(
            work_dir,
            source="paperhub",
            mode=mode,
            query=query,
            result_path=relative_path,
            returned_ids=returned_ids,
            new_ids=list(merge["new_ids"]),
            elapsed_seconds=elapsed,
            error=None,
            endpoint=payload.get("endpoint"),
            status="success",
            parameters=parameters,
        )
        return {
            "mode": mode,
            "query": query,
            "status": "success",
            "count": len(returned_ids),
            "added": int(merge["added"]),
            "new_ids": list(merge["new_ids"]),
            "result_path": relative_path,
            "elapsed_seconds": elapsed,
        }

    error = str(result.get("error") or f"PaperHub {mode} operation failed")
    failure_path = result_path.with_name(f"{result_path.stem}-error.json")
    atomic_write_json(failure_path, {
        "status": status,
        "mode": mode,
        "error": error,
        "http_status": result.get("http_status"),
        "retryable": bool(result.get("retryable")),
    })
    state_tool.log_query(
        work_dir,
        source="paperhub",
        mode=mode,
        query=query,
        result_path=failure_path.relative_to(work_dir).as_posix(),
        returned_ids=[],
        new_ids=[],
        elapsed_seconds=elapsed,
        error=error,
        endpoint=result.get("endpoint"),
        status=status if status in state_tool.QUERY_STATUSES else "failed",
        parameters=parameters,
    )
    return {
        "mode": mode,
        "query": query,
        "status": status,
        "count": 0,
        "added": 0,
        "new_ids": [],
        "result_path": failure_path.relative_to(work_dir).as_posix(),
        "elapsed_seconds": elapsed,
        "error": error,
    }


def _pool_size(work_dir: Path) -> int:
    path = work_dir / "pool.json"
    if not path_exists(path):
        return 0
    value = read_json(path)
    papers = value.get("papers", []) if isinstance(value, dict) else []
    return len(papers) if isinstance(papers, list) else 0


def _resumed_operation(
    work_dir: Path,
    *,
    mode: str,
    query: str,
    result_path: Path,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    current = state_tool.initialize(work_dir)
    if query not in current.get("searched_queries", []) or not path_exists(result_path):
        return None
    payload = read_json(result_path)
    if not isinstance(payload, dict):
        return None
    new_ids: list[str] = []
    log_path = work_dir / "query-log.json"
    if path_exists(log_path):
        log = read_json(log_path)
        entries = log.get("queries", []) if isinstance(log, dict) else []
        for entry in reversed(entries):
            if (
                isinstance(entry, dict)
                and entry.get("source") == "paperhub"
                and entry.get("mode") == mode
                and entry.get("query") == query
                and entry.get("status") == "success"
            ):
                new_ids = [str(value) for value in entry.get("new_ids", [])]
                break
    return ({
        "mode": mode,
        "query": query,
        "status": "success",
        "count": len(_returned_ids(payload)),
        "added": 0,
        "new_ids": new_ids,
        "result_path": result_path.relative_to(work_dir).as_posix(),
        "elapsed_seconds": 0.0,
        "attempts": 0,
        "resumed": True,
    }, payload)


def _run_with_one_retry(
    operation: dict[str, Any],
    *,
    timeout: int,
    pacer: RequestPacer,
) -> dict[str, Any]:
    result = _attempt(**operation, timeout=timeout, pacer=pacer)
    if result.get("retryable") and allows_transport_retry(operation["output_path"].parent.parent):
        attempt_error_path = operation["output_path"].with_name(
            f"{operation['output_path'].stem}-attempt-1-error.json"
        )
        atomic_write_json(attempt_error_path, {
            "status": result.get("status"),
            "error": result.get("error"),
            "http_status": result.get("http_status"),
        })
        time.sleep(TRANSIENT_RETRY_COOLDOWN_SECONDS)
        result = _attempt(**operation, timeout=timeout, pacer=pacer)
        result["attempts"] = 2
    else:
        result["attempts"] = 1
    return result


def _run_search_phase(
    batch: dict[str, Any],
    work_dir: Path,
    iteration: int,
    timeout: int,
    concepts: list[str],
) -> dict[str, Any]:
    queries = _normalize_queries(batch)
    batch_token = _batch_token({
        "phase": "search",
        "iteration": iteration,
        "queries": [
            {
                key: entry[key]
                for key in ("mode", "query", "limit", "year_start", "year_end")
            }
            for entry in queries
        ],
    })
    current = state_tool.initialize(work_dir)
    history = read_json(work_dir / "query-log.json").get("queries", [])
    latest = {}
    for item in history:
        if item.get("source") == "paperhub":
            key = (item.get("mode"), item.get("query"), json.dumps(item.get("parameters") or {}, sort_keys=True))
            latest[key] = item
    successful = {key for key, item in latest.items()
                  if item.get("status") in {None, "success"} and not item.get("error")}
    pending = [entry for entry in queries if (
        entry["mode"], entry["query"],
        json.dumps({key: entry[key] for key in ("limit", "year_start", "year_end")}, sort_keys=True)
    ) not in successful]
    skipped = len(queries) - len(pending)
    pacer = RequestPacer()
    operations = []

    detail = current.get("source_details", {}).get("paperhub", {})
    gate_needed = int(detail.get("queries") or 0) == 0
    if gate_needed and pending:
        gate_index = next(
            (index for index, entry in enumerate(pending) if entry["mode"] == "keyword"),
            None,
        )
        if gate_index is None:
            raise ValueError("the first PaperHub batch requires a keyword capability gate")
        gate = pending.pop(gate_index)
        output_path = _result_path(
            work_dir, iteration, "search", batch_token, int(gate["_index"])
        )
        result = _run_with_one_retry(
            {
                "mode": gate["mode"], "value": gate["query"],
                "limit": gate["limit"],
                "year_start": gate["year_start"], "year_end": gate["year_end"],
                "output_path": output_path,
            },
            timeout=timeout,
            pacer=pacer,
        )
        recorded = _persist_operation(
            work_dir,
            mode=gate["mode"],
            query=gate["query"],
            result_path=output_path,
            result=result,
            parameters={key: gate[key] for key in ("limit", "year_start", "year_end")},
        )
        recorded["gate"] = True
        recorded["attempts"] = result.get("attempts", 1)
        operations.append(recorded)
        if recorded["status"] != "success":
            return _phase_output(
                work_dir, "search", operations, skipped + len(pending), concepts,
                gate_status=recorded["status"],
            )

    retryable: list[tuple[dict[str, Any], Path, dict[str, Any]]] = []
    for entry in pending:
        output_path = _result_path(
            work_dir, iteration, "search", batch_token, int(entry["_index"])
        )
        result = _attempt(
            mode=entry["mode"],
            value=entry["query"],
            limit=entry["limit"],
            year_start=entry["year_start"],
            year_end=entry["year_end"],
            output_path=output_path,
            timeout=timeout,
            pacer=pacer,
        )
        if result.get("retryable") and allows_transport_retry(work_dir):
            retryable.append((entry, output_path, result))
            continue
        recorded = _persist_operation(
            work_dir,
            mode=entry["mode"],
            query=entry["query"],
            result_path=output_path,
            result=result,
            parameters={key: entry[key] for key in ("limit", "year_start", "year_end")},
        )
        recorded["attempts"] = 1
        operations.append(recorded)

    if retryable:
        for entry, output_path, result in retryable:
            atomic_write_json(output_path.with_name(
                f"{output_path.stem}-attempt-1-error.json"
            ), {
                "status": result.get("status"),
                "error": result.get("error"),
                "http_status": result.get("http_status"),
            })
        time.sleep(TRANSIENT_RETRY_COOLDOWN_SECONDS)

    for entry, output_path, _first_result in retryable:
        result = _attempt(
            mode=entry["mode"],
            value=entry["query"],
            limit=entry["limit"],
            year_start=entry["year_start"],
            year_end=entry["year_end"],
            output_path=output_path,
            timeout=timeout,
            pacer=pacer,
        )
        recorded = _persist_operation(
            work_dir,
            mode=entry["mode"],
            query=entry["query"],
            result_path=output_path,
            result=result,
            parameters={key: entry[key] for key in ("limit", "year_start", "year_end")},
        )
        recorded["attempts"] = 2
        operations.append(recorded)
    return _phase_output(work_dir, "search", operations, skipped, concepts)


def _run_citation_phase(
    batch: dict[str, Any],
    work_dir: Path,
    iteration: int,
    timeout: int,
    concepts: list[str],
) -> dict[str, Any]:
    ids = _numeric_ids(batch.get("citation_ids", []), field="citation_ids", maximum=5)
    citation_limit = int(batch.get("citation_limit", 30))
    if not 1 <= citation_limit <= 100:
        raise ValueError("citation_limit must be between 1 and 100")
    if not ids:
        return _phase_output(work_dir, "citations", [], 0, concepts, citation_papers=[])
    batch_token = _batch_token({
        "phase": "citations",
        "iteration": iteration,
        "citation_ids": ids,
        "citation_limit": citation_limit,
    })
    pacer = RequestPacer()
    operations = []
    resumed_count = 0
    refs_path = _result_path(work_dir, iteration, "citations", batch_token, 1)
    refs_query = ",".join(ids)
    refs_key = f"references:{refs_query}"
    resumed_refs = _resumed_operation(
        work_dir, mode="references", query=refs_key, result_path=refs_path
    )
    if resumed_refs is not None:
        recorded_refs, refs_payload = resumed_refs
        refs = {"status": "success", "payload": refs_payload, "attempts": 0}
        resumed_count += 1
    else:
        refs = _run_with_one_retry(
            {
                "mode": "references", "value": refs_query,
                "limit": None, "year_start": None, "year_end": None,
                "output_path": refs_path,
            },
            timeout=timeout,
            pacer=pacer,
        )
        recorded_refs = _persist_operation(
            work_dir,
            mode="references",
            query=refs_key,
            result_path=refs_path,
            result=refs,
        )
        recorded_refs["attempts"] = refs.get("attempts", 1)
    operations.append(recorded_refs)
    if recorded_refs["status"] != "success":
        return _phase_output(
            work_dir, "citations", operations, resumed_count, concepts,
            citation_papers=[]
        )
    payload = refs.get("payload", {})
    ref_ids = _returned_ids(payload)[:citation_limit]
    if not ref_ids:
        output = _phase_output(
            work_dir, "citations", operations, resumed_count, concepts,
            citation_papers=[]
        )
        output["warning"] = payload.get("warning") or "PaperHub returned no reference IDs."
        return output

    papers_path = _result_path(work_dir, iteration, "citations", batch_token, 2)
    papers_query = ",".join(ref_ids)
    papers_key = f"papers:{papers_query}"
    resumed_papers = _resumed_operation(
        work_dir, mode="papers", query=papers_key, result_path=papers_path
    )
    if resumed_papers is not None:
        recorded_papers, papers_payload = resumed_papers
        papers = {"status": "success", "payload": papers_payload, "attempts": 0}
        resumed_count += 1
    else:
        papers = _run_with_one_retry(
            {
                "mode": "papers", "value": papers_query,
                "limit": None, "year_start": None, "year_end": None,
                "output_path": papers_path,
            },
            timeout=timeout,
            pacer=pacer,
        )
        recorded_papers = _persist_operation(
            work_dir,
            mode="papers",
            query=papers_key,
            result_path=papers_path,
            result=papers,
        )
        recorded_papers["attempts"] = papers.get("attempts", 1)
    operations.append(recorded_papers)
    new_ids = set(recorded_papers.get("new_ids", []))
    payload_papers = papers.get("payload", {}).get("papers", [])
    citation_papers = [
        item for item in payload_papers
        if isinstance(item, dict) and str(item.get("id")) in new_ids
    ] if isinstance(payload_papers, list) else []
    return _phase_output(
        work_dir, "citations", operations, resumed_count, concepts,
        citation_papers=citation_papers,
    )


def _phase_output(
    work_dir: Path,
    phase: str,
    operations: list[dict[str, Any]],
    skipped: int,
    concepts: list[str],
    *,
    gate_status: str | None = None,
    citation_papers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    failures = [item for item in operations if item["status"] != "success"]
    status = gate_status or ("partial" if failures else "ok")
    result = {
        "status": status,
        "phase": phase,
        "operations_completed": len(operations),
        "operations_skipped": skipped,
        "added": sum(int(item.get("added") or 0) for item in operations),
        "pool_size": _pool_size(work_dir),
        "results": operations,
        "evidence_view": pool_inspect.build_view(
            pool_inspect._papers(read_json(work_dir / "pool.json")),
            concepts=concepts,
            limit=20,
            abstract_chars=700,
        ),
    }
    if citation_papers is not None:
        result["citation_evidence_view"] = pool_inspect.build_view(
            citation_papers,
            concepts=concepts,
            limit=20,
            abstract_chars=500,
        )
    return result


def run_batch(args: argparse.Namespace) -> dict[str, Any]:
    require_search_worker(args.work_dir)
    batch = _load_batch(args.batch)
    phase = str(batch.get("phase") or "search").strip().casefold()
    if phase not in {"search", "citations"}:
        raise ValueError("batch.phase must be search or citations")
    iteration = int(batch.get("iteration", 1))
    if not 1 <= iteration <= 8:
        raise ValueError("batch.iteration must be between 1 and 8")
    validate_batch(args.work_dir, batch, _normalize_queries(batch))
    concepts_raw = batch.get("inspect_concepts", [])
    if isinstance(concepts_raw, str):
        concepts_raw = [value.strip() for value in concepts_raw.split(",")]
    if not isinstance(concepts_raw, list):
        raise ValueError("batch.inspect_concepts must be a list or comma-separated string")
    concepts = [str(value).strip() for value in concepts_raw if str(value).strip()][:50]
    state_tool.initialize(args.work_dir)
    try:
        if phase == "search":
            return _run_search_phase(
                batch, args.work_dir, iteration, args.timeout, concepts
            )
        return _run_citation_phase(
            batch, args.work_dir, iteration, args.timeout, concepts
        )
    except RetrievalBudgetExhausted as exc:
        return {"status": "partial", "budget_stop": True, "reason": str(exc),
                "pool_size": _pool_size(args.work_dir),
                "evidence_view": pool_inspect.build_view(
                    pool_inspect._papers(read_json(args.work_dir / "pool.json")),
                    concepts=concepts)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch", required=True, type=Path)
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    if args.workers != 1:
        parser.error("--workers must be 1; pacing is intentionally serial")
    if not 1 <= args.timeout <= 600:
        parser.error("--timeout must be between 1 and 600 seconds")
    try:
        output = run_batch(args)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if output.get("status") in {"ok", "partial"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
