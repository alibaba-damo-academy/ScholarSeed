"""Opaque, bounded execution-resource admission across the provider boundary."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from scholarseed_runtime.contract.command import OpenSessionRequest, ResumeSessionRequest

RESOURCE_LIFECYCLE_LOGGER = "scholarseed_runtime.resources"

RESOURCE_WAIT_TIMEOUT = "runtime_resource_wait_timeout"
RESOURCE_QUEUE_FULL = "runtime_resource_queue_full"
RESOURCE_CANCELLED = "runtime_resource_cancelled"
RESOURCE_RESERVATION_INVALID = "runtime_resource_reservation_invalid"


class ResourcePurpose(str, Enum):
    SESSION = "session"
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


@dataclass(frozen=True)
class ResourceCapacity:
    role: str
    limit: int
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
    "RESOURCE_QUEUE_FULL",
    "RESOURCE_RESERVATION_INVALID",
    "RESOURCE_WAIT_TIMEOUT",
    "ResourceCapacity",
    "ResourceEvidence",
    "ResourcePolicy",
    "ResourcePurpose",
    "ResourceReceipt",
    "ResourceRequest",
    "ResourceState",
]
