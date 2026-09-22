#!/usr/bin/env scholarseed-skill-python
"""Standalone workflow commands: bounded JSON handoffs, validation, and resumable gates."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path

from io_utils import atomic_write_json, atomic_write_text, read_json, utc_now
from platform_support import command_display
from process_control import run_cancellable, ChildProcessCancelled
from run_state import (initialize_run, read_state, update_status, increment_search_round,
                       record_report_review, complete_final_report)
from stage_guard import (authorize_download, claim_stage, contained, digest,
                         require_run, release_stage, require_worker, cancel_stage, serialized)
from validate_json import validate_data

SKILL = Path(__file__).resolve().parent.parent
FINAL_DELIVERY_CHECKPOINT = {
    "capability": "literature",
    "operation": "result",
    "checkpoint": "final",
    "required_before_claiming_delivery": True,
}

# Sibling bundled skill that owns the official-API / visible-browser web providers.
# Resolved by name from the skill root so the route degrades to native Web when the
# web-search skill is not installed alongside this one.
WEB_SEARCH_SKILL_NAME = "web-search"
WEB_SEARCH_INVOKE_PARTS = ("scripts", "invoke.py")


def web_search_invoke() -> str:
    """Absolute path to the sibling web-search skill's invoke.py, or '' when absent."""
    candidate = SKILL.parent.joinpath(WEB_SEARCH_SKILL_NAME, *WEB_SEARCH_INVOKE_PARTS)
    return str(candidate) if candidate.is_file() else ""


def execute(script: str, arguments: list[str], *, environment=None) -> None:
    # Only internal, explicitly selected entrypoints; never execute model text.
    allowed = {"modules/search/finalize.py", "scripts/module_runner.py",
               "scripts/open_download_preflight.py", "scripts/post_open_gate.py"}
    if script not in allowed:
        raise ValueError("unsupported stage executable")
    result = run_cancellable([sys.executable, str(SKILL / script), *map(str, arguments)],
                             env=environment, text=True, capture_output=False)
    if result.returncode:
        raise ValueError(f"{script} failed with exit {result.returncode}; preserve artifacts and resume")


def start(work_dir: Path, request_file: Path, auto_delegated=False) -> dict:
    request = request_file.read_text(encoding="utf-8")
    if not request.strip():
        raise ValueError("request file is empty")
    run = initialize_run(work_dir, request)
    atomic_write_json(run / "workflow.json", {
        "schema_version": "2.0", "run_id": run.name,
        "auto_delegated": bool(auto_delegated), "created_at": utc_now(),
    })
    # A complete draft removes schema discovery without deciding research scope
    # or treating start/auto delegation as confirmation of a generated intent.
    intent_path = run / "intent-draft.json"
    draft = {"schema_version": "1.1", "original_request": request,
             "precise_intent": request.strip(), "research_questions": [],
             "include_criteria": [], "exclude_criteria": [],
             "time_range": {"from_year": None, "to_year": None},
             "paper_types": [], "language": None, "max_results": None,
             "confirmed": False}
    validate_data("intent", draft)
    atomic_write_json(intent_path, draft)
    command = [sys.executable, str(SKILL / "scripts/stage.py"), "search",
               "--run-dir", str(run), "--intent", str(intent_path)]
    return {"status": "ready", "run_dir": str(run), "next_action": "confirm_intent",
            "intent_file": str(intent_path),
            "intent_instructions": (
                "Edit this complete draft: restate precise_intent and fill criteria only from "
                "the user's request/clarifications; keep unspecified fields empty or null. "
                "The copied request is not an interpreted or confirmed intent. "
                + ("Resolve ambiguity conservatively under explicit auto delegation; then set "
                   "confirmed=true and confirmation_source=auto_delegated."
                   if auto_delegated else
                   "Obtain explicit user confirmation (reuse an already-confirmed scope); then set "
                   "confirmed=true and confirmation_source=user_explicit.")
                + " Execute next_command only after confirmation; balance is the default, "
                  "and an explicit mode/budget can be appended with search options."),
            "next_argv": command, "next_command": command_display(command)}


