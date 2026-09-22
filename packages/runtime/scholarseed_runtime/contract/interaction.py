"""Typed bidirectional callback contracts for runtime HIL requests."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from scholarseed_runtime.contract.event import RuntimeValue


class CallbackAudience(str, Enum):
    USER = "user"
    SERVICE = "service"


class CallbackKind(str, Enum):
    COMMAND_APPROVAL = "command_approval"
    FILE_APPROVAL = "file_approval"
    USER_INPUT = "user_input"
    PERMISSION = "permission"
    ELICITATION = "elicitation"
    DYNAMIC_TOOL = "dynamic_tool"
    ATTESTATION = "attestation"
    CURRENT_TIME = "current_time"


@dataclass(frozen=True)
class RuntimeCallbackRequest:
    schema_version: int
    runtime_id: str
    product_session_id: str
    native_session_id: str
    request_id: str
    audience: CallbackAudience
    kind: CallbackKind
    blocking: bool
    prompt: RuntimeValue
    response_contract: RuntimeValue
    observed_at: str
    native_turn_id: str = ""
    native_item_id: str = ""
    allowed_decisions: tuple[str, ...] = ()
    deadline: str = ""
    evidence_ref: str = ""


@dataclass(frozen=True)
class RuntimeCallbackResponse:
    request_id: str
    decision: str
    values: RuntimeValue
    idempotency_key: str
    responded_at: str


__all__ = [
    "CallbackAudience",
    "CallbackKind",
    "RuntimeCallbackRequest",
    "RuntimeCallbackResponse",
]
