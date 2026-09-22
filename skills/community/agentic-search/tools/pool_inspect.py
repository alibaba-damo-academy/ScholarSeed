#!/usr/bin/env scholarseed-skill-python
"""Read a compact, relevance-ranked slice of a persistent search pool."""

import argparse
from difflib import SequenceMatcher
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paper_select import compute_similarity, heuristic_relevance  # noqa: E402
import state as search_state  # noqa: E402


def _concepts(args, query):
    if args.concepts:
        return [item.strip() for item in args.concepts.split(",") if item.strip()]
    return list(dict.fromkeys(re.findall(r"[a-zA-Z][a-zA-Z-]{3,}", query.lower())))


def _rank(papers, concepts, limit, diversity_weight):
    remaining = []
    for paper in papers:
        item = dict(paper)
        item["_score"] = heuristic_relevance(item, concepts)
        remaining.append(item)
    remaining.sort(key=lambda item: (-item["_score"], item.get("title", "")))

    selected = []
    while remaining and len(selected) < limit:
        best_index = 0
        best_value = -float("inf")
        for index, paper in enumerate(remaining):
            similarity = max(
                (compute_similarity(paper, prior) for prior in selected), default=0,
            )
            value = paper["_score"] - diversity_weight * similarity * 10
            if value > best_value:
                best_index, best_value = index, value
        selected.append(remaining.pop(best_index))
    return selected


def _compact(paper, abstract_chars, minimal=False):
    # A zero-abstract view is used to choose already-assessed candidates. Keep
    # it genuinely compact: authors and publication-detail fields are present
    # in the persistent pool and final metadata, but add no selection signal.
    minimal = minimal or abstract_chars == 0
    abstract = paper.get("abstract") or ""
    if abstract_chars == 0:
        abstract = ""
    elif len(abstract) > abstract_chars:
        abstract = abstract[:abstract_chars].rstrip() + "…"
    compact = {
        "paper_id": paper.get("paper_id", ""),
        "title": paper.get("title", ""),
        "year": paper.get("year"),
        "venue": paper.get("venue", ""),
        "journal_name": paper.get("journal_name", ""),
        "citation_count": paper.get("citation_count", 0),
        "abstract": abstract,
        "doi": paper.get("doi", ""),
        "source": paper.get("source", ""),
        "found_by": paper.get("found_by", []),
        "relevance_score": round(paper.get("_score", 0), 2),
    }
    if not minimal:
        compact.update({
            "authors": paper.get("authors", []),
            "journal_pages": paper.get("journal_pages", ""),
            "journal_volume": paper.get("journal_volume", ""),
            "arxiv_id": paper.get("arxiv_id", ""),
        })
    return compact


