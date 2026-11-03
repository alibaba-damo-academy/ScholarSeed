"""Runtime-neutral command/event orchestration over the public Gateway ABI."""

from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass, replace
from enum import Enum

from scholarseed_runtime.contract import (
    CapabilityState,
    CommandReceipt,
    CommandState,
    RuntimeCallbackRequest,
    RuntimeCapabilityName,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeSession,
    TurnRequest,
)
from scholarseed_runtime.contract.command import (
    EmptyThreadReplacementProof,
    SubmissionRetryProof,
    ThreadReplacementProof,
)
from scholarseed_runtime.contract.content import validate_content
from scholarseed_runtime.contract.history import MessagePhase
from scholarseed_runtime.contract.incident import RUNTIME_TURN_NOT_SUBMITTED
from scholarseed_runtime.contract.session import (
    RUNTIME_CONFIRMATION_UNSUPPORTED,
    RUNTIME_THREAD_REPLACEMENT_BUSY,
    RUNTIME_THREAD_REPLACEMENT_STALE,
    RUNTIME_THREAD_REPLACEMENT_UNSUPPORTED,
    RuntimeThreadReplacement,
    RuntimeTurnConfirmation,
    SuspendReceipt,
    SuspendState,
    SuspendTicket,
    ThreadReplacementReceipt,
    ThreadReplacementTarget,
    ThreadReplacementTicket,
    TurnConfirmationReceipt,
    TurnConfirmationTarget,
)

RuntimeObservation = RuntimeEvent | RuntimeCallbackRequest
RuntimeObservationHandler = Callable[[RuntimeObservation], Awaitable[None]]
RuntimeObservationBatchHandler = Callable[[tuple[RuntimeObservation, ...]], Awaitable[None]]
OBSERVATION_BATCH_LIMIT = 64
logger = logging.getLogger(__name__)


class RuntimeDriverError(RuntimeError):
    """A provider violated a binding, sequence, or command contract."""


