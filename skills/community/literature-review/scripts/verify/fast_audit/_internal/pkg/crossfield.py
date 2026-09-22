"""Cross-field metadata consistency validator — local copy."""

from ._utils import normalize_text, extract_surname


def levenshtein_distance(s1: str, s2: str) -> int:
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)
    prev = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1):
        curr = [i + 1]
        for j, c2 in enumerate(s2):
            curr.append(min(prev[j + 1] + 1, curr[j] + 1, prev[j] + (c1 != c2)))
        prev = curr
    return prev[len(s2)]


def normalized_levenshtein_similarity(s1: str, s2: str) -> float:
    s1 = normalize_text(s1)
    s2 = normalize_text(s2)
    if not s1 and not s2:
        return 1.0
    max_len = max(len(s1), len(s2))
    if max_len == 0:
        return 1.0
    return 1 - levenshtein_distance(s1, s2) / max_len


def check_author_match(claimed: str, db_returned: str) -> bool:
    if not claimed or not db_returned:
        return True
    return extract_surname(claimed) == extract_surname(db_returned)


def check_year_match(claimed, db_returned) -> bool:
    if claimed is None or db_returned is None:
        return True
    try:
        return abs(int(claimed) - int(db_returned)) <= 1
    except (ValueError, TypeError):
        return True


def validate_crossfield(claimed: dict, db_returned: dict) -> dict:
    title_sim = normalized_levenshtein_similarity(
        claimed.get("title", ""), db_returned.get("title", ""))
    title_pass = title_sim >= 0.92
    author_match = check_author_match(
        claimed.get("first_author", ""), db_returned.get("first_author", ""))
    year_match = check_year_match(claimed.get("year"), db_returned.get("year"))

    checks = {
        "title_similarity": round(title_sim, 4),
        "title_pass": title_pass,
        "author_match": author_match,
        "year_match": year_match,
    }
    consistent = title_pass and author_match and year_match
    if not consistent:
        if not title_pass and title_sim < 0.5:
            failure_mode = "identifier_hijacking"
        else:
            failure_mode = "partial_attr_corruption"
    else:
        failure_mode = "none"
    return {"consistent": consistent, "checks": checks, "failure_mode": failure_mode}


def validate_batch(items: list[dict]) -> dict:
    """items: [{citation_raw, claimed, db_returned}, ...]"""
    results = []
    inconsistent_count = 0
    for it in items:
        claimed = it.get("claimed", {}) or {}
        db = it.get("db_returned", {}) or {}
        r = validate_crossfield(claimed, db)
        results.append({
            "citation_raw": it.get("citation_raw", ""),
            "consistent": r["consistent"],
            **r,
        })
        if not r["consistent"]:
            inconsistent_count += 1
    return {
        "results": results,
        "inconsistent_count": inconsistent_count,
        "total": len(results),
    }
