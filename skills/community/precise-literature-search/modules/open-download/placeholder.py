#!/usr/bin/env scholarseed-skill-python
"""Create explicit placeholder PDFs for selected open-access demo papers."""

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


def resolve_under_run(run_dir: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else run_dir / path


def summarize(papers: list[dict[str, Any]], selected_count: int) -> dict[str, int]:
    return {
        "selected": selected_count,
        "downloaded": sum(item["status"] == "downloaded" for item in papers),
        "action_required": sum(item["status"] == "action_required" for item in papers),
        "failed": sum(item["status"] == "failed" for item in papers),
        "skipped": sum(item["status"] == "skipped" for item in papers),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        selection = read_json(args.input)
        if not isinstance(selection, dict) or selection.get("confirmed_by_user") is not True:
            raise ValueError("selection must be an object with confirmed_by_user=true")
        metadata_value = selection.get("metadata_path")
        selected = selection.get("selected_paper_ids")
        if not isinstance(metadata_value, str) or not isinstance(selected, list):
            raise ValueError("selection needs metadata_path and selected_paper_ids")
        metadata = read_json(resolve_under_run(args.run_dir, metadata_value))
        paper_by_id = {paper.get("id"): paper for paper in metadata.get("papers", []) if isinstance(paper, dict)}
        results: list[dict[str, Any]] = []
        occupied_paths: set[str] = set()
        for paper_id in selected:
            paper = paper_by_id.get(paper_id)
            if paper is None:
                results.append({
                    "paper_id": str(paper_id), "title": "Unknown selected paper", **download_access(paper, "open-download"),
                    "status": "failed", "file_path": None, "content_type": None, "verified_exists": False,
                    "message": "Selected paper ID was not present in metadata.",
                })
                continue
            if not selection.get("download_open"):
                status, message = "skipped", "The arXiv route was not selected by the user."
                file_path = None
            elif paper.get("open_access") != "yes":
                status, message = "skipped", "Paper is not marked open access; leave it for the paid-access phase."
                file_path = None
            else:
                relative = title_pdf_relative_path(
                    str(paper.get("title") or "Untitled"),
                    str(paper_id),
                    occupied_paths,
                )
                absolute = args.run_dir / relative
                write_placeholder_pdf(absolute, str(paper_id), str(paper.get("title", "Untitled")))
                status, message, file_path = "downloaded", "Generated placeholder PDF for workflow testing.", relative.as_posix()
                occupied_paths.add(relative.as_posix())
            results.append({
                "paper_id": str(paper_id), "title": str(paper.get("title", "Untitled")), **download_access(paper, "open-download"),
                "status": status, "file_path": file_path, "content_type": "application/pdf" if file_path else None,
                "verified_exists": bool(file_path and filesystem_path(args.run_dir / file_path).is_file()), "message": message,
            })
        manifest = {
            "schema_version": "1.0", "run_id": selection.get("run_id", args.run_dir.name),
            "generated_at": utc_now(), "is_placeholder": True, "papers": results,
            "summary": summarize(results, len(selected)),
            "warnings": ["Placeholder PDFs are workflow fixtures, not real paper full texts."],
        }
        atomic_write_json(args.output, manifest)
    except (OSError, ValueError) as exc:
        print(f"[PLACEHOLDER] arXiv download failed for {args.input}: {exc}", file=sys.stderr)
        return 2
    print(f"[PLACEHOLDER] open-download manifest written: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
