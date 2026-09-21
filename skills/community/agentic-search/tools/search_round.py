#!/usr/bin/env scholarseed-skill-python
"""Run one PaperHub search round from a JSON plan with bounded concurrency.

The complete responses are stored under SESSION/rounds and merged into the
persistent pool. Stdout stays compact so an agent can inspect progress without
loading every abstract into its context.

Plan schema:
{
  "queries": [
    {"mode": "keyword", "query": "diffusion AND optimization", "limit": 20},
    {"mode": "title", "query": "Score Distillation Sampling"}
  ],
  "auto_citations": {"anchor_count": 5, "citation_limit": 30},
  "citation_ids": ["123", "456"],
  "citation_limit": 30,
  "phase": "search",
  "finish_round": false,
  "subtopics": ["guidance", "timestep schedules"],
  "coverage": {"guidance": true}
}
"""

import argparse
from datetime import datetime, timezone
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import state as search_state  # noqa: E402
import pool_inspect as pool_view  # noqa: E402
import search_policy  # noqa: E402


TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
PAPERHUB = os.path.join(TOOLS_DIR, "paperhub.py")
SEARCH_MODES = {"keyword", "title"}
RATE_WINDOW_BATCH_SIZE = 15
RATE_WINDOW_COOLDOWN_SECONDS = 5.0
TRANSIENT_BATCH_RETRY_COOLDOWN_SECONDS = 10.0
AUTO_CITATION_COOLDOWN_MIN_OPERATIONS = 15
AUTO_CITATION_COOLDOWN_SECONDS = 10.0
RETRYABLE_RESULT_CODES = {
    "PAPERHUB_TRANSPORT_ERROR",
    "PAPERHUB_HTTP_429",
    "PAPERHUB_HTTP_500",
    "PAPERHUB_HTTP_502",
    "PAPERHUB_HTTP_503",
    "PAPERHUB_HTTP_504",
}
AUTH_UNAVAILABLE_CODES = {
    "PAPERHUB_AUTH_MISSING",
    "PAPERHUB_HTTP_401",
    "PAPERHUB_HTTP_403",
}
SOURCE_UNAVAILABLE_CODES = AUTH_UNAVAILABLE_CODES | {
    "PAPERHUB_TRANSPORT_ERROR",
    "PAPERHUB_HTTP_500",
    "PAPERHUB_HTTP_502",
    "PAPERHUB_HTTP_503",
    "PAPERHUB_HTTP_504",
}


def _redact_error(value):
    return re.sub(
        r"(?:ssk|sk|pplx)-[A-Za-z0-9_-]+", "[REDACTED]",
        str(value or ""),
    )[:1000]


def _fallback_required(
    args, policy, error_code, planned_queries, operations, message,
):
    failed_operations = []
    for entry, result in operations:
        failed_operations.append({
            "mode": entry.get("mode"),
            "query": entry.get("query") or ",".join(entry.get("ids", [])),
            "error_code": result.get("error_code"),
            "error": _redact_error(result.get("error")),
            "wall_elapsed_seconds": float(result.get("wall_elapsed", 0) or 0),
            "attempts": int(result.get("attempts", 1) or 1),
        })
    retry_attempts = sum(
        max(0, item["attempts"] - 1) for item in failed_operations
    )
    wall_elapsed = round(sum(
        item["wall_elapsed_seconds"] for item in failed_operations
    ), 3)
    event = {
        "schema_version": 1,
        "event": "paperhub_fallback",
        "detected_at_utc": datetime.now(timezone.utc).isoformat(),
        "mode": policy["mode"],
        "paperhub": {
            "error_code": error_code,
            "planned_queries": planned_queries,
            "executed_operations": len(operations),
            "retry_attempts": retry_attempts,
            "wall_elapsed_seconds": wall_elapsed,
            "failed_operations": failed_operations,
        },
    }
    event_path = os.path.join(args.session, "fallback_event.json")
    search_state._atomic_json_write(event_path, event)
    return {
        "mode": policy["mode"],
        "status": "fallback_required",
        "fallback_required": True,
        "fallback_source": "web_search_skill",
        "paperhub_error_code": error_code,
        "planned_queries": planned_queries,
        "executed_operations": len(operations),
        "retry_attempts": retry_attempts,
        "paperhub_wall_elapsed_seconds": wall_elapsed,
        "fallback_event_file": os.path.abspath(event_path),
        "message": message,
    }, 0


