"""Validated Codex process budgets and admission state."""

from __future__ import annotations

import math
from dataclasses import dataclass, fields
from enum import Enum
from typing import Mapping

from scholarseed_runtime.contract.resource import ResourceState

DEFAULT_RESOURCE_QUEUE_LIMIT = 100
DEFAULT_RESOURCE_WAIT_SECONDS = 120.0
DEFAULT_THREAD_UNLOAD_SECONDS = 30 * 60
DEFAULT_ATTACHMENT_IDLE_SECONDS = 0.0
CODEX_THREAD_UNLOAD_CONFIG = "thread_unload_delay_secs"
DEFAULT_RESERVATION_TOMBSTONE_SECONDS = 300.0
DEFAULT_RESERVATION_TOMBSTONE_LIMIT = 1024
CODEX_POOL_CLOSE_ERROR = "codex_pool_close_failed"
CODEX_HOST_START_FAILED = "codex_host_start_failed"
HOST_LEASE_RELEASED = "released"
CAPACITY_CONFIGURATION_KEY = "capacity"
CAPACITY_CONFIGURATION_INVALID = "codex_capacity_configuration_invalid"


class HostRole(str, Enum):
    EXECUTION = "execution"
    CONTROL = "control"


class HostState(str, Enum):
    STARTING = "starting"
    READY = "ready"
    STOPPING = "stopping"
    STOPPED = "stopped"


SHAREABLE_HOST_STATES = frozenset({HostState.STARTING, HostState.READY})
PENDING_RESOURCE_STATES = frozenset({ResourceState.WAITING, ResourceState.GRANTED})


@dataclass(frozen=True)
class CapacityPolicy:
    execution_hosts: int | None = None
    control_hosts: int | None = None
    queue_limit: int = DEFAULT_RESOURCE_QUEUE_LIMIT
    wait_seconds: float = DEFAULT_RESOURCE_WAIT_SECONDS
    idle_seconds: float = DEFAULT_THREAD_UNLOAD_SECONDS
    tombstone_seconds: float = DEFAULT_RESERVATION_TOMBSTONE_SECONDS
    tombstone_limit: int = DEFAULT_RESERVATION_TOMBSTONE_LIMIT

    def __post_init__(self) -> None:
        for value in (
            self.queue_limit,
            self.tombstone_limit,
        ):
            if type(value) is not int or value <= 0:
                raise ValueError(CAPACITY_CONFIGURATION_INVALID)
        for host_limit in (self.execution_hosts, self.control_hosts):
            if host_limit is not None and (type(host_limit) is not int or host_limit <= 0):
                raise ValueError(CAPACITY_CONFIGURATION_INVALID)
        for duration in (self.wait_seconds, self.idle_seconds, self.tombstone_seconds):
            if (
                isinstance(duration, bool)
                or not isinstance(duration, (int, float))
                or not math.isfinite(duration)
                or duration <= 0
            ):
                raise ValueError(CAPACITY_CONFIGURATION_INVALID)
        if int(self.idle_seconds) != self.idle_seconds:
            raise ValueError(CAPACITY_CONFIGURATION_INVALID)

    def limit(self, role: HostRole) -> int | None:
        return {
            HostRole.EXECUTION: self.execution_hosts,
            HostRole.CONTROL: self.control_hosts,
        }[role]

    @classmethod
    def parse(cls, values: object) -> "CapacityPolicy":
        if values is None:
            return cls()
        if not isinstance(values, Mapping) or set(values) - {CAPACITY_CONFIGURATION_KEY}:
            raise ValueError(CAPACITY_CONFIGURATION_INVALID)
        capacity = values.get(CAPACITY_CONFIGURATION_KEY, {})
        if not isinstance(capacity, Mapping) or set(capacity) - {item.name for item in fields(cls)}:
            raise ValueError(CAPACITY_CONFIGURATION_INVALID)
        return cls(**capacity)


__all__ = ["CapacityPolicy", "HostRole", "HostState"]
