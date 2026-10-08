#!/usr/bin/env scholarseed-skill-python
"""Plan and verify deterministic recovery choices for unsuccessful downloads."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

from io_utils import atomic_write_json, read_json, title_pdf_relative_path, utc_now
from filesystem import filesystem_path
from validate_json import ContractError, validate_data
from browser_pool import abandon, cancellation_signals, run_lock
from process_control import ChildProcessCancelled


#: States a recovery may still act on. `skipped` is deliberately absent: it is the
#: terminal record of a paper the product did not grant (or cannot identify), so offering
#: it for manual download or retry would hand the paid route an unauthorized target.
UNSUCCESSFUL = {"action_required", "failed", "not_attempted"}


def require_under_run(run_dir: Path, path: Path, label: str) -> Path:
    root = run_dir.resolve()
    candidate = path.resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"{label} must stay inside the run directory: {candidate}") from exc
    return candidate


def resolve_under_run(run_dir: Path, value: str, label: str) -> Path:
    relative = Path(value)
    if relative.is_absolute():
        raise ValueError(f"{label} must be run-relative: {value}")
    return require_under_run(run_dir, run_dir / relative, label)


def paper_url(paper: dict[str, Any]) -> str | None:
    value = paper.get("url")
    if isinstance(value, str):
        parsed = urlparse(value.strip())
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return parsed._replace(query="", fragment="").geturl()
    doi = paper.get("doi")
    if isinstance(doi, str) and doi.strip():
        normalized = doi.strip()
        parsed = urlparse(normalized)
        if parsed.hostname in {"doi.org", "dx.doi.org"}:
            normalized = parsed.path.lstrip("/")
        if normalized.casefold().startswith("doi:"):
            normalized = normalized.split(":", 1)[1].strip()
        if normalized and not any(char.isspace() for char in normalized):
            return f"https://doi.org/{quote(normalized, safe='/():;._-')}"
    arxiv_id = paper.get("arxiv_id") or paper.get("arxivId")
    if isinstance(arxiv_id, str) and arxiv_id.strip():
        normalized = arxiv_id.strip().removeprefix("arXiv:").removeprefix("arxiv:")
        return f"https://arxiv.org/abs/{quote(normalized, safe='/._-')}"
    return None


def summarize(items: list[dict[str, Any]], selected: int) -> dict[str, int]:
    return {
        "selected": selected,
        "downloaded": sum(item.get("status") == "downloaded" for item in items),
        "action_required": sum(item.get("status") == "action_required" for item in items),
        "failed": sum(item.get("status") == "failed" for item in items),
        "skipped": sum(item.get("status") == "skipped" for item in items),
    }


def build_plan(
    run_dir: Path,
    selection: dict[str, Any],
    metadata: dict[str, Any],
    manifest: dict[str, Any],
    manifest_relative: str,
) -> dict[str, Any]:
    papers_by_id = {
        str(paper.get("id")): paper
        for paper in metadata.get("papers", [])
        if isinstance(paper, dict) and paper.get("id") is not None
    }
    occupied = {
        str(item.get("file_path"))
        for item in manifest.get("papers", [])
        if isinstance(item, dict) and isinstance(item.get("file_path"), str)
    }
    manual: list[dict[str, str]] = []
    retry_ids: list[str] = []
    missing_urls: list[str] = []
    for item in manifest.get("papers", []):
        if not isinstance(item, dict) or item.get("status") not in UNSUCCESSFUL:
            continue
        paper_id = str(item.get("paper_id") or "")
        if not paper_id:
            continue
        retry_ids.append(paper_id)
        paper = papers_by_id.get(paper_id, {})
        url = paper_url(paper)
        if not url:
            missing_urls.append(paper_id)
            continue
        target = title_pdf_relative_path(
            str(item.get("title") or paper.get("title") or "Untitled"),
            paper_id,
            occupied,
        ).as_posix()
        occupied.add(target)
        manual.append({
            "paper_id": paper_id,
            "title": str(item.get("title") or paper.get("title") or "Untitled"),
            "url": url,
            "target_file": target,
        })
    return {
        "schema_version": "1.0",
        "run_id": selection["run_id"],
        "generated_at": utc_now(),
        "manifest_path": manifest_relative,
        "options": {
            "manual_download": {
                "papers": manual,
                "instructions": (
                    "Open each URL in the dedicated workflow browser, save the PDF to its "
                    "exact target_file, then tell the host the manual downloads are ready."
                ),
                "verification": (
                    "Run download_recovery.py verify-manual with this recovery file; valid "
                    "PDFs are added to the manifest and missing/invalid files remain unsuccessful."
                ),
            },
            "retry_paper_dl": {
                "paper_ids": retry_ids,
                "instructions": (
                    "Resume the same paper-dl/non-arXiv selection (internal: paid-download). The adapter preserves verified "
                    "successes and sends only unsuccessful papers to paper-dl."
                ),
            },
            "skip_and_read": {
                "available": True,
                "instructions": "Run download_recovery.py skip-and-read with this run and manifest to release its browser, then read verified files only.",
            },
        },
        "warnings": (
            [f"No safe article URL was available for: {', '.join(missing_urls)}"]
            if missing_urls else []
        ),
    }


def is_pdf(path: Path) -> bool:
    try:
        path = filesystem_path(path)
        return path.is_file() and path.read_bytes()[:5] == b"%PDF-"
    except (OSError, ValueError):
        return False


def verify_manual(
    run_dir: Path,
    recovery: dict[str, Any],
    manifest: dict[str, Any],
) -> dict[str, Any]:
    manual = recovery.get("options", {}).get("manual_download", {}).get("papers", [])
    targets = {
        str(item.get("paper_id")): str(item.get("target_file"))
        for item in manual
        if isinstance(item, dict) and item.get("paper_id") and item.get("target_file")
    }
    verified: list[str] = []
    invalid_or_missing: list[str] = []
    for item in manifest.get("papers", []):
        if not isinstance(item, dict):
            continue
        paper_id = str(item.get("paper_id") or "")
        target = targets.get(paper_id)
        if not target:
            continue
        path = resolve_under_run(run_dir, target, "manual PDF target")
        if not is_pdf(path):
            invalid_or_missing.append(paper_id)
            continue
        item.update({
            "status": "downloaded",
            "file_path": target,
            "content_type": "application/pdf",
            "verified_exists": True,
            "message": "Manually downloaded PDF verified and added to the run manifest.",
        })
        item.pop("action_reason", None)
        verified.append(paper_id)
    manifest["generated_at"] = utc_now()
    manifest["summary"] = summarize(
        manifest.get("papers", []),
        int(manifest.get("summary", {}).get("selected", len(manifest.get("papers", [])))),
    )
    manifest["status"] = (
        "action_required"
        if any(item.get("status") == "action_required" for item in manifest.get("papers", []))
        else "completed"
    )
    if verified:
        manifest.setdefault("warnings", []).append(
            f"Verified {len(verified)} manually supplied PDF(s) and added them to the manifest."
        )
    validate_data("download-manifest", manifest)
    return {
        "verified_paper_ids": verified,
        "invalid_or_missing_paper_ids": invalid_or_missing,
        "remaining_unsuccessful_paper_ids": [
            str(item.get("paper_id"))
            for item in manifest.get("papers", [])
            if isinstance(item, dict) and item.get("status") in UNSUCCESSFUL
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    plan = subparsers.add_parser("plan")
    plan.add_argument("--run-dir", required=True, type=Path)
    plan.add_argument("--selection", required=True, type=Path)
    plan.add_argument("--manifest", required=True, type=Path)
    plan.add_argument("--output", required=True, type=Path)
    verify = subparsers.add_parser("verify-manual")
    verify.add_argument("--run-dir", required=True, type=Path)
    verify.add_argument("--recovery", required=True, type=Path)
    skip = subparsers.add_parser("skip-and-read")
    skip.add_argument("--run-dir", required=True, type=Path)
    skip.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    try:
        run_dir = args.run_dir.resolve()
        if args.command == "plan":
            selection_path = require_under_run(run_dir, args.selection, "selection")
            manifest_path = require_under_run(run_dir, args.manifest, "manifest")
            output_path = require_under_run(run_dir, args.output, "recovery output")
            selection = read_json(selection_path)
            manifest = read_json(manifest_path)
            validate_data("selection", selection)
            validate_data("download-manifest", manifest)
            if selection.get("run_id") != manifest.get("run_id"):
                raise ValueError("selection and manifest run IDs must match")
            metadata_value = selection.get("metadata_path")
            if not isinstance(metadata_value, str) or not metadata_value:
                raise ValueError("selection needs a run-relative metadata_path")
            metadata = read_json(resolve_under_run(run_dir, metadata_value, "metadata_path"))
            validate_data("metadata", metadata)
            if metadata.get("run_id") != selection.get("run_id"):
                raise ValueError("selection and metadata run IDs must match")
            recovery = build_plan(
                run_dir, selection, metadata, manifest,
                manifest_path.relative_to(run_dir).as_posix(),
            )
            atomic_write_json(output_path, recovery)
            print(json.dumps(recovery, ensure_ascii=False))
            return 0

        with cancellation_signals(), run_lock(run_dir):
            if args.command == "skip-and-read":
                return skip_remaining(run_dir, args.manifest)
            return finish_manual(run_dir, args.recovery)
    except (ContractError, OSError, ValueError, ChildProcessCancelled) as exc:
        print(f"download recovery failed: {exc}", file=sys.stderr)
        return 2
    return 0


def skip_remaining(run_dir, manifest_arg):
    manifest_path = require_under_run(run_dir, manifest_arg, "manifest")
    manifest = read_json(manifest_path)
    validate_data("download-manifest", manifest)
    if manifest.get("run_id") != run_dir.name:
        raise ValueError("manifest and run directory IDs must match")
    result = abandon(run_dir)
    for item in manifest["papers"]:
        if item.get("status") in UNSUCCESSFUL:
            item.update(status="skipped", message="User chose to skip the remaining downloads.")
            item.pop("action_reason", None)
    manifest["status"] = "completed"
    manifest["generated_at"] = utc_now()
    manifest["summary"] = summarize(manifest["papers"], manifest["summary"]["selected"])
    for key in ("action", "action_type", "resume_token"):
        manifest.pop(key, None)
    manifest["completion_notice"] = {
        "type": "paid_download_finished", "browser_pool_released": True,
        "safe_to_close_cdp_browser": False,
        "message": "Remaining downloads skipped; browser cleanup completed.",
    }
    validate_data("download-manifest", manifest)
    atomic_write_json(manifest_path, manifest)
    print(json.dumps(result, ensure_ascii=False))
    return 0


def finish_manual(run_dir, recovery_arg):
    recovery_path = require_under_run(run_dir, recovery_arg, "recovery")
    recovery = read_json(recovery_path)
    if recovery.get("run_id") != run_dir.name:
        raise ValueError("recovery and run directory IDs must match")
    manifest_value = recovery.get("manifest_path")
    if not isinstance(manifest_value, str) or not manifest_value:
        raise ValueError("recovery needs a run-relative manifest_path")
    manifest_path = resolve_under_run(run_dir, manifest_value, "manifest_path")
    manifest = read_json(manifest_path)
    validate_data("download-manifest", manifest)
    if manifest.get("run_id") != recovery.get("run_id"):
        raise ValueError("recovery and manifest run IDs must match")
    result = verify_manual(run_dir, recovery, manifest)
    atomic_write_json(manifest_path, manifest)
    if not any(item.get("status") == "action_required" for item in manifest.get("papers", [])):
        result.update(abandon(run_dir))
        for key in ("action", "action_type", "resume_token"):
            manifest.pop(key, None)
        manifest["completion_notice"] = {
            "type": "paid_download_finished",
            "message": "Browser pool cleanup completed; no browser action is needed.",
            "browser_pool_released": True,
            "safe_to_close_cdp_browser": False,
        }
        atomic_write_json(manifest_path, manifest)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
