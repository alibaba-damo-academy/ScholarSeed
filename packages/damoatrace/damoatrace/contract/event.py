"""proto/trace/event.py — trace 注入面协议 + 事件词汇 (Evidence Contract; 01 §5.1)。

两族契约 (都零逻辑):
- **注入面协议** (`Span`/`Tracer`/`LogSink`/`MetricSink`): tracer 门面, refact/01 A.5。
- **事件词汇** (`EventKind`/`TraceName`/`ComponentId`/`UsageKey`): 跨 core/work/service/tracekit
  共享的可观测词汇 (event/record 形状在 `record.py`, 失败分类在 `error.py`)。
"""

from __future__ import annotations

from enum import Enum, StrEnum
from types import TracebackType
from typing import Any, Dict, Optional, Protocol, Type, runtime_checkable


@runtime_checkable
class Span(Protocol):
    span_id: str
    parent_span_id: str | None
    name: str
    status: str

    def set(self, **fields: Any) -> None: ...
    def event(self, name: str, **fields: Any) -> None: ...
    def __enter__(self) -> "Span": ...
    def __exit__(self, *exc: Any) -> None: ...
    async def __aenter__(self) -> "Span": ...
    async def __aexit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> Optional[bool]: ...
    def set_attribute(self, key: str, value: Any) -> None: ...
    def set_attributes(self, attrs: Dict[str, Any]) -> None: ...
    def set_usage(self, usage: Dict[str, int]) -> None: ...
    def set_inputs(self, inputs: Dict[str, Any]) -> None: ...
    def set_outputs(self, outputs: Dict[str, Any]) -> None: ...
    def set_error(self, error: BaseException) -> None: ...


@runtime_checkable
class Tracer(Protocol):
    def span(self, name: str, *, kind: str, **fields: Any) -> Span: ...
    def start_span(
        self,
        *,
        kind: str,
        name: str,
        task_run_id: str,
        component_id: Optional[str] = None,
        parent_span_id: Optional[str] = None,
        attributes: Optional[Dict[str, Any]] = None,
    ) -> Span: ...
    def emit_event(
        self,
        *,
        kind: str,
        name: str,
        task_run_id: str,
        component_id: Optional[str] = None,
        attributes: Optional[Dict[str, Any]] = None,
    ) -> None: ...


@runtime_checkable
class LogSink(Protocol):
    def emit(
        self, level: str, event: str, *, span_id: str | None = None, **fields: Any
    ) -> None: ...


@runtime_checkable
class MetricSink(Protocol):
    def counter(self, name: str, value: float = 1, **labels: Any) -> None: ...
    def timing(self, name: str, ms: float, **labels: Any) -> None: ...


# ─── trace 事件词汇 (kind / name / component / usage) ───
class EventKind(str, Enum):
    """trace 事件类别 (design §2)。与 `proto.kernel.event.EventKind` (流式项类别) 不同名域。"""

    # 任务/对话级
    TASK_START = "task.start"
    TASK_END = "task.end"
    USER_MESSAGE = "user.message"
    AGENT_RESPONSE = "agent.response"
    RUN_OUTCOME = "run.outcome"  # ★Phase0 (06 §8.1): run 成败标签

    # Turn 级
    TURN_START = "turn.start"
    TURN_END = "turn.end"

    # LLM
    LLM_STREAM = "llm.stream"
    SIDE_QUERY = "side.query"

    # Tool
    TOOL_DISPATCH = "tool.dispatch"
    TOOL_EXEC = "tool.exec"
    TOOL_RELOAD = "tool.reload"

    # Memory
    MEMORY_RECALL = "memory.recall"
    MEMORY_WRITE = "memory.write"
    MEMORY_INJECT = "memory.inject"

    # Prompt
    PROMPT_STAGE = "prompt.stage"
    PROMPT_BLOCK = "prompt.block"
    CONTEXT_COMPACT = "context.compact"

    # Policy + HIL
    POLICY_DECIDE = "policy.decide"
    POLICY_RULE_ADDED = "policy.rule.added"
    HIL_REQUEST = "hil.request"
    HIL_RESPONSE = "hil.response"

    # Mode
    MODE_TRANSITION = "mode.transition"

    # Evolve
    EVOLVE_SIGNAL = "evolve.signal"
    EVOLVE_WRITE = "evolve.write"

    # Hook / Middleware
    HOOK_FIRE = "hook.fire"
    MIDDLEWARE_RUN = "middleware.run"

    # Subagent lifecycle
    SUBAGENT_START = "subagent.start"
    SUBAGENT_STOP = "subagent.stop"

    # Channel
    CHANNEL_RECEIVE = "channel.receive"
    CHANNEL_SEND = "channel.send"

    # Cache / Backend
    CACHE_HIT = "cache.hit"
    CACHE_MISS = "cache.miss"
    BACKEND_FALLBACK = "backend.fallback"

    # Reminder
    REMINDER_REGISTERED = "reminder.registered"
    REMINDER_EXPIRED = "reminder.expired"
    REMINDER_INJECTED = "reminder.injected"


