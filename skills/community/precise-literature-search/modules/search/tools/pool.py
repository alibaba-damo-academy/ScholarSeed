#!/usr/bin/env scholarseed-skill-python
"""Merge normalized query results into a persistent pool and print compact views."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

SEARCH_DIR = Path(__file__).resolve().parent.parent
SKILL_DIR = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(SEARCH_DIR))
sys.path.insert(0, str(SKILL_DIR / "scripts"))

from io_utils import atomic_write_json, read_json, utc_now  # noqa: E402
from filesystem import path_exists
from tools.dedup import deduplicate  # noqa: E402


def _pool_path(work_dir: Path) -> Path:
    return work_dir / "pool.json"


def _read_papers(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if not isinstance(value, dict):
        return []
    for key in ("papers", "matched", "results"):
        items = value.get(key)
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
    return []


def merge_papers(work_dir: Path, new_papers: list[dict[str, Any]]) -> dict[str, Any]:
    path = _pool_path(work_dir)
    existing = read_json(path) if path_exists(path) else {"schema_version": "1.0", "papers": []}
    before = _read_papers(existing)
    merged = deduplicate(before + new_papers)
    value = {"schema_version": "1.0", "papers": merged, "updated_at": utc_now()}
    atomic_write_json(path, value)
    before_ids = {str(item.get("id")) for item in before}
    new_ids = [item["id"] for item in merged if item["id"] not in before_ids]
    return {"added": len(new_ids), "new_ids": new_ids, "pool_size": len(merged)}


def _score(paper: dict[str, Any]) -> float:
    relevance = paper.get("relevance")
    raw = relevance.get("score") if isinstance(relevance, dict) else None
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw)
    citations = paper.get("citation_count")
    return float(citations) if isinstance(citations, (int, float)) else 0.0


def _ordered_papers(work_dir: Path) -> list[dict[str, Any]]:
    value = read_json(_pool_path(work_dir))
    papers = _read_papers(value)
    return sorted(papers, key=lambda paper: (-_score(paper), str(paper.get("id") or "")))


def summarize(work_dir: Path, limit: int = 12) -> dict[str, Any]:
    papers = _read_papers(read_json(_pool_path(work_dir)))
    ordered = _ordered_papers(work_dir)
    sources: dict[str, int] = {}
    for paper in papers:
        source = str(paper.get("source") or "unknown")
        sources[source] = sources.get(source, 0) + 1
    return {
        "pool_size": len(papers),
        "source_counts": sources,
        "candidates": [
            {
                "id": paper.get("id"), "title": paper.get("title"),
                "year": paper.get("year"), "source": paper.get("source"),
                "relevance_score": _score(paper),
            }
            for paper in ordered[:max(0, limit)]
        ],
    }


def review_candidates(work_dir: Path, limit: int = 20) -> dict[str, Any]:
    """Return a bounded abstract-bearing view for coverage assessment."""
    from tools.pool_inspect import build_view
    ordered = _ordered_papers(work_dir)
    view = build_view(ordered, limit=limit, abstract_chars=700)
    return {"pool_size": len(ordered), "reviewed": view["returned"],
            "candidates": view["candidates"], "view_truncated": view["view_truncated"]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["merge", "summary", "review"])
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--limit", type=int, default=12)
    args = parser.parse_args()
    if args.action == "merge":
        if args.input is None:
            parser.error("--input is required for merge")
        result = merge_papers(args.work_dir, _read_papers(read_json(args.input)))
    elif args.action == "summary":
        result = summarize(args.work_dir, args.limit)
    else:
        result = review_candidates(args.work_dir, args.limit)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
