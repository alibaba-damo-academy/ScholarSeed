#!/usr/bin/env scholarseed-skill-python
"""Create and update resumable literature-search run state."""

from __future__ import annotations

import argparse
import hashlib
import re
import secrets
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from io_utils import atomic_write_json, read_json, utc_now
from validate_json import validate_reading_outcome, validate_report_review, validate_run_state


STATUSES = {
    "INITIALIZED", "INTENT_DRAFTED", "INTENT_CONFIRMED", "SEARCHING",
    "REVIEW_PENDING", "REFINEMENT_REQUESTED", "RESULTS_ACCEPTED",
    "DOWNLOAD_DECISION_PENDING", "DOWNLOADING_OPEN", "PAID_DOWNLOAD_PENDING",
    "PAID_ACTION_REQUIRED", "DOWNLOADING_PAID", "READING",
    "REPORT_REVIEW_PENDING", "FINAL_REPORTING", "COMPLETED", "FAILED",
}


def new_run_id() -> str:
    return f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(3)}"


def initialize_run(work_dir: Path, request: str | None = None) -> Path:
    root = work_dir.resolve() / ".precise-literature-search" / "runs"
    while True:
        run_dir = root / new_run_id()
        try:
            run_dir.mkdir(parents=True, exist_ok=False)
            break
        except FileExistsError:
            continue
    for relative in ("search", "downloads/papers", "downloads/paper-dl-logs"):
        (run_dir / relative).mkdir(parents=True, exist_ok=True)
    if request is not None:
        (run_dir / "request.txt").write_text(request.rstrip() + "\n", encoding="utf-8")
    now = utc_now()
    state = {
        "schema_version": "2.0",
        "run_id": run_dir.name,
        "status": "INITIALIZED",
        "created_at": now,
        "updated_at": now,
        "search_round": 0,
        "paths": {
            "request": "request.txt" if request is not None else None,
            "intent": None,
            "latest_metadata": None,
            "latest_search_report": None,
            "selection": None,
            "download_manifest": None,
            "reading_plan": None,
            "native_results": None,
            "report": None,
            "paper_summary": None,
            "reading_outcome": None,
            "report_review": None,
            "final_report": None,
        },
        "events": [
            {"timestamp": now, "from": None, "to": "INITIALIZED", "message": "Run initialized"}
        ],
        "errors": [],
    }
    atomic_write_json(run_dir / "state.json", state)
    atomic_write_json(run_dir / "workflow.json", {"schema_version": "2.0", "run_id": run_dir.name, "auto_delegated": False})
    return run_dir


def read_state(run_dir: Path) -> dict[str, Any]:
    data = read_json(run_dir / "state.json")
    validate_run_state(data)
    return data


def write_state(run_dir: Path, state: dict[str, Any]) -> None:
    state["updated_at"] = utc_now()
    validate_run_state(state)
    atomic_write_json(run_dir / "state.json", state)


def update_status(
    run_dir: Path,
    status: str,
    message: str,
    paths: dict[str, str | None] | None = None,
) -> dict[str, Any]:
    if status not in STATUSES:
        raise ValueError(f"unknown status: {status}")
    state = read_state(run_dir)
    if status == "FINAL_REPORTING":
        raise ValueError(
            "FINAL_REPORTING may be entered only through report-review --decision complete"
        )
    prospective_paper_summary = (
        paths.get("paper_summary")
        if paths is not None and "paper_summary" in paths
        else state["paths"].get("paper_summary")
    )
    has_full_text_reading = (
        isinstance(prospective_paper_summary, str)
        or any(event.get("to") == "READING" for event in state["events"])
    )
    if status == "COMPLETED" and has_full_text_reading:
        raise ValueError(
            "a full-text run may enter COMPLETED only through stage.py complete"
        )
    previous = state["status"]
    now = utc_now()
    state["status"] = status
    if paths:
        unknown = sorted(set(paths) - set(state["paths"]))
        if unknown:
            raise ValueError(f"unknown state path key(s): {', '.join(unknown)}")
        state["paths"].update(paths)
    state["events"].append(
        {"timestamp": now, "from": previous, "to": status, "message": message}
    )
    write_state(run_dir, state)
    return state


