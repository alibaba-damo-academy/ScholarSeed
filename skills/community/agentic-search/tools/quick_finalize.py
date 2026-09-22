#!/usr/bin/env scholarseed-skill-python
"""Deterministically rank a Quick-mode pool and write metadata.json.

Quick search deliberately spends its only model turn on entity resolution and
query planning.  This tool performs the final ranking from auditable retrieval
provenance, avoiding a second long model-selection turn.
"""

import argparse
from collections import Counter
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pool_inspect  # noqa: E402
import search_policy  # noqa: E402
import state as search_state  # noqa: E402


STOPWORDS = {
    "about", "after", "also", "among", "before", "being", "could", "from",
    "have", "into", "many", "more", "most", "other", "over", "paper",
    "papers", "recent", "research", "should", "some", "such", "than", "that",
    "their", "these", "they", "this", "through", "under", "using", "what",
    "when", "where", "which", "while", "with", "would",
}


def _exclusive_cutoff_year(query):
    """Return the exclusive year in a natural-language ``before YEAR`` query."""
    match = re.search(
        r"\bbefore\s+(?:(?:jan(?:uary)?)\s+(?:1(?:st)?\s*,?\s*)?)?"
        r"((?:19|20|21)\d{2})\b",
        str(query), re.I,
    )
    return int(match.group(1)) if match else None


def _identity(paper):
    paper_id = str(paper.get("paper_id") or "").strip()
    if paper_id:
        return "id:" + paper_id
    return "title:" + pool_inspect._title_key(paper.get("title"))


def _concepts(query, supplied):
    if supplied:
        values = [item.strip().lower() for item in supplied.split(",") if item.strip()]
        return list(dict.fromkeys(values))[:40]
    words = re.findall(r"[a-z][a-z-]{3,}", str(query).lower())
    return list(dict.fromkeys(word for word in words if word not in STOPWORDS))[:30]


def _sources(paper):
    values = paper.get("found_by", [])
    if isinstance(values, str):
        values = [values]
    return [str(value) for value in values if str(value).strip()]


def _title_probe_matches(papers):
    hits, _ = pool_inspect._title_probe_best_hits(papers, 100)
    return {
        _identity(item["paper"]): item
        for item in hits if item["match_score"] >= 0.55
    }


def _score(paper, concepts, title_matches):
    identity = _identity(paper)
    title_hit = title_matches.get(identity)
    sources = _sources(paper)
    search_sources = [source for source in sources if not source.startswith("references:")]
    reference_sources = [source for source in sources if source.startswith("references:")]
    relevance = pool_inspect.heuristic_relevance(paper, concepts)
    title_bonus = 0.0
    if title_hit:
        title_bonus = 18.0 if title_hit["exact_title_match"] else 12.0 * title_hit["match_score"]
    provenance_bonus = min(3.0, 0.75 * len(set(search_sources)))
    citation_path_bonus = min(3.0, 1.5 * len(set(reference_sources)))
    citations = int(paper.get("citation_count", 0) or 0)
    impact_tiebreaker = min(1.0, math.log10(citations + 1) / 5.0)
    return round(
        relevance + title_bonus + provenance_bonus + citation_path_bonus + impact_tiebreaker,
        4,
    )


def _select(papers, concepts, count, diversity_weight):
    title_matches = _title_probe_matches(papers)
    candidates = []
    for source in papers:
        if not str(source.get("title") or "").strip():
            continue
        item = dict(source)
        item["_quick_score"] = _score(item, concepts, title_matches)
        item["_title_hit"] = title_matches.get(_identity(item))
        candidates.append(item)
    candidates.sort(key=lambda item: (
        -item["_quick_score"],
        pool_inspect._title_key(item.get("title")),
        str(item.get("paper_id") or ""),
    ))

    selected = []
    while candidates and len(selected) < count:
        best_index = 0
        best_value = -float("inf")
        for index, paper in enumerate(candidates):
            similarity = max(
                (pool_inspect.compute_similarity(paper, prior) for prior in selected),
                default=0.0,
            )
            value = paper["_quick_score"] - diversity_weight * similarity * 10
            if value > best_value:
                best_index, best_value = index, value
        selected.append(candidates.pop(best_index))
    return selected


def _covered_concepts(paper, concepts):
    text = "%s %s" % (paper.get("title") or "", paper.get("abstract") or "")
    text = text.lower()
    return [concept for concept in concepts if concept in text][:5]


