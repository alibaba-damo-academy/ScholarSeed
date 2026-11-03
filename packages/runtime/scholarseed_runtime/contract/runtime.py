"""External runtime descriptor and readiness records."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum

from scholarseed_runtime.contract.capability import CapabilitySet
from scholarseed_runtime.contract.event import RuntimeValue
from scholarseed_runtime.contract.resource import ResourceLease
from scholarseed_runtime.contract.sandbox import SandboxRecovery, SandboxResources
from scholarseed_runtime.contract.storage import RuntimeConfigurationStorage

RUNTIME_ABI_VERSION = "6"


@dataclass(frozen=True)
class ProviderConfiguration:
    runtime_id: str
    values: RuntimeValue = None
    resource_lease: Callable[[], ResourceLease] | None = None
    configuration_storage: RuntimeConfigurationStorage | None = None
    sandbox_resources: SandboxResources | None = None
    sandbox_recovery: SandboxRecovery | None = None


class RuntimeStatus(str, Enum):
    READY = "ready"
    UNAVAILABLE = "unavailable"
    UNAUTHENTICATED = "unauthenticated"
    INCOMPATIBLE = "incompatible"
    ERROR = "error"


@dataclass(frozen=True)
class RuntimeDescriptor:
    runtime_id: str
    display_name: str
    adapter_version: str
    runtime_version_range: str
    protocol_version: str
    protocol_schema_hash: str
    capabilities: CapabilitySet
    abi_version: str = RUNTIME_ABI_VERSION
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class RuntimeReadiness:
    runtime_id: str
    status: RuntimeStatus
    ready: bool
    executable: str = ""
    version: str = ""
    authenticated: bool | None = None
    safe_error: str = ""
    warning: str = ""
    process_state: str = ""
    process_generation: int = 0
    recovery_attempt: int = 0
    max_recovery_attempts: int = 0


__all__ = [
    "RUNTIME_ABI_VERSION",
    "ProviderConfiguration",
    "RuntimeDescriptor",
    "RuntimeReadiness",
    "RuntimeStatus",
]
