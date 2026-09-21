"""Runtime-neutral commands sent from a product to an adapter."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

from scholarseed_runtime.contract.artifact import ArtifactDirectiveSpec
from scholarseed_runtime.contract.binding import RuntimeBinding
from scholarseed_runtime.contract.capability import RuntimeCapabilityName
from scholarseed_runtime.contract.event import RuntimeValue
from scholarseed_runtime.contract.evidence import NOOP_RUNTIME_TIMING, RuntimeTimingPort
from scholarseed_runtime.contract.history import HistoryEntry
from scholarseed_runtime.contract.model import ModelCredentialPort, ModelIntent
from scholarseed_runtime.contract.permission import PermissionIntent
from scholarseed_runtime.contract.secret import LaunchSecretIntent, RuntimeSecretPort


class CommandState(str, Enum):
    ACCEPTED = "accepted"
    APPLIED = "applied"
    REJECTED = "rejected"
    UNSUPPORTED = "unsupported"
    RESTART_REQUIRED = "restart_required"


class InventoryKind(str, Enum):
    MODELS = "models"
    SKILLS = "skills"
    MCP = "mcp"


class RuntimeControlKind(str, Enum):
    MCP_SNAPSHOT = "mcp.snapshot"
    MCP_LIST_TOOLS = "mcp.list_tools"
    MCP_LIST_RESOURCES = "mcp.list_resources"
    MCP_READ_RESOURCE = "mcp.read_resource"
    MCP_RELOAD = "mcp.reload"
    MCP_CALL_TOOL = "mcp.call_tool"
    MCP_LOGIN = "mcp.login"
    MCP_LIST_PROMPTS = "mcp.list_prompts"
    MCP_LOGOUT = "mcp.logout"
    MCP_TRUST = "mcp.trust"


@dataclass(frozen=True)
class CommandReceipt:
    command_id: str
    state: CommandState
    correlation_id: str = ""
    safe_error: str = ""


@dataclass(frozen=True)
class OpenSessionRequest:
    product_session_id: str
    cwd: Path
    model: ModelIntent = ModelIntent()
    credential_port: ModelCredentialPort | None = None
    launch_secrets: LaunchSecretIntent = LaunchSecretIntent()
    secret_port: RuntimeSecretPort | None = None
    permission: PermissionIntent = PermissionIntent()
    base_instructions: str = ""
    developer_instructions: str = ""
    skill_roots: tuple[Path, ...] = ()
    skill_configurations: tuple[SkillConfiguration, ...] = ()
    artifact_directives: tuple[ArtifactDirectiveSpec, ...] = ()
    required_capabilities: tuple[RuntimeCapabilityName, ...] = ()
    ephemeral: bool = False
    reservation_id: str = ""
    initial_history: tuple[HistoryEntry, ...] = ()
    timing: RuntimeTimingPort = field(default=NOOP_RUNTIME_TIMING, compare=False, repr=False)


@dataclass(frozen=True)
class ResumeSessionRequest:
    binding: RuntimeBinding
    cwd: Path
    model: ModelIntent = ModelIntent()
    credential_port: ModelCredentialPort | None = None
    launch_secrets: LaunchSecretIntent = LaunchSecretIntent()
    secret_port: RuntimeSecretPort | None = None
    permission: PermissionIntent = PermissionIntent()
    base_instructions: str = ""
    developer_instructions: str = ""
    skill_roots: tuple[Path, ...] = ()
    skill_configurations: tuple[SkillConfiguration, ...] = ()
    artifact_directives: tuple[ArtifactDirectiveSpec, ...] = ()
    reservation_id: str = ""
    timing: RuntimeTimingPort = field(default=NOOP_RUNTIME_TIMING, compare=False, repr=False)


@dataclass(frozen=True)
class TurnRequest:
    command_id: str
    items: tuple[RuntimeValue, ...]
    model: str = ""
    collaboration_mode: str = ""


@dataclass(frozen=True)
class SteerRequest:
    command_id: str
    items: tuple[RuntimeValue, ...]
    expected_turn_id: str = ""


@dataclass(frozen=True)
class InterruptRequest:
    command_id: str
    expected_turn_id: str = ""


@dataclass(frozen=True)
class TerminateSessionRequest:
    command_id: str


@dataclass(frozen=True)
class ForkRequest:
    command_id: str
    product_session_id: str
    source: RuntimeBinding


@dataclass(frozen=True)
class ArchiveRequest:
    command_id: str


@dataclass(frozen=True)
class DeleteRequest:
    command_id: str


@dataclass(frozen=True)
class RuntimeConfigurationIntent:
    revision: str
    permission: PermissionIntent | None = None
    model: ModelIntent | None = None
    required: bool = False


@dataclass(frozen=True)
class AppliedState:
    requested_revision: str
    applied_revision: str
    state: CommandState
    scope: str = ""
    evidence_ref: str = ""
    safe_error: str = ""
    values: RuntimeValue = None


@dataclass(frozen=True)
class InventoryRequest:
    kinds: tuple[InventoryKind, ...]
    refresh: bool = False


@dataclass(frozen=True)
class RuntimeInventory:
    revision: str
    values: RuntimeValue


@dataclass(frozen=True)
class SkillConfiguration:
    """Enablement of one installed skill identity, owned by the calling product."""

    path: Path
    enabled: bool


@dataclass(frozen=True)
class SkillConfigurationRequest:
    cwd: Path
    skills: tuple[SkillConfiguration, ...]
    roots: tuple[Path, ...] = ()
    timing: RuntimeTimingPort = field(default=NOOP_RUNTIME_TIMING, compare=False, repr=False)


@dataclass(frozen=True)
class RuntimeInspectionRequest:
    """Query provider inventory without creating a native agent session."""

    cwd: Path
    inventory: InventoryRequest
    roots: tuple[Path, ...] = ()
    launch_secrets: LaunchSecretIntent = LaunchSecretIntent()
    secret_port: RuntimeSecretPort | None = None
    timing: RuntimeTimingPort = field(default=NOOP_RUNTIME_TIMING, compare=False, repr=False)


@dataclass(frozen=True)
class RuntimeControlRequest:
    command_id: str
    kind: RuntimeControlKind
    values: RuntimeValue


__all__ = [
    "AppliedState",
    "ArchiveRequest",
    "CommandReceipt",
    "CommandState",
    "DeleteRequest",
    "ForkRequest",
    "InventoryKind",
    "InterruptRequest",
    "InventoryRequest",
    "OpenSessionRequest",
    "RuntimeConfigurationIntent",
    "RuntimeControlKind",
    "RuntimeControlRequest",
    "RuntimeInventory",
    "RuntimeInspectionRequest",
    "ResumeSessionRequest",
    "SkillConfiguration",
    "SkillConfigurationRequest",
    "SteerRequest",
    "TerminateSessionRequest",
    "TurnRequest",
]
