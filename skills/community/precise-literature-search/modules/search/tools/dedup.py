#!/usr/bin/env scholarseed-skill-python
"""Normalize and deduplicate paper records without losing source provenance."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

SEARCH_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SEARCH_DIR))

from normalize import normalize_paper  # noqa: E402


def _title_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def _identity_keys(paper: dict[str, Any]) -> list[str]:
    keys = [f"id:{paper['id']}"]
    if paper.get("doi"):
        keys.append(f"doi:{str(paper['doi']).casefold()}")
    if paper.get("arxiv_id"):
        keys.append(f"arxiv:{str(paper['arxiv_id']).casefold()}")
    keys.append(f"title:{_title_key(paper['title'])}")
    return keys


def _completeness(paper: dict[str, Any]) -> int:
    return sum(bool(paper.get(key)) for key in ("abstract", "doi", "arxiv_id", "venue", "authors"))


def deduplicate(papers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    key_to_index: dict[str, int] = {}
    for raw in papers:
        paper = normalize_paper(raw)
        if paper is None:
            continue
        keys = _identity_keys(paper)
        match = next((key_to_index[key] for key in keys if key in key_to_index), None)
        if match is None:
            match = len(result)
            result.append(paper)
        elif _completeness(paper) > _completeness(result[match]):
            previous_source = result[match].get("source")
            result[match] = paper
            if previous_source and previous_source != paper.get("source"):
                result[match]["also_found_by"] = [previous_source]
        elif paper.get("source") != result[match].get("source"):
            sources = result[match].setdefault("also_found_by", [])
            if paper.get("source") and paper["source"] not in sources:
                sources.append(paper["source"])
        for key in _identity_keys(result[match]):
            key_to_index[key] = match
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--summary-only", action="store_true")
    args = parser.parse_args()
    data = json.loads(args.input.read_text(encoding="utf-8")) if args.input else json.load(sys.stdin)
    papers = data.get("papers", data.get("results", [])) if isinstance(data, dict) else data
    deduped = deduplicate([paper for paper in papers if isinstance(paper, dict)])
    result = {
        "schema_version": "1.0", "papers": deduped,
        "original_count": len(papers), "deduped_count": len(deduped),
        "removed": len(papers) - len(deduped),
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.summary_only:
        print(json.dumps({key: result[key] for key in ("original_count", "deduped_count", "removed")}))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
