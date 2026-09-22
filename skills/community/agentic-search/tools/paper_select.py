#!/usr/bin/env scholarseed-skill-python
"""Select papers from pool using relevance scoring + diversity optimization.

Usage:
    scholarseed-skill-python paper_select.py --pool pool.json --query "..." --output metadata.json
    scholarseed-skill-python paper_select.py --pool pool.json --query "..." --output metadata.json --budget 5,15,15

Scoring strategy:
  1. Heuristic relevance scoring (keyword overlap + citation + recency)
  2. Greedy set selection with diversity penalty (AdaGReS-inspired)

For non-English queries, pass agent-generated English concepts with --concepts.
"""

import argparse
import json
import math
import re
import sys
from collections import defaultdict


def title_key(t):
    return re.sub(r"[^a-z0-9]+", "", (t or "").lower())


def heuristic_relevance(paper, query_concepts):
    """Heuristic relevance score based on keyword overlap and metadata."""
    text = ((paper.get("title") or "") + " " + (paper.get("abstract") or "")).lower()
    
    # Keyword match score (0-10)
    keyword_score = sum(1 for c in query_concepts if c.lower() in text)
    keyword_score = min(keyword_score, 10)
    
    # Citation impact (log-scaled, 0-5)
    citations = paper.get("citation_count") or 0
    if citations > 0:
        citation_score = min(math.log10(citations + 1), 5)
    else:
        citation_score = 0
    
    # Recency bonus (papers from 2022+ get bonus)
    year = paper.get("year") or 2020
    recency_bonus = max(0, (year - 2020) * 0.3)
    recency_bonus = min(recency_bonus, 1.5)
    
    # Title match bonus (if query concept appears in title, more relevant)
    title_lower = (paper.get("title") or "").lower()
    title_bonus = sum(1.5 for c in query_concepts if c.lower() in title_lower)
    title_bonus = min(title_bonus, 6)
    
    return keyword_score + citation_score + recency_bonus + title_bonus


def compute_similarity(paper_a, paper_b):
    """Simple word-overlap similarity between two papers."""
    def words(p):
        text = ((p.get("title") or "") + " " + (p.get("abstract") or "")[:200]).lower()
        return set(re.findall(r"[a-z]{3,}", text))
    
    wa = words(paper_a)
    wb = words(paper_b)
    if not wa or not wb:
        return 0
    overlap = len(wa & wb)
    return overlap / min(len(wa), len(wb))


def greedy_diverse_select(papers, budget, diversity_weight=0.3):
    """
    AdaGReS-inspired greedy selection:
    At each step, select paper that maximizes:
      score(p) = relevance(p) - diversity_weight * max_similarity(p, selected_set)
    """
    if not papers:
        return []
    
    selected = []
    remaining = list(papers)
    
    total_to_select = sum(budget)
    
    for step in range(total_to_select):
        if not remaining:
            break
        
        best_paper = None
        best_score = -float("inf")
        
        for p in remaining:
            rel = p.get("_relevance_score", 0)
            
            # Diversity penalty: similarity to most similar already-selected paper
            if selected:
                max_sim = max(compute_similarity(p, s) for s in selected)
            else:
                max_sim = 0
            
            # Adaptive weight: increase diversity importance as we select more
            adaptive_weight = diversity_weight * (1 + step / total_to_select)
            
            score = rel - adaptive_weight * max_sim * 10
            
            if score > best_score:
                best_score = score
                best_paper = p
        
        if best_paper:
            selected.append(best_paper)
            remaining.remove(best_paper)
    
    # Assign tiers
    tier_boundaries = [budget[0], budget[0] + budget[1], sum(budget)]
    for i, p in enumerate(selected):
        if i < tier_boundaries[0]:
            p["tier"] = 1
        elif i < tier_boundaries[1]:
            p["tier"] = 2
        else:
            p["tier"] = 3
    
    return selected


def main():
    parser = argparse.ArgumentParser(description="Paper selection with diversity")
    parser.add_argument("--pool", required=True, help="Pool JSON file (array of papers or {papers: [...]})")
    parser.add_argument("--query", required=True, help="User query for relevance scoring")
    parser.add_argument("--output", "-o", required=True, help="Output metadata.json path")
    parser.add_argument("--budget", default="5,15,15", help="Tier budgets: tier1,tier2,tier3")
    parser.add_argument("--concepts", default=None, help="Comma-separated query concepts for scoring")
    parser.add_argument("--diversity-weight", type=float, default=0.3)
    args = parser.parse_args()

    # Load pool
    with open(args.pool) as f:
        data = json.load(f)
    if isinstance(data, dict):
        papers = list(data.values()) if all(isinstance(v, dict) for v in data.values()) else data.get("papers", [])
    else:
        papers = data

    # Parse budget
    try:
        budget = [int(x) for x in args.budget.split(",")]
    except ValueError:
        parser.error("--budget must contain three non-negative integers, for example 5,15,15")
    if len(budget) != 3 or any(x < 0 for x in budget):
        parser.error("--budget must contain three non-negative integers, for example 5,15,15")

    # Extract query concepts
    if args.concepts:
        concepts = [c.strip() for c in args.concepts.split(",")]
    else:
        # Auto-extract from query: split into meaningful phrases
        q = args.query.lower()
        # Use words of length >= 4 as concepts, plus common bigrams
        words = re.findall(r"[a-z]{4,}", q)
        # Also try to find meaningful bigrams
        all_words = q.split()
        bigrams = [f"{all_words[i]} {all_words[i+1]}" for i in range(len(all_words)-1) 
                   if len(all_words[i]) >= 3 and len(all_words[i+1]) >= 3]
        concepts = list(set(words + bigrams))

    # Score papers
    for p in papers:
        p["_relevance_score"] = heuristic_relevance(p, concepts)

    # Sort by relevance first (for the greedy algorithm's starting point)
    papers.sort(key=lambda p: -p["_relevance_score"])

    # Greedy diverse selection
    selected = greedy_diverse_select(papers, budget, args.diversity_weight)

    # Clean up internal fields and build output
    for p in selected:
        p["relevance_score"] = round(p.pop("_relevance_score", 0), 2)

    metadata = {
        "search_summary": {
            "query": args.query,
            "pool_size": len(papers),
            "selected_count": len(selected),
            "budget": budget,
            "diversity_weight": args.diversity_weight,
        },
        "papers": selected,
    }

    with open(args.output, "w") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    # Print summary
    tier_counts = defaultdict(int)
    for p in selected:
        tier_counts[p["tier"]] += 1
    print(f"Selected {len(selected)} papers: T1={tier_counts[1]}, T2={tier_counts[2]}, T3={tier_counts[3]}", file=sys.stderr)
    print(f"Top 5:", file=sys.stderr)
    for p in selected[:5]:
        print(f"  [{p['relevance_score']:.1f}] {p['title'][:70]} ({p.get('year','?')})", file=sys.stderr)


if __name__ == "__main__":
    main()