def _canonical(mode, value):
    return f"{mode}:{str(value).strip()}"


def _load_plan(path):
    if path == "-":
        data = json.load(sys.stdin)
    else:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("plan must be a JSON object")
    return data


def _normalize_queries(plan):
    queries = plan.get("queries", [])
    if not isinstance(queries, list):
        raise ValueError("plan.queries must be a list")
    if len(queries) > 100:
        raise ValueError("a round may contain at most 100 PaperHub queries")

    normalized = []
    seen = set()
    for item in queries:
        if isinstance(item, str):
            item = {"mode": "keyword", "query": item}
        if not isinstance(item, dict):
            raise ValueError("each query must be a string or object")
        mode = str(item.get("mode", "keyword")).strip().lower()
        value = str(item.get("query", "")).strip()
        if mode not in SEARCH_MODES:
            raise ValueError(f"unsupported query mode: {mode}")
        if not value:
            raise ValueError("query text cannot be empty")
        key = _canonical(mode, value)
        if key in seen:
            continue
        seen.add(key)
        default_limit = 5 if mode == "title" else 20
        limit = int(item.get("limit", default_limit))
        if not 1 <= limit <= 1000:
            raise ValueError(f"invalid limit for {key}: {limit}")
        entry = {
            "mode": mode,
            "query": value,
            "key": key,
            "limit": limit,
            "ensure_abstract": bool(item.get("ensure_abstract", True)),
        }
        for field in ("year_start", "year_end"):
            if item.get(field) is not None:
                entry[field] = int(item[field])
        if entry.get("year_start") and entry.get("year_end"):
            if entry["year_start"] > entry["year_end"]:
                raise ValueError(f"year_start exceeds year_end for {key}")
        normalized.append(entry)
    return normalized


def _run_paperhub(mode, value, options=None, timeout=180):
    options = options or {}
    cmd = [sys.executable, PAPERHUB, mode, value]
    if mode in SEARCH_MODES:
        cmd.extend(["--limit", str(options["limit"])])
        if options.get("year_start") is not None:
            cmd.extend(["--year-start", str(options["year_start"])])
        if options.get("year_end") is not None:
            cmd.extend(["--year-end", str(options["year_end"])])
        if not options.get("ensure_abstract", True):
            cmd.append("--allow-missing-abstract")

    started = time.monotonic()
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "error": f"PaperHub {mode} subprocess timed out after {timeout}s",
            "error_code": "PAPERHUB_BATCH_TIMEOUT",
            "wall_elapsed": round(time.monotonic() - started, 3),
        }
    wall_elapsed = round(time.monotonic() - started, 3)
    try:
        result = json.loads(proc.stdout)
    except (TypeError, ValueError):
        detail = (proc.stderr or proc.stdout or "no output").strip()[:1000]
        return {
            "error": f"PaperHub {mode} returned invalid JSON: {detail}",
            "error_code": "PAPERHUB_BATCH_INVALID_OUTPUT",
            "wall_elapsed": wall_elapsed,
        }
    result["wall_elapsed"] = wall_elapsed
    if proc.returncode and not result.get("error"):
        result["error"] = f"PaperHub {mode} exited with status {proc.returncode}"
        result["error_code"] = "PAPERHUB_BATCH_SUBPROCESS_ERROR"
    return result


def _run_paperhub_with_retry(
    mode, value, options=None, timeout=180, max_attempts=2,
    retry_delay_seconds=0,
):
    """Retry one transient service failure while preserving total wall time."""
    total_wall = 0.0
    result = {}
    attempts = 0
    for attempts in range(1, max_attempts + 1):
        result = _run_paperhub(mode, value, options, timeout)
        total_wall += float(result.get("wall_elapsed", 0) or 0)
        if result.get("error_code") not in RETRYABLE_RESULT_CODES:
            break
        if attempts < max_attempts and retry_delay_seconds:
            time.sleep(retry_delay_seconds)
            total_wall += retry_delay_seconds
    result = dict(result)
    result["wall_elapsed"] = round(total_wall, 3)
    result["attempts"] = attempts
    return result


def _paper_with_provenance(paper, found_by):
    item = dict(paper)
    prior = item.get("found_by", [])
    if isinstance(prior, str):
        prior = [prior]
    item["found_by"] = sorted(set(prior) | {found_by})
    return item


