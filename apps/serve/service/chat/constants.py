"""Stable vocabulary shared by the chat API, services, and persistence.

runtime 身份和能力由 Runtime Gateway 的 provider descriptor/binding 提供。本文件只保留与
具体 Harness 无关的产品词汇（事件名、会话状态、错误码等）。
"""

from __future__ import annotations

from enum import Enum
from typing import Any


class SessionTitleFallback(str, Enum):
    """Explicit provenance for an application-generated session title."""

    NEW_SESSION = "new_session"


HARNESS_ENV = "SCHOLARSEED_HARNESS"
NATIVE_HARNESS_WORK = "assistant"

PRODUCT_SESSION_STATE_STARTING = "starting"
PRODUCT_SESSION_STATE_IDLE = "idle"
PRODUCT_SESSION_STATE_RUNNING = "running"
PRODUCT_SESSION_STATE_WAITING = "waiting"
PRODUCT_SESSION_STATE_INTERRUPTED = "interrupted"
PRODUCT_SESSION_STATE_FAILED = "failed"
PRODUCT_SESSION_STATE_CLOSED = "closed"

PRODUCT_EVENT_SESSION_STATE = "session_state"
PRODUCT_EVENT_SESSION_TITLE_UPDATED = "session_title_updated"
PRODUCT_EVENT_USER_MESSAGE = "user_message"
PRODUCT_EVENT_MESSAGE_QUEUED = "message_queued"
QUEUED_ASSISTANT_REFERENCES = "assistant_references"
PRODUCT_EVENT_MESSAGE_UPDATED = "message_updated"
PRODUCT_EVENT_MESSAGE_REMOVED = "message_removed"
PRODUCT_EVENT_SEND_NOW_SUBMITTED = "send_now_submitted"
PRODUCT_EVENT_SEND_NOW_ACCEPTED = "send_now_accepted"
PRODUCT_EVENT_SEND_NOW_REJECTED = "send_now_rejected"
PRODUCT_EVENT_SEND_NOW_OUTCOME_UNKNOWN = "send_now_outcome_unknown"
PRODUCT_EVENT_TURN_COMPLETED = "turn_completed"
PRODUCT_EVENT_TURN_FAILED = "turn_failed"
PRODUCT_EVENT_TURN_INTERRUPTED = "turn_interrupted"
PRODUCT_EVENT_MESSAGE_DELTA = "message_delta"
PRODUCT_EVENT_ANSWER_SOURCES = "answer_sources"
PRODUCT_EVENT_REASONING_DELTA = "reasoning_delta"
PRODUCT_EVENT_TOOL_STARTED = "tool_started"
PRODUCT_EVENT_TOOL_OUTPUT_DELTA = "tool_output_delta"
PRODUCT_EVENT_TOOL_COMPLETED = "tool_completed"
PRODUCT_EVENT_HISTORY_RETRIEVED = "history_retrieved"
PRODUCT_EVENT_WEB_SEARCH_STARTED = "web_search_started"
PRODUCT_EVENT_WEB_SEARCH_COMPLETED = "web_search_completed"
PRODUCT_EVENT_PAPER_SEARCH_STARTED = "paper_search_started"
PRODUCT_EVENT_PAPER_SEARCH_COMPLETED = "paper_search_completed"
PRODUCT_EVENT_SKILL_STARTED = "skill_started"
PRODUCT_EVENT_SKILL_COMPLETED = "skill_completed"
PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED = "native_activity_started"
PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED = "native_activity_completed"
PRODUCT_EVENT_SUBAGENT_SPAWNED = "subagent_spawned"
PRODUCT_EVENT_SUBAGENT_STARTED = "subagent_started"
PRODUCT_EVENT_SUBAGENT_STATUS_CHANGED = "subagent_status_changed"
PRODUCT_EVENT_SUBAGENT_COMPLETED = "subagent_completed"
PRODUCT_EVENT_SUBAGENT_FAILED = "subagent_failed"
PRODUCT_EVENT_SUBAGENT_INTERRUPTED = "subagent_interrupted"
PRODUCT_EVENT_PLAN_SNAPSHOT = "plan_snapshot"
PRODUCT_EVENT_FILE_CHANGED = "file_changed"
PRODUCT_EVENT_DISPLAY_CARD = "display_card"
PRODUCT_EVENT_ARTIFACT_CHANGED = "artifact_changed"
PRODUCT_EVENT_ARTIFACT_PUBLISHED = "artifact_published"
PRODUCT_EVENT_ARTIFACT_LIBRARY_LINKED = "artifact_library_linked"
PRODUCT_EVENT_ARTIFACT_DECLARED = "artifact_declared"
PRODUCT_EVENT_ARTIFACT_FAILED = "artifact_failed"
PRODUCT_EVENT_REVIEW_READY = "review_ready"
PRODUCT_EVENT_HIL_REQUESTED = "hil_requested"
PRODUCT_EVENT_HIL_RESOLVED = "hil_resolved"
PRODUCT_EVENT_USAGE_UPDATED = "usage_updated"
PRODUCT_EVENT_CONTEXT_COMPACTED = "context_compacted"
PRODUCT_EVENT_MODEL_CAPABILITY_RESOLUTION = "model_capability_resolution"
PRODUCT_EVENT_RUNTIME_INCIDENT = "runtime_incident"
PRODUCT_EVENT_RUNTIME_ERROR = "runtime_error"
PRODUCT_EVENT_TURN_UNKNOWN = "turn_unknown"
PRODUCT_EVENT_OPERATION_STATE = "operation_state"
PRODUCT_EVENT_TURN_RECONCILED = "turn_reconciled"
PRODUCT_EVENT_VERSION_V1 = 1
PRODUCT_EVENT_VERSION = 2
PRODUCT_EVENT_ARTIFACT_UPSERT = "upsert"
PRODUCT_EVENT_ARTIFACT_REMOVE = "remove"
PRODUCT_EVENT_ARTIFACT_SNAPSHOT = "snapshot"

