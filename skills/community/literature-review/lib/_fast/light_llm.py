"""light_llm.py — shared async LLM wrapper for survey-generation worker skills.

Single-model wrapper:

  * `provider="qwen"` → AsyncOpenAI client against the qwen3.8-max gateway.

That is the only provider the pipeline uses; every stage resolves to it.
The Anthropic backend that used to live alongside it is gone — there is
one wire protocol now, and `create_llm` dispatches on the `backend` field
of the provider entry purely so a second one could be added later.

Outline, chapter, full-manuscript and delta-refinement runners share this
streaming client. Legacy text callers also use SSE. Public surface:

  - LightLLM, _LLMStats
  - BUILTIN_PROVIDERS
  - create_llm()
  - _make_nonce_text(), _make_nonce_message()
  - _read_cache_tokens(), _read_reasoning_tokens(), _percentile()

Cache-bust mode (env `BUST_LLM_CACHE=1`) prepends a unique nonce *system
message* to defeat the gateway's prompt-prefix hash cache.

Credentials and URL overrides:

  `SCHOLARSEED_ACCOUNT_TOKEN` is the sole API-token source. `TEXT_BASE_URL`
  overrides the URL supplied by the stage config. `create_llm` raises a clear
  RuntimeError when the shared token is empty.

"""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
import slr_paths as _slr_paths
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import asyncio
import os
import random
import sys
import time
import uuid
from typing import Any, Optional

# 网关 Token 计量：统一 session-id header helper（读 DEEP_RD_SESSION_ID，env 缺失则不加）。
# 容错：定位/导入失败时降级为返回原 headers，绝不让 header 透传破坏既有 stage。
try:
    from pathlib import Path as _Path

    _shared_dir = str(_Path(__file__).resolve().parents[2] / "shared")
    if _shared_dir not in sys.path:
        pass
    from gateway_headers import build_gateway_headers  # type: ignore
except Exception:  # pragma: no cover - defensive
    def build_gateway_headers(base: Optional[dict] = None) -> dict:
        return dict(base) if base else {}


# ---------------------------------------------------------------------------
# Provider registry (single source of truth across all skills)
# ---------------------------------------------------------------------------

# The pipeline runs on a single model reached through a single
# OpenAI-protocol gateway. The URL default lives in the model config and the
# token only in SCHOLARSEED_ACCOUNT_TOKEN; neither has a registry-level fallback.
BUILTIN_PROVIDERS: dict[str, dict[str, Any]] = {
    "qwen": {
        "backend": "openai",
        "model": "qwen3.8-max",
    },
}


# ---------------------------------------------------------------------------
# Cache-bust helpers (exported; driven by the BUST_LLM_CACHE env var)
# ---------------------------------------------------------------------------

def _cache_bust_enabled() -> bool:
    val = os.environ.get("BUST_LLM_CACHE", "").strip().lower()
    return val not in ("", "0", "false", "no", "off")


_PAD_WORDS = (
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima "
    "mike november oscar papa quebec romeo sierra tango uniform victor whiskey "
    "xray yankee zulu nadir azimuth quanta plasma vector tensor scalar parsec "
    "lumen quartz cobalt zenith vortex helix prism cipher matrix syntax codex "
    "lambda kappa sigma omega pixel raster glyph nebula photon quasar pulsar "
    "lattice fractal entropy gradient orbital nucleus quark boson lepton meson "
    "axion gluon hadron isotope plasma soliton phonon magnon polaron exciton"
).split()


def _make_nonce_text() -> str:
    """Cache-bust padding (~80 padding tokens) used by both backends."""
    rng = random.Random(uuid.uuid4().int)
    padding = " ".join(rng.choice(_PAD_WORDS) for _ in range(80))
    tag = f"{uuid.uuid4().hex}-{time.time_ns()}"
    return (
        f"[benchmark-nonce: {tag}] (ignore this line; it exists only to "
        f"invalidate prompt-prefix caches for benchmarking) {padding}"
    )


def _make_nonce_message() -> dict:
    """Same payload as `_make_nonce_text()`, wrapped as a chat message.
    Used by the OpenAI-shape response path."""
    return {"role": "system", "content": _make_nonce_text()}


# ---------------------------------------------------------------------------
# Stats base (shared between backends)
# ---------------------------------------------------------------------------


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round((pct / 100.0) * (len(s) - 1)))))
    return s[k]