def _paper_identity(paper):
    paper_id = str(paper.get("paper_id") or "").strip()
    if paper_id:
        return f"id:{paper_id}"
    title = re.sub(r"[^a-z0-9]+", "", str(paper.get("title") or "").lower())
    return f"title:{title}" if title else ""


def _merge_for_anchor_selection(papers):
    """Merge duplicate search hits without mutating the persistent pool."""
    merged = {}
    for source in papers:
        if not isinstance(source, dict):
            continue
        identity = _paper_identity(source)
        if not identity:
            continue
        paper = dict(source)
        found_by = paper.get("found_by", [])
        if isinstance(found_by, str):
            found_by = [found_by]
        paper["found_by"] = list(dict.fromkeys(
            item for item in found_by if isinstance(item, str)
        ))
        prior = merged.get(identity)
        if prior is None:
            merged[identity] = paper
            continue
        if not prior.get("abstract") and paper.get("abstract"):
            richer = paper
            other = prior
        else:
            richer = prior
            other = paper
        richer = dict(richer)
        richer["found_by"] = sorted(set(richer.get("found_by", [])) | set(
            other.get("found_by", [])
        ))
        merged[identity] = richer
    return list(merged.values())


def _list_values(value):
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def _anchor_concepts(plan, query, config):
    """Build stable concepts from the model's plan without another model turn."""
    values = []
    values.extend(_list_values(config.get("concepts")))
    values.extend(_list_values(plan.get("inspect_concepts")))
    values.extend(_list_values(plan.get("subtopics")))
    text = " ".join(values + [str(query or "")]).lower()
    values.extend(re.findall(r"[a-z][a-z-]{3,}", text))
    return list(dict.fromkeys(value.lower() for value in values if value))[:100]


def _query_source_priorities(queries):
    """Turn the plan's deliberate per-mode ordering into a bounded prior."""
    priorities = {}
    for mode in SEARCH_MODES:
        group = [entry for entry in queries if entry.get("mode") == mode]
        denominator = max(1, len(group) - 1)
        for index, entry in enumerate(group):
            priorities[entry["key"]] = 1.0 - (index / denominator)
    return priorities


def _anchor_features(paper, concepts, source_priorities=None):
    source_priorities = source_priorities or {}
    sources = [
        source for source in paper.get("found_by", [])
        if isinstance(source, str) and not source.startswith("references:")
    ]
    title_probes = [
        source.split(":", 1)[1].strip()
        for source in sources if source.startswith("title:")
    ]
    match_score = max((
        pool_view._title_match_score(probe, paper.get("title"))
        for probe in title_probes
    ), default=0.0)
    exact_title_match = any(
        pool_view._title_key(probe) == pool_view._title_key(paper.get("title"))
        for probe in title_probes
    )
    relevance = pool_view.heuristic_relevance(paper, concepts)
    evidence_text = (
        f"{paper.get('title') or ''} {paper.get('abstract') or ''}"
    ).lower()
    matched_concepts = {
        concept for concept in concepts
        if len(concept) >= 4 and concept in evidence_text
    }
    # The model already spent effort proposing precise title probes. Preserve
    # that signal, but leave enough room for a strong keyword-only discovery.
    title_bonus = 0.0
    if exact_title_match:
        title_bonus = 7.0
    elif match_score >= 0.55:
        title_bonus = 5.0 * match_score
    source_bonus = min(1.5, 0.35 * len(set(sources)))
    plan_priority = max((source_priorities.get(source, 0.0) for source in sources), default=0.0)
    plan_priority_bonus = 3.0 * plan_priority
    off_topic_penalty = 5.0 if not matched_concepts and match_score < 0.55 else 0.0
    score = (
        relevance + title_bonus + source_bonus + plan_priority_bonus
        - off_topic_penalty
    )
    return {
        "anchor_score": round(score, 4),
        "relevance_score": round(relevance, 4),
        "matched_concept_count": len(matched_concepts),
        "title_match_score": round(match_score, 4),
        "exact_title_match": exact_title_match,
        "plan_priority": round(plan_priority, 4),
        "sources": sources,
    }