def _title_key(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


_TITLE_STOPWORDS = {
    "a", "an", "and", "as", "at", "by", "for", "from", "in", "into",
    "of", "on", "the", "to", "toward", "towards", "through", "using",
    "via", "with",
}


def _title_tokens(value):
    tokens = re.findall(r"[a-z0-9]+", str(value or "").lower())
    meaningful = [token for token in tokens if token not in _TITLE_STOPWORDS]
    return meaningful or tokens


def _title_match_score(probe, title):
    """Score a title result while tolerating glue words and subtitles."""
    if not _title_key(probe) or not _title_key(title):
        return 0.0
    if _title_key(probe) == _title_key(title):
        return 1.0
    probe_tokens = _title_tokens(probe)
    title_tokens = _title_tokens(title)
    if not probe_tokens or not title_tokens:
        return 0.0
    probe_set = set(probe_tokens)
    title_set = set(title_tokens)
    overlap = len(probe_set & title_set)
    coverage = overlap / len(probe_set)
    precision = overlap / len(title_set)
    sequence = SequenceMatcher(
        None, " ".join(probe_tokens), " ".join(title_tokens),
    ).ratio()
    return round(0.55 * coverage + 0.25 * precision + 0.20 * sequence, 4)


def _source_values(paper):
    values = paper.get("found_by", [])
    if isinstance(values, str):
        values = [values]
    return [value for value in values if isinstance(value, str)]


def _audit_compact(paper, found_by):
    """Keep only fields that carry signal during the final provenance audit."""
    return {
        "paper_id": paper.get("paper_id", ""),
        "title": paper.get("title", ""),
        "year": paper.get("year"),
        "venue": paper.get("venue", ""),
        "citation_count": paper.get("citation_count", 0),
        "source": paper.get("source", ""),
        "found_by": list(dict.fromkeys(found_by)),
    }


def _title_probe_best_hits(papers, limit):
    """Return one textually best result for every distinct title-mode probe."""
    probes = {}
    candidates = {}
    for paper in papers:
        for source in _source_values(paper):
            if not source.startswith("title:"):
                continue
            probe = source.split(":", 1)[1].strip()
            key = _title_key(probe)
            if not key:
                continue
            probes.setdefault(key, probe)
            candidates.setdefault(key, []).append(paper)

    hits = []
    for key in sorted(probes, key=lambda item: probes[item].lower()):
        probe = probes[key]
        ranked = sorted(
            candidates[key],
            key=lambda paper: (
                -_title_match_score(probe, paper.get("title")),
                -int(paper.get("citation_count", 0) or 0),
                _title_key(paper.get("title")),
                str(paper.get("paper_id", "")),
            ),
        )
        if not ranked:
            continue
        paper = ranked[0]
        hits.append({
            "probe": probe,
            "match_score": _title_match_score(probe, paper.get("title")),
            "exact_title_match": _title_key(probe) == _title_key(paper.get("title")),
            "paper": {**paper, "_score": 0},
        })
        if len(hits) >= limit:
            break
    return hits, len(probes)


def build_provenance_audit(
    papers,
    *,
    query="",
    concepts=None,
    title_limit=100,
    citation_limit=20,
    diversity_weight=0.25,
):
    """Build a compact final-selection audit without opening a new search."""
    papers = list(papers)
    title_hits, title_probe_count = _title_probe_best_hits(papers, title_limit)
    title_ids = {
        str(item["paper"].get("paper_id") or _title_key(item["paper"].get("title")))
        for item in title_hits
    }
    if concepts is None:
        concepts = list(dict.fromkeys(
            re.findall(r"[a-zA-Z][a-zA-Z-]{3,}", str(query).lower())
        ))
    else:
        concepts = [str(item).strip() for item in concepts if str(item).strip()]

    citation_papers = []
    for paper in papers:
        sources = _source_values(paper)
        if not any(source.startswith("references:") for source in sources):
            continue
        identity = str(paper.get("paper_id") or _title_key(paper.get("title")))
        if identity in title_ids:
            continue
        citation_papers.append(paper)
    ranked_citations = _rank(
        citation_papers, concepts, citation_limit, diversity_weight,
    )

    compact_title_hits = []
    for item in title_hits:
        paper = item["paper"]
        matching_sources = [
            source for source in _source_values(paper)
            if source.startswith("title:")
            and _title_key(source.split(":", 1)[1]) == _title_key(item["probe"])
        ]
        citation_sources = [
            source for source in _source_values(paper)
            if source.startswith("references:")
        ]
        compact_title_hits.append({
            "probe": item["probe"],
            "match_score": item["match_score"],
            "exact_title_match": item["exact_title_match"],
            "paper": _audit_compact(
                paper, matching_sources + citation_sources,
            ),
        })
    compact_citations = []
    for paper in ranked_citations:
        citation_sources = [
            source for source in _source_values(paper)
            if source.startswith("references:")
        ]
        compact_citations.append({
            **_audit_compact(paper, citation_sources),
        })
    return {
        "pool_size": len(papers),
        "title_probe_count": title_probe_count,
        "title_probe_best_hits_returned": len(compact_title_hits),
        "citation_candidates_returned": len(compact_citations),
        "title_probe_best_hits": compact_title_hits,
        "citation_candidates": compact_citations,
    }


def _lookup(papers, ids, title_fragments, limit):
    selected = []
    seen = set()

    by_id = {
        str(paper.get("paper_id", "")): paper
        for paper in papers if paper.get("paper_id") not in (None, "")
    }
    for paper_id in ids:
        paper = by_id.get(paper_id)
        if paper is not None:
            selected.append({**paper, "_score": 0})
            seen.add(id(paper))

    for fragment in title_fragments:
        needle = _title_key(fragment)
        if not needle:
            continue
        matches = [
            paper for paper in papers
            if id(paper) not in seen and needle in _title_key(paper.get("title"))
        ]
        matches.sort(key=lambda paper: (
            _title_key(paper.get("title")) != needle,
            abs(len(_title_key(paper.get("title"))) - len(needle)),
            -int(paper.get("citation_count", 0) or 0),
            paper.get("title", ""),
        ))
        for paper in matches:
            selected.append({**paper, "_score": 0})
            seen.add(id(paper))
            if len(selected) >= limit:
                return selected
    return selected[:limit]


def _exact_title_probe_hits(papers, limit):
    """Return papers whose full title exactly matches a title-mode probe."""
    selected = []
    for paper in papers:
        title_key = _title_key(paper.get("title"))
        if not title_key:
            continue
        probes = []
        for source in paper.get("found_by", []):
            if not isinstance(source, str) or not source.startswith("title:"):
                continue
            probe = source.split(":", 1)[1].strip()
            if _title_key(probe) == title_key:
                probes.append(probe)
        if probes:
            selected.append({
                **paper,
                "_score": 0,
                "matched_title_probes": list(dict.fromkeys(probes)),
            })
    selected.sort(key=lambda paper: (
        _title_key(paper.get("title")),
        -int(paper.get("citation_count", 0) or 0),
    ))
    return selected[:limit]


def build_view(
    papers,
    *,
    query="",
    concepts=None,
    ids=None,
    title_fragments=None,
    exact_title_probe_hits=False,
    limit=20,
    abstract_chars=700,
    diversity_weight=0.25,
):
    """Build the same compact evidence view used by the CLI.

    This public helper lets a batched search return its post-merge evidence view
    in the same tool call, without changing ranking or truncation semantics.
    """
    papers = list(papers)
    ids = list(ids or [])
    title_fragments = list(title_fragments or [])
    lookup_mode = bool(ids or title_fragments or exact_title_probe_hits)
    if concepts is None:
        concepts = list(dict.fromkeys(
            re.findall(r"[a-zA-Z][a-zA-Z-]{3,}", str(query).lower())
        ))
    else:
        concepts = [str(item).strip() for item in concepts if str(item).strip()]
    if exact_title_probe_hits:
        selected = _exact_title_probe_hits(papers, limit)
        concepts = []
    elif lookup_mode:
        selected = _lookup(papers, ids, title_fragments, limit)
        concepts = []
    else:
        selected = _rank(papers, concepts, limit, diversity_weight)

    return {
        "pool_size": len(papers),
        "returned": len(selected),
        "concepts": concepts,
        "papers": [
            {
                **_compact(paper, abstract_chars, minimal=lookup_mode),
                **({"matched_title_probes": paper["matched_title_probes"]}
                   if paper.get("matched_title_probes") else {}),
            }
            for paper in selected
        ],
    }


def main():
    parser = argparse.ArgumentParser(description="Inspect a compact slice of a search pool")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--session", help="search session directory")
    source.add_argument("--pool", help="pool JSON path")
    parser.add_argument("--query", help="query text; defaults to session query")
    parser.add_argument("--concepts", help="comma-separated English concepts")
    parser.add_argument("--ids", help="comma-separated paper IDs; bypass relevance ranking")
    parser.add_argument(
        "--title-contains", action="append", default=[], metavar="TEXT",
        help="case/punctuation-insensitive title fragment; repeat for multiple lookups",
    )
    parser.add_argument(
        "--exact-title-probe-hits", action="store_true",
        help="list papers whose normalized full title exactly matches a title-mode probe",
    )
    parser.add_argument(
        "--provenance-audit", action="store_true",
        help="list each title probe's best hit plus non-duplicate citation candidates",
    )
    parser.add_argument(
        "--citation-limit", type=int, default=20,
        help="citation candidates returned by --provenance-audit (0-100)",
    )
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--abstract-chars", type=int, default=700)
    parser.add_argument("--diversity-weight", type=float, default=0.25)
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error("--limit must be between 1 and 100")
    if not 0 <= args.abstract_chars <= 5000:
        parser.error("--abstract-chars must be between 0 and 5000")
    if not 0 <= args.citation_limit <= 100:
        parser.error("--citation-limit must be between 0 and 100")
    audit_modes = int(args.exact_title_probe_hits) + int(args.provenance_audit)
    if audit_modes > 1 or (
        audit_modes and (args.ids or args.title_contains)
    ):
        parser.error("audit modes cannot be combined with each other or ID/title lookups")

    if args.session:
        pool = search_state.read_pool(args.session)
        state = search_state.read_state(args.session) or {}
    else:
        with open(args.pool, encoding="utf-8") as f:
            pool = json.load(f)
        state = {}
    papers = list(pool.values()) if isinstance(pool, dict) else pool
    if not isinstance(papers, list):
        parser.error("pool must be a paper list or title-keyed object")

    query = args.query if args.query is not None else state.get("query", "")
    concepts = None if not args.concepts else _concepts(args, query)
    if args.provenance_audit:
        view = build_provenance_audit(
            papers,
            query=query,
            concepts=concepts,
            title_limit=args.limit,
            citation_limit=args.citation_limit,
            diversity_weight=args.diversity_weight,
        )
        json.dump(view, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return
    wanted = [value.strip() for value in (args.ids or "").split(",") if value.strip()]
    view = build_view(
        papers,
        query=query,
        concepts=concepts,
        ids=wanted,
        title_fragments=args.title_contains,
        exact_title_probe_hits=args.exact_title_probe_hits,
        limit=args.limit,
        abstract_chars=args.abstract_chars,
        diversity_weight=args.diversity_weight,
    )
    json.dump(view, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