def _reason(paper):
    title_hit = paper.get("_title_hit")
    sources = _sources(paper)
    reference = any(source.startswith("references:") for source in sources)
    if title_hit and title_hit["exact_title_match"]:
        return "Exact result for the planned title probe: %s" % title_hit["probe"]
    if title_hit:
        return "Near-exact result for the planned title probe: %s" % title_hit["probe"]
    if reference:
        return "Relevant result independently supported by citation tracking."
    if len(set(sources)) > 1:
        return "Relevant result recovered through multiple planned searches."
    return "High-scoring result from the planned topic search."


def _public_paper(paper, tier, concepts, include_abstract):
    fields = (
        "paper_id", "title", "authors", "year", "venue", "journal_name",
        "journal_pages", "journal_volume", "citation_count", "doi", "arxiv_id",
        "is_open_access", "url", "publication_date", "reference_count",
        "influential_citation_count", "publication_types", "source", "found_by",
    )
    output = {field: paper.get(field) for field in fields if field in paper}
    output["access"] = (
        "open" if paper.get("is_open_access") is True else "closed_or_unknown"
    )
    if include_abstract:
        output["abstract"] = paper.get("abstract", "")
    output["tier"] = tier
    output["reason"] = _reason(paper)
    output["subtopics_covered"] = _covered_concepts(paper, concepts)
    output["relevance_score"] = round(float(paper.get("_quick_score", 0)), 2)
    return output


def _tier(index, budget):
    if index < budget[0]:
        return 1
    if index < budget[0] + budget[1]:
        return 2
    return 3


def finalize_quick(
    session_dir, output_dir, concepts_text=None, count=None,
    diversity_weight=0.2, include_abstract=False,
):
    """Finalize one Quick session and return a compact result summary."""
    state = search_state.read_state(session_dir)
    if state is None:
        raise ValueError("session is not initialized")
    policy = search_policy.from_state(state)
    if policy["mode"] != "quick":
        raise ValueError("quick_finalize requires a Quick-mode session")
    count = int(count or policy["selected_count"])
    if not 5 <= count <= 25:
        raise ValueError("count must be between 5 and 25")
    if not 0 <= diversity_weight <= 1:
        raise ValueError("diversity_weight must be between 0 and 1")

    pool = search_state.read_pool(session_dir)
    papers = list(pool.values()) if isinstance(pool, dict) else list(pool)
    if not papers:
        raise ValueError("search pool is empty")
    cutoff = _exclusive_cutoff_year(state.get("query", ""))
    cutoff_filtered = 0
    if cutoff:
        before = len(papers)
        papers = [
            paper for paper in papers
            if not isinstance(paper.get("year"), int) or paper["year"] < cutoff
        ]
        cutoff_filtered = before - len(papers)
        if not papers:
            raise ValueError("all search results violate the publication cutoff")
    concepts = _concepts(state.get("query", ""), concepts_text)
    selected = _select(papers, concepts, count, diversity_weight)
    configured_budget = list(policy["tier_budget"])
    if count != sum(configured_budget):
        tier1 = min(4, max(1, round(count * 0.2)))
        tier2 = min(count - tier1, max(1, round(count * 0.45)))
        configured_budget = [tier1, tier2, count - tier1 - tier2]
    output_papers = [
        _public_paper(paper, _tier(index, configured_budget), concepts, include_abstract)
        for index, paper in enumerate(selected)
    ]
    metadata = {
        "search_summary": {
            "query": state.get("query", ""),
            "mode": "quick",
            "total_rounds": state.get("rounds_completed", 0),
            "total_queries": len(state.get("searched_queries", [])),
            "pool_size": len(papers),
            "selected_count": len(output_papers),
            "tier_budget": configured_budget,
            "selection_strategy": policy["selection_strategy"],
            "concepts": concepts,
            "exclusive_cutoff_year": cutoff,
            "cutoff_filtered_count": cutoff_filtered,
        },
        "papers": output_papers,
    }
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, "metadata.json")
    search_state._atomic_json_write(output_path, metadata)
    tiers = Counter(paper["tier"] for paper in output_papers)
    return {
        "output": os.path.abspath(output_path),
        "pool_size": len(papers),
        "selected_count": len(output_papers),
        "tiers": {str(key): value for key, value in sorted(tiers.items())},
    }


def main():
    parser = argparse.ArgumentParser(description="Finalize a Quick-mode search")
    parser.add_argument("--session", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--concepts", help="comma-separated English relevance concepts")
    parser.add_argument("--count", type=int)
    parser.add_argument("--diversity-weight", type=float, default=0.2)
    parser.add_argument("--include-abstract", action="store_true")
    args = parser.parse_args()

    try:
        result = finalize_quick(
            args.session,
            args.output_dir,
            concepts_text=args.concepts,
            count=args.count,
            diversity_weight=args.diversity_weight,
            include_abstract=args.include_abstract,
        )
    except ValueError as exc:
        parser.error(str(exc))
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
