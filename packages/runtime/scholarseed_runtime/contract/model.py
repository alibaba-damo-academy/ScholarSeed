"""Vendor-neutral model connection intent for external runtimes."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Mapping, Protocol


class ModelConnectionMode(str, Enum):
    NATIVE = "native"
    REMOTE = "remote"


class ModelWireProtocol(str, Enum):
    RESPONSES = "responses"
    CHAT_COMPLETIONS = "chat_completions"


class ModelToolProtocol(str, Enum):
    PROVIDER_NATIVE = "provider_native"
    JSON_SCHEMA = "json_schema"


@dataclass(frozen=True)
class ModelCapabilities:
    tool_protocol: ModelToolProtocol = ModelToolProtocol.PROVIDER_NATIVE
    input_modalities: tuple[str, ...] | None = None
    reasoning_efforts: tuple[str, ...] = ()


@dataclass(frozen=True)
class ModelCredential:
    """Ephemeral secret material; never persist or include in runtime evidence."""

    api_key: str = field(default="", repr=False)
    headers: Mapping[str, str] = field(default_factory=dict, repr=False)


class ModelCredentialPort(Protocol):
    """Resolve one opaque credential reference at session admission time."""

    async def resolve(self, credential_ref: str) -> ModelCredential: ...


@dataclass(frozen=True)
class ModelTransport:
    mode: ModelConnectionMode = ModelConnectionMode.NATIVE
    endpoint: str = ""
    wire_protocol: ModelWireProtocol = ModelWireProtocol.RESPONSES
    credential_ref: str = ""
    supports_websockets: bool = False
    # 出站传输的重试预算（产品按 endpoint 归属决定，``None`` 表示交给 runtime 默认）。
    # 这是厂商中立的「最多重试几次」提示：网关路自有重试+降级故设 0，BYOK 直连路无兜底
    # 故保留一次瞬时重连。具体配置键名与语义由 vendor adapter 落地，契约只携带预算值。
    stream_max_retries: int | None = None
    request_max_retries: int | None = None


@dataclass(frozen=True)
class ModelThinking:
    """厂商形态不是档位时用户的思考意图（开关 / token 预算）。

    与 ``ModelIntent.reasoning_effort`` **互斥**：某条坐标到底是哪种形态由能力声明决定，
    一次选择只会落在其中一个上，所以这不是同一事实的两份记录，而是一个和式的两个分支。
    ``None`` 表示这条坐标上没有任何思考形态（未声明即不发参数）。
    """

    enabled: bool | None = None
    budget: int | None = None


@dataclass(frozen=True)
class ModelIntent:
    """Product model selection without a Harness-specific provider table."""

    model_ref: str = ""
    revision: str = ""
    transport: ModelTransport = ModelTransport()
    context_window: int | None = None
    reasoning_effort: str = ""
    thinking: ModelThinking | None = None
    service_tier: str = ""
    capabilities: ModelCapabilities = ModelCapabilities()


__all__ = [
    "ModelCapabilities",
    "ModelToolProtocol",
    "ModelConnectionMode",
    "ModelCredential",
    "ModelCredentialPort",
    "ModelIntent",
    "ModelTransport",
    "ModelThinking",
    "ModelWireProtocol",
]