def select_auto_citation_anchors(
    papers, *, query="", concepts=None, source_priorities=None,
    anchor_count=5, diversity_weight=0.35,
):
    """Choose auditable, diverse citation anchors from one search batch."""
    concepts = list(concepts or [])
    candidates = []
    for paper in _merge_for_anchor_selection(papers):
        if not str(paper.get("paper_id") or "").strip():
            continue
        item = dict(paper)
        item["_anchor"] = _anchor_features(
            item, concepts, source_priorities=source_priorities,
        )
        candidates.append(item)
    candidates.sort(key=lambda item: (
        -item["_anchor"]["anchor_score"],
        pool_view._title_key(item.get("title")),
        str(item.get("paper_id", "")),
    ))

    selected = []
    covered_sources = set()
    while candidates and len(selected) < anchor_count:
        best_index = 0
        best_value = -float("inf")
        for index, paper in enumerate(candidates):
            features = paper["_anchor"]
            similarity = max((
                pool_view.compute_similarity(paper, prior)
                for prior in selected
            ), default=0.0)
            sources = set(features["sources"])
            source_novelty = 0.5 if sources - covered_sources else 0.0
            value = (
                features["anchor_score"]
                - diversity_weight * similarity * 10
                + source_novelty
            )
            if value > best_value:
                best_index, best_value = index, value
        chosen = candidates.pop(best_index)
        selected.append(chosen)
        covered_sources.update(chosen["_anchor"]["sources"])

    return [{
        "paper_id": str(paper.get("paper_id")),
        "title": paper.get("title", ""),
        "year": paper.get("year"),
        "citation_count": paper.get("citation_count", 0),
        **paper["_anchor"],
    } for paper in selected]


def _auto_citation_config(plan):
    raw = plan.get("auto_citations")
    if raw in (None, False):
        return None
    if raw is True:
        raw = {}
    if not isinstance(raw, dict):
        raise ValueError("plan.auto_citations must be a boolean or object")
    anchor_count = int(raw.get("anchor_count", 5))
    citation_limit = int(raw.get("citation_limit", plan.get("citation_limit", 30)))
    diversity_weight = float(raw.get("diversity_weight", 0.35))
    if not 1 <= anchor_count <= 8:
        raise ValueError("auto_citations.anchor_count must be between 1 and 8")
    if not 1 <= citation_limit <= 200:
        raise ValueError("auto_citations.citation_limit must be between 1 and 200")
    if not 0 <= diversity_weight <= 1:
        raise ValueError("auto_citations.diversity_weight must be between 0 and 1")
    return {
        **raw,
        "anchor_count": anchor_count,
        "citation_limit": citation_limit,
        "diversity_weight": diversity_weight,
    }


def _apply_policy(plan, queries, current):
    """Apply runner-side mode defaults and reject plans that exceed the mode."""
    policy = search_policy.from_state(current)
    mode = policy["mode"]
    plan = dict(plan)
    keyword_count = sum(entry["mode"] == "keyword" for entry in queries)
    title_count = sum(entry["mode"] == "title" for entry in queries)
    limits = (
        ("total", len(queries), int(policy["max_search_queries"])),
        ("keyword", keyword_count, int(policy["max_keyword_queries"])),
        ("title", title_count, int(policy["max_title_queries"])),
    )
    for label, actual, maximum in limits:
        if actual > maximum:
            raise ValueError(
                "%s mode permits at most %d %s queries per plan; received %d"
                % (mode, maximum, label, actual)
            )

    explicit_citations = plan.get("citation_ids", [])
    if explicit_citations is None:
        explicit_citations = []
    if not isinstance(explicit_citations, list):
        raise ValueError("plan.citation_ids must be a list")

    completed = int(current.get("rounds_completed", 0) or 0)
    has_operations = bool(queries or explicit_citations or plan.get("auto_citations"))
    if has_operations and completed >= int(policy["max_logical_rounds"]):
        raise ValueError(
            "%s mode has already completed its %d logical retrieval round(s); finalize now"
            % (mode, policy["max_logical_rounds"])
        )

    if len(explicit_citations) > int(policy["citation_anchor_count"]):
        raise ValueError(
            "%s mode permits at most %d citation anchors; received %d"
            % (mode, policy["citation_anchor_count"], len(explicit_citations))
        )

    if mode == "quick":
        if plan.get("finish_round") is False:
            raise ValueError(
                "quick mode uses one combined search+citation round; finish_round cannot be false"
            )
        if explicit_citations:
            raise ValueError(
                "quick mode selects citation anchors automatically; omit citation_ids"
            )
        if not queries:
            raise ValueError("quick mode requires search queries in its single round")
        plan["auto_citations"] = {
            "anchor_count": int(policy["citation_anchor_count"]),
            "citation_limit": int(policy["citation_limit"]),
            "concepts": plan.get("inspect_concepts") or plan.get("subtopics") or [],
        }
        plan["finish_round"] = True
    return plan, policy


