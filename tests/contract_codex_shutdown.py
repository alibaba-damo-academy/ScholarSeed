"""Shutdown observation must preserve cancellation and omit user data."""

import asyncio
import unittest
from unittest.mock import patch

from scholarseed_codex import shutdown


class ShutdownObservationTests(unittest.IsolatedAsyncioTestCase):
    async def test_waiting_observation_does_not_complete_or_cancel_owned_work(self):
        gate = asyncio.Event()
        entered = asyncio.Event()

        async def close():
            async with shutdown.observe_shutdown("host_close", 123, 7) as observation:
                with observation.phase("process_wait"):
                    entered.set()
                    await gate.wait()

        with (
            patch.object(shutdown, "WAIT_INTERVAL_SECONDS", 0.005),
            self.assertLogs(shutdown.LOGGER, "INFO") as logs,
        ):
            task = asyncio.create_task(close())
            await entered.wait()
            await asyncio.sleep(0.03)
            self.assertFalse(task.done())
            gate.set()
            await task
        evidence = "\n".join(logs.output)
        self.assertIn('"event": "waiting"', evidence)
        self.assertIn('"stage": "process_wait"', evidence)
        self.assertIn('"stage_elapsed_ms"', evidence)
        self.assertFalse(
            any(
                task.get_coro().__qualname__.endswith("ShutdownObservation.watch")
                for task in asyncio.all_tasks()
            )
        )

    async def test_cancellation_is_not_converted_to_success(self):
        entered = asyncio.Event()

        async def close():
            async with shutdown.observe_shutdown("host_close", None, 1) as observation:
                with observation.phase("reader_task_join"):
                    entered.set()
                    await asyncio.Event().wait()

        with self.assertLogs(shutdown.LOGGER, "INFO") as logs:
            task = asyncio.create_task(close())
            await entered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        evidence = "\n".join(logs.output)
        self.assertIn("CancelledError", evidence)
        self.assertNotIn('"event": "finished"', evidence)

    async def test_await_locations_do_not_include_local_values(self):
        secret = "test-private-value-never-log"

        async def waiting():
            private_value = secret
            await asyncio.Event().wait()
            return private_value

        task = asyncio.create_task(waiting())
        await asyncio.sleep(0)
        locations = str(shutdown.await_locations(task))
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        self.assertIn("waiting", locations)
        self.assertNotIn(secret, locations)
        self.assertNotIn("private_value", locations)
