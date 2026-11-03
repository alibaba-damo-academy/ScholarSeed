"""Runtime-neutral capability contracts for external agent Harnesses."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class CapabilityState(str, Enum):
    SUPPORTED = "supported"
    DEGRADED = "degraded"
    EXPERIMENTAL = "experimental"
    UNSUPPORTED = "unsupported"


class RuntimeCapabilityName(str, Enum):
    SUSPEND = "suspend"
    RESOURCE_ADMISSION = "resource_admission"
    HOST_WARMUP = "host_warmup"
    HOST_RECONFIGURATION = "host_reconfiguration"
    SHARED_HOST_CONTROL = "shared_host_control"
    TURN_CONFIRMATION = "turn_confirmation"
    THREAD_REPLACEMENT = "thread_replacement"
    TURN_ADMISSION = "turn_admission"
    RESUME = "resume"
    FORK = "fork"
    STEER = "steer"
    INTERRUPT = "interrupt"
    HUMAN_IN_THE_LOOP = "human_in_the_loop"
    TOOL_APPROVAL = "tool_approval"
    MODEL_INVENTORY = "model_inventory"
    SKILL_INVENTORY = "skill_inventory"
    MCP_INVENTORY = "mcp_inventory"
    PLAN_SNAPSHOT = "plan_snapshot"
    TOOL_EVENTS = "tool_events"
    WEB_SEARCH = "web_search"
    FILE_EVENTS = "file_events"
    ARTIFACT_DECLARATIONS = "artifact_declarations"
    TYPED_INPUT = "typed_input"
    LOCAL_IMAGES = "local_images"
    FILE_INPUTS = "file_inputs"
    SANDBOX = "sandbox"
    COLLABORATION_MODES = "collaboration_modes"
    SUBAGENT_LIFECYCLE = "subagent_lifecycle"
    SUBAGENT_CONTENT = "subagent_content"
    SUBAGENT_CONTROL = "subagent_control"
    TERMINATE_SESSION = "terminate_session"
    SKILLS = "skills"
    ARCHIVE = "archive"
    DELETE = "delete"
    RECONFIGURE = "reconfigure"


@dataclass(frozen=True)
class RuntimeCapability:
    name: str
    state: CapabilityState
    detail: str = ""


@dataclass(frozen=True)
class CapabilitySet:
    entries: tuple[RuntimeCapability, ...] = ()


__all__ = [
    "CapabilitySet",
    "CapabilityState",
    "RuntimeCapability",
    "RuntimeCapabilityName",
]