def _query_job(entry, timeout):
    result = _run_paperhub(entry["mode"], entry["query"], entry, timeout)
    return entry, result


def _citation_search(citation_ids, citation_limit, timeout):
    ids = []
    seen = set()
    for value in citation_ids:
        value = str(value).strip()
        if value and value not in seen:
            seen.add(value)
            ids.append(value)
    if not ids:
        return [], [], []

    refs_key = _canonical("references", ",".join(ids))
    refs = _run_paperhub_with_retry(
        "references", ",".join(ids), timeout=timeout,
        retry_delay_seconds=TRANSIENT_BATCH_RETRY_COOLDOWN_SECONDS,
    )
    raw = [{"key": refs_key, "mode": "references", "ids": ids, "result": refs}]
    if refs.get("error"):
        return [], raw, []

    ref_ids = []
    seen_refs = set()
    for anchor_id in ids:
        values = refs.get("references", {}).get(anchor_id, [])
        for ref_id in values:
            ref_id = str(ref_id)
            if ref_id and ref_id not in seen_refs:
                seen_refs.add(ref_id)
                ref_ids.append(ref_id)
                if len(ref_ids) >= citation_limit:
                    break
        if len(ref_ids) >= citation_limit:
            break
    if not ref_ids:
        return [], raw, [refs_key]

    papers_key = _canonical("papers", ",".join(ref_ids))
    papers_result = _run_paperhub_with_retry(
        "papers", ",".join(ref_ids), timeout=timeout,
        retry_delay_seconds=TRANSIENT_BATCH_RETRY_COOLDOWN_SECONDS,
    )
    raw.append({
        "key": papers_key, "mode": "papers", "ids": ref_ids,
        "result": papers_result,
    })
    if papers_result.get("error"):
        return [], raw, [refs_key]
    papers = [
        _paper_with_provenance(paper, refs_key)
        for paper in papers_result.get("papers", [])
    ]
    return papers, raw, [refs_key, papers_key]


def _compact_query_result(item, titles_per_query):
    result = item["result"]
    papers = result.get("papers", [])
    return {
        "mode": item["mode"],
        "query": item.get("query") or ",".join(item.get("ids", [])),
        "count": result.get("count", len(papers)),
        "elapsed": result.get("elapsed", 0),
        "wall_elapsed": result.get("wall_elapsed", 0),
        "attempts": result.get("attempts", 1),
        "top_titles": [p.get("title", "") for p in papers[:titles_per_query]],
        **({"error": result["error"]} if result.get("error") else {}),
    }


