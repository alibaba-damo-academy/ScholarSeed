"""
Step 5: Delta (论文间进展关系) 提取 + 校验
"""
from __future__ import annotations

from typing import Any, Optional

from llm_call import _llm_call
from progress import PipelineStop
from paper_card_prompts import SYSTEM_PROMPT, build_delta_prompt, build_user_prompt


# ============================================================================
# Delta Validation
# ============================================================================

_DELTA_REQUIRED_FIELDS = [
    "cited_bib_id", "problem_attacked", "new_insight",
    "methodological_pivot", "empirical_gain", "applicability_boundary",
]


def _validate_delta(delta: Any) -> list[str]:
    """Validate delta extraction result. Returns list of errors (empty = pass)."""
    if not isinstance(delta, (list, dict)):
        return ["delta must be a JSON array or object with 'deltas' key"]
    items = delta if isinstance(delta, list) else delta.get("deltas", [])
    if not isinstance(items, list):
        return ["delta.deltas must be an array"]
    errs: list[str] = []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            errs.append(f"delta[{i}] not object")
            continue
        for f in _DELTA_REQUIRED_FIELDS:
            if f not in item:
                errs.append(f"delta[{i}] missing field '{f}'")
    return errs


# ============================================================================
# Delta Extraction
# ============================================================================

async def _extract_delta(llm, title: str, content: str,
                         with_source_map: bool = False,
                         stop: Optional[PipelineStop] = None,
                         where: str = "?",
                         usage_out: Optional[dict] = None) -> tuple[Any, dict, dict]:
    """Extract delta relationships. Returns (delta, delta_source_map, usage)."""
    user_prompt = build_user_prompt(title, content, build_delta_prompt(with_source_map=with_source_map))
    raw_delta, usage = await _llm_call(
        llm, SYSTEM_PROMPT, user_prompt,
        expect_json=True, stop=stop, where=where,
        usage_out=usage_out,
    )
    delta_source_map = {}
    if with_source_map and isinstance(raw_delta, dict):
        delta_source_map = raw_delta.pop("source_map", {})
    return raw_delta, delta_source_map, usage
