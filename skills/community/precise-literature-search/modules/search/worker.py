#!/usr/bin/env scholarseed-skill-python
"""Decision-only interface for the saved balance strategy (no new search policy)."""
from __future__ import annotations

import argparse
from copy import deepcopy
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import sys

SEARCH = Path(__file__).resolve().parent
OUTPUT_BYTES = 8000  # Leave room for the host's tool envelope (often a 10 KB limit).
sys.path.insert(0, str(SEARCH))
sys.path.insert(0, str(SEARCH / "tools"))
sys.path.insert(0, str(SEARCH.parents[1] / "scripts"))
from io_utils import atomic_write_json, read_json
from validate_json import validate_data
from platform_support import lock_file
from stage_guard import require_worker
import selection_evidence as evidence
from finalize import finalize_search
import web_registration
import worker_actions as actions
import worker_review as reviews
from tools import balance_search, pool_inspect, pool, state, search_round
from tools.balance_policy import budget_status


def artifact(root: Path, name: str | Path) -> Path:
    path = Path(name)
    path = path if path.is_absolute() else root / path
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("artifact must stay inside its round directory")
    if path.is_symlink():
        raise ValueError("artifact must not be a symbolic link")
    return path


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


@contextmanager
def transaction(work: Path):
    if work.is_symlink() or work.name != "work":
        raise ValueError("use the supplied round work directory")
    work = work.resolve()
    run = work.parents[2]
    require_worker(run, "search", verify_inputs=True)
    # Share the host transaction lock, without holding the lease lock across IO.
    lock = artifact(run, ".stage-operation.lock")
    with lock.open("a+b") as handle:
        try:
            lock_file(handle, blocking=False)
        except OSError as exc:
            raise ValueError("another stage command is active") from exc
        require_worker(run, "search", verify_inputs=True)
        request = read_json(artifact(work.parent, "request.json"))
        dispatch = read_json(artifact(work, "dispatch.json"))
        validate_data("search-request", request)
        if dispatch.get("profile") != "balance":
            raise ValueError("worker requires a balance round")
        if (dispatch["run_id"] != request["run_id"] or dispatch["outer_round"] != request["round"]
                or request["intent"].get("confirmed") is not True):
            raise ValueError("dispatch does not match the confirmed request")
        policy = dispatch["policy"]
        if request["max_results"] > policy["max_selected_count"]:
            raise ValueError("request exceeds the saved balance result cap")
        # Existing tools use these paths internally; reject escaping symlinks first.
        for name in ("results", "reviews", "state.json", "pool.json", "query-log.json", "plan.json",
                     "balance-execution.json", "web-execution.json", "selection.json"):
            artifact(work, name)
        for name in ("metadata.json", "report.md"):
            artifact(work.parent, name)
        yield request, dispatch


def commands(work: Path) -> dict:
    base = [sys.executable, str(SEARCH / "worker.py")]
    token = require_worker(work.resolve().parents[2], "search")["token"]
    result = {}
    for action, filename in (("context", None), ("overview", None), ("retrieve", "retrieval-decisions.json"),
                             ("cite", "citation-decisions.json"), ("select", "selection-decisions.json"),
                             ("record-web", "web-decisions.json")):
        argv = [*base, action, "--work-dir", str(work), "--token", token]
        if filename:
            argv += ["--input", filename]  # Resolved against work, not the caller's cwd.
        result[action] = {"command": shlex.join(argv)}
    return result


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


CONTROL_DEFAULTS = {"status": "ok", "error": None, "phase_state": {}, "budget": {},
                    "allowed_actions": [], "next_commands": {}, "next_action": None}


def controls(result, cursor=0):
    value = {key: deepcopy(result.get(key, default)) for key, default in CONTROL_DEFAULTS.items()}
    if cursor:
        value["next_commands"] = {}  # Executable templates belong to the first page.
    return value


