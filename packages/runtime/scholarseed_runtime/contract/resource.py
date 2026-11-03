"""Opaque, bounded execution-resource admission across the provider boundary."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from scholarseed_runtime.contract.command import OpenSessionRequest, ResumeSessionRequest

RESOURCE_LIFECYCLE_LOGGER = "scholarseed_runtime.resources"

RESOURCE_WAIT_TIMEOUT = "runtime_resource_wait_timeout"
RESOURCE_QUEUE_FULL = "runtime_resource_queue_full"
RESOURCE_CANCELLED = "runtime_resource_cancelled"
RESOURCE_RESERVATION_INVALID = "runtime_resource_reservation_invalid"
RESOURCE_THREAD_CAPACITY = "runtime_thread_capacity_reached"
RESOURCE_HOST_CONFIGURATION_CONFLICT = "runtime_host_configuration_conflict"
RESOURCE_HOST_CONTEXT_REQUIRED = "runtime_host_context_required"
RESOURCE_HOST_CONFIGURATION_UNCERTAIN = "runtime_host_configuration_uncertain"
RESOURCE_HOST_BUSY = "runtime_host_busy"
RESOURCE_RELEASE_BUSY = "runtime_resource_release_busy"
RESOURCE_RELEASE_FAILED = "runtime_resource_release_failed"


class ResourceLease(Protocol):
    """Physical resource ownership, retained until its OS lifetime has ended."""

    def close(self) -> None: ...


class ResourcePurpose(str, Enum):
    SESSION = "session"
    TURN = "turn"
    INVOCATION = "invocation"
    CONTROL = "control"


class ResourceState(str, Enum):
    GRANTED = "granted"
    WAITING = "waiting"
    REJECTED = "rejected"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
    CONSUMED = "consumed"


@dataclass(frozen=True)
class ResourcePolicy:
    wait_seconds: float
    idle_seconds: float
    refresh_before_turn: bool = False


@dataclass(frozen=True)
class ResourceCapacity:
    role: str
    limit: int | None
    used: int
    waiting: int


@dataclass(frozen=True)
class ResourceRequest:
    request_id: str
    purpose: ResourcePurpose
    deadline: float
    session_request: OpenSessionRequest | ResumeSessionRequest


@dataclass(frozen=True)
class ResourceReceipt:
    request_id: str
    reservation_id: str
    state: ResourceState
    capacity: tuple[ResourceCapacity, ...] = ()
    safe_error: str = ""
    deadline: float = 0.0
    evidence: ResourceEvidence | None = None


@dataclass(frozen=True)
class ResourceEvidence:
    """Resource ownership evidence; never includes the process compatibility key."""

    event_id: str
    request_id: str
    reservation_id: str
    host_id: str
    lease_id: str
    role: str
    state: str
    observed_at: float
    capacity: tuple[ResourceCapacity, ...]
    process_generation: int = 0


__all__ = [
    "RESOURCE_CANCELLED",
    "RESOURCE_HOST_CONFIGURATION_CONFLICT",
    "RESOURCE_HOST_CONFIGURATION_UNCERTAIN",
    "RESOURCE_HOST_CONTEXT_REQUIRED",
    "RESOURCE_HOST_BUSY",
    "RESOURCE_QUEUE_FULL",
    "RESOURCE_RELEASE_BUSY",
    "RESOURCE_RELEASE_FAILED",
    "RESOURCE_RESERVATION_INVALID",
    "RESOURCE_THREAD_CAPACITY",
    "RESOURCE_WAIT_TIMEOUT",
    "ResourceCapacity",
    "ResourceEvidence",
    "ResourceLease",
    "ResourcePolicy",
    "ResourcePurpose",
    "ResourceReceipt",
    "ResourceRequest",
    "ResourceState",
]
