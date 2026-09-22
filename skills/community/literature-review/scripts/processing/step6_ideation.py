"""
Step 6: Ideation Claims (idea 生成用 claims) 提取 + 校验
"""
from __future__ import annotations

from typing import Any, Optional

from llm_call import _llm_call
from progress import PipelineStop
from paper_card_prompts import SYSTEM_PROMPT, IDEATION_CLAIMS_PROMPT, build_user_prompt


# ============================================================================
# Ideation Validation
# ============================================================================

_VALID_ROLE_HINTS = {"anchor", "pressure", "component", "bridge", "uncertain"}


def _validate_ideation(ideation: Any) -> list[str]:
    """Validate ideation claims extraction result."""
    if not isinstance(ideation, dict):
        return ["ideation must be a JSON object with 'idea_claims' key"]
    claims = ideation.get("idea_claims", [])
    if not isinstance(claims, list):
        return ["ideation.idea_claims must be an array"]
    if len(claims) < 4:
        return [f"ideation.idea_claims too few ({len(claims)}, need >= 4)"]
    errs: list[str] = []
    for i, item in enumerate(claims):
        if not isinstance(item, dict):
            errs.append(f"idea_claims[{i}] not an object")
            continue
        if "claim" not in item:
            errs.append(f"idea_claims[{i}] missing field 'claim'")
        if "role_hint" not in item:
            errs.append(f"idea_claims[{i}] missing field 'role_hint'")
        role = item.get("role_hint", "")
        if role and role not in _VALID_ROLE_HINTS:
            errs.append(f"idea_claims[{i}] invalid role_hint '{role}'")
    return errs


# ============================================================================
# Ideation Extraction
# ============================================================================

async def _extract_ideation_claims(llm, title: str, content: str,
                                   stop: Optional[PipelineStop] = None,
                                   where: str = "?",
                                   usage_out: Optional[dict] = None) -> tuple[Any, dict]:
    """Extract ideation claims. Returns (ideation, usage)."""
    user_prompt = build_user_prompt(title, content, IDEATION_CLAIMS_PROMPT)
    ideation, usage = await _llm_call(
        llm, SYSTEM_PROMPT, user_prompt,
        expect_json=True, stop=stop, where=where,
        usage_out=usage_out,
    )
    return ideation, usage
