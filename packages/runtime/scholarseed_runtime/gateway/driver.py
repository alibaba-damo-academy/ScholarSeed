"""Runtime-neutral command/event orchestration over the public Gateway ABI."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import Enum

from scholarseed_runtime.contract import (
    CommandReceipt,
    CommandState,
    RuntimeCallbackRequest,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeSession,
    TurnRequest,
)
from scholarseed_runtime.contract.content import validate_content
from scholarseed_runtime.contract.history import MessagePhase
from scholarseed_runtime.contract.session import SuspendReceipt, SuspendState, SuspendTicket

RuntimeObservation = RuntimeEvent | RuntimeCallbackRequest
RuntimeObservationHandler = Callable[[RuntimeObservation], Awaitable[None]]


class RuntimeDriverError(RuntimeError):
    """A provider violated a binding, sequence, or command contract."""


def _token_count(value: object) -> int:
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RuntimeDriverError("runtime token usage must be a non-negative integer")
    return value


class RuntimeTurnOutcome(str, Enum):
    COMPLETED = "completed"
    FAILED = "failed"
    INTERRUPTED = "interrupted"
    UNKNOWN = "unknown"


TERMINAL_OUTCOMES = {
    RuntimeEventKind.TURN_COMPLETED: RuntimeTurnOutcome.COMPLETED,
    RuntimeEventKind.TURN_FAILED: RuntimeTurnOutcome.FAILED,
    RuntimeEventKind.TURN_INTERRUPTED: RuntimeTurnOutcome.INTERRUPTED,
    RuntimeEventKind.TURN_UNKNOWN: RuntimeTurnOutcome.UNKNOWN,
}


@dataclass(frozen=True)
class RuntimeTurnResult:
    command_id: str
    native_turn_id: str
    outcome: RuntimeTurnOutcome
    final_text: str = ""
    safe_error: str = ""
    input_tokens: int = 0
    output_tokens: int = 0


class RuntimeDriver:
    """One consumer for one runtime session; product fan-out happens after projection."""

    def __init__(
        self,
        session: RuntimeSession,
        on_observation: RuntimeObservationHandler,
    ) -> None:
        self._session = session
        self._on_observation = on_observation
        self._consumer: asyncio.Task[None] | None = None
        self._terminals: dict[str, asyncio.Future[RuntimeTurnResult]] = {}
        self._final_text: dict[str, str] = {}
        self._usage: dict[str, tuple[int, int]] = {}
        self._last_sequence = 0
        self._projected_sequence = 0
        self._projection_changed = asyncio.Condition()
        self._consumer_error: BaseException | None = None
        self._closed = False
        self._suspend_ticket: SuspendTicket | None = None

    @property
    def session(self) -> RuntimeSession:
        return self._session

    @property
    def suspending(self) -> bool:
        return self._suspend_ticket is not None

    def start(self) -> None:
        if self._consumer is not None:
            raise RuntimeDriverError("runtime event consumer is already started")
        self._consumer = asyncio.create_task(self._consume())

    async def submit(self, request: TurnRequest) -> RuntimeTurnResult:
        if self._closed:
            raise RuntimeDriverError("runtime event consumer is closed")
        if request.command_id in self._terminals:
            raise RuntimeDriverError("runtime command id is already active")
        future = asyncio.get_running_loop().create_future()
        self._terminals[request.command_id] = future
        try:
            receipt = await self._session.submit(request)
            if receipt.state is not CommandState.ACCEPTED:
                raise RuntimeCommandError(receipt)
            return await future
        finally:
            if not future.done():
                future.cancel()
            self._terminals.pop(request.command_id, None)
            self._final_text.pop(request.command_id, None)
            self._usage.pop(request.command_id, None)

    async def close(self) -> None:
        self._closed = True
        async with self._projection_changed:
            self._projection_changed.notify_all()
        consumer = self._consumer
        self._consumer = None
        if consumer is not None:
            consumer.cancel()
            try:
                await consumer
            except (asyncio.CancelledError, RuntimeDriverError):
                pass
        for future in self._terminals.values():
            if not future.done():
                future.set_exception(RuntimeDriverError("runtime session detached"))
        await self._session.detach()

    async def suspend(self, checkpoint: Callable[[int], Awaitable[None]]) -> SuspendReceipt:
        if self._terminals or self._closed or self._consumer is None:
            raise RuntimeDriverError("runtime driver is not idle")
        ticket = self._suspend_ticket
        if ticket is None:
            snapshot = await self._session.activity()
            ticket = await self._session.prepare_suspend(snapshot.revision)
            self._suspend_ticket = ticket
        try:
            async with self._projection_changed:
                await self._projection_changed.wait_for(
                    lambda: self._projected_sequence >= ticket.watermark
                    or self._consumer_error is not None
                    or self._closed
                )
                if self._consumer_error is not None or self._closed:
                    raise RuntimeDriverError("runtime projection did not complete")
            await checkpoint(ticket.watermark)
            receipt = await self._session.commit_suspend(ticket, self._projected_sequence)
        except BaseException:
            receipt = await self._session.suspend_status(ticket)
            if receipt.state is SuspendState.PREPARED:
                await self._session.abort_suspend(ticket)
                self._suspend_ticket = None
                raise
            if receipt.state is SuspendState.COMMITTING:
                if receipt.finished:
                    raise
                receipt = await self._session.commit_suspend(ticket, self._projected_sequence)
            if receipt.state is not SuspendState.RELEASED:
                raise
        if receipt.state is not SuspendState.RELEASED:
            raise RuntimeDriverError("runtime did not confirm lease release")
        self._closed = True
        consumer = self._consumer
        self._consumer = None
        if consumer is not None:
            consumer.cancel()
            await asyncio.gather(consumer, return_exceptions=True)
        return receipt

    async def _consume(self) -> None:
        try:
            async for observation in self._session.events():
                self._validate(observation)
                await self._on_observation(observation)
                if isinstance(observation, RuntimeEvent):
                    self._reduce(observation)
                    async with self._projection_changed:
                        self._projected_sequence = observation.sequence
                        self._projection_changed.notify_all()
            raise RuntimeDriverError("runtime event stream ended before detach")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._closed = True
            async with self._projection_changed:
                self._consumer_error = error
                self._projection_changed.notify_all()
            for future in self._terminals.values():
                if not future.done():
                    future.set_exception(error)
            raise

    def _validate(self, observation: RuntimeObservation) -> None:
        binding = self._session.binding
        if (
            observation.runtime_id != binding.runtime_id
            or observation.product_session_id != binding.product_session_id
            or observation.native_session_id != binding.opaque_session_ref
        ):
            raise RuntimeDriverError("runtime observation binding mismatch")
        if isinstance(observation, RuntimeEvent):
            validate_content(observation.payload)
            if observation.sequence <= self._last_sequence:
                raise RuntimeDriverError("runtime event sequence is not strictly increasing")
            self._last_sequence = observation.sequence

    def _reduce(self, event: RuntimeEvent) -> None:
        command_id = event.correlation_id
        if event.kind is RuntimeEventKind.CONTENT_COMPLETED and command_id:
            payload = event.payload if isinstance(event.payload, dict) else {}
            if (
                payload.get("role") == "assistant"
                and payload.get("phase") != MessagePhase.COMMENTARY.value
            ):
                self._final_text[command_id] = str(payload.get("text") or "")
            return
        if event.kind is RuntimeEventKind.USAGE_UPDATED and command_id:
            payload = event.payload if isinstance(event.payload, dict) else {}
            self._usage[command_id] = (
                _token_count(payload.get("input_tokens")),
                _token_count(payload.get("output_tokens")),
            )
            return
        outcome = TERMINAL_OUTCOMES.get(event.kind)
        if outcome is None or not command_id:
            return
        future = self._terminals.get(command_id)
        if future is None or future.done():
            return
        payload = event.payload if isinstance(event.payload, dict) else {}
        input_tokens, output_tokens = self._usage.get(command_id, (0, 0))
        future.set_result(
            RuntimeTurnResult(
                command_id=command_id,
                native_turn_id=event.native_turn_id,
                outcome=outcome,
                final_text=self._final_text.get(command_id, ""),
                safe_error=str(payload.get("safe_error") or payload.get("error") or ""),
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
        )


class RuntimeCommandError(RuntimeDriverError):
    """A runtime rejected or could not safely accept a command."""

    def __init__(self, receipt: CommandReceipt) -> None:
        self.receipt = receipt
        super().__init__(receipt.safe_error or f"runtime command {receipt.state.value}")


__all__ = [
    "RuntimeCommandError",
    "RuntimeDriver",
    "RuntimeDriverError",
    "RuntimeObservation",
    "RuntimeObservationHandler",
    "RuntimeTurnOutcome",
    "RuntimeTurnResult",
]
