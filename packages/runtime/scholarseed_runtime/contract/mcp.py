"""Runtime-neutral MCP configuration, application state and trust contracts."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol, runtime_checkable

from scholarseed_runtime.contract.secret import RuntimeSecretPort

MCP_INITIAL_CONFIGURATION_REVISION = 0
MCP_CONFIGURATION_UNSUPPORTED = "mcp_configuration_unsupported"


class McpTrustDecision(str, Enum):
    ALLOW_SESSION = "allow_session"
    TRUST_WORKSPACE = "trust_workspace"
    DENY = "deny"


class McpApplicationState(str, Enum):
    PENDING = "pending"
    READY = "ready"
    FAILED = "failed"


class McpServerState(str, Enum):
    CONNECTING = "connecting"
    AUTH_REQUIRED = "auth_required"
    READY = "ready"
    FAILED = "failed"


@dataclass(frozen=True)
class McpServerObservation:
    server_id: str
    state: McpServerState
    tool_count: int | None = None
    safe_error: str = ""


class McpCredentialTarget(str, Enum):
    ENVIRONMENT = "environment"
    HEADER = "header"


@dataclass(frozen=True)
class McpCredentialBinding:
    target: McpCredentialTarget
    name: str
    secret_ref: str = field(repr=False)


@dataclass(frozen=True)
class McpStdioTransport:
    command: str
    args: tuple[str, ...] = ()
    cwd: str | None = None
    environment: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class McpHttpTransport:
    url: str
    headers: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class McpServerConfiguration:
    name: str
    transport: McpStdioTransport | McpHttpTransport
    enabled: bool = True
    credentials: tuple[McpCredentialBinding, ...] = ()
    tool_timeout_ms: int | None = None
    startup_timeout_ms: int | None = None


@dataclass(frozen=True)
class McpConfigurationRequest:
    """A complete desired set; secret material stays out of persisted configuration."""

    revision: int
    servers: tuple[McpServerConfiguration, ...]
    secret_port: RuntimeSecretPort | None = field(default=None, repr=False, compare=False)
    shared_credentials: tuple[McpCredentialBinding, ...] = ()


@dataclass(frozen=True)
class McpHostApplication:
    host_id: str
    generation: int
    desired_revision: int
    applied_revision: int
    state: McpApplicationState
    inventory_revision: str = ""
    safe_error: str = ""
    servers: tuple[McpServerObservation, ...] = ()


@dataclass(frozen=True)
class McpConfigurationReceipt:
    """Observed application state, not merely a persisted configuration acknowledgement.

    READY proves the host applied the configuration and verified its inventory;
    it does not prove every tool was called successfully. A host with safe_error
    is not ready, even if its state is contradictory.
    """

    desired_revision: int
    hosts: tuple[McpHostApplication, ...] = ()
    safe_error: str = ""


@runtime_checkable
class RuntimeMcpConfiguration(Protocol):
    """Optional provider capability; unsupported providers must not fake application.

    Configuration admission returns without waiting for the invoking turn to end.
    New work is fenced until the owning physical host has applied its target.
    Desired revisions never decrease. Repeated identical revisions are idempotent;
    an equal revision with different content must be rejected. Late requests or
    host notifications cannot overwrite a newer desired or applied state.
    """

    async def configure_mcp(self, request: McpConfigurationRequest) -> McpConfigurationReceipt: ...

    async def mcp_configuration(self) -> McpConfigurationReceipt: ...
