"""Shared text-processing helpers (local copy; depends on `jieba` for zh)."""

from __future__ import annotations

import math
import re
import unicodedata

# Lazy jieba: only loaded when tokenize() actually hits a zh path. English-only
# workspaces never pay the import cost (~0.5–1.5 s) or the dictionary-load cost
# on first lcut(). _ensure_jieba() is called from inside tokenize() — never at
# module load time.
jieba = None
_JIEBA_IMPORT_ERROR: ImportError | None = None
_jieba_loaded = False


def _ensure_jieba() -> None:
    global jieba, _JIEBA_IMPORT_ERROR, _jieba_loaded
    if _jieba_loaded:
        return
    _jieba_loaded = True
    try:
        import jieba as _j
        _j.setLogLevel(60)
        jieba = _j
    except ImportError as _e:
        _JIEBA_IMPORT_ERROR = _e


_CJK_CHAR_RE = re.compile(r"[一-鿿]")
_PUNCT_OR_DIGIT_RE = re.compile(r"^[\W\d_]+$", re.UNICODE)
_EN_WORD_RE = re.compile(r"\b[a-z]{3,}\b")


# Extended English stopwords (47 generic + ~50 academic boilerplate). Filtered
# from both topic extraction and cosine vectors so the ratio stays fair.
EN_STOPWORDS = frozenset({
    # generic (kept from original list)
    "the", "and", "are", "for", "but", "not", "you", "she", "him", "her", "they",
    "them", "his", "its", "our", "out", "who", "why", "how", "all", "any", "had",
    "has", "have", "was", "were", "been", "being", "can", "could", "should",
    "would", "may", "might", "will", "shall", "this", "that", "these", "those",
    "with", "from", "into", "onto", "upon", "also", "only", "even", "just", "via",
    "very", "much", "many", "some", "more", "most", "less", "least", "both",
    "each", "every", "none", "other", "such", "same", "used", "use", "using",
    "based", "than", "then", "when", "where", "what", "which", "because",
    "while", "after", "before", "over", "under", "between", "through", "during",
    "without", "within", "above", "below", "across", "along", "around",
    "however", "therefore", "thus", "hence", "moreover", "furthermore",
    # academic boilerplate (newly added)
    "approach", "approaches", "paper", "papers", "propose", "proposed",
    "proposes", "novel", "key", "method", "methods", "result", "results",
    "framework", "frameworks", "various", "different", "existing", "recent",
    "demonstrate", "demonstrates", "demonstrated", "show", "shows", "shown",
    "advanced", "advancement", "advancements", "extensive", "limited",
    "challenging", "tackle", "instead", "given", "present", "presents",
    "presented", "called", "including", "includes", "included", "specific",
    "general", "particular", "particularly", "respectively",
    "additionally", "comprehensive", "systematic",
    # latex / tex residue
    "cite", "citep", "citet", "ref", "fig", "tab", "eq",
})


# Tiny CJK stopword list (Chinese particles + filler words). Keep small;
# jieba already drops single-char tokens of length<2 via the length filter.
ZH_STOPWORDS = frozenset({
    "的", "了", "和", "是", "在", "也", "与", "及", "或", "等", "而", "并",
    "及其", "对于", "关于", "以及", "之中", "之间", "之上", "之下", "之外",
    "本文", "本研究", "我们", "他们", "它们", "其中", "其他", "另外", "因此",
    "然而", "此外", "另一方面", "一方面", "通过", "基于", "为了", "可以",
    "能够", "需要", "本节",
})


_SUFFIXES_LONG = ("tions", "ments", "ities", "ality")
_SUFFIXES_MED = ("tion", "ment", "ness", "ing", "ies", "ied", "ers")
_SUFFIXES_SHORT = ("es", "ed", "er", "ly", "s")