def increment_search_round(run_dir: Path, message: str = "Started search round") -> int:
    state = read_state(run_dir)
    if state["status"] not in {"INTENT_CONFIRMED", "REFINEMENT_REQUESTED"}:
        raise ValueError(
            "a search round may start only after intent confirmation or an explicit refinement request"
        )
    state["search_round"] += 1
    round_number = state["search_round"]
    previous = state["status"]
    state["status"] = "SEARCHING"
    state["events"].append(
        {
            "timestamp": utc_now(),
            "from": previous,
            "to": "SEARCHING",
            "message": f"{message} {round_number}",
        }
    )
    write_state(run_dir, state)
    return round_number


def _resolve_run_path(run_dir: Path, value: str) -> Path:
    root = run_dir.resolve()
    relative = Path(value)
    if relative.is_absolute():
        raise ValueError(f"run artifact path must be relative: {value}")
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"run artifact escapes the run directory: {value}") from exc
    return candidate


def _copy_immutable(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise ValueError(f"run artifact does not exist: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if not destination.is_file() or destination.read_bytes() != source.read_bytes():
            raise ValueError(f"refusing to overwrite archived artifact: {destination}")
        return
    shutil.copy2(source, destination)


def record_report_review(
    run_dir: Path,
    decision: str,
    feedback: str | None = None,
    decision_source: str | None = None,
) -> Path:
    """Finalize a report review or archive the iteration before another search."""
    if decision not in {"complete", "refine"}:
        raise ValueError(f"unknown report review decision: {decision}")
    if decision_source not in {None, "user_explicit", "host_agent"}:
        raise ValueError(f"unknown report review decision source: {decision_source}")
    normalized_feedback = feedback.strip() if isinstance(feedback, str) else None
    if decision == "refine" and not normalized_feedback:
        raise ValueError("--feedback is required when report review requests refinement")

    state = read_state(run_dir)
    if state["status"] != "REPORT_REVIEW_PENDING":
        raise ValueError("report review is allowed only from REPORT_REVIEW_PENDING")
    round_number = state["search_round"]
    if round_number < 1:
        raise ValueError("report review requires at least one completed search round")
    report_value = state["paths"].get("report")
    if not isinstance(report_value, str):
        raise ValueError("REPORT_REVIEW_PENDING requires a report path in state.json")
    report_path = _resolve_run_path(run_dir, report_value)
    if not report_path.is_file():
        raise ValueError(f"report does not exist: {report_value}")
    if not report_path.read_text(encoding="utf-8").strip():
        raise ValueError(f"report is empty: {report_value}")
    paper_summary_value = state["paths"].get("paper_summary")
    if not isinstance(paper_summary_value, str):
        raise ValueError("REPORT_REVIEW_PENDING requires a paper summary path in state.json")
    paper_summary_path = _resolve_run_path(run_dir, paper_summary_value)
    if not paper_summary_path.is_file():
        raise ValueError(f"paper summary does not exist: {paper_summary_value}")
    if not paper_summary_path.read_text(encoding="utf-8").strip():
        raise ValueError(f"paper summary is empty: {paper_summary_value}")

    archive_dir = run_dir / "iterations" / f"round-{round_number:03d}"
    archived: dict[str, str] = {}
    if decision == "refine":
        candidates = {
            "selection": (state["paths"].get("selection"), "selection.json"),
            "download_manifest": (
                state["paths"].get("download_manifest"),
                "download-manifest.json",
            ),
            "report": (report_value, "report.md"),
        }
        candidates["paper_summary"] = (paper_summary_value, "paper_summary.md")
        paid_action = run_dir / "paid-action.json"
        if paid_action.is_file():
            candidates["paid_action"] = ("paid-action.json", "paid-action.json")
        optional_reader_artifacts = {
            "reading_outcome": (state["paths"].get("reading_outcome"), "reading-outcome.json"),
            "reading_plan": (state["paths"].get("reading_plan"), "reading-plan.json"),
            "native_results": (state["paths"].get("native_results"), "native-results.json"),
        }
        for key, candidate in optional_reader_artifacts.items():
            if isinstance(candidate[0], str):
                candidates[key] = candidate
        for key, (source_value, archive_name) in candidates.items():
            if not isinstance(source_value, str):
                raise ValueError(f"cannot archive report iteration without state path: {key}")
            source = _resolve_run_path(run_dir, source_value)
            destination = archive_dir / archive_name
            _copy_immutable(source, destination)
            archived[key] = destination.relative_to(run_dir).as_posix()

    review_path = archive_dir / "review.json"
    review = {
        "schema_version": "1.1",
        "run_id": state["run_id"],
        "search_round": round_number,
        "decision": decision,
        "feedback": normalized_feedback,
        "report_path": report_value,
        "reviewed_at": utc_now(),
        "archived_artifacts": archived,
    }
    if decision_source is not None:
        review["decision_source"] = decision_source
    if review_path.exists():
        existing = read_json(review_path)
        validate_report_review(existing)
        comparable = {key: value for key, value in review.items() if key != "reviewed_at"}
        existing_comparable = {
            key: value for key, value in existing.items() if key != "reviewed_at"
        } if isinstance(existing, dict) else None
        if comparable != existing_comparable:
            raise ValueError(f"refusing to overwrite report review: {review_path}")
        review = existing
    else:
        validate_report_review(review)
        atomic_write_json(review_path, review)

    previous = state["status"]
    next_status = "FINAL_REPORTING" if decision == "complete" else "REFINEMENT_REQUESTED"
    if decision == "complete":
        state["schema_version"] = "2.0"
    state["status"] = next_status
    state["paths"]["report_review"] = review_path.relative_to(run_dir).as_posix()
    if decision == "refine":
        state["paths"].update({
            "selection": None,
            "download_manifest": None,
            "reading_plan": None,
            "native_results": None,
            "report": None,
            "paper_summary": None,
            "reading_outcome": None,
        })
    state["events"].append({
        "timestamp": utc_now(),
        "from": previous,
        "to": next_status,
        "message": (
            "Report review completed; final cited report requested"
            if decision == "complete"
            else f"Post-report refinement requested; archived round {round_number} artifacts"
        ) + (f"; decision source: {decision_source}" if decision_source else ""),
    })
    write_state(run_dir, state)
    return review_path


def _no_readable_fulltext(run_dir: Path, state: dict[str, Any]) -> bool:
    """Allow evidence-free completion only with complete, manifest-bound outcomes.

    Missing outcomes in current or archived reading rounds are unknown,
    not proof of zero readable papers; their ordinary citation gate stays intact.
    """
    rounds = [(state["search_round"], state["paths"])]
    for review_path in sorted((run_dir / "iterations").glob("round-*/review.json")):
        review = read_json(review_path)
        validate_report_review(review)
        if review.get("run_id") != state["run_id"]:
            raise ValueError("archived review belongs to another run")
        if review["decision"] == "refine":
            rounds.append((review["search_round"], review["archived_artifacts"]))
    for round_number, paths in rounds:
        outcome_value = paths.get("reading_outcome")
        manifest_value = paths.get("download_manifest")
        if not isinstance(outcome_value, str) or not isinstance(manifest_value, str):
            return False
        outcome = read_json(_resolve_run_path(run_dir, outcome_value))
        validate_reading_outcome(outcome)
        manifest_path = _resolve_run_path(run_dir, manifest_value)
        manifest = read_json(manifest_path)
        if (outcome.get("schema_version") != "1.0" or outcome.get("run_id") != state["run_id"]
                or outcome.get("search_round") != round_number
                or outcome.get("manifest_sha256") != hashlib.sha256(manifest_path.read_bytes()).hexdigest()):
            raise ValueError("reading outcome must match the run, round and download manifest SHA-256")
        papers = outcome.get("papers")
        if not isinstance(manifest, dict) or not isinstance(manifest.get("papers"), list):
            raise ValueError("reading outcome and manifest require paper arrays")
        if any(not isinstance(p, dict) or not isinstance(p.get("paper_id"), str)
               or (p.get("file_path") is not None and not isinstance(p["file_path"], str))
               for p in manifest["papers"]):
            raise ValueError("invalid download manifest paper identity")
        expected = {(p["paper_id"], p.get("file_path")) for p in manifest["papers"]
                    if p.get("status") == "downloaded"}
        seen = set()
        has_readable = False
        for paper in papers:
            key = (paper.get("paper_id"), paper.get("file_path"))
            if key in seen or key not in expected or paper.get("status") not in {"readable", "unreadable"}:
                raise ValueError("reading outcomes must uniquely cover downloaded manifest entries")
            seen.add(key)
            has_readable |= paper["status"] == "readable"
            if paper["status"] == "unreadable" and not str(paper.get("reason") or "").strip():
                raise ValueError("unreadable paper requires an exclusion reason")
        if seen != expected:
            raise ValueError("reading outcome omits downloaded papers")
        if has_readable:
            return False
    return True


def complete_final_report(run_dir: Path, report: str = "final_report.md", *, _stage_authorized=False) -> Path:
    """Validate the cited answer report and make a reviewed run terminal."""
    if not _stage_authorized:
        raise ValueError("reports must complete through stage.py with their stage token")
    if Path(report).as_posix() != "final_report.md":
        raise ValueError("final report path must be exactly final_report.md")
    state = read_state(run_dir)
    recovering_final_report = (
        state["status"] == "FAILED"
        and bool(state["errors"])
        and state["errors"][-1].get("step") == "final-report"
    )
    if state["status"] != "FINAL_REPORTING" and not recovering_final_report:
        raise ValueError(
            "final report completion is allowed only from FINAL_REPORTING or a final-report failure"
        )
    review_value = state["paths"].get("report_review")
    if not isinstance(review_value, str):
        raise ValueError("FINAL_REPORTING requires a report review path in state.json")
    review = read_json(_resolve_run_path(run_dir, review_value))
    validate_report_review(review)
    if review.get("decision") != "complete":
        raise ValueError("final report requires an explicit complete review decision")

    report_path = _resolve_run_path(run_dir, report)
    if not report_path.is_file():
        raise ValueError(f"final report does not exist: {report}")
    contents = report_path.read_text(encoding="utf-8").strip()
    if not contents:
        raise ValueError(f"final report is empty: {report}")
    reference_headings = list(re.finditer(
        r"^##\s+(?:References|参考资料)\s*$",
        contents,
        re.MULTILINE,
    ))
    if len(reference_headings) != 1:
        raise ValueError("final report must end with exactly one ## References or ## 参考资料 section")
    reference_heading = reference_headings[0]
    body = contents[:reference_heading.start()]
    references = contents[reference_heading.end():]
    abstract_alert_headings = list(re.finditer(
        r"^##\s+(?:高度相关但未获得全文的文献（摘要级提醒）|"
        r"Highly relevant papers without full text \(abstract-level alerts\))\s*$",
        body,
        re.MULTILINE,
    ))
    if len(abstract_alert_headings) > 1:
        raise ValueError("final report may contain at most one abstract-alert section")

    full_text_body = body
    if abstract_alert_headings:
        abstract_heading = abstract_alert_headings[0]
        full_text_body = body[:abstract_heading.start()]
        abstract_alerts = body[abstract_heading.end():]
        if re.search(r"^##\s+", abstract_alerts, re.MULTILINE):
            raise ValueError(
                "the abstract-alert section must appear immediately before final references"
            )
        abstract_entry_numbers: list[str] = []
        for line in abstract_alerts.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            match = re.fullmatch(r"\[A(\d+)\]\s+\S.*", stripped)
            if match is None:
                raise ValueError(
                    "the abstract-alert section may contain only single-line [A#] entries"
                )
            chinese_label = (
                re.search(r"证据级别\s*[:：]\s*摘要", stripped) is not None
                and "未阅读全文" in stripped
            )
            english_label = (
                re.search(r"Evidence level\s*:\s*abstract", stripped, re.IGNORECASE)
                is not None
                and re.search(
                    r"full text (?:was )?not read", stripped, re.IGNORECASE
                )
                is not None
            )
            if not chinese_label and not english_label:
                raise ValueError(
                    "every abstract-alert entry must state abstract evidence and that full text was not read"
                )
            abstract_entry_numbers.append(match.group(1))
        if not abstract_entry_numbers:
            raise ValueError("abstract-alert section must contain [A#] entries")
        if len(abstract_entry_numbers) != len(set(abstract_entry_numbers)):
            raise ValueError("abstract-alert entry numbers must be unique")
        abstract_citation_numbers = set(re.findall(r"\[A(\d+)\]", full_text_body))
        if abstract_citation_numbers != set(abstract_entry_numbers):
            raise ValueError(
                "every inline abstract alert must map to exactly one [A#] entry"
            )
        if re.search(r"\[(\d+(?:\s*,\s*\d+)*)\]", abstract_alerts):
            raise ValueError(
                "abstract-alert entries must not use numbered full-text citations"
            )
    elif re.search(r"\[A\d+\]", body):
        raise ValueError("inline abstract alerts require a dedicated abstract-alert section")

    no_fulltext = _no_readable_fulltext(run_dir, state)
    citation_groups = re.findall(r"\[(\d+(?:\s*,\s*\d+)*)\]", full_text_body)
    if no_fulltext:
        if not re.search(r"^##\s+(?:No readable full text|无可读全文证据)\s*$", full_text_body, re.MULTILINE):
            raise ValueError("no-fulltext report requires an explicit No readable full text limitation section")
        if citation_groups or references.strip():
            raise ValueError("no-fulltext report must not contain numbered full-text citations or references")
    elif not citation_groups:
        raise ValueError("final report must contain numbered inline citations such as [1]")
    reference_numbers: list[str] = []
    for line in references.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = re.fullmatch(r"(?:[-*]\s*)?\[(\d+)\]\s+\S.*", stripped)
        if match is None:
            raise ValueError(
                "the final reference section may contain only numbered reference entries"
            )
        reference_numbers.append(match.group(1))
    if not reference_numbers and not no_fulltext:
        raise ValueError("final report reference section must contain numbered entries")
    cited_numbers = {
        number.strip()
        for group in citation_groups
        for number in group.split(",")
    }
    if len(reference_numbers) != len(set(reference_numbers)):
        raise ValueError("final report reference numbers must be unique")
    if cited_numbers != set(reference_numbers):
        raise ValueError("every inline citation must map to exactly one numbered reference")

    previous = state["status"]
    state["schema_version"] = "2.0"
    state["status"] = "COMPLETED"
    state["completion_outcome"] = "no_readable_fulltext" if no_fulltext else "full_text"
    state["paths"]["final_report"] = report_path.relative_to(run_dir.resolve()).as_posix()
    state["events"].append({
        "timestamp": utc_now(),
        "from": previous,
        "to": "COMPLETED",
        "message": ("No readable full text; limitations report finalized without full-text claims"
                    if no_fulltext else "Final cited answer report generated; run finalized"),
    })
    write_state(run_dir, state)
    return report_path


def append_event(run_dir: Path, message: str) -> dict[str, Any]:
    state = read_state(run_dir)
    state["events"].append(
        {"timestamp": utc_now(), "from": state["status"], "to": state["status"], "message": message}
    )
    write_state(run_dir, state)
    return state


def record_error(run_dir: Path, step: str, message: str) -> dict[str, Any]:
    state = read_state(run_dir)
    previous = state["status"]
    now = utc_now()
    state["status"] = "FAILED"
    state["errors"].append({"timestamp": now, "step": step, "message": message})
    state["events"].append(
        {"timestamp": now, "from": previous, "to": "FAILED", "message": f"{step}: {message}"}
    )
    write_state(run_dir, state)
    return state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    init = subparsers.add_parser("init")
    init.add_argument("--work-dir", type=Path, default=Path.cwd())
    init.add_argument("--request")
    status = subparsers.add_parser("set")
    status.add_argument("--run-dir", type=Path, required=True)
    status.add_argument("--status", choices=sorted(STATUSES), required=True)
    status.add_argument("--message", required=True)
    status.add_argument("--path", action="append", default=[], metavar="KEY=VALUE")
    round_parser = subparsers.add_parser("round")
    round_parser.add_argument("--run-dir", type=Path, required=True)
    review = subparsers.add_parser("report-review")
    review.add_argument("--run-dir", type=Path, required=True)
    review.add_argument("--decision", choices=("complete", "refine"), required=True)
    review.add_argument("--feedback")
    review.add_argument("--decision-source", choices=("user_explicit", "host_agent"))
    fail = subparsers.add_parser("fail")
    fail.add_argument("--run-dir", type=Path, required=True)
    fail.add_argument("--step", required=True)
    fail.add_argument("--message", required=True)
    args = parser.parse_args()
    try:
        if args.command == "init":
            print(initialize_run(args.work_dir, args.request))
        elif args.command == "set":
            path_updates: dict[str, str | None] = {}
            for item in args.path:
                if "=" not in item:
                    raise ValueError(f"--path must be KEY=VALUE, got: {item}")
                key, value = item.split("=", 1)
                path_updates[key] = value or None
            update_status(args.run_dir, args.status, args.message, path_updates)
            print(args.run_dir / "state.json")
        elif args.command == "round":
            print(increment_search_round(args.run_dir))
        elif args.command == "report-review":
            print(record_report_review(
                args.run_dir,
                args.decision,
                args.feedback,
                args.decision_source,
            ))
        else:
            record_error(args.run_dir, args.step, args.message)
            print(args.run_dir / "state.json")
    except (OSError, ValueError) as exc:
        print(f"state operation failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