def record_layout(result):
    """Use the same record envelope for short responses and multi-page views."""
    header = {key: deepcopy(value) for key, value in result.items() if key not in CONTROL_DEFAULTS}
    records = []
    for key in ("evidence_view", "citation_evidence_view"):
        view_data = header.get(key)
        if not isinstance(view_data, dict):
            continue
        for field in ("candidates", "title_probe_best_hits", "citation_candidates"):
            if isinstance(view_data.get(field), list):
                records.extend({"view": key, "kind": field, "record": item}
                               for item in view_data.pop(field))
    # Metadata is also structurally paged, so a long intent never forces JSON
    # character reconstruction. Text segments carry their field path and order.
    sections = []

    def section(value, path):
        if len(encoded(value).encode("utf-8")) <= 2400:
            sections.append({"view": None, "kind": "metadata", "record": {"path": path, "value": value}})
        elif isinstance(value, str):
            parts = [value[i:i + 500] for i in range(0, len(value), 500)]
            for index, part in enumerate(parts):
                sections.append({"view": None, "kind": "text_segment", "record": {
                    "path": path, "part": index + 1, "parts": len(parts), "text": part}})
        elif isinstance(value, (dict, list)):
            sections.append({"view": None, "kind": "metadata", "record": {
                "path": path, "value": {} if isinstance(value, dict) else []}})
            pairs = sorted(value.items()) if isinstance(value, dict) else enumerate(value)
            for key, item in pairs:
                section(item, [*path, key])
        else:
            raise ValueError(f"metadata field {path!r} is too large; reduce this scalar value")

    header_limit = max(0, 6500 - len(encoded(controls(result)).encode("utf-8")))
    if len(encoded(header).encode("utf-8")) <= header_limit:
        return header, records
    compact = {}
    # Keep control information immediately readable even when user text is huge.
    priority = ("intent", "state", "phase_progress")
    keys = [key for key in priority if key in header]
    keys += sorted(set(header) - set(keys))
    for key in keys:
        value = header[key]
        if len(encoded({**compact, key: value}).encode("utf-8")) <= min(4000, header_limit):
            compact[key] = value
        else:
            section(value, [key])
    return compact, sections + records


def record_page(work, result, cursor=0):
    """Page complete records, never serialized JSON fragments or silent truncation."""
    header, records = record_layout(result)
    if not isinstance(cursor, int) or isinstance(cursor, bool) or not 0 <= cursor < len(records) + 1:
        raise ValueError("cursor is outside the saved snapshot")
    name = f"results/worker-output-{digest(result)}.json"
    save_once(artifact(work, name), result)
    pools = [result[key].get("pool_size") for key in ("evidence_view", "citation_evidence_view")
             if isinstance(result.get(key), dict) and isinstance(result[key].get("pool_size"), int)]
    base = [sys.executable, str(SEARCH / "worker.py")]
    scope = ["--work-dir", str(work), "--token", os.environ["PLS_STAGE_TOKEN"]]

    start = max(0, cursor - 1)

    def page_at(end):
        following = end + 1 if end < len(records) else None
        return {**controls(result, cursor), "snapshot": name,
                "metadata": header if cursor == 0 else None,
                "records": records[start:end],
                "counts": {"pool": max(pools) if pools else None,
                           "view": sum(item["view"] is not None for item in records),
                           "total": len(records), "page": end - start},
                "cursor": cursor, "next_cursor": following,
                "next_command": shlex.join([*base, "read-output", *scope, "--input", name,
                                             "--cursor", str(following)]) if following is not None else None}

    page = page_at(start)
    if len(encoded(page).encode("utf-8")) + 1 > OUTPUT_BYTES:
        command = shlex.join([*base, "context", *scope, "--evidence-only", "--limit", "1", "--abstract-chars", "0"])
        raise ValueError(f"output metadata exceeds the bounded page; complete snapshot saved at {name}. "
                         f"Read focused evidence with: {command}")
    end = start
    while end < len(records):
        trial = page_at(end + 1)
        if len(encoded(trial).encode("utf-8")) + 1 > OUTPUT_BYTES:
            if end == start and cursor != 0:
                record = records[end]["record"]
                paper = record.get("paper", record) if isinstance(record, dict) else {}
                identity = str(paper.get("id", ""))
                args = [*base, "context", *scope, "--evidence-only", "--limit", "1", "--abstract-chars", "0"]
                if identity:
                    args += ["--ids", identity]
                raise ValueError(f"evidence record at cursor {cursor} exceeds the bounded page; "
                                 f"complete snapshot saved at {name}. Request a focused summary with: {shlex.join(args)}. "
                                 "The original evidence remains unchanged in the saved snapshot.")
            break
        end += 1
        page = trial
    return page


