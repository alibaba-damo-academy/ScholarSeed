"""Product session lifecycle on top of the runtime gateway."""

from __future__ import annotations

import asyncio
import builtins
import json
import logging
import mimetypes
import os
import sqlite3
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import asdict, is_dataclass
from enum import Enum
from hashlib import sha256
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from scholarseed_runtime.contract import (
    AppliedState,
    CapabilityState,
    CommandState,
    ModelThinking,
    RuntimeCapabilityName,
    RuntimeConfigurationIntent,
    RuntimeControlKind,
    RuntimeControlRequest,
    RuntimePermissionMode,
)
from scholarseed_runtime.contract.history import MessagePhase
from scholarseed_runtime.contract.input import InputKind
from scholarseed_runtime.contract.mcp import McpTrustDecision
from scholarseed_runtime.contract.permission import PermissionUpdatePreview, PermissionUpdateScope
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_BUSY,
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    RESOURCE_HOST_CONTEXT_REQUIRED,
    ResourcePurpose,
)
from scholarseed_runtime.contract.session import (
    RUNTIME_CONFIRMATION_STALE,
    TurnConfirmationReceipt,
    TurnConfirmationTarget,
)
from service.capabilities.domain import COMPONENT_ANSWER_CAPABILITY
from service.capabilities.service.delivery import INSTALLATION_FIELD
from service.capabilities.service.descriptor import (
    ComponentValidationError,
    validate_component_submission,
)
from service.capabilities.service.plugins import component_action
from service.capabilities.service.presentation import PLUGIN_COMPONENT_STALE
from service.chat.constants import (
    ASK_PERMISSION_MODE,
    AUTOMATIC_CRASH_RETRY,
    BYPASS_PERMISSION_MODE,
    HIL_STATE_STALE,
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_SESSION_TITLE_UPDATED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_REFERENCE_FILE,
    PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE,
    PRODUCT_SESSION_STATE_INTERRUPTED,
    PRODUCT_TURN_OUTCOME_COMPLETED,
    PRODUCT_TURN_OUTCOME_INTERRUPTED,
    PRODUCT_TURN_OUTCOME_UNKNOWN,
    RUNTIME_CAPABILITY_UNAVAILABLE,
    SAFE_AUTO_PERMISSION_MODE,
    SESSION_ARCHIVE_POLL_SECONDS,
    SESSION_ARCHIVE_STOP_FAILED,
    SESSION_ARCHIVE_STOP_TIMEOUT_SECONDS,
    SESSION_ARCHIVED_ERROR,
    SESSION_DELETE_STOP_FAILED,
    SESSION_PROJECT_NOT_AUTHORIZED_ERROR,
    SESSION_PROJECT_NOT_REGISTERED_ERROR,
    SESSION_RECOVERY_INTERRUPT_REASON,
    SESSION_RELOCATE_FAILED_ERROR,
    SESSION_RELOCATE_REQUIRES_TURN_ERROR,
    SESSION_RELOCATE_STOP_FAILED_ERROR,
    SESSION_RELOCATE_STOP_PENDING_ERROR,
    SESSION_RELOCATE_STOP_POLL_SECONDS,
    SESSION_RELOCATE_STOP_TIMEOUT_SECONDS,
    SESSION_RENAME_MAX_LENGTH,
    SESSION_RUNNING_ERROR,
    SESSION_TERMINATED,
    SESSION_TITLE_DEFAULT,
    TURN_UNKNOWN_CONFIRM_DECISION,
    TURN_UNKNOWN_CONFIRM_INVALID,
    TURN_UNKNOWN_NOT_FOUND,
    SessionTitleFallback,
)
from service.chat.persistence.artifacts import ArtifactStatus, SessionArtifactStore
from service.chat.persistence.catalog import (
    LEGACY_RUNTIME_ID,
    UNCERTAINTY_CONFIRMATION_KEY,
    HilStatus,
    OpenState,
    SessionAccessError,
    SessionCatalogRecord,
    SessionCatalogStore,
    SessionHilRecord,
    SessionListScope,
    SessionModelState,
    SessionPrincipal,
    SessionStateConflictError,
    SessionStatus,
    UncertaintyKind,
    UncertaintyState,
)
from service.chat.persistence.events import (
    SESSION_FORK_EVENT,
    SESSION_FORK_IMPORTED_KEY,
    SESSION_FORK_KEY,
    SESSION_FORK_SOURCE_CHANGED,
    WORKSPACE_BOUND_EVENT,
    WORKSPACE_ORIGIN_UNAVAILABLE,
    ProductEventRecord,
    ProductEventStore,
)
from service.chat.runtime.activation import ResourceWaitObserver
from service.chat.runtime.composition import LiveSessionService
from service.chat.runtime.interaction import (
    BROWSER_APPROVAL_METHOD,
    BROWSER_HISTORY_APPROVAL_METHOD,
    PRODUCT_USER_INPUT_METHOD,
    USER_INPUT_METHOD,
    interaction_snapshot,
)
from service.chat.runtime.live import LiveSession
from service.chat.runtime.projection import (
    artifact_snapshot_payload,
    queued_message_payload,
    readiness_payload,
    runtime_capabilities_payload,
    runtime_payload,
    thinking_payload,
)
from service.chat.runtime.reconfiguration import (
    PREPARATION_INSTANCE_CHANGED,
    RECONFIGURATION_STALE,
    PreparationError,
)
from service.chat.schema import thinking_from_payload
from service.chat.service.handoff import (
    CONTINUATION_BUSY,
    CONTINUATION_MAX_SOURCE_BYTES,
    CONTINUATION_MAX_SOURCE_EVENTS,
    CONTINUATION_MODEL_UNAVAILABLE,
    CONTINUATION_STALE,
    CONTINUATION_UNAVAILABLE,
    continuation_snapshot,
)
from service.chat.service.models import RETIRED_NATIVE_MODEL_KEY, SessionModelUnavailableError
from service.chat.service.settings import SettingsService
from service.chat.service.workspaces import SessionWorkspaceService
from service.chat.utils import parse_session_list_cursor, session_list_cursor
from service.identity.service.skill_credentials import (
    CredentialAdmissionError,
    SkillCredentialService,
)
from service.paths import (
    SESSION_ATTACHMENT_DIRNAME,
    SESSION_OUTPUT_DIRNAME,
    SESSION_RUNTIME_DIR,
)
from service.platform.activity import (
    Activities,
    ActivityDomain,
    ActivityPhase,
    MaintenanceActive,
    MaintenanceStale,
)
from service.platform.bridge import (
    COMPONENT_REQUEST_MARKER,
)
from service.platform.files import (
    MAX_DIRECTORY_ITEMS,
    guess_media_type,
    list_directory,
    read_file,
    read_file_raw,
    resolve_child,
)

HTTP_OK = 200
HTTP_BAD_REQUEST = 400
HTTP_NOT_FOUND = 404
HTTP_CONFLICT = 409
HTTP_UNAVAILABLE = 503
HTTP_INTERNAL_ERROR = 500
SESSION_OPEN_FAILED_ERROR = "harness_session_open_failed"
# 结构化计时事件: 让 sessions/open 的锁等待与总耗时线上可归因 (Aone #87119853)。
SESSION_OPEN_TIMING_EVENT = "session_open_timing"
# 计时日志走 service 命名空间下的独立 logger: 注入的 _log (scholarseed.newserve) 不在 serve 的
# INFO 放行名单内 (root=WARNING 会丢弃其 INFO, 见 cli/serve.py 的 namespace setLevel), 用独立
# logger 才能保证埋点在生产日志里必达。
SESSION_OPEN_TIMING_LOGGER = logging.getLogger(__name__).getChild("open_timing")
RECOVERY_CHECK_SETTLEMENT_WAIT_SECONDS = 3.0
SESSION_REQUIRED_CAPABILITIES_FIELD = "required_capabilities"
SESSION_REQUIRED_CAPABILITIES_INVALID_ERROR = "invalid_required_capabilities"
SESSION_RESUME_FAILED_ERROR = "harness_session_resume_failed"
SESSION_OUTPUT_UNAVAILABLE_ERROR = "session_output_unavailable"
SESSION_DELETION_UNAVAILABLE = "session_deletion_unavailable"
SESSION_DELETION_FAILED = "session_deletion_failed"
SESSION_MODEL_UNAVAILABLE_ERROR = "session_model_unavailable"
SESSION_MODEL_SWITCH_FAILED_ERROR = "session_model_switch_failed"
SESSION_PERMISSION_SWITCH_FAILED_ERROR = "session_permission_switch_failed"
SESSION_WRITABLE_ROOTS_CHANGED_ERROR = "session_writable_roots_changed"
SESSION_PERMISSION_APPLICATION_INVALID = "session_permission_application_invalid"
SESSION_PERMISSION_CONFIRMATION_REQUIRED = "session_permission_confirmation_required"
SESSION_PERMISSION_UPDATE_UNCONFIRMED = "session_permission_update_unconfirmed"
SESSION_PERMISSION_STOP_PENDING = "session_permission_stop_pending"
SESSION_PERMISSION_CONTINUATION_STALE = "session_permission_continuation_stale"
SESSION_PERMISSION_STOP_TIMEOUT_SECONDS = 30.0
SESSION_PERMISSION_STOP_POLL_SECONDS = 0.1
SESSION_PERMISSION_CONTINUATION_TEXT = (
    "继续刚才中断的任务。先核对已完成操作和产物，不重复已产生副作用的步骤。"
)


class PermissionApplication(str, Enum):
    AUTO = "auto"
    NEXT_TURN = "next_turn"
    INTERRUPT_CONTINUE = "interrupt_continue"


RUNTIME_RPC_REJECTED_ERROR = "runtime_rpc_rejected"
RUNTIME_TRANSPORT_LOST_ERROR = "runtime_transport_lost"
RUNTIME_RPC_TIMEOUT_ERROR = "runtime_rpc_timeout"
SESSION_OPERATION_FAILURES = {
    "open": (SESSION_OPEN_FAILED_ERROR, "会话创建失败"),
    "resume": (SESSION_RESUME_FAILED_ERROR, "会话恢复失败"),
    "model_switch": (SESSION_MODEL_SWITCH_FAILED_ERROR, "模型切换失败"),
    "permission_switch": (SESSION_PERMISSION_SWITCH_FAILED_ERROR, "权限模式切换失败"),
}
RUNTIME_FAILURE_DEFAULT_MESSAGE = "请重试；若仍失败，请重新打开会话。"
RUNTIME_FAILURE_MESSAGES = {
    RESOURCE_HOST_CONFIGURATION_CONFLICT: (
        "本次配置与当前共享执行后端不兼容，未创建或替换后端，也未中断其他会话。"
        "请等待任务完成，再确认退出并重新启动应用以切换配置。"
    ),
    "agent_runtime_capacity_reached": (
        "Agent 运行时进程池已满。请在正在运行的任务结束后完全退出书深，重新打开后重试。"
    ),
    "runtime_thread_capacity_reached": (
        "当前会话线程已满，请等待其他任务结束或关闭闲置会话后重试。"
    ),
    SESSION_MODEL_UNAVAILABLE_ERROR: "所选模型当前不可用，请检查模型配置后重试。",
    RUNTIME_RPC_REJECTED_ERROR: "Agent 运行时拒绝了本次请求，请重新打开会话后重试。",
    RUNTIME_TRANSPORT_LOST_ERROR: "与 Agent 运行时的本地连接已中断，请重新打开会话后重试。",
    RUNTIME_RPC_TIMEOUT_ERROR: "Agent 运行时请求超时，请重试。",
}
SESSION_BROWSER_HIDDEN_NAMES = ("settings.json", "config.json")
SESSION_RELOCATE_CONTEXT_PENDING = "assistant_context_relocation_pending"
SESSION_LIST_DEFAULT_LIMIT = 60
SESSION_LIST_MAX_LIMIT = 500
SESSION_SEARCH_QUERY_MAX_LENGTH = 200
SESSION_SEARCH_EXCERPT_CONTEXT_LENGTH = 36
SESSION_LOCAL_PATH_REFERENCE_LIMIT = 32
MCP_LIST_DEFAULT_LIMIT = 100
MCP_LIST_MAX_LIMIT = 500
MCP_OPERATION_SNAPSHOT = "snapshot"
MCP_OPERATION_LIST_TOOLS = "list_tools"
MCP_OPERATION_LIST_RESOURCES = "list_resources"
MCP_OPERATION_READ_RESOURCE = "read_resource"
MCP_OPERATION_RELOAD = "reload"
MCP_OPERATION_CALL_TOOL = "call_tool"
MCP_OPERATION_LOGIN = "login"
MCP_OPERATION_LIST_PROMPTS = "list_prompts"
MCP_OPERATION_LOGOUT = "logout"
MCP_OPERATION_TRUST = "trust"
MCP_DIRECT_APPROVAL_REQUIRED = "mcp_direct_call_requires_explicit_approval"
MCP_META_REQUEST_ID_KEY = "scholarseedRequestId"
MCP_REQUEST_ID_MAX_LENGTH = 128
MCP_REQUEST_ID_PUNCTUATION = frozenset("-_.:")
SESSION_RECOVERY_HIL_KEY_PREFIX = "service:recovery:hil"
SESSION_RECOVERY_TURN_KEY_PREFIX = "service:recovery:turn"
SESSION_OPEN_FIELDS = frozenset(
    {
        "model_id",
        "reasoning_effort",
        "permission_mode",
        "project_path",
        "resume_session_id",
        "fork_session_id",
        "fork_turn_id",
        SESSION_REQUIRED_CAPABILITIES_FIELD,
    }
)
SESSION_FORK_FIELDS = frozenset({"fork_session_id", "fork_turn_id"})
SESSION_FORK_INVALID = "session_fork_invalid"
SESSION_FORK_UNAVAILABLE = "session_fork_unavailable"
SESSION_FORK_INCOMPLETE = "session_fork_turn_incomplete"
SESSION_FORK_TITLE_SUFFIX = " · 分支"
PRODUCT_PERMISSION_MODES = (
    ASK_PERMISSION_MODE,
    SAFE_AUTO_PERMISSION_MODE,
    BYPASS_PERMISSION_MODE,
)


