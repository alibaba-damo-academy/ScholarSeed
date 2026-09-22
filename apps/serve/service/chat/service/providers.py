"""Preset endpoint declarations for user-owned model connections (BYOK).

These are **form hints**, not product egress: the product never contacts any of them
on its own. A preset only becomes a real request after the user picks it, supplies
their own credential, and activates the resulting connection.

Adding a vendor is adding one declaration below — no branch anywhere reads a specific
``id``. Every ``base_url`` host here must also be registered in
``wiki/architecture/network.md`` §2.1; the contract gate enforces that.

Vendor knowledge is product-level, so it lives in Serve rather than in DamoAgent: the
runtime contract package must not learn about "DashScope" or "OpenRouter".
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from scholarseed_runtime.contract import ModelWireProtocol

CUSTOM_PROVIDER_ID = "custom"
LOCAL_CREDENTIAL_HINT = "本地服务通常不校验凭据，可填任意值（例如 ollama）"


@dataclass(frozen=True)
class PresetProvider:
    """One selectable endpoint preset shown in the connection editor."""

    id: str
    label: str
    base_url: str
    wire_api: str
    note: str = ""
    credential_hint: str = ""
    capability_registry: bool = False


# Anthropic is deliberately absent: it has no OpenAI-compatible surface, so it needs the
# Responses→Messages translation leg (proposal 51 P3). Shipping an entry that always
# fails is worse than shipping none.
PRESET_PROVIDERS: tuple[PresetProvider, ...] = (
    PresetProvider(
        id="dashscope",
        label="阿里云百炼",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        wire_api=ModelWireProtocol.CHAT_COMPLETIONS.value,
        credential_hint="在百炼控制台创建 API-KEY",
        capability_registry=True,
    ),
    PresetProvider(
        id="dashscope-token-plan",
        label="阿里云百炼 Token Plan（个人版）",
        base_url="https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        wire_api=ModelWireProtocol.CHAT_COMPLETIONS.value,
        credential_hint="在百炼 Token Plan 个人版控制台生成 API Key（sk-sp- 开头）",
        capability_registry=True,
    ),
    PresetProvider(
        id="dashscope-token-plan-team",
        label="阿里云百炼 Token Plan（团队版）",
        base_url="https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        wire_api=ModelWireProtocol.CHAT_COMPLETIONS.value,
        credential_hint="在百炼 Token Plan 团队版控制台生成 API Key",
        capability_registry=True,
    ),
    PresetProvider(
        id="openai",
        label="OpenAI",
        base_url="https://api.openai.com/v1",
        wire_api=ModelWireProtocol.CHAT_COMPLETIONS.value,
        note="该端点也实现 Responses 协议，可在下方切换",
        credential_hint="在 OpenAI 平台的 API keys 页创建",
        capability_registry=True,
    ),
    PresetProvider(
        id="google",
        label="Google Gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        wire_api=ModelWireProtocol.CHAT_COMPLETIONS.value,
        note="这是 Gemini 的 OpenAI 兼容面；原生 Gemini 协议暂不支持",
        credential_hint="使用 Google AI Studio 的 API key",
        capability_registry=True,
    ),
    PresetProvider(
        id="deepseek",
        label="DeepSeek",
        base_url="https://api.deepseek.com/v1",
        wire_api=ModelWireProtocol.CHAT_COMPLETIONS.value,
        credential_hint="在 DeepSeek 开放平台创建 API key",
        capability_registry=True,
    ),
    PresetProvider(
        id="moonshot",
        label="Moonshot（Kimi）",
        base_url="https://api.moonshot.cn/v1",
        wire_api=ModelWireProtocol.CHAT_COMPLETIONS.value,
        credential_hint="在 Moonshot 开放平台创建 API key",
        capability_registry=True,
    ),
    PresetProvider(
        id="zhipu",
        label="智谱 GLM",
        base_url="https://open.bigmodel.cn/api/paas/v4",
        wire_api=ModelWireProtocol.CHAT_COMPLETIONS.value,
        credential_hint="在智谱开放平台创建 API key",
        capability_registry=True,
    ),
    PresetProvider(
        id="openrouter",
        label="OpenRouter",
        base_url="https://openrouter.ai/api/v1",
        wire_api=ModelWireProtocol.CHAT_COMPLETIONS.value,
        note="聚合多家模型，拉取后的候选列表很长，可搜索筛选",
        credential_hint="在 OpenRouter 控制台创建 API key",
    ),
    PresetProvider(
        id="ollama",
        label="本地 Ollama / vLLM",
        base_url="http://127.0.0.1:11434/v1",
        wire_api=ModelWireProtocol.CHAT_COMPLETIONS.value,
        note="请求不出本机；vLLM 等其它本地服务改一下端口即可",
        credential_hint=LOCAL_CREDENTIAL_HINT,
    ),
)


def preset_providers() -> list[dict[str, Any]]:
    """Project the presets for the connection editor.

    Nothing here is secret, so the projection is the declaration itself; keeping it a
    function (rather than exposing the tuple) leaves one place to filter from if a
    preset ever becomes conditional.
    """

    rows = [asdict(provider) for provider in PRESET_PROVIDERS]
    for row in rows:
        row.pop("capability_registry", None)
    return rows


def preset_provider_labels() -> dict[str, str]:
    """Map a preset id onto the vendor name a user recognises.

    A saved connection only declares *which* preset it came from; turning that into
    「阿里云百炼」 for the model menu is vendor knowledge, so it stays with the table.
    """

    return {provider.id: provider.label for provider in PRESET_PROVIDERS}


def uses_vendor_capability_registry(base_url: str) -> bool:
    """Whether an endpoint is an exact first-party preset with verified model semantics."""

    endpoint = str(base_url or "").strip().rstrip("/").lower()
    return any(
        provider.capability_registry and provider.base_url.rstrip("/").lower() == endpoint
        for provider in PRESET_PROVIDERS
    )