def display_result(work, result):
    with transaction(work):
        return encoded(record_page(work, result))


def read_output(work, name, cursor=0):
    with transaction(work):
        if name is None or not re.fullmatch(r"results/worker-output-[0-9a-f]{64}\.json", str(name)):
            raise ValueError("read-output requires a worker output snapshot, relative to work")
        result = read_json(artifact(work, name))
        if str(name) != f"results/worker-output-{digest(result)}.json":
            raise ValueError("output snapshot content does not match its digest")
        return record_page(work, result, cursor)


def overview(work, request):
    """Title index of every eligible pool record; full evidence stays in context."""
    papers = evidence._pool(work)
    excluded = {str(value) for value in request["exclude_previous_ids"]}
    plan = read_json(work / "plan.json") if (work / "plan.json").exists() else {}
    concepts = plan.get("subtopics", [])
    ranked = sorted((paper for key, paper in papers.items() if key not in excluded),
                    key=lambda paper: (-pool_inspect._base_score(paper, concepts), str(paper["id"])))
    records = [{key: paper[key] for key in ("id", "title", "year") if key in paper} for paper in ranked]
    # These are navigation records, not a substitute for reviewing source evidence.
    return {"evidence_view": {"pool_size": len(papers), "returned": len(records),
                              "view_type": "title_index", "candidates": records},
            "inspection": {"command": commands(work)["context"]["command"] +
                           " --evidence-only --limit 20 --abstract-chars 4000",
                           "append": "--ids followed by up to 20 IDs from this index"}}


def compact_discovery(work, result):
    if not any(key in result for key in ("evidence_view", "citation_evidence_view")):
        return result
    with transaction(work) as (request, _):
        result = {key: value for key, value in result.items()
                  if key not in {"evidence_view", "citation_evidence_view"}}
        result.update(overview(work, request))
    return result


def bind_view(work, request, visible):
    reviews.bind(work, request, visible, artifact=artifact)


def view(work, request, *, ids=None, limit=20, abstract_chars=700, audit=False):
    maximum = 45 if abstract_chars == 0 else 20
    if not 1 <= limit <= maximum or not 0 <= abstract_chars <= 4000:
        raise ViewError("view limit is 1–20 (45 without abstracts); abstract_chars is 0–4000. Use overview for all candidate titles.")
    papers = evidence._pool(work)
    excluded = {str(value) for value in request["exclude_previous_ids"]}
    chosen = [p for key, p in papers.items() if key not in excluded and (not ids or key in ids)]
    plan = read_json(work / "plan.json") if (work / "plan.json").exists() else {}
    concepts = plan.get("subtopics", [])
    if audit:
        result = pool_inspect.build_provenance_audit(chosen, read_json(work / "query-log.json"),
                                                    concepts=concepts, title_limit=100, citation_limit=20)
        visible = [item["paper"] for item in result["title_probe_best_hits"]] + result["citation_candidates"]
    else:
        result = pool_inspect.build_view(chosen, concepts=concepts, limit=limit, abstract_chars=abstract_chars)
        visible = result["candidates"]
    result["pool_size"] = len(papers)
    bind_view(work, request, visible)
    return {"evidence_view": result}


class ViewError(ValueError):
    code = "invalid_view_options"
    recovery_action = "overview"
    details = {"limit": {"with_abstracts": 20, "titles_only": 45}, "abstract_chars": [0, 4000]}


class DecisionError(ValueError):
    def __init__(self, field, message, **details):
        super().__init__(f"{field}: {message}")
        self.code = "invalid_decision_field"
        self.details = {"field": field, **details}


