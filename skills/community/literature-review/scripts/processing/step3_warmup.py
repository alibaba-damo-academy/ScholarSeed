"""
Step 3: KV Cache 预热 (发一次短请求后 sleep 3s)
"""
from __future__ import annotations

import asyncio
from typing import Optional

from llm_call import _llm_call
from progress import PipelineStop
from paper_card_prompts import SYSTEM_PROMPT, build_paper_prefix


async def _warmup_cache(llm, title: str, content: str,
                        stop: Optional[PipelineStop] = None,
                        where: str = "?",
                        usage_out: Optional[dict] = None) -> dict:
    """Warmup: 触发 KV Cache 落盘 + sleep 3s. 返回 usage."""
    warmup_user = build_paper_prefix(title, content) + "Reply with exactly one word: OK. Do not output anything else."
    _, usage = await _llm_call(
        llm, SYSTEM_PROMPT, warmup_user,
        expect_json=False, max_tokens=1, stop=stop, where=where,
        usage_out=usage_out,
    )
    await asyncio.sleep(3.0)
    return usage
