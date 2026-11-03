"""Normalized events emitted by an external agent runtime adapter."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TypeAlias

RuntimeScalar: TypeAlias = str | int | float | bool | None
RuntimeValue: TypeAlias = RuntimeScalar | list["RuntimeValue"] | dict[str, "RuntimeValue"]


class DeliveryClass(str, Enum):
    MUST_PERSIST = "must_persist"
    COALESCIBLE = "coalescible"
    EVIDENCE_ONLY = "evidence_only"


class ActorKind(str, Enum):
    MAIN = "main"
    SUBAGENT = "subagent"


class RuntimeEventKind(str, Enum):
    SESSION_OPENED = "session.opened"
    SESSION_RESUMED = "session.resumed"
    SESSION_CLOSED = "session.closed"
    TURN_STARTED = "turn.started"
    CONTENT_DELTA = "content.delta"
    CONTENT_COMPLETED = "content.completed"
    TOOL_STARTED = "tool.started"
    TOOL_PROGRESS = "tool.progress"
    TOOL_COMPLETED = "tool.completed"
    ARTIFACT_OBSERVED = "artifact.observed"
    ARTIFACT_DECLARED = "artifact.declared"
    ARTIFACT_DECLARATION_FAILED = "artifact.declaration_failed"
    PLAN_UPDATED = "plan.updated"
    USAGE_UPDATED = "usage.updated"
    CONTEXT_COMPACTED = "context.compacted"
    MODEL_CAPABILITY_RESOLUTION = "model.capability_resolution"
    SKILLS_CHANGED = "skills.changed"
    INTERACTION_RESOLVED = "interaction.resolved"
    TURN_COMPLETED = "turn.completed"
    TURN_FAILED = "turn.failed"
    TURN_INTERRUPTED = "turn.interrupted"
    TURN_UNKNOWN = "turn.unknown"
    TURN_NOT_SUBMITTED = "turn.not_submitted"
    SUBAGENT_SPAWNED = "subagent.spawned"
    SUBAGENT_STARTED = "subagent.started"
    SUBAGENT_STATUS_CHANGED = "subagent.status_changed"
    SUBAGENT_COMPLETED = "subagent.completed"
    SUBAGENT_FAILED = "subagent.failed"
    SUBAGENT_INTERRUPTED = "subagent.interrupted"
    RUNTIME_STATUS = "runtime.status"
    RUNTIME_WARNING = "runtime.warning"
    RUNTIME_EVIDENCE = "runtime.evidence"
    RUNTIME_INCIDENT = "runtime.incident"
    RUNTIME_STREAM_GAP = "runtime.stream_gap"
    RUNTIME_EXTENSION = "runtime.extension"


@dataclass(frozen=True)
class RuntimeEvent:
    schema_version: int
    event_id: str
    runtime_id: str
    product_session_id: str
    native_session_id: str
    process_generation: int
    sequence: int
    kind: RuntimeEventKind
    delivery: DeliveryClass
    observed_at: str
    native_turn_id: str = ""
    native_item_id: str = ""
    call_id: str = ""
    correlation_id: str = ""
    causation_id: str = ""
    actor_kind: ActorKind = ActorKind.MAIN
    actor_id: str = ""
    parent_actor_id: str = ""
    payload: RuntimeValue = None
    evidence_ref: str = ""


__all__ = [
    "ActorKind",
    "DeliveryClass",
    "RuntimeEvent",
    "RuntimeEventKind",
    "RuntimeScalar",
    "RuntimeValue",
]
