"""Product runtime protocol.state ownership."""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from scholarseed_codex.protocol.session import (
    CodexSessionEventKind,
)
from scholarseed_runtime.contract.history import (
    MessagePhase,
    TurnStatus,
)
from scholarseed_runtime.contract.incident import (
    RuntimeRetryability,
)

CODEX_RUNTIME_ID = "codex"


class CodexActivationStage(str, Enum):
    PREPARE_LOCK_WAIT = "codex.prepare_lock_wait"
    LAUNCH_CREDENTIALS = "codex.launch_credentials"
    MODEL_CREDENTIALS = "codex.model_credentials"
    MODEL_CATALOG = "codex.model_catalog"
    READINESS = "codex.readiness"
    READINESS_LOCK_WAIT = "codex.readiness_lock_wait"
    READINESS_PROBE = "codex.readiness_probe"
    RESOURCE_WAIT = "codex.resource_wait"
    PROCESS_START = "codex.process_start_handshake"
    PROCESS_READY_WAIT = "codex.process_ready_wait"
    SESSION_OPEN = "codex.session_open"
    SESSION_RESUME = "codex.session_resume"


CODEX_DEFAULT_BIN = "codex"


CODEX_APP_SERVER_LISTEN = "stdio://"


CODEX_DEFAULT_CLIENT_NAME = "damoagent_surface"


CODEX_DEFAULT_CLIENT_TITLE = "DamoAgent Surface"


CODEX_DEFAULT_CLIENT_VERSION = "0.1.2"


CODEX_DEFAULT_SERVICE_NAME = "damoagent"


CODEX_DEFAULT_APPROVAL_POLICY = "on-request"


CODEX_DEFAULT_SANDBOX_MODE = "workspace-write"


CODEX_SANDBOX_MODES = ("read-only", "workspace-write", "danger-full-access")


CODEX_MULTI_AGENT_MODES = ("disabled", "custom", "explicitRequestOnly", "proactive")


CODEX_APPROVAL_POLICIES = ("untrusted", "on-request", "never")


CODEX_STREAM_LIMIT_BYTES = 16 * 1024 * 1024


CODEX_RPC_TIMEOUT_SECONDS = 30.0


AGENT_RUNTIME_STOP_TIMEOUT_SECONDS = 2.0


CODEX_PREFLIGHT_TIMEOUT_SECONDS = 10.0


CODEX_PREFLIGHT_OUTPUT_LIMIT_BYTES = 16 * 1024


# CLI 预检结论的缓存有效期。只用来折叠同一时间窗内的重复预检 —— 启动期主进程的健康闸
# 与渲染层各探一次 —— 取值远小于消费方既有的 30 秒就绪态轮询粒度, 所以不会让登录态比
# 现在更陈旧。
CODEX_READINESS_CACHE_TTL_SECONDS = 10.0


# 引用计数归零的 host 在被真正关闭前允许空闲的时长。技能盘点这类请求级控制句柄每次用完
# 都会把计数打到 0; 归零即杀进程意味着下一次盘点要重付一遍 codex 冷启 (实测 --version
# 约 0.7 秒, app-server 握手再加数百毫秒), 进程池对这条路径等于不存在。保留一段时间让
# 交互式连续操作命中热进程, 超时后再回收, 避免长期占着 node 进程不放。
CODEX_IDLE_HOST_TTL_SECONDS = 300.0


CODEX_MAX_DIAGNOSTIC_LINES = 200


CODEX_MAX_RUNTIME_EVIDENCE = 200


CODEX_RECOVERY_INITIAL_DELAY_SECONDS = 0.5


CODEX_RECOVERY_BACKOFF_MULTIPLIER = 2.0


CODEX_RECOVERY_MAX_DELAY_SECONDS = 8.0


CODEX_RECOVERY_JITTER_RATIO = 0.2


CODEX_MAX_RECOVERY_ATTEMPTS = 5


CODEX_MAX_CONCURRENT_THREAD_RESUMES = 4


CODEX_RECOVERY_TOTAL_TIMEOUT_SECONDS = 60.0


CODEX_DIAGNOSTIC_DIGEST_LENGTH = 12


CODEX_DIAGNOSTIC_ENCODING = "utf-8"


CODEX_STDERR_DIAGNOSTIC_CHANNEL = "stderr"


RPC_METHOD_NOT_FOUND = -32601
SANDBOX_EXECUTION_METHOD = "command/exec"


