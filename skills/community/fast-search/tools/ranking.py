"""Ranking primitives used by the Veryfast retrieval and selection path."""

from difflib import SequenceMatcher
import math
import re


def heuristic_relevance(paper, query_concepts):
    """Score keyword overlap, impact, recency, and title matches."""
    text = ((paper.get("title") or "") + " " + (paper.get("abstract") or "")).lower()
    keyword_score = min(sum(1 for concept in query_concepts if concept.lower() in text), 10)
    citations = paper.get("citation_count") or 0
    citation_score = min(math.log10(citations + 1), 5) if citations > 0 else 0
    year = paper.get("year") or 2020
    recency_bonus = min(max(0, (year - 2020) * 0.3), 1.5)
    title = (paper.get("title") or "").lower()
    title_bonus = min(
        sum(1.5 for concept in query_concepts if concept.lower() in title), 6
    )
    return keyword_score + citation_score + recency_bonus + title_bonus


def compute_similarity(paper_a, paper_b):
    """Return word-overlap similarity for the diversity penalty."""
    def words(paper):
        text = (
            (paper.get("title") or "") + " " + (paper.get("abstract") or "")[:200]
        ).lower()
        return set(re.findall(r"[a-z]{3,}", text))

    left = words(paper_a)
    right = words(paper_b)
    if not left or not right:
        return 0
    return len(left & right) / min(len(left), len(right))


def title_key(value):
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


def title_match_score(probe, title):
    """Score a title result while tolerating glue words and subtitles."""
    if not title_key(probe) or not title_key(title):
        return 0.0
    if title_key(probe) == title_key(title):
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


def title_probe_best_hits(papers, limit):
    """Return one textually best result for every distinct title-mode probe."""
    probes = {}
    candidates = {}
    for paper in papers:
        for source in _source_values(paper):
            if not source.startswith("title:"):
                continue
            probe = source.split(":", 1)[1].strip()
            key = title_key(probe)
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
                -title_match_score(probe, paper.get("title")),
                -int(paper.get("citation_count", 0) or 0),
                title_key(paper.get("title")),
                str(paper.get("paper_id", "")),
            ),
        )
        if not ranked:
            continue
        paper = ranked[0]
        hits.append({
            "probe": probe,
            "match_score": title_match_score(probe, paper.get("title")),
            "exact_title_match": title_key(probe) == title_key(paper.get("title")),
            "paper": {**paper, "_score": 0},
        })
        if len(hits) >= limit:
            break
    return hits, len(probes)
