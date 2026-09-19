"""Contract tests for Serve's command/event Runtime Gateway driver."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import replace

from scholarseed_runtime.contract import (
    CapabilitySet,
    CommandReceipt,
    CommandState,
    DeliveryClass,
    RuntimeBinding,
    RuntimeEvent,
    RuntimeEventKind,
    TurnRequest,
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
    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
