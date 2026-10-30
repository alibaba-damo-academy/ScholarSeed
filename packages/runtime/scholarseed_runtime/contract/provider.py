"""Provider SPI for opening and resuming external agent sessions."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from scholarseed_runtime.contract.binding import RuntimeBinding
from scholarseed_runtime.contract.command import (
    CommandReceipt,
    HostWarmupRequest,
    OpenSessionRequest,
    ResumeSessionRequest,
    RuntimeInspectionRequest,
    RuntimeInventory,
    SkillConfigurationRequest,
)
from scholarseed_runtime.contract.resource import ResourcePolicy, ResourceReceipt, ResourceRequest
from scholarseed_runtime.contract.runtime import (
    ProviderConfiguration,
    RuntimeDescriptor,
    RuntimeReadiness,
)
from scholarseed_runtime.contract.session import RuntimeExecutionThread, RuntimeSession
from scholarseed_runtime.contract.storage import StorageInspection, StorageRoot

RUNTIME_OPEN_NOT_APPLIED = "runtime_session_open_not_applied"
RUNTIME_HOST_WARMUP_COMMAND = "host.prewarm"
RUNTIME_HOST_RECONFIGURATION_COMMAND = "host.reconfigure"


@runtime_checkable
class RuntimeHostWarmup(Protocol):
    """Optional admitted host initialization; APPLIED creates no session or turn."""

    async def prewarm(self, request: HostWarmupRequest) -> CommandReceipt: ...


@runtime_checkable
class RuntimeHostReconfiguration(Protocol):
    """Explicit same-authority replacement after the application closes admission.

    The caller owns product intent authorization and attachment drain. The provider must
    prove physical release before unlocking configuration and reserve the target
    atomically against ordinary admission. Uncertain mutations stay fenced.
    """

    async def reconfigure(self, request: HostWarmupRequest) -> CommandReceipt: ...


class RuntimeOpenNotAppliedError(RuntimeError):
    """Prove this reservation attempted no native open and settled its ownership.

    Providers may raise this only after exclusively claiming the reservation,
    before native session creation, and after all owned cleanup has completed.
    Cancellation, ambiguous writes, and incomplete cleanup cannot establish it.
    """

    def __init__(self, reservation_id: str, safe_error: str = RUNTIME_OPEN_NOT_APPLIED) -> None:
        if not reservation_id.strip():
            raise ValueError("negative open proof requires a reservation identity")
        self.reservation_id = reservation_id
        self.safe_error = safe_error or RUNTIME_OPEN_NOT_APPLIED
        super().__init__(self.safe_error)


class RuntimeProvider(Protocol):
    @property
    def descriptor(self) -> RuntimeDescriptor: ...

    def storage_roots(self, inspection: StorageInspection | None = None) -> tuple[StorageRoot, ...]:
        """Declare persistent directory roots before configuration or execution.

        This must not create directories, launch processes or prepare credentials.
        Return absolute paths with explicit directory-creation permission; ()
        explicitly declares no provider-owned storage.
        Session workspaces are supplied separately by the host. This inventory
        grants neither filesystem access nor data-format compatibility.
        Without inspection, do not open persistent files. With inspection, use
        only its qualified reads; an unselected root must be returned for the
        host's next discovery pass, never opened directly.
        """
        ...

    def configure(self, configuration: ProviderConfiguration) -> CommandReceipt: ...

    @property
    def resource_policy(self) -> ResourcePolicy: ...

    async def reserve(self, request: ResourceRequest) -> ResourceReceipt: ...

    async def wait_resource(self, reservation_id: str) -> ResourceReceipt: ...

    async def cancel_resource(self, reservation_id: str) -> ResourceReceipt: ...

    async def probe(self) -> RuntimeReadiness: ...

    async def inspect(self, request: RuntimeInspectionRequest) -> RuntimeInventory: ...

    async def execution_threads(
        self, binding: RuntimeBinding, cwd: Path, *, host: HostWarmupRequest | None = None
    ) -> tuple[RuntimeExecutionThread, ...]: ...

    async def configure_skills(self, request: SkillConfigurationRequest) -> CommandReceipt: ...

    async def open(self, request: OpenSessionRequest) -> RuntimeSession:
        """Open once; only RuntimeOpenNotAppliedError proves safe first-open retry."""
        ...

    async def resume(self, request: ResumeSessionRequest) -> RuntimeSession: ...

    async def release_idle_resources(self) -> CommandReceipt:
        """Release unowned native resources; APPLIED confirms none remain.

        This does not close admission or permanently shut down the provider.
        Active, unknown or failed resources must never be reported as released.
        """
        ...

    async def shutdown(self) -> CommandReceipt: ...


__all__ = [
    "RUNTIME_HOST_RECONFIGURATION_COMMAND",
    "RUNTIME_HOST_WARMUP_COMMAND",
    "RuntimeHostWarmup",
    "RuntimeHostReconfiguration",
    "RuntimeOpenNotAppliedError",
    "RuntimeProvider",
]