def _required_capabilities(value: object) -> tuple[RuntimeCapabilityName, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise ValueError(SESSION_REQUIRED_CAPABILITIES_INVALID_ERROR)
    try:
        capabilities = tuple(RuntimeCapabilityName(item) for item in value if isinstance(item, str))
    except ValueError as error:
        raise ValueError(SESSION_REQUIRED_CAPABILITIES_INVALID_ERROR) from error
    if len(capabilities) != len(value) or len(set(capabilities)) != len(capabilities):
        raise ValueError(SESSION_REQUIRED_CAPABILITIES_INVALID_ERROR)
    return capabilities


def _runtime_failure_payload(error: Exception, *, operation: str) -> dict[str, Any]:
    stable_error, summary = SESSION_OPERATION_FAILURES[operation]
    safe_error = str(getattr(error, "safe_error", "") or "").strip() or stable_error
    method = str(getattr(error, "method", "") or "").strip()
    rpc_code = getattr(error, "rpc_code", None)
    reason = RUNTIME_FAILURE_MESSAGES.get(safe_error, RUNTIME_FAILURE_DEFAULT_MESSAGE)
    return {
        "ok": False,
        "error": stable_error,
        "code": safe_error,
        "detail": f"{summary}。{reason}",
        "failure_type": type(error).__name__,
        "rpc_method": method or None,
        "rpc_code": rpc_code if isinstance(rpc_code, int) else None,
    }


def workspace_allows(active_workspace: Path, session_workspace: Path | None) -> bool:
    """Allow the active root and its descendants without string-prefix checks."""

    if session_workspace is None:
        return False
    active = active_workspace.expanduser().resolve()
    requested = session_workspace.expanduser().resolve()
    return requested == active or active in requested.parents


class SessionService:
    """Own product ids, durable vendor bindings, resume, and user controls."""

    def __init__(
        self,
        cwd: Path,
        sessions: dict[str, LiveSession],
        *,
        activities: Activities,
        access: SessionCatalogStore,
        events: ProductEventStore,
        runtime: LiveSessionService,
        workspaces: SessionWorkspaceService,
        artifacts: SessionArtifactStore,
        settings: SettingsService,
        credentials: SkillCredentialService,
        logger: Any,
    ) -> None:
        self._activities = activities
        self._cwd = cwd.expanduser().resolve()
        self._sessions = sessions
        # 「这个项目当前允许写哪些根」由 content 域回答, 组合根负责绑定。
        # 这里存一个 provider 而不是 import content: 会话域不依赖文件域的实现,
        # 未绑定时回空集合 = 只有 cwd 可写, 等价改造前的行为。
        self._writable_roots: Callable[[Path], tuple[Path, ...]] = lambda _path: ()
        self._output_directory: Callable[[Path, str], Path] | None = None
        self._project_relocation: Callable[[str, sqlite3.Connection], bool] | None = None
        self._access = access
        self._events = events
        self._runtime = runtime
        self._workspaces = workspaces
        self._artifacts = artifacts
        self._settings = settings
        self._credentials = credentials
        self._logger = logger
        self._open_lock = asyncio.Lock()
        self._update_shutdown_generation: str | None = None
        self._update_shutdown_sessions: tuple[LiveSession, ...] = ()
        self._update_shutdown_prepared = False
        self._turn_confirmation: Callable[[str, str], Awaitable[None]] | None = None
        self._queue_cancellation: Callable[[str], Awaitable[None]] | None = None
        self._settlement_resume: Callable[[LiveSession], None] | None = None
        self._deletion: Callable[[SessionCatalogRecord], None] | None = None
        self._task_documents: Callable[[str, str], tuple[dict, ...]] = lambda _session, _project: ()

    def bind_task_documents(self, provider: Callable[[str, str], tuple[dict, ...]]) -> None:
        self._task_documents = provider

    def bind_deletion(self, callback: Callable[[SessionCatalogRecord], None]) -> None:
        self._deletion = callback

    def bind_turn_confirmation(self, callback: Callable[[str, str], Awaitable[None]]) -> None:
        self._turn_confirmation = callback

    def bind_queue_cancellation(self, callback: Callable[[str], Awaitable[None]]) -> None:
        """Bind pending-message cleanup, called while the lifecycle lock is held."""

        self._queue_cancellation = callback

    def bind_settlement_resume(self, callback: Callable[[LiveSession], None]) -> None:
        self._settlement_resume = callback

    def broadcast_product_events(
        self,
        session_id: str,
        records: tuple[ProductEventRecord, ...],
    ) -> None:
        """Broadcast already committed events when the session is resident."""

        live = self._sessions.get(session_id)
        if live is not None:
            live.broadcast_product_events(records)

    def _model_state(self, session_id: str) -> SessionModelState:
        """Read model state, migrating legacy sessions that predate model binding."""

        return self._access.model_state(
            session_id,
            default_model_id=RETIRED_NATIVE_MODEL_KEY,
        )

    def _recover_selected_model(
        self,
        session_id: str,
        principal: SessionPrincipal,
        state: SessionModelState,
        actor_id: str,
    ) -> str:
        """把会话存量选择对齐到目录当前可执行的键，发生切换时落盘修复。

        目录解析（``selected_model_key``）自带未登录门禁回落：置灰的内置键会解析成
        第一个可用模型。解析失败（键已不在目录）时保持原值，让 open 照旧给出可读错误。
        """

        try:
            resolved = self._runtime.selected_model_key(state.selected_model_id, user_id=actor_id)
        except SessionModelUnavailableError:
            return state.selected_model_id
        if resolved == state.selected_model_id:
            return resolved
        self._access.set_model(
            session_id,
            principal,
            resolved,
            reasoning_effort=state.selected_reasoning_effort,
            thinking=state.selected_thinking,
        )
        self._logger.info(
            "session_model_auto_recovered session_id=%s from=%s to=%s",
            session_id,
            state.selected_model_id,
            resolved,
        )
        return resolved

    def bridge_caller(self, session_id: str) -> LiveSession | None:
        """An active, non-interrupted product caller; each route validates its capability."""

        live = self._sessions.get(session_id)
        if (
            live is None
            or not live.running
            or live.interrupting
            or live.terminating
            or live.terminated
        ):
            return None
        live.restore_turn_context()
        return live

    async def align_metering_identity(self, session_id: str, actor_id: str) -> bool:
        """Validate host compatibility before rebinding an outbound account."""

        live = self._sessions.get(session_id)
        if live is None:
            return False
        return await self._runtime.realign_metering_identity(live, actor_id)

    async def align_skill_environment(self, session_id: str) -> bool:
        """让一个已在运行的会话对齐到当前有效的技能凭据（key 被轮换后的自愈）。

        实际准入时校验身份并按需补签，环境不同才恢复原有绑定；撤权失败拒绝准入。

        进行中的 turn 不打断 (返回 False), 下一个 turn 再对齐: 为了换一把 key 而掐掉用户
        正在跑的回答, 代价远大于晚一轮生效。

        凭据缓存按**真实账号 id** 键控, 所以这里取 live.user_id 而不是发起请求的归属
        principal —— 归属可以是机器级的, 拿它去读缓存会永远读空, 于是每个 turn 都判定
        「不一致」并重开一次 vendor thread。归属校验由路由的 session_guard 与
        align_owned_skill_environments 的 require 负责, 不在这里重复。
        """

        live = self._sessions.get(session_id)
        if live is None:
            return False
        if live.running:
            return False
        return await self._align_skill_environment(live)

    async def _align_skill_environment(self, live: LiveSession) -> bool:
        """Called under the lifecycle lock; failed authorization alignment rejects admission."""
        desired = await self._credentials.admission_environment(live.user_id)
        if dict(desired) == dict(live.process_environment):
            return False
        session_id = live.id
        record = self._access.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        migrated = await self._runtime.realign_environment(
            live,
            model_id=live.model_id or record.model_id or "",
            process_environment=desired,
        )
        if not migrated:
            raise RuntimeError("runtime credential alignment unavailable")
        if dict(desired) != self._credentials.cached_environment(live.user_id):
            raise CredentialAdmissionError("authorization changed while resuming runtime")
        return True

    async def align_owned_skill_environments(self, principal: SessionPrincipal) -> int:
        """把该用户所有空闲会话对齐到当前凭据, 返回真正迁移了的会话数。

        账号页点完轮换后由客户端通知触发, 让「点一下就生效」落在用户正看着的那个会话上,
        而不是等他下一次发消息。跑着 turn 的会话跳过, 由 turn 前的对齐兜住。
        """

        migrated = 0
        for session_id in tuple(self._sessions):
            try:
                self._access.require(session_id, principal)
            except SessionAccessError:
                continue
            if await self.align_skill_environment(session_id):
                migrated += 1
        return migrated

    def require_access(self, session_id: str, principal: SessionPrincipal) -> None:
        self._access.require(session_id, principal)

    def is_readonly(self, session_id: str) -> bool:
        record = self._access.get(session_id)
        live = self._sessions.get(session_id)
        return bool((record is not None and record.archived) or (live is not None and live.closing))

    def queued(self, session_id: str) -> tuple[dict[str, Any], int]:
        """Read persisted requests without activating or requiring a live session."""
        if self._access.get(session_id) is None:
            return {"ok": False, "error": "session_not_found"}, HTTP_NOT_FOUND
        return {
            "ok": True,
            "messages": [
                queued_message_payload(row) for row in self._access.queued_messages(session_id)
            ],
        }, HTTP_OK

    def is_running(self, session_id: str, principal: SessionPrincipal) -> bool:
        self.require_access(session_id, principal)
        live = self._sessions.get(session_id)
        return bool(live and live.running)

    async def continuation(
        self,
        session_id: str,
        principal: SessionPrincipal,
        *,
        turn_id: str = "",
    ) -> tuple[dict[str, Any], int]:
        """Read a bounded draft snapshot without opening or mutating either task."""

        async with self._open_lock:
            self.require_access(session_id, principal)
            async with AsyncExitStack() as guards:
                live = self._sessions.get(session_id)
                if live is not None:
                    await guards.enter_async_context(live.lifecycle_lock)
                    if (
                        live.running
                        or live.closing
                        or live.interrupting
                        or live.steer_lock.locked()
                        or live.active_product_turn_id
                        or live.ledger.has_unknown_outcome
                        or (live.resource_task is not None and not live.resource_task.done())
                    ):
                        return {"ok": False, "error": CONTINUATION_BUSY}, HTTP_CONFLICT
                source = self._access.get(session_id)
                if source is None:
                    raise SessionAccessError("session not found")
                model_id, blocked = self._access.continuation_state(session_id)
                if (
                    blocked
                    or source.status in {SessionStatus.RUNNING, SessionStatus.WAITING_HIL}
                    or source.last_turn_status == PRODUCT_TURN_OUTCOME_UNKNOWN
                ):
                    return {"ok": False, "error": CONTINUATION_BUSY}, HTTP_CONFLICT
                if not model_id:
                    return {"ok": False, "error": CONTINUATION_MODEL_UNAVAILABLE}, HTTP_CONFLICT
                terminal = self._events.continuation_terminal(
                    session_id, through_seq=source.last_product_seq
                )
                if not terminal:
                    return {"ok": False, "error": CONTINUATION_UNAVAILABLE}, HTTP_CONFLICT
                if turn_id and terminal != turn_id:
                    return {"ok": False, "error": CONTINUATION_STALE}, HTTP_CONFLICT
                try:
                    records = self._events.continuation_records(
                        session_id,
                        through_seq=source.last_product_seq,
                        limit=CONTINUATION_MAX_SOURCE_EVENTS,
                        byte_limit=CONTINUATION_MAX_SOURCE_BYTES,
                    )
                    payload = continuation_snapshot(source, model_id, records)
                except (ValueError, UnicodeError):
                    return {"ok": False, "error": CONTINUATION_UNAVAILABLE}, HTTP_CONFLICT
                return payload, HTTP_OK

    async def open(
        self,
        body: Mapping[str, Any],
        principal: SessionPrincipal,
        *,
        actor_id: str,
        skill_environment: Mapping[str, str] | None = None,
    ) -> tuple[dict[str, Any], int]:
        """Create or exactly resume one product session; never replay a prompt.

        `skill_environment` 是本次请求解析出的会话进程环境变量 (App Server / skill 共用的
        SCHOLARSEED_API_KEY)。它由 HTTP 边界解析 —— 只有那里有用户凭据 —— 本层只负责透传。

        `principal` 是**数据归属**身份 (谁能寻址这个会话), `actor_id` 是**真实账号**身份
        (网关用量归属到谁、凭据缓存按谁键控)。两者可以不同 —— 归属可以是机器级的 —— 所以
        actor_id 必填: 一旦回落到 principal.user_id, 计量腿会静默记到错误的人头上。
        """

        unexpected = sorted(set(body) - SESSION_OPEN_FIELDS)
        if unexpected:
            return {
                "ok": False,
                "error": "invalid_session_open_fields",
                "fields": unexpected,
            }, HTTP_BAD_REQUEST
        try:
            required_capabilities = _required_capabilities(
                body.get(SESSION_REQUIRED_CAPABILITIES_FIELD)
            )
        except ValueError as error:
            return {"ok": False, "error": str(error)}, HTTP_BAD_REQUEST
        resume_id = str(body.get("resume_session_id") or "").strip()
        if SESSION_FORK_FIELDS.intersection(body) and (
            set(body) != SESSION_FORK_FIELDS
            or any(
                not isinstance(body.get(name), str) or not body[name].strip()
                for name in SESSION_FORK_FIELDS
            )
        ):
            return {"ok": False, "error": SESSION_FORK_INVALID}, HTTP_BAD_REQUEST
        if resume_id:
            mutable_resume_fields = sorted(
                name for name in ("model_id", "permission_mode", "project_path") if body.get(name)
            )
            if SESSION_REQUIRED_CAPABILITIES_FIELD in body:
                mutable_resume_fields.append(SESSION_REQUIRED_CAPABILITIES_FIELD)
            if mutable_resume_fields:
                return {
                    "ok": False,
                    "error": "resume_session_fields_immutable",
                    "fields": mutable_resume_fields,
                }, HTTP_CONFLICT
        # _open_lock 是进程级全局串行锁: 整段冷恢复都握在锁内, 客户端 abort 也不会提前释放。
        # 记录锁等待与总耗时, 才能把「服务端慢恢复」与「重试排队等锁」区分开 (Aone #87119853)。
        lock_requested_at = time.perf_counter()
        async with self._open_lock, AsyncExitStack() as admission:
            admission.enter_context(self._activities.enter(ActivityDomain.RUNTIME, root=True))
            lock_wait_ms = (time.perf_counter() - lock_requested_at) * 1000.0
            opened_at = time.perf_counter()
            path = "resume" if resume_id else "create"
            try:
                if resume_id:
                    payload, status = await self._resume(
                        resume_id, principal, actor_id, skill_environment
                    )
                elif body.get("fork_session_id"):
                    payload, status = await self._fork(body, principal, actor_id, skill_environment)
                else:
                    payload, status = await self._create(
                        body,
                        principal,
                        actor_id,
                        skill_environment,
                        required_capabilities,
                    )
            except asyncio.CancelledError:
                # 客户端断开是否取消本协程, 决定「排队等锁后自愈」还是「半启动进程被弃」两种机制;
                # 此处仅观测并原样抛出, 不改变清理语义 (CancelledError 属 BaseException,
                # _resume/_create 的 except Exception 兜底不会捕获它)。
                SESSION_OPEN_TIMING_LOGGER.warning(
                    "%s path=%s session_id=%s cancelled lock_wait_ms=%.0f elapsed_ms=%.0f",
                    SESSION_OPEN_TIMING_EVENT,
                    path,
                    resume_id,
                    lock_wait_ms,
                    (time.perf_counter() - opened_at) * 1000.0,
                )
                raise
            SESSION_OPEN_TIMING_LOGGER.info(
                "%s path=%s session_id=%s status=%s lock_wait_ms=%.0f duration_ms=%.0f",
                SESSION_OPEN_TIMING_EVENT,
                path,
                resume_id or payload.get("session_id", ""),
                status,
                lock_wait_ms,
                (time.perf_counter() - opened_at) * 1000.0,
            )
            return payload, status

    async def _fork(
        self,
        body: Mapping[str, Any],
        principal: SessionPrincipal,
        actor_id: str,
        skill_environment: Mapping[str, str] | None,
    ) -> tuple[dict[str, Any], int]:
        source_id = str(body["fork_session_id"]).strip()
        self.require_access(source_id, principal)
        async with AsyncExitStack() as guards:
            source_live = self._sessions.get(source_id)
            if source_live is not None:
                await guards.enter_async_context(source_live.lifecycle_lock)
                if source_live.closing:
                    return {"ok": False, "error": SESSION_RUNNING_ERROR}, HTTP_CONFLICT
            record = self._access.get(source_id)
            binding = self._access.runtime_binding(source_id)
            terminal = self._events.turn_completed(
                source_id, vendor_turn_id=str(body["fork_turn_id"]).strip()
            )
            if record is None or binding is None or record.runtime_id != self._runtime.runtime_id:
                return {"ok": False, "error": SESSION_FORK_UNAVAILABLE}, HTTP_CONFLICT
            if record.archived:
                return {"ok": False, "error": SESSION_ARCHIVED_ERROR}, HTTP_CONFLICT
            if terminal is None:
                return {"ok": False, "error": SESSION_FORK_INCOMPLETE}, HTTP_CONFLICT
            if terminal.vendor_thread_id != binding.opaque_session_ref:
                return {"ok": False, "error": SESSION_FORK_SOURCE_CHANGED}, HTTP_CONFLICT
            state = self._model_state(source_id)
            activation = self._access.activation(source_id)
            fork_body = {
                "project_path": record.project_path,
                "model_id": state.selected_model_id,
                "reasoning_effort": state.selected_reasoning_effort,
                "permission_mode": record.policy_id,
                "thinking": thinking_payload(state.selected_thinking),
            }
            required_capabilities = activation.required_capabilities if activation else ()
        return await self._create(
            fork_body,
            principal,
            actor_id,
            skill_environment,
            required_capabilities=required_capabilities,
            fork_origin=terminal,
        )

    async def _restore_fork_history(self, live: LiveSession) -> None:
        origin = self._events.by_key(live.id, SESSION_FORK_KEY)
        if origin is None or self._events.by_key(live.id, SESSION_FORK_IMPORTED_KEY) is not None:
            return
        await self._runtime.ensure_active(live)
        target = self._access.get(live.id)
        if target is None:
            raise RuntimeError(SESSION_FORK_UNAVAILABLE)
        self._events.inherit_history(
            str(origin.payload["source_session_id"]),
            target,
            int(origin.payload["source_product_seq"]),
        )

    async def _create(
        self,
        body: Mapping[str, Any],
        principal: SessionPrincipal,
        actor_id: str,
        skill_environment: Mapping[str, str] | None = None,
        required_capabilities: tuple[RuntimeCapabilityName, ...] = (),
        fork_origin: ProductEventRecord | None = None,
    ) -> tuple[dict[str, Any], int]:
        session_id = uuid.uuid4().hex
        supported = {
            capability.name
            for capability in self._runtime.gateway_capabilities.entries
            if capability.state is CapabilityState.SUPPORTED
        }
        missing = tuple(
            capability.value
            for capability in required_capabilities
            if capability.value not in supported
        )
        if missing:
            return {
                "ok": False,
                "error": RUNTIME_CAPABILITY_UNAVAILABLE,
                "capabilities": list(missing),
            }, HTTP_UNAVAILABLE
        try:
            runtime_workdir, project_path, output_root = await self._activities.finish(
                ActivityDomain.RESOURCE,
                lambda: self._activities.to_thread(
                    ActivityDomain.RESOURCE,
                    self._new_paths,
                    session_id,
                    body.get("project_path"),
                    principal,
                ),
            )
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}, HTTP_CONFLICT
        executable = self._settings.runtime_executable()
        readiness = await self._runtime.readiness(executable=executable)
        if not readiness.ready:
            return self._readiness_error(readiness), HTTP_UNAVAILABLE
        permission_mode = str(
            body.get("permission_mode") or self._settings.permission_mode()
        ).strip()
        if permission_mode not in PRODUCT_PERMISSION_MODES:
            return {"ok": False, "error": "invalid_permission_mode"}, HTTP_BAD_REQUEST
        if project_path is None:
            runtime_workdir.mkdir(parents=True, exist_ok=True)
            output_root.mkdir(parents=True, exist_ok=True)
        live: LiveSession | None = None
        try:
            selected_model = str(body.get("model_id") or self._settings.runtime_model()).strip()
            reasoning_effort = str(body.get("reasoning_effort") or "").strip()
            try:
                thinking = thinking_from_payload(body.get("thinking"))
            except ValueError as exc:
                return {"ok": False, "error": str(exc)}, HTTP_BAD_REQUEST
            if reasoning_effort:
                await self._runtime.validate_effort(
                    selected_model, reasoning_effort, user_id=actor_id
                )
            if thinking is not None:
                await self._runtime.validate_thinking(selected_model, thinking, user_id=actor_id)
            live = await self._runtime.open(
                session_id=session_id,
                runtime_id=self._runtime.runtime_id,
                cwd=runtime_workdir,
                project_path=project_path,
                output_root=output_root,
                resume_vendor_thread_id="",
                permission_mode=permission_mode,
                model_id=selected_model,
                reasoning_effort=reasoning_effort,
                thinking=thinking,
                executable=readiness.executable or executable,
                process_environment=skill_environment,
                user_id=actor_id,
                writable_roots=self._writable_roots(project_path or runtime_workdir),
                required_capabilities=required_capabilities,
            )
            allocated = self._access.allocate(
                session_id,
                # 落库的是**建会话的真实账号**, 不是归属身份: 归属可能被收敛到机器级, 若把
                # 它写进 principal_id, 轴改回按账号隔离时这些行就再也认不回原主了。
                SessionPrincipal(user_id=actor_id),
                runtime_id=live.runtime_id,
                runtime_workdir=str(runtime_workdir),
                project_path=str(project_path) if project_path else None,
                output_root=str(output_root),
                codex_version=readiness.version or None,
                model_id=live.model_id or None,
                policy_id=permission_mode,
                status=SessionStatus.READY,
                title=SESSION_TITLE_DEFAULT,
                title_fallback=SessionTitleFallback.NEW_SESSION,
                created_at=time.time(),
                required_capabilities=required_capabilities,
                reasoning_effort=reasoning_effort,
                thinking=thinking,
            )
            self._events.bind_workspace(allocated, initial=True)
            if fork_origin is not None:
                self._events.append(
                    session_id=session_id,
                    runtime_id=live.runtime_id,
                    vendor_thread_id="",
                    vendor_turn_id=None,
                    vendor_item_id=None,
                    kind=SESSION_FORK_EVENT,
                    payload={
                        "source_session_id": fork_origin.session_id,
                        "source_thread_id": fork_origin.vendor_thread_id,
                        "source_turn_id": fork_origin.vendor_turn_id,
                        "source_product_seq": fork_origin.product_seq,
                    },
                    idempotency_key=SESSION_FORK_KEY,
                )
            await live.activate()
            if fork_origin is not None:
                await self._restore_fork_history(live)
                source = self._access.get(fork_origin.session_id)
                if source is not None:
                    self._access.rename(
                        session_id,
                        principal,
                        (source.title + SESSION_FORK_TITLE_SUFFIX)[:SESSION_RENAME_MAX_LENGTH],
                    )
            self._sessions[session_id] = live
        except SessionModelUnavailableError as exc:
            if live is not None:
                await live.aclose()
            return {"ok": False, "error": str(exc)}, HTTP_BAD_REQUEST
        except Exception as exc:
            if live is not None:
                await live.aclose()
            failure = _runtime_failure_payload(exc, operation="open")
            self._logger.error(
                "%s session_id=%s failure_type=%s code=%s rpc_method=%s rpc_code=%s",
                SESSION_OPEN_FAILED_ERROR,
                session_id,
                failure["failure_type"],
                failure["code"],
                failure["rpc_method"],
                failure["rpc_code"],
                exc_info=True,
            )
            return failure, 500
        return self._snapshot(live, readiness=readiness), HTTP_OK

    def navigation(
        self, session_id: str, principal: SessionPrincipal
    ) -> tuple[dict[str, Any], int]:
        """Restore a location from the catalog without opening an Agent session."""
        try:
            self._access.require(session_id, principal)
        except SessionAccessError:
            return {"ok": False, "error": "session_not_found"}, HTTP_NOT_FOUND
        record = self._access.get(session_id)
        if record is None or record.archived:
            return {"ok": False, "error": "session_not_found"}, HTTP_NOT_FOUND
        try:
            self._require_registered_project(
                Path(record.project_path) if record.project_path else None
            )
        except ValueError as error:
            return {"ok": False, "error": str(error)}, HTTP_CONFLICT
        live = self._sessions.get(session_id)
        return {
            "session_id": record.session_id,
            **self._title_projection(record),
            "runtime_workdir": record.runtime_workdir,
            "project_path": record.project_path,
            "runtime_id": record.runtime_id,
            "running": bool(live is not None and live.running),
        }, HTTP_OK

    async def _resume(
        self,
        session_id: str,
        principal: SessionPrincipal,
        actor_id: str,
        skill_environment: Mapping[str, str] | None = None,
    ) -> tuple[dict[str, Any], int]:
        try:
            self._access.require(session_id, principal)
        except SessionAccessError:
            return {"ok": False, "error": "session_not_found"}, HTTP_NOT_FOUND
        record = self._access.get(session_id)
        if record is None:
            return {"ok": False, "error": "session_not_found"}, HTTP_NOT_FOUND
        if record.archived:
            return {"ok": False, "error": SESSION_ARCHIVED_ERROR}, HTTP_CONFLICT
        try:
            self._require_registered_project(
                Path(record.project_path) if record.project_path else None
            )
        except ValueError as error:
            return {"ok": False, "error": str(error)}, HTTP_CONFLICT
        existing = self._sessions.get(session_id)
        if existing is not None:
            executable = self._settings.runtime_executable()
            readiness = await self._runtime.readiness(
                runtime_id=existing.runtime_id,
                executable=executable,
            )
            try:
                await self._runtime.realign_metering_identity(existing, actor_id)
            except (RuntimeError, ValueError) as error:
                safe_error = getattr(error, "safe_error", "") or str(error)
                if safe_error == RESOURCE_HOST_CONFIGURATION_CONFLICT:
                    return {"ok": False, "error": safe_error}, HTTP_CONFLICT
                return {"ok": False, "error": RESOURCE_HOST_CONTEXT_REQUIRED}, HTTP_UNAVAILABLE
            return self._snapshot(existing, readiness=readiness), HTTP_OK
        activation = self._access.activation(session_id)
        if record.runtime_id == LEGACY_RUNTIME_ID or activation is None:
            return {"ok": False, "error": "legacy_session_readonly"}, HTTP_CONFLICT
        executable = self._settings.runtime_executable()
        readiness = await self._runtime.readiness(
            runtime_id=record.runtime_id,
            executable=executable,
        )
        if not readiness.ready:
            return self._readiness_error(readiness), HTTP_UNAVAILABLE
        was_inflight = record.status in {SessionStatus.RUNNING, SessionStatus.WAITING_HIL}
        recovery_hil = self._access.pending_hil(record.session_id) if was_inflight else ()
        mode = record.policy_id or ASK_PERMISSION_MODE
        resume_state = self._model_state(session_id)
        # 登出会让会话存量选择指向被门禁置灰的内置模型；resume 时把会话选择修复到
        # 目录解析出的生效模型（未登录时为第一个可用模型），避免整条会话卡在不可执行键上。
        resume_model = self._recover_selected_model(session_id, principal, resume_state, actor_id)
        live: LiveSession | None = None
        try:
            live = await self._runtime.open(
                session_id=record.session_id,
                runtime_id=record.runtime_id,
                cwd=Path(record.runtime_workdir),
                project_path=Path(record.project_path) if record.project_path else None,
                output_root=Path(record.output_root),
                resume_vendor_thread_id=record.vendor_thread_id or "",
                permission_mode=mode,
                model_id=resume_model,
                reasoning_effort=resume_state.selected_reasoning_effort,
                thinking=resume_state.selected_thinking,
                executable=readiness.executable or executable,
                process_environment=skill_environment,
                user_id=actor_id,
                writable_roots=self._writable_roots(
                    Path(record.project_path)
                    if record.project_path
                    else Path(record.runtime_workdir)
                ),
            )
            await live.activate()
            await self._restore_fork_history(live)
            self._sessions[session_id] = live
            if self._access.pending_turn_settlement(session_id) is not None:
                if self._settlement_resume is None:
                    raise RuntimeError("pending turn settlement has no recovery owner")
                self._access.mark_turn_recovery_blocked(session_id, True)
            elif was_inflight:
                await self._publish_recovery(live, record, recovery_hil)
        except Exception as exc:
            self._access.mark_turn_recovery_blocked(session_id, True)
            if live is not None:
                await live.aclose()
            failure = _runtime_failure_payload(exc, operation="resume")
            self._logger.error(
                "%s session_id=%s failure_type=%s code=%s rpc_method=%s rpc_code=%s",
                SESSION_RESUME_FAILED_ERROR,
                session_id,
                failure["failure_type"],
                failure["code"],
                failure["rpc_method"],
                failure["rpc_code"],
                exc_info=True,
            )
            return failure, 500
        return self._snapshot(live, readiness=readiness), HTTP_OK

    async def check_recovery(
        self,
        session_id: str,
        principal: SessionPrincipal,
        *,
        actor_id: str,
        skill_environment: Mapping[str, str] | None = None,
    ) -> tuple[dict[str, Any], int]:
        pending = self._access.pending_turn_settlement(session_id)
        if pending is None:
            return {"ok": True, "recovery_blocked": False, "recovery_pending": False}, HTTP_OK
        live = self._sessions.get(session_id)
        if live is None:
            _, status = await self.open(
                {"resume_session_id": session_id},
                principal,
                actor_id=actor_id,
                skill_environment=skill_environment,
            )
            live = self._sessions.get(session_id)
            if status != HTTP_OK or live is None:
                return {
                    "ok": False,
                    "recovery_blocked": True,
                    "recovery_pending": True,
                    "error": "turn_recovery_blocked",
                }, HTTP_OK
        try:
            await self._runtime.ensure_active(live)
            session = live.runtime_session
            if session is None:
                raise RuntimeError("runtime session is unavailable")
            activity = await session.activity()
        except Exception as exc:
            self._access.mark_turn_recovery_blocked(session_id, True)
            self._logger.warning(
                "turn_recovery_check_failed session_id=%s failure_type=%s",
                session_id,
                type(exc).__name__,
                exc_info=True,
            )
            return {
                "ok": False,
                "recovery_blocked": True,
                "recovery_pending": True,
                "error": "turn_recovery_blocked",
            }, HTTP_OK
        if not activity.execution_tree_complete:
            self._access.mark_turn_recovery_blocked(session_id, True)
            return {
                "ok": False,
                "recovery_blocked": True,
                "recovery_pending": True,
                "error": "turn_recovery_blocked",
            }, HTTP_OK
        self._access.mark_turn_recovery_blocked(session_id, activity.execution_tree_idle)
        if self._settlement_resume is None:
            raise RuntimeError("pending turn settlement has no recovery owner")
        if live.current_task is None or live.current_task.done():
            self._settlement_resume(live)
        if activity.execution_tree_idle and live.current_task is not None:
            try:
                await asyncio.wait_for(
                    asyncio.shield(live.current_task),
                    timeout=RECOVERY_CHECK_SETTLEMENT_WAIT_SECONDS,
                )
            except asyncio.TimeoutError:
                pass
        return {
            "ok": True,
            "recovery_blocked": bool(
                (pending := self._access.pending_turn_settlement(session_id))
                and pending.recovery_blocked
            ),
            "recovery_pending": pending is not None,
            "activity_active": not activity.execution_tree_idle,
        }, HTTP_OK

    async def _publish_recovery(
        self,
        live: LiveSession,
        record: SessionCatalogRecord,
        pending_hil: tuple[SessionHilRecord, ...],
    ) -> None:
        """Make a process-loss interruption durable and visible before follow-up work."""

        for request in pending_hil:
            await live.publish(
                PRODUCT_EVENT_HIL_RESOLVED,
                {
                    "request_id": request.product_request_id,
                    "state": HIL_STATE_STALE,
                    "answer": "",
                },
                turn_id=request.vendor_turn_id or "",
                item_id=request.vendor_item_id or "",
                idempotency_key=(f"{SESSION_RECOVERY_HIL_KEY_PREFIX}:{request.product_request_id}"),
            )
            self._access.expire_hil(request.product_request_id)
        recovery_turn_id = record.last_turn_id or ""
        unknown_turns = tuple(
            row
            for row in self._access.uncertainties(record.session_id, unresolved_only=True)
            if row.kind is UncertaintyKind.TURN
            and row.state in {UncertaintyState.EXECUTING, UncertaintyState.UNKNOWN}
        )
        if unknown_turns:
            for turn in unknown_turns:
                await live.publish(
                    PRODUCT_EVENT_TURN_UNKNOWN,
                    {"status": PRODUCT_TURN_OUTCOME_UNKNOWN},
                    turn_id=turn.correlation_id,
                    idempotency_key=(
                        f"{SESSION_RECOVERY_TURN_KEY_PREFIX}:{turn.correlation_id}:unknown"
                    ),
                )
            if recovery_turn_id not in {turn.correlation_id for turn in unknown_turns}:
                recovery_turn_id = unknown_turns[0].correlation_id
            self._access.update_status(
                record.session_id,
                SessionStatus.ERROR,
                turn_id=recovery_turn_id,
                turn_status=PRODUCT_TURN_OUTCOME_UNKNOWN,
            )
            return
        await live.publish(
            PRODUCT_EVENT_TURN_INTERRUPTED,
            {"reason": SESSION_RECOVERY_INTERRUPT_REASON},
            turn_id=recovery_turn_id,
            idempotency_key=(
                f"{SESSION_RECOVERY_TURN_KEY_PREFIX}:{recovery_turn_id or record.session_id}"
            ),
        )
        self._access.update_status(
            record.session_id,
            SessionStatus.INTERRUPTED,
            turn_id=recovery_turn_id,
            turn_status=PRODUCT_SESSION_STATE_INTERRUPTED,
        )

    def _require_registered_project(self, project: Path | None) -> None:
        if project is not None and not self._workspaces.is_project(project):
            raise ValueError(SESSION_PROJECT_NOT_REGISTERED_ERROR)

    def _new_paths(
        self,
        session_id: str,
        requested_project: object,
        principal: SessionPrincipal,
    ) -> tuple[Path, Path | None, Path]:
        if requested_project is None or not str(requested_project).strip():
            runtime_workdir = (SESSION_RUNTIME_DIR / session_id).resolve()
            return runtime_workdir, None, runtime_workdir / SESSION_OUTPUT_DIRNAME
        project = Path(str(requested_project)).expanduser().resolve()
        if not self._workspaces.is_project(project):
            raise ValueError(SESSION_PROJECT_NOT_REGISTERED_ERROR)
        if not self._workspaces.allows(
            principal_id=principal.user_id,
            active_workspace=self._cwd,
            requested_workspace=project,
        ):
            raise ValueError(SESSION_PROJECT_NOT_AUTHORIZED_ERROR)
        directory = self._project_output_directory(project, session_id)
        return directory, project, directory

    def bind_output_directory(self, provider: Callable[[Path, str], Path]) -> None:
        self._output_directory = provider

    def bind_project_relocation(self, callback: Callable[[str, sqlite3.Connection], bool]) -> None:
        """Compose mutable project-scoped selection changes with catalog rebinding."""
        self._project_relocation = callback

    def _project_output_directory(self, project: Path, session_id: str) -> Path:
        if self._output_directory is None:
            raise ValueError(SESSION_OUTPUT_UNAVAILABLE_ERROR)
        return self._output_directory(project, session_id)

    def _readiness_error(self, readiness: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "error": "harness_runtime_not_ready",
            "runtime_id": self._runtime.runtime_id,
            "readiness": readiness_payload(
                readiness,
                configured_executable=self._settings.runtime_executable(),
            ),
        }

    @staticmethod
    def _title_projection(record: SessionCatalogRecord | None) -> dict[str, Any]:
        title = record.title if record is not None else ""
        return {
            "title": title or SESSION_TITLE_DEFAULT,
            "title_fallback": (
                record.title_fallback
                if record is not None and title
                else SessionTitleFallback.NEW_SESSION
            ),
        }

    def _snapshot(self, live: LiveSession, *, readiness: Any) -> dict[str, Any]:
        record = self._access.get(live.id)
        pending = self._access.pending_turn_settlement(live.id)
        recovery_blocked = bool(pending and pending.recovery_blocked)
        model_state = self._model_state(live.id) if record is not None else None
        selected_model_id = (
            model_state.selected_model_id if model_state is not None else live.model_id
        )
        return {
            "session_id": live.id,
            **self._title_projection(record),
            "runtime_id": live.runtime_id,
            "runtime": runtime_payload(
                runtime_id=live.runtime_id,
                version=str(getattr(readiness, "version", "") or ""),
                model_id=selected_model_id,
                reasoning_effort=(
                    model_state.selected_reasoning_effort if model_state else live.reasoning_effort
                ),
                active_reasoning_effort=(
                    live.reasoning_effort if live.runtime_session is not None else ""
                ),
                thinking=(model_state.selected_thinking if model_state else live.thinking),
                active_thinking=live.thinking if live.runtime_session is not None else None,
            ),
            "readiness": readiness_payload(
                readiness,
                configured_executable=self._settings.runtime_executable(),
            ),
            "capabilities": runtime_capabilities_payload(
                live.gateway_capabilities
                if live.runtime_binding is not None
                else self._runtime.gateway_capabilities
            ),
            "workdir": str(live.runtime_workdir),
            "runtime_workdir": str(live.runtime_workdir),
            "project_path": str(live.project_path) if live.project_path else None,
            "resumed": live.resumed,
            "last_seq": live.last_seq,
            "pending_hil": live.pending_hil_snapshot(blocking_only=False),
            "uncertain_operations": live.ledger.uncertainty_snapshot(),
            "unknown_outcome": live.ledger.has_unknown_outcome,
            "running": live.turn_active and not recovery_blocked,
            "active_turn_id": (
                (live.ledger.active_turn_id or None) if not recovery_blocked else None
            ),
            "recovery_blocked": recovery_blocked,
            "recovery_pending": pending is not None,
            **(
                self._events.recovery_snapshot(live.id, pending.native_turn_id)
                if recovery_blocked and pending
                else {}
            ),
            "interrupting": live.interrupting,
            "last_interrupt_succeeded": live.last_interrupt_succeeded,
            "todos": list(record.todos) if record is not None else [],
            "todo_turn_id": record.todo_turn_id if record is not None else None,
            "todo_explanation": record.todo_explanation if record is not None else None,
            "last_turn_id": record.last_turn_id if record is not None else None,
            "last_turn_status": record.last_turn_status if record is not None else None,
            "artifacts": live.artifact_snapshot(),
        }

    async def list(
        self,
        limit: int,
        principal: SessionPrincipal,
        *,
        scope: SessionListScope = SessionListScope.ALL,
        project_path: str | None = None,
        query: str | None = None,
        history: Callable[[str], tuple[Any, ...]] | None = None,
        cursor: str = "",
        archived: bool = False,
        include_last_agent_reply: bool = False,
    ) -> dict[str, Any]:
        bounded = min(SESSION_LIST_MAX_LIMIT, max(1, int(limit or SESSION_LIST_DEFAULT_LIMIT)))
        normalized_query = str(query or "").strip()[:SESSION_SEARCH_QUERY_MAX_LENGTH]
        normalized_project: str | None = None
        if scope is SessionListScope.PROJECT:
            raw_project = str(project_path or "").strip()
            if not raw_project:
                raise SessionAccessError("project not found")
            project = Path(raw_project).expanduser().resolve()
            if not self._workspaces.is_project(project) or not self._workspaces.allows(
                principal_id=principal.user_id,
                active_workspace=self._cwd,
                requested_workspace=project,
            ):
                raise SessionAccessError("project not found")
            normalized_project = str(project)
        scan_limit = SESSION_LIST_MAX_LIMIT if normalized_query else bounded
        rows = self._access.listed(
            principal,
            runtime_id=self._runtime.runtime_id,
            scope=scope,
            project_path=normalized_project,
            limit=scan_limit + 1,
            after=parse_session_list_cursor(cursor),
            archived=archived,
        )
        total = min(len(rows), scan_limit)
        sessions = []
        scanned = 0
        for record in rows[:scan_limit]:
            scanned += 1
            match = (
                self._search_match(
                    record,
                    normalized_query,
                    history or self._access.portable_history,
                )
                if normalized_query
                else None
            )
            if normalized_query and match is None:
                continue
            row = self._list_row(record)
            if match is not None:
                row["match"] = match
            sessions.append(row)
            if include_last_agent_reply:
                row["last_agent_reply_at"] = await asyncio.to_thread(
                    self._events.last_agent_reply_at, record.session_id
                )
            if len(sessions) >= bounded:
                break
        return {
            "sessions": sessions,
            "total": total,
            "runtime_id": self._runtime.runtime_id,
            "next_cursor": (
                session_list_cursor(
                    rows[scanned - 1].updated_at,
                    rows[scanned - 1].session_id,
                    rows[scanned - 1].pinned if scope is SessionListScope.PROJECT else None,
                )
                if scanned and scanned < len(rows)
                else None
            ),
        }

    async def search_project(
        self,
        project_path: str,
        user_id: str,
        query: str,
        limit: int,
    ) -> dict[str, Any]:
        """Public project-scoped search used by product-level search composition."""

        return await self.list(
            limit,
            SessionPrincipal(user_id=user_id),
            scope=SessionListScope.PROJECT,
            project_path=project_path,
            query=query,
            history=self._events.portable_history,
        )

    def _search_match(
        self,
        record: SessionCatalogRecord,
        query: str,
        history: Callable[[str], tuple[Any, ...]],
    ) -> dict[str, Any] | None:
        needle = query.casefold()
        title = record.title or SESSION_TITLE_DEFAULT
        best_entry: Any | None = None
        best_offset = -1
        best_count = 0
        total_count = 0
        for entry in history(record.session_id):
            folded_text = entry.text.casefold()
            count = folded_text.count(needle)
            if not count:
                continue
            total_count += count
            if count < best_count:
                continue
            best_entry = entry
            best_offset = folded_text.find(needle)
            best_count = count
        if best_entry is not None:
            entry = best_entry
            offset = best_offset
            start = max(0, offset - SESSION_SEARCH_EXCERPT_CONTEXT_LENGTH)
            end = min(
                len(entry.text),
                offset + len(query) + SESSION_SEARCH_EXCERPT_CONTEXT_LENGTH,
            )
            excerpt = entry.text[start:end].strip()
            return {
                "excerpt": f"{'…' if start else ''}{excerpt}{'…' if end < len(entry.text) else ''}",
                "field": "message",
                "role": entry.role,
                "count": total_count,
                "turn_id": entry.turn_id or None,
                "item_id": entry.item_id or None,
            }
        if needle in title.casefold():
            return {"excerpt": title, "field": "title"}
        return None

    async def recoverable(
        self,
        principal: SessionPrincipal,
    ) -> builtins.list[dict[str, Any]]:
        # 本类的 `list` 方法在类作用域里遮蔽了内建 `list`, 标注必须显式限定。
        return (
            await self.list(
                SESSION_LIST_MAX_LIMIT,
                principal,
                scope=SessionListScope.ALL,
            )
        )["sessions"]

    def _list_row(self, record: SessionCatalogRecord) -> dict[str, Any]:
        live = self._sessions.get(record.session_id)
        binding = self._access.runtime_binding(record.session_id)
        model_state = self._model_state(record.session_id)
        pending = self._access.pending_turn_settlement(record.session_id)
        recovery_blocked = pending is not None and (live is None or pending.recovery_blocked)
        pending_running = pending is not None and not (
            record.last_turn_id == pending.native_turn_id
            and record.status
            in {SessionStatus.COMPLETED, SessionStatus.INTERRUPTED, SessionStatus.ERROR}
        )
        return {
            "session_id": record.session_id,
            "runtime_id": record.runtime_id,
            "runtime": runtime_payload(
                version=str(record.codex_version or ""),
                model_id=model_state.selected_model_id,
                reasoning_effort=model_state.selected_reasoning_effort,
                active_reasoning_effort=(
                    model_state.active_reasoning_effort
                    if live is not None and live.runtime_session is not None
                    else ""
                ),
                thinking=model_state.selected_thinking,
                active_thinking=(
                    model_state.active_thinking
                    if live is not None and live.runtime_session is not None
                    else None
                ),
            ),
            "readiness": None,
            "capabilities": runtime_capabilities_payload(
                live.gateway_capabilities
                if live is not None
                else (
                    binding.capabilities
                    if binding is not None
                    else self._runtime.gateway_capabilities
                )
            ),
            "created_at": record.created_at,
            "mtime": record.updated_at,
            "pinned": record.pinned,
            "archived": record.archived,
            "last_seq": record.last_product_seq,
            "last_turn_status": record.last_turn_status,
            "workdir": record.runtime_workdir,
            "runtime_workdir": record.runtime_workdir,
            "project_path": record.project_path,
            **self._title_projection(record),
            "turns": 1 if record.last_turn_id else 0,
            "live": live is not None,
            "running": (bool(live and live.turn_active) or pending_running)
            and not recovery_blocked,
            "recovery_blocked": recovery_blocked,
            "recovery_pending": pending is not None,
            **(
                self._events.recovery_snapshot(record.session_id, pending.native_turn_id)
                if recovery_blocked and pending
                else {}
            ),
            "unknown_outcome": (
                live.ledger.has_unknown_outcome
                if live is not None
                else record.last_turn_status == PRODUCT_TURN_OUTCOME_UNKNOWN
            ),
            "waiting": record.status == SessionStatus.WAITING_HIL,
            "kind": "session",
        }

    async def interrupt(self, session_id: str) -> dict[str, Any]:
        live = self._sessions.get(session_id)
        if live is None:
            return {"ok": True, "idle": True, "interrupting": False}
        if live.resource_task is not None and not live.resource_task.done():
            if await live.cancel_resource_wait():
                return {"ok": True, "idle": True, "interrupting": False, "cancelled_waiting": True}
        if not live.running:
            if live.runtime_session is None:
                return {"ok": True, "idle": True, "interrupting": False}
            try:
                activity = await live.runtime_session.activity()
            except Exception:
                return {
                    "ok": False,
                    "error": "previous_turn_activity_unavailable",
                    "interrupting": False,
                }
            if activity.idle and not (
                live.runtime_driver is not None and live.runtime_driver.projection_failed
            ):
                return {"ok": True, "idle": True, "interrupting": False}
        try:
            await live.interrupt(cleanup_background_processes=True)
            if not live.running:
                await live.recover_runtime_projection()
        except Exception as exc:
            self._logger.error(
                "session_interrupt_failed session_id=%s failure_type=%s safe_error=%s",
                session_id,
                type(exc).__name__,
                str(getattr(exc, "safe_error", "") or ""),
                exc_info=True,
            )
            return {"ok": False, "error": "harness_interrupt_failed", "interrupting": False}
        await live.publish(
            PRODUCT_EVENT_SESSION_STATE,
            {
                "state": PRODUCT_SESSION_STATE_INTERRUPTED,
                "runtime_id": self._runtime.runtime_id,
            },
        )
        return {"ok": True, "idle": False, "interrupting": False}

    async def prepare_for_update_shutdown(self, generation: str) -> None:
        async with self._open_lock:
            snapshot = self._activities.snapshot()
            if snapshot.phase is not ActivityPhase.DRAINING or snapshot.generation != generation:
                raise MaintenanceStale("update_maintenance_stale")
            if self._update_shutdown_generation is not None:
                raise MaintenanceActive("update shutdown preparation already owned")
            self._update_shutdown_generation = generation
            self._update_shutdown_prepared = False
            self._update_shutdown_sessions = tuple(self._sessions.values())
            preparations = tuple(
                asyncio.create_task(live.prepare_update_shutdown(generation))
                for live in self._update_shutdown_sessions
            )
            gathering = asyncio.gather(*preparations, return_exceptions=True)
            cancellation = None
            while not gathering.done():
                try:
                    await asyncio.shield(gathering)
                except asyncio.CancelledError as error:
                    if cancellation is None:
                        cancellation = error
                        for preparation in preparations:
                            if not preparation.done() and not preparation.cancelling():
                                preparation.cancel()
            results = gathering.result()
            if cancellation is not None:
                failures = []
                for result in results:
                    if isinstance(result, asyncio.CancelledError):
                        continue
                    if isinstance(result, BaseExceptionGroup):
                        _cancelled, remaining = result.split(asyncio.CancelledError)
                        if remaining is None:
                            continue
                    if isinstance(result, BaseException):
                        failures.append(result)
                if failures:
                    raise BaseExceptionGroup(
                        "update shutdown preparation failed during cancellation",
                        [*failures, cancellation],
                    ) from None
                raise cancellation
            for result in results:
                if isinstance(result, BaseException):
                    raise result
            snapshot = self._activities.snapshot()
            if snapshot.phase is not ActivityPhase.DRAINING or snapshot.generation != generation:
                raise MaintenanceStale("update_maintenance_stale")
            self._update_shutdown_prepared = True

    def resume_after_update_shutdown(self, generation: str) -> None:
        snapshot = self._activities.snapshot()
        if (
            snapshot.phase is not ActivityPhase.DRAINING
            or snapshot.generation != generation
            or self._update_shutdown_generation != generation
        ):
            raise MaintenanceStale("update_maintenance_stale")
        if not self._update_shutdown_prepared:
            raise MaintenanceActive("update shutdown preparation incomplete")
        for live in self._update_shutdown_sessions:
            live.resume_after_update_shutdown(generation)
        self._update_shutdown_sessions = ()
        self._update_shutdown_generation = None
        self._update_shutdown_prepared = False

    async def interrupt_running_for_shutdown(self) -> None:
        async def stop(live: LiveSession, task: asyncio.Task[Any]) -> None:
            while not task.done() and not live.ledger.active_turn_id:
                await asyncio.sleep(SESSION_RELOCATE_STOP_POLL_SECONDS)
            if not task.done():
                await live.interrupt(cleanup_background_processes=True)
            await asyncio.shield(task)

        await asyncio.gather(
            *(
                stop(live, live.current_task)
                for live in tuple(self._sessions.values())
                if live.current_task is not None and not live.current_task.done()
            )
        )

    async def interrupt_running_for_update(self) -> None:
        """Honor the confirmed restart for every session owned by this Serve instance.

        The private parent control closes new admission before calling this method.
        A successful interrupt receipt alone is not a drain receipt: the caller
        must still wait for all execution leases to end.
        """

        async def interrupt_one(session_id: str, live: LiveSession) -> dict[str, Any]:
            # An admitted turn can still be starting before it has a vendor ID.
            # Interrupting in that window receives a no-op native receipt.
            while (
                self._sessions.get(session_id) is live
                and live.running
                and not live.ledger.active_turn_id
                and (live.resource_task is None or live.resource_task.done())
            ):
                await asyncio.sleep(SESSION_RELOCATE_STOP_POLL_SECONDS)
            if not live.running and live.runtime_session is not None:
                # A completed root turn can leave native descendants running.
                # Maintenance owns all attached execution, not only UI turns.
                await live.interrupt(cleanup_background_processes=True)
                return {"ok": True}
            return await self.interrupt(session_id)

        async def interrupt_invocations() -> dict[str, Any]:
            # Service tools can await an independent invocation while the parent
            # turn is stopping. Request both interrupts before waiting for either.
            await self._runtime.interrupt_invocations_for_update()
            return {"ok": True}

        selected = tuple(self._sessions.items())
        self._logger.info(
            "update session interruption started: sessions=%d running=%d",
            len(selected),
            sum(bool(live.running) for _session_id, live in selected),
        )
        results = await asyncio.gather(
            interrupt_invocations(),
            *(interrupt_one(session_id, live) for session_id, live in selected),
            return_exceptions=True,
        )
        if any(isinstance(result, BaseException) or not result.get("ok") for result in results):
            self._logger.warning("update session interruption failed")
            raise RuntimeError("update session interruption failed")
        self._logger.info("update session interruption accepted: sessions=%d", len(selected))

    async def terminate(
        self, session_id: str, *, require_idle: bool = False
    ) -> tuple[dict[str, Any], int]:
        live = self._sessions.get(session_id)
        if live is None:
            return {"ok": False, "error": "session_not_live"}, HTTP_CONFLICT
        task = asyncio.current_task()
        async with live.lifecycle_lock:
            close_only = require_idle and live.terminated and live.termination_task is None
            if live.closing and not close_only:
                return {"ok": False, "error": SESSION_TERMINATED}, HTTP_CONFLICT
            live.terminating = not require_idle
            live.termination_task = task
        try:
            if not close_only:
                await live.cancel_resource_wait()
                await self._runtime.cancel_activation(session_id)
                if live.runtime_binding is not None and live.runtime_session is None:
                    await self._runtime.ensure_active(live)
                async with live.lifecycle_lock:
                    if self._queue_cancellation is not None:
                        await self._queue_cancellation(session_id)
                if require_idle and live.runtime_session is not None:
                    async with asyncio.timeout(SESSION_ARCHIVE_STOP_TIMEOUT_SECONDS):
                        await live.interrupt(cleanup_background_processes=True)
                        while not (await live.runtime_session.activity()).idle:
                            await asyncio.sleep(SESSION_ARCHIVE_POLL_SECONDS)
                        if self._access.pending_turn_settlement(session_id) is not None and (
                            live.current_task is None or live.current_task.done()
                        ):
                            if self._settlement_resume is None:
                                raise RuntimeError("pending turn settlement has no recovery owner")
                            self._settlement_resume(live)
                        if live.current_task is not None and not live.current_task.done():
                            await asyncio.shield(live.current_task)
                        if self._access.pending_turn_settlement(session_id) is not None:
                            raise RuntimeError("product turn settlement is incomplete")
                async with live.lifecycle_lock:
                    await live.terminate()
            await live.aclose()
            if self._sessions.get(session_id) is live:
                self._sessions.pop(session_id)
            return {"ok": True, "session_id": session_id, "terminated": True}, HTTP_OK
        except Exception as error:
            self._logger.error(
                "session_termination_failed session_id=%s require_idle=%s failure_type=%s",
                session_id,
                require_idle,
                type(error).__name__,
                exc_info=True,
            )
            return {"ok": False, "error": "runtime_session_terminate_failed"}, HTTP_CONFLICT
        finally:
            async with live.lifecycle_lock:
                if live.termination_task is task:
                    live.termination_task = None
                    if not live.terminated:
                        live.terminating = False

    def requires_host_for_hil(self, request_id: str) -> bool:
        try:
            record = self._access.hil(request_id)
            return any(
                isinstance(question, Mapping)
                and bool(question.get("component") or question.get(INSTALLATION_FIELD))
                for question in record.payload.get("questions", [])
            ) or record.method in {
                BROWSER_APPROVAL_METHOD,
                BROWSER_HISTORY_APPROVAL_METHOD,
            }
        except SessionAccessError:
            return False

    async def respond_hil(
        self,
        session_id: str,
        request_id: str,
        body: Mapping[str, Any],
    ) -> tuple[dict[str, Any], int]:
        live = self._sessions.get(session_id)
        if live is None:
            return {"ok": False, "error": "session_not_live"}, HTTP_CONFLICT
        try:
            stored = self._access.hil(request_id)
            if stored.session_id != session_id:
                return {"ok": False, "error": "hil_request_stale"}, HTTP_CONFLICT
            if stored.status is HilStatus.RESOLVED and any(
                isinstance(question, Mapping) and question.get("component")
                for question in stored.payload.get("questions", [])
            ):
                for question in stored.payload.get("questions", []):
                    reference = question.get("component") if isinstance(question, Mapping) else None
                    if reference:
                        snapshot = live.component_registry.snapshot(reference, user_id=live.user_id)
                        if snapshot["interaction"]["session_id"] != session_id:
                            raise ValueError("component_binding_invalid")
                if dict(stored.decision or {}) != dict(body):
                    return {"ok": False, "error": "hil_response_conflict"}, HTTP_CONFLICT
                return {
                    "ok": True,
                    "request_id": request_id,
                    "interaction": interaction_snapshot(stored),
                }, HTTP_OK
        except (SessionAccessError, ValueError, OSError, KeyError, TypeError) as error:
            return {"ok": False, "error": str(error)}, HTTP_CONFLICT
        activity = live.interactions.product_activity(request_id) or live.turn_activity
        lease = (
            self._activities.continue_from(activity, ActivityDomain.TURN)
            if activity is not None
            else self._activities.enter(ActivityDomain.TURN, root=True)
        )
        with lease:
            try:
                record = self._access.hil(request_id)
                if record.session_id != session_id:
                    return {"ok": False, "error": "hil_request_stale"}, HTTP_CONFLICT
                for question in record.payload.get("questions", []):
                    if isinstance(question, Mapping) and question.get(INSTALLATION_FIELD):
                        live.validate_installation_answer(question, body)
                    reference = question.get("component") if isinstance(question, Mapping) else None
                    if not reference:
                        continue
                    if not isinstance(reference, Mapping):
                        raise ValueError(PLUGIN_COMPONENT_STALE)
                    live.component_registry.validate(
                        reference, session_id=session_id, user_id=live.user_id
                    )
                    if question.get(COMPONENT_REQUEST_MARKER) and not body.get("cancelled"):
                        answers = body.get("answers")
                        if not isinstance(answers, Mapping) or set(answers) != {question["id"]}:
                            raise ValueError("component_answer_invalid")
                        answer = json.loads(answers[question["id"]])
                        if not isinstance(answer, dict) or set(answer) != {"action", "values"}:
                            raise ValueError("component_answer_invalid")
                        snapshot = live.component_registry.snapshot(reference, user_id=live.user_id)
                        action = component_action(
                            snapshot["descriptor"], reference["component"], answer["action"]
                        )
                        if action is None or action["capability"] != COMPONENT_ANSWER_CAPABILITY:
                            raise ValueError("component_action_denied")
                        definition = next(
                            item
                            for item in snapshot["descriptor"]["components"]
                            if item["id"] == reference["component"]
                        )
                        validate_component_submission(
                            definition, answer["action"], answer["values"]
                        )
            except ComponentValidationError as error:
                return {"ok": False, "error": str(error), "detail": error.detail}, HTTP_CONFLICT
            except (SessionAccessError, ValueError, OSError, KeyError, TypeError) as error:
                return {"ok": False, "error": str(error)}, HTTP_CONFLICT
            if live.interactions.is_product_request(request_id):
                interaction = await live.interactions.resolve(
                    None, request_id, body, active_turn_id=live.ledger.active_turn_id
                )
            else:
                async with self._runtime.operation(live, request_id=request_id) as session:
                    interaction = await live.interactions.resolve(session, request_id, body)
            if interaction is None:
                uncertainty = next(
                    (
                        row
                        for row in live.ledger.uncertainty_snapshot()
                        if row["correlation_id"] == request_id
                    ),
                    None,
                )
                if uncertainty is not None:
                    return {
                        "ok": False,
                        "error": "hil_response_not_retryable",
                        "operation": uncertainty,
                    }, HTTP_CONFLICT
                return {"ok": False, "error": "hil_request_stale"}, HTTP_CONFLICT
            return {
                "ok": True,
                "request_id": request_id,
                "interaction": interaction,
            }, HTTP_OK

    def pending_interactions(self, principal: SessionPrincipal) -> dict[str, Any]:
        """Return every live, owner-visible question waiting for user input."""

        interactions = [
            interaction_snapshot(record)
            for record in self._access.pending_hil_for_principal(principal)
            if record.method
            in {
                USER_INPUT_METHOD,
                PRODUCT_USER_INPUT_METHOD,
                BROWSER_APPROVAL_METHOD,
                BROWSER_HISTORY_APPROVAL_METHOD,
            }
            and record.session_id in self._sessions
        ]
        return {"interactions": interactions}

    async def confirm_unknown_turn(
        self,
        session_id: str,
        turn_id: str,
        body: Mapping[str, Any],
    ) -> tuple[dict[str, Any], int]:
        if str(body.get("decision") or "") != TURN_UNKNOWN_CONFIRM_DECISION:
            return {"ok": False, "error": TURN_UNKNOWN_CONFIRM_INVALID}, HTTP_BAD_REQUEST
        live = self._sessions.get(session_id)
        if live is None:
            return {"ok": False, "error": "session_not_live"}, HTTP_CONFLICT
        async with live.lifecycle_lock:
            result, status = await self._confirm_unknown_locked(live, turn_id)
        if result.get("ok") and self._turn_confirmation is not None:
            await self._turn_confirmation(session_id, turn_id)
        return result, status

    async def authorize_crash_retry(self, live: LiveSession, turn_id: str) -> bool:
        result, _status = await self._confirm_unknown_locked(live, turn_id, automatic_retry=True)
        return bool(result.get("ok"))

    async def _confirm_unknown_locked(
        self, live: LiveSession, turn_id: str, *, automatic_retry: bool = False
    ) -> tuple[dict[str, Any], int]:
        session_id = live.id
        if self._sessions.get(session_id) is not live:
            return {"ok": False, "error": "session_not_live"}, HTTP_CONFLICT
        confirmation_receipt: TurnConfirmationReceipt | None = None
        expected_uncertainty = self._durable_turn_confirmation(live, turn_id)
        confirmation_supported = any(
            capability.name == RuntimeCapabilityName.TURN_CONFIRMATION.value
            and capability.state is CapabilityState.SUPPORTED
            for capability in live.gateway_capabilities.entries
        )
        if automatic_retry and not confirmation_supported:
            return {"ok": False, "error": RUNTIME_CONFIRMATION_STALE}, HTTP_CONFLICT
        if confirmation_supported and expected_uncertainty is None:
            driver = live.runtime_driver
            if driver is None or live.terminating or live.terminated:
                return {"ok": False, "error": RUNTIME_CONFIRMATION_STALE}, HTTP_CONFLICT
            try:
                await driver.drain_observations()
                uncertainty = self._access.uncertainty(session_id, UncertaintyKind.TURN, turn_id)
                if (
                    uncertainty is None
                    or uncertainty.process_generation <= 0
                    or not uncertainty.incident_id
                ):
                    return {"ok": False, "error": RUNTIME_CONFIRMATION_STALE}, HTTP_CONFLICT
                expected_uncertainty = (uncertainty.process_generation, uncertainty.incident_id)
                receipt = await driver.confirm_turn(
                    TurnConfirmationTarget(
                        product_session_id=session_id,
                        native_session_id=driver.session.binding.opaque_session_ref,
                        client_submission_id=turn_id,
                        incident_id=uncertainty.incident_id,
                        process_generation=uncertainty.process_generation,
                    )
                )
                if receipt.state is not CommandState.APPLIED:
                    return {"ok": False, "error": RUNTIME_CONFIRMATION_STALE}, HTTP_CONFLICT
                confirmation_receipt = receipt
            except Exception as error:
                self._logger.warning(
                    "runtime_turn_confirmation_failed session_id=%s error_type=%s",
                    session_id,
                    type(error).__name__,
                )
                return {"ok": False, "error": RUNTIME_CONFIRMATION_STALE}, HTTP_CONFLICT
        if not await live.ledger.confirm_unknown_turn(
            turn_id,
            expected_uncertainty=expected_uncertainty,
            confirmation_receipt=confirmation_receipt,
            automatic_retry=automatic_retry,
        ):
            if not await live.ledger.republish_confirmed_turn(
                turn_id,
                expected_uncertainty=expected_uncertainty,
                confirmation_receipt=confirmation_receipt,
                automatic_retry=automatic_retry,
            ):
                return (
                    ({"ok": False, "error": RUNTIME_CONFIRMATION_STALE}, HTTP_CONFLICT)
                    if expected_uncertainty is not None
                    else ({"ok": False, "error": TURN_UNKNOWN_NOT_FOUND}, HTTP_NOT_FOUND)
                )
        return {
            "ok": True,
            "turn_id": turn_id,
            "resolution": (
                AUTOMATIC_CRASH_RETRY if automatic_retry else TURN_UNKNOWN_CONFIRM_DECISION
            ),
            "unknown_outcome": True,
        }, HTTP_OK

    def _durable_turn_confirmation(self, live: LiveSession, turn_id: str) -> tuple[int, str] | None:
        uncertainty = self._access.uncertainty(live.id, UncertaintyKind.TURN, turn_id)
        binding = live.runtime_binding
        if (
            uncertainty is None
            or uncertainty.state is not UncertaintyState.CONFIRMED
            or uncertainty.process_generation <= 0
            or not uncertainty.incident_id
            or binding is None
        ):
            return None
        provenance = uncertainty.payload.get(UNCERTAINTY_CONFIRMATION_KEY)
        if not isinstance(provenance, Mapping):
            return None
        target = asdict(
            TurnConfirmationTarget(
                product_session_id=live.id,
                native_session_id=binding.opaque_session_ref,
                client_submission_id=turn_id,
                incident_id=uncertainty.incident_id,
                process_generation=uncertainty.process_generation,
            )
        )
        if (
            provenance.get("target") != target
            or not isinstance(provenance.get("ticket_id"), str)
            or not provenance.get("ticket_id")
            or not isinstance(provenance.get("generation"), str)
            or not provenance.get("generation")
            or any(
                not isinstance(provenance.get(field), int)
                or isinstance(provenance.get(field), bool)
                or provenance[field] < 0
                for field in ("revision", "watermark")
            )
        ):
            return None
        return uncertainty.process_generation, uncertainty.incident_id

    async def delete(
        self,
        session_id: str,
        principal: SessionPrincipal,
        *,
        actor_id: str = "",
    ) -> tuple[dict[str, Any], int]:
        async with self._open_lock:
            return await self._activities.finish(
                ActivityDomain.RESOURCE, lambda: self._delete(session_id, principal, actor_id)
            )

    async def _delete(
        self, session_id: str, principal: SessionPrincipal, actor_id: str
    ) -> tuple[dict[str, Any], int]:
        self.require_access(session_id, principal)
        if self._deletion is None:
            return {"ok": False, "error": SESSION_DELETION_UNAVAILABLE}, HTTP_UNAVAILABLE
        record = self._access.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        payload, status = await self._stop_for_removal(record, principal, actor_id)
        if status != HTTP_OK:
            return {"ok": False, "error": SESSION_DELETE_STOP_FAILED}, status
        try:
            await self._activities.to_thread(ActivityDomain.RESOURCE, self._deletion, record)
        except Exception:
            self._logger.exception("session_deletion_failed session_id=%s", session_id)
            return {"ok": False, "error": SESSION_DELETION_FAILED}, HTTP_INTERNAL_ERROR
        self._access.release(session_id, principal)
        return {"ok": True, "session_id": session_id}, HTTP_OK

    async def rename(
        self,
        session_id: str,
        title: str,
        principal: SessionPrincipal,
    ) -> tuple[dict[str, Any], int]:
        clean = title.strip()
        if not clean:
            return {"ok": False, "error": "session_title_required"}, HTTP_BAD_REQUEST
        if len(clean) > SESSION_RENAME_MAX_LENGTH:
            return {"ok": False, "error": "session_title_too_long"}, HTTP_BAD_REQUEST
        live = self._sessions.get(session_id)
        if live is None:
            record = self._access.rename(session_id, principal, clean)
        else:
            async with live.lifecycle_lock:
                record = self._access.rename(session_id, principal, clean)
                if not live.terminating and not live.terminated:
                    await live.publish(
                        PRODUCT_EVENT_SESSION_TITLE_UPDATED,
                        {"title": record.title, "title_fallback": record.title_fallback},
                    )
        return {
            "ok": True,
            "session_id": session_id,
            "title": record.title,
            "title_fallback": record.title_fallback,
        }, HTTP_OK

    async def set_archived(
        self,
        session_id: str,
        archived: bool,
        principal: SessionPrincipal,
        *,
        actor_id: str,
        skill_environment: Mapping[str, str] | None = None,
    ) -> tuple[dict[str, Any], int]:
        async with self._open_lock:
            self.require_access(session_id, principal)
            record = self._access.get(session_id)
            if record is None:
                raise SessionAccessError("session not found")
            if record.archived == archived:
                return {"ok": True, "session_id": session_id, "archived": archived}, HTTP_OK
            if archived and await self._archive_if_idle(record, principal):
                return {"ok": True, "session_id": session_id, "archived": archived}, HTTP_OK
            if archived:
                payload, status = await self._stop_for_removal(
                    record, principal, actor_id, skill_environment
                )
                if status != HTTP_OK:
                    return {"ok": False, "error": SESSION_ARCHIVE_STOP_FAILED}, status
            self._access.set_archived(session_id, principal, archived)
            return {"ok": True, "session_id": session_id, "archived": archived}, HTTP_OK

    async def _archive_if_idle(
        self, record: SessionCatalogRecord, principal: SessionPrincipal
    ) -> bool:
        session_id = record.session_id
        live = self._sessions.get(session_id)
        async with AsyncExitStack() as scope:
            if live is not None:
                await scope.enter_async_context(live.lifecycle_lock)
                if (
                    live.running
                    or live.interrupting
                    or live.closing
                    or (live.resource_task is not None and not live.resource_task.done())
                ):
                    return False
            pending = self._access.pending_turn_settlement(session_id)
            if (
                live is None
                and record.status in {SessionStatus.RUNNING, SessionStatus.WAITING_HIL}
                and not (pending is not None and pending.recovery_blocked)
            ) or self._access.queued_messages(session_id):
                return False
            if live is not None and live.pending_hil_snapshot():
                return False
            activation = self._access.activation(session_id)
            if activation is not None and activation.open_state in {
                OpenState.OPENING,
                OpenState.OPEN_UNKNOWN,
            }:
                return False
            if live is not None and live.runtime_session is not None:
                try:
                    activity = await live.runtime_session.activity()
                except Exception:
                    return False
                if not activity.idle or not activity.execution_tree_idle:
                    return False
            self._access.set_archived(session_id, principal, True)
            return True

    async def _stop_for_removal(
        self,
        record: SessionCatalogRecord,
        principal: SessionPrincipal,
        actor_id: str,
        skill_environment: Mapping[str, str] | None = None,
    ) -> tuple[dict[str, Any], int]:
        session_id = record.session_id
        live = self._sessions.get(session_id)
        needs_stop = (
            record.status in {SessionStatus.RUNNING, SessionStatus.WAITING_HIL}
            or bool(self._access.queued_messages(session_id))
            or self._access.pending_turn_settlement(session_id) is not None
        )
        if live is None and needs_stop:
            with self._activities.enter(ActivityDomain.RUNTIME, root=True):
                payload, status = await self._resume(
                    session_id, principal, actor_id, skill_environment
                )
            if status != HTTP_OK:
                return payload, status
            live = self._sessions.get(session_id)
        if live is not None or needs_stop:
            return await self.terminate(session_id, require_idle=True)
        return {"ok": True}, HTTP_OK

    def set_pinned(
        self,
        session_id: str,
        pinned: bool,
        principal: SessionPrincipal,
    ) -> dict[str, Any]:
        record = self._access.set_pinned(session_id, principal, pinned)
        return {"ok": True, "session_id": session_id, "pinned": record.pinned}

    async def assign_project(
        self,
        *,
        session_id: str,
        principal: SessionPrincipal,
        project_path: str,
        stop_running: bool = False,
    ) -> tuple[dict[str, Any], int]:
        self.require_access(session_id, principal)
        record = self._access.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        live = self._sessions.get(session_id)
        target = Path(project_path).expanduser().resolve()
        if not self._workspaces.is_project(target):
            return {
                "ok": False,
                "error": SESSION_PROJECT_NOT_REGISTERED_ERROR,
            }, HTTP_CONFLICT
        if not self._workspaces.allows(
            principal_id=principal.user_id,
            active_workspace=self._cwd,
            requested_workspace=target,
        ):
            return {
                "ok": False,
                "error": SESSION_PROJECT_NOT_AUTHORIZED_ERROR,
            }, HTTP_CONFLICT
        if record.project_path == str(target):
            return {
                "ok": True,
                "session_id": session_id,
                "project_path": str(target),
                "runtime_workdir": record.runtime_workdir,
                "output_root": record.output_root,
            }, HTTP_OK
        if not record.last_turn_id and (live is None or not live.running):
            return {
                "ok": False,
                "error": SESSION_RELOCATE_REQUIRES_TURN_ERROR,
            }, HTTP_CONFLICT
        if live is not None and live.running and not stop_running:
            return {"ok": False, "error": SESSION_RUNNING_ERROR}, HTTP_CONFLICT
        try:
            self._preflight_workspace(record)
            target_output = self._project_output_directory(target, session_id)
        except ValueError as error:
            return {"ok": False, "error": str(error)}, HTTP_CONFLICT
        if live is None:
            try:
                assigned = self._relocate_record(
                    session_id,
                    principal,
                    runtime_workdir=str(target_output),
                    project_path=str(target),
                    output_root=str(target_output),
                )
            except SessionStateConflictError as error:
                return {"ok": False, "error": str(error)}, HTTP_CONFLICT
        else:
            async with live.activation_lock:
                if live.running:
                    if not stop_running:
                        return {"ok": False, "error": SESSION_RUNNING_ERROR}, HTTP_CONFLICT
                    # Interrupt acknowledgement is not a terminal event. Keep turn
                    # admission locked until the real runtime and local executor
                    # are both idle, then rebind and persist within the same lock.
                    try:
                        async with asyncio.timeout(SESSION_RELOCATE_STOP_TIMEOUT_SECONDS):
                            # A just-admitted first turn may not have a vendor ID
                            # yet. Interrupt only once there is a real target;
                            # do not treat this startup window as an empty chat.
                            while live.running and not live.ledger.active_turn_id:
                                await asyncio.sleep(SESSION_RELOCATE_STOP_POLL_SECONDS)
                            if live.running:
                                await live.interrupt()
                            while live.running:
                                await asyncio.sleep(SESSION_RELOCATE_STOP_POLL_SECONDS)
                    except TimeoutError:
                        self._logger.warning(
                            SESSION_RELOCATE_STOP_PENDING_ERROR,
                            extra={"session_id": session_id},
                        )
                        return {
                            "ok": False,
                            "error": SESSION_RELOCATE_STOP_PENDING_ERROR,
                        }, HTTP_CONFLICT
                    except Exception as exc:
                        self._logger.error(
                            SESSION_RELOCATE_STOP_FAILED_ERROR,
                            extra={"session_id": session_id, "failure_type": type(exc).__name__},
                        )
                        return {
                            "ok": False,
                            "error": SESSION_RELOCATE_STOP_FAILED_ERROR,
                        }, HTTP_CONFLICT
                # The first turn may have been persisted during the wait above.
                record = self._access.get(session_id)
                if record is None:
                    raise SessionAccessError("session not found")
                if not record.last_turn_id:
                    return {
                        "ok": False,
                        "error": SESSION_RELOCATE_REQUIRES_TURN_ERROR,
                    }, HTTP_CONFLICT
                relocate_mode = record.policy_id or ASK_PERMISSION_MODE
                try:
                    await self._runtime.rebind(
                        live,
                        cwd=target_output,
                        project_path=target,
                        output_root=target_output,
                        writable_roots=self._writable_roots(target),
                        model_id=self._model_state(session_id).active_model_id,
                        process_environment=self._credentials.cached_environment(live.user_id),
                    )
                    live.applied_permission_mode = relocate_mode
                    try:
                        assigned = self._relocate_record(
                            session_id,
                            principal,
                            runtime_workdir=str(target_output),
                            project_path=str(target),
                            output_root=str(target_output),
                        )
                    except Exception:
                        await self._runtime.rebind(
                            live,
                            cwd=Path(record.runtime_workdir),
                            project_path=(
                                Path(record.project_path) if record.project_path else None
                            ),
                            output_root=Path(record.output_root),
                            writable_roots=self._writable_roots(
                                Path(record.project_path or record.runtime_workdir)
                            ),
                            model_id=self._model_state(session_id).active_model_id,
                        )
                        raise
                except SessionStateConflictError as error:
                    return {"ok": False, "error": str(error)}, HTTP_CONFLICT
                except Exception as exc:
                    self._logger.error(
                        SESSION_RELOCATE_FAILED_ERROR,
                        extra={"session_id": session_id, "failure_type": type(exc).__name__},
                    )
                    return {
                        "ok": False,
                        "error": SESSION_RELOCATE_FAILED_ERROR,
                    }, 500
        return {
            "ok": True,
            "session_id": session_id,
            "project_path": assigned.project_path,
            "runtime_workdir": assigned.runtime_workdir,
            "output_root": assigned.output_root,
        }, HTTP_OK

    def history(self, session_id: str) -> dict[str, Any]:
        record = self._access.get(session_id)
        live = self._sessions.get(session_id)
        if record is not None:
            if live is not None:
                live.recover_publications()
            else:
                self._runtime.recover_publications(session_id)
        detached = live is None or live.runtime_session is None
        durable_history = self._events.portable_history(session_id) if detached else ()
        return {
            "turns": (
                live.history()
                if live is not None and not detached
                else [
                    {
                        "kind": (
                            "user"
                            if entry.role == "user"
                            else ("thinking" if entry.phase == MessagePhase.COMMENTARY else "text")
                        ),
                        "role": entry.role,
                        "text": entry.text,
                        "turn_id": entry.turn_id,
                        "item_id": entry.item_id,
                        "phase": entry.phase.value if entry.phase is not None else None,
                    }
                    for entry in durable_history
                ]
            ),
            "recovery_blocked": bool(
                (pending := self._access.pending_turn_settlement(session_id))
                and (live is None or pending.recovery_blocked)
            ),
            "recovery_pending": pending is not None,
            "todos": list(record.todos) if record is not None else [],
            **(
                self._events.recovery_snapshot(session_id, pending.native_turn_id)
                if pending and (live is None or pending.recovery_blocked)
                else {}
            ),
            "todo_turn_id": record.todo_turn_id if record is not None else None,
            "todo_explanation": record.todo_explanation if record is not None else None,
            "artifacts": (
                artifact_snapshot_payload(self._artifacts.list_session(session_id))
                if record is not None
                else []
            ),
        }

    def files(
        self, session_id: str, path: str = "", offset: int = 0, *, outputs_only: bool = False
    ) -> dict[str, Any]:
        """Browse the immutable workdir bound to one product session."""

        root = self._session_root(session_id)
        directory = resolve_child(root, path)
        input_root = root / SESSION_ATTACHMENT_DIRNAME
        hidden_names = SESSION_BROWSER_HIDDEN_NAMES
        if outputs_only and directory == root:
            hidden_names = (*hidden_names, SESSION_ATTACHMENT_DIRNAME)
        listing = list_directory(
            root,
            path,
            hide_dotfiles=True,
            hidden_names=hidden_names,
            offset=offset,
        )
        session_record = self._access.get(session_id)
        project = (
            Path(session_record.project_path)
            if session_record is not None and session_record.project_path
            else None
        )
        listing["project_path"] = (
            root.relative_to(project).as_posix()
            if project is not None and root.is_relative_to(project)
            else None
        )
        if outputs_only and directory.is_relative_to(input_root):
            return {
                **listing,
                "items": [],
                "total": 0,
                "artifacts": [],
                "literature": [],
                "has_files": False,
            }
        artifacts = self._artifacts.list_session(session_id)
        if outputs_only:
            artifacts = tuple(
                artifact
                for artifact in artifacts
                if not Path(artifact.canonical_path).resolve().is_relative_to(input_root)
            )
        published = {
            record.canonical_path: record
            for record in sorted(artifacts, key=lambda record: record.created_at)
            if record.metadata.get("publication_id")
        }
        for item in listing["items"]:
            record = published.get(str(root / listing["path"] / item["name"]))
            if record is not None:
                item["artifact"] = artifact_snapshot_payload((record,))[0]
        indexed = {}
        if not listing["path"]:
            for artifact in sorted(artifacts, key=lambda artifact: artifact.created_at):
                target = Path(artifact.canonical_path).resolve()
                if not target.is_relative_to(root) or not target.is_file():
                    continue
                relative = target.relative_to(root)
                if not any(part.startswith(".") for part in relative.parts[:-1]):
                    continue
                if relative.name.startswith(".") or relative.name in SESSION_BROWSER_HIDDEN_NAMES:
                    continue
                metadata = target.stat()
                indexed[str(target)] = {
                    "name": relative.as_posix(),
                    "dir": False,
                    "size": metadata.st_size,
                    "updated_at": metadata.st_mtime,
                    "artifact": artifact_snapshot_payload((artifact,))[0],
                }
            total = listing["total"]
            listing["items"].extend(
                list(indexed.values())[
                    max(0, offset - total) : max(0, offset + MAX_DIRECTORY_ITEMS - total)
                ]
            )
            listing["total"] += len(indexed)
        listing["artifacts"] = artifact_snapshot_payload(artifacts)
        listing["literature"] = (
            list(self._task_documents(session_id, session_record.project_path))
            if not outputs_only
            and not listing["path"]
            and session_record is not None
            and session_record.project_path
            else []
        )

        def scan_error(error: OSError) -> None:
            raise error

        has_files = bool(listing["literature"] or indexed)
        if not has_files:
            for parent, directories, files in os.walk(
                directory, followlinks=False, onerror=scan_error
            ):
                directories[:] = [
                    name
                    for name in directories
                    if not name.startswith(".")
                    and not (outputs_only and Path(parent) / name == input_root)
                ]
                if any(
                    not name.startswith(".") and name not in SESSION_BROWSER_HIDDEN_NAMES
                    for name in files
                ):
                    has_files = True
                    break
        listing["has_files"] = has_files
        return listing

    def file_content(self, session_id: str, path: str) -> dict[str, Any]:
        local_file = self._authorized_local_file(session_id, path)
        if local_file is not None:
            return read_file(local_file.parent, local_file.name)
        return read_file(*self._session_file_path(session_id, path))

    def file_raw(self, session_id: str, path: str) -> tuple[bytes, str]:
        local_file = self._authorized_local_file(session_id, path)
        if local_file is not None:
            return read_file_raw(local_file.parent, local_file.name)
        return read_file_raw(*self._session_file_path(session_id, path))

    def _session_file_path(self, session_id: str, path: str) -> tuple[Path, str]:
        root = self._session_root(session_id)
        candidate = Path(path)
        if candidate.is_absolute() and candidate.is_relative_to(root):
            path = candidate.relative_to(root).as_posix()
        return root, path

    def _authorized_local_file(self, session_id: str, path: str) -> Path | None:
        candidate = Path(path).expanduser()
        if not candidate.is_absolute():
            return None
        live = self._sessions.get(session_id)
        return live.authorized_local_input_file(candidate) if live is not None else None

    def _session_root(self, session_id: str) -> Path:
        live = self._sessions.get(session_id)
        if live is not None:
            return live.runtime_workdir
        record = self._access.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        return Path(record.runtime_workdir).expanduser().resolve()

    def save_attachment(
        self,
        session_id: str,
        *,
        filename: str,
        content: bytes,
        media_type: str,
    ) -> dict[str, Any]:
        """Write an explicit upload under the bound session authorization root."""

        live = self._sessions.get(session_id)
        if live is None:
            raise SessionAccessError("session not live")
        safe_name = Path(filename).name.strip()
        if not safe_name or safe_name in {".", ".."}:
            raise ValueError("attachment filename is invalid")
        attachment_root = (live.runtime_workdir / SESSION_ATTACHMENT_DIRNAME).resolve()
        attachment_root.mkdir(parents=True, exist_ok=True)
        target = (attachment_root / f"{uuid.uuid4().hex}-{safe_name}").resolve()
        try:
            target.relative_to(attachment_root)
            target.relative_to(live.runtime_workdir)
        except ValueError as exc:
            raise ValueError("attachment path escapes the session workspace") from exc
        target.write_bytes(content)
        return {
            "path": str(target),
            "absolute_path": str(target),
            "relative_path": target.relative_to(live.runtime_workdir).as_posix(),
            "name": safe_name,
            "media_type": media_type or guess_media_type(safe_name) or "",
            "sha256": sha256(content).hexdigest(),
            "size": len(content),
        }

    def register_local_paths(
        self,
        session_id: str,
        paths: tuple[str, ...],
    ) -> builtins.list[dict[str, Any]]:
        """Authorize exact desktop-selected files or directories without copying them."""

        live = self._sessions.get(session_id)
        if live is None:
            raise ValueError("session_not_live")
        if not paths or len(paths) > SESSION_LOCAL_PATH_REFERENCE_LIMIT:
            raise ValueError("local_file_reference_count_invalid")
        canonical_paths: list[tuple[Path, InputKind]] = []
        seen: set[Path] = set()
        for raw in paths:
            selected = Path(raw).expanduser()
            if not selected.is_absolute():
                raise ValueError("local_file_path_must_be_absolute")
            canonical = selected.resolve()
            if canonical.is_dir() and (selected.is_symlink() or selected.is_junction()):
                raise ValueError("local_path_link_not_allowed")
            if not canonical.exists() or not (canonical.is_file() or canonical.is_dir()):
                raise ValueError("local_file_not_found")
            if canonical in seen:
                continue
            seen.add(canonical)
            canonical_paths.append(
                (
                    canonical,
                    InputKind.DIRECTORY if canonical.is_dir() else InputKind.FILE,
                )
            )
        references: list[dict[str, Any]] = []
        for path, kind in canonical_paths:
            reference: dict[str, Any] = {
                "reference_id": live.register_local_input_path(path, kind),
                "path": str(path),
                "name": path.name,
                "kind": kind.value,
                "media_type": "",
            }
            if kind == InputKind.FILE:
                reference["media_type"] = mimetypes.guess_type(path.name)[0] or ""
                reference["size"] = path.stat().st_size
            references.append(reference)
        return references

    async def mcp_snapshot(self, session_id: str, *, request_id: str = "") -> dict[str, Any]:
        snapshot, correlation_id = await self._run_mcp_control(
            session_id,
            kind=RuntimeControlKind.MCP_SNAPSHOT,
            operation=MCP_OPERATION_SNAPSHOT,
            request_id=request_id,
            values={},
        )
        payload = dict(snapshot) if isinstance(snapshot, Mapping) else {}
        payload["request_id"] = correlation_id
        return payload

    async def mcp_tools(
        self,
        session_id: str,
        *,
        server: str,
        cursor: str,
        limit: int,
        request_id: str = "",
    ) -> dict[str, Any]:
        page, correlation_id = await self._run_mcp_control(
            session_id,
            kind=RuntimeControlKind.MCP_LIST_TOOLS,
            operation=MCP_OPERATION_LIST_TOOLS,
            server=server,
            request_id=request_id,
            values={
                "server": server,
                "cursor": cursor,
                "limit": min(MCP_LIST_MAX_LIMIT, max(1, limit or MCP_LIST_DEFAULT_LIMIT)),
                "include_schema": True,
            },
        )
        return self._mcp_payload(page, correlation_id)

    async def mcp_resources(
        self,
        session_id: str,
        *,
        server: str,
        cursor: str,
        limit: int,
        request_id: str = "",
    ) -> dict[str, Any]:
        page, correlation_id = await self._run_mcp_control(
            session_id,
            kind=RuntimeControlKind.MCP_LIST_RESOURCES,
            operation=MCP_OPERATION_LIST_RESOURCES,
            server=server,
            request_id=request_id,
            values={
                "server": server,
                "cursor": cursor,
                "limit": min(MCP_LIST_MAX_LIMIT, max(1, limit or MCP_LIST_DEFAULT_LIMIT)),
            },
        )
        return self._mcp_payload(page, correlation_id)

    async def mcp_read_resource(
        self,
        session_id: str,
        *,
        server: str,
        uri: str,
        request_id: str = "",
    ) -> dict[str, Any]:
        if not server.strip() or not uri.strip():
            raise ValueError("mcp server and resource uri are required")
        contents, correlation_id = await self._run_mcp_control(
            session_id,
            kind=RuntimeControlKind.MCP_READ_RESOURCE,
            operation=MCP_OPERATION_READ_RESOURCE,
            server=server,
            target=uri,
            request_id=request_id,
            values={"server": server, "uri": uri},
        )
        return self._mcp_payload(contents, correlation_id)

    async def mcp_reload(
        self,
        session_id: str,
        *,
        server: str,
        request_id: str = "",
    ) -> dict[str, Any]:
        snapshot, correlation_id = await self._run_mcp_control(
            session_id,
            kind=RuntimeControlKind.MCP_RELOAD,
            operation=MCP_OPERATION_RELOAD,
            server=server,
            request_id=request_id,
            values={"server": server},
        )
        return self._mcp_payload(snapshot, correlation_id)

    async def mcp_call_tool(
        self,
        session_id: str,
        *,
        server: str,
        tool: str,
        arguments: Mapping[str, Any],
        meta: Mapping[str, Any],
        request_id: str = "",
        explicitly_approved: bool = False,
    ) -> dict[str, Any]:
        if not server.strip() or not tool.strip():
            raise ValueError("mcp server and tool are required")
        correlation_id = self._mcp_request_id(request_id)
        request_meta = dict(meta)
        request_meta[MCP_META_REQUEST_ID_KEY] = correlation_id
        result, correlation_id = await self._run_mcp_control(
            session_id,
            kind=RuntimeControlKind.MCP_CALL_TOOL,
            operation=MCP_OPERATION_CALL_TOOL,
            server=server,
            target=tool,
            request_id=correlation_id,
            explicitly_approved=explicitly_approved,
            approval_required=True,
            values={
                "server": server,
                "tool": tool,
                "arguments": dict(arguments),
                "meta": request_meta,
            },
        )
        return self._mcp_payload(result, correlation_id)

    async def mcp_begin_login(
        self,
        session_id: str,
        *,
        server: str,
        scopes: tuple[str, ...],
        request_id: str = "",
    ) -> dict[str, Any]:
        if not server.strip():
            raise ValueError("mcp server is required")
        challenge, correlation_id = await self._run_mcp_control(
            session_id,
            kind=RuntimeControlKind.MCP_LOGIN,
            operation=MCP_OPERATION_LOGIN,
            server=server,
            request_id=request_id,
            values={"server": server, "scopes": list(scopes)},
        )
        return self._mcp_payload(challenge, correlation_id)

    async def mcp_prompts(
        self,
        session_id: str,
        *,
        server: str,
        request_id: str = "",
    ) -> dict[str, Any]:
        page, correlation_id = await self._run_mcp_control(
            session_id,
            kind=RuntimeControlKind.MCP_LIST_PROMPTS,
            operation=MCP_OPERATION_LIST_PROMPTS,
            server=server,
            request_id=request_id,
            values={"server": server},
        )
        return self._mcp_payload(page, correlation_id)

    async def mcp_logout(
        self,
        session_id: str,
        *,
        server: str,
        request_id: str = "",
    ) -> dict[str, Any]:
        snapshot, correlation_id = await self._run_mcp_control(
            session_id,
            kind=RuntimeControlKind.MCP_LOGOUT,
            operation=MCP_OPERATION_LOGOUT,
            server=server,
            request_id=request_id,
            values={"server": server},
        )
        return self._mcp_payload(snapshot, correlation_id)

    async def mcp_trust(
        self,
        session_id: str,
        *,
        server: str,
        decision: str,
        request_id: str = "",
    ) -> dict[str, Any]:
        try:
            typed_decision = McpTrustDecision(decision)
        except ValueError as exc:
            raise ValueError("invalid mcp trust decision") from exc
        snapshot, correlation_id = await self._run_mcp_control(
            session_id,
            kind=RuntimeControlKind.MCP_TRUST,
            operation=MCP_OPERATION_TRUST,
            server=server,
            request_id=request_id,
            values={"server": server, "decision": typed_decision.value},
        )
        return self._mcp_payload(snapshot, correlation_id)

    async def _run_mcp_control(
        self,
        session_id: str,
        *,
        kind: RuntimeControlKind,
        operation: str,
        values: Mapping[str, Any],
        server: str = "",
        target: str = "",
        request_id: str = "",
        explicitly_approved: bool = False,
        approval_required: bool = False,
    ) -> tuple[Any, str]:
        live = self._sessions.get(session_id)
        if live is None:
            raise ValueError("mcp control is unavailable for this session")
        correlation_id = self._mcp_request_id(request_id)
        live.trace_mcp_control_started(
            request_id=correlation_id,
            operation=operation,
            server=server,
            target=target,
            explicitly_approved=explicitly_approved,
        )
        try:
            if approval_required and not explicitly_approved:
                raise ValueError(MCP_DIRECT_APPROVAL_REQUIRED)
            await self.prepare_turn(
                live, request_id=correlation_id, purpose=ResourcePurpose.SESSION
            )
            async with self._runtime.operation(live, request_id=correlation_id) as session:
                applied = await session.control(
                    RuntimeControlRequest(
                        command_id=correlation_id,
                        kind=kind,
                        values=dict(values),
                    )
                )
                if applied.state is not CommandState.APPLIED and not (
                    kind is RuntimeControlKind.MCP_RELOAD and applied.state is CommandState.ACCEPTED
                ):
                    raise ValueError(applied.safe_error or "mcp capability is unavailable")
                result = applied.values
        except Exception as exc:
            live.trace_mcp_control_completed(
                request_id=correlation_id,
                operation=operation,
                server=server,
                target=target,
                success=False,
                failure_type=type(exc).__name__,
            )
            raise
        success = not (isinstance(result, Mapping) and result.get("ok") is False)
        live.trace_mcp_control_completed(
            request_id=correlation_id,
            operation=operation,
            server=server,
            target=target,
            success=success,
        )
        return result, correlation_id

    @staticmethod
    def _mcp_request_id(value: str) -> str:
        normalized = value.strip()
        if not normalized:
            return uuid.uuid4().hex
        if len(normalized) > MCP_REQUEST_ID_MAX_LENGTH or any(
            not (character.isalnum() or character in MCP_REQUEST_ID_PUNCTUATION)
            for character in normalized
        ):
            raise ValueError("invalid mcp request id")
        return normalized

    @classmethod
    def _mcp_payload(cls, value: Any, request_id: str) -> dict[str, Any]:
        payload = cls._json_value(value)
        if not isinstance(payload, dict):
            payload = {"result": payload}
        payload["request_id"] = request_id
        return payload

    @classmethod
    def _json_value(cls, value: Any) -> Any:
        if is_dataclass(value) and not isinstance(value, type):
            return cls._json_value(asdict(value))
        if isinstance(value, Enum):
            return value.value
        if isinstance(value, Path):
            return str(value)
        if isinstance(value, Mapping):
            return {str(key): cls._json_value(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [cls._json_value(item) for item in value]
        return value

    def mode(self, session_id: str) -> dict[str, Any]:
        record = self._access.get(session_id)
        selected = record.policy_id if record and record.policy_id else ASK_PERMISSION_MODE
        live = self._sessions.get(session_id)
        active = live.applied_permission_mode if live and live.runtime_session is not None else ""
        payload = self._mode_payload(selected, active)
        return {
            **payload,
            "next_turn_selected": bool(
                record and record.next_turn_mode == selected and payload["deferred"]
            ),
            "current_turn_modes": [
                mode
                for mode in PRODUCT_PERMISSION_MODES
                if live
                and isinstance(live.runtime_session, PermissionUpdatePreview)
                and live.runtime_session.permission_update_scope(
                    live.permission_intent(RuntimePermissionMode(mode))
                )
                == PermissionUpdateScope.TURN
            ],
            "switch_warning": live.permission_switch_warning if live else "",
        }

    def model(self, session_id: str) -> dict[str, Any]:
        record = self._access.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        model_state = self._model_state(session_id)
        live = self._sessions.get(session_id)
        attached = live is not None and live.runtime_session is not None
        active_model = model_state.active_model_id if attached else ""
        active_effort = model_state.active_reasoning_effort if attached else ""
        active_thinking = model_state.active_thinking if attached else None
        return {
            "session_id": session_id,
            "model_id": model_state.selected_model_id,
            "default_model_id": (
                model_state.selected_model_id
                if self._settings.runtime_model() == model_state.selected_model_id
                else ""
            ),
            "active_model_id": active_model,
            "reasoning_effort": model_state.selected_reasoning_effort,
            "active_reasoning_effort": active_effort,
            "thinking": thinking_payload(model_state.selected_thinking),
            "active_thinking": thinking_payload(active_thinking),
            "deferred": (
                model_state.selected_model_id,
                model_state.selected_reasoning_effort,
                model_state.selected_thinking,
            )
            != (active_model, active_effort, active_thinking),
            "runtime": runtime_payload(
                model_id=model_state.selected_model_id,
                reasoning_effort=model_state.selected_reasoning_effort,
                active_reasoning_effort=active_effort,
                thinking=model_state.selected_thinking,
                active_thinking=active_thinking,
            ),
        }

    def prepare_model(
        self,
        model_id: str,
        *,
        actor_id: str,
        request_id: str,
        service_instance_id: str,
        persist_default: bool = False,
    ) -> dict[str, Any]:
        if service_instance_id != self._activities.instance_id:
            raise ValueError(PREPARATION_INSTANCE_CHANGED)

        def validate() -> None:
            if (
                not model_id
                or self._runtime.selected_model_key(model_id, user_id=actor_id) != model_id
            ):
                raise ValueError(RECONFIGURATION_STALE)

        def commit() -> None:
            self._settings.set_runtime_model(model_id)

        operation = self._runtime.reconfiguration.start(
            request_id=request_id,
            session_id=None,
            user_id=actor_id,
            model_id=model_id,
            wait_seconds=self._runtime.reconfiguration_wait_seconds,
            validate=validate,
            commit=commit if persist_default else None,
            warm=lambda owner: self._runtime.warm_host(
                user_id=actor_id,
                model_id=model_id,
                owner=owner,
            ),
            apply=lambda owner: self._runtime.reconfigure_host(
                user_id=actor_id,
                model_id=model_id,
                owner=owner,
            ),
        )
        return {**operation, "service_instance_id": self._activities.instance_id}

    def preparation_status(self, request_id: str, *, actor_id: str) -> dict[str, Any]:
        return {
            **self._runtime.reconfiguration.status(request_id, None, actor_id),
            "service_instance_id": self._activities.instance_id,
        }

    @asynccontextmanager
    async def model_admission(
        self,
        model_id: str,
        *,
        actor_id: str,
        domain: ActivityDomain,
        service_instance_id: str,
    ) -> AsyncIterator[None]:
        manager = self._runtime.reconfiguration
        while True:
            try:
                if manager.pending:
                    await manager.wait_pending()
                if self._activities.snapshot().phase is not ActivityPhase.OPEN:
                    raise ValueError(RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
                try:
                    operation = self.prepare_model(
                        model_id,
                        actor_id=actor_id,
                        request_id=str(uuid.uuid4()),
                        service_instance_id=service_instance_id,
                    )
                except ValueError as error:
                    if str(error) != RESOURCE_HOST_BUSY or not manager.pending:
                        raise
                    await manager.wait_pending()
                    continue
                operation = await manager.wait(operation["request_id"], None, actor_id)
                if operation["state"] != CommandState.APPLIED.value:
                    raise ValueError(operation["error"] or RESOURCE_HOST_CONTEXT_REQUIRED)
                lease = self._activities.enter(domain, root=True)
            except MaintenanceActive:
                if not manager.pending:
                    raise PreparationError(RESOURCE_HOST_CONFIGURATION_UNCERTAIN) from None
                continue
            except (ValueError, RuntimeError) as error:
                raise PreparationError(str(getattr(error, "safe_error", "") or error)) from error
            break
        with lease:
            yield

    @asynccontextmanager
    async def turn_admission(
        self,
        session_id: str,
        principal: SessionPrincipal,
        *,
        actor_id: str,
        model_id: str,
        service_instance_id: str | None,
    ) -> AsyncIterator[None]:
        self._access.require(session_id, principal)
        if self.is_readonly(session_id):
            raise PreparationError(SESSION_ARCHIVED_ERROR)
        if self.model(session_id)["model_id"] != model_id:
            raise PreparationError(RECONFIGURATION_STALE)
        async with self.model_admission(
            model_id,
            actor_id=actor_id,
            domain=ActivityDomain.TURN,
            service_instance_id=(
                self._activities.instance_id if service_instance_id is None else service_instance_id
            ),
        ):
            self._access.require(session_id, principal)
            if self.is_readonly(session_id):
                raise PreparationError(SESSION_ARCHIVED_ERROR)
            if self.model(session_id)["model_id"] != model_id:
                raise PreparationError(RECONFIGURATION_STALE)
            try:
                await self.align_metering_identity(session_id, actor_id)
            except (ValueError, RuntimeError) as error:
                raise PreparationError(str(getattr(error, "safe_error", "") or error)) from error
            yield

    def _reconfigure_host(
        self,
        session_id: str,
        principal: SessionPrincipal,
        *,
        actor_id: str,
        request_id: str,
        model_id: str,
    ) -> dict[str, Any]:
        self._access.require(session_id, principal)
        if not self._runtime.reconfiguration_supported:
            raise ValueError(RESOURCE_HOST_CONTEXT_REQUIRED)

        def validate() -> None:
            self._access.require(session_id, principal)
            if (
                not isinstance(model_id, str)
                or not model_id
                or self.model(session_id)["model_id"] != model_id
            ):
                raise ValueError(RECONFIGURATION_STALE)

        record = self._access.get(session_id)
        if record is None:
            raise SessionAccessError("session not found")
        return self._runtime.reconfiguration.start(
            request_id=request_id,
            session_id=session_id,
            user_id=actor_id,
            model_id=model_id,
            wait_seconds=self._runtime.reconfiguration_wait_seconds,
            validate=validate,
            apply=lambda owner: self._runtime.reconfigure_host(
                cwd=Path(record.runtime_workdir),
                user_id=actor_id,
                model_id=model_id,
                owner=owner,
            ),
        )

    def reconfiguration_status(
        self, session_id: str, request_id: str, *, actor_id: str
    ) -> dict[str, Any]:
        return self._runtime.reconfiguration.status(request_id, session_id, actor_id)

    def current_reconfiguration(self, session_id: str, *, actor_id: str) -> dict[str, Any] | None:
        return self._runtime.reconfiguration.current(session_id, actor_id)

    async def set_model(
        self,
        session_id: str,
        principal: SessionPrincipal,
        model_id: str,
        *,
        actor_id: str,
        reasoning_effort: str = "",
        thinking: ModelThinking | None = None,
        remember_default: bool = False,
    ) -> tuple[dict[str, Any], int]:
        with self._activities.enter(ActivityDomain.RUNTIME, root=True):
            return await self._activities.finish(
                ActivityDomain.RUNTIME,
                lambda: self._set_model(
                    session_id,
                    principal,
                    model_id,
                    actor_id=actor_id,
                    reasoning_effort=reasoning_effort,
                    thinking=thinking,
                    remember_default=remember_default,
                ),
            )

    async def _set_model(
        self,
        session_id: str,
        principal: SessionPrincipal,
        model_id: str,
        *,
        actor_id: str,
        reasoning_effort: str = "",
        thinking: ModelThinking | None = None,
        remember_default: bool = False,
    ) -> tuple[dict[str, Any], int]:
        """Persist model intent; only an attached idle runtime is reconfigured immediately."""
        self._access.require(session_id, principal)
        try:
            if reasoning_effort:
                await self._runtime.validate_effort(
                    model_id.strip(), reasoning_effort, user_id=actor_id
                )
            if thinking is not None:
                await self._runtime.validate_thinking(model_id.strip(), thinking, user_id=actor_id)
            target = self._runtime.selected_model_key(model_id.strip(), user_id=actor_id)
        except SessionModelUnavailableError as error:
            return {
                "ok": False,
                "error": SESSION_MODEL_UNAVAILABLE_ERROR,
                "detail": str(error),
            }, HTTP_BAD_REQUEST
        live = self._sessions.get(session_id)
        apply_now = False
        if live is None:
            self._access.set_model(
                session_id, principal, target, reasoning_effort=reasoning_effort, thinking=thinking
            )
        else:
            async with live.lifecycle_lock:
                self._access.set_model(
                    session_id,
                    principal,
                    target,
                    reasoning_effort=reasoning_effort,
                    thinking=thinking,
                )
                apply_now = live.runtime_session is not None and not live.running
                if live.runtime_session is None:
                    live.model_id = target
                    live.reasoning_effort = reasoning_effort
                    live.thinking = thinking
        if remember_default:
            self._settings.set_runtime_model(target)
        if apply_now and live is not None:
            try:
                await self.prepare_turn(live, purpose=ResourcePurpose.SESSION)
            except Exception as error:
                return (
                    {
                        **_runtime_failure_payload(error, operation="model_switch"),
                        **self.model(session_id),
                    },
                    HTTP_INTERNAL_ERROR,
                )
        return {"ok": True, **self.model(session_id)}, HTTP_OK

    def _preflight_workspace(self, record: SessionCatalogRecord) -> None:
        if self._events.latest_kind(record.session_id, WORKSPACE_BOUND_EVENT) is not None:
            return
        root = Path(record.runtime_workdir).resolve()
        for artifact in self._artifacts.list_session(record.session_id):
            if artifact.status is not ArtifactStatus.PUBLISHED and not Path(
                artifact.canonical_path
            ).resolve().is_relative_to(root):
                raise ValueError(WORKSPACE_ORIGIN_UNAVAILABLE)
        after = 0
        while events := self._events.replay(record.session_id, after_seq=after):
            after = events[-1].product_seq
            for event in events:
                if event.kind != PRODUCT_EVENT_USER_MESSAGE:
                    continue
                for ref in event.payload.get("refs", []):
                    if (
                        isinstance(ref, dict)
                        and ref.get("type") == PRODUCT_REFERENCE_FILE
                        and ref.get("origin") != PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE
                    ):
                        if (
                            not Path(str(ref.get("path") or ""))
                            .resolve()
                            .is_relative_to(root / SESSION_ATTACHMENT_DIRNAME)
                        ):
                            raise ValueError(WORKSPACE_ORIGIN_UNAVAILABLE)

    def _relocate_record(
        self,
        session_id: str,
        principal: SessionPrincipal,
        *,
        runtime_workdir: str,
        project_path: str,
        output_root: str,
    ) -> SessionCatalogRecord:
        # The catalog still identifies the old scope here, including when the
        # live vendor thread has already rebound. Drain its durable outbox first.
        self._runtime.recover_publications(session_id)
        with self._events.transaction() as connection:
            self._access.require(session_id, principal)
            record = self._access.get(session_id)
            if record is None:
                raise SessionAccessError("session not found")
            self._preflight_workspace(record)
            if self._project_relocation is not None:
                if not self._project_relocation(session_id, connection):
                    raise SessionStateConflictError(SESSION_RELOCATE_CONTEXT_PENDING)
            if (
                self._events.latest_kind(session_id, WORKSPACE_BOUND_EVENT, connection=connection)
                is None
            ):
                self._events.bind_workspace(record, initial=True, connection=connection)
            assigned = self._access.relocate(
                session_id,
                principal,
                runtime_workdir=runtime_workdir,
                project_path=project_path,
                output_root=output_root,
                connection=connection,
            )
            self._events.bind_workspace(assigned, connection=connection)
        return assigned

    def bind_writable_roots(self, provider: Callable[[Path], tuple[Path, ...]]) -> None:
        """绑定可写根提供者 (组合根调用一次)。"""

        self._writable_roots = provider

    def project_session_ids(self, project_root: Path) -> tuple[str, ...]:
        """返回同项目已加载会话，供撤销授权后的显式中断使用。"""

        target = project_root.expanduser().resolve()
        affected: list[str] = []
        for session_id, live in list(self._sessions.items()):
            scope = (live.project_path or live.runtime_workdir).expanduser().resolve()
            if scope != target and (live.project_path is not None or target not in scope.parents):
                continue
            affected.append(session_id)
        return tuple(affected)

    async def prepare_turn(
        self,
        live: LiveSession,
        *,
        request_id: str = "",
        deadline: float | None = None,
        on_wait: ResourceWaitObserver | None = None,
        purpose: ResourcePurpose = ResourcePurpose.TURN,
    ) -> None:
        try:
            await self._prepare_turn(
                live, request_id=request_id, deadline=deadline, on_wait=on_wait, purpose=purpose
            )
        except Exception as error:
            if getattr(error, "safe_error", "") == RESOURCE_HOST_CONFIGURATION_CONFLICT:
                self._schedule_reconfiguration(live)
            raise

    def _schedule_reconfiguration(self, live: LiveSession) -> None:
        try:
            if not self._runtime.reconfiguration_supported:
                return
            record = self._access.get(live.id)
            if record is None:
                return
            self._reconfigure_host(
                live.id,
                SessionPrincipal(record.principal_id),
                actor_id=live.user_id,
                request_id=str(uuid.uuid4()),
                model_id=self.model(live.id)["model_id"],
            )
        except Exception as error:
            self._logger.warning(
                "runtime_host_reconfiguration_not_scheduled session_id=%s failure_type=%s code=%s",
                live.id,
                type(error).__name__,
                getattr(error, "safe_error", "") or RESOURCE_HOST_CONTEXT_REQUIRED,
            )

    async def _prepare_turn(
        self,
        live: LiveSession,
        *,
        request_id: str = "",
        deadline: float | None = None,
        on_wait: ResourceWaitObserver | None = None,
        purpose: ResourcePurpose = ResourcePurpose.TURN,
    ) -> None:
        """Apply current intent and admit execution without holding locks during resource waits."""
        self._require_registered_project(live.project_path)
        try:
            desired = await self._credentials.admission_environment(live.user_id)
        except Exception as exc:
            self._logger.error(
                "runtime_credential_alignment_failed session_id=%s failure_type=%s cause_type=%s",
                live.id,
                type(exc).__name__,
                type(exc.__cause__).__name__ if exc.__cause__ else "none",
            )
            raise CredentialAdmissionError(CredentialAdmissionError.code) from exc
        roots = self._writable_roots(live.project_path or live.runtime_workdir)
        restart = False
        retained_product_turn = False
        skill_configurations = await self._runtime.skill_configurations(
            cwd=live.runtime_workdir,
            user_id=live.user_id,
            model_id=live.model_id,
            process_environment=desired,
        )
        async with live.lifecycle_lock:
            if live.running and live.runtime_session is not None:
                return
            retained_product_turn = bool(live.active_product_turn_id)
            record = self._access.get(live.id)
            if record is None:
                raise SessionAccessError("session not found")
            selected_mode = record.policy_id or ASK_PERMISSION_MODE
            roots = self._writable_roots(live.project_path or live.runtime_workdir)
            model_state = self._model_state(live.id)
            # 与 resume 同一条修复语义：登出后置灰的存量选择在每轮准入前对齐到目录
            # 当前可执行的键（未登录时为第一个可用模型），发生切换即落盘。
            selected_model = self._recover_selected_model(
                live.id,
                SessionPrincipal(record.principal_id),
                model_state,
                live.user_id,
            )
            environment_changed = dict(desired) != dict(live.process_environment)
            if live.runtime_session is not None:
                restart = (
                    environment_changed
                    or roots != live.writable_roots
                    or skill_configurations != live.skill_configurations
                    or bool(live.runtime_driver and live.runtime_driver.suspending)
                )
                if not restart and (
                    live.applied_permission_mode != selected_mode or live.writable_roots != roots
                ):
                    permission_state = await self._apply_permission_intent(
                        live, selected_mode, writable_roots=roots
                    )
                    restart = permission_state.state is CommandState.RESTART_REQUIRED
                    if permission_state.state in {CommandState.APPLIED, CommandState.ACCEPTED}:
                        live.writable_roots = roots
                    if permission_state.state is CommandState.APPLIED:
                        live.applied_permission_mode = selected_mode
                if not restart and (live.model_id, live.reasoning_effort, live.thinking) != (
                    selected_model,
                    model_state.selected_reasoning_effort,
                    model_state.selected_thinking,
                ):
                    model_result = await self._apply_model_intent(
                        live,
                        selected_model,
                        model_state.selected_reasoning_effort,
                        model_state.selected_thinking,
                    )
                    restart = model_result is CommandState.RESTART_REQUIRED
                    if model_result is CommandState.APPLIED:
                        self._access.apply_model(
                            live.id,
                            selected_model,
                            reasoning_effort=model_state.selected_reasoning_effort,
                            thinking=model_state.selected_thinking,
                            preserve_selection=True,
                        )
        if restart or retained_product_turn:
            if request_id:
                await self._runtime.wait_until_suspended(live, deadline=deadline)
            elif not await live.suspend_runtime():
                raise RuntimeError("runtime admission requires a quiescent session")
        async with live.lifecycle_lock:
            if live.runtime_session is None:
                live.retarget_environment(desired)
                live.writable_roots = roots
                state = self._model_state(live.id)
                live.model_id = state.selected_model_id
                live.reasoning_effort = state.selected_reasoning_effort
                live.thinking = state.selected_thinking
        await self._runtime.ensure_active(
            live, purpose=purpose, request_id=request_id, deadline=deadline, on_wait=on_wait
        )
        try:
            self._require_registered_project(live.project_path)
            if roots != live.writable_roots or roots != self._writable_roots(
                live.project_path or live.runtime_workdir
            ):
                raise RuntimeError(SESSION_WRITABLE_ROOTS_CHANGED_ERROR)
            async with live.lifecycle_lock:
                record = self._access.get(live.id)
                if record is None:
                    raise SessionAccessError("session not found")
                current_mode = record.policy_id or ASK_PERMISSION_MODE
                if current_mode != selected_mode:
                    applied = await self._apply_permission_intent(
                        live, current_mode, writable_roots=roots
                    )
                    if applied.state not in {CommandState.APPLIED, CommandState.ACCEPTED}:
                        raise RuntimeError(SESSION_PERMISSION_SWITCH_FAILED_ERROR)
                    if applied.state is CommandState.APPLIED:
                        live.applied_permission_mode = current_mode
            # Reconfiguration also awaits vendor work; it cannot extend directory admission.
            if roots != self._writable_roots(live.project_path or live.runtime_workdir):
                raise RuntimeError(SESSION_WRITABLE_ROOTS_CHANGED_ERROR)
        except Exception:
            # A wait may outlive authorization. Do not submit using the old roots.
            if live.runtime_session is not None:
                await live.suspend_runtime()
            raise
        if dict(desired) != self._credentials.cached_environment(live.user_id):
            # Admission was revoked while awaiting resources. Never submit against it.
            if live.runtime_session is not None:
                await live.suspend_runtime()
            raise CredentialAdmissionError(CredentialAdmissionError.code)

    async def _apply_permission_intent(
        self,
        live: LiveSession,
        mode: str,
        *,
        writable_roots: tuple[Path, ...] | None = None,
    ) -> AppliedState:
        session = live.runtime_session
        if session is None:
            return AppliedState(
                requested_revision=mode,
                applied_revision="",
                state=CommandState.RESTART_REQUIRED,
                scope="session",
            )
        intent = live.permission_intent(RuntimePermissionMode(mode), writable_roots=writable_roots)
        applied = await session.reconfigure(
            RuntimeConfigurationIntent(
                revision=intent.revision,
                permission=intent,
                required=True,
            )
        )
        if applied.state in {CommandState.REJECTED, CommandState.UNSUPPORTED}:
            raise RuntimeError(applied.safe_error or SESSION_PERMISSION_SWITCH_FAILED_ERROR)
        return applied

    async def _apply_model_intent(
        self,
        live: LiveSession,
        model_id: str,
        reasoning_effort: str = "",
        thinking: ModelThinking | None = None,
    ) -> CommandState:
        session = live.runtime_session
        if session is None:
            raise RuntimeError(SESSION_MODEL_SWITCH_FAILED_ERROR)
        model = self._runtime.resolve_model(
            model_id,
            reasoning_effort=reasoning_effort,
            thinking=thinking,
            user_id=live.user_id,
            session_id=live.id,
        )
        intent, _credential_port = model.runtime_model(reasoning_effort, thinking)
        applied = await session.reconfigure(
            RuntimeConfigurationIntent(
                revision=intent.revision,
                model=intent,
                required=True,
            )
        )
        if applied.state is CommandState.RESTART_REQUIRED:
            # Admission may wait; the caller releases the lifecycle lock first.
            return applied.state
        if applied.state is not CommandState.APPLIED:
            raise RuntimeError(applied.safe_error or SESSION_MODEL_SWITCH_FAILED_ERROR)
        live.model_id = model.key
        live.reasoning_effort = reasoning_effort
        live.thinking = thinking
        return applied.state

    def _mode_payload(self, selected: str, active: str) -> dict[str, Any]:
        """权限模式的统一投影: 用户选择 + 当前 thread 实际绑定 + 是否还没落地。"""

        return {
            "mode": selected,
            "active_mode": active,
            "deferred": bool(active) and active != selected,
            "modes": list(PRODUCT_PERMISSION_MODES),
            "backend": self._runtime.runtime_id,
        }

    async def set_mode(
        self,
        session_id: str,
        principal: SessionPrincipal,
        mode: str,
        *,
        application: str = PermissionApplication.AUTO.value,
    ) -> tuple[dict[str, Any], int]:
        with self._activities.enter(ActivityDomain.RUNTIME):
            return await self._activities.finish(
                ActivityDomain.RUNTIME,
                lambda: self._set_mode(session_id, principal, mode, application=application),
            )

    async def _set_mode(
        self,
        session_id: str,
        principal: SessionPrincipal,
        mode: str,
        *,
        application: str = PermissionApplication.AUTO.value,
    ) -> tuple[dict[str, Any], int]:
        """Persist permission intent without allocating resources for a detached session."""
        target = mode.strip()
        try:
            action = PermissionApplication(application)
        except ValueError:
            return {"ok": False, "error": SESSION_PERMISSION_APPLICATION_INVALID}, HTTP_BAD_REQUEST
        if target not in PRODUCT_PERMISSION_MODES:
            return {
                "ok": False,
                "error": "invalid_permission_mode",
                "modes": list(PRODUCT_PERMISSION_MODES),
            }, HTTP_BAD_REQUEST
        self._access.require(session_id, principal)
        live = self._sessions.get(session_id)
        active = ""
        warning = ""
        continuation: dict[str, Any] = {}
        if live is None:
            self._access.set_policy(
                session_id,
                principal,
                target,
                next_turn=action is PermissionApplication.NEXT_TURN,
            )
        else:
            async with live.lifecycle_lock:
                pending_hil = bool(self._access.pending_hil(session_id))
                if (
                    action is PermissionApplication.AUTO
                    and (live.running or pending_hil)
                    and target != live.applied_permission_mode
                    and target not in self.mode(session_id)["current_turn_modes"]
                ):
                    return {
                        "ok": False,
                        "error": SESSION_PERMISSION_CONFIRMATION_REQUIRED,
                        **self.mode(session_id),
                    }, HTTP_CONFLICT
                self._access.set_policy(
                    session_id,
                    principal,
                    target,
                    next_turn=action is PermissionApplication.NEXT_TURN,
                )
                live.permission_switch_warning = ""
                apply_now = (
                    action is not PermissionApplication.NEXT_TURN
                    and live.runtime_session is not None
                    and not live.running
                    and not pending_hil
                )
                if (
                    action is PermissionApplication.AUTO
                    and live.runtime_session is not None
                    and live.running
                    and target != live.applied_permission_mode
                ):
                    try:
                        applied = await self._apply_permission_intent(live, target)
                        warning = applied.safe_error or (
                            SESSION_PERMISSION_UPDATE_UNCONFIRMED
                            if applied.state is not CommandState.APPLIED
                            else ""
                        )
                        live.permission_switch_warning = warning
                        if applied.state is CommandState.APPLIED:
                            live.applied_permission_mode = target
                            live.applied_permission_turn_id = (
                                str(applied.values.get("turn_id") or "")
                                if isinstance(applied.values, dict)
                                else ""
                            )
                    except Exception as error:
                        return (
                            {
                                **_runtime_failure_payload(error, operation="permission_switch"),
                                **self.mode(session_id),
                            },
                            HTTP_INTERNAL_ERROR,
                        )
            if action is PermissionApplication.INTERRUPT_CONTINUE:
                async with live.activation_lock:
                    if live.running:
                        submission_id = live.last_submission_id
                        if not submission_id or live.catalog.queued_messages(live.id):
                            return {
                                "ok": False,
                                "error": SESSION_PERMISSION_CONTINUATION_STALE,
                                **self.mode(session_id),
                            }, HTTP_CONFLICT
                        try:
                            interrupted = False
                            async with asyncio.timeout(SESSION_PERMISSION_STOP_TIMEOUT_SECONDS):
                                while live.running and not live.ledger.active_turn_id:
                                    await asyncio.sleep(SESSION_PERMISSION_STOP_POLL_SECONDS)
                                if live.running:
                                    interrupted_turn_id = live.ledger.active_turn_id
                                    await live.interrupt()
                                    outcome = await live.ledger.wait_terminal(interrupted_turn_id)
                                    if outcome not in {
                                        PRODUCT_TURN_OUTCOME_INTERRUPTED,
                                        PRODUCT_TURN_OUTCOME_COMPLETED,
                                    }:
                                        return {
                                            "ok": False,
                                            "error": SESSION_PERMISSION_CONTINUATION_STALE,
                                            **self.mode(session_id),
                                        }, HTTP_CONFLICT
                                    interrupted = outcome == PRODUCT_TURN_OUTCOME_INTERRUPTED
                                while live.running:
                                    await asyncio.sleep(SESSION_PERMISSION_STOP_POLL_SECONDS)
                        except TimeoutError:
                            return {
                                "ok": False,
                                "error": SESSION_PERMISSION_STOP_PENDING,
                                **self.mode(session_id),
                            }, HTTP_CONFLICT
                        except Exception as error:
                            return {
                                **_runtime_failure_payload(error, operation="permission_switch"),
                                **self.mode(session_id),
                            }, HTTP_INTERNAL_ERROR
                        if (
                            live.last_submission_id != submission_id
                            or live.ledger.has_unknown_outcome
                            or self._access.pending_hil(session_id)
                            or self.mode(session_id)["mode"] != target
                        ):
                            return {
                                "ok": False,
                                "error": SESSION_PERMISSION_CONTINUATION_STALE,
                                **self.mode(session_id),
                            }, HTTP_CONFLICT
                        if interrupted:
                            continuation = {
                                "submission_id": submission_id,
                                "interrupt_generation": live.interrupt_generation,
                            }
                        apply_now = True
            if apply_now:
                try:
                    await self.prepare_turn(live, purpose=ResourcePurpose.SESSION)
                except Exception as error:
                    return (
                        {
                            **_runtime_failure_payload(error, operation="permission_switch"),
                            **self.mode(session_id),
                        },
                        HTTP_INTERNAL_ERROR,
                    )
            if live.runtime_session is not None:
                active = live.applied_permission_mode
        return {
            "ok": True,
            **self.mode(session_id),
            "switch_warning": warning,
            **({"continuation": continuation} if continuation else {}),
        }, HTTP_OK

    def unavailable(self, capability: str) -> dict[str, Any]:
        return {
            "ok": False,
            "available": False,
            "runtime_id": self._runtime.runtime_id,
            "capability": capability,
            "error": RUNTIME_CAPABILITY_UNAVAILABLE,
        }

    def inspect_context(self, _session_id: str, _principal: SessionPrincipal) -> dict[str, Any]:
        return self.unavailable("context_inspection")

    async def apply_context_operation(
        self,
        _session_id: str,
        _operation: Mapping[str, Any],
        _principal: SessionPrincipal,
    ) -> dict[str, Any]:
        return self.unavailable("context_operation")

    async def update_skills(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return self.unavailable("mutable_session_skills")


__all__ = ["SessionService", "workspace_allows"]