class TraceName(StrEnum):
    """trace 事件 `name` 的统一常量。静态名直接用成员; 动态名用成员做前缀 f-string 拼后缀。"""

    # ── 静态名 (整名即成员) ──
    AGENT_RUN = "agent.run"
    USER_MESSAGE = "user.message"
    AGENT_RESPONSE = "agent.response"
    RUN_OUTCOME = "run.outcome"
    COMPACT_RUN = "compact.run"
    PRECOMPACT_BLOCKED = "precompact.blocked"
    CONTEXT_COMPACT = "context.compact"
    PROMPT_PIPELINE_ERROR = "prompt_pipeline_error"
    TOOL_DISPATCH = "tool.dispatch"
    EVOLVE_WRITE = "evolve.write"
    WATCH_ERROR = "watch.error"
    MONITOR_EVENT = "monitor_event"

    # ── 动态前缀 (f"{成员}.{x}" 或 f"{成员}:{x}") ──
    TURN = "turn"
    LLM = "llm"
    TOOL = "tool"
    POLICY = "policy"
    POLICY_SANDBOX_ONLY = "policy.sandbox_only"
    POLICY_RULE_ADDED = "policy.rule.added"
    SUBAGENT_START = "subagent.start"
    SUBAGENT_STOP = "subagent.stop"
    MODE_TRANSITION = "mode.transition"
    PROMPT_STAGE = "prompt.stage"
    ASSEMBLE = "assemble"
    CTXPROC = "ctxproc"
    HOOK = "hook"
    MIDDLEWARE = "middleware"
    EVOLVE_GATE = "evolve.gate"
    RELOAD = "reload"
    WATCH = "watch"
    WAKE_FIRE = "wake.fire"
    WAKE_THROTTLED = "wake.throttled"
    WAKE_ERROR = "wake.error"
    MEMORY_BG = "memory.bg"
    CRON_FIRE = "cron.fire"
    CRON_DONE = "cron.done"


class ComponentId(StrEnum):
    """trace 事件 `component_id` 的统一常量。发事件组件的身份标识。"""

    AGENT_CORE = "AgentCore"
    MODE_MANAGER = "ModeManager"
    HUMAN_BROKER = "HumanBroker"
    CONTEXT_PIPELINE = "ContextPipeline"
    SCHEDULER_ENGINE = "SchedulerEngine"
    MAILBOX_WAKE_DRIVER = "MailboxWakeDriver"
    ASSEMBLE_RUNTIME = "assemble_runtime"
    CHANNEL_CLI = "channel:cli"
    EVOLVE_ORCHESTRATOR = "evolve:orchestrator@1.0.0"
    EVOLVE_VALIDATION_GATE = "evolve:validation_gate@1.0.0"
    EVOLVE_FILE_WATCHER = "evolve:file_watcher@1.0.0"
    LLM_LIVE_COMPACT = "llm:livecompactprovider@1.0.0"


class UsageKey(StrEnum):
    """token usage 字典键的统一常量。StrEnum 成员即 str, 可直接作 dict 键。"""

    INPUT = "input_tokens"
    OUTPUT = "output_tokens"
    CACHE_READ = "cache_read_tokens"
    CACHE_CREATION = "cache_creation_tokens"
    PROMPT_CONTEXT = "prompt_context_tokens"

    @classmethod
    def zero(cls) -> dict:
        return {cls.INPUT: 0, cls.OUTPUT: 0, cls.CACHE_READ: 0, cls.CACHE_CREATION: 0}
