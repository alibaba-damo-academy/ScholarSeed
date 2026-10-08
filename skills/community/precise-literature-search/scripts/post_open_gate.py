#!/usr/bin/env scholarseed-skill-python
"""Choose the required workflow step after the arXiv-only download batch."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from arxiv import normalize_arxiv_id
from filesystem import canonical_path, filesystem_path
from io_utils import read_json
from run_state import read_state, update_status
from validate_json import ContractError, validate_data

MANAGED_STORAGE = "managed"
PAPER_REF_PREFIX = "paper:"


def require_under_run(run_dir: Path, path: Path, label: str) -> Path:
    """Containment-checked identity in ordinary form; I/O wraps at the boundary."""
    root = canonical_path(run_dir)
    candidate = canonical_path(path)
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


#: Manifest states the paper-dl route may still act on: what serve reported as
#: unsuccessful for a granted paper, plus a paid batch awaiting user intervention.
#: A paper the product did not grant is recorded as `skipped` and is terminal — never a
#: download target, whatever its metadata says about access. `not_attempted` is not
#: produced by this release and stays out of the route so a hand-written manifest cannot
#: smuggle a target in; it can still be resolved or explicitly skipped by recovery.
PAID_PENDING_STATUSES = frozenset({"failed", "action_required"})


def paid_pending(item: Any) -> bool:
    """Whether one manifest entry still needs the paper-dl route.

    Eligibility comes from the manifest — i.e. from what serve actually reported for a
    granted paper — never from metadata, so an ungranted candidate cannot be routed to
    a downloader that ignores the product authorization. Verified entries are
    `downloaded`, which is outside the pending set.
    """
    return isinstance(item, dict) and item.get("status") in PAID_PENDING_STATUSES


def verified_managed_download(item: dict[str, Any]) -> bool:
    """A managed entry is complete when it carries serve's ref and revision.

    The bytes never enter the run directory, so there is nothing local to open: serve
    re-verifies ref and revision against its own object map at the delivery checkpoint,
    and every read goes through its per-ref authorization.
    """
    ref = item.get("ref")
    revision = item.get("revision")
    if not isinstance(ref, str) or not ref.startswith(PAPER_REF_PREFIX):
        return False
    if not isinstance(revision, str) or not revision:
        return False
    # A managed entry with a run-directory copy would defeat the managed store.
    return item.get("file_path") is None


def verified_manifest_download(item: Any, run_dir: Path) -> bool:
    """Verify one manifest entry against the truth of its own storage scope."""
    if not isinstance(item, dict):
        return False
    if item.get("status") != "downloaded" or item.get("verified_exists") is not True:
        return False
    if item.get("storage") == MANAGED_STORAGE:
        return verified_managed_download(item)
    file_value = item.get("file_path")
    if not isinstance(file_value, str) or not file_value:
        return False
    try:
        path = resolve_under_run(run_dir, file_value, "manifest PDF")
        file_path = filesystem_path(path)
        if not file_path.is_file():
            return False
        with file_path.open("rb") as handle:
            return handle.read(5) == b"%PDF-"
    except (OSError, ValueError):
        return False


def choose_next_action(
    selection: dict[str, Any],
    metadata: dict[str, Any],
    manifest: dict[str, Any],
    run_dir: Path,
) -> dict[str, Any]:
    selected = selection["selected_paper_ids"]
    if any(not isinstance(paper_id, str) or not paper_id for paper_id in selected):
        raise ValueError("selected_paper_ids must contain non-empty strings")
    if len(selected) != len(set(selected)):
        raise ValueError("selected_paper_ids must be unique")
    papers_by_id = {
        str(paper.get("id")): paper
        for paper in metadata.get("papers", [])
        if isinstance(paper, dict) and paper.get("id") is not None
    }
    missing = [str(paper_id) for paper_id in selected if str(paper_id) not in papers_by_id]
    if missing:
        raise ValueError(f"selected paper ID(s) are missing from metadata: {', '.join(missing)}")
    manifest_by_id = {
        str(item.get("paper_id")): item
        for item in manifest.get("papers", [])
        if isinstance(item, dict) and item.get("paper_id") is not None
    }
    pending = [
        str(paper_id) for paper_id in selected if paid_pending(manifest_by_id.get(str(paper_id)))
    ]
    if selection.get("download_paid") is True and pending:
        already_confirmed = (
            selection.get("paid_download_confirmation") == "included_in_selection"
            or selection.get("decision_source") == "auto_delegated"
        )
        return {
            "next_action": (
                "start_paid_download" if already_confirmed else "confirm_paid_download"
            ),
            "pending_count": len(pending),
            "pending_paper_ids": pending,
        }
    return {
        "next_action": "prepare_reading",
        "pending_count": 0,
        "pending_paper_ids": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--selection", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    try:
        run_dir = canonical_path(args.run_dir)
        selection_path = require_under_run(run_dir, args.selection, "selection")
        manifest_path = require_under_run(run_dir, args.manifest, "manifest")
        selection = read_json(selection_path)
        manifest = read_json(manifest_path)
        validate_data("selection", selection)
        validate_data("download-manifest", manifest)
        state = read_state(run_dir)
        if state["status"] != "DOWNLOADING_OPEN":
            raise ValueError(
                "post-open gate requires run status DOWNLOADING_OPEN; "
                f"found {state['status']}"
            )
        run_id = state["run_id"]
        if selection.get("run_id") != run_id or manifest.get("run_id") != run_id:
            raise ValueError("selection, manifest, and state run IDs must match")
        metadata_value = selection.get("metadata_path")
        if not isinstance(metadata_value, str) or not metadata_value:
            raise ValueError("selection needs a run-relative metadata_path")
        metadata = read_json(resolve_under_run(run_dir, metadata_value, "metadata_path"))
        validate_data("metadata", metadata)
        if metadata.get("run_id") != run_id:
            raise ValueError("metadata and state run IDs must match")
        if metadata.get("is_placeholder") is not False:
            raise ValueError("post-open gate refuses placeholder metadata")
        result = choose_next_action(selection, metadata, manifest, run_dir)
        if result["next_action"] == "start_paid_download":
            update_status(
                run_dir,
                "DOWNLOADING_PAID",
                f"arXiv batch reported; {result['pending_count']} selected paper(s) already authorized for paper-dl/non-arXiv routing",
                {
                    "selection": selection_path.relative_to(run_dir).as_posix(),
                    "download_manifest": manifest_path.relative_to(run_dir).as_posix(),
                },
            )
        elif result["next_action"] == "confirm_paid_download":
            update_status(
                run_dir,
                "PAID_DOWNLOAD_PENDING",
                f"arXiv batch reported; {result['pending_count']} selected paper(s) await paper-dl/non-arXiv confirmation",
                {
                    "selection": selection_path.relative_to(run_dir).as_posix(),
                    "download_manifest": manifest_path.relative_to(run_dir).as_posix(),
                },
            )
        print(json.dumps(result, ensure_ascii=False))
    except (ContractError, OSError, ValueError) as exc:
        print(f"post-open gate failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