def require_fields(value, field, names):
    if not isinstance(value, dict):
        raise DecisionError(field, "expected an object")
    for name in names:
        if name not in value:
            raise DecisionError(f"{field}.{name}" if field else name, "required field is missing")


def decision_items(value, field):
    if not isinstance(value, list):
        raise DecisionError(field, "expected an array")
    for index, item in enumerate(value):
        path = f"{field}[{index}]"
        require_fields(item, path, ())
        yield path, item


def validate_decisions(action, decisions):
    """Explain input mistakes at the public interface, before any mutation/IO."""
    if decisions is None:  # Saved-batch resume and existing missing-input errors.
        return
    fields = {"retrieve": ("subtopics", "entity_analysis", "queries"),
              "cite": ("citation_ids",), "record-web": ("queries",),
              "select": ("selected", "coverage_assessment", "warnings", "stop_reason")}
    require_fields(decisions, "", fields[action])
    if action == "retrieve":
        for path, query in decision_items(decisions["queries"], "queries"):
            require_fields(query, path, ("mode", "query", "rationale"))
            if not isinstance(query["rationale"], str) or not query["rationale"].strip():
                raise DecisionError(path + ".rationale", "expected a nonempty query purpose")
            if not isinstance(query["query"], str) or not query["query"].strip():
                raise DecisionError(path + ".query", "expected a nonempty string")
            count = len(query["query"].split())
            if query["mode"] == "keyword" and count > 8:
                raise DecisionError(path + ".query", f"keyword query has {count} words; maximum is 8. Shorten it or split into distinct queries within the phase cap.",
                                    word_count=count, max_words=8, query=query["query"][:240],
                                    query_truncated=len(query["query"]) > 240)
        if not decisions["queries"]:
            raise DecisionError("queries", "expected at least one retrieval query")
        for path, entity in decision_items(decisions.get("entities", []), "entities"):
            require_fields(entity, path, ("name", "type", "rationale", "confidence"))
        for field in ("candidate_angles", "search_angles", "web_queries"):
            if field in decisions:
                raise DecisionError(field, "worker derives this from queries and the Web execution ledger; remove the field")
    elif action == "record-web":
        for path, query in decision_items(decisions["queries"], "queries"):
            require_fields(query, path, ("query", "papers", "status"))
            if not isinstance(query["query"], str) or not query["query"].strip():
                raise DecisionError(path + ".query", "expected a nonempty actual query")
            elapsed = query.get("elapsed_seconds")
            if elapsed is not None and (isinstance(elapsed, bool) or not isinstance(elapsed, (int, float))
                                        or not math.isfinite(elapsed) or elapsed < 0):
                raise DecisionError(path + ".elapsed_seconds", "expected nonnegative measured seconds or null")
            allowed = ["success", "transport_error", "authentication_error", "execution_blocked"]
            if query["status"] not in allowed:
                raise DecisionError(path + ".status", "expected one of: " + ", ".join(allowed), allowed_values=allowed)
            if not isinstance(query["papers"], list):
                raise DecisionError(path + ".papers", "expected an array")
    elif action == "select":
        if "review_token" in decisions or "review_ref" in decisions:
            raise DecisionError("review_ref", "use each paper record's review_ref on its selection item; no global binding is accepted")
        for path, choice in decision_items(decisions.get("related_recommendations", []), "related_recommendations"):
            require_fields(choice, path, ("id", "confirmed_connections", "unmet_criteria"))
        for path, choice in decision_items(decisions["selected"], "selected"):
            require_fields(choice, path, ("id", "tier", "relevance_score", "selection_reason", "subtopics_covered"))
            for criterion_path, criterion in decision_items(choice.get("criteria", []), path + ".criteria"):
                require_fields(criterion, criterion_path, ("criterion_key", "verdict", "reason"))
                for quote_path, quote in decision_items(criterion.get("evidence", []), criterion_path + ".evidence"):
                    require_fields(quote, quote_path, ("field", "quote"))

        for group in ("selected", "related_recommendations"):
            for path, choice in decision_items(decisions.get(group, []), group):
                if "review_token" in choice:
                    raise DecisionError(path + ".review_token", "removed; copy the paper record's review_ref")
                if "review_ref" not in choice:
                    raise reviews.ReviewError("review_reference_invalid", path + ".review_ref", str(choice["id"]), "copy this paper's review_ref from its evidence record")


