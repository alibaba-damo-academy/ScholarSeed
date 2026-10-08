#!/usr/bin/env scholarseed-skill-python
"""Shape the product's acquisition record into the download manifest.

serve fetches, verifies and holds every authorized full text (proposal 116 G1); this
module only turns the host-relayed `literature acquire` response into manifest entries.
It opens no network connection, holds no credential, and writes no PDF bytes.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any


SKILL_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

from acquire_result import (  # noqa: E402
    AcquireResultError,
    acquired_by_id,
    failures_by_id,
    load_acquire_result,
    require_within_selection,
)
from download_access import download_access  # noqa: E402
from io_utils import atomic_write_json, read_json, utc_now  # noqa: E402
from post_open_gate import paper_arxiv_id  # noqa: E402
from progress import update_progress  # noqa: E402


MANAGED_STORAGE = "managed"
PDF_CONTENT_TYPE = "application/pdf"
NOT_ACQUIRED_MESSAGE = (
    "The product did not acquire this paper: it is outside the granted subset, or it has "
    "no arXiv/DOI identifier serve can fetch. This is terminal — it is never routed to a "
    "downloader and no full text is claimed for it."
)

ProgressReporter = Any


def require_under_run(run_dir: Path, path: Path, label: str) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(run_dir.resolve())
    except ValueError as exc:
        raise ValueError(f"{label} must stay inside the run directory: {resolved}") from exc
    return resolved


def resolve_under_run(run_dir: Path, value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = run_dir / path
    return require_under_run(run_dir, path, label)


def managed_source_label(paper: dict[str, Any]) -> str:
    """The identifier serve fetched this paper by, for an honest per-paper message."""
    arxiv_id = paper_arxiv_id(paper)
    if arxiv_id:
        return f"arXiv:{arxiv_id}"
    doi = str(paper.get("doi") or "").strip()
    return f"doi:{doi}" if doi else "product acquisition"


def summarize(papers: list[dict[str, Any]], selected_count: int) -> dict[str, int]:
    return {
        "selected": selected_count,
        "downloaded": sum(item["status"] == "downloaded" for item in papers),
        "action_required": sum(item["status"] == "action_required" for item in papers),
        "failed": sum(item["status"] == "failed" for item in papers),
        "skipped": sum(item["status"] == "skipped" for item in papers),
    }


def entry_for(
    paper_id: str,
    paper: dict[str, Any] | None,
    acquired: dict[str, dict[str, Any]],
    failures: dict[str, dict[str, Any]],
    route_selected: bool,
) -> tuple[str, str, str | None, str | None, str]:
    """One paper's honest outcome: status, message, ref, revision and storage."""
    if paper is None:
        return "failed", "Selected paper ID was not present in metadata.", None, None, ""
    if not route_selected:
        return "skipped", "The managed acquisition route was not selected by the user.", None, None, ""
    if paper_id in acquired:
        record = acquired[paper_id]
        return (
            "downloaded",
            f"Acquired by serve into managed storage ({managed_source_label(paper)}).",
            str(record.get("ref") or ""),
            str(record.get("revision") or ""),
            MANAGED_STORAGE,
        )
    if paper_id in failures:
        failure = failures[paper_id]
        reason = str(failure.get("reason") or "").strip()
        code = str(failure.get("code") or "acquire_failed")
        return "failed", f"{code}: {reason}".strip(), None, None, ""
    return "skipped", NOT_ACQUIRED_MESSAGE, None, None, ""