def handoff(run: Path, lease: dict, prompt: str, inputs: dict) -> dict:
    inputs = {"PLS_PYTHON": sys.executable, **inputs}
    for alias, key in (("REQUEST_JSON", "request"), ("WORK", "work_dir")):
        if key in inputs:
            inputs[alias] = inputs[key]
    if "request" in inputs:
        inputs["ROUND_DIR"] = str(Path(inputs["request"]).parent)
    if lease["stage"] == "search":
        # Route the search stage's web step through the sibling web-search skill when it is
        # installed; the prompt falls back to native Web when this resolved path is empty.
        inputs["WEB_SEARCH_INVOKE"] = web_search_invoke()
    command = [sys.executable, str(SKILL / "scripts/stage.py"), "complete",
               "--run-dir", str(run), "--stage", lease["stage"],
               "--token=" + lease["token"]]
    result = {"status": "dispatch_required", "stage": lease["stage"],
            "token": lease["token"], "prompt": str(SKILL / prompt), "inputs": inputs,
            "worker_environment": {"PLS_STAGE_TOKEN": lease["token"]},
            "complete_argv": command, "complete_command": command_display(command)}
    if lease["stage"] == "search" and "work_dir" in inputs:
        dispatch = read_json(Path(inputs["work_dir"]) / "dispatch.json")
        if dispatch.get("profile") == "balance":
            worker = [sys.executable, str(SKILL / "modules/search/worker.py"),
                      "context", "--work-dir", inputs["work_dir"], "--token", lease["token"]]
            result["worker_context_argv"] = worker
            result["worker_context_command"] = command_display(worker)
    return result


