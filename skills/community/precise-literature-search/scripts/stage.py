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

from acquire_result import (ACQUIRE_RESULT_RELATIVE, AcquireResultError, load_acquire_result,
                            require_within_selection)
from io_utils import atomic_write_json, atomic_write_text, read_json, utc_now
from filesystem import canonical_path, filesystem_path, path_exists
from platform_support import command_display
from process_control import run_cancellable, ChildProcessCancelled
from run_state import (initialize_run, read_state, update_status, increment_search_round,
                       record_report_review, complete_final_report)
from stage_guard import (authorize_download, claim_stage, contained, digest,
                         require_run, release_stage, require_worker, cancel_stage, serialized)
from task_binding import ACTIVATION_HINT, activation_request
from validate_json import ContractError, validate_data

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
DOWNLOAD_COMMAND = "download"
DOWNLOAD_MANIFEST_RELATIVE = "downloads/manifest.json"


def read_download_manifest(run: Path) -> dict:
    manifest = read_json(run / DOWNLOAD_MANIFEST_RELATIVE)
    if not isinstance(manifest, dict):
        raise ContractError("download manifest must be a JSON object")
    papers = manifest.get("papers")
    if not isinstance(papers, list):
        raise ContractError("download manifest papers must be an array")
    for index, paper in enumerate(papers):
        if not isinstance(paper, dict):
            raise ContractError(f"papers[{index}] must be a JSON object")
        status = paper.get("status")
        if not isinstance(status, str) or not status.strip():
            raise ContractError(f"papers[{index}].status must be a non-empty string")
    return manifest


def with_task_activation(result: dict, run: Path, *, download_checkpoint: bool = False) -> dict:
    """Attach this run's lease activation request; the product lease lasts one turn."""
    activation = activation_request(run)
    output = {**result, "task_activation": activation,
              "task_activation_hint": ACTIVATION_HINT}
    manifest = run / DOWNLOAD_MANIFEST_RELATIVE
    if download_checkpoint and path_exists(manifest) and any(paper.get("status") == "downloaded"
                                    for paper in read_download_manifest(run)["papers"]):
        output["download_admission"] = {
            "capability": "literature", "operation": "ingest",
            "request": {"run": activation["request"]["workspace"]},
        }
        output["fulltext_delivery"] = {
            "capability": "literature", "operation": "delivery",
            "request": {"run": activation["request"]["workspace"]},
            "instructions": "Register verified successes with download_admission first, then call this checkpoint. The user chooses where to save resources; library admission is separate. Canceling preserves library items and reading authorization.",
        }
        output["download_admission_hint"] = (
            "After task activation, call this native scholarseed_bridge request now, including "
            "partial successes. It saves PDFs to the library and publishes full-text buttons; "
            "do not wait for reading or final-report. Resolve run relative to the actual session "
            "workdir. Downloaded and admitted are separate outcomes; report admission failures."
        )
    return output


def web_search_invoke() -> str:
    """Absolute path to the sibling web-search skill's invoke.py, or '' when absent."""
    candidate = SKILL.parent.joinpath(WEB_SEARCH_SKILL_NAME, *WEB_SEARCH_INVOKE_PARTS)
    return str(candidate) if filesystem_path(candidate).is_file() else ""


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
    request = filesystem_path(request_file).read_text(encoding="utf-8")
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
    previous_mode = read_json(previous_request_path).get("search_profile") if path_exists(previous_request_path) else None
    mode = profile or previous_mode or "balance"
    if mode not in {"fast_mock", "balance", "full"}:
        raise ValueError("new searches support fast_mock, balance, or full")
    count = max_results if max_results is not None else intent.get("max_results")
    cap = {"fast_mock": 1, "balance": 20, "full": None}[mode]
    if max_results is not None and cap is not None and max_results > cap:
        raise ValueError("max_results exceeds selected mode cap")
    count = min(count or cap or 20, cap) if cap else (count or 20)
    excluded = set()
    for archived_selection in sorted(filesystem_path(run / "iterations").glob("round-*/selection.json")):
        # Only post-download review creates these archives, not pre-download refinement.
        archived = read_json(archived_selection)
        archived_metadata = read_json(contained(run, archived["metadata_path"]))
        excluded.update(p["id"] for p in archived_metadata["papers"])
    review_value = state["paths"].get("report_review")
    if review_value:
        review = read_json(contained(run, review_value))
        feedback = feedback if feedback is not None else review.get("feedback")
    if feedback is None and state["status"] == "REFINEMENT_REQUESTED" and path_exists(run / "refinement-feedback.txt"):
        feedback = filesystem_path((run / "refinement-feedback.txt")).read_text(encoding="utf-8")
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


