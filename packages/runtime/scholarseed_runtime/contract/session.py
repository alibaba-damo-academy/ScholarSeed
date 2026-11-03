"""Runtime session SPI implemented by independently packaged adapters."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable

from scholarseed_runtime.contract.binding import RuntimeBinding
from scholarseed_runtime.contract.capability import CapabilitySet
from scholarseed_runtime.contract.command import (
    AppliedState,
    ArchiveRequest,
    CommandReceipt,
    CommandState,
    DeleteRequest,
    ForkRequest,
    InterruptRequest,
    InventoryRequest,
    RuntimeConfigurationIntent,
    RuntimeControlRequest,
    RuntimeInventory,
    SteerRequest,
    TerminateSessionRequest,
    ThreadReplacementProof,
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
RUNTIME_CONFIRMATION_UNSUPPORTED = "runtime_turn_confirmation_unsupported"
RUNTIME_CONFIRMATION_STALE = "runtime_turn_confirmation_stale"
RUNTIME_CONFIRMATION_BUSY = "runtime_turn_confirmation_busy"
RUNTIME_CONFIRMATION_UNPERSISTED = "runtime_turn_confirmation_unpersisted"
RUNTIME_THREAD_REPLACEMENT_UNSUPPORTED = "runtime_thread_replacement_unsupported"
RUNTIME_THREAD_REPLACEMENT_STALE = "runtime_thread_replacement_stale"
RUNTIME_THREAD_REPLACEMENT_BUSY = "runtime_thread_replacement_busy"
RUNTIME_THREAD_REPLACEMENT_UNPERSISTED = "runtime_thread_replacement_unpersisted"
RUNTIME_OBSERVATION_PENDING = "runtime_observation_pending"
RUNTIME_ACTIVITY_CHANGED = "runtime_activity_changed"
RUNTIME_TRANSIENT_ACTIVITY_BLOCKERS = frozenset(
    {RUNTIME_OBSERVATION_PENDING, RUNTIME_ACTIVITY_CHANGED}
)


@dataclass(frozen=True)
class TurnConfirmationTarget:
    product_session_id: str
    native_session_id: str
    client_submission_id: str
    incident_id: str
    process_generation: int


@dataclass(frozen=True)
class TurnConfirmationTicket:
    ticket_id: str
    target: TurnConfirmationTarget
    generation: str
    revision: int
    watermark: int


@dataclass(frozen=True)
class TurnConfirmationReceipt:
    ticket: TurnConfirmationTicket
    state: CommandState
    safe_error: str = ""


@runtime_checkable
class RuntimeTurnConfirmation(Protocol):
    async def prepare_turn_confirmation(
        self, target: TurnConfirmationTarget
    ) -> TurnConfirmationTicket: ...

    async def commit_turn_confirmation(
        self, ticket: TurnConfirmationTicket, persisted_watermark: int
    ) -> TurnConfirmationReceipt: ...


@dataclass(frozen=True)
class ThreadReplacementTarget:
    binding: RuntimeBinding
    command_id: str
    incident_id: str
    failed_generation: int


@dataclass(frozen=True)
class ThreadReplacementTicket:
    proof: ThreadReplacementProof
    generation: str
    revision: int
    watermark: int


@dataclass(frozen=True)
class ThreadReplacementReceipt:
    ticket: ThreadReplacementTicket
    state: CommandState
    safe_error: str = ""


@runtime_checkable
class RuntimeThreadReplacement(Protocol):
    async def prepare_thread_replacement(
        self, target: ThreadReplacementTarget
    ) -> ThreadReplacementTicket: ...

    async def commit_thread_replacement(
        self, ticket: ThreadReplacementTicket, persisted_watermark: int
    ) -> ThreadReplacementReceipt: ...


class SuspendState(str, Enum):
    PREPARED = "prepared"
    COMMITTING = "committing"
    RELEASED = "released"
    ABORTED = "aborted"


class RuntimeExecutionTreeBlocker(str, Enum):
    TURN = "turn_active"
    BACKGROUND_TASK = "background_task_active"


@dataclass(frozen=True)
class RuntimeExecutionThread:
    thread_id: str
    parent_thread_id: str


@dataclass(frozen=True)
class RuntimeActivitySnapshot:
    generation: str
    revision: int
    watermark: int
    complete: bool
    blockers: tuple[str, ...] = ()
    execution_tree_complete: bool = False
    execution_tree_blockers: tuple[str, ...] = ()

    @property
    def idle(self) -> bool:
        return self.complete and not self.blockers

    @property
    def execution_tree_idle(self) -> bool:
        return self.execution_tree_complete and not self.execution_tree_blockers


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
    "RuntimeThreadReplacement",
    "ThreadReplacementTarget",
    "ThreadReplacementTicket",
    "ThreadReplacementReceipt",
    "RUNTIME_THREAD_REPLACEMENT_UNSUPPORTED",
    "RUNTIME_THREAD_REPLACEMENT_STALE",
    "RUNTIME_THREAD_REPLACEMENT_BUSY",
    "RUNTIME_THREAD_REPLACEMENT_UNPERSISTED",
    "RuntimeTurnConfirmation",
    "TurnConfirmationTarget",
    "TurnConfirmationTicket",
    "TurnConfirmationReceipt",
    "RuntimeSession",
    "RuntimeActivitySnapshot",
    "RuntimeExecutionTreeBlocker",
    "RuntimeExecutionThread",
    "SuspendTicket",
    "SuspendReceipt",
    "SuspendState",
    "RUNTIME_SUSPEND_BUSY",
    "RUNTIME_SUSPEND_STALE",
    "RUNTIME_SUSPEND_UNPERSISTED",
    "RUNTIME_SUSPEND_UNSUPPORTED",
]