@serialized
def prepare_search(run: Path, intent_path: Path | None, profile: str | None,
                   feedback: str | None, max_results: int | None, seconds: int | None) -> dict:
    sys.path.insert(0, str(SKILL / "modules/search/tools"))
    from prepare_search import prepare
    state = read_state(run)
    if state["status"] == "INITIALIZED":
        if intent_path is None:
            raise ValueError("confirmed intent file required")
        intent = read_json(intent_path)
        validate_data("intent", intent)
        if intent["confirmed"] is not True:
            raise ValueError("intent is not confirmed")
        if intent.get("confirmation_source") == "auto_delegated" and not read_json(run / "workflow.json")["auto_delegated"]:
            raise ValueError("automatic intent confirmation was not delegated")
        atomic_write_json(run / "intent.json", intent)
        update_status(run, "INTENT_CONFIRMED", "Confirmed intent supplied", {"intent": "intent.json"})
        state = read_state(run)
    if state["status"] not in {"INTENT_CONFIRMED", "REFINEMENT_REQUESTED"}:
        raise ValueError("search preparation requires confirmed intent or explicit refinement")
    if state["status"] == "REFINEMENT_REQUESTED" and intent_path is not None:
        revised = read_json(intent_path)
        validate_data("intent", revised)
        if revised["confirmed"] is not True:
            raise ValueError("changed scope requires renewed intent confirmation")
        source = revised.get("confirmation_source")
        if source == "auto_delegated":
            if not read_json(run / "workflow.json")["auto_delegated"]:
                raise ValueError("automatic intent confirmation was not delegated")
        elif source != "user_explicit":
            raise ValueError("changed scope requires confirmation_source=user_explicit after user confirmation")
        atomic_write_json(contained(run, state["paths"]["intent"]), revised)
    intent = read_json(contained(run, state["paths"]["intent"]))
    previous_request_path = run / "search" / f"round-{state['search_round']:03d}" / "request.json"
    previous_mode = read_json(previous_request_path).get("search_profile") if previous_request_path.exists() else None
    mode = profile or previous_mode or "balance"
    if mode not in {"fast_mock", "balance", "full"}:
        raise ValueError("new searches support fast_mock, balance, or full")
    count = max_results if max_results is not None else intent.get("max_results")
    cap = {"fast_mock": 1, "balance": 20, "full": None}[mode]
    if max_results is not None and cap is not None and max_results > cap:
        raise ValueError("max_results exceeds selected mode cap")
    count = min(count or cap or 20, cap) if cap else (count or 20)
    excluded = set()
    for archived_selection in sorted((run / "iterations").glob("round-*/selection.json")):
        # Only post-download review creates these archives, not pre-download refinement.
        archived = read_json(archived_selection)
        archived_metadata = read_json(contained(run, archived["metadata_path"]))
        excluded.update(p["id"] for p in archived_metadata["papers"])
    review_value = state["paths"].get("report_review")
    if review_value:
        review = read_json(contained(run, review_value))
        feedback = feedback if feedback is not None else review.get("feedback")
    if feedback is None and state["status"] == "REFINEMENT_REQUESTED" and (run / "refinement-feedback.txt").exists():
        feedback = (run / "refinement-feedback.txt").read_text(encoding="utf-8")
    previous = state["paths"].get("latest_metadata")
    request = {"schema_version": "2.0",
               "run_id": state["run_id"], "round": state["search_round"] + 1,
               "intent": intent, "user_feedback": feedback, "previous_round": previous,
               "exclude_previous_ids": sorted(excluded), "max_results": count, "search_profile": mode}
    if seconds is not None:
        request["time_budget_seconds"] = seconds
    validate_data("search-request", request)
    if mode == "balance":
        from balance_policy import new_policy
        new_policy(seconds)
    lease = claim_stage(run, "search", request["round"], [run / "intent.json"])
    increment_search_round(run)
    round_dir = run / "search" / f"round-{request['round']:03d}"
    atomic_write_json(round_dir / "request.json", request)
    lease["input_sha256"][str((round_dir / "request.json").relative_to(run))] = digest(round_dir / "request.json")
    atomic_write_json(run / "stage-lease.json", lease)
    dispatch = prepare(round_dir / "request.json", round_dir / "work")
    result = handoff(run, lease, dispatch["prompt"], {
        "SKILL_DIR": str(SKILL), "RUN_DIR": str(run),
        "request": str(round_dir / "request.json"), "work_dir": str(round_dir / "work"),
        "plan_contract": dispatch["plan_contract"],
    })
    result["profile"] = mode
    return result


def stats(run: Path) -> dict:
    state = read_state(run)
    result = {"status": state["status"], "run_id": state["run_id"],
              "run_dir": str(run), "search_round": state["search_round"], "artifacts": state["paths"]}
    manifest_path = run / "downloads/manifest.json"
    if manifest_path.exists():
        from post_open_gate import verified_manifest_download
        manifest = read_json(manifest_path)
        counts = Counter(p.get("status", "unknown") for p in manifest["papers"])
        counts["verified_pdf"] = sum(verified_manifest_download(p, run) for p in manifest["papers"])
        result["download_counts"] = dict(counts)
    metadata_path = state["paths"].get("latest_metadata")
    if metadata_path:
        metadata = read_json(contained(run, metadata_path))
        result["candidate_count"] = len(metadata["papers"])
        result["recommendation_count"] = len(metadata.get("related_recommendations", []))
    return result


