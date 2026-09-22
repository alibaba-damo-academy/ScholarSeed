"""
LLM 调用辅助 — 重试、超时、JSON 提取、usage 合并
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any, Optional

from progress import (
    FatalLLMError,
    LLMCallError,
    PipelineStop,
    PipelineStoppedError,
    classify_error,
    format_exception,
)


# ---- Retry constants (can be overridden by run_pipeline at startup) ----
LLM_RETRIES = 3       # Inner LLM call retry (API/network/parse failures)
_RETRY_BASE_SECONDS = 1.5
_RETRY_CAP_SECONDS = 60.0


def _retry_delay(attempt: int, retry_after: Optional[float]) -> float:
    """Exponential backoff with jitter; never undercut Retry-After."""
    backoff = min(_RETRY_CAP_SECONDS, _RETRY_BASE_SECONDS * (2 ** (attempt - 1)))
    jitter = random.uniform(0.0, min(1.0, backoff * 0.25))
    return max(backoff, retry_after or 0.0) + jitter


def _merge_usage(target: dict, source: dict):
    """Accumulate token usage from source into target."""
    for key in ("prompt_cache_hit_tokens", "prompt_cache_miss_tokens",
                "completion_tokens", "prompt_tokens"):
        if key in source:
            target[key] = target.get(key, 0) + (source[key] or 0)


def _extract_json_from_response(text: str) -> Any:
    """Extract JSON from LLM response, handling markdown code blocks."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        brace_start = text.find("{")
        brace_end = text.rfind("}")
        if brace_start != -1 and brace_end != -1:
            try:
                return json.loads(text[brace_start:brace_end + 1])
            except json.JSONDecodeError:
                pass
        return None


async def _llm_call(llm, system: str, user: str, *,
                    expect_json: bool,
                    max_tokens: Optional[int] = None,
                    stop: Optional[PipelineStop] = None,
                    where: str = "?",
                    usage_out: Optional[dict] = None,
                    timeout: Optional[float] = None) -> tuple[Any, dict]:
    """1 次 LLM 调用 + 网络重试 (LLM_RETRIES 次). 返回 (parsed_or_text, usage).
    Fatal HTTP errors raise immediately. Retryable failures use one script-owned
    exponential-backoff loop; only the final exhausted result is exposed to the
    paper-level circuit breaker. max_tokens=None uses llm.default_max_tokens.
    If usage_out is provided, every attempt's usage is accumulated into it
    (so tokens consumed by failed attempts are still tracked).
    timeout: hard overall timeout in seconds (asyncio.wait_for). Overrides any
    per-read httpx timeout so that keep-alive heartbeats cannot mask stalls.
    Falls back to llm.timeout if not explicitly provided."""
    effective_timeout = timeout if timeout is not None else getattr(llm, "timeout", None)
    last_exc: Optional[Exception] = None
    last_category = "unknown"
    maximum=1 if getattr(llm,'uses_runtime',False) else LLM_RETRIES
    for attempt in range(maximum):
        if stop is not None and stop.should_stop():
            raise PipelineStoppedError(f"pipeline stopped: {stop.fatal_reason}")
        try:
            chat_coro = llm.chat(system, user, max_tokens=max_tokens, json_mode=expect_json)
            if effective_timeout is not None:
                text, usage = await asyncio.wait_for(chat_coro, timeout=effective_timeout)
            else:
                text, usage = await chat_coro
            if usage_out is not None:
                _merge_usage(usage_out, usage)
            # Log cache hit stats (OpenAI-shape usage:
            #   prompt = total prompt tokens including cached,
            #   hit/miss are sub-components of prompt)
            raw_prompt = usage.get("prompt_tokens", 0) or 0
            cache_hit = usage.get("prompt_cache_hit_tokens", 0) or 0
            cache_miss = usage.get("prompt_cache_miss_tokens", 0) or 0
            total_prompt = raw_prompt if raw_prompt > 0 else (cache_hit + cache_miss)
            hit_pct = f"{cache_hit / total_prompt * 100:.0f}%" if total_prompt > 0 else "N/A"
            logging.debug(
                f"[CACHE] {where}: prompt={total_prompt}, hit={cache_hit}, miss={cache_miss}, "
                f"hit%={hit_pct}, completion={usage.get('completion_tokens', 0)}"
            )
            if expect_json:
                parsed = _extract_json_from_response(text)
                if parsed is None:
                    raise ValueError(f"JSON parse failed: {text[:200]!r}")
                return parsed, usage
            return text.strip(), usage
        except Exception as exc:
            if getattr(llm,'uses_runtime',False) and isinstance(exc,(TimeoutError,asyncio.TimeoutError)):
                from runtime_model_client import RuntimeModelError
                exc=RuntimeModelError('RUNTIME_TIMEOUT','Runtime logical request exceeded the script deadline; it will not be retried through another transport.')
            last_exc = exc
            info = classify_error(exc)
            last_category = info.category
            detail = format_exception(
                exc,
                where=where,
                attempt=attempt + 1,
                timeout=effective_timeout,
            )
            if info.fatal:
                if stop is not None:
                    await stop.trigger_fatal(exc, where)
                raise FatalLLMError(info.status_code or 0, detail) from exc
            if attempt + 1 < maximum:
                delay = _retry_delay(attempt + 1, info.retry_after)
                logging.warning(
                    f"[LLM_RETRY] {where}: attempt {attempt + 2}/{maximum}, "
                    f"sleep={delay:.2f}s, {detail}"
                )
                await asyncio.sleep(delay)
    assert last_exc is not None
    detail = format_exception(
        last_exc,
        where=where,
        attempt=maximum,
        timeout=effective_timeout,
    )
    raise LLMCallError(last_category, where, maximum, detail) from last_exc