RUNTIME_CAPABILITY_UNAVAILABLE = "runtime_capability_unavailable"
RUNTIME_INCIDENT_IDEMPOTENCY_PREFIX = "incident"
RUNTIME_INCIDENT_INVALID = "runtime_incident_invalid"
RUNTIME_LEGACY_ERROR = "codex_runtime_error"
# 供应商拒绝但 Codex 已把真实 error.code 拍平时的产品级通用兜底码（adapter 的
# ``CODEX_PROVIDER_FAILED`` 投影到产品面/ incident 的值）。归因恢复只在 incident 仍是
# 这个「无具体归因」通用码（或空）时回填真实上游码，绝不覆盖已带具体码的 incident。
GENERIC_PROVIDER_FAILURE_CODE = "codex_provider_failed"
PRODUCT_EVENT_ID_PREFIX = "product"
PRODUCT_REFERENCE_FILE = "file"
PRODUCT_REFERENCE_DIRECTORY = "directory"
PRODUCT_REFERENCE_SKILL = "skill"
PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE = "local_file"
PRODUCT_REFERENCE_ORIGIN_LOCAL_DIRECTORY = "local_directory"
USER_MESSAGE_BINDING_ADMITTED = "admitted"
USER_MESSAGE_BINDING_BOUND = "bound"
USER_MESSAGE_ORIGIN_TURN = "turn"
USER_MESSAGE_ORIGIN_STEER = "steer"
USER_MESSAGE_ORIGINS = frozenset((USER_MESSAGE_ORIGIN_TURN, USER_MESSAGE_ORIGIN_STEER))