def build_plan(request, dispatch, decisions, web_outcomes=()):
    validate_decisions("retrieve", decisions)
    queries = [{**q, "angle": q["rationale"]} for q in decisions["queries"]]
    normalized = search_round._normalize_queries({"queries": queries})
    if len(normalized) != len(queries):
        raise ValueError("submit each query once")
    angles = list(dict.fromkeys(q["angle"] for q in queries if q["mode"] == "keyword"))
    # The plan's concept list has 24 slots, while the balanced union permits
    # 27 operations. Keep one binding per entity, then fill with title probes;
    # every title still lives in landmarks and every keyword in planned_queries.
    # With no entities or titles, probes and landmarks stay empty; keywords alone
    # remain the executable plan. Never invent or relabel a title query.
    probes = []
    titles = [q for q in queries if q["mode"] == "title"]
    for entity in decisions.get("entities", []):
        match = next((q for q in [*titles, *queries]
                      if str(q.get("entity", "")).casefold() == str(entity["name"]).casefold()), None)
        if match is None:
            raise ValueError("every entity must be referenced by a query")
        if match not in probes:
            probes.append(match)
    for q in titles:
        if q not in probes and len(probes) < 24:
            probes.append(q)
    known = {str(e["name"]).casefold() for e in decisions.get("entities", [])}
    if any(q.get("entity") and str(q["entity"]).casefold() not in known for q in queries):
        raise ValueError("query references an unknown entity")
    plan = {"schema_version": "2.0", "strategy_version": "search-skill-balanced-v1",
            "run_id": request["run_id"], "outer_round": request["round"],
            "precise_intent": request["intent"]["precise_intent"], "max_results": request["max_results"],
            "exclude_ids": request["exclude_previous_ids"], "created_at": dispatch["created_at"],
            "subtopics": decisions["subtopics"], "entity_analysis": decisions["entity_analysis"],
            "entity_hypotheses": decisions.get("entities", []),
            "candidate_angles": angles, "search_angles": angles,
            "concept_probes": [{"concept": q["angle"], "mode": q["mode"], "query": q["query"].strip(),
                                "rationale": q["rationale"], "entity": q.get("entity")} for q in probes],
            "landmark_queries": [{"mode": q["mode"], "query": q["query"].strip(), "rationale": q["rationale"]}
                                 for q in queries if q["mode"] == "title"],
            "planned_queries": [{"angle": q["angle"], "source": "paperhub", "mode": "keyword",
                                 "query": q["query"].strip(), "purpose": q["rationale"]}
                                for q in queries if q["mode"] == "keyword"]}
    # Web provenance describes executed resolution, not a PaperHub keyword angle.
    plan["web_provenance"] = [{"query": q["query"], "status": q.get("status"),
                               "result_path": q.get("result_path")} for q in web_outcomes]
    validate_data("search-plan-current-balance", plan)
    years = request["intent"].get("time_range") or {}
    batch_queries = []
    for q in normalized:
        item = {key: value for key, value in q.items() if key != "_index"}
        for key, source in (("year_start", "from_year"), ("year_end", "to_year")):
            if item[key] is None:
                item[key] = years.get(source)
        batch_queries.append(item)
    search_round._normalize_queries({"queries": batch_queries})
    return plan, {"phase": "search", "iteration": 1, "finish_round": False,
                  "queries": batch_queries, "inspect_concepts": plan["subtopics"]}


def save_once(path, value):
    if path.exists():
        if read_json(path) != value:
            raise ValueError("cannot replace saved decisions or phase; resume without --input")
    else:
        atomic_write_json(path, value)


