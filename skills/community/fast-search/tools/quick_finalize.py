#!/usr/bin/env scholarseed-skill-python
"""Deterministically rank a Veryfast result pool and write metadata.json.

Veryfast search deliberately spends its only model turn on entity resolution and
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
import ranking  # noqa: E402
import publication_window  # noqa: E402
import paper_identity  # noqa: E402
import search_policy  # noqa: E402
import state as search_state  # noqa: E402


STOPWORDS = {
    "about", "after", "also", "among", "before", "being", "could", "from",
    "have", "into", "many", "more", "most", "other", "over", "paper",
    "papers", "recent", "research", "should", "some", "such", "than", "that",
    "their", "these", "they", "this", "through", "under", "using", "what",
    "when", "where", "which", "while", "with", "would",
}


class DirectTargetNotFound(ValueError):
    """Bounded retrieval did not verify the target; not proof of non-indexing."""


def _identity(paper):
    paper_id = str(paper.get("paper_id") or "").strip()
    if paper_id:
        return "id:" + paper_id
    return "title:" + ranking.title_key(paper.get("title"))


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
    hits, _ = ranking.title_probe_best_hits(papers, 100)
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
    relevance = ranking.heuristic_relevance(paper, concepts)
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
        ranking.title_key(item.get("title")),
        str(item.get("paper_id") or ""),
    ))

    selected = []
    while candidates and len(selected) < count:
        best_index = 0
        best_value = -float("inf")
        for index, paper in enumerate(candidates):
            similarity = max(
                (ranking.compute_similarity(paper, prior) for prior in selected),
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
    if str(paper.get("paper_id", "")).startswith("external:"):
        return "Scholarly metadata verified at %s; no PaperHub record was required." % paper.get("verification_url", paper.get("url", ""))
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


def _public_paper(paper, tier, concepts):
    fields = (
        "paper_id", "title", "authors", "year", "venue", "journal_name",
        "journal_pages", "journal_volume", "citation_count", "doi", "arxiv_id",
        "is_open_access", "url", "publication_date", "reference_count",
        "influential_citation_count", "publication_types", "source", "found_by", "verification_url",
    )
    output = {field: paper.get(field) for field in fields if field in paper}
    output["access"] = (
        "open" if paper.get("is_open_access") is True else "closed_or_unknown"
    )
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


def _compact_text(value):
    """Normalize a title/query for conservative full-phrase containment."""
    return "".join(character for character in str(value).casefold() if character.isalnum())


def _direct_query_match(paper, query):
    """Return a strong match class for identifiers or a title named by the user."""
    query_text = str(query or "")
    if paper_identity.identifier_match(paper, query_text) or paper_identity.url_match(paper, query_text):
        return 2
    normalized_query = _compact_text(query_text)
    normalized_title = _compact_text(paper.get("title") or "")
    if len(normalized_title) >= 8 and normalized_title in normalized_query:
        return 1
    return 0


def _best_title_match(paper, best_title):
    """Return a match only for the agent-declared canonical full title."""
    if not str(best_title or "").strip():
        return 0
    key = ranking.title_key(best_title)
    if key and key == ranking.title_key(paper.get("title")):
        return 2
    # Non-Latin titles must not match merely because both ASCII keys are empty.
    full_key = _compact_text(best_title)
    if full_key and full_key == _compact_text(paper.get("title") or ""):
        return 2
    return 0


def _declared_target_match(paper, query, best_title):
    if paper_identity.identifier_conflict(paper, query):
        return 0
    direct = _direct_query_match(paper, query)
    # Missing identifiers are not a contradiction. The canonical full title
    # must already have been verified against the input in the same web batch.
    return max(2 if direct == 2 else 0, _best_title_match(paper, best_title))


def _promote_tier1_best(selected, tier1_count, query="", best_title=""):
    """Put the best query-aligned Tier 1 paper first without changing membership."""
    boundary = min(max(int(tier1_count), 0), len(selected))
    if boundary < 2:
        return selected
    best_index = max(
        range(boundary),
        key=lambda index: (
            _direct_query_match(selected[index], query),
            _best_title_match(selected[index], best_title),
            float(selected[index].get("_quick_score", 0) or 0),
        ),
    )
    if best_index:
        selected.insert(0, selected.pop(best_index))
    return selected


def finalize_quick(
    session_dir, output_dir, concepts_text=None, count=None,
    diversity_weight=0.2, best_title="", require_best_target=False,
    papers_override=None, external_audit=None,
):
    """Finalize one Veryfast session and return a compact result summary."""
    state = search_state.read_state(session_dir)
    if state is None:
        raise ValueError("session is not initialized")
    policy = search_policy.from_state(state)
    if policy["mode"] != "quick":
        raise ValueError("quick_finalize requires a Veryfast session")
    count = int(count or policy["selected_count"])
    if not 5 <= count <= 25:
        raise ValueError("count must be between 5 and 25")
    if not 0 <= diversity_weight <= 1:
        raise ValueError("diversity_weight must be between 0 and 1")

    pool = search_state.read_pool(session_dir)
    if papers_override is None:
        papers = list(pool.values()) if isinstance(pool, dict) else list(pool)
    else:
        papers = list(papers_override)
    window = publication_window.resolve(state.get("publication_window"))
    if not papers and not window and not require_best_target:
        raise ValueError("search pool is empty")
    retrieved_pool_size = len(papers)
    papers, date_exclusions = publication_window.filter_papers(papers, window)
    # Retain the legacy audit key without reinterpreting the user's prose.
    end = window.get('date_end', '')
    cutoff = int(end[:4]) + 1 if end.endswith('-12-31') else None
    cutoff_filtered = sum(date_exclusions.values())
    concepts = _concepts(state.get("query", ""), concepts_text)
    query = state.get("query", "")
    best_title = str(best_title or "").strip()
    target_pool_matches = [
        paper for paper in papers
        if _declared_target_match(paper, query, best_title)
    ] if best_title or require_best_target else []
    if require_best_target and not target_pool_matches:
        raise DirectTargetNotFound(
            "required direct target could not be verified in the eligible candidate pool: %s"
            % (best_title or query)
        )
    selected = _select(papers, concepts, count, diversity_weight)
    if require_best_target:
        # An explicit single-paper request has an unambiguous relevance anchor.
        # Reserve it without changing the topic ranker or other candidates' order.
        target = max(target_pool_matches, key=lambda paper: (
            _direct_query_match(paper, query), _best_title_match(paper, best_title),
            float(paper.get("_quick_score", 0) or 0),
        ))
        selected = [target] + [paper for paper in selected if _identity(paper) != _identity(target)]
        selected = selected[:count]
    configured_budget = list(policy["tier_budget"])
    if count != sum(configured_budget):
        tier1 = min(4, max(1, round(count * 0.2)))
        tier2 = min(count - tier1, max(1, round(count * 0.45)))
        configured_budget = [tier1, tier2, count - tier1 - tier2]
    if not require_best_target:
        _promote_tier1_best(selected, configured_budget[0], query, best_title=best_title)
    output_papers = [
        _public_paper(paper, _tier(index, configured_budget), concepts)
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
            "tier1_top1_strategy": (
                "verified_required_target_first" if require_best_target else
                "explicit_query_alignment_then_agent_best_target_then_relevance_within_tier1"
            ),
            "tier1_top1_paper_id": output_papers[0].get("paper_id", "") if output_papers else "",
            "agent_best_target_title": best_title,
            "agent_best_target_required": bool(require_best_target),
            "agent_best_target_pool_match_count": len(target_pool_matches),
            "concepts": concepts,
            "exclusive_cutoff_year": cutoff,
            "cutoff_filtered_count": cutoff_filtered,
            **({"external_verification": external_audit} if external_audit and external_audit.get("checks") else {}),
            **({
                "publication_window": window,
                "publication_date_policy": "verified_record_date_or_fully_contained_year",
                "retrieved_pool_size": retrieved_pool_size,
                "date_exclusions": date_exclusions,
                "retrieval_date_filter": state.get("retrieval_date_filter", {}),
                "requested_count": count,
                "result_status": "completed" if output_papers else "empty",
                "shortfall_reason": (
                    "insufficient_eligible_candidates"
                    if len(output_papers) < count else None
                ),
            } if window else {}),
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
        **({
            "publication_window": window,
            "result_status": metadata["search_summary"]["result_status"],
            "shortfall_reason": metadata["search_summary"]["shortfall_reason"],
        } if window else {}),
    }


def main():
    parser = argparse.ArgumentParser(description="Finalize a Veryfast search")
    parser.add_argument("--session", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--concepts", help="comma-separated English relevance concepts")
    parser.add_argument("--count", type=int)
    parser.add_argument("--diversity-weight", type=float, default=0.2)
    parser.add_argument("--best-title")
    parser.add_argument("--require-best-target", action="store_true")
    parser.add_argument(
        "--include-abstract", action="store_true", help=argparse.SUPPRESS,
    )
    args = parser.parse_args()

    try:
        result = finalize_quick(
            args.session,
            args.output_dir,
            concepts_text=args.concepts,
            count=args.count,
            diversity_weight=args.diversity_weight,
            best_title=args.best_title,
            require_best_target=args.require_best_target,
        )
    except ValueError as exc:
        parser.error(str(exc))
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
