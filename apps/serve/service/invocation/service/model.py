"""Domain records for isolated one-shot execution."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

# 一次性调用的默认档：调用方不写时按它跑，写别的值必须落在这条坐标声明的档位里
# （准入校验在 API schema 层，用能力层的唯一全集 ``REASONING_EFFORT_LEVELS``）。
DEFAULT_INVOCATION_REASONING_EFFORT = "low"


@dataclass(frozen=True)
class InvocationSkill:
    id: str
    profile: str | None = None


class InvocationSandbox(str, Enum):
    READ_ONLY = "read-only"
    WORKSPACE_WRITE = "workspace-write"
    DANGER_FULL_ACCESS = "danger-full-access"


@dataclass(frozen=True)
class InvocationExecution:
    web_search: bool = True
    sandbox: InvocationSandbox = InvocationSandbox.WORKSPACE_WRITE
    network_access: bool = True
    reasoning_effort: str | None = DEFAULT_INVOCATION_REASONING_EFFORT
    service_tier: str = "fast"


DEFAULT_INVOCATION_EXECUTION = InvocationExecution()


@dataclass(frozen=True)
class InvocationCommand:
    prompt: str
    skill: InvocationSkill | None
    developer_prompt: bool = True
    execution: InvocationExecution = DEFAULT_INVOCATION_EXECUTION


class InvocationStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    INTERRUPTED = "interrupted"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class InvocationArtifact:
    artifact_id: str
    relative_path: str
    role: str
    mime_type: str
    size_bytes: int
    content_sha256: str
    vendor_turn_id: str


@dataclass(frozen=True)
class InvocationRecord:
    invocation_id: str
    owner_id: str
    workspace: str
    status: InvocationStatus
    skill: dict[str, str] = field(default_factory=dict)
    execution: dict[str, str | bool] = field(default_factory=dict)
    artifacts: tuple[InvocationArtifact, ...] = ()
    model_key: str = ""
    output_text: str = ""
    error_code: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    vendor_thread_id: str = ""
    vendor_turn_id: str = ""


__all__ = [
    "InvocationArtifact",
    "InvocationCommand",
    "DEFAULT_INVOCATION_EXECUTION",
    "DEFAULT_INVOCATION_REASONING_EFFORT",
    "InvocationExecution",
    "InvocationRecord",
    "InvocationSandbox",
    "InvocationSkill",
    "InvocationStatus",
]
