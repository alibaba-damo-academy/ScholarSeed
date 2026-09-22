#!/usr/bin/env scholarseed-skill-python
"""Import an independent search result without interpreting AS tools or state."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile


def import_result(source: Path, workspace: Path) -> dict:
    source, workspace = source.resolve(), workspace.resolve()
    output = workspace / "02_retrieval"
    if source == output or output in source.parents or source in output.parents:
        raise ValueError("source must be separate from 02_retrieval")
    raw = (source / "metadata.json").read_bytes()
    metadata = json.loads(raw)
    papers = metadata.get("papers") if isinstance(metadata, dict) else None
    if not isinstance(papers, list) or not papers or any(
        not isinstance(p, dict) or not str(p.get("title") or "").strip()
        for p in papers
    ):
        raise ValueError("metadata.json must contain a non-empty papers[] with titles")
    # Preserve the whole opaque run, including future AS trace formats. No AS
    # imports, configured paths, or source-specific tool calls belong here.
    destinations = ["as_run", "metadata.json", "search_import.json",
                    "selected_paper.json", "retrieval_report.json", "pipeline_status.json"]
    if any((output / name).exists() for name in destinations):
        raise ValueError("02_retrieval already contains a search or corpus; use a fresh workspace")
    output.mkdir(parents=True, exist_ok=True)
    manifest = {
        "source_dir": str(source), "snapshot_dir": "as_run",
        "metadata_sha256": hashlib.sha256(raw).hexdigest(),
        "selected_count": len(papers),
    }
    with tempfile.TemporaryDirectory(prefix=".search-import-", dir=output) as tmp:
        stage = Path(tmp)
        shutil.copytree(source, stage / "as_run")
        if (stage / "as_run" / "metadata.json").read_bytes() != raw:
            raise ValueError("search output changed during import; wait for AS to finish")
        (stage / "metadata.json").write_bytes(raw)
        (stage / "search_import.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        for name in ("as_run", "search_import.json", "metadata.json"):
            (stage / name).rename(output / name)
    return {"stage": "retrieval_import", "status": "SUCCESS",
            "status_reason": "", "papers_found": len(papers),
            "metadata": str(output / "metadata.json")}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--workspace", required=True)
    args = parser.parse_args()
    try:
        status = import_result(Path(args.source), Path(args.workspace))
    except (OSError, ValueError) as exc:
        status = {"stage": "retrieval_import", "status": "FAILED", "status_reason": str(exc)}
    print(json.dumps(status, ensure_ascii=False))
    return int(status["status"] == "FAILED")


if __name__ == "__main__":
    raise SystemExit(main())