RPC_INVALID_PARAMS = -32602


CODEX_UNAVAILABLE_ERROR = "codex_executable_unavailable"

CODEX_APP_SERVER_ERROR = "codex_app_server_error"

CODEX_SUBMISSION_RETRY_STALE = "codex_submission_retry_stale"
CODEX_SUBMISSION_RETRY_EXPIRED = "codex_submission_retry_expired"
CODEX_SUBMISSION_CANCELLED = "codex_submission_cancelled"
CODEX_TRANSIENT_SUBMISSION_ERRORS = frozenset(
    {
        "runtime_transport_lost",
        "agent_runtime_exit",
        "codex_generation_changed",
        "codex_turn_not_submitted",
    }
)


CODEX_VERSION_ERROR = "codex_version_check_failed"


CODEX_PREFLIGHT_TIMEOUT_ERROR = "codex_preflight_timeout"


CODEX_VERSION_INCOMPATIBLE_ERROR = "codex_version_incompatible_upgrade_required"


CODEX_VERSION_UNPARSEABLE_ERROR = "codex_version_unparseable"


CODEX_UNTESTED_VERSION_WARNING = "codex_version_newer_than_tested"


CODEX_LAUNCH_ARGUMENT_INVALID_ERROR = "codex_launch_argument_invalid"


CODEX_LAUNCH_ARGUMENT_MISSING_ERROR = "codex_launch_argument_missing"


CODEX_SKILLS_EXTRA_ROOTS_SET_METHOD = "skills/extraRoots/set"


CODEX_THREAD_INJECT_ITEMS_METHOD = "thread/inject_items"


CODEX_FS_WATCH_METHOD = "fs/watch"


CODEX_FS_UNWATCH_METHOD = "fs/unwatch"


CODEX_FS_CHANGED_METHOD = "fs/changed"


CODEX_HISTORY_ROLE_USER = "user"


CODEX_HISTORY_ROLE_ASSISTANT = "assistant"


CODEX_WEB_SEARCH_ITEM_TYPE = "webSearch"


CODEX_COLLAB_TOOL_CALL_ITEM_TYPE = "collabAgentToolCall"


CODEX_SUB_AGENT_ACTIVITY_ITEM_TYPE = "subAgentActivity"


CODEX_AUTO_APPROVAL_NOTIFICATION_KINDS = {
    "item/autoApprovalReview/started": CodexSessionEventKind.NATIVE_ACTIVITY_STARTED,
    "item/autoApprovalReview/completed": CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED,
}


# 上游第三个自动审批通知（StrictReviewRequiredNotification: threadId/turnId/startedAtMs）。
# 它没有 started/completed 配对，也不带 reviewId，所以单独登记而不是塞进上面的映射。
CODEX_STRICT_REVIEW_NOTIFICATION = "autoApprovalReview/strictReviewRequired"


CODEX_DEDICATED_ITEM_TYPES = frozenset(
    {
        "agentMessage",
        "commandExecution",
        "contextCompaction",
        "dynamicToolCall",
        "fileChange",
        "mcpToolCall",
        "reasoning",
        "userMessage",
        CODEX_WEB_SEARCH_ITEM_TYPE,
    }
)


CODEX_SEARCH_NOTIFICATION_KINDS = {
    "webSearch/begin": CodexSessionEventKind.WEB_SEARCH_STARTED,
    "webSearch/end": CodexSessionEventKind.WEB_SEARCH_COMPLETED,
    "paperSearch/begin": CodexSessionEventKind.PAPER_SEARCH_STARTED,
    "paperSearch/end": CodexSessionEventKind.PAPER_SEARCH_COMPLETED,
}


def _redacted_diagnostic(channel: str, value: str) -> str:
    fingerprint = hashlib.sha256(value.encode(CODEX_DIAGNOSTIC_ENCODING)).hexdigest()[
        :CODEX_DIAGNOSTIC_DIGEST_LENGTH
    ]
    return f"{channel}:length={len(value)}:sha256={fingerprint}"


