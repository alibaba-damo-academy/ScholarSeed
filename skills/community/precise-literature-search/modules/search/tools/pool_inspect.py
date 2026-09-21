#!/usr/bin/env scholarseed-skill-python
"""Return bounded, relevance/diversity-aware views of the persistent pool."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable

SKILL_DIR = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

from io_utils import read_json  # noqa: E402

MAX_VIEW_CHARS = 48000


def _bounded(value: Any, limit: int) -> str | None:
    return str(value)[:limit] if value is not None else None


def _number(value: Any) -> int | float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value
    return None


def _papers(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if not isinstance(value, dict):
        return []
    for key in ("papers", "matched", "results"):
        items = value.get(key)
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
    return []


def _tokens(value: Any) -> set[str]:
    return {
        token for token in re.findall(r"[a-z0-9]+", str(value or "").casefold())
        if len(token) > 2
    }


def _title_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").casefold())


def _title_match(probe: str, title: Any) -> float:
    left = _title_key(probe)
    right = _title_key(title)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    probe_tokens = _tokens(probe)
    title_tokens = _tokens(title)
    overlap = len(probe_tokens & title_tokens)
    coverage = overlap / max(1, len(probe_tokens))
    precision = overlap / max(1, len(title_tokens))
    sequence = SequenceMatcher(None, left, right).ratio()
    return round(0.55 * coverage + 0.20 * precision + 0.25 * sequence, 4)


def _base_score(paper: dict[str, Any], concepts: list[str]) -> float:
    relevance = paper.get("relevance")
    explicit = relevance.get("score") if isinstance(relevance, dict) else None
    if isinstance(explicit, (int, float)) and not isinstance(explicit, bool) and math.isfinite(explicit):
        score = float(explicit)
    else:
        score = 0.0
    title = str(paper.get("title") or "").casefold()
    abstract = str(paper.get("abstract") or "").casefold()
    for concept in concepts:
        needle = concept.casefold()
        if needle in title:
            score += 3.0
        elif needle in abstract:
            score += 1.0
    citations = paper.get("citation_count")
    if isinstance(citations, (int, float)) and math.isfinite(citations) and citations > 0:
        score += min(2.0, math.log10(float(citations) + 1.0) / 2.0)
    return score


def _similarity(left: dict[str, Any], right: dict[str, Any]) -> float:
    left_tokens = _tokens(f"{left.get('title', '')} {left.get('abstract', '')}")
    right_tokens = _tokens(f"{right.get('title', '')} {right.get('abstract', '')}")
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def _rank(
    papers: Iterable[dict[str, Any]],
    concepts: list[str],
    limit: int,
    diversity_weight: float,
) -> list[dict[str, Any]]:
    remaining = []
    for source in papers:
        paper = dict(source)
        paper["_inspect_score"] = _base_score(paper, concepts)
        remaining.append(paper)
    remaining.sort(
        key=lambda item: (
            -item["_inspect_score"], _title_key(item.get("title")),
            str(item.get("id") or ""),
        )
    )
    selected: list[dict[str, Any]] = []
    while remaining and len(selected) < limit:
        best_index = max(
            range(len(remaining)),
            key=lambda index: (
                remaining[index]["_inspect_score"]
                - diversity_weight
                * max(
                    (_similarity(remaining[index], prior) for prior in selected),
                    default=0.0,
                )
                * 10.0
            ),
        )
        selected.append(remaining.pop(best_index))
    return selected


def _compact(paper: dict[str, Any], abstract_chars: int) -> dict[str, Any]:
    abstract_chars = min(max(0, abstract_chars), 4000)
    abstract = str(paper.get("abstract") or "")
    if abstract_chars == 0:
        abstract = ""
    elif len(abstract) > abstract_chars:
        abstract = f"{abstract[:max(0, abstract_chars - 1)].rstrip()}…"
    relevance = paper.get("relevance") if isinstance(paper.get("relevance"), dict) else {}
    reasons = relevance.get("reasons") if isinstance(relevance.get("reasons"), list) else []
    subtopics = paper.get("subtopics_covered") if isinstance(paper.get("subtopics_covered"), list) else []
    identity = paper.get("id")
    identity_omitted = identity is not None and len(str(identity)) > 512
    return {
        "id": None if identity_omitted else identity,
        "identity_omitted": identity_omitted,
        "title": _bounded(paper.get("title"), 600),
        "abstract": abstract,
        "year": _number(paper.get("year")),
        "venue": _bounded(paper.get("venue"), 300),
        "citation_count": _number(paper.get("citation_count")),
        "source": _bounded(paper.get("source"), 100),
        "language": _bounded(paper.get("language"), 80),
        "publication_type": _bounded(paper.get("publication_type"), 100),
        "publication_types": [_bounded(value, 100) for value in (paper.get("publication_types") or [])[:10]]
                             if isinstance(paper.get("publication_types"), list) else [],
        "document_type": _bounded(paper.get("document_type"), 50),
        "relevance": {"score": _number(relevance.get("score")),
                      "reasons": [_bounded(value, 240) for value in reasons[:3]]},
        "subtopics_covered": [_bounded(value, 160) for value in subtopics[:8]],
        "inspect_score": round(float(paper.get("_inspect_score") or 0.0), 3),
    }


def build_view(
    papers: Iterable[dict[str, Any]],
    *,
    concepts: Iterable[str] | None = None,
    limit: int = 20,
    abstract_chars: int = 700,
    diversity_weight: float = 0.25,
) -> dict[str, Any]:
    source = list(papers)
    wanted = [str(value).strip()[:160] for value in (concepts or []) if str(value).strip()][:50]
    selected = _rank(source, wanted, min(max(0, limit), 100 if abstract_chars == 0 else 20), diversity_weight)
    candidates = []
    size = len(json.dumps(wanted, ensure_ascii=False))
    for item in selected:
        compact = _compact(item, abstract_chars)
        item_size = len(json.dumps(compact, ensure_ascii=False, indent=2))
        if size + item_size > MAX_VIEW_CHARS - 4000:
            break
        candidates.append(compact)
        size += item_size
    return {
        "pool_size": len(source),
        "returned": len(candidates),
        "concepts": wanted,
        "candidates": candidates,
        "view_truncated": len(candidates) < len(selected),
    }


def build_provenance_audit(
    papers: Iterable[dict[str, Any]],
    query_log: dict[str, Any],
    *,
    concepts: Iterable[str] | None = None,
    title_limit: int = 20,
    citation_limit: int = 20,
) -> dict[str, Any]:
    source = list(papers)
    by_id = {str(item.get("id")): item for item in source if item.get("id") is not None}
    queries = query_log.get("queries", []) if isinstance(query_log, dict) else []
    title_hits = []
    title_ids: set[str] = set()
    citation_ids: set[str] = set()
    seen_title_probes: set[str] = set()
    for entry in queries:
        if not isinstance(entry, dict) or entry.get("source") != "paperhub":
            continue
        returned = [str(value) for value in entry.get("returned_ids", [])]
        mode = entry.get("mode")
        if mode == "title" and len(title_hits) < min(max(0, title_limit), 100):
            probe = str(entry.get("query") or "")
            probe_key = _title_key(probe)
            if not probe_key or probe_key in seen_title_probes:
                continue
            candidates = [by_id[value] for value in returned if value in by_id]
            if candidates:
                best = max(
                    candidates,
                    key=lambda item: (
                        _title_match(probe, item.get("title")),
                        int(item.get("citation_count") or 0),
                    ),
                )
                identity = str(best.get("id"))
                title_ids.add(identity)
                seen_title_probes.add(probe_key)
                title_hits.append({
                    "probe": probe[:600],
                    "match_score": _title_match(probe, best.get("title")),
                    "paper": _compact({**best, "_inspect_score": 0.0}, 0),
                })
        elif mode == "papers":
            citation_ids.update(returned)
    citation_papers = [
        by_id[value] for value in citation_ids
        if value in by_id and value not in title_ids
    ]
    citation_view = build_view(
        citation_papers,
        concepts=concepts,
        limit=min(max(0, citation_limit), 20),
        abstract_chars=0,
    )
    while title_hits and len(json.dumps([title_hits, citation_view["candidates"]], ensure_ascii=False, indent=2)) > MAX_VIEW_CHARS - 4000:
        title_hits.pop()
    return {
        "pool_size": len(source),
        "title_probe_best_hits": title_hits,
        "citation_candidates": citation_view["candidates"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--concepts", default="")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--abstract-chars", type=int, default=700)
    parser.add_argument("--diversity-weight", type=float, default=0.25)
    parser.add_argument("--provenance-audit", action="store_true")
    parser.add_argument("--citation-limit", type=int, default=20)
    parser.add_argument("--ids", default="")
    parser.add_argument("--title-contains", action="append", default=[])
    parser.add_argument("--exclude-id", action="append", default=[])
    args = parser.parse_args()
    maximum = 100 if args.abstract_chars == 0 or args.provenance_audit else 20
    if not 1 <= args.limit <= maximum:
        parser.error(f"--limit must be between 1 and {maximum}")
    if not 0 <= args.abstract_chars <= 4000:
        parser.error("--abstract-chars must be between 0 and 4000")
    if not 0 <= args.diversity_weight <= 1:
        parser.error("--diversity-weight must be between 0 and 1")
    if not 0 <= args.citation_limit <= 20:
        parser.error("--citation-limit must be between 0 and 20")
    if not 0 <= args.abstract_chars <= 4000:
        parser.error("--abstract-chars must be between 0 and 4000")
    if not 0 <= args.citation_limit <= 20:
        parser.error("--citation-limit must be between 0 and 20")
    if not 0 <= args.diversity_weight <= 1:
        parser.error("--diversity-weight must be between 0 and 1")

    pool = _papers(read_json(args.work_dir / "pool.json"))
    wanted_ids = {value.strip() for value in args.ids.split(",") if value.strip()}
    fragments = [value.casefold() for value in args.title_contains]
    pool = [item for item in pool if str(item.get("id")) not in set(args.exclude_id)]
    if wanted_ids or fragments:
        pool = [item for item in pool if str(item.get("id")) in wanted_ids
                or any(value in str(item.get("title", "")).casefold() for value in fragments)]
    concepts = [value.strip() for value in args.concepts.split(",") if value.strip()]
    if args.provenance_audit:
        output = build_provenance_audit(
            pool,
            read_json(args.work_dir / "query-log.json"),
            concepts=concepts,
            title_limit=args.limit,
            citation_limit=args.citation_limit,
        )
    else:
        output = build_view(
            pool,
            concepts=concepts,
            limit=args.limit,
            abstract_chars=args.abstract_chars,
            diversity_weight=args.diversity_weight,
        )
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