@serialized
def download(run: Path, intervention_resolved=False, confirm_non_arxiv=False) -> dict:
    from stage_guard import require_download
    state = read_state(run)
    if state["status"] == "PAID_DOWNLOAD_PENDING":
        if not confirm_non_arxiv:
            raise ValueError("non-arXiv batch requires separate confirmation: --confirm-non-arxiv")
        update_status(run, "DOWNLOADING_PAID", "Separate non-arXiv confirmation received")
        state = read_state(run)
    selection = run / "selection.json"
    manifest = run / "downloads/manifest.json"
    environment = dict(os.environ)
    if read_json(run / "workflow.json")["auto_delegated"]:
        environment["PAPER_DL_MODE"] = "autodev"
    if state["status"] == "PAID_ACTION_REQUIRED":
        if not intervention_resolved:
            return {**stats(run), "next_action": "resolve_intervention_before_resume"}
        update_status(run, "DOWNLOADING_PAID", "User resolved the displayed intervention")
    if state["status"] == "DOWNLOAD_DECISION_PENDING":
        update_status(run, "DOWNLOADING_OPEN", "Starting authorized download batch",
                      {"download_manifest": "downloads/manifest.json"})
    state = read_state(run)
    if state["status"] == "DOWNLOADING_OPEN":
        # Preflight writes skipped entries for non-arXiv-only selections.
        from open_download_preflight import route_selection
        selected = read_json(selection)
        metadata = read_json(contained(run, selected["metadata_path"]))
        route, skipped = route_selection(selected, metadata)
        if route["next_action"] == "run_open_download":
            require_download(run, selection, "open-download")
            execute("scripts/module_runner.py", ["--module", "open-download", "--input", selection,
                    "--output", manifest, "--run-dir", run], environment=environment)
        else:
            # Validate the same authorization even when this route makes no HTTP call.
            from stage_guard import digest as file_digest
            permit = read_json(run / "download-authorization.json")
            if (permit["selection_sha256"] != file_digest(selection)
                    or permit["metadata_sha256"] != file_digest(contained(run, selected["metadata_path"]))
                    or permit["round"] != state["search_round"]):
                raise ValueError("download authorization is stale")
            atomic_write_json(manifest, skipped)
        execute("scripts/post_open_gate.py", ["--run-dir", run, "--selection", selection,
                "--manifest", manifest], environment=environment)
    state = read_state(run)
    if state["status"] == "DOWNLOADING_PAID":
        require_download(run, selection, "paid-download")
        execute("scripts/module_runner.py", ["--module", "paid-download", "--input", selection,
                "--output", manifest, "--run-dir", run, "--resume"], environment=environment)
    elif state["status"] == "PAID_ACTION_REQUIRED":
        return {**stats(run), "next_action": "resolve_intervention_before_resume"}
    current = read_json(manifest)
    if current.get("status") == "action_required":
        update_status(run, "PAID_ACTION_REQUIRED", "Download requires user intervention")
    return stats(run)


@serialized
def prepare_reading(run: Path, source: str) -> dict:
    if source == "auto_delegated" and not read_json(run / "workflow.json")["auto_delegated"]:
        raise ValueError("reading was not delegated")
    state = read_state(run)
    if state["status"] not in {"DOWNLOADING_OPEN", "DOWNLOADING_PAID"}:
        raise ValueError("reading requires a settled download batch")
    manifest = read_json(run / "downloads/manifest.json")
    validate_data("download-manifest", manifest)
    if any(p["status"] in {"failed", "action_required", "not_attempted"} for p in manifest["papers"]):
        raise ValueError("resolve, retry, or explicitly skip unsuccessful downloads before reading")
    from post_open_gate import verified_manifest_download
    pdfs = [contained(run, p["file_path"]) for p in manifest["papers"] if verified_manifest_download(p, run)]
    if not pdfs:
        outcome = {"schema_version": "1.0", "run_id": state["run_id"],
                   "search_round": state["search_round"], "manifest_sha256": digest(run / "downloads/manifest.json"),
                   "papers": [{"paper_id": p["paper_id"], "file_path": p.get("file_path"),
                               "status": "unreadable", "reason": "No existing run-contained PDF with valid signature"}
                              for p in manifest["papers"] if p["status"] == "downloaded"]}
        atomic_write_json(run / "reading-outcome.json", outcome)
        for name in ("report.md", "paper_summary.md"):
            atomic_write_text(run / name, "# No readable full text\n\nNo verified PDF was available for reading. No full-text findings are claimed.\n")
        validate_reading(run)
        update_status(run, "REPORT_REVIEW_PENDING", "No verified PDFs; limitations recorded", {
            "download_manifest": "downloads/manifest.json", "reading_outcome": "reading-outcome.json",
            "report": "report.md", "paper_summary": "paper_summary.md"})
        return {**stats(run), "next_action": "finish_or_refine"}
    lease = claim_stage(run, "reading", state["search_round"], [run / "downloads/manifest.json", run / "intent.json", *pdfs])
    update_status(run, "READING", "Reading confirmed", {"download_manifest": "downloads/manifest.json"})
    return handoff(run, lease, "modules/pdf-reader/PDF_READER_AGENT.md", {
        "SKILL_DIR": str(SKILL), "RUN_DIR": str(run), "manifest": str(run / "downloads/manifest.json"),
        **{name: str(run / name) for name in ("report.md", "paper_summary.md", "reading-outcome.json")},
    })