CODEX_BENIGN_NOTIFICATION_METHODS = {
    "account/login/completed",
    "account/rateLimits/updated",
    "account/updated",
    "app/list/updated",
    "command/exec/outputDelta",
    "configWarning",
    "deprecationNotice",
    "externalAgentConfig/import/completed",
    "externalAgentConfig/import/progress",
    "fuzzyFileSearch/sessionCompleted",
    "fuzzyFileSearch/sessionUpdated",
    "hook/completed",
    "hook/started",
    "model/safetyBuffering/updated",
    "model/verification",
    "process/exited",
    "process/outputDelta",
    "remoteControl/status/changed",
    "rawResponse/completed",
    "rawResponseItem/completed",
    "thread/archived",
    "thread/closed",
    "thread/deleted",
    "thread/environment/connected",
    "thread/environment/disconnected",
    "thread/goal/cleared",
    "thread/goal/updated",
    "thread/name/updated",
    "thread/realtime/closed",
    "thread/realtime/itemAdded",
    "thread/realtime/outputAudio/delta",
    "thread/realtime/sdp",
    "thread/realtime/started",
    "thread/realtime/transcript/delta",
    "thread/realtime/transcript/done",
    "thread/unarchived",
    "turn/moderationMetadata",
    "windows/worldWritableWarning",
}


CODEX_PROVIDER_INCIDENT_METHODS = frozenset({"error", "turn/completed"})


MCP_NOTIFICATION_PREFIX = "mcpServer/"


MCP_CONFIG_NOTIFICATION_PREFIX = "config/mcpServer/"


logger = logging.getLogger(__name__)


McpNotificationHandler = Callable[[str, Mapping[str, Any]], Awaitable[bool]]


class CodexProcessState(str, Enum):
    STOPPED = "stopped"
    STARTING = "starting"
    READY = "ready"
    CRASHED = "crashed"
    RECOVERY_PENDING = "recovery_pending"
    BACKOFF = "backoff"
    RECOVERING = "recovering"
    UNAVAILABLE = "unavailable"
    CLOSING = "closing"


class CodexThreadAttachmentState(str, Enum):
    ATTACHING = "attaching"
    ATTACHED = "attached"
    DETACHED = "detached"
    RECOVERY_PENDING = "recovery_pending"
    RESUMING = "resuming"
    BROKEN = "broken"
    CLOSED = "closed"


class AppServerError(RuntimeError):
    """An App Server process or JSON-RPC request failed."""

    def __init__(
        self,
        message: str,
        *,
        safe_error: str = CODEX_APP_SERVER_ERROR,
        method: str = "",
        generation: int = 0,
        rpc_code: int | None = None,
        rpc_latency_ms: int = 0,
        rpc_request_id: int | None = None,
        rpc_pid: int | None = None,
        native_reason: str = "",
        native_stage: str | None = None,
        native_code_type: str | None = None,
        native_code: int | None = None,
        retryability: RuntimeRetryability = RuntimeRetryability.USER_RETRYABLE,
        submission_not_applied: bool = False,
    ) -> None:
        super().__init__(message)
        self.safe_error = safe_error
        self.method = method
        self.generation = generation
        self.rpc_code = rpc_code
        self.rpc_latency_ms = rpc_latency_ms
        self.rpc_request_id = rpc_request_id
        self.rpc_pid = rpc_pid
        self.native_reason = native_reason
        self.native_stage = native_stage
        self.native_code_type = native_code_type
        self.native_code = native_code
        self.retryability = retryability
        self.submission_not_applied = submission_not_applied


def _message_phase(value: object) -> MessagePhase | None:
    try:
        return MessagePhase(str(value))
    except ValueError:
        return None


def _resolved_history_message_phase(
    value: object,
    *,
    item_index: int,
    final_agent_index: int | None,
    turn_status: str,
) -> MessagePhase:
    """Resolve the official nullable phase from a terminal turn's causal order."""

    phase = _message_phase(value)
    if phase is not None:
        return phase
    # The official App Server contract permits a null phase. A completed
    # turn's last assistant message is its answer; any earlier message or any
    # message from a non-completed turn is interim commentary.
    if turn_status == TurnStatus.COMPLETED.value and item_index == final_agent_index:
        return MessagePhase.FINAL_ANSWER
    return MessagePhase.COMMENTARY


def normalized_roots(roots: tuple[Path, ...]) -> tuple[str, ...]:
    """绝对化 + 去重 + 排序。集合语义, 顺序不携带信息。"""

    return tuple(
        sorted({str(Path(root).expanduser().resolve()) for root in roots if str(root).strip()})
    )


@dataclass(frozen=True)
class _PendingRequest:
    rpc_id: Any
    method: str
    thread_id: str
    turn_id: str
    item_id: str
    params: Mapping[str, Any]
    generation: int = 0
