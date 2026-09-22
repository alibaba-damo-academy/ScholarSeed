"""Small, auditable intent checks; semantic screening belongs to the agent."""
from __future__ import annotations

import hashlib
import json
from typing import Any

RESEARCH_FIELDS = ("precise_intent", "research_questions", "include_criteria",
                   "exclude_criteria", "time_range", "paper_types", "language")


def intent_key(intent: dict[str, Any]) -> str:
    """Bind the review to research constraints, excluding confirmation/budgets."""
    data = {field: intent.get(field) for field in RESEARCH_FIELDS}
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode("utf-8")).hexdigest()


def assess_intent(paper: dict[str, Any], intent: dict[str, Any]) -> tuple[str, list[str]]:
    review = paper.get("intent_review")
    matched = isinstance(review, dict) and review.get("intent_key") == intent_key(intent)
    reasons: list[str] = []
    years = intent.get("time_range") or {}
    lower, upper = years.get("from_year"), years.get("to_year")
    year = paper.get("year")
    if (lower is not None or upper is not None) and not isinstance(year, int):
        # A sourced review year may fill a metadata gap. An unresolved year
        # stays unknown but does not block a candidate intended for reading.
        if matched and isinstance(review.get("year"), int) and not isinstance(review["year"], bool) and 1000 <= review["year"] <= 9999 and isinstance(review.get("year_source"), str) and review["year_source"].strip():
            year = review["year"]
    if isinstance(year, int) and not isinstance(year, bool):
        if (lower is not None and year < lower) or (upper is not None and year > upper):
            return "excluded", [f"Year {year} is outside the requested time range."]
    language_names = {"en": "english", "english": "english", "英文": "english",
                      "zh": "chinese", "chinese": "chinese", "中文": "chinese"}
    requested = str(intent.get("language") or "").casefold().strip()
    actual = str(paper.get("language") or "").casefold().strip()
    if requested in language_names and actual in language_names and language_names[requested] != language_names[actual]:
        return "excluded", [f"Language {actual} differs from the requested language."]
    # Type names and natural-language criteria are not a safe keyword filter.
    # The agent decides whether this is a useful candidate for the complete
    # intent; missing detail is resolved during reading, not by keyword gates.
    if not matched or not isinstance(review.get("eligible"), bool) or not isinstance(review.get("reason"), str) or not review["reason"].strip():
        reasons.append("Agent review against the complete current intent is required.")
    elif review["eligible"] is False:
        return "excluded", [review["reason"]]
    if reasons:
        return "pending", reasons
    return "eligible", [review["reason"]]