def run_round(args):
    plan = _load_plan(args.plan)
    queries = _normalize_queries(plan)
    current = search_state.read_state(args.session)
    if current is None:
        raise ValueError("session is not initialized; run state.py init first")
    plan, policy = _apply_policy(plan, queries, current)
    if not os.environ.get("SCHOLARSEED_API_KEY", "").strip():
        return _fallback_required(
            args, policy, "PAPERHUB_AUTH_MISSING", len(queries), [],
            (
                "PaperHub credential unavailable; use the Web-only fallback "
                "without asking the user for a token."
            ),
        )
    auto_config = _auto_citation_config(plan)
    explicit_citation_ids = plan.get("citation_ids", [])
    if explicit_citation_ids and not isinstance(explicit_citation_ids, list):
        raise ValueError("plan.citation_ids must be a list")
    if auto_config and explicit_citation_ids:
        raise ValueError("auto_citations cannot be combined with citation_ids")
    if auto_config and plan.get("finish_round") is False:
        raise ValueError("auto_citations must finish one combined logical round")
    if (
        explicit_citation_ids and not queries
        and int(current.get("last_round_auto_citation_count", 0) or 0) > 0
    ):
        raise ValueError(
            "the previous logical round already completed automatic citation "
            "tracking; plan a new gap-driven retrieval graph or finalize"
        )

    budget_before = search_state.budget_status(args.session)
    if budget_before.get("enabled") and budget_before.get("should_finalize"):
        return {
            "budget_stop": True,
            "budget": budget_before,
            "message": (
                "Selection/finalization reserve has started; do not open another "
                "retrieval batch. Select from the persistent pool and finalize now."
            ),
        }, 0

    already_searched = set(current.get("searched_queries", []))
    pending = [entry for entry in queries if entry["key"] not in already_searched]
    skipped = [entry["key"] for entry in queries if entry["key"] in already_searched]
    raw_results = []
    successful_query_keys = []
    papers = []
    query_results = []

    started = time.monotonic()
    if pending:
        # PaperHub can reject a tight burst near the 25th request. Preserve the
        # high-value tail of a 27-operation Balanced plan by pacing it instead
        # of dropping title probes or paying repeated 429 backoff failures.
        auth_failure = None
        for offset in range(0, len(pending), RATE_WINDOW_BATCH_SIZE):
            if offset:
                time.sleep(RATE_WINDOW_COOLDOWN_SECONDS)
            batch = pending[offset:offset + RATE_WINDOW_BATCH_SIZE]
            if args.workers == 1:
                for entry in batch:
                    entry, result = _query_job(entry, args.timeout)
                    query_results.append((entry, result))
                    if result.get("error_code") in AUTH_UNAVAILABLE_CODES:
                        auth_failure = result
                        break
            else:
                with ThreadPoolExecutor(
                    max_workers=min(args.workers, len(batch)),
                ) as executor:
                    futures = [
                        executor.submit(_query_job, entry, args.timeout)
                        for entry in batch
                    ]
                    for future in as_completed(futures):
                        entry, result = future.result()
                        query_results.append((entry, result))
                        if result.get("error_code") in AUTH_UNAVAILABLE_CODES:
                            auth_failure = result
            if auth_failure is not None:
                break

        if auth_failure is not None:
            return _fallback_required(
                args, policy, auth_failure.get("error_code"), len(queries),
                query_results,
                (
                    "PaperHub authentication unavailable; stop PaperHub "
                    "requests and use the Web-only fallback without asking "
                    "the user for a token."
                ),
            )

        # A tunnel can reject several concurrent descriptors at once, and the
        # shared service token bucket may still be empty after one request's
        # bounded backoff. Finish the first pass, then retry transient failures
        # serially so retries do not contend with the original batch.
        if any(
            result.get("error_code") in RETRYABLE_RESULT_CODES
            for _, result in query_results
        ):
            time.sleep(TRANSIENT_BATCH_RETRY_COOLDOWN_SECONDS)
        for entry, first_result in query_results:
            result = first_result
            attempts = 1
            if result.get("error_code") in RETRYABLE_RESULT_CODES:
                retry = _run_paperhub(entry["mode"], entry["query"], entry, args.timeout)
                retry = dict(retry)
                retry["wall_elapsed"] = round(
                    float(result.get("wall_elapsed", 0) or 0)
                    + float(retry.get("wall_elapsed", 0) or 0),
                    3,
                )
                result = retry
                attempts = 2
            result = dict(result)
            result["attempts"] = attempts
            raw_results.append({
                "key": entry["key"], "mode": entry["mode"],
                "query": entry["query"], "options": {
                    key: entry[key] for key in (
                        "limit", "year_start", "year_end", "ensure_abstract"
                    ) if key in entry
                },
                "result": result,
            })
            if not result.get("error"):
                successful_query_keys.append(entry["key"])
                papers.extend(
                    _paper_with_provenance(paper, entry["key"])
                    for paper in result.get("papers", [])
                )

    auto_citation = None
    citation_ids = list(explicit_citation_ids)
    citation_limit = int(plan.get("citation_limit", 30))
    if auto_config:
        concepts = _anchor_concepts(plan, current.get("query", ""), auto_config)
        anchors = select_auto_citation_anchors(
            papers,
            query=current.get("query", ""),
            concepts=concepts,
            source_priorities=_query_source_priorities(queries),
            anchor_count=auto_config["anchor_count"],
            diversity_weight=auto_config["diversity_weight"],
        )
        citation_ids = [anchor["paper_id"] for anchor in anchors]
        citation_limit = auto_config["citation_limit"]
        auto_citation_cooldown = 0.0
        if len(pending) >= AUTO_CITATION_COOLDOWN_MIN_OPERATIONS and citation_ids:
            auto_citation_cooldown = AUTO_CITATION_COOLDOWN_SECONDS
            time.sleep(auto_citation_cooldown)
        auto_citation = {
            "requested_anchor_count": auto_config["anchor_count"],
            "selected_anchor_count": len(anchors),
            "citation_limit": citation_limit,
            "pre_citation_cooldown_seconds": auto_citation_cooldown,
            "concepts": concepts,
            "anchors": anchors,
        }
    if not 1 <= citation_limit <= 200:
        raise ValueError("citation_limit must be between 1 and 200")
    citation_key = _canonical("references", ",".join(str(v).strip() for v in citation_ids))
    citation_papers_for_view = []
    if citation_ids and citation_key not in already_searched:
        citation_papers, citation_raw, citation_keys = _citation_search(
            citation_ids, citation_limit, args.timeout,
        )
        citation_papers_for_view = citation_papers
        papers.extend(citation_papers)
        raw_results.extend(citation_raw)
        successful_query_keys.extend(citation_keys)
    elif citation_ids:
        skipped.append(citation_key)

    # Fall back only when every attempted PaperHub operation failed at the
    # source/capability layer. A successful query with zero papers is a valid
    # retrieval result and must not be mistaken for an outage.
    error_codes = [
        item["result"].get("error_code")
        for item in raw_results
        if item["result"].get("error")
    ]
    if (
        raw_results
        and len(error_codes) == len(raw_results)
        and all(code in SOURCE_UNAVAILABLE_CODES for code in error_codes)
    ):
        error_code = next(
            (code for code in error_codes if code in AUTH_UNAVAILABLE_CODES),
            error_codes[0],
        )
        operations = [
            (
                {"mode": item["mode"], "query": item.get("query"), "ids": item.get("ids", [])},
                item["result"],
            )
            for item in raw_results
        ]
        return _fallback_required(
            args, policy, error_code, len(queries), operations,
            (
                "PaperHub is unavailable after bounded retries; use the "
                "Web-only fallback without asking the user for a token."
            ),
        )

    if not raw_results:
        return {
            "error": "the plan contained no new queries or citation anchors",
            "skipped_queries": skipped,
        }, 1

    raw_results.sort(key=lambda item: item["key"])
    failed = [item for item in raw_results if item["result"].get("error")]
    round_number = current.get("rounds_completed", 0) + 1
    phase = re.sub(r"[^a-z0-9_-]+", "-", str(plan.get("phase", "search")).lower()).strip("-")
    phase = phase or "search"
    rounds_dir = os.path.join(args.session, "rounds")
    os.makedirs(rounds_dir, exist_ok=True)
    raw_path = os.path.join(rounds_dir, f"round_{round_number:03d}_{phase}.json")
    if os.path.exists(raw_path):
        raw_path = os.path.join(
            rounds_dir, f"round_{round_number:03d}_{phase}_{int(time.time())}.json",
        )
    raw_document = {
        "round": round_number,
        "plan": plan,
        "results": raw_results,
        "wall_elapsed": round(time.monotonic() - started, 3),
    }
    if auto_citation is not None:
        auto_citation["citation_tracking_complete"] = not any(
            item["result"].get("error")
            for item in raw_results if item["mode"] in {"references", "papers"}
        )
        auto_citation["next_action"] = (
            "assess gaps and either run a new retrieval graph or finalize; "
            "do not run a separate citation-only plan"
        )
        raw_document["auto_citation"] = auto_citation
    search_state._atomic_json_write(raw_path, raw_document)

    state_payload = {
        "queries": successful_query_keys,
        "papers": papers,
        "subtopics": plan.get("subtopics"),
        "coverage": plan.get("coverage", {}),
        "finish_round": bool(plan.get("finish_round", True)),
        "auto_citation_count": (
            int(auto_citation.get("selected_anchor_count", 0))
            if auto_citation is not None else 0
        ),
    }
    if plan.get("new_valuable_papers") is not None:
        state_payload["new_valuable_papers"] = int(plan["new_valuable_papers"])
    persisted = search_state.record_round(args.session, state_payload)
    if persisted.get("error"):
        return persisted, 1

    output = {
        **persisted,
        "mode": policy["mode"],
        "planned_queries": len(queries),
        "executed_operations": len(raw_results),
        "skipped_queries": skipped,
        "failed_operations": len(failed),
        "retry_attempts": sum(
            max(0, int(item["result"].get("attempts", 1)) - 1)
            for item in raw_results
        ),
        "raw_results_file": os.path.abspath(raw_path),
        "round_wall_elapsed": raw_document["wall_elapsed"],
    }
    if auto_citation is not None:
        output["auto_citation"] = auto_citation
    budget_after = search_state.budget_status(args.session)
    if budget_after.get("enabled"):
        output["budget"] = budget_after
        if budget_after.get("should_finalize"):
            output["budget_message"] = (
                "Selection/finalization reserve has started; select from the "
                "persistent pool and finalize instead of opening another batch."
            )
    # Keep budget ahead of per-operation results in serialized stdout. Large
    # evidence views may be truncated by an agent harness; the deadline signal
    # must remain visible without an extra state/help/source inspection.
    output["results"] = [
        _compact_query_result(item, args.titles_per_query) for item in raw_results
    ]
    if getattr(args, "inspect", False):
        pool = search_state.read_pool(args.session)
        papers_for_view = list(pool.values()) if isinstance(pool, dict) else pool
        inspection_concepts = plan.get("inspect_concepts")
        if isinstance(inspection_concepts, str):
            inspection_concepts = [
                item.strip() for item in inspection_concepts.split(",") if item.strip()
            ]
        if not inspection_concepts:
            inspection_concepts = None
        output["evidence_view"] = pool_view.build_view(
            papers_for_view,
            query=current.get("query", ""),
            concepts=inspection_concepts,
            limit=getattr(args, "inspect_limit", 20),
            abstract_chars=getattr(args, "inspect_abstract_chars", 700),
            diversity_weight=getattr(args, "inspect_diversity_weight", 0.25),
        )
        if citation_ids:
            # Citation tracking only improves recall when newly added references
            # are visible to the agent. A global top slice can bury a relevant
            # landmark under stronger papers already seen in the search phase.
            # Return a second, bounded view scoped to this operation.
            unique_new = {}
            for paper in citation_papers_for_view:
                key = str(paper.get("paper_id") or "").strip()
                if not key:
                    key = re.sub(
                        r"[^a-z0-9]+", "", str(paper.get("title") or "").lower()
                    )
                if key:
                    unique_new[key] = paper
            output["citation_evidence_view"] = pool_view.build_view(
                unique_new.values(),
                query=current.get("query", ""),
                concepts=inspection_concepts,
                limit=min(20, getattr(args, "inspect_limit", 20)),
                abstract_chars=min(
                    500, getattr(args, "inspect_abstract_chars", 700),
                ),
                diversity_weight=getattr(args, "inspect_diversity_weight", 0.25),
            )
    return output, (1 if failed and not successful_query_keys else 0)


