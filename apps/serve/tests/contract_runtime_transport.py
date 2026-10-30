"""Contract for lossless long-session SSE replay and transport liveness."""

from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from service.chat.persistence.catalog import (
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.chat.persistence.worker import PersistenceWorker
from service.chat.runtime.content import MessageSnapshots
from service.chat.runtime.live import LiveSession
from service.chat.service.events import SSE_HEARTBEAT_FRAME, EventService

SESSION_ID = "runtime-transport-session"
RUNTIME_ID = "codex"
VENDOR_THREAD_ID = "runtime-transport-thread"
REPLAY_PAGE_SIZE = 2
REPLAY_EVENT_COUNT = 3
HEARTBEAT_TEST_SECONDS = 0.001
SUBSCRIBER_TEST_CAPACITY = 3


class RuntimeTransportContract(unittest.IsolatedAsyncioTestCase):
    def test_message_snapshots_isolate_turns_and_items(self) -> None:
        snapshots = MessageSnapshots()
        self.assertEqual(snapshots.append("turn-1", "comment", "正在"), "正在")
        self.assertEqual(snapshots.append("turn-1", "answer", "结果"), "结果")
        self.assertEqual(snapshots.append("turn-2", "comment", "另一个"), "另一个")
        self.assertEqual(snapshots.append("turn-1", "comment", "计算。"), "正在计算。")
        snapshots.finish("turn-1", "comment")
        self.assertEqual(snapshots.append("turn-1", "comment", "新消息"), "新消息")
        snapshots.finish_turn("turn-1")
        self.assertEqual(snapshots.append("turn-1", "answer", "重试"), "重试")
        self.assertEqual(snapshots.append("turn-2", "comment", "继续"), "另一个继续")

    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="runtime-transport-")
        database = Path(self._temporary.name) / "sessions.sqlite3"
        catalog = SessionCatalogStore(database)
        catalog.register(
            SESSION_ID,
            SessionPrincipal("transport-owner"),
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_session_id="process-1",
            runtime_workdir=self._temporary.name,
            project_path=None,
            output_root=str(Path(self._temporary.name) / "outputs"),
            codex_version="test",
            model_id="test",
            policy_id="workspace-write",
            status=SessionStatus.READY,
            title="transport",
            created_at=1.0,
        )
        self.events = ProductEventStore(database)
        self.logger = MagicMock()

    def tearDown(self) -> None:
        self._temporary.cleanup()

    async def test_replay_pages_until_the_durable_cursor_is_exhausted(self) -> None:
        for index in range(REPLAY_EVENT_COUNT):
            self.events.append(
                session_id=SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=VENDOR_THREAD_ID,
                vendor_turn_id="turn-1",
                vendor_item_id=f"item-{index}",
                kind="message_delta",
                payload={"delta": str(index)},
                idempotency_key=f"replay-{index}",
            )
        service = EventService({}, self.events, self.logger)
        with patch(
            "service.chat.service.events.MAXIMUM_REPLAY_LIMIT",
            REPLAY_PAGE_SIZE,
        ):
            stream = service.open(SESSION_ID, 0)
            try:
                frames = [await anext(stream) for _ in range(REPLAY_EVENT_COUNT)]
            finally:
                await stream.aclose()
        self.assertEqual(len(frames), REPLAY_EVENT_COUNT)
        self.assertIn('"seq":3', frames[-1])

    async def test_idle_live_stream_emits_a_valid_sse_heartbeat(self) -> None:
        live = SimpleNamespace(subscribers=[], lifecycle_lock=asyncio.Lock())
        service = EventService({SESSION_ID: live}, self.events, self.logger)  # type: ignore[dict-item]
        stream = service.open(SESSION_ID, 0)
        try:
            with patch(
                "service.chat.service.events.SSE_HEARTBEAT_SECONDS",
                HEARTBEAT_TEST_SECONDS,
            ):
                frame = await anext(stream)
            self.assertEqual(frame, SSE_HEARTBEAT_FRAME)
            self.assertIn("event: heartbeat\n", frame)
            self.assertIn("data: {}\n\n", frame)
            self.assertNotIn("id:", frame)
        finally:
            await stream.aclose()
        self.assertEqual(live.subscribers, [])

    def append_product_event(self, key: str) -> ProductEventRecord:
        return self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id=None,
            vendor_item_id=None,
            kind="artifact_library_linked",
            payload={"link_id": key},
            idempotency_key=key,
        )

    async def test_live_wakeup_drains_unbroadcast_events_before_notified_event(self) -> None:
        live = SimpleNamespace(subscribers=[], lifecycle_lock=asyncio.Lock())
        service = EventService({SESSION_ID: live}, self.events, self.logger)  # type: ignore[dict-item]
        stream = service.open(SESSION_ID, 0)
        try:
            with patch("service.chat.service.events.SSE_HEARTBEAT_SECONDS", HEARTBEAT_TEST_SECONDS):
                self.assertEqual(await anext(stream), SSE_HEARTBEAT_FRAME)
                first = self.append_product_event("unbroadcast")
                second = self.append_product_event("notified")
                live.subscribers[0].put_nowait(LiveSession.event_envelope(second))
                self.assertIn(f'"seq":{first.product_seq}', await anext(stream))
                self.assertIn(f'"seq":{second.product_seq}', await anext(stream))
                live.subscribers[0].put_nowait(LiveSession.event_envelope(first))
                self.assertEqual(await anext(stream), SSE_HEARTBEAT_FRAME)
        finally:
            await stream.aclose()

    async def test_inactive_stream_observes_later_commits_and_resumes_cursor(self) -> None:
        first = self.append_product_event("before-subscribe")
        stream = EventService({}, self.events, self.logger).open(SESSION_ID, first.product_seq)
        try:
            with patch("service.chat.service.events.SSE_HEARTBEAT_SECONDS", HEARTBEAT_TEST_SECONDS):
                self.assertEqual(await anext(stream), SSE_HEARTBEAT_FRAME)
                second = self.append_product_event("after-subscribe")
                self.assertIn(f'"seq":{second.product_seq}', await anext(stream))
                self.assertEqual(await anext(stream), SSE_HEARTBEAT_FRAME)
        finally:
            await stream.aclose()

    async def test_slow_subscriber_is_bounded_and_forced_to_replay(self) -> None:
        live = SimpleNamespace(subscribers=[], lifecycle_lock=asyncio.Lock())
        service = EventService({SESSION_ID: live}, self.events, self.logger)  # type: ignore[dict-item]
        stream = service.open(SESSION_ID, 0)
        with (
            patch(
                "service.chat.service.events.EVENT_BACKLOG_MAX",
                SUBSCRIBER_TEST_CAPACITY,
            ),
            patch(
                "service.chat.service.events.SSE_HEARTBEAT_SECONDS",
                HEARTBEAT_TEST_SECONDS,
            ),
        ):
            self.assertEqual(await anext(stream), SSE_HEARTBEAT_FRAME)
            queue = live.subscribers[0]
            self.assertEqual(queue.maxsize, SUBSCRIBER_TEST_CAPACITY)
            live.subscribers.remove(queue)
            with self.assertRaises(StopAsyncIteration):
                await anext(stream)

    async def test_publish_drops_only_the_slow_live_queue_after_durable_commit(self) -> None:
        record = ProductEventRecord(
            event_id=1,
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id=None,
            vendor_item_id=None,
            kind="message_delta",
            payload={"delta": "durable"},
            schema_version=2,
            product_seq=1,
            idempotency_key="slow-consumer",
            created_at=1.0,
        )
        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue(maxsize=1)
        queue.put_nowait({"already": "full"})
        live = LiveSession.__new__(LiveSession)
        live.id = SESSION_ID
        live.runtime_id = RUNTIME_ID
        live.vendor_thread_id = VENDOR_THREAD_ID
        live.subscribers = [queue]  # type: ignore[assignment]
        live._events = MagicMock(append=MagicMock(return_value=record))
        live._trace = MagicMock()
        live._logger = self.logger
        live._persistence = PersistenceWorker()
        self.addAsyncCleanup(live._persistence.close)
        live._publication_lock = asyncio.Lock()
        live._publication_error = None
        live._broadcast_sequence = 0

        committed = await live.publish("message_delta", {"delta": "durable"})

        self.assertIs(committed, record)
        self.assertEqual(live.subscribers, [])
        self.logger.warning.assert_called_once()


if __name__ == "__main__":
    unittest.main()