def _stem_en(word: str) -> str:
    """Light suffix-stripping for English plural/gerund collapse.

    Keep aggressive enough to merge `model`↔`models`, `learn`↔`learning`,
    `optimize`↔`optimization`, but stop at 4-char floor so very short stems
    don't disappear. This is deliberately cheaper / lossier than a true
    Porter stemmer — fine for bag-of-words coverage scoring.
    """
    if len(word) <= 4:
        return word
    for suf in _SUFFIXES_LONG:
        if word.endswith(suf) and len(word) - len(suf) >= 3:
            return word[: -len(suf)]
    for suf in _SUFFIXES_MED:
        if word.endswith(suf) and len(word) - len(suf) >= 3:
            return word[: -len(suf)]
    for suf in _SUFFIXES_SHORT:
        if word.endswith(suf) and len(word) - len(suf) >= 4:
            return word[: -len(suf)]
    return word


def detect_lang(text: str) -> str:
    """Return 'zh' if the text contains any CJK characters, else 'en'."""
    return "zh" if (text and _CJK_CHAR_RE.search(text)) else "en"


def tokenize(text: str, lang: str | None = None) -> list[str]:
    """Unified tokenizer used by coverage / relevance.

    Returns a list of normalized tokens with stopwords stripped and English
    words lightly stemmed. CJK input is segmented via jieba; non-CJK input
    is split on word boundaries.

    Raises RuntimeError if jieba is unavailable when zh tokenization is
    needed — fast_audit's CJK path requires jieba (optional scripts/compatibility/requirements.txt).
    """
    if not text:
        return []
    if lang is None:
        lang = detect_lang(text)
    if lang == "zh":
        _ensure_jieba()
        if jieba is None:
            raise RuntimeError(
                "jieba is required for Chinese tokenization. "
                f"Install with `pip install jieba`. ({_JIEBA_IMPORT_ERROR})"
            )
        raw = jieba.lcut(text)
        out: list[str] = []
        for w in raw:
            w = w.strip()
            if len(w) < 2:
                continue
            if _PUNCT_OR_DIGIT_RE.match(w):
                continue
            if w in ZH_STOPWORDS:
                continue
            out.append(w.lower())
        return out
    # English / latin
    lowered = text.lower()
    return [
        _stem_en(w)
        for w in _EN_WORD_RE.findall(lowered)
        if w not in EN_STOPWORDS and _stem_en(w) not in EN_STOPWORDS
    ]


def compute_idf(docs: list[list[str]]) -> dict[str, float]:
    """Smoothed IDF: log((1 + N) / (1 + df)) + 1.

    `docs` is a list of token lists (one per document). Returns
    {token: idf_weight}. Empty corpus → empty dict.
    """
    n = len(docs)
    if n == 0:
        return {}
    df: dict[str, int] = {}
    for doc in docs:
        for t in set(doc):
            df[t] = df.get(t, 0) + 1
    return {t: math.log((1 + n) / (1 + d)) + 1.0 for t, d in df.items()}


def tfidf_vec(tokens: list[str], idf: dict[str, float]) -> dict[str, float]:
    """Build a TF-IDF vector from pre-computed IDF weights."""
    if not tokens:
        return {}
    tf: dict[str, int] = {}
    for t in tokens:
        tf[t] = tf.get(t, 0) + 1
    return {t: c * idf.get(t, 1.0) for t, c in tf.items()}


def cosine(v1: dict[str, float], v2: dict[str, float]) -> float:
    """Cosine similarity between two sparse vectors keyed by token."""
    if not v1 or not v2:
        return 0.0
    keys = set(v1) | set(v2)
    dot = sum(v1.get(k, 0.0) * v2.get(k, 0.0) for k in keys)
    n1 = math.sqrt(sum(v * v for v in v1.values()))
    n2 = math.sqrt(sum(v * v for v in v2.values()))
    return dot / (n1 * n2) if n1 and n2 else 0.0


def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = text.lower().strip()
    text = " ".join(text.split())
    return text


def simple_tokenize(text: str) -> list[str]:
    """Deprecated — kept for callers outside the TF-IDF pipeline. Prefer
    `tokenize()` which is language-aware, stopword-filtered, and stemmed.
    """
    text = text.lower()
    return re.findall(r"\b\w+\b", text)


def extract_surname(name: str) -> str:
    name = name.strip().rstrip(".")
    if not name:
        return ""
    parts = name.split()
    non_initial_parts = [p for p in parts if len(p.rstrip(".")) > 1]
    if non_initial_parts:
        return non_initial_parts[-1].lower().rstrip(".")
    return parts[-1].lower().rstrip(".")
