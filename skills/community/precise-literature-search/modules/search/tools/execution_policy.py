"""Enforce this run's saved retrieval limits using recorded query history."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from io_utils import read_json
from filesystem import canonical_path, path_exists
from validate_json import validate_data
from balance_policy import RetrievalBudgetExhausted, request_timeout as balance_timeout


def require_search_worker(work_dir: Path) -> None:
    from stage_guard import require_worker
    work = canonical_path(work_dir)
    if len(work.parents) > 2:
        require_worker(work.parents[2], "search")


def context(work_dir: Path) -> tuple[dict, dict, dict, str | None]:
    def optional(name, root=work_dir):
        path = root / name
        return read_json(path) if path_exists(path) else {}
    dispatch = optional("dispatch.json")
    plan = optional("plan.json")
    request = optional("request.json", work_dir.parent)
    profile = dispatch.get("profile")
    return request, plan, dispatch, profile


def query_history(work_dir: Path) -> list[dict]:
    path = work_dir / "query-log.json"
    if not path_exists(path):
        return []
    return [item for item in read_json(path).get("queries", [])
            if isinstance(item, dict) and item.get("status") != "execution_blocked"]


def allows_transport_retry(work_dir: Path) -> bool:
    return context(work_dir)[3] != "fast_mock"


def consumed_queries(work_dir: Path) -> int:
    return len(query_history(work_dir))


def request_timeout(work_dir: Path, timeout: float) -> float:
    request, plan, dispatch, profile = context(work_dir)
    state_path = work_dir / "state.json"
    if profile is not None and path_exists(state_path):
        state = read_json(state_path)
        if state.get("iteration", 0) >= state.get("max_iterations", 8):
            raise RetrievalBudgetExhausted("saved search iteration budget exhausted")
        if state.get("stop_reason"):
            raise RetrievalBudgetExhausted("search already stopped: " + str(state["stop_reason"]))
    timeout = balance_timeout(work_dir, timeout)
    if profile == "balance":
        return timeout
    seconds = request.get("time_budget_seconds")
    if seconds is not None:
        started_values = [value for value in (dispatch.get("created_at"), plan.get("created_at")) if value]
        if not started_values:
            raise ValueError("an explicit search deadline requires a saved start time")
        starts = [datetime.fromisoformat(value.replace("Z", "+00:00")) for value in started_values]
        if any(start.tzinfo is None for start in starts):
            raise ValueError("search start time must include a timezone")
        started = min(starts)
        remaining = float(seconds) - (datetime.now(timezone.utc) - started).total_seconds()
        if remaining <= 0:
            raise RetrievalBudgetExhausted("saved search time budget exhausted")
        timeout = min(timeout, remaining)
    return timeout


def validate_batch(work_dir: Path, batch: dict, queries: list[dict]) -> None:
    request, plan, dispatch, profile = context(work_dir)
    if profile not in {"fast_mock", "balance", "full"}:
        raise ValueError("discovery requires a prepared search round")
    validate_data(dispatch.get("plan_contract", "search-plan"), plan)
    if request:
        validate_data("search-request", request)
        if (request["intent"].get("confirmed") is not True
                or plan["run_id"] != request["run_id"] or plan["outer_round"] != request["round"]
                or plan["precise_intent"] != request["intent"]["precise_intent"]
                or plan["max_results"] != request["max_results"]
                or plan["exclude_ids"] != request["exclude_previous_ids"]):
            raise ValueError("discovery requires a plan matching the confirmed request")
    iteration = batch.get("iteration", 1)
    maximum = {"fast_mock": 1, "balance": 1}.get(profile, 8)
    if isinstance(iteration, bool) or not isinstance(iteration, int) or not 1 <= iteration <= maximum:
        raise ValueError("batch iteration exceeds the saved strategy")
    history = [item for item in query_history(work_dir) if item.get("source") == "paperhub"]
    phase = batch.get("phase", "search")
    if phase == "search":
        inventory = {(item.get("mode"), str(item.get("query", "")).strip().casefold())
                     for item in history if item.get("mode") in {"keyword", "title"}}
        pending = {(item["mode"], item["query"].casefold()) for item in queries}
        union = inventory | pending
        if profile == "fast_mock":
            cap = 1
            if any(item["limit"] > cap for item in queries):
                raise ValueError("retrieval limit exceeds the saved compact strategy")
            keyword_limit, title_limit = (1, 2)
            if (sum(mode == "keyword" for mode, _ in union) > keyword_limit
                    or sum(mode == "title" for mode, _ in union) > title_limit):
                raise ValueError("compact strategy discovery path budget exhausted")
            keywords = {item["query"].strip().casefold() for item in plan["planned_queries"]
                        if item["mode"] == "keyword"}
            for item in queries:
                for old in history:
                    if (old.get("mode") == item["mode"]
                            and str(old.get("query", "")).strip().casefold() == item["query"].casefold()
                            and old.get("parameters")
                            and old["parameters"] != {key: item[key] for key in ("limit", "year_start", "year_end")}):
                        raise ValueError("compact strategies cannot repeat a discovery query with changed parameters")
                if item["mode"] != "keyword" or item["query"].casefold() in keywords:
                    continue
                raise ValueError("keyword query is not authorized by the saved plan")
        if profile == "balance":
            policy = dispatch.get("policy", {})
            if not policy:
                raise ValueError("balance execution requires its saved policy")
            if (len(union) > policy["max_search_queries"]
                    or sum(mode == "keyword" for mode, _ in union) > policy["max_keyword_queries"]
                    or sum(mode == "title" for mode, _ in union) > policy["max_title_queries"]):
                raise ValueError("balance cumulative query budget exhausted")
            planned = {(item["mode"], item["query"].strip().casefold()) for item in
                       [*plan["planned_queries"], *plan["concept_probes"], *plan["landmark_queries"]]
                       if item["mode"] in {"keyword", "title"}}
            if not pending.issubset(planned):
                raise ValueError("balance query is outside the saved plan")
            if any(item.get("mode") in {"references", "papers"} for item in history):
                raise ValueError("balance does not permit search after citation expansion")
        if profile == "fast_mock":
            for item in queries:
                attempts = [old for old in history if old.get("mode") == item["mode"]
                            and old.get("query", "").strip().casefold() == item["query"].casefold()]
                if attempts and (attempts[-1].get("status") not in {None, "success"}
                                 or attempts[-1].get("error")):
                    raise ValueError("fast_mock does not retry attempted discovery queries")
                for old in attempts:
                    parameters = {key: item[key] for key in ("limit", "year_start", "year_end")}
                    if old.get("parameters") and old["parameters"] != parameters:
                        raise ValueError("fast_mock cannot repeat a query with changed parameters")
    else:
        seeds = {str(value) for value in batch.get("citation_ids", [])}
        limit = batch.get("citation_limit", 30)
        previous = [item for item in history if item.get("mode") == "references"]
        previous_seeds = {seed for item in previous
                          for seed in str(item.get("query", "")).removeprefix("references:").split(",")}
        if profile == "fast_mock":
            if len(seeds | previous_seeds) > 1 or limit > 1:
                raise ValueError("compact strategy citation budget exhausted")
            if previous:
                # A changed iteration or limit produces a different result path,
                # defeating the citation runner's exact-batch cache.
                token = hashlib.sha256(json.dumps({"phase": "citations", "iteration": iteration,
                                                   "citation_ids": list(dict.fromkeys(str(value).strip() for value in batch.get("citation_ids", []))),
                                                   "citation_limit": limit}, sort_keys=True,
                                                  ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()[:12]
                if any(f"iteration-{iteration:03d}-citations-{token}-" not in str(item.get("result_path") or "")
                       for item in previous):
                    raise ValueError("compact citation expansion must resume its original iteration and limit")
        if profile == "fast_mock" and any(item.get("error") or item.get("status") not in {None, "success"}
                                           for item in previous):
            raise ValueError("fast_mock does not retry citation discovery")
        if profile == "balance" and (len(seeds) > 3 or limit != 30):
            raise ValueError("balance citation budget exceeded")
