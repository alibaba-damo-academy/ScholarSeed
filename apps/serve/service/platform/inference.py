"""Non-session model invocation contracts shared by Serve domains.

These records deliberately contain no gateway URL, credential, Session, or persistence
logic. Product features submit a named purpose and explicit input to the registered
tool-free model transport. It does not open an Agent runtime, create a product Chat
Session, or inherit current chat history. Tool-bearing tasks use the invocation domain.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Awaitable, Callable, Mapping, Protocol, runtime_checkable

TOOL_FREE_UNSUPPORTED = "tool_free_generation_unsupported"


class ModelInvocationStatus(str, Enum):
    """Durable lifecycle of one independently metered model attempt."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"


class ReasoningPolicy(str, Enum):
    """Latency preference: use supported controls, otherwise provider defaults.

    Keep the existing wire value for persisted requests.
    """

    DEFAULT = "default"
    LOW_LATENCY = "disabled_or_subscription_minimum"


class ModelInvocationEventKind(str, Enum):
    ACCEPTED = "accepted"
    STARTED = "started"
    OUTPUT_DELTA = "output_delta"
    OUTPUT_COMPLETED = "output_completed"


@dataclass(frozen=True)
class ModelInvocationEvent:
    """Public document-action activity, without native frames or reasoning."""

    invocation_id: str
    kind: ModelInvocationEventKind
    text: str = ""
    item_id: str = ""


ModelInvocationObserver = Callable[[ModelInvocationEvent], Awaitable[None]]


@dataclass(frozen=True)
class ModelInvocationLimits:
    """Input admission bound and requested output budget (runtime support varies)."""

    max_input_chars: int
    max_output_tokens: int


@dataclass(frozen=True)
class ModelAttachment:
    """Invocation-owned inline input; never persisted in the task ledger."""

    media_type: str
    data: str
    name: str = ""


@dataclass(frozen=True)
class ModelInvocationRequest:
    """One compiled action that has no product Chat Session."""

    invocation_id: str
    owner_id: str
    project_id: str
    purpose: str
    model_key: str
    instructions: str
    input_text: str
    limits: ModelInvocationLimits
    trace_attributes: Mapping[str, str] = field(default_factory=dict)
    attachments: tuple[ModelAttachment, ...] = ()
    json_output: bool = False
    reasoning_policy: ReasoningPolicy = ReasoningPolicy.DEFAULT
    require_tool_free: bool = False


@dataclass(frozen=True)
class ModelInvocationUsage:
    """Provider-reported usage; zero means unavailable, not free."""

    input_tokens: int = 0
    output_tokens: int = 0
    receipt_id: str = ""


@dataclass(frozen=True)
class ModelInvocationResult:
    """Safe final or reconcilable state returned by the provider."""

    invocation_id: str
    status: ModelInvocationStatus
    model_key: str = ""
    output_text: str = ""
    usage: ModelInvocationUsage = field(default_factory=ModelInvocationUsage)
    error_code: str = ""
    error_detail: str = ""


@runtime_checkable
class OneShotModelProvider(Protocol):
    """Port implemented by a real independently metered model transport."""

    def available(self) -> bool: ...

    async def invoke(
        self, request: ModelInvocationRequest, *, observer: ModelInvocationObserver | None = None
    ) -> ModelInvocationResult: ...

    async def cancel(self, *, invocation_id: str, owner_id: str) -> ModelInvocationResult: ...


__all__ = [
    "ModelInvocationLimits",
    "ModelInvocationRequest",
    "ModelInvocationResult",
    "ModelInvocationStatus",
    "ModelInvocationUsage",
    "OneShotModelProvider",
]
