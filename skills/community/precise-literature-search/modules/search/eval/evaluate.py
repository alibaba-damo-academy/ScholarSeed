#!/usr/bin/env scholarseed-skill-python
"""Evaluate tiered search metadata against a title-based ground-truth set."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


def title_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def is_match(left: str, right: str) -> bool:
    left_key = title_key(left)
    right_key = title_key(right)
    if not left_key or not right_key:
        return False
    if left_key == right_key:
        return True
    shorter, longer = sorted((left_key, right_key), key=len)
    return len(shorter) > 20 and shorter in longer and len(shorter) / len(longer) > 0.8


def _ground_truth(path: Path) -> list[str]:
    if path.suffix.casefold() != ".json":
        return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    value: Any = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(value, dict):
        value = value.get("papers", value.get("ground_truth", []))
    if not isinstance(value, list):
        return []
    return [
        str(item.get("title") or "") if isinstance(item, dict) else str(item)
        for item in value
        if (isinstance(item, str) and item.strip()) or isinstance(item, dict)
    ]


def evaluate(metadata: dict[str, Any], ground_truth: list[str]) -> dict[str, Any]:
    papers = metadata.get("papers", []) if isinstance(metadata, dict) else []
    titles = [str(paper.get("title") or "") for paper in papers if isinstance(paper, dict)]
    found = [title for title in ground_truth if any(is_match(candidate, title) for candidate in titles)]
    correct = [title for title in titles if any(is_match(title, target) for target in ground_truth)]
    recall = len(found) / len(ground_truth) if ground_truth else 0.0
    precision = len(correct) / len(titles) if titles else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    tiers: dict[str, dict[str, Any]] = {}
    for tier in (1, 2, 3):
        tier_titles = [
            str(paper.get("title") or "") for paper in papers
            if isinstance(paper, dict) and paper.get("tier") == tier
        ]
        tier_found = sum(
            any(is_match(candidate, target) for candidate in tier_titles)
            for target in ground_truth
        )
        tiers[f"tier{tier}"] = {"count": len(tier_titles), "ground_truth_found": tier_found}
    return {
        "recall": round(recall, 4), "precision": round(precision, 4), "f1": round(f1, 4),
        "ground_truth_total": len(ground_truth), "ground_truth_found": len(found),
        "predicted_total": len(titles), "predicted_correct": len(correct),
        "tier_metrics": tiers,
        "missed_titles": [title for title in ground_truth if title not in found],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", required=True, type=Path)
    parser.add_argument("--ground-truth", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = evaluate(
        json.loads(args.metadata.read_text(encoding="utf-8")),
        _ground_truth(args.ground_truth),
    )
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
