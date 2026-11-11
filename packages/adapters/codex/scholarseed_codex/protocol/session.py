from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Awaitable, Callable, Mapping

from scholarseed_codex.protocol.mcp import JsonValue
from scholarseed_runtime.contract.evidence import NOOP_RUNTIME_TIMING, RuntimeTimingPort
from scholarseed_runtime.contract.history import TurnStatus
from scholarseed_runtime.contract.incident import RuntimeIncident
from scholarseed_runtime.contract.inventory import SkillPolicy

CODEX_DEFAULT_TURN_TIMEOUT_SECONDS = 12 * 60 * 60
CODEX_REASONING_SUMMARY_CONFIG = "model_reasoning_summary"
CODEX_REASONING_SUMMARY_AUTO = "auto"


class CodexApprovalReviewer(str, Enum):
    """Who reviews permission requests raised by an external runtime."""

    USER = "user"
    AUTO_REVIEW = "auto_review"


class CodexRuntimeStatus(str, Enum):
    READY = "ready"
    UNAVAILABLE = "unavailable"
    UNAUTHENTICATED = "unauthenticated"
    INCOMPATIBLE = "incompatible"
    ERROR = "error"


class CodexNativeActivityCategory(str, Enum):
    """Product-neutral presentation category for native runtime items."""

    COLLABORATION = "collaboration"
    MEDIA = "media"
    WAIT = "wait"
    MODE = "mode"
    OTHER = "other"


class CodexSessionEventKind(str, Enum):
    OPENED = "opened"
    ATTACHED = "attached"
    RESUMED = "resumed"
    INTERRUPTED = "interrupted"
    CLOSED = "closed"
    SNAPSHOT = "snapshot"
    TURN_STARTED = "turn_started"
    ASSISTANT_DELTA = "assistant_delta"
    ASSISTANT_COMPLETED = "assistant_completed"
    REASONING_DELTA = "reasoning_delta"
    REASONING_COMPLETED = "reasoning_completed"
    TOOL_STARTED = "tool_started"
    TOOL_PROGRESS = "tool_progress"
    TOOL_COMPLETED = "tool_completed"
    TOOL_SEARCH_STARTED = "tool_search_started"
    TOOL_SEARCH_COMPLETED = "tool_search_completed"
    WEB_SEARCH_STARTED = "web_search_started"
    WEB_SEARCH_COMPLETED = "web_search_completed"
    PAPER_SEARCH_STARTED = "paper_search_started"
    PAPER_SEARCH_COMPLETED = "paper_search_completed"
    SKILL_STARTED = "skill_started"
    SKILL_COMPLETED = "skill_completed"
    NATIVE_ACTIVITY_STARTED = "native_activity_started"
    NATIVE_ACTIVITY_COMPLETED = "native_activity_completed"
    SUBAGENT_ACTIVITY = "subagent_activity"
    FILE_CHANGED = "file_changed"
    PLAN_UPDATED = "plan_updated"
    PLAN_DELTA = "plan_delta"
    DIFF_UPDATED = "diff_updated"
    HIL_REQUESTED = "hil_requested"
    HIL_RESOLVED = "hil_resolved"
    HIL_STALE = "hil_stale"
    DYNAMIC_TOOL_REQUESTED = "dynamic_tool_requested"
    USAGE_UPDATED = "usage_updated"
    CONTEXT_COMPACTED = "context_compacted"
    MAILBOX_CONSUMED = "mailbox_consumed"
    TURN_COMPLETED = "turn_completed"
    TURN_FAILED = "turn_failed"
    TURN_INTERRUPTED = "turn_interrupted"
    RUNTIME_ERROR = "runtime_error"
    RUNTIME_STATUS = "runtime_status"
    RUNTIME_WARNING = "runtime_warning"
    RUNTIME_INCIDENT = "runtime_incident"
    TURN_UNKNOWN = "turn_unknown"
    MODEL_REROUTED = "model_rerouted"
    TITLE_UPDATED = "title_updated"
    SKILLS_CHANGED = "skills_changed"
    MCP_EVENT = "mcp_event"


@dataclass(frozen=True)
class CodexRuntimeIdentity:
    client_name: str = ""
    client_title: str = ""
    client_version: str = ""
    service_name: str = ""