def _read_reasoning_tokens(usage: Any) -> int:
    """Read reasoning_tokens from usage.completion_tokens_details."""
    details = getattr(usage, "completion_tokens_details", None)
    if details is not None:
        val = getattr(details, "reasoning_tokens", None)
        if val is not None:
            return int(val)
        if isinstance(details, dict):
            return int(details.get("reasoning_tokens") or 0)
    extra = getattr(usage, "model_extra", None) or {}
    if isinstance(extra, dict):
        details_dict = extra.get("completion_tokens_details")
        if isinstance(details_dict, dict):
            return int(details_dict.get("reasoning_tokens") or 0)
    return 0


def _read_cache_tokens(usage: Any) -> tuple[int, int]:
    """Defensive read of cache hit/miss tokens from a usage object.

    Tries Anthropic-style field names (`cache_read_input_tokens` /
    `cache_creation_input_tokens`) and OpenAI-style field names
    (`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`). Returns the
    first pair where at least one of (hit, miss) is set. The pydantic v2
    `model_extra` dict is consulted as a fallback.

    The two schemas don't collide, so checking both is safe regardless of
    which backend produced the usage object.
    """
    # Try direct attrs first — Anthropic-style schema.
    hit = getattr(usage, "cache_read_input_tokens", None)
    miss = getattr(usage, "cache_creation_input_tokens", None)
    if hit is None and miss is None:
        # Fall back to the OpenAI schema.
        hit = getattr(usage, "prompt_cache_hit_tokens", None)
        miss = getattr(usage, "prompt_cache_miss_tokens", None)

    # Last resort: pydantic-v2 extras dict.
    if hit is None or miss is None:
        extra = getattr(usage, "model_extra", None) or {}
        if isinstance(extra, dict):
            if hit is None:
                hit = (
                    extra.get("cache_read_input_tokens")
                    or extra.get("prompt_cache_hit_tokens")
                )
            if miss is None:
                miss = (
                    extra.get("cache_creation_input_tokens")
                    or extra.get("prompt_cache_miss_tokens")
                )

    return int(hit or 0), int(miss or 0)


class _LLMStats:
    """Bookkeeping mixin: counters, latency list, summary()."""

    def __init__(self) -> None:
        self._stats_lock = asyncio.Lock()
        self._latencies: list[float] = []
        self._prompt_tokens = 0
        self._completion_tokens = 0
        self._reasoning_tokens = 0
        self._cache_hit_tokens = 0
        self._cache_miss_tokens = 0
        self._calls = 0
        self._failures = 0
        self._usage_missing_calls = 0
        self.cache_bust = _cache_bust_enabled()
        self.model: str = ""  # subclass overwrites
        self.thinking: bool = False  # reasoning toggle; honored in _OpenAICompatLLM.chat

    def summary(self) -> dict:
        latencies = list(self._latencies)
        total_prompt_cache = self._cache_hit_tokens + self._cache_miss_tokens
        hit_ratio = (
            self._cache_hit_tokens / total_prompt_cache
            if total_prompt_cache > 0
            else None
        )
        return {
            "calls": self._calls,
            "failures": self._failures,
            "usage_missing_calls": self._usage_missing_calls,
            "wall_time_total_s": round(sum(latencies), 3),
            "wall_time_p50_s": round(_percentile(latencies, 50), 3),
            "wall_time_p95_s": round(_percentile(latencies, 95), 3),
            "wall_time_max_s": round(max(latencies) if latencies else 0.0, 3),
            "prompt_tokens": self._prompt_tokens,
            "completion_tokens": self._completion_tokens,
            "reasoning_tokens": self._reasoning_tokens,
            "cache_hit_tokens": self._cache_hit_tokens,
            "cache_miss_tokens": self._cache_miss_tokens,
            "cache_hit_ratio": round(hit_ratio, 4) if hit_ratio is not None else None,
            "cache_bust": self.cache_bust,
            "model": self.model,
        }


# ---------------------------------------------------------------------------
# LightLLM — abstract base. Concrete subclasses implement chat().
# ---------------------------------------------------------------------------