PRODUCT_TURN_OUTCOME_COMPLETED = "completed"
PRODUCT_TURN_OUTCOME_FAILED = "failed"
PRODUCT_TURN_OUTCOME_INTERRUPTED = "interrupted"
PRODUCT_TURN_OUTCOME_UNKNOWN = "unknown_outcome"
PRODUCT_TURN_OUTCOME_CONFIRMED = "unknown_confirmed"
TURN_OUTCOME_UNCONFIRMED = "turn_outcome_unconfirmed"
TURN_UNKNOWN_CONFIRM_DECISION = "continue_without_replay"
TURN_UNKNOWN_CONFIRM_INVALID = "turn_unknown_confirmation_invalid"
TURN_UNKNOWN_NOT_FOUND = "turn_unknown_not_found"

SESSION_SOURCE = "serve"
SERVE_DEFAULT_PERMISSION_MODE = "default"
SERVE_SESSION_OVERRIDES: dict[str, Any] = {
    "hil_enabled": False,
    "default_mode": SERVE_DEFAULT_PERMISSION_MODE,
    "scheduler": False,
}

HIL_STATE_PENDING = "pending"
HIL_STATE_RESOLVED = "resolved"
HIL_STATE_CANCELLED = "cancelled"
HIL_STATE_STALE = "stale"
HIL_CANCELLED_ANSWER = "已取消任务"
HIL_RESPONSE_RECEIVED_EVENT = "hil.response_received"
HIL_RESPONSE_RESOLVED_EVENT = "hil.response_resolved"
HIL_RESPONSE_UNKNOWN_EVENT = "hil.response_unknown"
HIL_SSE_PUBLISHED_EVENT = "hil.sse_published"
ASK_REQUEST_ID_LEN = 12

SSE_CONNECTED_EVENT = "sse.connected"
SSE_DISCONNECTED_EVENT = "sse.disconnected"
SSE_PUBLISHED_EVENT = "sse.published"
SSE_REPLAY_STARTED_EVENT = "sse.replay_started"
SSE_REPLAY_FINISHED_EVENT = "sse.replay_finished"
SSE_BACKPRESSURE_EVENT = "sse.backpressure"
EVENT_BACKLOG_MAX = 8192
SSE_HEARTBEAT_SECONDS = 15.0

TURN_CANCELLED_ERROR = "cancelled"
TURN_CANCELLED_EVENT = "serve.turn_cancelled"
TURN_INTERRUPT_STARTED_EVENT = "serve.turn_interrupt_started"
TURN_INTERRUPT_FINISHED_EVENT = "serve.turn_interrupt_finished"
TURN_INTERRUPT_FAILED_EVENT = "serve.turn_interrupt_failed"
TURN_INTERRUPT_STARTED_FRAME = "interrupt_started"
TURN_INTERRUPT_FINISHED_FRAME = "interrupt_finished"
TURN_INTERRUPT_QUEUE_DELIVERY = "after_interrupt"
TURN_FAILED_CODE = "turn_failed"
TURN_ERROR_PHASE = "turn.run"
TURN_STARTED_EVENT = "serve.turn_started"
TURN_FINISHED_EVENT = "serve.turn_finished"
TURN_FAILED_EVENT = "serve.turn_failed"
FRONTEND_ERROR_EXPOSED_EVENT = "serve.frontend_error_exposed"