class RuntimeTurnNotSubmittedError(RuntimeDriverError):
    def __init__(self, proof: EmptyThreadReplacementProof) -> None:
        super().__init__(RUNTIME_TURN_NOT_SUBMITTED)
        self.proof = proof
        self.request: TurnRequest | None = None


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
PASSIVE_OBSERVATION_KINDS = frozenset(
    {
        RuntimeEventKind.SESSION_OPENED,
        RuntimeEventKind.SESSION_RESUMED,
        RuntimeEventKind.SESSION_CLOSED,
        RuntimeEventKind.RUNTIME_STATUS,
        RuntimeEventKind.RUNTIME_WARNING,
        RuntimeEventKind.RUNTIME_EVIDENCE,
        RuntimeEventKind.RUNTIME_INCIDENT,
        RuntimeEventKind.MODEL_CAPABILITY_RESOLUTION,
        RuntimeEventKind.SKILLS_CHANGED,
        RuntimeEventKind.TURN_NOT_SUBMITTED,
    }
)


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
        *,
        on_observations: RuntimeObservationBatchHandler | None = None,
    ) -> None:
        self._session = session
        self._on_observation = on_observation
        self._on_observations = on_observations
        self._consumer: asyncio.Task[None] | None = None
        self._terminals: dict[str, asyncio.Future[RuntimeTurnResult]] = {}
        self._calls: dict[str, str] = {}
        self._proofs: dict[str, RuntimeEvent] = {}
        self._started_commands: set[str] = set()
        self._execution_observed = False
        self._final_text: dict[str, str] = {}
        self._usage: dict[str, tuple[int, int]] = {}
        self._last_sequence = 0
        self._projected_sequence = 0
        self._projection_changed = asyncio.Condition()
        self._consumer_error: BaseException | None = None
        self._pending_observations: list[RuntimeObservation] = []
        self._projection_failed = False
        self._recovery_lock = asyncio.Lock()
        self._closed = False
        self._suspend_ticket: SuspendTicket | None = None
        self._replacement_lock = asyncio.Lock()
        self._replacement_ticket: ThreadReplacementTicket | None = None
        self._replacement_receipt: ThreadReplacementReceipt | None = None

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

    @property
    def projection_failed(self) -> bool:
        return self._projection_failed

    async def recover_projection(self) -> int:
        """Resume retained observations only after explicit host recovery admission."""
        async with self._recovery_lock:
            consumer = self._consumer
            if (
                not self.projection_failed
                or consumer is None
                or not consumer.done()
                or self._terminals
            ):
                raise RuntimeDriverError("runtime projection is not recoverable")
            consumer.exception()
            self._projection_failed = False
            try:
                await self._project_pending()
            except asyncio.CancelledError:
                self._projection_failed = True
                raise
            self._consumer_error = None
            self._closed = False
            self._consumer = None
            self.start()
            return self._projected_sequence

    async def _project_pending(self) -> None:
        while self._pending_observations:
            count = 1
            first = self._pending_observations[0]
            if self._on_observations is not None and isinstance(first, RuntimeEvent):
                if first.kind is RuntimeEventKind.TOOL_PROGRESS:
                    while count < len(self._pending_observations):
                        next_event = self._pending_observations[count]
                        if (
                            not isinstance(next_event, RuntimeEvent)
                            or next_event.kind is not first.kind
                        ):
                            break
                        count += 1
            batch = tuple(self._pending_observations[:count])
            try:
                if self._on_observations is None:
                    await self._on_observation(first)
                else:
                    await self._on_observations(batch)
            except Exception:
                self._projection_failed = True
                raise
            for observation in batch:
                if isinstance(observation, RuntimeEvent):
                    self._reduce(observation)
                    async with self._projection_changed:
                        self._projected_sequence = observation.sequence
                        self._projection_changed.notify_all()
            del self._pending_observations[:count]

    async def submit(self, request: TurnRequest) -> RuntimeTurnResult:
        if self._closed:
            raise RuntimeDriverError("runtime event consumer is closed")
        if self._replacement_ticket is not None:
            raise RuntimeDriverError(RUNTIME_THREAD_REPLACEMENT_BUSY)
        if request.command_id in self._terminals:
            raise RuntimeDriverError("runtime command id is already active")
        future = asyncio.get_running_loop().create_future()
        self._terminals[request.command_id] = future
        accepted = asyncio.Event()
        attempts = request.submission_attempts

        async def authorize_retry(proof: SubmissionRetryProof) -> Callable[[], bool]:
            nonlocal attempts
            submission = proof.submission
            if (
                proof.binding != self._session.binding
                or proof.command_id != request.command_id
                or not proof.call_id
                or type(submission.attempts) is not int
                or submission.attempts <= attempts
                or not 0 < submission.failed_generation <= submission.process_generation
                or not math.isfinite(submission.deadline)
                or submission.deadline <= asyncio.get_running_loop().time()
                or proof.watermark < 0
                or request.submission_deadline is not None
                and submission.deadline > request.submission_deadline
            ):
                raise RuntimeDriverError("invalid unsubmitted retry proof")
            async with asyncio.timeout_at(submission.deadline):
                await accepted.wait()
                await self._wait_projection(proof.watermark)
                if (
                    future.done()
                    or self._closed
                    or self._calls.get(request.command_id) != proof.call_id
                    or request.command_id in self._started_commands
                    or submission.attempts <= attempts
                ):
                    raise RuntimeDriverError(
                        "unsubmitted retry proof does not own the current call"
                    )
                attempts = submission.attempts

                def product_current() -> bool:
                    return True

                if request.retry_authorizer is not None:
                    product_current = await request.retry_authorizer(proof)

                def current() -> bool:
                    return (
                        not future.done()
                        and not self._closed
                        and attempts == submission.attempts
                        and self._calls.get(request.command_id) == proof.call_id
                        and request.command_id not in self._started_commands
                        and product_current()
                    )

                return current

        try:
            receipt = await self._session.submit(replace(request, retry_authorizer=authorize_retry))
            if receipt.state is not CommandState.ACCEPTED:
                raise RuntimeCommandError(receipt)
            self._calls[request.command_id] = receipt.correlation_id
            accepted.set()
            early_proof = self._proofs.pop(request.command_id, None)
            if early_proof is not None:
                self._resolve_proof(early_proof)
            try:
                return await future
            except RuntimeTurnNotSubmittedError as error:
                error.request = request
                raise
        finally:
            accepted.set()
            if not future.done():
                future.cancel()
            self._terminals.pop(request.command_id, None)
            self._final_text.pop(request.command_id, None)
            self._usage.pop(request.command_id, None)
            self._calls.pop(request.command_id, None)
            self._proofs.pop(request.command_id, None)
            self._started_commands.discard(request.command_id)
            async with self._projection_changed:
                self._projection_changed.notify_all()

    async def close(self) -> None:
        self._closed = True
        async with self._projection_changed:
            self._projection_changed.notify_all()
        consumer = self._consumer
        self._consumer = None
        consumer_error: Exception | None = None
        if consumer is not None:
            consumer.cancel()
            try:
                await consumer
            except (asyncio.CancelledError, RuntimeDriverError):
                pass
            except Exception as error:
                consumer_error = error
        for future in self._terminals.values():
            if not future.done():
                future.set_exception(RuntimeDriverError("runtime session detached"))
        try:
            await self._session.detach()
        except Exception as error:
            if consumer_error is None:
                raise
            logger.error(
                "runtime_session_detach_failed runtime_id=%s session_id=%s error_type=%s",
                self._session.binding.runtime_id,
                self._session.binding.product_session_id,
                type(error).__name__,
            )
            raise ExceptionGroup("runtime session close failed", [consumer_error, error]) from None
        if consumer_error is not None:
            raise consumer_error

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

    async def _wait_projection(self, watermark: int) -> None:
        async with self._projection_changed:
            await self._projection_changed.wait_for(
                lambda: self._projected_sequence >= watermark
                or self._consumer_error is not None
                or self._closed
            )
            if self._consumer_error is not None or self._closed or self._consumer is None:
                raise RuntimeDriverError("runtime projection did not complete")

    async def drain_observations(self) -> int:
        if self._closed or self._consumer is None:
            raise RuntimeDriverError("runtime event consumer is unavailable")
        snapshot = await self._session.activity()
        await self._wait_projection(snapshot.watermark)
        return self._projected_sequence

    async def confirm_turn(self, target: TurnConfirmationTarget) -> TurnConfirmationReceipt:
        session = self._session
        supported = any(
            entry.name == RuntimeCapabilityName.TURN_CONFIRMATION.value
            and entry.state is CapabilityState.SUPPORTED
            for entry in session.capabilities.entries
        )
        if not supported or not isinstance(session, RuntimeTurnConfirmation):
            raise RuntimeDriverError(RUNTIME_CONFIRMATION_UNSUPPORTED)
        if self._closed or self._consumer is None or self._terminals or self._suspend_ticket:
            raise RuntimeDriverError("runtime driver is not idle")
        ticket = await session.prepare_turn_confirmation(target)
        if ticket.target != target or ticket.watermark < 0:
            raise RuntimeDriverError("runtime confirmation target mismatch")
        await self._wait_projection(ticket.watermark)
        receipt = await session.commit_turn_confirmation(ticket, self._projected_sequence)
        if receipt.ticket != ticket:
            raise RuntimeDriverError("runtime confirmation receipt mismatch")
        if receipt.state is CommandState.APPLIED:
            await self._wait_projection(ticket.watermark)
        return receipt

    def _thread_replacement_session(
        self, *, allow_pending: bool = False
    ) -> RuntimeThreadReplacement:
        session = self._session
        supported = any(
            entry.name == RuntimeCapabilityName.THREAD_REPLACEMENT.value
            and entry.state is CapabilityState.SUPPORTED
            for entry in session.capabilities.entries
        )
        if not supported or not isinstance(session, RuntimeThreadReplacement):
            raise RuntimeDriverError(RUNTIME_THREAD_REPLACEMENT_UNSUPPORTED)
        if self._closed or self._consumer is None or self._consumer_error is not None:
            raise RuntimeDriverError(RUNTIME_THREAD_REPLACEMENT_STALE)
        if (self._terminals and not allow_pending) or self._suspend_ticket:
            raise RuntimeDriverError(RUNTIME_THREAD_REPLACEMENT_BUSY)
        return session

    def _thread_replacement_target(
        self, ticket: ThreadReplacementTicket
    ) -> ThreadReplacementTarget:
        if not isinstance(ticket, ThreadReplacementTicket) or not isinstance(
            ticket.proof, ThreadReplacementProof
        ):
            raise RuntimeDriverError(RUNTIME_THREAD_REPLACEMENT_STALE)
        proof = ticket.proof
        if (
            proof.binding != self._session.binding
            or not all(
                isinstance(value, str) and value.strip()
                for value in (
                    ticket.generation,
                    proof.proof_id,
                    proof.command_id,
                    proof.incident_id,
                )
            )
            or not all(
                type(value) is int and value >= 0
                for value in (ticket.revision, ticket.watermark, proof.watermark)
            )
            or type(proof.failed_generation) is not int
            or type(proof.absence_generation) is not int
            or not 0 < proof.failed_generation < proof.absence_generation
            or proof.watermark != ticket.watermark
        ):
            raise RuntimeDriverError(RUNTIME_THREAD_REPLACEMENT_STALE)
        return ThreadReplacementTarget(
            proof.binding, proof.command_id, proof.incident_id, proof.failed_generation
        )

    async def prepare_thread_replacement(
        self, target: ThreadReplacementTarget
    ) -> ThreadReplacementTicket:
        async with self._replacement_lock:
            self._thread_replacement_session(allow_pending=True)
            if (
                not isinstance(target, ThreadReplacementTarget)
                or target.binding != self._session.binding
                or not all(
                    isinstance(value, str) and value.strip()
                    for value in (target.command_id, target.incident_id)
                )
                or type(target.failed_generation) is not int
                or target.failed_generation <= 0
            ):
                raise RuntimeDriverError(RUNTIME_THREAD_REPLACEMENT_STALE)
            async with self._projection_changed:
                await self._projection_changed.wait_for(
                    lambda: not self._terminals or self._consumer_error is not None or self._closed
                )
            session = self._thread_replacement_session()
            ticket = self._replacement_ticket
            if ticket is None:
                ticket = await session.prepare_thread_replacement(target)
            if self._thread_replacement_target(ticket) != target:
                raise RuntimeDriverError(RUNTIME_THREAD_REPLACEMENT_STALE)
            await self._wait_projection(ticket.watermark)
            self._thread_replacement_session()
            self._replacement_ticket = ticket
            return ticket

    async def commit_thread_replacement(
        self, ticket: ThreadReplacementTicket
    ) -> ThreadReplacementReceipt:
        async with self._replacement_lock:
            session = self._thread_replacement_session()
            self._thread_replacement_target(ticket)
            if self._replacement_ticket != ticket:
                raise RuntimeDriverError(RUNTIME_THREAD_REPLACEMENT_STALE)
            await self._wait_projection(ticket.watermark)
            self._thread_replacement_session()
            if self._replacement_receipt is not None:
                return self._replacement_receipt
            receipt = await session.commit_thread_replacement(ticket, self._projected_sequence)
            if not isinstance(receipt, ThreadReplacementReceipt) or receipt.ticket != ticket:
                raise RuntimeDriverError("runtime thread replacement receipt mismatch")
            if receipt.state is CommandState.APPLIED:
                await self._wait_projection(ticket.watermark)
                self._replacement_receipt = receipt
            return receipt

    async def _consume(self) -> None:
        observations = aiter(self._session.events())
        pending: asyncio.Task[RuntimeObservation] | None = None

        async def next_observation() -> RuntimeObservation:
            return await anext(observations)

        try:
            while True:
                batch: list[RuntimeObservation] = []
                ended = False
                if pending is None:
                    pending = asyncio.create_task(next_observation())
                try:
                    batch.append(await pending)
                except StopAsyncIteration:
                    ended = True
                pending = None
                if self._on_observations is not None:
                    while batch and len(batch) < OBSERVATION_BATCH_LIMIT:
                        pending = asyncio.create_task(next_observation())
                        # Collect only available observations; never wait to fill a batch.
                        await asyncio.sleep(0)
                        if not pending.done():
                            break
                        try:
                            batch.append(pending.result())
                        except StopAsyncIteration:
                            ended = True
                            pending = None
                            break
                        pending = None
                for observation in batch:
                    self._validate(observation)
                if batch:
                    self._pending_observations.extend(batch)
                    await self._project_pending()
                if ended:
                    raise RuntimeDriverError("runtime event stream ended before detach")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._closed = True
            logger.error(
                "runtime_observation_consumer_failed runtime_id=%s session_id=%s "
                "last_sequence=%s projected_sequence=%s error_type=%s",
                self._session.binding.runtime_id,
                self._session.binding.product_session_id,
                self._last_sequence,
                self._projected_sequence,
                type(error).__name__,
            )
            async with self._projection_changed:
                self._consumer_error = error
                self._projection_changed.notify_all()
            for future in self._terminals.values():
                if not future.done():
                    future.set_exception(error)
            raise
        finally:
            if pending is not None:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                if self._projection_failed and not pending.cancelled():
                    try:
                        observation = pending.result()
                    except StopAsyncIteration:
                        pass
                    except Exception:
                        self._projection_failed = False
                    else:
                        try:
                            self._validate(observation)
                        except Exception:
                            self._projection_failed = False
                        else:
                            self._pending_observations.append(observation)
            if isinstance(observations, AsyncGenerator):
                await observations.aclose()

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
        self._observe_execution(observation)

    def _observe_execution(self, observation: RuntimeObservation) -> None:
        if (
            isinstance(observation, RuntimeEvent)
            and not observation.native_turn_id
            and not observation.native_item_id
            and observation.kind in PASSIVE_OBSERVATION_KINDS
        ):
            return
        self._execution_observed = True
        if not isinstance(observation, RuntimeEvent) or not observation.correlation_id:
            self._started_commands.update(self._terminals)
        elif observation.correlation_id in self._terminals:
            self._started_commands.add(observation.correlation_id)

    def _resolve_proof(self, event: RuntimeEvent) -> None:
        command_id = event.correlation_id
        future = self._terminals.get(command_id)
        if future is None or future.done():
            return
        proof = EmptyThreadReplacementProof.from_event(event, self._session.binding)
        if (
            self._execution_observed
            or command_id in self._started_commands
            or self._calls.get(command_id) != proof.call_id
        ):
            raise RuntimeDriverError("replacement proof does not own the current unsubmitted call")
        future.set_exception(RuntimeTurnNotSubmittedError(proof))

    def _reduce(self, event: RuntimeEvent) -> None:
        command_id = event.correlation_id
        self._observe_execution(event)
        if event.kind is RuntimeEventKind.TURN_NOT_SUBMITTED:
            if command_id in self._terminals:
                if command_id in self._calls:
                    self._resolve_proof(event)
                else:
                    self._proofs[command_id] = event
            return
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