READING_TEXT_DIR = "work-reading"


def stats(run: Path) -> dict:
    state = read_state(run)
    result = {"status": state["status"], "run_id": state["run_id"],
              "run_dir": str(run), "search_round": state["search_round"], "artifacts": state["paths"]}
    manifest_path = run / DOWNLOAD_MANIFEST_RELATIVE
    if path_exists(manifest_path):
        from post_open_gate import verified_manifest_download
        manifest = read_download_manifest(run)
        counts = Counter(p.get("status", "unknown") for p in manifest["papers"])
        counts["verified_pdf"] = sum(verified_manifest_download(p, run) for p in manifest["papers"])
        counts["managed"] = sum(p.get("storage") == "managed" for p in manifest["papers"])
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
            require_acquired_by_product(run, selected)
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
    current = read_download_manifest(run)
    if current.get("status") == "action_required":
        update_status(run, "PAID_ACTION_REQUIRED", "Download requires user intervention")
    result = stats(run)
    return result


def require_acquired_by_product(run: Path, selection: dict) -> None:
    """Only serve fetches full text, and only the host can relay what it acquired.

    The record is checked here so a missing or widened relay fails before the batch is
    reported; whether the bytes exist is re-verified by serve at the delivery checkpoint.
    """
    result = load_acquire_result(run)
    selected = selection.get("selected_paper_ids")
    if not isinstance(selected, list):
        raise ValueError("selection needs selected_paper_ids")
    require_within_selection(result, [str(paper_id) for paper_id in selected])


@serialized
def prepare_reading(run: Path, source: str) -> dict:
    if source == "auto_delegated" and not read_json(run / "workflow.json")["auto_delegated"]:
        raise ValueError("reading was not delegated")
    state = read_state(run)
    if state["status"] not in {"DOWNLOADING_OPEN", "DOWNLOADING_PAID"}:
        raise ValueError("reading requires a settled download batch")
    manifest = read_download_manifest(run)
    validate_data("download-manifest", manifest)
    if any(p["status"] in {"failed", "action_required", "not_attempted"} for p in manifest["papers"]):
        raise ValueError("resolve, retry, or explicitly skip unsuccessful downloads before reading")
    from post_open_gate import verified_manifest_download
    verified = [p for p in manifest["papers"] if verified_manifest_download(p, run)]
    if not verified:
        outcome = {"schema_version": "1.0", "run_id": state["run_id"],
                   "search_round": state["search_round"], "manifest_sha256": digest(run / "downloads/manifest.json"),
                   "papers": [{"paper_id": p["paper_id"], "file_path": p.get("file_path"),
                               "status": "unreadable",
                               "reason": "No full text is verified by the product for this turn"}
                              for p in manifest["papers"] if p["status"] == "downloaded"]}
        atomic_write_json(run / "reading-outcome.json", outcome)
        for name in ("read_report.md", "paper_summary.md"):
            atomic_write_text(run / name, "# No readable full text\n\nNo verified full text was available for reading. No full-text findings are claimed.\n")
        validate_reading(run)
        update_status(run, "REPORT_REVIEW_PENDING", "No verified full texts; limitations recorded", {
            "download_manifest": "downloads/manifest.json", "reading_outcome": "reading-outcome.json",
            "report": "read_report.md", "paper_summary": "paper_summary.md"})
        return {**stats(run), "next_action": "finish_or_refine"}
    text_dir = run / READING_TEXT_DIR
    filesystem_path(text_dir).mkdir(parents=True, exist_ok=True)
    bindings = [run / "downloads/manifest.json", run / "intent.json"]
    if filesystem_path(run / ACQUIRE_RESULT_RELATIVE).is_file():
        bindings.append(run / ACQUIRE_RESULT_RELATIVE)
    bindings.extend(contained(run, p["file_path"]) for p in verified if p.get("file_path"))
    lease = claim_stage(run, "reading", state["search_round"], bindings)
    update_status(run, "READING", "Reading under the product full-text authorization",
                  {"download_manifest": "downloads/manifest.json"})
    return handoff(run, lease, "modules/pdf-reader/PDF_READER_AGENT.md", {
        "SKILL_DIR": str(SKILL), "RUN_DIR": str(run), "manifest": str(run / "downloads/manifest.json"),
        "reading_dir": str(text_dir),
        **{name: str(run / name) for name in ("read_report.md", "paper_summary.md", "reading-outcome.json")},
    })


