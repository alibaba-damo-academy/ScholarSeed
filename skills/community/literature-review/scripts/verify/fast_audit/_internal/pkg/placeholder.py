"""Placeholder citation detector — local copy."""

import re

PLACEHOLDER_PATTERNS = [
    (r"(?:Firstname|First\s+Last|Lastname|Author)\s.*?\d{4}", "generic_author_name"),
    (r"et\s+al\.\s*\(?\s*(?:XXXX|20XX|YYYY)\s*\)?", "placeholder_year"),
    (r"\(\s*(?:XXXX|20XX|YYYY)\s*\)", "placeholder_year_parens"),
    (r"doi:\s*$", "empty_doi"),
    (r"10\.xxxx", "placeholder_doi"),
    (r"doi:\s*10\.0000/placeholder", "placeholder_doi"),
    (r"arxiv:\s*\d{4}\.\d{5,}xxx", "placeholder_arxiv"),
    (r"arXiv:\s*$", "empty_arxiv"),
    (r"[□■○●◇◆△▽▲▼]{2,}", "unicode_placeholder"),
    (r"\[citation\s+needed\]", "citation_needed_marker"),
    (r"\[ref\s*\?\]", "ref_placeholder"),
    (r"Journal\s+of\s+(?:Something|Placeholder|XXX)", "placeholder_journal"),
    (r"https?://(?:example\.com|placeholder|xxx\.xxx)", "placeholder_url"),
]

COMPILED_PATTERNS = [(re.compile(p, re.IGNORECASE), name) for p, name in PLACEHOLDER_PATTERNS]


def check_placeholder(citation_text: str) -> dict:
    matches = []
    for pattern, name in COMPILED_PATTERNS:
        for m in pattern.findall(citation_text):
            matches.append({
                "pattern_name": name,
                "matched_text": m if isinstance(m, str) else m[0],
            })
    return {
        "is_placeholder": len(matches) > 0,
        "matches": matches,
        "failure_mode": "placeholder" if matches else "none",
    }


def check_batch(cite_keys: list[str], raw_citation: str = "") -> dict:
    """Run placeholder detection on multiple cite keys + an optional raw block."""
    results = []
    placeholder_count = 0
    for key in cite_keys:
        r = check_placeholder(key)
        results.append({"cite_key": key, "is_placeholder": r["is_placeholder"], **r})
        if r["is_placeholder"]:
            placeholder_count += 1

    raw_result = None
    if raw_citation:
        raw_result = check_placeholder(raw_citation)
        if raw_result["is_placeholder"]:
            placeholder_count += 1

    return {
        "results": results,
        "placeholder_count": placeholder_count,
        "total": len(results),
        "raw_citation_result": raw_result,
    }
