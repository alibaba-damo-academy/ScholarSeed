"""
LLM 客户端 — _LightLLM（OpenAI 协议，指向 qwen 网关）
"""
from __future__ import annotations

from typing import Optional

from config import _SCRIPT_DIR  # noqa: F401 — ensures sys.path is set up
from gateway_headers import build_gateway_headers  # noqa: E402


class _LightLLM:
    """Lightweight async LLM wrapper for OpenAI-compatible APIs."""

    def __init__(self, model: str, base_url: str, api_key: str,
                 thinking: bool = False, timeout: float = 300.0, default_max_tokens: int = 16000):
        import httpx
        from openai import AsyncOpenAI
        self.model = model
        self.thinking = thinking
        self.default_max_tokens = default_max_tokens
        self.timeout = timeout  # Hard overall timeout for asyncio.wait_for
        # Use httpx.Timeout so that `read` timeout also applies —
        # the default OpenAI SDK timeout only guards connection establishment,
        # not the total time waiting for the response body.
        self.async_client = AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
            timeout=httpx.Timeout(timeout, connect=30.0),
            # Retry ownership lives in llm_call.py so Retry-After handling,
            # attempt logging, and breaker semantics stay deterministic.
            max_retries=0,
            # 网关 Token 计量：注入 X-Deeprd-Session-id（env 缺失则为空 dict，行为不变）
            default_headers=build_gateway_headers(),
        )

    async def chat(self, system: str, user: str, max_tokens: Optional[int] = None,
                   json_mode: bool = False) -> tuple[str, dict]:
        """Send a chat request. Returns (content, usage_dict).
        The gateway caches the prompt prefix implicitly — no explicit cache markers."""
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        params: dict = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens if max_tokens is not None else self.default_max_tokens,
        }
        if json_mode:
            params["response_format"] = {"type": "json_object"}
        # Reasoning-mode toggle, same convention as lib/_*/light_llm.py:
        # the gateway accepts `thinking.type=enabled` to turn it on and
        # `enable_thinking=false` to turn it off.
        if self.thinking:
            params["extra_body"] = {"thinking": {"type": "enabled"}}
        else:
            params["extra_body"] = {"enable_thinking": False}

        from request_capacity import configured_check
        configured_check(self.model,messages,params["max_tokens"])

        # Streaming request: keeps the HTTP connection alive on long generations
        # (avoids gateway idle timeouts) and accumulates the delta chunks.
        params["stream"] = True
        params["stream_options"] = {"include_usage": True}

        content_parts: list[str] = []
        usage: dict = {}
        stream = await self.async_client.chat.completions.create(**params)
        from stream_lifecycle import StreamLifecycle
        lifecycle=StreamLifecycle(stream)
        finish=None
        try:
            async for chunk in stream:
                if chunk.choices:
                    if chunk.choices[0].finish_reason: finish=chunk.choices[0].finish_reason
                    delta = chunk.choices[0].delta
                    if delta is not None and delta.content:
                        content_parts.append(delta.content)
                chunk_usage = getattr(chunk, "usage", None)
                if chunk_usage is not None:
                    try:
                        usage = chunk_usage.model_dump()
                    except Exception:
                        usage = dict(chunk_usage.__dict__)
        finally:
            await lifecycle.close()
        if finish != 'stop':
            raise ValueError('paper extraction stream ended without a complete response: '+str(finish))
        return "".join(content_parts), usage