def validate_reading(run: Path) -> dict:
    outcome = read_json(contained(run, "reading-outcome.json"))
    validate_data("reading-outcome", outcome)
    state = read_state(run)
    manifest_path = run / "downloads/manifest.json"
    if (outcome["run_id"] != state["run_id"] or outcome["search_round"] != state["search_round"]
            or outcome["manifest_sha256"] != digest(manifest_path)):
        raise ValueError("reading outcome is stale or bound to a different manifest")
    from post_open_gate import verified_manifest_download
    manifest_papers = read_download_manifest(run)["papers"]
    verified = {p["paper_id"] for p in manifest_papers if verified_manifest_download(p, run)}
    expected = {p["paper_id"] for p in manifest_papers if p["status"] == "downloaded"}
    actual = [p["paper_id"] for p in outcome["papers"]]
    if expected != set(actual) or len(actual) != len(set(actual)):
        raise ValueError("reading outcome does not cover exactly the downloaded papers")
    for name in ("read_report.md", "paper_summary.md"):
        if not filesystem_path(contained(run, name)).read_text(encoding="utf-8").strip():
            raise ValueError(f"{name} must be nonempty")
    summaries = filesystem_path((run / "paper_summary.md")).read_text(encoding="utf-8")
    readable = sum(p["status"] == "readable" for p in outcome["papers"])
    for paper in outcome["papers"]:
        if paper["status"] != "readable":
            continue
        if paper["paper_id"] not in verified:
            raise ValueError(
                f"{paper['paper_id']} is claimed readable without a product-verified full text"
            )
        evidence = paper.get("file_path")
        if not isinstance(evidence, str) or not evidence:
            raise ValueError("readable outcome must name the run-contained evidence it used")
        path = contained(run, evidence)
        if not filesystem_path(path).is_file() or filesystem_path(path).stat().st_size == 0:
            raise ValueError("readable outcome requires existing nonempty run-contained evidence")
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
                "--output", directory / "metadata.json", "--report-output", directory / "search_report.md", "--run-dir", run],
                environment=dict(os.environ, PLS_STAGE_TOKEN=token))
        validate_data("metadata", read_json(directory / "metadata.json"))
        update_status(run, "REVIEW_PENDING", "Search output validated", {
            "latest_metadata": (directory / "metadata.json").relative_to(run).as_posix(),
            "latest_search_report": (directory / "search_report.md").relative_to(run).as_posix()})
    elif stage == "reading":
        validate_reading(run)
        update_status(run, "REPORT_REVIEW_PENDING", "Reading output validated", {
            "report": "read_report.md", "paper_summary": "paper_summary.md", "reading_outcome": "reading-outcome.json",
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
    bindings = [run / "intent.json", run / "request.txt", run / "read_report.md", run / "paper_summary.md",
                run / "reading-outcome.json", run / "downloads/manifest.json"]
    bindings.extend(canonical_path(p) for p in filesystem_path(run / "iterations").glob("round-*/*") if p.is_file())
    bindings.extend(canonical_path(p) for p in filesystem_path(run / "downloads/papers").glob("*.pdf") if p.is_file())
    bindings.extend(canonical_path(p) for p in filesystem_path(run / READING_TEXT_DIR).glob("*.txt") if p.is_file())
    if filesystem_path(run / ACQUIRE_RESULT_RELATIVE).is_file():
        bindings.append(run / ACQUIRE_RESULT_RELATIVE)
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
            ("downloads/manifest.json", "read_report.md", "paper_summary.md", "reading-outcome.json")
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
            state["status"] == "SEARCHING" and path_exists(run / "stage-lease.json")
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
    if path_exists(run / "downloads/manifest.json"):
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
    run = None
    try:
        if args.command == "start":
            result = start(args.work_dir, args.request_file, args.auto_delegated)
            run = Path(result["run_dir"])
        else:
            run = canonical_path(args.run_dir)
            require_run(run)
            if args.command == "search":
                feedback = filesystem_path(args.feedback_file).read_text(encoding="utf-8") if args.feedback_file else None
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
                result = refine(run, filesystem_path(args.feedback_file).read_text(encoding="utf-8"))
            elif args.command == "metadata-only":
                result = metadata_only(run, args.decision_source)
            else:
                result = stats(run)
        print(json.dumps(with_task_activation(result, run, download_checkpoint=args.command == DOWNLOAD_COMMAND), ensure_ascii=False))
        return 0
    except ChildProcessCancelled as exc:
        print(json.dumps({"status": "cancelled", "signal": exc.signum}))
        return 128 + exc.signum
    except (OSError, ValueError, KeyError, TypeError) as exc:
        result = {"status": "blocked", "reason": str(exc)}
        if args.command == DOWNLOAD_COMMAND and run is not None:
            try:
                result = with_task_activation(result, run, download_checkpoint=True)
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                pass
        print(json.dumps(result, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