def validate_reading(run: Path) -> dict:
    outcome = read_json(contained(run, "reading-outcome.json"))
    validate_data("reading-outcome", outcome)
    state = read_state(run)
    manifest_path = run / "downloads/manifest.json"
    if (outcome["run_id"] != state["run_id"] or outcome["search_round"] != state["search_round"]
            or outcome["manifest_sha256"] != digest(manifest_path)):
        raise ValueError("reading outcome is stale or bound to a different manifest")
    expected = {(p["paper_id"], p.get("file_path")) for p in read_json(manifest_path)["papers"]
                if p["status"] == "downloaded"}
    actual = {(p["paper_id"], p.get("file_path")) for p in outcome["papers"]}
    if expected != actual or len(actual) != len(outcome["papers"]):
        raise ValueError("reading outcome does not cover exactly the downloaded papers")
    for name in ("report.md", "paper_summary.md"):
        if not contained(run, name).read_text(encoding="utf-8").strip():
            raise ValueError(f"{name} must be nonempty")
    summaries = (run / "paper_summary.md").read_text(encoding="utf-8")
    readable = sum(p["status"] == "readable" for p in outcome["papers"])
    for paper in outcome["papers"]:
        if paper["status"] == "readable":
            path = contained(run, paper["file_path"])
            with path.open("rb") as handle:
                if handle.read(5) != b"%PDF-":
                    raise ValueError("readable outcome requires a valid existing PDF")
    if (summaries.count("Interaction summary:") != readable
            or summaries.count("Query-specific evidence:") != readable):
        raise ValueError("paper_summary.md must have one interaction summary and evidence block per readable paper")
    return outcome


@serialized
def complete(run: Path, stage: str, token: str) -> dict:
    require_worker(run, stage, token, verify_inputs=True)
    state = read_state(run)
    if stage == "search":
        directory = run / "search" / f"round-{state['search_round']:03d}"
        execute("modules/search/finalize.py", ["--input", directory / "request.json", "--work-dir", directory / "work",
                "--output", directory / "metadata.json", "--report-output", directory / "report.md", "--run-dir", run],
                environment=dict(os.environ, PLS_STAGE_TOKEN=token))
        validate_data("metadata", read_json(directory / "metadata.json"))
        update_status(run, "REVIEW_PENDING", "Search output validated", {
            "latest_metadata": str((directory / "metadata.json").relative_to(run)),
            "latest_search_report": str((directory / "report.md").relative_to(run))})
    elif stage == "reading":
        validate_reading(run)
        update_status(run, "REPORT_REVIEW_PENDING", "Reading output validated", {
            "report": "report.md", "paper_summary": "paper_summary.md", "reading_outcome": "reading-outcome.json",
            "reading_plan": None, "native_results": None})
    else:
        complete_final_report(run, _stage_authorized=True)
    release_stage(run, stage, token)
    result = stats(run)
    if stage == "final-report":
        result["delivery_checkpoint"] = FINAL_DELIVERY_CHECKPOINT
    return result