class LightLLM(_LLMStats):
    """Abstract base. Subclasses implement `async chat(messages, **kwargs)`.

    Kept as a public symbol so existing callers using it as a type hint
    (e.g. `llm: _LightLLM`) keep type-checking. Direct instantiation
    raises NotImplementedError — use `create_llm()` instead.
    """

    def __init__(self) -> None:
        super().__init__()

    async def chat(self, messages: list[dict], **kwargs) -> str:
        raise NotImplementedError(
            "LightLLM is abstract; instantiate via create_llm(provider)."
        )

    async def chat_stream(self, messages: list[dict], **kwargs) -> str:
        """Streaming variant — collects SSE chunks into a single string.
        Implementations must stream; there is no nonstreaming fallback."""
        raise NotImplementedError("A streaming text backend is required")

    async def chat_stream_with_continuation(
        self,
        messages: list[dict],
        *,
        max_continuation_rounds: int = 5,
        continuation_prompt: str = (
            "Continue writing from exactly where you left off. "
            "Do not repeat any already-generated content. "
            "Resume the LaTeX output directly."
        ),
        on_progress=None,
        **kwargs,
    ) -> str:
        """Streaming call with automatic continuation on max_tokens truncation.

        If the response is truncated (OpenAI reports this as
        finish_reason == "length"), re-calls with the accumulated output
        appended as an assistant message and a continuation user prompt,
        preserving the full original context each round.

        Default: falls back to chat_stream() (no continuation support);
        _OpenAICompatLLM overrides this with a real continuation loop.
        """
        return await self.chat_stream(messages, **kwargs)


# ---------------------------------------------------------------------------
# _OpenAICompatLLM — the one backend: OpenAI-protocol chat completions.
# ---------------------------------------------------------------------------


