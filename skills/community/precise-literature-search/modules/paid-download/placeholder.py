#!/usr/bin/env scholarseed-skill-python
"""Simulate the paper-dl action-required and explicit-resume protocol."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

SKILL_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

from download_access import download_access
from filesystem import filesystem_path
from io_utils import (  # noqa: E402
    atomic_write_json,
    read_json,
    title_pdf_relative_path,
    utc_now,
    write_placeholder_pdf,
)
from adapter import paper_needs_paid_download  # noqa: E402


def resolve_under_run(run_dir: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else run_dir / path


def summary(items: list[dict[str, Any]], selected_count: int) -> dict[str, int]:
    return {
        "selected": selected_count,
        "downloaded": sum(item["status"] == "downloaded" for item in items),
        "action_required": sum(item["status"] == "action_required" for item in items),
        "failed": sum(item["status"] == "failed" for item in items),
        "skipped": sum(item["status"] == "skipped" for item in items),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    try:
        selection = read_json(args.input)
        if not isinstance(selection, dict) or selection.get("confirmed_by_user") is not True:
            raise ValueError("paper-dl/non-arXiv download requires a user-confirmed selection")
        if args.resume and not selection.get("download_paid"):
            raise ValueError("resume refused because download_paid is not enabled in the selection")
        metadata_path = selection.get("metadata_path")
        selected = selection.get("selected_paper_ids")
        if not isinstance(metadata_path, str) or not isinstance(selected, list):
            raise ValueError("selection needs metadata_path and selected_paper_ids")
        metadata = read_json(resolve_under_run(args.run_dir, metadata_path))
        paper_by_id = {paper.get("id"): paper for paper in metadata.get("papers", []) if isinstance(paper, dict)}
        existing: dict[str, dict[str, Any]] = {}
        previous_output = filesystem_path(args.output)
        if previous_output.is_file() and previous_output.stat().st_size:
            previous = read_json(args.output)
            existing = {item.get("paper_id"): item for item in previous.get("papers", []) if isinstance(item, dict)}
        occupied_paths = {
            str(item.get("file_path"))
            for item in existing.values()
            if item.get("status") == "downloaded" and item.get("file_path")
        }
        candidates = [paper_by_id.get(paper_id) for paper_id in selected]
        candidates = [paper for paper in candidates if paper and paper_needs_paid_download(paper)]
        for paper in candidates:
            paper_id = str(paper["id"])
            if not selection.get("download_paid"):
                item = {
                    "paper_id": paper_id, "title": str(paper.get("title", "Untitled")), **download_access(paper, "paid-download"),
                    "status": "skipped", "file_path": None, "content_type": None, "verified_exists": False,
                    "message": "The authorized paper-dl flow was not selected by the user.",
                }
            elif not args.resume:
                item = {
                    "paper_id": paper_id, "title": str(paper.get("title", "Untitled")), **download_access(paper, "paid-download"),
                    "status": "action_required", "file_path": None, "content_type": None, "verified_exists": False,
                    "message": "Awaiting explicit user confirmation after simulated authorized login or human verification.",
                }
            else:
                relative = title_pdf_relative_path(
                    str(paper.get("title") or "Untitled"),
                    paper_id,
                    occupied_paths,
                )
                absolute = args.run_dir / relative
                write_placeholder_pdf(absolute, paper_id, str(paper.get("title", "Untitled")))
                occupied_paths.add(relative.as_posix())
                item = {
                    "paper_id": paper_id, "title": str(paper.get("title", "Untitled")), **download_access(paper, "paid-download"),
                    "status": "downloaded", "file_path": relative.as_posix(), "content_type": "application/pdf",
                    "verified_exists": filesystem_path(absolute).is_file(),
                    "message": "Generated simulated paid-access placeholder PDF after explicit resume.",
                }
            existing[paper_id] = item
        items = [existing[key] for key in sorted(existing)]
        needs_action = bool(candidates and selection.get("download_paid") and not args.resume)
        manifest: dict[str, Any] = {
            "schema_version": "1.0", "run_id": selection.get("run_id", args.run_dir.name),
            "generated_at": utc_now(), "is_placeholder": True,
            "status": "action_required" if needs_action else "completed",
            "papers": items, "summary": summary(items, len(selected)),
            "warnings": ["Paid access is simulated; no browser, publisher, account, or real credential was used."],
        }
        if needs_action:
            manifest.update({
                "action_type": "login_or_human_verification",
                "message": "Open the publisher browser session, log in with your authorized account, complete any human verification, then return and explicitly confirm that the session is ready.",
                "resume_token": "placeholder-user-confirmation",
            })
        atomic_write_json(args.output, manifest)
    except (OSError, ValueError) as exc:
        print(f"[PLACEHOLDER] paper-dl/non-arXiv download failed for {args.input}: {exc}", file=sys.stderr)
        return 2
    if needs_action:
        print("[ACTION REQUIRED] Explicit user confirmation is required before --resume.")
    else:
        print(f"[PLACEHOLDER] paid-download manifest written: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