CODEX_MANAGED_IDENTITY = CodexRuntimeIdentity(
    client_name="scholarseed_desktop",
    client_title="书深",
    service_name="scholarseed",
)


@dataclass(frozen=True)
class CodexRuntimeLaunchArgument:
    """One optional process argument supplied by a surface consumer.

    ``option`` is emitted first. Its value can be a literal ``value`` or can
    be resolved from ``environment`` at process-launch time. An environment
    backed argument is omitted when the variable is absent unless ``required``
    is true. The runtime owns only this generic launch contract; products own
    the concrete option and environment names they project into it.
    """

    option: str = ""
    value: str = ""
    environment: str = ""
    required: bool = False


@dataclass(frozen=True)
class CodexRuntimeReadiness:
    runtime_id: str
    status: CodexRuntimeStatus
    ready: bool
    executable: str = ""
    version: str = ""
    authenticated: bool | None = None
    process_state: str = ""
    safe_error: str = ""
    warning: str = ""
    process_generation: int = 0
    recovery_attempt: int = 0
    max_recovery_attempts: int = 0


@dataclass(frozen=True)
class CodexDynamicTool:
    name: str
    description: str
    input_schema: Mapping[str, JsonValue] = field(default_factory=dict)
    defer_loading: bool = False


@dataclass(frozen=True)
class CodexUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0


@dataclass(frozen=True)
class CodexTurnResult:
    turn_id: str
    status: TurnStatus
    turn_count: int = 1
    final_text: str = ""
    error: str = ""
    usage: CodexUsage = field(default_factory=CodexUsage)


@dataclass(frozen=True)
class CodexToolResponse:
    success: bool
    content_items: tuple[Mapping[str, JsonValue], ...] = ()


@dataclass(frozen=True)
class CodexSessionEvent:
    runtime_id: str
    session_id: str
    kind: CodexSessionEventKind
    turn_id: str = ""
    item_id: str = ""
    vendor_seq: int = 0
    payload: Mapping[str, JsonValue] = field(default_factory=dict)
    created_at: str | None = None
    incident: RuntimeIncident | None = None


@dataclass(frozen=True)
class CodexSessionOpenRequest:
    request_id: str
    runtime_id: str
    cwd: Path
    resume_session_id: str = ""
    fork_session_id: str = ""
    fork_turn_id: str = ""
    model: str = ""
    model_provider: str = ""
    thread_config: Mapping[str, JsonValue] = field(default_factory=dict)
    process_environment: Mapping[str, str] = field(default_factory=dict)
    remove_environment: tuple[str, ...] = ()
    launch_arguments: tuple[CodexRuntimeLaunchArgument, ...] = ()
    provider_configuration: Mapping[str, JsonValue] = field(default_factory=dict, repr=False)
    sandbox: str = ""
    permissions_profile: str = ""
    approval_policy: str = ""
    approval_reviewer: CodexApprovalReviewer | None = None
    multi_agent_mode: str = ""
    executable: str = ""
    timeout_seconds: float = CODEX_DEFAULT_TURN_TIMEOUT_SECONDS
    identity: CodexRuntimeIdentity = field(default_factory=CodexRuntimeIdentity)
    base_instructions: str = ""
    developer_instructions: str = ""
    dynamic_tools: tuple[CodexDynamicTool, ...] = ()
    skill_roots: tuple[Path, ...] = ()
    #: 除 cwd 之外允许写入的绝对根 (产品侧显式授权的目录)。
    #: 只是**初始值**: 授权可以在会话存续期间增删, 当前集合由 runtime 持有,
    #: 每个 turn 重新下发, 因此变更无需重开 thread。
    writable_roots: tuple[Path, ...] = ()
    network_access: bool = False
    created_at: str | None = None
    ephemeral: bool = False
    skill_policy: SkillPolicy = SkillPolicy.INHERIT
    execution_scope: str = ""
    timing: RuntimeTimingPort = field(default=NOOP_RUNTIME_TIMING, compare=False, repr=False)
    process_sharing_scope: str = field(default="", repr=False)
    isolation_scope: str = field(default="", repr=False)
    launch_cwd: Path | None = None


CodexSessionEventObserver = Callable[[CodexSessionEvent], Awaitable[None] | None]