class _OpenAICompatLLM(LightLLM):
    """Lightweight async wrapper around AsyncOpenAI for the qwen gateway."""

    def __init__(
        self,
        model: str,
        base_url: str,
        api_key: str,
        *,
        timeout: float = 180.0,
        default_temperature: float = 0.2,
        default_max_tokens: int = 8000,
        max_retries: Optional[int] = None,
    ):
        super().__init__()
        from openai import AsyncOpenAI

        self.model = model
        self.base_url = base_url
        self.timeout = timeout
        self.default_temperature = default_temperature
        self.default_max_tokens = default_max_tokens
        # When max_retries is None we leave the SDK default in place; callers
        # that own a script-level retry loop pass 0 to disable the SDK's
        # internal retries and avoid compounding (LLM_RETRIES × SDK retries).
        client_kwargs: dict[str, Any] = {
            "base_url": base_url, "api_key": api_key, "timeout": timeout
        }
        if max_retries is not None:
            client_kwargs["max_retries"] = max_retries
        # 网关 Token 计量：注入 X-Deeprd-Session-id（env 缺失则不加，行为不变）
        _gw_headers = build_gateway_headers()
        if _gw_headers:
            client_kwargs["default_headers"] = _gw_headers
        self.async_client = AsyncOpenAI(**client_kwargs)

    def _create_kwargs(self, messages: list[dict], kwargs: dict) -> dict:
        """Assemble the request body shared by chat() and chat_stream().

        Only the keys listed here reach the API, so caller-private kwargs
        (`_capture`) cannot leak into the request.
        """
        if self.cache_bust:
            messages = [_make_nonce_message(), *messages]

        # Reasoning-mode toggle. When `self.thinking` is True we ask
        # the model to engage chain-of-thought via the documented extra_body
        # field; when False we explicitly disable it so the model doesn't
        # auto-engage reasoning on stages that expect direct answers.
        extra_body = dict(kwargs.get("extra_body") or {})
        if self.thinking:
            extra_body.setdefault("thinking", {"type": "enabled"})
        else:
            extra_body.setdefault("enable_thinking", False)

        create_kwargs: dict[str, Any] = {
            "model": kwargs.get("model", self.model),
            "messages": messages,
            "temperature": kwargs.get("temperature", self.default_temperature),
            "max_tokens": kwargs.get("max_tokens", self.default_max_tokens),
            "extra_body": extra_body,
        }
        # Forward JSON-mode when the caller requests it (e.g.
        # response_format={"type": "json_object"}); harmless when absent.
        if kwargs.get("response_format"):
            create_kwargs["response_format"] = kwargs["response_format"]
        from request_capacity import configured_check
        configured_check(create_kwargs["model"],create_kwargs["messages"],create_kwargs["max_tokens"])
        return create_kwargs

    async def _record_call(self, elapsed: float, usage: Any) -> None:
        """Fold one completed call into the shared stats counters."""
        prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
        reasoning_tokens = _read_reasoning_tokens(usage) if usage is not None else 0
        hit_tokens, miss_tokens = (
            _read_cache_tokens(usage) if usage is not None else (0, 0)
        )
        async with self._stats_lock:
            self._calls += 1
            self._usage_missing_calls += int(usage is None)
            self._latencies.append(elapsed)
            self._prompt_tokens += prompt_tokens
            self._completion_tokens += completion_tokens
            self._reasoning_tokens += reasoning_tokens
            self._cache_hit_tokens += hit_tokens
            self._cache_miss_tokens += miss_tokens

    async def _record_failure(self, elapsed: float, usage: Any = None) -> None:
        await self._record_call(elapsed, usage)
        async with self._stats_lock:
            self._failures += 1

    async def chat(self, messages: list[dict], **kwargs) -> str:
        """All text calls use SSE, including compatibility chat callers."""
        return await self.chat_stream(messages, **kwargs)

    async def chat_stream(self, messages: list[dict], **kwargs) -> str:
        """Streaming variant — accumulates SSE deltas into one string.

        SSE delivers incremental output when the server emits it, reducing idle
        timeout risk. A stalled provider can still hit the configured read timeout. `stream_options={"include_usage": True}` makes the
        gateway emit a final usage-only chunk; that chunk carries no `choices`,
        which is why the loop guards on `chunk.choices` before indexing it.

        Populates `_capture["finish_reason"]` — `"length"` means the model was
        cut off at max_tokens, which is what chat_stream_with_continuation
        keys off.
        """
        capture = kwargs.get("_capture")
        create_kwargs = self._create_kwargs(messages, kwargs)
        create_kwargs["stream"] = True
        create_kwargs["stream_options"] = {"include_usage": True}
        if isinstance(capture, dict):
            capture['request'] = create_kwargs
        raw_chunks = [] if kwargs.get('_capture_raw') else None

        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        usage = None
        finish_reason = None
        response_models = set()

        t0 = time.perf_counter()
        stream = None
        lifecycle = None
        failed = False
        try:
            stream = await self.async_client.chat.completions.create(**create_kwargs)
            from stream_lifecycle import StreamLifecycle
            lifecycle = StreamLifecycle(stream)
            async for chunk in stream:
                if raw_chunks is not None and hasattr(chunk, 'model_dump'):
                    raw_chunks.append(chunk.model_dump())
                if isinstance(getattr(chunk, "model", None), str):
                    response_models.add(chunk.model)
                if chunk.choices:
                    choice = chunk.choices[0]
                    delta = getattr(choice, "delta", None)
                    if delta is not None:
                        if delta.content:
                            content_parts.append(delta.content)
                            if kwargs.get("_on_chunk"): kwargs["_on_chunk"](delta.content)
                        reasoning = getattr(delta, "reasoning_content", None)
                        if reasoning:
                            reasoning_parts.append(reasoning)
                    if choice.finish_reason:
                        finish_reason = choice.finish_reason
                if getattr(chunk, "usage", None) is not None:
                    usage = chunk.usage
        except Exception:
            failed = True
            await self._record_failure(time.perf_counter() - t0, usage)
            raise
        finally:
            if isinstance(capture, dict):
                capture["partial_response"] = "".join(content_parts)
                capture["reasoning"] = "".join(reasoning_parts)
                capture["finish_reason"] = finish_reason
                capture["usage"] = usage.model_dump() if hasattr(usage, "model_dump") else None
                capture["response_models"] = sorted(response_models)
                if raw_chunks is not None:
                    capture['raw_chunks'] = raw_chunks
            if stream is not None:
                try:
                    if lifecycle is not None:await lifecycle.close()
                    else:await stream.close()
                except Exception:
                    if not failed:
                        await self._record_failure(time.perf_counter() - t0, usage)
                        raise

        if finish_reason != 'stop':
            await self._record_failure(time.perf_counter()-t0,usage)
            from generation_diagnostics import GenerationError
            raise GenerationError('OUTPUT_TRUNCATED' if finish_reason=='length' else 'STREAM_INTERRUPTED',
                                  'text stream did not finish normally',finish_reason=finish_reason)
        await self._record_call(time.perf_counter() - t0, usage)

        # One join beats repeated concatenation across thousands of deltas.
        return "".join(content_parts)

    async def chat_stream_with_continuation(
        self,
        messages: list[dict],
        *,
        max_continuation_rounds: int = 5,
        continuation_prompt: str = (
            "Continue writing from exactly where you left off. "
            "Do not repeat any already-generated content. "
            "Resume the LaTeX output directly."
        ),
        on_progress=None,
        **kwargs,
    ) -> str:
        """Stream, and resume automatically when the model hits max_tokens.

        The OpenAI protocol reports truncation as `finish_reason == "length"`.
        Each extra round re-sends the original context plus everything
        generated so far as an assistant turn, so the model continues rather
        than restarting. `on_progress(round_index, chars_so_far)` is called
        after every round when supplied.
        """
        caller_capture = kwargs.pop("_capture", None)
        capture: dict = {}
        accumulated = ""
        conversation = list(messages)

        for round_index in range(max_continuation_rounds + 1):
            from generation_diagnostics import GenerationError
            try:
                accumulated += await self.chat_stream(conversation, _capture=capture, **kwargs)
            except GenerationError as exc:
                if exc.code != 'OUTPUT_TRUNCATED':raise
                accumulated += capture.get('partial_response','')
                if round_index == max_continuation_rounds:
                    if isinstance(caller_capture,dict):caller_capture.update(capture,partial_response=accumulated)
                    raise
            if on_progress is not None:
                on_progress(round_index, len(accumulated))
            if capture.get("finish_reason") != "length":
                break
            conversation = [
                *messages,
                {"role": "assistant", "content": accumulated},
                {"role": "user", "content": continuation_prompt},
            ]

        if isinstance(caller_capture, dict):
            caller_capture.update(capture)
        return accumulated


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def create_llm(
    provider: Optional[str] = None,
    *,
    model: Optional[str] = None,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
    thinking: bool = False,
    timeout: float = 180.0,
    default_temperature: float = 0.2,
    default_max_tokens: int = 8000,
    max_retries: Optional[int] = None,
    workspace=None,
) -> LightLLM:
    """Instantiate the right backend wrapper based on the provider key.

    `provider="qwen"` → `_OpenAICompatLLM` (OpenAI SDK against the
    qwen3.8-max gateway). `provider=None` defaults to `"qwen"`.

    `model` and `base_url` fill fields from `BUILTIN_PROVIDERS[provider]`.
    `TEXT_BASE_URL` has final precedence over the supplied URL. The retained
    `api_key` parameter is ignored for compatibility: the credential always
    comes from `SCHOLARSEED_ACCOUNT_TOKEN`. `thinking` toggles reasoning mode via
    `extra_body`.

    `max_retries` controls the underlying SDK's *internal* retry count.
    Default `None` keeps the SDK default (currently 2) — existing callers and
    any caller without its own retry loop are unaffected. Callers that own a
    script-level retry loop (e.g. the generation-agent runners) pass `0` so a
    transient 504 / overload is not amplified by SDK retries on top of the
    script's own retries before the script's fallback kicks in.
    """
    from runtime_model_client import runtime_text_client
    runtime=runtime_text_client(model or BUILTIN_PROVIDERS.get(provider or 'qwen',{}).get('model') or 'qwen3.8-max',
        workspace=workspace,timeout=timeout,default_max_tokens=default_max_tokens,
        default_temperature=default_temperature,thinking=thinking)
    if runtime is not None:return runtime
    key = provider or "qwen"
    if key in BUILTIN_PROVIDERS:
        cfg = BUILTIN_PROVIDERS[key]
    elif base_url:
        # Unknown provider supplied with an explicit base_url from
        # model_config.json. Treat it as an OpenAI-compatible backend, so a
        # second gateway can be pointed at without a BUILTIN_PROVIDERS entry.
        cfg = {"backend": "openai"}
    else:
        raise ValueError(
            f"Unknown LLM provider: {provider!r} (and no base_url supplied to "
            f"treat it as an OpenAI-compatible endpoint). "
            f"Known: {list(BUILTIN_PROVIDERS)}"
        )
    backend = cfg.get("backend")

    eff_model = model or cfg.get("model")
    from endpoint_defaults import model_base
    eff_base_url = os.environ.get("TEXT_BASE_URL", "").strip() or base_url or cfg.get("base_url")

    if backend == "openai":
        # Deliberately ignore `api_key`: config/caller credentials must never
        # shadow the shared ScholarSeed account token.
        eff_base_url = model_base(eff_base_url)
        eff_api_key = os.environ.get("SCHOLARSEED_ACCOUNT_TOKEN", "").strip()
        if not eff_api_key:
            raise RuntimeError(
                f"No API token for provider {key!r}; set "
                "SCHOLARSEED_ACCOUNT_TOKEN before starting Codex."
            )
        instance = _OpenAICompatLLM(
            model=eff_model,
            base_url=eff_base_url,
            api_key=eff_api_key,
            timeout=timeout,
            default_temperature=default_temperature,
            default_max_tokens=default_max_tokens,
            max_retries=max_retries,
        )
        instance.thinking = bool(thinking)
        return instance


    raise ValueError(
        f"Provider {key!r} has unknown backend={backend!r}. Expected 'openai'."
    )
