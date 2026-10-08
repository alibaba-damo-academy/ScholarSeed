"""Lossless observation acceptance independent of consumer speed."""

from __future__ import annotations

import asyncio
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from scholarseed_codex.emitter import CodexEmitter
from scholarseed_codex.events import translate_event
from scholarseed_codex.mailbox import ObservationMailbox
from scholarseed_codex.protocol.session import CodexSessionEventKind
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_runtime.contract import DeliveryClass, RuntimeEvent, RuntimeEventKind


def event(sequence: int, kind: RuntimeEventKind = RuntimeEventKind.TOOL_PROGRESS) -> RuntimeEvent:
    return RuntimeEvent(
        schema_version=1,
        event_id=f"event-{sequence}",
        runtime_id="codex",
        product_session_id="product",
        native_session_id="native",
        process_generation=1,
        sequence=sequence,
        kind=kind,
        delivery=DeliveryClass.MUST_PERSIST,
        observed_at="2026-09-30T00:00:00Z",
        payload={"delta": f"{sequence:06d}:中文\r\n"},
    )


class MailboxContract(unittest.IsolatedAsyncioTestCase):
    async def test_accepts_without_consumer_and_preserves_every_event(self) -> None:
        mailbox = ObservationMailbox(memory_budget_bytes=1024)
        expected = [event(i) for i in range(2500)] + [event(2500, RuntimeEventKind.TOOL_COMPLETED)]
        try:
            async with asyncio.timeout(10):
                for observation in expected:
                    await mailbox.put(observation)
            self.assertEqual(mailbox.qsize(), len(expected))
            self.assertLessEqual(mailbox.memory_bytes, 1024)
            self.assertTrue(mailbox.spilled)
            actual = [await mailbox.get() for _ in expected]
            self.assertEqual(actual, expected)
            self.assertEqual(mailbox.qsize(), 0)
            # A new burst after drain must not replay stale records.
            await mailbox.put(event(2501))
            self.assertEqual(await mailbox.get(), event(2501))
        finally:
            await mailbox.close()

    async def test_disk_failure_is_explicit_and_does_not_accept_event(self) -> None:
        mailbox = ObservationMailbox(memory_budget_bytes=1)
        try:
            with patch.object(mailbox, "_append", side_effect=OSError("disk full")):
                with self.assertRaisesRegex(OSError, "disk full"):
                    await mailbox.put(event(1))
            self.assertEqual(mailbox.qsize(), 0)
            with self.assertRaisesRegex(OSError, "disk full"):
                await mailbox.get()
            with self.assertRaisesRegex(OSError, "disk full"):
                await mailbox.put(event(2, RuntimeEventKind.TOOL_COMPLETED))
        finally:
            await mailbox.close()

    async def test_close_wakes_empty_consumer(self) -> None:
        mailbox = ObservationMailbox(memory_budget_bytes=1024)
        consumer = asyncio.create_task(mailbox.get())
        await asyncio.sleep(0)
        await mailbox.close()
        with self.assertRaises(EOFError):
            await consumer
        with self.assertRaises(EOFError):
            await mailbox.put(event(1))

    async def test_emitter_cannot_hide_failed_acceptance_then_publish_success(self) -> None:
        mailbox = ObservationMailbox(memory_budget_bytes=1)

        async def listener(source: object) -> None:
            await mailbox.put(
                translate_event(source, product_session_id="product", process_generation=1)
            )

        target = SimpleNamespace(thread_id="native", listener=listener)
        try:
            with patch.object(mailbox, "_append", side_effect=OSError("disk full")):
                with self.assertLogs("scholarseed_codex.emitter", level="ERROR"):
                    await CodexEmitter().emit(target, CodexSessionEventKind.TOOL_PROGRESS)
                    await CodexEmitter().emit(target, CodexSessionEventKind.TOOL_COMPLETED)
            with self.assertRaisesRegex(OSError, "disk full"):
                await mailbox.get()
            self.assertEqual(mailbox.qsize(), 0)
        finally:
            await mailbox.close()

    async def test_repeated_cancel_finishes_spill_and_reclaims_segments(self) -> None:
        mailbox = ObservationMailbox(memory_budget_bytes=1)
        started, release = threading.Event(), threading.Event()
        append = mailbox._append

        def slow_append(payload: bytes) -> None:
            started.set()
            release.wait(2)
            append(payload)

        try:
            with patch.object(mailbox, "_append", side_effect=slow_append):
                holder = SimpleNamespace(_events=mailbox, _watermark=0)
                producer = asyncio.create_task(
                    CodexRuntimeSession._publish_observation(holder, event(1))
                )
                await asyncio.to_thread(started.wait, 2)
                producer.cancel()
                await asyncio.sleep(0)
                producer.cancel()
                await asyncio.sleep(0)
                self.assertFalse(producer.done())
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await producer
            self.assertEqual(await mailbox.get(), event(1))
            self.assertEqual(holder._watermark, 1)
            self.assertEqual(len(mailbox._segments), 0)
        finally:
            release.set()
            await mailbox.close()

    async def test_serialization_failure_wakes_consumer(self) -> None:
        mailbox = ObservationMailbox()
        consumer = asyncio.create_task(mailbox.get())
        try:
            await asyncio.sleep(0)
            with patch("scholarseed_codex.mailbox.pickle.dumps", side_effect=TypeError("encode")):
                with self.assertRaisesRegex(TypeError, "encode"):
                    await mailbox.put(event(1))
            with self.assertRaisesRegex(TypeError, "encode"):
                await consumer
        finally:
            await mailbox.close()


if __name__ == "__main__":
    unittest.main()
