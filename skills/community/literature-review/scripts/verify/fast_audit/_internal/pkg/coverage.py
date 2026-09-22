"""Coverage audit — TF-IDF cosine baseline with IDF-weighted topic gating.

Like `relevance`, this module is a bag-of-words heuristic and cannot bridge
languages. `audit_coverage` partitions sections + papers by CJK / Latin
language buckets and only scores within a matching bucket; if no bucket has
both sides represented, the module returns `coverage_f1=None` and the
merger surfaces it as SKIPPED rather than spuriously FAIL. This is a compatibility audit heuristic.

CJK tokenization uses jieba (see `_utils.tokenize`). Topic gating uses
IDF-weighted top-K with a DF upper bound so domain-ubiquitous terms
(`model`, `learning`, `模型`) don't dominate the noise floor.
"""

from datetime import datetime

from ._utils import (
    compute_idf,
    cosine,
    detect_lang,
    tfidf_vec,
    tokenize,
)


def _partition_by_lang(items: list[dict], keys: tuple[str, ...]) -> dict:
    """Split items into {'zh': [...], 'en': [...]} buckets.
    `keys` is the list of fields to concatenate when sniffing language."""
    out: dict[str, list[dict]] = {"zh": [], "en": []}
    for it in items:
        text = " ".join(str(it.get(k, "") or "") for k in keys)
        out[detect_lang(text)].append(it)
    return out


def keyword_topic_coverage(sections: list[dict], papers: list[dict],
                           lang: str = "en",
                           min_papers_per_topic: int = 3,
                           df_upper_ratio: float = 0.7,
                           topic_cap: int = 40) -> dict:
    """Build the 'topics' set from the retrieved-paper corpus, then check
    which topics actually appear in the survey body.

    Topic definition: a token that
      (a) appears in ≥ `min_papers_per_topic` papers AND
      (b) appears in ≤ `df_upper_ratio × N` papers (drop near-universal terms
          like `model` / `learning` that would otherwise dominate),
    ranked by IDF × DF (higher = more distinguishing AND well-supported).
    Top `topic_cap` such tokens are kept.

    Coverage check uses a tokenized survey set (not raw substring) to avoid
    `model` falsely matching `modeling`.
    """
    paper_tokens = [tokenize(
        (p.get("title", "") or "") + " " + (p.get("abstract", "") or ""),
        lang=lang,
    ) for p in papers]
    n_papers = len(paper_tokens)

    df: dict[str, int] = {}
    for toks in paper_tokens:
        for t in set(toks):
            df[t] = df.get(t, 0) + 1

    upper = max(min_papers_per_topic, int(df_upper_ratio * n_papers)) if n_papers else 0
    idf = compute_idf(paper_tokens)
    # Candidate (token, score, df). Score = idf * df (favors well-supported
    # AND moderately rare terms — pure idf would over-weight DF=3 terms,
    # pure df would over-weight ubiquitous ones).
    candidates = sorted(
        ((t, idf.get(t, 1.0) * d, d) for t, d in df.items()
         if min_papers_per_topic <= d <= upper),
        key=lambda x: (-x[1], x[0]),
    )[:topic_cap]
    topics = {t for t, _, _ in candidates}

    survey_tokens: set[str] = set()
    for s in sections:
        survey_tokens.update(tokenize(s.get("content", "") or "", lang=lang))

    covered = topics & survey_tokens
    uncovered = topics - survey_tokens
    ratio = len(covered) / len(topics) if topics else 1.0

    return {
        "total_topics": len(topics),
        "covered": len(covered),
        "uncovered_topics": sorted(uncovered)[:20],
        "coverage_ratio": round(ratio, 4),
        "topic_idf_scores": [
            {"topic": t, "score": round(s, 3), "df": d}
            for t, s, d in candidates[:20]
        ],
        "df_upper_bound": upper,
    }


