#!/usr/bin/env scholarseed-skill-python
"""Route an open-download selection without making any network request."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from download_access import download_access
from io_utils import atomic_write_json, read_json, utc_now
from run_state import read_state
from validate_json import ContractError, validate_data


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


def normalize_arxiv_id(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip()
    lowered = normalized.casefold()
    if lowered.startswith("arxiv:"):
        normalized = normalized.split(":", 1)[1].strip()
    else:
        for prefix in (
            "https://arxiv.org/abs/", "http://arxiv.org/abs/",
            "https://arxiv.org/pdf/", "http://arxiv.org/pdf/",
        ):
            if lowered.startswith(prefix):
                normalized = normalized[len(prefix):]
                break
    if normalized.casefold().endswith(".pdf"):
        normalized = normalized[:-4]
    if not normalized or len(normalized) > 120 or any(char.isspace() for char in normalized):
        return None
    return normalized


def paper_arxiv_id(paper: dict[str, Any]) -> str | None:
    for key in ("arxiv_id", "arxivId"):
        normalized = normalize_arxiv_id(paper.get(key))
        if normalized:
            return normalized
    external = paper.get("external_ids") or paper.get("externalIds")
    if isinstance(external, dict):
        for key, value in external.items():
            if str(key).casefold() in {"arxiv", "arxiv_id", "arxivid"}:
                normalized = normalize_arxiv_id(value)
                if normalized:
                    return normalized
    return None


def route_selection(
    selection: dict[str, Any],
    metadata: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    selected = selection.get("selected_paper_ids", [])
    papers_by_id = {
        str(paper.get("id")): paper
        for paper in metadata.get("papers", [])
        if isinstance(paper, dict) and paper.get("id") is not None
    }
    missing = [str(paper_id) for paper_id in selected if str(paper_id) not in papers_by_id]
    if missing:
        raise ValueError(f"selected paper ID(s) are missing from metadata: {', '.join(missing)}")
    arxiv_ids = [
        str(paper_id)
        for paper_id in selected
        if selection.get("download_open") is True
        and paper_arxiv_id(papers_by_id[str(paper_id)]) is not None
    ]
    if arxiv_ids:
        return ({
            "next_action": "run_open_download",
            "selected_count": len(selected),
            "arxiv_candidate_count": len(arxiv_ids),
            "arxiv_candidate_ids": arxiv_ids,
            "manifest_written": False,
        }, None)

    items = []
    for paper_id in selected:
        paper = papers_by_id[str(paper_id)]
        if selection.get("download_open") is True:
            message = (
                "The arXiv route handles only arXiv-backed papers; this non-arXiv record "
                "was not downloaded."
            )
        else:
            message = "The arXiv route was not selected by the user."
        items.append({
            "paper_id": str(paper_id),
            "title": str(paper.get("title") or "Untitled"),
            **download_access(paper, "open-download"),
            "status": "skipped",
            "file_path": None,
            "content_type": None,
            "verified_exists": False,
            "message": message,
        })
    manifest = {
        "schema_version": "1.0",
        "run_id": selection["run_id"],
        "generated_at": utc_now(),
        "is_placeholder": False,
        "papers": items,
        "summary": {
            "selected": len(selected),
            "downloaded": 0,
            "action_required": 0,
            "failed": 0,
            "skipped": len(selected),
        },
        "warnings": [
            "The local preflight found no selected arXiv-backed candidates; "
            "the networked open-download adapter was not started."
        ],
    }
    return ({
        "next_action": "post_open_gate",
        "selected_count": len(selected),
        "arxiv_candidate_count": 0,
        "arxiv_candidate_ids": [],
        "manifest_written": True,
    }, manifest)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--selection", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    try:
        run_dir = args.run_dir.resolve()
        selection_path = require_under_run(run_dir, args.selection, "selection")
        manifest_path = require_under_run(run_dir, args.manifest, "manifest")
        selection = read_json(selection_path)
        validate_data("selection", selection)
        state = read_state(run_dir)
        if state["status"] != "DOWNLOADING_OPEN":
            raise ValueError(
                "open-download preflight requires run status DOWNLOADING_OPEN; "
                f"found {state['status']}"
            )
        if selection.get("run_id") != state["run_id"]:
            raise ValueError("selection and state run IDs must match")
        metadata_value = selection.get("metadata_path")
        if not isinstance(metadata_value, str) or not metadata_value:
            raise ValueError("selection needs a run-relative metadata_path")
        metadata = read_json(resolve_under_run(run_dir, metadata_value, "metadata_path"))
        validate_data("metadata", metadata)
        if metadata.get("run_id") != state["run_id"]:
            raise ValueError("metadata and state run IDs must match")
        if metadata.get("is_placeholder") is not False:
            raise ValueError("open-download preflight refuses placeholder metadata")
        result, manifest = route_selection(selection, metadata)
        if manifest is not None:
            validate_data("download-manifest", manifest)
            atomic_write_json(manifest_path, manifest)
        print(json.dumps(result, ensure_ascii=False))
    except (ContractError, OSError, ValueError) as exc:
        print(f"open-download preflight failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
