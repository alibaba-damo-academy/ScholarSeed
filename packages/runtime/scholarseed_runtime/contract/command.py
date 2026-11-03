"""Runtime-neutral commands sent from a product to an adapter."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Awaitable, Callable

from scholarseed_runtime.contract.artifact import ArtifactDirectiveSpec
from scholarseed_runtime.contract.binding import RuntimeBinding
from scholarseed_runtime.contract.capability import RuntimeCapabilityName
from scholarseed_runtime.contract.event import (
    ActorKind,
    DeliveryClass,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeValue,
)
from scholarseed_runtime.contract.evidence import NOOP_RUNTIME_TIMING, RuntimeTimingPort
from scholarseed_runtime.contract.history import HistoryEntry
from scholarseed_runtime.contract.input import SubmissionRetry, TurnAdmission
from scholarseed_runtime.contract.interaction import RuntimeServiceTool
from scholarseed_runtime.contract.inventory import SkillPolicy
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


RUNTIME_SKILL_POLICY_UNSUPPORTED = "runtime_skill_policy_unsupported"


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
class EmptyThreadReplacementProof:
    proof_id: str
    binding: RuntimeBinding
    command_id: str
    call_id: str
    failed_generation: int
    absence_generation: int
    event_id: str
    watermark: int
    submission_deadline: float
    submission_attempts: int

    @classmethod
    def from_event(
        cls, event: RuntimeEvent, binding: RuntimeBinding
    ) -> EmptyThreadReplacementProof:
        payload = event.payload if isinstance(event.payload, Mapping) else {}
        failed = payload.get("failed_generation")
        absent = payload.get("absence_generation")
        proof_id = payload.get("proof_id")
        deadline = payload.get("submission_deadline")
        attempts = payload.get("submission_attempts")
        if (
            event.kind is not RuntimeEventKind.TURN_NOT_SUBMITTED
            or event.delivery is not DeliveryClass.MUST_PERSIST
            or event.actor_kind is not ActorKind.MAIN
            or event.native_turn_id
            or not event.correlation_id
            or not event.call_id
            or not event.event_id
            or type(failed) is not int
            or type(absent) is not int
            or not 0 < failed < absent
            or event.process_generation != absent
            or event.sequence <= 0
            or not isinstance(proof_id, str)
            or not proof_id.strip()
            or not isinstance(deadline, (float, int))
            or isinstance(deadline, bool)
            or not math.isfinite(deadline)
            or deadline <= 0
            or type(attempts) is not int
            or attempts <= 0
            or event.product_session_id != binding.product_session_id
            or event.runtime_id != binding.runtime_id
            or event.native_session_id != binding.opaque_session_ref
        ):
            raise ValueError("invalid empty-thread replacement proof")
        return cls(
            proof_id,
            binding,
            event.correlation_id,
            event.call_id,
            failed,
            absent,
            event.event_id,
            event.sequence,
            float(deadline),
            attempts,
        )


@dataclass(frozen=True)
class ThreadReplacementProof:
    """A missing, exited native attachment can be replaced; its outcome stays unknown."""

    proof_id: str
    binding: RuntimeBinding
    command_id: str
    incident_id: str
    failed_generation: int
    absence_generation: int
    watermark: int


@dataclass(frozen=True)
class SubmissionRetryProof:
    binding: RuntimeBinding
    command_id: str
    call_id: str
    watermark: int
    submission: SubmissionRetry


@dataclass(frozen=True)
class HostWarmupRequest:
    """Prepare an application-owned host without opening a native thread or turn."""

    request_id: str
    cwd: Path
    process_sharing_scope: str = field(repr=False)
    model: ModelIntent = ModelIntent()
    credential_port: ModelCredentialPort | None = None
    launch_secrets: LaunchSecretIntent = LaunchSecretIntent()
    secret_port: RuntimeSecretPort | None = None
    base_instructions: str = ""
    skill_roots: tuple[Path, ...] = ()
    timing: RuntimeTimingPort = field(default=NOOP_RUNTIME_TIMING, compare=False, repr=False)


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
    service_tools: tuple[RuntimeServiceTool, ...] = ()
    skill_roots: tuple[Path, ...] = ()
    skill_configurations: tuple[SkillConfiguration, ...] = ()
    artifact_directives: tuple[ArtifactDirectiveSpec, ...] = ()
    required_capabilities: tuple[RuntimeCapabilityName, ...] = ()
    optional_capabilities: tuple[RuntimeCapabilityName, ...] = ()
    ephemeral: bool = False
    skill_policy: SkillPolicy = SkillPolicy.INHERIT
    reservation_id: str = ""
    initial_history: tuple[HistoryEntry, ...] = ()
    execution_scope: str = ""
    fork_source: ForkRequest | None = None
    timing: RuntimeTimingPort = field(default=NOOP_RUNTIME_TIMING, compare=False, repr=False)
    process_sharing_scope: str = field(default="", repr=False)
    execution_environment: Mapping[str, str] = field(default_factory=dict)


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
    service_tools: tuple[RuntimeServiceTool, ...] = ()
    skill_roots: tuple[Path, ...] = ()
    skill_configurations: tuple[SkillConfiguration, ...] = ()
    skill_policy: SkillPolicy = SkillPolicy.INHERIT
    artifact_directives: tuple[ArtifactDirectiveSpec, ...] = ()
    reservation_id: str = ""
    execution_scope: str = ""
    timing: RuntimeTimingPort = field(default=NOOP_RUNTIME_TIMING, compare=False, repr=False)
    process_sharing_scope: str = field(default="", repr=False)
    execution_environment: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class TurnRequest:
    command_id: str
    items: tuple[RuntimeValue, ...]
    model: str = ""
    collaboration_mode: str = ""
    admission: TurnAdmission | None = None
    submission_deadline: float | None = None
    submission_attempts: int = 0
    retry_authorizer: Callable[[SubmissionRetryProof], Awaitable[Callable[[], bool]]] | None = None


@dataclass(frozen=True)
class SteerRequest:
    command_id: str
    items: tuple[RuntimeValue, ...]
    expected_turn_id: str = ""


@dataclass(frozen=True)
class InterruptRequest:
    command_id: str
    expected_turn_id: str = ""
    cleanup_background_processes: bool = False


@dataclass(frozen=True)
class TerminateSessionRequest:
    command_id: str


@dataclass(frozen=True)
class ForkRequest:
    command_id: str
    product_session_id: str
    source: RuntimeBinding
    source_turn_id: str = ""


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
    host_identity: str = ""


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
    host: HostWarmupRequest | None = field(default=None, repr=False)


@dataclass(frozen=True)
class RuntimeInspectionRequest:
    """Query provider inventory without creating a native agent session."""

    cwd: Path
    inventory: InventoryRequest
    roots: tuple[Path, ...] = ()
    launch_secrets: LaunchSecretIntent = LaunchSecretIntent()
    secret_port: RuntimeSecretPort | None = None
    timing: RuntimeTimingPort = field(default=NOOP_RUNTIME_TIMING, compare=False, repr=False)
    host: HostWarmupRequest | None = field(default=None, repr=False)


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
    "HostWarmupRequest",
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