def main():
    parser = argparse.ArgumentParser(description="Run one batched PaperHub search round")
    parser.add_argument("--plan", required=True, help="JSON plan path, or - for stdin")
    parser.add_argument("--session", required=True, help="initialized search session directory")
    parser.add_argument("--workers", type=int, default=1, help="concurrent searches (1-12)")
    parser.add_argument("--timeout", type=int, default=180, help="timeout per operation")
    parser.add_argument(
        "--titles-per-query", type=int, default=3,
        help="number of titles shown per operation in compact stdout",
    )
    parser.add_argument(
        "--inspect", action="store_true",
        help="append the standard compact post-merge evidence view to stdout",
    )
    parser.add_argument("--inspect-limit", type=int, default=20)
    parser.add_argument("--inspect-abstract-chars", type=int, default=700)
    parser.add_argument("--inspect-diversity-weight", type=float, default=0.25)
    args = parser.parse_args()
    if not 1 <= args.workers <= 12:
        parser.error("--workers must be between 1 and 12")
    if not 0 <= args.titles_per_query <= 10:
        parser.error("--titles-per-query must be between 0 and 10")
    if not 1 <= args.inspect_limit <= 100:
        parser.error("--inspect-limit must be between 1 and 100")
    if not 0 <= args.inspect_abstract_chars <= 5000:
        parser.error("--inspect-abstract-chars must be between 0 and 5000")
    try:
        result, status = run_round(args)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result, status = {"error": str(exc)}, 1
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return status


if __name__ == "__main__":
    raise SystemExit(main())
