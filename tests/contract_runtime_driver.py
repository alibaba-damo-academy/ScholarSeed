"""Contract tests for Serve's command/event Runtime Gateway driver."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import replace
from unittest.mock import patch

from scholarseed_runtime.contract import (
    CapabilitySet,
    CapabilityState,
    CommandReceipt,
    CommandState,
    DeliveryClass,
    RuntimeBinding,
    RuntimeCapability,
    RuntimeCapabilityName,
    RuntimeEvent,
    RuntimeEventKind,
    TurnRequest,
)
from scholarseed_runtime.contract.command import ThreadReplacementProof
from scholarseed_runtime.contract.session import (
    RUNTIME_CONFIRMATION_UNSUPPORTED,
    RUNTIME_THREAD_REPLACEMENT_BUSY,
    RUNTIME_THREAD_REPLACEMENT_UNSUPPORTED,
    RuntimeActivitySnapshot,
    RuntimeThreadReplacement,
    RuntimeTurnConfirmation,
    ThreadReplacementReceipt,
    ThreadReplacementTarget,
    ThreadReplacementTicket,
    TurnConfirmationReceipt,
    TurnConfirmationTarget,
    TurnConfirmationTicket,
)
from scholarseed_runtime.gateway.driver import RuntimeDriver, RuntimeDriverError, RuntimeTurnOutcome

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


class ContractSession:
    def __init__(
        self, *, auto_complete: bool = True, detach_error: Exception | None = None
    ) -> None:
        self.binding = RuntimeBinding(
            product_session_id="product-1",
            runtime_id="contract",
            adapter_version="1",
            runtime_version="1",
            protocol_version="1",
            protocol_schema_hash="schema",
            opaque_session_ref="native-1",
            capabilities=CapabilitySet(),
        )
        self.capabilities = CapabilitySet()
        self.queue: asyncio.Queue[RuntimeEvent] = asyncio.Queue()
        self.detached = False
        self.auto_complete = auto_complete
        self.detach_error = detach_error

    async def events(self) -> AsyncIterator[RuntimeEvent]:
        while True:
            yield await self.queue.get()

    async def submit(self, request: TurnRequest) -> CommandReceipt:
        if self.auto_complete:
            asyncio.create_task(self._complete(request.command_id))
        return CommandReceipt(request.command_id, CommandState.ACCEPTED)

    async def _complete(self, command_id: str) -> None:
        await self.queue.put(self.event(1, RuntimeEventKind.TURN_STARTED, command_id))
        await self.queue.put(
            self.event(
                2,
                RuntimeEventKind.CONTENT_COMPLETED,
                command_id,
                payload={"role": "assistant", "text": "driver-ok"},
            )
        )
        await self.queue.put(
            self.event(
                3,
                RuntimeEventKind.USAGE_UPDATED,
                command_id,
                payload={"input_tokens": 11, "output_tokens": 3},
            )
        )
        await self.queue.put(self.event(4, RuntimeEventKind.TURN_COMPLETED, command_id))

    def event(
        self,
        sequence: int,
        kind: RuntimeEventKind,
        correlation_id: str,
        *,
        payload: dict | None = None,
    ) -> RuntimeEvent:
        return RuntimeEvent(
            schema_version=1,
            event_id=f"event-{sequence}",
            runtime_id=self.binding.runtime_id,
            product_session_id=self.binding.product_session_id,
            native_session_id=self.binding.opaque_session_ref,
            process_generation=1,
            sequence=sequence,
            kind=kind,
            delivery=DeliveryClass.MUST_PERSIST,
            observed_at="2026-09-04T00:00:00Z",
            native_turn_id="turn-1",
            correlation_id=correlation_id,
            payload=payload or {},
        )

    async def detach(self) -> None:
        self.detached = True
        if self.detach_error is not None:
            raise self.detach_error


class ConfirmationSession(ContractSession):
    def __init__(self, *, watermark: int = 0) -> None:
        super().__init__(auto_complete=False)
        self.capabilities = CapabilitySet(
            (
                RuntimeCapability(
                    RuntimeCapabilityName.TURN_CONFIRMATION.value, CapabilityState.SUPPORTED
                ),
            )
        )
        self.binding = replace(self.binding, capabilities=self.capabilities)
        self.target = TurnConfirmationTarget("product-1", "native-1", "client-1", "incident-1", 1)
        self.ticket = TurnConfirmationTicket("ticket-1", self.target, "host-1:2", 3, watermark)
        self.receipt = TurnConfirmationReceipt(self.ticket, CommandState.APPLIED)
        self.prepared = asyncio.Event()
        self.commits: list[tuple[TurnConfirmationTicket, int]] = []

    async def activity(self) -> RuntimeActivitySnapshot:
        return RuntimeActivitySnapshot("host-1:2", 3, self.ticket.watermark, True)

    async def prepare_turn_confirmation(
        self, target: TurnConfirmationTarget
    ) -> TurnConfirmationTicket:
        if target != self.target:
            raise AssertionError("confirmation target was changed before preparation")
        self.prepared.set()
        return self.ticket

    async def commit_turn_confirmation(
        self, ticket: TurnConfirmationTicket, persisted_watermark: int
    ) -> TurnConfirmationReceipt:
        self.commits.append((ticket, persisted_watermark))
        return self.receipt

    async def submit(self, request: TurnRequest) -> CommandReceipt:
        raise AssertionError("confirmation must not replay a turn")


class ReplacementSession(ContractSession):
    def __init__(self, *, watermark: int = 0, allow_submission: bool = False) -> None:
        super().__init__(auto_complete=False)
        self.capabilities = CapabilitySet(
            (
                RuntimeCapability(
                    RuntimeCapabilityName.THREAD_REPLACEMENT.value, CapabilityState.SUPPORTED
                ),
            )
        )
        self.binding = replace(self.binding, capabilities=self.capabilities)
        self.target = ThreadReplacementTarget(self.binding, "client-1", "incident-1", 1)
        self.proof = ThreadReplacementProof(
            "proof-1", self.binding, "client-1", "incident-1", 1, 2, watermark
        )
        self.ticket = ThreadReplacementTicket(self.proof, "host-1:2", 3, watermark)
        self.receipt = ThreadReplacementReceipt(self.ticket, CommandState.APPLIED)
        self.prepared = asyncio.Event()
        self.submitted = asyncio.Event()
        self.allow_submission = allow_submission
        self.preparations = 0
        self.commits: list[tuple[ThreadReplacementTicket, int]] = []

    async def prepare_thread_replacement(
        self, target: ThreadReplacementTarget
    ) -> ThreadReplacementTicket:
        if target != self.target:
            raise AssertionError("replacement target changed before preparation")
        self.preparations += 1
        self.prepared.set()
        return self.ticket

    async def commit_thread_replacement(
        self, ticket: ThreadReplacementTicket, persisted_watermark: int
    ) -> ThreadReplacementReceipt:
        self.commits.append((ticket, persisted_watermark))
        return self.receipt

    async def submit(self, request: TurnRequest) -> CommandReceipt:
        if self.allow_submission:
            self.submitted.set()
            return await super().submit(request)
        raise AssertionError("thread replacement must not replay a turn")


async def successful_turn() -> tuple:
    session = ContractSession()
    observed = []

    async def observe(event) -> None:
        observed.append(event)

    driver = RuntimeDriver(session, observe)
    driver.start()
    result = await driver.submit(TurnRequest("command-1", ("hello",)))
    await driver.close()
    return result, tuple(observed), session.detached


async def mismatched_binding() -> bool:
    session = ContractSession(auto_complete=False)

    async def observe(_event) -> None:
        return None

    driver = RuntimeDriver(session, observe)
    driver.start()
    task = asyncio.create_task(driver.submit(TurnRequest("command-2", ("hello",))))
    bad = replace(
        session.event(1, RuntimeEventKind.TURN_STARTED, "command-2"),
        product_session_id="other-product",
    )
    await session.queue.put(bad)
    try:
        await task
    except RuntimeDriverError:
        failed = not driver.projection_failed
        try:
            await driver.recover_projection()
        except RuntimeDriverError:
            pass
        else:
            failed = False
    else:
        failed = False
    await driver.close()
    return failed


async def submission_failure_releases_command() -> bool:
    class FailingOnceSession(ContractSession):
        failed = False

        async def submit(self, request):
            if not self.failed:
                self.failed = True
                raise RuntimeError("submission failed before admission")
            return await super().submit(request)

    session = FailingOnceSession()

    async def observe(_event):
        return None

    driver = RuntimeDriver(session, observe)
    driver.start()
    request = TurnRequest("retry-command", ("hello",))
    try:
        await driver.submit(request)
    except RuntimeError as error:
        if str(error) != "submission failed before admission":
            raise
    else:
        raise AssertionError("submission error must reach the caller")
    try:
        result = await driver.submit(request)
        return result.outcome is RuntimeTurnOutcome.COMPLETED
    finally:
        await driver.close()


async def batched_projection() -> bool:
    session = ContractSession(auto_complete=False)
    batches = []
    durable = asyncio.Event()

    async def observe(_event):
        raise AssertionError("batch handler must own projection")

    async def observe_batch(events):
        batches.append(events)
        if any(event.kind is RuntimeEventKind.TURN_COMPLETED for event in events):
            await durable.wait()

    driver = RuntimeDriver(session, observe, on_observations=observe_batch)
    for sequence in range(1, 132):
        session.queue.put_nowait(session.event(sequence, RuntimeEventKind.TOOL_PROGRESS, "batch"))
    session.queue.put_nowait(session.event(132, RuntimeEventKind.TURN_COMPLETED, "batch"))
    driver.start()
    task = asyncio.create_task(driver.submit(TurnRequest("batch", ("hello",))))
    while not any(
        event.kind is RuntimeEventKind.TURN_COMPLETED for batch in batches for event in batch
    ):
        await asyncio.sleep(0)
    held = not task.done()
    durable.set()
    result = await task
    await driver.close()
    return (
        held
        and result.outcome is RuntimeTurnOutcome.COMPLETED
        and [event.sequence for batch in batches for event in batch] == list(range(1, 133))
        and max(map(len, batches)) <= 64
        and len(batches) < 10
    )


async def failed_projection_is_visible_and_closed() -> bool:
    session = ContractSession(auto_complete=False)
    observed_error = RuntimeError("secret-projection-payload")

    async def observe(_event):
        raise observed_error

    driver = RuntimeDriver(session, observe)
    session.queue.put_nowait(session.event(1, RuntimeEventKind.TURN_UNKNOWN, "command-1"))
    with patch("scholarseed_runtime.gateway.driver.logger") as logger:
        driver.start()
        try:
            await driver._consumer
        except RuntimeError as error:
            if error is not observed_error:
                return False
        else:
            return False
        rejected = False
        try:
            await driver.submit(TurnRequest("command-2", ("hello",)))
        except RuntimeDriverError:
            rejected = True
        logged = logger.error.call_args
        result = (
            driver._consumer_error is observed_error
            and driver._projected_sequence == 0
            and rejected
            and logger.error.call_count == 1
            and logged.args[-1] == "RuntimeError"
            and "secret-projection-payload" not in str(logged)
        )
    try:
        await driver.close()
    except RuntimeError as error:
        return result and error is observed_error and session.detached
    return False


async def failed_projection_still_detaches(*, detach_failure: bool = False) -> bool:
    projection_error = ValueError("invalid runtime incident observation")
    detach_error = OSError("runtime detach failed") if detach_failure else None
    session = ContractSession(auto_complete=False, detach_error=detach_error)

    async def observe(_event):
        raise projection_error

    driver = RuntimeDriver(session, observe)
    with patch("scholarseed_runtime.gateway.driver.logger") as logger:
        driver.start()
        submission = asyncio.create_task(driver.submit(TurnRequest("command-1", ("hello",))))
        await asyncio.sleep(0)
        await session.queue.put(session.event(1, RuntimeEventKind.TURN_UNKNOWN, "command-1"))
        results = await asyncio.gather(submission, driver._consumer, return_exceptions=True)
        try:
            await driver.close()
        except Exception as error:
            return (
                (
                    isinstance(error, ExceptionGroup)
                    and error.exceptions == (projection_error, detach_error)
                    if detach_failure
                    else error is projection_error
                )
                and session.detached
                and all(result is projection_error for result in results)
                and driver._consumer_error is projection_error
                and not driver._terminals
                and (
                    not detach_failure
                    or (
                        projection_error.__cause__ is None
                        and projection_error.__context__ is None
                        and str(error) == "runtime session close failed (2 sub-exceptions)"
                        and logger.error.call_count == 2
                        and logger.error.call_args.args[-1] == "OSError"
                        and "runtime detach failed" not in str(logger.error.call_args)
                    )
                )
            )
        return False


async def failed_projection_preserves_exception_chain(*, explicit_cause: bool) -> bool:
    original_error = LookupError("secret-consumer-source")
    projection_error = ValueError("secret-runtime-projection")
    detach_error = OSError("secret-runtime-detach")
    session = ContractSession(auto_complete=False, detach_error=detach_error)

    async def observe(_event):
        try:
            raise original_error
        except LookupError:
            if explicit_cause:
                raise projection_error from original_error
            raise projection_error

    driver = RuntimeDriver(session, observe)
    session.queue.put_nowait(session.event(1, RuntimeEventKind.TURN_UNKNOWN, "command-1"))
    with patch("scholarseed_runtime.gateway.driver.logger") as logger:
        driver.start()
        results = await asyncio.gather(driver._consumer, return_exceptions=True)
        try:
            await driver.close()
        except ExceptionGroup as error:
            return (
                results[0] is projection_error
                and error.exceptions == (projection_error, detach_error)
                and projection_error.__cause__ is (original_error if explicit_cause else None)
                and projection_error.__context__ is original_error
                and projection_error.__suppress_context__ is explicit_cause
                and session.detached
                and logger.error.call_count == 2
                and logger.error.call_args.args[-1] == "OSError"
                and "secret-" not in str(logger.error.call_args)
            )
    return False


async def detachment_failure_is_visible() -> bool:
    detach_error = OSError("runtime detach failed")
    session = ContractSession(auto_complete=False, detach_error=detach_error)

    async def observe(_event):
        return None

    driver = RuntimeDriver(session, observe)
    driver.start()
    submission = asyncio.create_task(driver.submit(TurnRequest("command-1", ("hello",))))
    await asyncio.sleep(0)
    try:
        await driver.close()
    except OSError as error:
        results = await asyncio.gather(submission, return_exceptions=True)
        return (
            error is detach_error
            and session.detached
            and isinstance(results[0], RuntimeDriverError)
            and not driver._terminals
        )
    return False


async def projection_recovery_preserves_failed_and_prefetched_events(*, batched: bool) -> bool:
    session = ContractSession(auto_complete=False)
    observed = []
    fail = True

    async def observe(event):
        if fail and event.sequence == 2:
            raise OSError("projection unavailable")
        observed.append(event.sequence)

    async def observe_batch(events):
        for event in events:
            await observe(event)

    driver = RuntimeDriver(session, observe, on_observations=observe_batch if batched else None)
    for sequence in range(1, 5):
        session.queue.put_nowait(session.event(sequence, RuntimeEventKind.TOOL_STARTED, "old"))
    driver.start()
    try:
        await driver._consumer
    except OSError:
        pass
    if not driver.projection_failed or observed != [1]:
        return False
    try:
        await driver.recover_projection()
    except OSError:
        if not driver.projection_failed or observed != [1]:
            return False
    else:
        return False
    fail = False
    await driver.recover_projection()
    async with asyncio.timeout(2):
        while driver._projected_sequence < 4:
            await asyncio.sleep(0)
    result = observed == [1, 2, 3, 4] and not driver.projection_failed
    await driver.close()
    return result


async def confirmation_waits_for_durable_projection() -> bool:
    session = ConfirmationSession(watermark=1)
    durable = asyncio.Event()
    projecting = asyncio.Event()
    observed = []

    async def observe(event):
        projecting.set()
        await durable.wait()
        observed.append(event)

    driver = RuntimeDriver(session, observe)
    driver.start()
    confirmation = asyncio.create_task(driver.confirm_turn(session.target))
    drain = asyncio.create_task(driver.drain_observations())
    try:
        await session.prepared.wait()
        unknown = session.event(1, RuntimeEventKind.TURN_UNKNOWN, "client-1")
        await session.queue.put(unknown)
        await projecting.wait()
        await asyncio.sleep(0)
        held = (
            not confirmation.done()
            and not drain.done()
            and not session.commits
            and driver._projected_sequence == 0
        )
        durable.set()
        receipt, watermark = await asyncio.gather(confirmation, drain)
        return (
            held
            and isinstance(session, RuntimeTurnConfirmation)
            and receipt.state is CommandState.APPLIED
            and session.commits == [(session.ticket, 1)]
            and watermark == 1
            and observed == [unknown]
            and not driver._terminals
            and not driver._final_text
            and session.queue.empty()
        )
    finally:
        durable.set()
        await driver.close()
        await asyncio.gather(confirmation, drain, return_exceptions=True)


async def confirmation_rejects_failed_consumer() -> bool:
    session = ConfirmationSession(watermark=1)
    projecting = asyncio.Event()
    failed = asyncio.Event()
    projection_error = RuntimeError("private confirmation projection failure")

    async def observe(_event):
        projecting.set()
        await failed.wait()
        raise projection_error

    driver = RuntimeDriver(session, observe)
    driver.start()
    confirmation = asyncio.create_task(driver.confirm_turn(session.target))
    drain = asyncio.create_task(driver.drain_observations())
    await session.prepared.wait()
    await session.queue.put(session.event(1, RuntimeEventKind.TURN_UNKNOWN, "client-1"))
    await projecting.wait()
    with patch("scholarseed_runtime.gateway.driver.logger"):
        failed.set()
        results = await asyncio.gather(
            confirmation, drain, driver._consumer, return_exceptions=True
        )
    rejected = (
        all(isinstance(result, RuntimeDriverError) for result in results[:2])
        and results[2] is projection_error
        and not session.commits
        and driver._projected_sequence == 0
    )
    for operation in (driver.confirm_turn(session.target), driver.drain_observations()):
        try:
            await operation
        except RuntimeDriverError:
            pass
        else:
            rejected = False
    try:
        await driver.close()
    except RuntimeError as error:
        return rejected and error is projection_error and session.detached and not session.commits
    return False


async def confirmation_requires_capability_and_protocol() -> bool:
    unsupported = ConfirmationSession()
    unsupported.capabilities = CapabilitySet()
    degraded = ConfirmationSession()
    degraded.capabilities = CapabilitySet(
        (
            RuntimeCapability(
                RuntimeCapabilityName.TURN_CONFIRMATION.value, CapabilityState.DEGRADED
            ),
        )
    )
    missing_protocol = ContractSession(auto_complete=False)
    missing_protocol.capabilities = ConfirmationSession().capabilities
    for session in (unsupported, degraded, missing_protocol):

        async def observe(_event):
            raise AssertionError("unsupported confirmation must not emit an event")

        driver = RuntimeDriver(session, observe)
        try:
            await driver.confirm_turn(unsupported.target)
        except RuntimeDriverError as error:
            if str(error) != RUNTIME_CONFIRMATION_UNSUPPORTED:
                return False
        else:
            return False
        finally:
            await driver.close()
    return not unsupported.prepared.is_set() and not degraded.prepared.is_set()


async def confirmation_rejects_mismatched_target_and_receipt() -> bool:
    for mismatch in ("target", "watermark", "receipt"):
        session = ConfirmationSession()
        if mismatch == "target":
            session.ticket = replace(
                session.ticket, target=replace(session.target, incident_id="another-incident")
            )
        elif mismatch == "watermark":
            session.ticket = replace(session.ticket, watermark=-1)
        else:
            session.receipt = replace(
                session.receipt, ticket=replace(session.ticket, ticket_id="another-ticket")
            )

        async def observe(_event):
            raise AssertionError("mismatched confirmation must not emit an event")

        driver = RuntimeDriver(session, observe)
        driver.start()
        try:
            await driver.confirm_turn(session.target)
        except RuntimeDriverError:
            if len(session.commits) != int(mismatch == "receipt"):
                return False
        else:
            return False
        finally:
            await driver.close()
    return True


async def replacement_waits_for_projection_and_explicit_commit() -> bool:
    session = ReplacementSession(watermark=1)
    durable = asyncio.Event()
    projecting = asyncio.Event()
    observed = []

    async def observe(event):
        projecting.set()
        await durable.wait()
        observed.append(event)

    driver = RuntimeDriver(session, observe)
    driver.start()
    preparation = asyncio.create_task(driver.prepare_thread_replacement(session.target))
    try:
        await session.prepared.wait()
        unknown = session.event(1, RuntimeEventKind.TURN_UNKNOWN, "client-1")
        await session.queue.put(unknown)
        await projecting.wait()
        await asyncio.sleep(0)
        held = not preparation.done() and not session.commits
        durable.set()
        ticket = await preparation
        separate = not session.commits and driver._projected_sequence == 1
        same_ticket = await driver.prepare_thread_replacement(session.target)
        submission_blocked = False
        try:
            await driver.submit(TurnRequest("another-command", ("hello",)))
        except RuntimeDriverError as error:
            submission_blocked = str(error) == RUNTIME_THREAD_REPLACEMENT_BUSY
        except AssertionError:
            pass
        receipt = await driver.commit_thread_replacement(ticket)
        same_receipt = await driver.commit_thread_replacement(ticket)
        return (
            held
            and separate
            and submission_blocked
            and isinstance(session, RuntimeThreadReplacement)
            and ticket is same_ticket
            and session.preparations == 1
            and receipt is same_receipt
            and receipt.state is CommandState.APPLIED
            and session.commits == [(ticket, 1)]
            and observed == [unknown]
            and not driver._terminals
            and not driver._proofs
        )
    finally:
        durable.set()
        await driver.close()
        await asyncio.gather(preparation, return_exceptions=True)


async def replacement_requires_supported_capability_and_protocol() -> bool:
    unsupported = ReplacementSession()
    unsupported.capabilities = CapabilitySet()
    degraded = ReplacementSession()
    degraded.capabilities = CapabilitySet(
        (
            RuntimeCapability(
                RuntimeCapabilityName.THREAD_REPLACEMENT.value, CapabilityState.DEGRADED
            ),
        )
    )
    missing_protocol = ContractSession(auto_complete=False)
    missing_protocol.capabilities = ReplacementSession().capabilities
    for session in (unsupported, degraded, missing_protocol):

        async def observe(_event):
            raise AssertionError("unsupported replacement must not emit events")

        driver = RuntimeDriver(session, observe)
        try:
            await driver.prepare_thread_replacement(unsupported.target)
        except RuntimeDriverError as error:
            if str(error) != RUNTIME_THREAD_REPLACEMENT_UNSUPPORTED:
                return False
        else:
            return False
        finally:
            await driver.close()
    return not unsupported.prepared.is_set() and not degraded.prepared.is_set()


async def replacement_rejects_invalid_targets_and_tickets() -> bool:
    mismatches = (
        "binding",
        "command",
        "incident",
        "failed_generation",
        "proof_id",
        "absence_generation",
        "watermark",
        "proof_watermark",
        "revision",
        "generation",
        "receipt",
        "unprepared",
    )
    for mismatch in mismatches:
        session = ReplacementSession()
        target = session.target
        if mismatch == "binding":
            target = replace(target, binding=replace(target.binding, opaque_session_ref="other"))
        elif mismatch == "command":
            session.ticket = replace(
                session.ticket, proof=replace(session.proof, command_id="other")
            )
        elif mismatch == "incident":
            session.ticket = replace(
                session.ticket, proof=replace(session.proof, incident_id="other")
            )
        elif mismatch == "failed_generation":
            session.ticket = replace(
                session.ticket, proof=replace(session.proof, failed_generation=0)
            )
        elif mismatch == "proof_id":
            session.ticket = replace(session.ticket, proof=replace(session.proof, proof_id=""))
        elif mismatch == "absence_generation":
            session.ticket = replace(
                session.ticket, proof=replace(session.proof, absence_generation=1)
            )
        elif mismatch == "watermark":
            session.ticket = replace(session.ticket, watermark=-1)
        elif mismatch == "proof_watermark":
            session.ticket = replace(session.ticket, proof=replace(session.proof, watermark=1))
        elif mismatch == "revision":
            session.ticket = replace(session.ticket, revision=-1)
        elif mismatch == "generation":
            session.ticket = replace(session.ticket, generation="")
        elif mismatch == "receipt":
            session.receipt = replace(session.receipt, ticket=replace(session.ticket, revision=4))

        async def observe(_event):
            raise AssertionError("invalid replacement must not emit events")

        driver = RuntimeDriver(session, observe)
        driver.start()
        try:
            if mismatch == "unprepared":
                await driver.commit_thread_replacement(session.ticket)
            else:
                ticket = await driver.prepare_thread_replacement(target)
                await driver.commit_thread_replacement(ticket)
        except RuntimeDriverError:
            if len(session.commits) != int(mismatch == "receipt"):
                return False
        else:
            return False
        finally:
            await driver.close()
    return True


async def replacement_rejects_failed_projection(*, after_preparation: bool = False) -> bool:
    session = ReplacementSession(watermark=0 if after_preparation else 1)
    projection_error = ValueError("invalid replacement projection")

    async def observe(_event):
        raise projection_error

    driver = RuntimeDriver(session, observe)
    driver.start()
    preparation = asyncio.create_task(driver.prepare_thread_replacement(session.target))
    await session.prepared.wait()
    if after_preparation:
        await preparation
    await session.queue.put(session.event(1, RuntimeEventKind.TURN_UNKNOWN, "client-1"))
    with patch("scholarseed_runtime.gateway.driver.logger"):
        results = await asyncio.gather(preparation, driver._consumer, return_exceptions=True)
    rejected = (after_preparation or isinstance(results[0], RuntimeDriverError)) and results[
        1
    ] is projection_error
    try:
        await driver.commit_thread_replacement(session.ticket)
    except RuntimeDriverError:
        pass
    else:
        rejected = False
    try:
        await driver.close()
    except ValueError as error:
        return rejected and error is projection_error and session.detached and not session.commits
    return False


async def replacement_preserves_pending_commands() -> bool:
    session = ReplacementSession(allow_submission=True)

    async def observe(_event):
        return None

    driver = RuntimeDriver(session, observe)
    driver.start()
    submission = asyncio.create_task(driver.submit(TurnRequest("client-1", ("hello",))))
    preparation = None
    try:
        await session.submitted.wait()
        try:
            async with asyncio.timeout(0):
                await driver.prepare_thread_replacement(session.target)
        except TimeoutError:
            held = (
                session.target.command_id in driver._terminals
                and not submission.done()
                and not session.prepared.is_set()
                and not session.commits
            )
        except RuntimeDriverError:
            return False
        else:
            return False
        preparation = asyncio.create_task(driver.prepare_thread_replacement(session.target))
        await asyncio.sleep(0)
        held = held and not preparation.done() and not session.prepared.is_set()
        await session.queue.put(session.event(1, RuntimeEventKind.TURN_UNKNOWN, "client-1"))
        result, ticket = await asyncio.gather(submission, preparation)
        return (
            held
            and result.outcome is RuntimeTurnOutcome.UNKNOWN
            and ticket == session.ticket
            and session.preparations == 1
            and not driver._terminals
            and not session.commits
        )
    finally:
        await driver.close()
        await asyncio.gather(
            submission, *([preparation] if preparation is not None else []), return_exceptions=True
        )


async def replacement_waits_for_unknown_reduction_with_batched_observations() -> bool:
    session = ReplacementSession(watermark=2, allow_submission=True)
    preparation = None
    held = False
    observed = []

    async def observe(_event):
        raise AssertionError("batch projection must use the batch handler")

    async def observe_batch(events):
        nonlocal preparation, held
        observed.extend(events)
        if preparation is not None:
            return
        preparation = asyncio.create_task(driver.prepare_thread_replacement(session.target))
        await asyncio.sleep(0)
        held = (
            session.target.command_id in driver._terminals
            and not preparation.done()
            and not session.prepared.is_set()
        )

    driver = RuntimeDriver(session, observe, on_observations=observe_batch)
    driver.start()
    submission = asyncio.create_task(driver.submit(TurnRequest("client-1", ("hello",))))
    try:
        await session.submitted.wait()
        session.queue.put_nowait(session.event(1, RuntimeEventKind.TURN_UNKNOWN, "client-1"))
        session.queue.put_nowait(
            replace(
                session.event(
                    2,
                    RuntimeEventKind.RUNTIME_INCIDENT,
                    "client-1",
                    payload={
                        "incident": {
                            "incident_id": "incident-1",
                            "scope": "thread",
                            "state": "failed",
                            "kind": "resume_failed",
                            "strategy": "auto_resume",
                            "retryability": "terminal",
                            "safe_error": "codex_thread_history_missing",
                            "process_generation": 2,
                        }
                    },
                ),
                process_generation=2,
                native_turn_id="",
            )
        )
        result = await submission
        if preparation is None:
            return False
        try:
            ticket = await preparation
        except RuntimeDriverError:
            return False
        return (
            held
            and result.outcome is RuntimeTurnOutcome.UNKNOWN
            and ticket == session.ticket
            and driver._projected_sequence == 2
            and [event.kind for event in observed]
            == [RuntimeEventKind.TURN_UNKNOWN, RuntimeEventKind.RUNTIME_INCIDENT]
            and session.preparations == 1
            and not session.commits
        )
    finally:
        await driver.close()
        await asyncio.gather(
            submission, *([preparation] if preparation is not None else []), return_exceptions=True
        )


def main() -> int:
    result, observed, detached = asyncio.run(successful_turn())
    check("receipt and terminal remain separate", len(observed) == 4)
    check("terminal resolves the matching command", result.command_id == "command-1")
    check("completed content becomes final text", result.final_text == "driver-ok")
    check("terminal outcome remains typed", result.outcome is RuntimeTurnOutcome.COMPLETED)
    check("usage follows the correlated command", result.input_tokens == 11)
    check("output usage follows the correlated command", result.output_tokens == 3)
    check("close detaches the runtime session", detached)
    check("binding mismatch fails the active turn", asyncio.run(mismatched_binding()))
    check(
        "failed submission releases command state for retry",
        asyncio.run(submission_failure_releases_command()),
    )
    check(
        "bounded batches keep FIFO and defer terminal until durable",
        asyncio.run(batched_projection()),
    )
    check(
        "projection failure logs safe metadata and rejects later submission",
        asyncio.run(failed_projection_is_visible_and_closed()),
    )
    check(
        "failed consumer still detaches and preserves the projection failure",
        asyncio.run(failed_projection_still_detaches()),
    )
    check(
        "consumer and detach failures both remain observable with their original identities",
        asyncio.run(failed_projection_still_detaches(detach_failure=True)),
    )
    check(
        "detach failure preserves an explicit projection cause without logging sensitive errors",
        asyncio.run(failed_projection_preserves_exception_chain(explicit_cause=True)),
    )
    check(
        "detach failure preserves implicit projection context without suppressing it",
        asyncio.run(failed_projection_preserves_exception_chain(explicit_cause=False)),
    )
    check(
        "detach failure remains visible after pending submissions settle",
        asyncio.run(detachment_failure_is_visible()),
    )
    check(
        "explicit projection recovery preserves FIFO without replaying committed events",
        all(
            asyncio.run(projection_recovery_preserves_failed_and_prefetched_events(batched=value))
            for value in (False, True)
        ),
    )
    check(
        "confirmation and drain wait for durable projection without replay or terminal fabrication",
        asyncio.run(confirmation_waits_for_durable_projection()),
    )
    check(
        "consumer failure rejects waiting and later confirmation without committing",
        asyncio.run(confirmation_rejects_failed_consumer()),
    )
    check(
        "confirmation requires supported capability and typed protocol",
        asyncio.run(confirmation_requires_capability_and_protocol()),
    )
    check(
        "confirmation rejects mismatched target, negative watermark and mismatched receipt",
        asyncio.run(confirmation_rejects_mismatched_target_and_receipt()),
    )
    check(
        "thread replacement waits for projection and explicit commit without replay",
        asyncio.run(replacement_waits_for_projection_and_explicit_commit()),
    )
    check(
        "thread replacement requires supported capability and typed protocol",
        asyncio.run(replacement_requires_supported_capability_and_protocol()),
    )
    check(
        "thread replacement rejects stale targets, tickets and receipts",
        asyncio.run(replacement_rejects_invalid_targets_and_tickets()),
    )
    check(
        "thread replacement fails closed when projection fails",
        asyncio.run(replacement_rejects_failed_projection()),
    )
    check(
        "thread replacement commit rejects a consumer failure after preparation",
        asyncio.run(replacement_rejects_failed_projection(after_preparation=True)),
    )
    check(
        "thread replacement waits for pending commands without cancelling or clearing them",
        asyncio.run(replacement_preserves_pending_commands()),
    )
    check(
        "thread replacement waits for unknown reduction with batched observations",
        asyncio.run(replacement_waits_for_unknown_reduction_with_batched_observations()),
    )
    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