@serialized
def prepare_report(run: Path, source: str) -> dict:
    if source == "auto_delegated" and not read_json(run / "workflow.json")["auto_delegated"]:
        raise ValueError("report completion was not delegated")
    if read_state(run)["status"] != "REPORT_REVIEW_PENDING":
        raise ValueError("report requires an explicit finish decision after reading review")
    validate_reading(run)
    bindings = [run / "intent.json", run / "request.txt", run / "report.md", run / "paper_summary.md",
                run / "reading-outcome.json", run / "downloads/manifest.json"]
    bindings.extend(p for p in (run / "iterations").glob("round-*/*") if p.is_file())
    bindings.extend(p for p in (run / "downloads/papers").glob("*.pdf") if p.is_file())
    lease = claim_stage(run, "final-report", read_state(run)["search_round"], bindings)
    try:
        record_report_review(run, "complete", decision_source="host_agent" if source == "auto_delegated" else "user_explicit")
    except Exception:
        cancel_stage(run, lease["token"])
        raise
    return handoff(run, lease, "modules/final-report/FINAL_REPORT_AGENT.md", {
        "SKILL_DIR": str(SKILL), "RUN_DIR": str(run), "final_report.md": str(run / "final_report.md")})


@serialized
def resume_stage(run: Path, token: str) -> dict:
    lease = read_json(run / "stage-lease.json")
    if lease.get("token") != token or lease.get("status") not in {"active", "cancelled"}:
        raise ValueError("resume requires the saved active/cancelled stage token")
    if lease["round"] != read_state(run)["search_round"]:
        raise ValueError("cannot resume an older round")
    for name, expected in lease.get("input_sha256", {}).items():
        if digest(contained(run, name)) != expected:
            raise ValueError("stage input changed; do not resume a stale scope")
    # Resume retains saved inputs and deadlines; cancelled stages get a fresh token.
    if lease["status"] == "cancelled":
        lease = claim_stage(run, lease["stage"], lease["round"],
                            [contained(run, name) for name in lease.get("input_sha256", {})])
    stage = lease["stage"]
    if stage == "search":
        sys.path.insert(0, str(SKILL / "modules/search/tools"))
        from prepare_search import prepare
        directory = run / "search" / f"round-{lease['round']:03d}"
        dispatch = prepare(directory / "request.json", directory / "work")
        prompt = dispatch["prompt"]
        inputs = {"request": str(directory / "request.json"), "work_dir": str(directory / "work"),
                  "plan_contract": dispatch["plan_contract"]}
    else:
        prompt = {"reading": "modules/pdf-reader/PDF_READER_AGENT.md",
                  "final-report": "modules/final-report/FINAL_REPORT_AGENT.md"}[stage]
        inputs = {name: str(run / name) for name in (
            ("downloads/manifest.json", "report.md", "paper_summary.md", "reading-outcome.json")
            if stage == "reading" else ("final_report.md",))}
    result = handoff(run, lease, prompt, {"SKILL_DIR": str(SKILL), "RUN_DIR": str(run), **inputs})
    return result


@serialized
def refine(run: Path, feedback: str) -> dict:
    if not feedback.strip():
        raise ValueError("refinement requires concrete feedback")
    state = read_state(run)
    if state["status"] == "REPORT_REVIEW_PENDING":
        record_report_review(run, "refine", feedback)
    elif state["status"] == "REVIEW_PENDING" or (
            state["status"] == "SEARCHING" and (run / "stage-lease.json").exists()
            and read_json(run / "stage-lease.json").get("status") == "cancelled"):
        update_status(run, "REFINEMENT_REQUESTED", "Search refinement requested")
    else:
        raise ValueError("refinement requires search or reading review")
    atomic_write_text(run / "refinement-feedback.txt", feedback)
    return {**stats(run), "next_action": "search", "feedback_file": str(run / "refinement-feedback.txt")}


