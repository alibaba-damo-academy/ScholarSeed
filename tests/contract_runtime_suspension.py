"""Deterministic projection/checkpoint barriers; these are not product acceptance."""

from __future__ import annotations

import asyncio
import unittest

from scholarseed_runtime.contract import RuntimeEventKind
from scholarseed_runtime.contract.session import (
    RuntimeActivitySnapshot,
    SuspendReceipt,
    SuspendState,
    SuspendTicket,
)
from scholarseed_runtime.gateway.driver import RuntimeDriver, RuntimeDriverError
from tests.contract_runtime_driver import ContractSession


class SuspensionSession(ContractSession):
    def __init__(self, watermark: int = 1) -> None:
        super().__init__(auto_complete=False)
        self.ticket = SuspendTicket("ticket", "generation", 1, watermark)
        self.state = SuspendState.ABORTED
        self.prepared = asyncio.Event()
        self.committing = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()
        self.commits: list[int] = []

    async def activity(self) -> RuntimeActivitySnapshot:
        return RuntimeActivitySnapshot("generation", 1, self.ticket.watermark, True)

    async def prepare_suspend(self, revision: int) -> SuspendTicket:
        self.state = SuspendState.PREPARED
        self.prepared.set()
        return self.ticket

    async def commit_suspend(self, ticket: SuspendTicket, watermark: int) -> SuspendReceipt:
        self.commits.append(watermark)
        self.state = SuspendState.COMMITTING
        self.committing.set()
        await self.release.wait()
        self.state = SuspendState.RELEASED
        return SuspendReceipt(ticket, self.state)

    async def abort_suspend(self, ticket: SuspendTicket) -> SuspendReceipt:
        if self.state is SuspendState.PREPARED:
            self.state = SuspendState.ABORTED
        return SuspendReceipt(ticket, self.state)

    async def suspend_status(self, ticket: SuspendTicket) -> SuspendReceipt:
        return SuspendReceipt(ticket, self.state)


class RuntimeSuspensionContract(unittest.IsolatedAsyncioTestCase):
    async def create_driver(self, session, observe):
        driver = RuntimeDriver(session, observe)
        driver.start()
        self.addAsyncCleanup(driver.close)
        return driver

    async def test_checkpoint_waits_for_projection_not_delivery(self) -> None:
        session = SuspensionSession()
        entered = asyncio.Event()
        projected = asyncio.Event()
        checkpoints = []

        async def observe(event):
            entered.set()
            await projected.wait()

        async def checkpoint(watermark):
            checkpoints.append(watermark)

        driver = await self.create_driver(session, observe)
        await session.queue.put(session.event(1, RuntimeEventKind.SESSION_OPENED, ""))
        await entered.wait()
        task = asyncio.create_task(driver.suspend(checkpoint))
        await session.prepared.wait()
        self.assertFalse(task.done())
        self.assertEqual(checkpoints, [])
        self.assertEqual(session.commits, [])
        projected.set()
        result = await asyncio.wait_for(task, 1)
        self.assertEqual(result.state, SuspendState.RELEASED)
        self.assertEqual(checkpoints, [1])
        self.assertEqual(session.commits, [1])
        self.assertFalse(session.detached)

    async def test_failed_checkpoint_reopens_admission_without_release(self) -> None:
        session = SuspensionSession(watermark=0)

        async def observe(event):
            return None

        async def checkpoint(watermark):
            raise OSError("durable store unavailable")

        driver = await self.create_driver(session, observe)
        with self.assertRaises(OSError):
            await driver.suspend(checkpoint)
        self.assertEqual(session.state, SuspendState.ABORTED)
        self.assertEqual(session.commits, [])
        self.assertFalse(session.detached)

    async def test_cancellation_before_watermark_aborts_ticket(self) -> None:
        session = SuspensionSession()

        async def observe(event):
            return None

        async def checkpoint(watermark):
            self.fail("checkpoint ran before projection")

        driver = await self.create_driver(session, observe)
        task = asyncio.create_task(driver.suspend(checkpoint))
        await session.prepared.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(session.state, SuspendState.ABORTED)

    async def test_cancellation_during_commit_resolves_owned_release(self) -> None:
        session = SuspensionSession(watermark=0)
        session.release.clear()

        async def observe(event):
            return None

        async def checkpoint(watermark):
            return None

        driver = await self.create_driver(session, observe)
        task = asyncio.create_task(driver.suspend(checkpoint))
        await session.committing.wait()
        task.cancel()
        session.release.set()
        receipt = await asyncio.wait_for(task, 1)
        self.assertEqual(receipt.state, SuspendState.RELEASED)
        self.assertFalse(session.detached)

    async def test_close_wakes_a_waiting_projection_barrier(self) -> None:
        session = SuspensionSession()

        async def observe(event):
            return None

        async def checkpoint(watermark):
            self.fail("closed projection was checkpointed")

        driver = await self.create_driver(session, observe)
        task = asyncio.create_task(driver.suspend(checkpoint))
        await session.prepared.wait()
        await driver.close()
        with self.assertRaises(RuntimeDriverError):
            await asyncio.wait_for(task, 1)
        self.assertEqual(session.state, SuspendState.ABORTED)


if __name__ == "__main__":
    unittest.main()