def retrieve(work, request, dispatch, decisions):
    batch_path = artifact(work, "results/iteration-001-search-batch.json")
    plan_path = artifact(work, "plan.json")
    if decisions is not None:
        web_outcomes = [q for q in read_json(work / "query-log.json")["queries"]
                        if q.get("source") == "agent_web"]
        plan, batch = build_plan(request, dispatch, decisions, web_outcomes)
        # Check all immutable files before writing any of them.
        for path, value in ((plan_path, plan), (batch_path, batch)):
            if path.exists() and read_json(path) != value:
                raise ValueError("cannot replace saved plan or batch; resume without --input")
        save_once(plan_path, plan)
        save_once(batch_path, batch)
    if not batch_path.exists():
        raise ValueError("first retrieve needs --input with research decisions")
    plan = read_json(plan_path)
    current = read_json(work / "state.json")
    if not current["subtopic_coverage"]:
        state.update(work, "set-subtopics", subtopics=plan["subtopics"])
    return balance_search.run(argparse.Namespace(work_dir=work, batch=batch_path, timeout=180, workers=1))


def cite(work, decisions):
    batch_path = artifact(work, "results/iteration-001-citations-batch.json")
    if decisions is not None:
        ids = search_round._numeric_ids(decisions["citation_ids"], field="citation_ids", maximum=3)
        if len(ids) < 2 or any(value not in evidence._pool(work) for value in ids):
            raise ValueError("choose 2–3 numeric anchors from the current pool")
        plan = read_json(work / "plan.json")
        save_once(batch_path, {"phase": "citations", "iteration": 1, "finish_round": True,
                               "citation_ids": ids, "citation_limit": 30, "inspect_concepts": plan["subtopics"]})
    if not batch_path.exists():
        raise ValueError("first cite needs --input with citation_ids")
    return balance_search.run(argparse.Namespace(work_dir=work, batch=batch_path, timeout=180, workers=1))


def select(work, request, decisions):
    if decisions is None:
        raise ValueError("select requires --input")
    reason = decisions.get("stop_reason")
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 2000:
        raise ValueError("provide a concrete stop_reason of at most 2000 characters")
    papers = evidence._pool(work)
    selected = []
    excluded = {str(value) for value in request["exclude_previous_ids"]}
    seen = set()
    recommendations = []
    choices = [(False, item, f"selected[{index}]") for index, item in enumerate(decisions["selected"])]
    choices += [(True, item, f"related_recommendations[{index}]") for index, item in enumerate(decisions.get("related_recommendations", []))]
    for is_related, choice, choice_path in choices:
        key = str(choice["id"])
        if key not in papers or key in excluded or key in seen:
            raise ValueError("selected IDs must be unique, current, and not excluded")
        displayed = reviews.verify(work, request, papers[key], choice, choice_path, artifact=artifact)
        if is_related:
            reviews.check_quotes(papers[key], displayed, choice, choice_path, related=True)
            recommendations.append({field: choice[field] for field in
                                    ("id", "confirmed_connections", "unmet_criteria")})
            recommendations[-1].update(scope_key=evidence.scope_key(request),
                                       evidence_key=evidence.paper_evidence_key(papers[key]))
            seen.add(key)
            continue
        item = {field: choice[field] for field in
                ("id", "tier", "relevance_score", "selection_reason", "subtopics_covered")}
        item["intent_review"] = {"schema_version": "1.1", "eligible": True,
                                 "reason": choice["selection_reason"], "criteria": choice.get("criteria", []),
                                 "verification_status": "candidate",
                                 **{k: v for k, v in evidence.review_context(request, papers[key]).items()
                                    if k in {"intent_key", "scope_key", "evidence_key"}}}
        status, reasons = evidence.assess({**papers[key], "intent_review": item["intent_review"]}, request)
        if status != "eligible":
            raise ValueError(f"{key}: {' '.join(reasons)}")
        selected.append(item)
        seen.add(key)
    if len(selected) > request["max_results"]:
        raise ValueError("selection exceeds the requested result limit")
    registration = web_registration.summary(work, artifact=artifact)
    registration_warnings = []
    if registration["pending"] or registration["rejected"]:
        registration_warnings.append(f"Web registration: {registration['pending']} pending and {registration['rejected']} rejected records preserved outside the paper pool; inspect saved outcomes before treating this as no evidence.")
    selection = {"schema_version": "1.0", "selected": selected,
                 "related_recommendations": recommendations,
                 "coverage_assessment": decisions["coverage_assessment"], "warnings": list(decisions["warnings"]) + registration_warnings}
    validate_data("search-selection", selection)
    current = read_json(work / "state.json")
    if any(d.get("status") == "execution_blocked" for d in current.get("source_details", {}).values()):
        raise ValueError("execution_blocked requires host environment handling, not scholarly finalization")
    plan_path = work / "plan.json"
    plan = read_json(plan_path) if plan_path.exists() else None
    if plan is None:
        if selected or not budget_status(work)["should_finalize"]:
            raise ValueError("retrieve first; only an exhausted pre-plan budget permits an empty stop")
        current["planning_outcome"] = "budget_exhausted_before_plan"
        selection["warnings"] = list(selection["warnings"]) + ["Budget exhausted before a PaperHub plan was submitted; no PaperHub retrieval was executed."]
    current.update(iteration=1 if plan else 0, pool_size=len(papers), stop_reason=reason)
    covered = {topic for item in selected for topic in item["subtopics_covered"]}
    current["subtopic_coverage"] = {topic: topic in covered for topic in (plan or {}).get("subtopics", [])}
    metadata = finalize_search(request, plan, current,
                               read_json(work / "pool.json"), selection,
                               metadata_path=work.parent / "metadata.json", report_path=work.parent / "report.md")
    atomic_write_json(work / "selection.json", selection)
    atomic_write_json(work / "state.json", current)
    return {"status": metadata["status"], "selected_count": len(metadata["papers"]),
            "recommendation_count": len(metadata.get("related_recommendations", [])),
            "metadata": str(work.parent / "metadata.json"), "report": str(work.parent / "report.md"),
            "stop_reason": reason, "next_action": "host stage complete validates outputs and releases the lease"}