@serialized
def metadata_only(run: Path, source: str) -> dict:
    state = read_state(run)
    if state["status"] not in {"REVIEW_PENDING", "RESULTS_ACCEPTED", "DOWNLOAD_DECISION_PENDING"}:
        raise ValueError("metadata-only completion requires search review before any download")
    if source == "auto_delegated" and not read_json(run / "workflow.json")["auto_delegated"]:
        raise ValueError("completion was not delegated")
    if (run / "downloads/manifest.json").exists():
        raise ValueError("a download was already attempted; use the reading/outcome review flow")
    atomic_write_text(run / "metadata-only.md", "# Metadata-only result\n\n"
                      "The user stopped at scholarly metadata. No PDFs were downloaded or read; "
                      "no full-text conclusions are made.\n\n"
                      f"Search report: {state['paths']['latest_search_report']}\n")
    update_status(run, "COMPLETED", "Metadata-only completion confirmed", {"report": "metadata-only.md"})
    return stats(run)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    begin = sub.add_parser("start")
    begin.add_argument("--work-dir", required=True, type=Path)
    begin.add_argument("--request-file", required=True, type=Path)
    begin.add_argument("--auto-delegated", action="store_true")
    for name in ("search", "complete", "authorize-download", "download", "reading", "report", "status", "resume", "cancel", "refine", "metadata-only"):
        command = sub.add_parser(name)
        command.add_argument("--run-dir", type=Path, required=True)
        if name == "search":
            command.add_argument("--intent", type=Path)
            command.add_argument("--profile", choices=("fast_mock", "full", "balance"))
            command.add_argument("--feedback-file", type=Path)
            command.add_argument("--max-results", type=int)
            command.add_argument("--time-budget-seconds", type=int)
        if name == "refine":
            command.add_argument("--feedback-file", type=Path, required=True)
        if name in {"resume", "cancel"}:
            command.add_argument("--token", required=True)
        if name == "download":
            command.add_argument("--intervention-resolved", action="store_true")
            command.add_argument("--confirm-non-arxiv", action="store_true")
        if name == "complete":
            command.add_argument("--token", required=True)
        if name == "complete":
            command.add_argument("--stage", choices=("search", "reading", "final-report"), required=True)
        if name in {"authorize-download", "reading", "report", "metadata-only"}:
            command.add_argument("--decision-source", choices=("user_explicit", "auto_delegated"), required=True)
        if name == "authorize-download":
            command.add_argument("--selection", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "start":
            result = start(args.work_dir, args.request_file, args.auto_delegated)
        else:
            run = args.run_dir.resolve()
            require_run(run)
            if args.command == "search":
                feedback = args.feedback_file.read_text(encoding="utf-8") if args.feedback_file else None
                result = prepare_search(run, args.intent, args.profile, feedback, args.max_results, args.time_budget_seconds)
            elif args.command == "complete":
                result = complete(run, args.stage, args.token)
            elif args.command == "authorize-download":
                result = authorize_download(run, args.selection, args.decision_source)
            elif args.command == "download":
                result = download(run, args.intervention_resolved, args.confirm_non_arxiv)
            elif args.command == "reading":
                result = prepare_reading(run, args.decision_source)
            elif args.command == "report":
                result = prepare_report(run, args.decision_source)
            elif args.command == "resume":
                result = resume_stage(run, args.token)
            elif args.command == "cancel":
                result = serialized(cancel_stage)(run, args.token)
            elif args.command == "refine":
                result = refine(run, args.feedback_file.read_text(encoding="utf-8"))
            elif args.command == "metadata-only":
                result = metadata_only(run, args.decision_source)
            else:
                result = stats(run)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ChildProcessCancelled as exc:
        print(json.dumps({"status": "cancelled", "signal": exc.signum}))
        return 128 + exc.signum
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({"status": "blocked", "reason": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
