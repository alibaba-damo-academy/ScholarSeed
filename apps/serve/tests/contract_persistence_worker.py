"""Persistence never blocks the event loop and completes before cancellation."""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path

from service.chat.persistence.utils import begin_write
from service.chat.persistence.worker import PersistenceWorker


class PersistenceContract(unittest.IsolatedAsyncioTestCase):
    async def test_busy_admission_keeps_order_and_cancelled_work_finishes_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "writes.sqlite3"
            blocker = sqlite3.connect(database)
            blocker.execute("CREATE TABLE events(value INTEGER)")
            blocker.execute("BEGIN IMMEDIATE")
            worker = PersistenceWorker()
            attempted = threading.Event()
            committed: list[int] = []

            def write(sequence: int) -> None:
                connection = sqlite3.connect(database, timeout=0)
                try:
                    attempted.set()
                    begin_write(connection, database)
                    connection.execute("INSERT INTO events VALUES (?)", (sequence,))
                    connection.commit()
                    committed.append(sequence)
                finally:
                    connection.close()

            first = asyncio.create_task(worker.run(write, 1))
            second = asyncio.create_task(worker.run(write, 2))
            try:
                self.assertTrue(await asyncio.to_thread(attempted.wait, 2))
                first.cancel()
                await asyncio.sleep(0.05)
                self.assertFalse(first.done())
                self.assertFalse(second.done())
                blocker.rollback()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(first, 2)
                await asyncio.wait_for(second, 2)
                self.assertEqual(committed, [1, 2])
            finally:
                blocker.rollback()
                blocker.close()
                await asyncio.gather(first, second, return_exceptions=True)
                await worker.close()

    async def test_close_stops_unacquired_write_without_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "writes.sqlite3"
            blocker = sqlite3.connect(database)
            blocker.execute("CREATE TABLE events(value INTEGER)")
            blocker.execute("BEGIN IMMEDIATE")
            worker = PersistenceWorker()
            attempted = threading.Event()

            def write() -> None:
                connection = sqlite3.connect(database, timeout=0)
                try:
                    attempted.set()
                    begin_write(connection, database)
                    connection.execute("INSERT INTO events VALUES (1)")
                    connection.commit()
                finally:
                    connection.close()

            task = asyncio.create_task(worker.run(write))
            try:
                self.assertTrue(await asyncio.to_thread(attempted.wait, 2))
                await asyncio.wait_for(worker.close(), 2)
                with self.assertRaises(asyncio.CancelledError):
                    await task
                blocker.rollback()
                self.assertEqual(blocker.execute("SELECT COUNT(*) FROM events").fetchone()[0], 0)
            finally:
                blocker.rollback()
                blocker.close()
                await asyncio.gather(task, return_exceptions=True)
                await worker.close()

    async def test_close_does_not_start_queued_writes(self) -> None:
        worker = PersistenceWorker()
        started, release = threading.Event(), threading.Event()
        committed: list[int] = []

        def write() -> None:
            started.set()
            release.wait(2)
            committed.append(1)

        first = asyncio.create_task(worker.run(write))
        second = None
        closing = None
        try:
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            second = asyncio.create_task(worker.run(committed.append, 2))
            await asyncio.sleep(0)
            closing = asyncio.create_task(worker.close())
            await asyncio.sleep(0)
            self.assertFalse(closing.done())
            release.set()
            await first
            await asyncio.wait_for(closing, 2)
            with self.assertRaises(asyncio.CancelledError):
                await second
            self.assertEqual(committed, [1])
        finally:
            release.set()
            await asyncio.gather(
                first,
                *([second] if second else []),
                *([closing] if closing else []),
                return_exceptions=True,
            )
            await worker.close()

    async def test_non_admission_failure_is_not_retried(self) -> None:
        worker = PersistenceWorker()
        calls: list[bool] = []

        def write() -> None:
            calls.append(True)
            raise sqlite3.OperationalError("failure after transaction admission")

        try:
            with self.assertRaises(sqlite3.OperationalError):
                await worker.run(write)
            self.assertEqual(calls, [True])
        finally:
            await worker.close()

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
