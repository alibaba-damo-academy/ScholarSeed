"""
Step 1: 论文类型分类 (method/benchmark/survey/theory)
"""
from __future__ import annotations

from typing import Optional

from llm_call import _llm_call
from progress import PipelineStop, VALID_TYPES
from paper_card_prompts import CLASSIFY_TYPE_PROMPT


async def _classify_paper_type(llm, title: str, abstract: str,
                               stop: Optional[PipelineStop] = None,
                               where: str = "?",
                               usage_out: Optional[dict] = None) -> tuple[str, dict]:
    """Use LLM to classify paper type when upstream doesn't provide one.
    Returns (paper_type, usage)."""
    prompt = CLASSIFY_TYPE_PROMPT.format(title=title, abstract=abstract)
    result, usage = await _llm_call(
        llm, "You are a paper classifier.", prompt,
        expect_json=False, stop=stop, where=where,
        usage_out=usage_out,
    )
    result = result.lower().strip().rstrip(".'\"")
    if result in VALID_TYPES:
        return result, usage
    for vt in VALID_TYPES:
        if vt in result:
            return vt, usage
    return "method", usage
