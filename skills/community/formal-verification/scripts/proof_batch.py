#!/usr/bin/env scholarseed-skill-python
"""Bounded, resumable batch observation of client-prepared Lean candidates."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import statistics
import sys
import time
import uuid

from proof_client import (
    ClientError, ProofClient, TERMINAL, _load_preparation, collect_result,
    confirm_candidate, context_error, positive_number, progress_snapshot, save_task_progress,
    submit_selected, validate_for_submission, write_json, require_account_token,
)


class ObservationClient(ProofClient):
    """Every request, including submission/recovery, fits the observation window."""

    def __init__(self, client, deadline):
        super().__init__(client.base_url, token=client.token, timeout=client.timeout)
        self.opener = client.opener
        self.deadline = deadline

    def request(self, *args, timeout=None, **kwargs):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ClientError("WAIT_TIMEOUT", "batch observation ended; resume the same run")
        return super().request(*args, timeout=min(self.timeout, timeout or self.timeout, remaining), **kwargs)


class BatchProgressReporter:
    """Changed batch evidence plus a quiet heartbeat, without per-poll dumps."""

    def __init__(self, stream=None, heartbeat_seconds=30):
        self.stream = stream if stream is not None else sys.stderr
        self.heartbeat_seconds = positive_number(heartbeat_seconds)
        self.signature = None
        self.last_emitted = 0

    def __call__(self, event):
        snapshot = {key: event[key] for key in ("total", "complete", "verified", "expectations_met")}
        snapshot["active"] = []
        for case in event["active"]:
            progress = case.get("progress") or {}
            snapshot["active"].append({
                "id": case["id"], "task_id": case.get("task_id"),
                "status": progress.get("status", case.get("state")),
                "stage": progress.get("stage"),
                "attempts": progress.get("attempts"), "timing": progress.get("timing"),
                "observation_error": context_error(case["observation_error"]) if case.get("observation_error") else None,
            })
        signature = json.dumps({**snapshot, "active": [
            {key: value for key, value in case.items() if key != "timing"}
            for case in snapshot["active"]]}, sort_keys=True)
        now = time.monotonic()
        if signature != self.signature or now - self.last_emitted >= self.heartbeat_seconds:
            print(json.dumps(snapshot, ensure_ascii=False), file=self.stream, flush=True)
            self.signature, self.last_emitted = signature, now


def batch_report(directory, state):
    rows = []
    accepted = 0
    expectations_met = 0
    first_outer_round = 0
    per_tier = {}
    elapsed = []
    for case in state["cases"]:
        result = case.get("result", {})
        passed = result.get("accepted") is True
        accepted += passed
        expected = case["expected"]
        matched = ((expected == "prove" and passed and result.get("outcome") == "prove")
                   or (expected == "disprove" and passed and result.get("outcome") == "disprove")
                   or (expected == "reject_preflight"
                       and case.get("error", {}).get("code") == "PREFLIGHT_FAILED"))
        case["expectation_met"] = matched if case["state"] == "complete" else None
        expectations_met += matched
        snapshot = result.get("snapshot", {})
        first_outer_round += passed and snapshot.get("attempts", {}).get("completed") == 1
        tier = per_tier.setdefault(case["tier"], {"total": 0, "complete": 0,
                                                 "verified": 0, "expectations_met": 0})
        tier["total"] += 1
        tier["complete"] += case["state"] == "complete"
        tier["verified"] += passed
        tier["expectations_met"] += matched
        seconds = snapshot.get("timing", {}).get("elapsed_seconds")
        if type(seconds) in (int, float) and seconds >= 0:
            elapsed.append(seconds)
        proof = result.get("proof_path")
        problem = result.get("problem_path")
        links = " / ".join(f"[{role}]({path})" for role, path in
                           (("proof", proof), ("problem", problem)) if path)
        rows.append(f"| {case['id']} | {case['tier']} | {case['state']} | "
                    f"{result.get('outcome', case.get('error', {}).get('code', '-'))} | "
                    f"{case.get('task_id', '-')} | {links} |")
    summary = {"total": len(state["cases"]), "verified": accepted,
               "complete": sum(c["state"] == "complete" for c in state["cases"]),
               "expectations_met": expectations_met,
               "first_outer_round_verified": first_outer_round,
               "repair_success_rate": None,
               "repair_note": "No automatic repair or resubmission; new attempts need a new run.",
               "per_tier": per_tier,
               "median_server_elapsed_seconds": statistics.median(elapsed) if elapsed else None,
               "mean_server_elapsed_seconds": statistics.mean(elapsed) if elapsed else None,
               "base_url": state["base_url"]}
    state["summary"] = summary
    write_json(directory / "batch.json", state)
    lines = ["# Proof batch results", "",
             f"Verified proofs/disproofs: {accepted}/{len(state['cases'])}. "
             f"Expected outcomes met: {expectations_met}/{len(state['cases'])}.", "",
             "Completed attempt counts describe observed work only. "
             "Repair success is not measured; this run does not silently repair or retry problems.", "",
             "| Case | Tier | State | Outcome | Task | Files |",
             "| --- | --- | --- | --- | --- | --- |", *rows, ""]
    (directory / "report.md").write_text("\n".join(lines), encoding="utf-8")
    return summary


def run_batch(manifest_path, output_dir, *, client=None, concurrency=4,
              wait_seconds=45, poll_seconds=3, resume=False, on_progress=None):
    """One bounded observation window. A timeout never cancels or duplicates tasks."""
    require_account_token()
    if type(concurrency) is not int or not 1 <= concurrency <= 32:
        raise ValueError("concurrency must be an integer in 1..32")
    deadline = time.monotonic() + positive_number(wait_seconds)
    positive_number(poll_seconds)
    client = client or ProofClient()
    client = ObservationClient(client, deadline)
    manifest_path = Path(manifest_path).resolve()
    raw = manifest_path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    manifest = json.loads(raw)
    cases = manifest.get("cases", [])
    if not cases:
        raise ValueError("manifest needs nonempty cases")
    ids = [case.get("id", "") for case in cases]
    if (len(set(ids)) != len(ids) or any(not re.fullmatch(r"[a-z0-9_-]{1,64}", cid)
                                        for cid in ids)):
        raise ValueError("case IDs must be unique safe basenames")
    # Validate every preparation before the first remote mutation.
    preparation_hashes = {}
    for case in cases:
        path = (manifest_path.parent / case["preparation"]).resolve()
        preparation_hashes[case["id"]] = _load_preparation(path)[3]
        if case.get("expected", "prove") not in {"prove", "disprove", "reject_preflight"}:
            raise ValueError("expected must be prove, disprove, or reject_preflight")
        if "candidate" in case and (not manifest.get("delegated_selection_authorization")
                                    or not case.get("reason")):
            raise ValueError("LLM choices require user delegation and a per-case reason")
        if "candidate" in case and (type(case["candidate"]) is not int
                                    or case["candidate"] not in (1, 2, 3)):
            raise ValueError("candidate must be 1, 2, or 3")
        if "candidate" not in case and not (path / "selection.json").is_file():
            raise ValueError("case requires a saved user selection or delegated LLM choice")
    directory = Path(output_dir).resolve()
    state_path = directory / "batch.json"
    if resume:
        state = json.loads(state_path.read_text(encoding="utf-8"))
        if state["manifest_sha256"] != digest or state["base_url"] != client.base_url:
            raise ValueError("resume requires the same manifest and deployment")
        if any(c["preparation_sha256"] != preparation_hashes[c["id"]] for c in state["cases"]):
            raise ValueError("candidate preparation changed; start a new batch")
        if state.get("stop_reason") == "NOT_FOUND":
            return {**batch_report(directory, state), "busy": False, "not_found": True,
                    "report_path": str(directory / "report.md"),
                    "state_path": str(state_path)}
    else:
        directory.mkdir(parents=True, exist_ok=True)
        if any(directory.iterdir()):
            raise ValueError("new batch output directory must be empty")
        state = {"version": 1, "manifest_sha256": digest, "base_url": client.base_url,
                 "cases": [{"id": c["id"], "tier": c.get("tier", "unspecified"),
                            "expected": c.get("expected", "prove"), "state": "pending",
                            "preparation_sha256": preparation_hashes[c["id"]],
                            "idempotency_key": uuid.uuid4().hex} for c in cases]}
        write_json(directory / "manifest.json", manifest)
        write_json(state_path, state)
    options = dict(manifest.get("options", {}))
    preflight = options.pop("preflight", "required")
    if set(options) - {"rounds", "max_runtime_seconds", "informalize"}:
        raise ValueError("unsupported task option; remote configuration controls execution")
    busy = False
    not_found = False
    while time.monotonic() < deadline:
        for specification, case in zip(cases, state["cases"]):
            run_dir = directory / case["id"]
            if case["state"] == "complete":
                continue
            try:
                if case["state"] in {"pending", "submitting"}:
                    active = sum(c["state"] in {"submitted", "submitting"} for c in state["cases"])
                    if case["state"] == "pending" and active >= concurrency:
                        continue
                    case["state"] = "submitting"
                    write_json(state_path, state)
                    preparation = (manifest_path.parent / specification["preparation"]).resolve()
                    if "candidate" in specification:
                        confirm_candidate(preparation, specification["candidate"],
                                          selection_actor="llm",
                                          authorization=manifest["delegated_selection_authorization"],
                                          reason=specification["reason"])
                    # A lost creation response is replayed only with the exact saved key/payload.
                    if (run_dir / "request.json").is_file():
                        saved_error = run_dir / "error.json"
                        if saved_error.is_file():
                            error = json.loads(saved_error.read_text())
                            if error.get("code") in {"PREFLIGHT_FAILED", "PREFLIGHT_UNAVAILABLE",
                                                     "INVALID_INPUT", "UNSUPPORTED_BUDGET"}:
                                raise ClientError(error["code"], error["message"])
                        saved_task = run_dir / "task.json"
                        if saved_task.is_file():
                            task = json.loads(saved_task.read_text())
                        else:
                            payload = json.loads((run_dir / "request.json").read_text())
                            saved = json.loads((run_dir / "submission.json").read_text())
                            if (saved.get("base_url") != client.base_url
                                    or saved.get("idempotency_key") != case["idempotency_key"]):
                                raise ValueError("saved submission does not match this batch")
                            validate_for_submission(client, payload, run_dir, preflight)
                            task = client.request("POST", "/tasks", payload, key=case["idempotency_key"])
                    else:
                        result = submit_selected(preparation, client=client, output_dir=run_dir,
                                                 idempotency_key=case["idempotency_key"],
                                                 preflight=preflight, **options)
                        task = result["snapshot"]
                    case.update(state="submitted", task_id=task["task_id"])
                    write_json(state_path, state)
                else:
                    task = client.status(case["task_id"], timeout=min(client.timeout,
                                         max(0.01, deadline - time.monotonic())))
                save_task_progress(run_dir, task)
                case["progress"] = progress_snapshot(task)
                case.pop("observation_error", None)
                if task.get("status") in TERMINAL:
                    # A previous interrupted download keeps its evidence; resume into a new folder.
                    attempt = 1
                    delivery = run_dir / "delivery"
                    while delivery.exists():
                        attempt += 1
                        delivery = run_dir / f"delivery-{attempt}"
                    delivery.mkdir()
                    for name in ("request.json", "discovery.json"):
                        if (run_dir / name).is_file():
                            (delivery / name).write_bytes((run_dir / name).read_bytes())
                    case["result"] = collect_result(client, task, delivery)
                    case["state"] = "complete"
            except ClientError as error:
                if error.result.get("http_status") == 404 or error.result["code"] == "NOT_FOUND":
                    if case.get("task_id"):
                        error.result.setdefault("task_id", case["task_id"])
                        case["observation_error"] = error.result
                    else:
                        case.update(state="complete", error=error.result)
                    state["stop_reason"] = "NOT_FOUND"
                    not_found = True
                elif error.result["code"] == "BUSY":
                    if case.get("task_id"):
                        case["observation_error"] = error.result
                    else:
                        case.update(state="complete", error=error.result)
                    busy = True
                elif case.get("task_id"):
                    case["observation_error"] = error.result
                elif (error.result["code"] in {"NETWORK_ERROR", "HTTP_ERROR", "INVALID_RESPONSE", "WAIT_TIMEOUT",
                                                "IDEMPOTENCY_IN_PROGRESS"}
                      or error.result.get("http_status", 0) >= 500):
                    case["observation_error"] = error.result
                else:
                    case.update(state="complete", error=error.result)
            batch_report(directory, state)
            if busy or not_found or time.monotonic() >= deadline:
                break
        summary = batch_report(directory, state)
        if on_progress:
            on_progress({**summary, "active": [
                {"id": c["id"], "task_id": c.get("task_id"), "progress": c.get("progress"),
                 "state": c["state"],
                 "observation_error": c.get("observation_error")}
                for c in state["cases"] if c["state"] in {"submitted", "submitting"}]})
        if busy or not_found or summary["complete"] == summary["total"]:
            break
        time.sleep(min(poll_seconds, max(0, deadline - time.monotonic())))
    return {**batch_report(directory, state), "busy": busy, "not_found": not_found,
            "report_path": str(directory / "report.md"),
            "state_path": str(state_path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--base-url")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--wait-seconds", type=positive_number, default=45)
    parser.add_argument("--poll-seconds", type=positive_number, default=3)
    args = parser.parse_args()
    try:
        result = run_batch(args.manifest, args.output,
                           client=ProofClient(args.base_url, config_path=args.config),
                           concurrency=args.concurrency, wait_seconds=args.wait_seconds,
                           poll_seconds=args.poll_seconds, resume=args.resume,
                           on_progress=BatchProgressReporter())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return (1 if result["busy"] or result["not_found"] else
                3 if result["complete"] != result["total"] else
                0 if result["expectations_met"] == result["total"] else 2)
    except ClientError as error:
        print(json.dumps({"error": context_error(error.result)}, ensure_ascii=False))
        return 1
    except (ValueError, OSError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
