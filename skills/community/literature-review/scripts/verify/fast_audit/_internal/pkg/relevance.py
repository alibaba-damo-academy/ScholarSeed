"""Relevance scorer — IDF-weighted TF-IDF cosine baseline.

Bag-of-words baseline. TF-IDF cosine misses synonyms, abbreviations and
academic compression; treat any FAIL signal as a hint for manual review,
not as hard evidence of irrelevance. CJK tokenization uses jieba; cross-
lingual (zh ↔ en) pairs are still short-circuited as `skipped`. This is a compatibility audit heuristic.

The batch path computes IDF over the entire (claim, abstract) pool so a
term that's common across many cited papers — `model`, `learning`, `数据`
— is correctly down-weighted. The single-pair path falls back to TF (one
'document' contributes no useful DF), so prefer `compute_batch` when you
have more than a couple of pairs.
"""

from ._utils import (
    compute_idf,
    cosine,
    detect_lang,
    tfidf_vec,
    tokenize,
)


def _verdict_from_cosine(score: float) -> tuple[str, str]:
    """Bands recalibrated for IDF-weighted cosine on short-claim ↔ long-abstract
    pairs (typically lower than raw TF cosine). pass≥0.3, weak∈[0.15,0.3),
    fail<0.15. Treat as heuristic only — see module docstring.
    """
    if score >= 0.3:
        return "pass", "none"
    if score >= 0.15:
        return "weak", "none"
    return "fail", "semantic_halluc"


def compute_relevance(claim_text: str, paper_abstract: str,
                      retrieval_score: float | None = None,
                      idf: dict[str, float] | None = None) -> dict:
    """Score a single (claim, abstract) pair.

    Cross-lingual short-circuit: TF-IDF can't bridge zh ↔ en. Skip rather
    than spuriously fail.

    `idf` is optional — when provided (typically from `compute_batch`),
    cosine is IDF-weighted; otherwise it degrades to TF (the single-pair
    corpus carries no IDF information).
    """
    if detect_lang(claim_text) != detect_lang(paper_abstract):
        return {
            "cosine_similarity": 0.0,
            "method":            "tfidf_baseline",
            "verdict":           "skipped",
            "semantic_drift":    False,
            "failure_mode":      "cross_lingual_skipped",
        }
    lang = detect_lang(claim_text)
    c_toks = tokenize(claim_text, lang=lang)
    a_toks = tokenize(paper_abstract, lang=lang)
    if not c_toks or not a_toks:
        return {
            "cosine_similarity": 0.0,
            "method":            "tfidf_baseline",
            "verdict":           "fail",
            "semantic_drift":    False,
            "failure_mode":      "empty_after_tokenize",
        }
    weights = idf if idf is not None else {t: 1.0 for t in set(c_toks) | set(a_toks)}
    score = cosine(tfidf_vec(c_toks, weights), tfidf_vec(a_toks, weights))
    verdict, mode = _verdict_from_cosine(score)
    drift = retrieval_score is not None and (retrieval_score - score) > 0.2
    return {
        "cosine_similarity": round(score, 4),
        "method":            "tfidf_baseline",
        "verdict":           verdict,
        "semantic_drift":    drift,
        "failure_mode":      mode,
    }


def compute_batch(items: list[dict]) -> dict:
    """Score a batch of (claim, abstract) pairs with shared IDF.

    IDF is computed across *all* claim + abstract token lists (skipping
    cross-lingual pairs since they get scored as skipped anyway). This
    gives 2×N "documents" in the corpus, enough to meaningfully
    down-weight terms common across many cited papers.
    """
    # Pre-tokenize every pair once, recording lang and skip-status so we
    # only feed real (non-cross-lingual) tokens into the IDF corpus.
    prepared = []
    for it in items:
        claim = it.get("claim_text", "") or ""
        abstract = it.get("paper_abstract", "") or ""
        cl, al = detect_lang(claim), detect_lang(abstract)
        if cl != al:
            prepared.append({"skip": True})
            continue
        prepared.append({
            "skip": False,
            "lang": cl,
            "c_toks": tokenize(claim, lang=cl),
            "a_toks": tokenize(abstract, lang=al),
            "retrieval_score": it.get("retrieval_score"),
        })

    docs: list[list[str]] = []
    for p in prepared:
        if p["skip"]:
            continue
        if p["c_toks"]:
            docs.append(p["c_toks"])
        if p["a_toks"]:
            docs.append(p["a_toks"])
    idf = compute_idf(docs)

    results: list[dict] = []
    for it, p in zip(items, prepared):
        if p["skip"]:
            results.append({
                "cosine_similarity": 0.0,
                "method":            "tfidf_baseline",
                "verdict":           "skipped",
                "semantic_drift":    False,
                "failure_mode":      "cross_lingual_skipped",
            })
            continue
        if not p["c_toks"] or not p["a_toks"]:
            results.append({
                "cosine_similarity": 0.0,
                "method":            "tfidf_baseline",
                "verdict":           "fail",
                "semantic_drift":    False,
                "failure_mode":      "empty_after_tokenize",
            })
            continue
        score = cosine(tfidf_vec(p["c_toks"], idf), tfidf_vec(p["a_toks"], idf))
        verdict, mode = _verdict_from_cosine(score)
        drift = (p["retrieval_score"] is not None
                 and (p["retrieval_score"] - score) > 0.2)
        results.append({
            "cosine_similarity": round(score, 4),
            "method":            "tfidf_baseline",
            "verdict":           verdict,
            "semantic_drift":    drift,
            "failure_mode":      mode,
        })

    failed = sum(1 for r in results if r["verdict"] == "fail")
    skipped = sum(1 for r in results if r["verdict"] == "skipped")
    return {
        "results":  results,
        "total":    len(results),
        "failed":   failed,
        "skipped":  skipped,
    }