def record_web(work, decisions):
    return web_registration.record(work, decisions, artifact=artifact)


def _run(action, work, decisions=None, *, evidence_only=False, **view_options):
    work = Path(work).absolute()
    with transaction(work) as (request, dispatch):
        actions.preflight(work, action, decisions is not None, budget_status(work))
        if action == "overview":
            return overview(work, request)
        if action == "context":
            current = read_json(work / "state.json")
            result = {"budget": budget_status(work),
                    "state": {key: current.get(key) for key in ("iteration", "max_iterations", "pool_size", "stop_reason", "subtopic_coverage")},
                    "phase_progress": read_json(work / "balance-execution.json") if (work / "balance-execution.json").exists() else {},
                    "plan_saved": (work / "plan.json").exists(),
                    "web_registration": web_registration.summary(work, artifact=artifact),
                    **view(work, request, **view_options)}
            focused = (evidence_only or view_options.get("ids") or view_options.get("audit")
                       or view_options.get("limit", 20) != 20 or view_options.get("abstract_chars", 700) != 700)
            if not focused:
                result.update(profile="balance", intent=request["intent"], user_feedback=request.get("user_feedback"),
                              excluded_ids=request["exclude_previous_ids"], max_results=request["max_results"],
                              required_criteria=evidence.required_criteria(request),
                              web_outcomes=[{"query": q["query"], "status": q.get("status"), "result_path": q.get("result_path")}
                                     for q in read_json(work / "query-log.json")["queries"] if q.get("source") == "agent_web"][-8:],
                              input_examples=str(SEARCH / "DECISION_INPUTS.md"))
            return result
        if isinstance(decisions, Path):
            decisions = read_json(artifact(work, decisions))
        validate_decisions(action, decisions)
        if action == "select":
            return select(work, request, decisions)
        if action == "retrieve":
            result = retrieve(work, request, dispatch, decisions)
        elif action == "cite":
            result = cite(work, decisions)
        elif action == "record-web":
            result = record_web(work, decisions)
        else:
            raise ValueError("unknown worker action")
        # Avoid printing per-operation results plus repeated global evidence.
        compact = {key: result[key] for key in ("status", "budget", "budget_stop", "resumable", "reason",
                    "operations_completed", "operations_planned", "added", "pool_size", "recorded_queries", "web_registration") if key in result}
        compact["failures"] = [{key: item.get(key) for key in ("mode", "status", "error")}
                               for item in result.get("results", []) if item.get("status") != "success"][:8]
        excluded = {str(value) for value in request["exclude_previous_ids"]}
        visible = []
        view_keys = ("citation_evidence_view",) if action == "cite" else ("evidence_view",)
        for key in view_keys:
            if key in result:
                bounded = dict(result[key])
                bounded["candidates"] = [p for p in bounded["candidates"] if str(p["id"]) not in excluded]
                bounded["returned"] = len(bounded["candidates"])
                bounded["pool_size"] = len(evidence._pool(work))
                compact[key] = bounded
                visible.extend(bounded["candidates"])
        if any(key in compact for key in view_keys):
            bind_view(work, request, visible)
            return compact
        if action in {"cite", "record-web"}:
            return compact  # A skipped citation phase has no new evidence.
        return {**compact, **view(work, request)}