SESSION_OPENED_EVENT = "serve.session_opened"
SESSION_RESUMED_EVENT = "serve.session_resumed"
SESSION_RECOVERY_INTERRUPT_REASON = "app_restart"
SESSION_MODEL_RESTORE_FAILED_EVENT = "serve.session_model_restore_failed"
SESSION_OPEN_FAILED_EVENT = "serve.session_open_failed"
SESSION_DELETE_REASON = "session_delete"
SESSION_DELETE_RUNNING_ERROR = "session_running"
SESSION_DELETE_MISSING_ERROR = "session_not_found"
SESSION_RENAME_EMPTY_ERROR = "session_title_required"
SESSION_RENAME_MAX_LENGTH = 150
SESSION_TITLE_DEFAULT = "新对话"
SESSION_TITLE_ELLIPSIS = "…"
SESSION_NOT_FOUND_ERROR = "session not found"
SESSION_LIST_CREATED_AT_KEY = "created_at"
SESSION_LIST_ID_KEY = "session_id"
SESSION_LIST_WAITING_KEY = "waiting"
SESSION_LIST_PROJECT_REQUIRED_ERROR = "project_path_required_for_project_scope"
SESSION_LIST_PROJECT_UNEXPECTED_ERROR = "project_path_only_allowed_for_project_scope"
SESSION_PROJECT_PATH_KEY = "project_path"
SESSION_PROJECT_NOT_AUTHORIZED_ERROR = "project_path_not_authorized"
SESSION_PROJECT_NOT_REGISTERED_ERROR = "project_path_not_registered"
SESSION_PROJECT_MISMATCH_ERROR = "project_path must be a registered project matching workdir"
SESSION_RELOCATE_FAILED_ERROR = "session_relocate_failed"
SESSION_RELOCATE_REQUIRES_TURN_ERROR = "session_relocate_requires_turn"
SESSION_RELOCATE_STOP_FAILED_ERROR = "session_relocate_stop_failed"
SESSION_RELOCATE_STOP_PENDING_ERROR = "session_relocate_stop_pending"
SESSION_RELOCATE_STOP_TIMEOUT_SECONDS = 30.0
SESSION_RELOCATE_STOP_POLL_SECONDS = 0.05
SESSION_UNASSIGNED_WORKSPACE_ERROR = "an unassigned session must use the default workspace"
SESSION_RUNTIME_WORKDIR_KEY = "runtime_workdir"
SESSION_TODOS_KEY = "todos"
SESSION_RELOCATION_REASON = "session_relocation"
SESSION_PERMISSION_SWITCH_REQUIRES_HIL_RESOLUTION_ERROR = (
    "session_permission_switch_requires_hil_resolution"
)
SESSION_RUNNING_ERROR = "session_running"
SESSION_TERMINATED = "session_terminated"
DELETE_LIVE_CLOSE_TIMEOUT_SECONDS = 30.0
CRON_SESSION_KIND = "cron"
USER_INTERRUPT_REASON = "user_interrupt"

CONTEXT_EVENT_OP_REPLACE = "replace"
CONTEXT_EVENT_OP_SNAPSHOT = "snapshot"
CONTEXT_EVENT_OP_REMOVE = "remove"
CONTEXT_DELTA_ADDED = "added"
CONTEXT_DELTA_SUPERSEDED = "superseded"
CONTEXT_DELTA_EVICTED = "evicted"

