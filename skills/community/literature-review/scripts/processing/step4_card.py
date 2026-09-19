"""
Step 4: Card + common_fields (+ source_map) 提取 + 质量校验
"""
from __future__ import annotations

from typing import Optional

from llm_call import _llm_call
from progress import PipelineStop
from paper_card_prompts import SYSTEM_PROMPT, build_combined_card_prompt, build_user_prompt


# ============================================================================
# Quality Validation
# ============================================================================

_TYPE_REQUIRED_FIELDS = {
    "method": ["background", "problem", "idea", "method", "experiments", "conclusion", "discussion", "other_info"],
    "benchmark": ["background", "problem", "idea", "dataset", "metrics", "experiments", "conclusion"],
    "survey": ["background", "problem", "summary", "analysis", "discussion", "survey_outline"],
    "theory": ["background", "problem", "theorem_proof", "implication", "discussion"],
}


_TLDR_PLACEHOLDER_VALUES = {
    "no relevant information found",
    "not available from provided content",
}


def _validate_tldr(common_fields: dict | None) -> list[str]:
    """Validate common_fields.tldr: must exist, >= 10 words, and not a placeholder."""
    if not common_fields or not common_fields.get("tldr"):
        return ["common_fields.tldr is required"]
    tldr = common_fields["tldr"]
    if tldr.strip().lower() in _TLDR_PLACEHOLDER_VALUES:
        return [f"common_fields.tldr must not be a placeholder value (got '{tldr}')"]
    word_count = len(tldr.split())
    if word_count < 10:
        return [f"common_fields.tldr must be >= 10 words (got {word_count})"]
    return []


def _validate_card(paper_type: str, depth: str, card: dict, common_fields: dict) -> list[str]:
    """Validate card quality. Returns list of error messages (empty = pass)."""
    errors = []

    # --- common_fields checks (all depths) ---
    if not common_fields:
        errors.append("common_fields is required")
    else:
        errors.extend(_validate_tldr(common_fields))
        if not common_fields.get("core_contribution"):
            errors.append("common_fields.core_contribution is required")

    # --- card existence (all depths) ---
    if not card:
        errors.append(f"card must not be null for depth={depth}")

    if depth == "metadata_only" or not card:
        return errors

    # --- card content checks (full/partial only) ---
    for field in _TYPE_REQUIRED_FIELDS.get(paper_type, []):
        if not card.get(field):
            errors.append(f"card.{field} is required for type={paper_type}")

    if paper_type == "method" and isinstance(card.get("method"), dict):
        description = card["method"].get("description", "")
        if len(description) < 50:
            errors.append(f"card.method.description too short ({len(description)} chars, min 50)")

    return errors


# ============================================================================
# Card Extraction
# ============================================================================

async def _extract_card_combined(llm, paper_type: str, title: str, content: str,
                                 with_source_map: bool = False,
                                 stop: Optional[PipelineStop] = None,
                                 where: str = "?",
                                 usage_out: Optional[dict] = None) -> tuple[dict, dict, dict, dict]:
    """Extract card + common_fields (+ optional source_map) in a single LLM call.

    Returns (card, common_fields, source_map, usage). source_map is {} if not requested.
    """
    user_prompt = build_user_prompt(
        title, content, build_combined_card_prompt(paper_type, with_source_map=with_source_map)
    )
    combined, usage = await _llm_call(
        llm, SYSTEM_PROMPT, user_prompt,
        expect_json=True, stop=stop, where=where,
        usage_out=usage_out,
    )
    card = combined.get("card", combined)
    common_fields = combined.get("common_fields", {})
    source_map = combined.get("source_map", {}) if with_source_map else {}
    return card, common_fields, source_map, usage