def run(action, work, decisions=None, *, evidence_only=False, **view_options):
    work = Path(work).absolute()
    try:
        result = _run(action, work, decisions, evidence_only=evidence_only, **view_options)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        try:
            with transaction(work):
                exc.worker_guidance = actions.error_guidance(work, exc, budget_status(work), commands(work))
        except (ValueError, OSError, KeyError, TypeError):
            pass  # Authentication/state failures must not disclose executable commands.
        raise
    with transaction(work):
        result["budget"] = budget_status(work)
        result.update(actions.guidance(work, result["budget"], commands(work)))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("context", "overview", "retrieve", "cite", "select", "record-web", "read-output"))
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--token", required=True)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--ids", nargs="+")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--abstract-chars", type=int, default=700)
    parser.add_argument("--audit", action="store_true")
    parser.add_argument("--evidence-only", action="store_true", help="omit reusable initialization context")
    parser.add_argument("--cursor", type=int, default=0, help="next_cursor from a saved evidence page")
    args = parser.parse_args()
    os.environ["PLS_STAGE_TOKEN"] = args.token
    try:
        if args.action == "read-output":
            print(encoded(read_output(args.work_dir, args.input, args.cursor)))
            return 0
        result = run(args.action, args.work_dir, args.input, ids=args.ids, limit=args.limit,
                     abstract_chars=args.abstract_chars, audit=args.audit, evidence_only=args.evidence_only)
        if args.action in {"retrieve", "cite"}:
            result = compact_discovery(args.work_dir, result)
        output = display_result(args.work_dir, result)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        message = str(exc)
        guidance = getattr(exc, "worker_guidance", {})
        failure = {"status": "error", **{key: value for key, value in guidance.items() if key in CONTROL_DEFAULTS},
                   "error": {"code": guidance.get("error_code", getattr(exc, "code", "invalid_input")),
                             "message": message[:1000], "message_truncated": len(message) > 1000,
                             "details": getattr(exc, "details", {}),
                             "retryable": guidance.get("retryable", False),
                             "recovery_action": guidance.get("recovery_action"),
                             "recovery_command": guidance.get("recovery_command")}}
        try:
            with transaction(args.work_dir):
                failure["budget"] = budget_status(args.work_dir)
                output = encoded(record_page(args.work_dir, failure))
        except (ValueError, OSError, KeyError, TypeError):
            # Authentication or invalid work paths must not expose state/commands.
            failure = {"status": "error", "error": {
                "code": "worker_response_unavailable", "message": message[:1000],
                "message_truncated": len(message) > 1000, "details": {},
                "retryable": False, "recovery_action": None, "recovery_command": None}}
            output = encoded({**controls(failure), "snapshot": None, "metadata": {}, "records": [],
                              "counts": {"pool": None, "view": 0, "total": 0, "page": 0},
                              "cursor": 0, "next_cursor": None, "next_command": None})
        print(output)
        return 2
    print(output)
    if args.action == "select":
        return 0  # A validated no-match/failure report is still a completed selection command.
    return 0 if result.get("status", "ok") in {"ok", "partial"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
