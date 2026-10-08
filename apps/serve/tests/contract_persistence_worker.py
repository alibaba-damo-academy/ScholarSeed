"""Persistence never blocks the event loop and completes before cancellation."""

from __future__ import annotations

import asyncio
import threading
import time
import unittest

from service.chat.persistence.worker import PersistenceWorker


class PersistenceContract(unittest.IsolatedAsyncioTestCase):
    async def test_slow_write_does_not_block_loop_and_preserves_order(self) -> None:
        worker = PersistenceWorker()
        committed: list[int] = []
        threads: list[int] = []

        def write(sequence: int) -> None:
            time.sleep(0.02)
            committed.append(sequence)
            threads.append(threading.get_ident())

        ticks = 0

        async def heartbeat() -> None:
            nonlocal ticks
            while len(committed) < 5:
                ticks += 1
                await asyncio.sleep(0.001)

        try:
            await asyncio.gather(heartbeat(), *(worker.run(write, i) for i in range(5)))
            self.assertEqual(committed, list(range(5)))
            self.assertEqual(len(set(threads)), 1)
            self.assertNotEqual(threads[0], threading.get_ident())
            self.assertGreater(ticks, 10)
        finally:
            await worker.close()

    async def test_cancel_waits_for_started_write_before_close(self) -> None:
        worker = PersistenceWorker()
        started = threading.Event()
        release = threading.Event()
        committed: list[bool] = []

        def write() -> None:
            started.set()
            release.wait(2)
            committed.append(True)

        task = asyncio.create_task(worker.run(write))
        try:
            await asyncio.to_thread(started.wait, 2)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(committed, [True])
        finally:
            release.set()
            await worker.close()


if __name__ == "__main__":
    unittest.main()