INVALID_GLOBAL_PERMISSION_MODE_ERROR = "invalid_global_permission_mode"
INVALID_WORKFLOW_ENABLED_ERROR = "invalid_workflow_enabled"
INVALID_AUTO_REVIEW_ENABLED_ERROR = "invalid_auto_review_enabled"
ASK_PERMISSION_MODE = "ask"
SAFE_AUTO_PERMISSION_MODE = "safe_auto"
BYPASS_PERMISSION_MODE = "bypassPermissions"
GLOBAL_PERMISSION_MODES: tuple[str, ...] = (
    ASK_PERMISSION_MODE,
    SAFE_AUTO_PERMISSION_MODE,
    BYPASS_PERMISSION_MODE,
)
# 首次使用默认交由安全审批器处理；用户主动选择后持久化覆盖该缺省值。
DEFAULT_GLOBAL_PERMISSION_MODE = SAFE_AUTO_PERMISSION_MODE
GLOBAL_PERMISSION_MODE_KEY = "default_permission_mode"
SESSION_PERMISSION_MODE_KEY = "initial_permission_mode"
SESSION_WORKFLOW_ENABLED_KEY = "workflow_enabled"
SESSION_AUTO_REVIEW_ENABLED_KEY = "auto_review_enabled"
SESSION_MODEL_KEY = "model_key"
SESSION_PERSONAL_PROFILE_KEY = "personal_profile_id"
GLOBAL_WORKFLOW_DEFAULT_KEY = "default_workflow_enabled"
GLOBAL_AUTO_REVIEW_DEFAULT_KEY = "default_auto_review_enabled"
MAX_VERSIONS_PER_FILE_KEY = "max_versions_per_file"
MAX_VERSION_FILE_SIZE_KB_KEY = "max_version_file_size_kb"
VERSION_MODE_KEY = "file_version_mode"
VERSION_POLICY_MIGRATION_KEY = "file_version_policy_migration_required"
VERSION_POLICY_BACKUP_KEY = "file_version_policy_legacy"
VERSION_INCLUDE_PATTERNS_KEY = "file_version_include"
VERSION_IGNORE_PATTERNS_KEY = "file_version_ignore"
DEFAULT_VERSION_IGNORE_PATTERNS: tuple[str, ...] = (
    # Runtime logs and process state.
    "*.log",
    "*.log.*",
    "log/",
    "logs/",
    "*.pid",
    "*.pid.lock",
    "*.seed",
    # Crash and diagnostic dumps.
    "core",
    "core.*",
    "*.core",
    "*.dmp",
    "*.dump",
    "*.stackdump",
    "hs_err_pid*",
    # Editor, operating-system, cache, and test residue.
    "*.tmp",
    "*.temp",
    "*.swp",
    "*.swo",
    "*~",
    ".DS_Store",
    "Thumbs.db",
    ".cache/",
    ".pytest_cache/",
    ".mypy_cache/",
    ".ruff_cache/",
    "__pycache__/",
    ".tox/",
    ".nox/",
    ".coverage",
    ".coverage.*",
    "coverage/",
    "htmlcov/",
    # Restorable dependencies and generated build output.
    "node_modules/",
    ".venv/",
    "venv/",
    "env/",
    "dist/",
    "build/",
    "out/",
    "target/",
    ".next/",
    ".nuxt/",
    ".svelte-kit/",
    ".parcel-cache/",
    ".turbo/",
)
LEGACY_RUNTIME_EXECUTABLE_KEY = "codex_executable"
RUNTIME_MODEL_KEY = "codex_model"
# proposal 47 §6.4: 项目工作区根。设置文件的 owner 留在本域 (它已经拥有这个文件),
# 取值由组合根读取后注入 content —— 让 content 反向依赖 chat 才是层级破坏。
WORKSPACE_ROOT_KEY = "workspace_root"
DEFAULT_WORKFLOW_ENABLED = True
DEFAULT_AUTO_REVIEW_ENABLED = False
AUTO_REVIEW_CAPABILITY_UNAVAILABLE_ERROR = "auto_review_capability_unavailable"
SETTINGS_TMP_SUFFIX = ".tmp"
WORKFLOW_CAPABILITY_UNAVAILABLE_ERROR = "workflow_capability_unavailable"
WORKSPACE_ROOT_NOT_FOUND_ERROR = "workspace_root_not_found"
WORKFLOW_RUNTIME_PROVISIONED = True
UNKNOWN_COMMAND_ERROR = "unknown_command"
UNSUPPORTED_COMMAND_ERROR = "unsupported_command"
UNSUPPORTED_PLATFORM_COMMANDS = frozenset({"clear", "exit"})

WORKSPACE_BUSY_ERROR = "workspace_busy"
WORKSPACE_ATTACHMENT_KIND = "workspace_file"
PAPER_READING_COMMAND = "paper.reading"
PAPER_ANCHOR_COMMAND = "paper.anchor"
PAPER_ANCHOR_GET_COMMAND = "paper.anchor_get"
PAPER_ANCHOR_TARGET_KIND = "paper_anchor"