def build_manifest(
    selection: dict[str, Any],
    metadata: dict[str, Any],
    run_dir: Path,
    result: dict[str, Any],
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    selected = selection.get("selected_paper_ids")
    if not isinstance(selected, list):
        raise ValueError("selection needs selected_paper_ids")
    selected = [str(paper_id) for paper_id in selected]
    raw_papers = metadata.get("papers")
    if not isinstance(raw_papers, list):
        raise ValueError("metadata papers must be an array")
    papers_by_id = {
        str(paper.get("id")): paper
        for paper in raw_papers
        if isinstance(paper, dict) and paper.get("id") is not None
    }
    acquired = acquired_by_id(result)
    failures = failures_by_id(result)
    require_within_selection(result, selected)
    route_selected = selection.get("download_open") is True
    emit = progress or (lambda _message: None)
    emit(
        f"[DOWNLOAD STATUS] managed batch recorded: {len(acquired)} acquired by serve "
        f"from {len(selected)} selected."
    )
    update_progress(
        run_dir,
        stage="download",
        activity="Recording the full texts serve acquired",
        current=0,
        total=len(selected),
        completed=0,
        emit=emit,
    )

    results: list[dict[str, Any]] = []
    for index, paper_id in enumerate(selected, start=1):
        paper = papers_by_id.get(paper_id)
        title = " ".join(str((paper or {}).get("title") or "Untitled").split())[:120] or "Untitled"
        status, message, ref, revision, storage = entry_for(
            paper_id, paper, acquired, failures, route_selected
        )
        results.append(
            {
                "paper_id": paper_id,
                "title": str((paper or {}).get("title") or "Untitled"),
                **download_access(paper, "open-download"),
                "status": status,
                "storage": storage or None,
                "ref": ref or None,
                "revision": revision or None,
                "file_path": None,
                "content_type": PDF_CONTENT_TYPE if status == "downloaded" else None,
                "verified_exists": status == "downloaded",
                "message": message,
            }
        )
        emit(f"[DOWNLOAD STATUS] managed {index}/{len(selected)} {title}: {status}")
        update_progress(
            run_dir,
            stage="download",
            activity=f"Recorded {title} from the product acquisition",
            current=index,
            total=len(selected),
            completed=index,
            emit=emit,
        )

    warnings = [
        "Full texts are held in product managed storage; the run directory keeps no PDF copies.",
        "serve acquires by arXiv id or DOI; only papers it reported as failed may reach paper-dl.",
        "Entries come from the host-relayed bridge response; serve re-verifies them at delivery.",
    ]
    failed_count = sum(item["status"] == "failed" for item in results)
    if failed_count:
        warnings.append(
            f"{failed_count} selected paper(s) could not be acquired; inspect per-paper messages."
        )
    not_acquired = sum(
        item["status"] == "skipped" and item["message"] == NOT_ACQUIRED_MESSAGE
        for item in results
    )
    if not_acquired:
        warnings.append(
            f"{not_acquired} selected paper(s) were not acquired by the product; they are "
            "terminal skips — not download or recovery targets — and no full-text finding "
            "may cite them."
        )
    manifest = {
        "schema_version": "1.0",
        "run_id": selection.get("run_id", run_dir.name),
        "generated_at": utc_now(),
        "is_placeholder": False,
        "adapter": {"name": "product-bridge"},
        "papers": results,
        "summary": summarize(results, len(selected)),
        "warnings": warnings,
    }
    summary = manifest["summary"]
    emit(
        "[DOWNLOAD COMPLETE] managed batch ended: "
        f"downloaded={summary['downloaded']} failed={summary['failed']} "
        f"skipped={summary['skipped']}"
    )
    update_progress(
        run_dir,
        stage="download",
        activity="Managed acquisition recorded",
        status="completed",
        current=len(selected),
        total=len(selected),
        completed=len(selected),
        emit=emit,
    )
    return manifest


def report_failure(run_dir: Path, emit: ProgressReporter) -> None:
    if not run_dir.is_dir():
        return
    update_progress(
        run_dir,
        stage="download",
        activity="Managed acquisition recording failed",
        status="failed",
        emit=emit,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-dir", required=True, type=Path)
    args = parser.parse_args()
    run_dir = args.run_dir.resolve()

    def emit(message: str) -> None:
        print(message, flush=True)

    try:
        from stage_guard import require_download

        require_download(run_dir, args.input, "open-download")
        selection = read_json(args.input)
        if not isinstance(selection, dict) or selection.get("confirmed_by_user") is not True:
            raise ValueError("selection must be an object with confirmed_by_user=true")
        metadata_value = selection.get("metadata_path")
        if not isinstance(metadata_value, str) or not metadata_value.strip():
            raise ValueError("selection needs metadata_path")
        metadata = read_json(resolve_under_run(run_dir, metadata_value, "metadata_path"))
        if not isinstance(metadata, dict):
            raise ValueError("metadata must be a JSON object")
        result = load_acquire_result(run_dir)
        manifest = build_manifest(selection, metadata, run_dir, result, progress=emit)
        atomic_write_json(args.output, manifest)
    except AcquireResultError as exc:
        report_failure(run_dir, emit)
        print(f"open-download recording blocked: {exc}", file=sys.stderr)
        return 2
    except (OSError, RuntimeError, ValueError) as exc:
        report_failure(run_dir, emit)
        print(f"open-download recording failed for {args.input}: {exc}", file=sys.stderr)
        return 2
    print(
        f"managed acquisition recorded {manifest['summary']['downloaded']} full text(s): "
        f"{args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