def semantic_alignment(sections: list[dict], papers: list[dict],
                       lang: str = "en",
                       threshold: float = 0.15) -> dict:
    """For each paper, find the closest section by IDF-weighted cosine.
    Papers with max cosine < threshold are flagged as 'orphan' (no section
    discusses them).
    """
    section_token_lists = [tokenize(s.get("content", "") or "", lang=lang)
                           for s in sections]
    paper_token_lists = [tokenize(
        (p.get("abstract", "") or "") + " " + (p.get("title", "") or ""),
        lang=lang,
    ) for p in papers]

    # Joint corpus for IDF — sections + papers, so a term frequent across
    # both sides correctly gets low IDF.
    idf = compute_idf(section_token_lists + paper_token_lists)
    section_vecs = [(s.get("title", ""), tfidf_vec(toks, idf))
                    for s, toks in zip(sections, section_token_lists)]

    orphan_papers, aligned_papers = [], []
    for p, p_toks in zip(papers, paper_token_lists):
        p_vec = tfidf_vec(p_toks, idf)
        max_sim, best_section = 0.0, ""
        for s_title, s_vec in section_vecs:
            sim = cosine(p_vec, s_vec)
            if sim > max_sim:
                max_sim, best_section = sim, s_title
        if max_sim < threshold:
            orphan_papers.append({
                "paper_id": p.get("paper_id"),
                "title": p.get("title"),
                "max_similarity": round(max_sim, 4),
            })
        else:
            aligned_papers.append({
                "paper_id": p.get("paper_id"),
                "best_section": best_section,
                "similarity": round(max_sim, 4),
            })
    return {
        "total_papers": len(papers),
        "aligned": len(aligned_papers),
        "orphan_count": len(orphan_papers),
        "orphan_papers": orphan_papers[:10],
    }


def temporal_coverage(papers: list[dict], references: list[dict] | None = None,
                      recent_years: int = 3) -> dict:
    current_year = datetime.now().year
    cutoff = current_year - recent_years
    paper_years = [p.get("year", 0) for p in papers if p.get("year")]
    if not paper_years:
        return {"recent_ratio": 0.0, "details": "no year data"}
    recent = sum(1 for y in paper_years if y >= cutoff)
    classic = sum(1 for y in paper_years if y < cutoff - 5)
    ref_recent = 0
    if references:
        ref_years = [r.get("year", 0) for r in references if r.get("year")]
        ref_recent = sum(1 for y in ref_years if y >= cutoff)
    return {
        "recent_ratio": round(recent / len(paper_years), 4),
        "recent_count": recent,
        "total_papers": len(paper_years),
        "classic_count": classic,
        "referenced_recent": ref_recent,
        "pass": (recent / len(paper_years)) >= 0.3,
    }


def audit_coverage(sections: list[dict], papers: list[dict],
                   expected_topics: list[str] | None = None) -> dict:
    """Score coverage within whichever (zh / en) bucket has both sections
    AND papers. Cross-lingual configurations (e.g. zh sections + en papers
    only) cannot be scored by TF-IDF — return `coverage_f1=None` and let
    the merger surface SKIPPED rather than a spurious FAIL.

    `temporal_coverage` is language-agnostic (uses years only) so it always
    runs over all papers.
    """
    sec_buckets = _partition_by_lang(sections, ("title", "content"))
    pap_buckets = _partition_by_lang(papers, ("title", "abstract"))

    candidates = [(lang, sec_buckets[lang], pap_buckets[lang])
                  for lang in ("zh", "en")
                  if sec_buckets[lang] and pap_buckets[lang]]

    temporal = temporal_coverage(papers)

    if not candidates:
        return {
            "coverage_f1":           None,
            "topic_coverage":        None,
            "semantic_alignment":    None,
            "temporal_coverage":     temporal,
            "orphan_papers":         [],
            "missing_topics":        [],
            "cross_lingual_skipped": True,
            "reason": ("sections and papers do not share a TF-IDF-scoreable "
                       "language bucket "
                       f"(sec zh={len(sec_buckets['zh'])}/en={len(sec_buckets['en'])}, "
                       f"pap zh={len(pap_buckets['zh'])}/en={len(pap_buckets['en'])})"),
        }

    lang, secs, paps = max(candidates, key=lambda c: len(c[1]) + len(c[2]))
    topic = keyword_topic_coverage(secs, paps, lang=lang)
    alignment = semantic_alignment(secs, paps, lang=lang)
    precision = alignment["aligned"] / len(paps) if paps else 0
    recall = topic["coverage_ratio"]
    f1 = (2 * precision * recall / (precision + recall)
          if (precision + recall) > 0 else 0)
    return {
        "coverage_f1":           round(f1, 4),
        "topic_coverage":        topic,
        "semantic_alignment":    alignment,
        "temporal_coverage":     temporal,
        "orphan_papers":         alignment.get("orphan_papers", []),
        "missing_topics":        topic.get("uncovered_topics", []),
        "scored_lang_bucket":    lang,
        "scored_sections":       len(secs),
        "scored_papers":         len(paps),
    }
