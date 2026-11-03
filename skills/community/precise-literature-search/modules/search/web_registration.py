"""Preserve native Web discoveries independently of scholarly classification."""
from __future__ import annotations

import hashlib
import json
from urllib.parse import urlsplit

from io_utils import atomic_write_json, read_json, utc_now
from filesystem import path_exists
from normalize import DOCUMENT_TYPES, normalize_paper
from tools import pool, state


def key(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def observations(value):
    """The immutable actual outcome, independent of classification decisions."""
    return {**value, "papers": [
        {k: v for k, v in paper.items()
         if k not in {"document_type", "documentType", "classification_reason"}}
        if isinstance(paper, dict) else paper for paper in value["papers"]]}


def classify(raw, index):
    result = {"index": index, "status": "rejected", "reason": "Expected a titled record with a scholarly URL or identifier."}
    if not isinstance(raw, dict):
        return result, None
    if "documentType" in raw:
        result.update(status="pending", reason="Use document_type with classification_reason; documentType is not a Web decision field.")
        return result, None
    declared = raw.get("document_type")
    if declared is not None and (not isinstance(declared, str) or declared not in DOCUMENT_TYPES):
        result.update(status="pending", reason="Unknown document_type; use an evidenced paper/blog/documentation/dataset/web_page classification.")
        return result, None
    try:
        paper = normalize_paper({**raw, "source": "web_search"})
    except (ValueError, TypeError, AttributeError):
        result.update(status="pending", reason="Malformed metadata; original record preserved for inspection.")
        return result, None
    if paper is None:
        return result, None
    result["title"] = paper["title"]
    url = paper.get("url")
    try:
        parsed = urlsplit(url) if isinstance(url, str) else None
        linked = bool(parsed and parsed.scheme in {"http", "https"} and parsed.hostname)
    except ValueError:
        linked = False
    if not linked and not (paper.get("doi") or paper.get("arxiv_id")):
        return result, None
    if paper["document_type"] == "paper":
        # A domain guess is not required for author-hosted papers, but an explicit
        # override must explain its observed basis rather than merely bypass a gate.
        inferred = normalize_paper({k: v for k, v in {**raw, "source": "web_search"}.items()
                                    if k not in {"document_type", "documentType"}})
        reason = raw.get("classification_reason")
        if declared == "paper" and inferred["document_type"] != "paper" and not (isinstance(reason, str) and 0 < len(reason.strip()) <= 2000):
            result.update(status="pending", reason="For this host, include classification_reason describing observed publication evidence with document_type=paper.")
            return result, None
        result.update(status="accepted", reason="Titled scholarly record.", id=paper["id"])
        return result, paper
    if paper["document_type"] in {"unknown", "web_page"} and declared is None:
        result.update(status="pending", reason="Type is unconfirmed. Record retained outside the paper pool; classify only if needed for a later selection.")
    else:
        result["reason"] = "Classified as " + paper["document_type"] + "; preserved outside the paper pool."
    return result, None


def summary(work, *, artifact):
    result = {"accepted": 0, "pending": 0, "rejected": 0, "outcomes": [],
              "batch_count": 0, "query_count": 0, "accounting": "post_hoc"}
    ledger = artifact(work, "web-execution.json")
    if not path_exists(ledger):
        return result
    batches = read_json(ledger)["batches"]
    result["batch_count"] = len(batches)
    identities = dict.fromkeys(identity for batch in batches for identity in batch["outcome_ids"])
    for identity in identities:
        path = artifact(work, f"results/web-{identity}.json")
        if not path_exists(path):
            continue  # An interrupted registration is completed by resubmitting it.
        result["query_count"] += 1
        for item in read_json(path).get("registration", []):
            result[item["status"]] += 1
        result["outcomes"].append(str(path.relative_to(work)))
    return result


def record(work, decisions, *, artifact):
    if decisions is None:
        raise ValueError("record-web requires --input with actual native web outcomes")
    ledger_path = artifact(work, "web-execution.json")
    ledger = read_json(ledger_path) if path_exists(ledger_path) else {"schema_version": "1.0", "batches": []}
    items = decisions["queries"]
    if not isinstance(items, list) or not 1 <= len(items) <= 8:
        raise ValueError("record one to eight actual web query outcomes")
    prepared, seen = [], set()
    for item in items:
        identity = key(observations(item))
        if identity in seen:
            raise ValueError("record each actual Web outcome once per input")
        seen.add(identity)
        if item["status"] not in {"success", "transport_error", "authentication_error", "execution_blocked"}:
            raise ValueError("invalid web outcome status")
        records = item["papers"]
        if not isinstance(records, list) or len(records) > 20:
            raise ValueError("at most twenty evidenced records per web query")
        path = artifact(work, f"results/web-{identity}.json")
        previous = read_json(path) if path_exists(path) else None
        if previous and observations(previous["raw_outcome"]) != observations(item):
            raise ValueError("saved Web outcome does not match its content digest")
        normalized, registration = [], []
        for index, raw in enumerate(records):
            decision, paper = classify(raw, index)
            if previous and previous["registration"][index]["status"] == "accepted" and decision["status"] != "accepted":
                raise ValueError("cannot downgrade an accepted Web record during registration repair")
            registration.append(decision)
            if paper is not None:
                normalized.append(paper)
        attempt = f"results/web-attempt-{key(item)}.json"
        value = {**item, "papers": normalized, "raw_outcome": item, "registration": registration,
                 "attempts": list(dict.fromkeys([*(previous or {}).get("attempts", []), attempt]))}
        prepared.append((path, value, attempt))
    known = {identity for batch in ledger["batches"] for identity in batch["outcome_ids"]}
    new_ids = sorted(seen - known)
    if new_ids:
        # Save the complete batch before applying derived pool/history updates.
        # Replaying the same input finishes any interrupted write without a new call.
        ledger["batches"].append({"batch_id": key(new_ids), "recorded_at": utc_now(),
                                  "outcome_ids": new_ids})
        atomic_write_json(ledger_path, ledger)
    for path, value, attempt in prepared:
        # An append-only raw snapshot survives every later classification repair.
        raw_path = artifact(work, attempt)
        if not path_exists(raw_path):
            atomic_write_json(raw_path, value["raw_outcome"])
        elif read_json(raw_path) != value["raw_outcome"]:
            raise ValueError("saved Web attempt does not match its content digest")
        merged = pool.merge_papers(work, value["papers"])
        atomic_write_json(path, value)
        history_path = artifact(work, "query-log.json")
        history = read_json(history_path)
        prior = next((q for q in history["queries"] if q.get("source") == "agent_web" and q.get("result_path") == str(path)), None)
        ids = [p["id"] for p in value["papers"]]
        if prior is None:
            state.log_query(work, source="agent_web", mode="web", query=value["query"], result_path=str(path),
                            returned_ids=ids, new_ids=merged["new_ids"], elapsed_seconds=value.get("elapsed_seconds"),
                            error=value.get("error"), status=value["status"])
        else:
            # A classification repair is not another network call. Keep actual
            # query/timing counts and retain the raw attempts in the outcome.
            prior.update(returned_ids=ids, new_ids=list(dict.fromkeys([*prior["new_ids"], *merged["new_ids"]])))
            atomic_write_json(history_path, history)
        # Derive counts from persisted observations, including after an interrupted
        # repair. Incrementing from the previous outcome loses updates on retry.
        current = read_json(artifact(work, "state.json"))
        source = state.canonical_source("agent_web")
        calls = [q for q in read_json(history_path)["queries"]
                 if state.canonical_source(q.get("source", "")) == source]
        counted = [q for q in calls if q.get("status") != "execution_blocked"]
        count = sum(len(q["returned_ids"]) for q in counted)
        current["source_counts"][source] = count
        detail = current["source_details"].setdefault(source, {"status": "success", "endpoint": None, "errors": []})
        detail.update(queries=len(counted), candidates=count)
        # query-log is durable before state updates. Rebuild failure state too,
        # so resuming after that boundary never loses a failed actual call.
        latest = {call["query"]: call for call in calls}
        failed = [call for call in latest.values()
                  if call.get("error") or call.get("status") != "success"]
        messages = [call.get("error") or f"agent_web web {call['query']}: {call['status']}"
                    for call in failed]
        observed_errors = {call.get("error") or f"agent_web web {call['query']}: {call['status']}"
                           for call in calls if call.get("error") or call.get("status") != "success"}
        detail["errors"] = messages
        statuses = {call["status"] for call in failed}
        detail["status"] = ("execution_blocked" if "execution_blocked" in statuses else
                            "partial" if failed and count else
                            "authentication_error" if "authentication_error" in statuses else
                            "transport_error" if failed else "success")
        current["unresolved_errors"] = [message for message in current.get("unresolved_errors", [])
                                        if message not in observed_errors] + messages
        current["errors"] = list(dict.fromkeys([*current.get("errors", []),
                                                *(call["error"] for call in calls if call.get("error"))]))
        current["searched_queries"] = list(dict.fromkeys([*current.get("searched_queries", []),
                                                          *(call["query"] for call in counted)]))
        current["pool_size"] = merged["pool_size"]
        atomic_write_json(artifact(work, "state.json"), current)
    registration = summary(work, artifact=artifact)
    # Recording is complete even when some discoveries are not scholarly papers.
    # Keep individual decisions in the outcome artifact instead of flooding the
    # next model turn with a classification repair checklist.
    registration["classification_blocks_progress"] = False
    registration["instruction"] = (
        "Web outcomes are recorded. Continue retrieval or candidate review. "
        "Pending records remain outside the paper pool; amend their classification only "
        "if a later selection depends on them. Individual decisions are saved in outcomes."
    )
    return {"status": "ok",
            "recorded_queries": len(prepared), "web_registration": registration}
