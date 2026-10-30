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
from scholarseed_runtime.contract.session import (
    RUNTIME_CONFIRMATION_UNSUPPORTED,
    RuntimeActivitySnapshot,
    RuntimeTurnConfirmation,
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
    def __init__(self, *, auto_complete: bool = True) -> None:
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
        failed = True
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
    driver._consumer = None
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
    driver._consumer = None
    await driver.close()
    return rejected and not session.commits


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
    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
