"""Runtime session SPI implemented by independently packaged adapters."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from scholarseed_runtime.contract.binding import RuntimeBinding
from scholarseed_runtime.contract.capability import CapabilitySet
from scholarseed_runtime.contract.command import (
    AppliedState,
    ArchiveRequest,
    CommandReceipt,
    DeleteRequest,
    ForkRequest,
    InterruptRequest,
    InventoryRequest,
    RuntimeConfigurationIntent,
    RuntimeControlRequest,
    RuntimeInventory,
    SteerRequest,
    TerminateSessionRequest,
    TurnRequest,
)
from scholarseed_runtime.contract.event import RuntimeEvent, RuntimeValue
from scholarseed_runtime.contract.interaction import RuntimeCallbackRequest, RuntimeCallbackResponse
from scholarseed_runtime.contract.resource import ResourceEvidence

RUNTIME_SUSPEND_BUSY = "runtime_suspend_busy"
RUNTIME_SUSPEND_UNSUPPORTED = "runtime_suspend_unsupported"
RUNTIME_SUSPEND_STALE = "runtime_suspend_stale"
RUNTIME_SUSPEND_UNPERSISTED = "runtime_suspend_unpersisted"
RUNTIME_SUSPEND_FAILED = "runtime_suspend_failed"


class SuspendState(str, Enum):
    PREPARED = "prepared"
    COMMITTING = "committing"
    RELEASED = "released"
    ABORTED = "aborted"


@dataclass(frozen=True)
class RuntimeActivitySnapshot:
    generation: str
    revision: int
    watermark: int
    complete: bool
    blockers: tuple[str, ...] = ()

    @property
    def idle(self) -> bool:
        return self.complete and not self.blockers


@dataclass(frozen=True)
class SuspendTicket:
    ticket_id: str
    generation: str
    revision: int
    watermark: int


@dataclass(frozen=True)
class SuspendReceipt:
    ticket: SuspendTicket
    state: SuspendState
    safe_error: str = ""
    finished: bool = False


class RuntimeSession(Protocol):
    @property
    def binding(self) -> RuntimeBinding: ...

    @property
    def capabilities(self) -> CapabilitySet: ...

    @property
    def resource_evidence(self) -> ResourceEvidence | None: ...

    async def activity(self) -> RuntimeActivitySnapshot: ...

    async def prepare_suspend(self, expected_revision: int) -> SuspendTicket: ...

    async def commit_suspend(
        self, ticket: SuspendTicket, persisted_watermark: int
    ) -> SuspendReceipt: ...

    async def abort_suspend(self, ticket: SuspendTicket) -> SuspendReceipt: ...

    async def suspend_status(self, ticket: SuspendTicket) -> SuspendReceipt: ...

    async def snapshot(self) -> RuntimeValue: ...

    async def history(self, cursor: RuntimeValue = None) -> RuntimeValue: ...

    def events(self) -> AsyncIterator[RuntimeEvent | RuntimeCallbackRequest]: ...

    async def submit(self, request: TurnRequest) -> CommandReceipt: ...

    async def steer(self, request: SteerRequest) -> CommandReceipt: ...

    async def interrupt(self, request: InterruptRequest) -> CommandReceipt: ...

    async def terminate(self, request: TerminateSessionRequest) -> CommandReceipt: ...

    async def respond(self, response: RuntimeCallbackResponse) -> CommandReceipt: ...

    async def reconfigure(self, request: RuntimeConfigurationIntent) -> AppliedState: ...

    async def fork(self, request: ForkRequest) -> "RuntimeSession": ...

    async def archive(self, request: ArchiveRequest) -> CommandReceipt: ...

    async def delete(self, request: DeleteRequest) -> CommandReceipt: ...

    async def inventory(self, request: InventoryRequest) -> RuntimeInventory: ...

    async def control(self, request: RuntimeControlRequest) -> AppliedState: ...

    async def detach(self) -> None: ...


__all__ = [
    "RuntimeSession",
    "RuntimeActivitySnapshot",
    "SuspendTicket",
    "SuspendReceipt",
    "SuspendState",
    "RUNTIME_SUSPEND_BUSY",
    "RUNTIME_SUSPEND_STALE",
    "RUNTIME_SUSPEND_UNPERSISTED",
    "RUNTIME_SUSPEND_UNSUPPORTED",
]
