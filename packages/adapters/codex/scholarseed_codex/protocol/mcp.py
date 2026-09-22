"""Codex MCP control records used inside this adapter."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Awaitable, Callable, Mapping, Protocol, Sequence, TypeAlias

from scholarseed_runtime.contract.mcp import McpTrustDecision

JsonValue: TypeAlias = (
    str | int | float | bool | None | Mapping[str, "JsonValue"] | Sequence["JsonValue"]
)


class McpOwner(str, Enum):
    NATIVE = "native"
    CODEX = "codex"
    CLAUDE = "claude"
    UNKNOWN = "unknown"


class McpScope(str, Enum):
    USER = "user"
    PROJECT = "project"
    SESSION = "session"
    MANAGED = "managed"
    UNKNOWN = "unknown"


class McpTransport(str, Enum):
    STDIO = "stdio"
    STREAMABLE_HTTP = "streamable_http"
    SSE = "sse"
    UNKNOWN = "unknown"


class McpTrustState(str, Enum):
    UNKNOWN = "unknown"
    TRUSTED = "trusted"
    REQUIRED = "required"
    SESSION = "session"
    WORKSPACE = "workspace"
    DENIED = "denied"


class McpStartupState(str, Enum):
    NOT_STARTED = "not_started"
    STARTING = "starting"
    READY = "ready"
    FAILED = "failed"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"


class McpAuthStatus(str, Enum):
    UNKNOWN = "unknown"
    UNSUPPORTED = "unsupported"
    NOT_LOGGED_IN = "not_logged_in"
    BEARER_TOKEN = "bearer_token"
    OAUTH = "oauth"


class McpFailureReason(str, Enum):
    NONE = "none"
    REAUTHENTICATION_REQUIRED = "reauthentication_required"
    STARTUP = "startup"
    PROTOCOL = "protocol"
    TRANSPORT = "transport"
    POLICY = "policy"
    TRUST = "trust"
    CATALOG_CHANGED = "catalog_changed"
    UNKNOWN = "unknown"


class McpLoadedState(str, Enum):
    DEFERRED = "deferred"
    LOADED = "loaded"
    STALE = "stale"
    REVOKED = "revoked"


class McpEventKind(str, Enum):
    SNAPSHOT = "snapshot"
    SERVER_STATUS_CHANGED = "server_status_changed"
    AUTH_REQUIRED = "auth_required"
    AUTH_COMPLETED = "auth_completed"
    INVENTORY_CHANGED = "inventory_changed"
    TOOL_PROGRESS = "tool_progress"
    RESOURCE_UPDATED = "resource_updated"
    TRUST_REQUIRED = "trust_required"
    FAILURE = "failure"


@dataclass(frozen=True)
class McpControlCapabilities:
    server_list: bool = True
    tool_list: bool = True
    resource_list: bool = False
    resource_read: bool = False
    prompt_list: bool = False
    prompt_get: bool = False
    oauth_login: bool = False
    reload: bool = False
    config_write: bool = False
    trust: bool = False
    direct_tool_call: bool = False
    logout: bool = False
    cli_fallback: bool = False


@dataclass(frozen=True)
class McpServerInfo:
    name: str = ""
    version: str = ""
    title: str = ""
    description: str = ""
    website_url: str = ""


@dataclass(frozen=True)
class McpToolView:
    runtime_id: str
    server: str
    name: str
    callable_name: str
    namespace: str = ""
    title: str = ""
    description: str = ""
    input_schema: Mapping[str, JsonValue] = field(default_factory=dict)
    output_schema: Mapping[str, JsonValue] = field(default_factory=dict)
    annotations: Mapping[str, JsonValue] = field(default_factory=dict)
    meta: Mapping[str, JsonValue] = field(default_factory=dict)
    schema_fingerprint: str = ""
    safety_fingerprint: str = ""
    inventory_revision: str = ""
    loaded_state: McpLoadedState = McpLoadedState.DEFERRED


@dataclass(frozen=True)
class McpResourceView:
    server: str
    uri: str
    name: str = ""
    title: str = ""
    description: str = ""
    mime_type: str = ""
    size: int | None = None
    template: bool = False


@dataclass(frozen=True)
class McpPromptView:
    server: str
    name: str
    title: str = ""
    description: str = ""
    arguments: tuple[Mapping[str, JsonValue], ...] = ()


@dataclass(frozen=True)
class McpServerView:
    runtime_id: str
    owner: McpOwner
    name: str
    scope: McpScope = McpScope.UNKNOWN
    origin: str = ""
    transport: McpTransport = McpTransport.UNKNOWN
    enabled: bool = True
    required: bool = False
    trust_state: McpTrustState = McpTrustState.UNKNOWN
    startup_state: McpStartupState = McpStartupState.UNKNOWN
    auth_status: McpAuthStatus = McpAuthStatus.UNKNOWN
    failure_reason: McpFailureReason = McpFailureReason.NONE
    safe_error: str = ""
    server_info: McpServerInfo = field(default_factory=McpServerInfo)
    namespace_description: str = ""
    tools_count: int = 0
    resources_count: int = 0
    prompts_count: int = 0
    inventory_revision: str = ""
    config_fingerprint: str = ""
    editable: bool = False


@dataclass(frozen=True)
class McpSnapshot:
    runtime_id: str
    session_id: str
    revision: str
    servers: tuple[McpServerView, ...] = ()
    seq: int = 0


@dataclass(frozen=True)
class McpListRequest:
    server: str = ""
    cursor: str = ""
    limit: int = 100
    include_schema: bool = False


@dataclass(frozen=True)
class McpToolPage:
    data: tuple[McpToolView, ...] = ()
    next_cursor: str = ""


@dataclass(frozen=True)
class McpResourcePage:
    data: tuple[McpResourceView, ...] = ()
    next_cursor: str = ""


@dataclass(frozen=True)
class McpPromptPage:
    data: tuple[McpPromptView, ...] = ()
    next_cursor: str = ""


@dataclass(frozen=True)
class McpReadRequest:
    server: str
    uri: str


@dataclass(frozen=True)
class McpResourceContents:
    server: str
    uri: str
    contents: tuple[Mapping[str, JsonValue], ...] = ()


@dataclass(frozen=True)
class McpPromptRequest:
    server: str
    name: str
    arguments: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class McpPromptContents:
    server: str
    name: str
    description: str = ""
    messages: tuple[Mapping[str, JsonValue], ...] = ()


@dataclass(frozen=True)
class McpLoginRequest:
    server: str
    scopes: tuple[str, ...] = ()
    timeout_seconds: float = 300.0


@dataclass(frozen=True)
class McpLoginChallenge:
    server: str
    authorization_url: str
    expires_at: str = ""


@dataclass(frozen=True)
class McpReloadRequest:
    server: str = ""


@dataclass(frozen=True)
class McpToolCallRequest:
    server: str
    tool: str
    arguments: Mapping[str, JsonValue] = field(default_factory=dict)
    meta: Mapping[str, JsonValue] = field(default_factory=dict)


@dataclass(frozen=True)
class McpToolCallResult:
    server: str
    tool: str
    ok: bool
    content: tuple[Mapping[str, JsonValue], ...] = ()
    structured_content: JsonValue = None
    meta: Mapping[str, JsonValue] = field(default_factory=dict)


@dataclass(frozen=True)
class McpLogoutRequest:
    server: str


@dataclass(frozen=True)
class McpTrustRequest:
    server: str
    decision: McpTrustDecision


@dataclass(frozen=True)
class McpEvent:
    kind: McpEventKind
    session_id: str
    runtime_id: str
    server: str = ""
    seq: int = 0
    inventory_revision: str = ""
    payload: Mapping[str, JsonValue] = field(default_factory=dict)


McpEventObserver = Callable[[McpEvent], Awaitable[None]]


class McpControlPort(Protocol):
    capabilities: McpControlCapabilities

    async def snapshot(self) -> McpSnapshot: ...

    async def list_tools(self, request: McpListRequest) -> McpToolPage: ...

    async def list_resources(self, request: McpListRequest) -> McpResourcePage: ...

    async def read_resource(self, request: McpReadRequest) -> McpResourceContents: ...

    async def list_prompts(self, request: McpListRequest) -> McpPromptPage: ...

    async def get_prompt(self, request: McpPromptRequest) -> McpPromptContents: ...

    async def begin_login(self, request: McpLoginRequest) -> McpLoginChallenge: ...

    async def call_tool(self, request: McpToolCallRequest) -> McpToolCallResult: ...

    async def logout(self, request: McpLogoutRequest) -> McpSnapshot: ...

    async def reload(self, request: McpReloadRequest) -> McpSnapshot: ...

    async def decide_trust(self, request: McpTrustRequest) -> McpSnapshot: ...

    def subscribe(self, observer: McpEventObserver) -> Callable[[], None]: ...
