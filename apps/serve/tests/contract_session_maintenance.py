"""Session maintenance timing, admission and actual worker drain contracts."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from service.chat.constants import PRODUCT_EVENT_MESSAGE_DELTA, PRODUCT_EVENT_VERSION
from service.chat.persistence import blocks, journal
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventStore
from service.chat.service.maintenance import (
    SessionMaintenanceService,
    await_storage_maintenance,
    maintain_session_storage,
)
from service.persistence.project import transaction
from service.platform.activity import (
    Activities,
    ActivityDomain,
    ActivityPhase,
    MaintenanceActive,
    MaintenanceIncomplete,
)

INTERVAL = 0.02


class SessionStorageMaintenanceContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database = Path(self.directory.name) / "sessions.sqlite3"
        self.catalog = SessionCatalogStore(self.database)
        self.catalog.register(
            "session",
            SessionPrincipal("owner"),
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_session_id="process",
            runtime_workdir=self.directory.name,
            project_path=None,
            output_root=self.directory.name,
            codex_version="test",
            model_id="model",
            policy_id="workspace-write",
            status=SessionStatus.READY,
            title="",
            created_at=1.0,
        )
        self.events = ProductEventStore(self.database)

    def _legacy_history(self, count: int) -> None:
        with transaction(self.database, immediate=True) as connection:
            connection.executemany(
                "INSERT INTO product_event(session_id,runtime_id,vendor_thread_id,"
                "vendor_turn_id,vendor_item_id,kind,payload,schema_version,product_seq,"
                "idempotency_key,created_at) VALUES ('session','codex','thread','turn',"
                "'answer',?,?,?,?,?,2.0)",
                (
                    (
                        PRODUCT_EVENT_MESSAGE_DELTA,
                        json.dumps({"delta": f"正文 {index}"}),
                        PRODUCT_EVENT_VERSION,
                        index + 1,
                        f"event-{index}",
                    )
                    for index in range(count)
                ),
            )
            connection.execute("UPDATE session_catalog SET last_product_seq=?", (count,))
            connection.executemany(
                "INSERT INTO session_portable_history(session_id,ordinal,role,text) "
                "VALUES ('session',?,'user',?)",
                ((index, f"恢复上下文 {index}") for index in range(3)),
            )

    def _logical_history(self):
        return self.events.replay("session", limit=1000), self.catalog.portable_history("session")

    def test_scheduled_migration_and_gc_keep_event_and_catalog_live_bodies(self) -> None:
        self._legacy_history(3)
        expected = self._logical_history()
        with transaction(self.database, immediate=True) as connection:
            with journal.Journal(connection, self.database) as bodies:
                discarded = bodies.put("unreferenced superseded body" * 4096)
                old_generation = bodies.path
        with patch("service.chat.persistence.journal.COMPACT_MIN_BYTES", 1):
            self.assertFalse(maintain_session_storage(self.database))
        self.assertEqual(self._logical_history(), expected)
        self.assertEqual(
            (
                ProductEventStore(self.database).replay("session"),
                SessionCatalogStore(self.database).portable_history("session"),
            ),
            expected,
        )
        with closing(sqlite3.connect(self.database)) as connection:
            connection.row_factory = sqlite3.Row
            event_refs = tuple(ProductEventStore.body_references(connection))
            catalog_refs = tuple(SessionCatalogStore.body_references(connection))
            self.assertEqual(len(event_refs), 0)
            self.assertEqual(len(catalog_refs), 3)
            with blocks.BlockStore(connection, self.database) as block_store:
                self.assertEqual(len(tuple(block_store.rows(session_id="session"))), 3)
            with journal.Journal(connection, self.database) as bodies:
                self.assertNotEqual(bodies.path, old_generation)
                for reference in (*event_refs, *catalog_refs):
                    self.assertTrue(bodies.get(reference))
                with self.assertRaisesRegex(RuntimeError, "missing"):
                    bodies.get(discarded)
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM product_event").fetchone()[0],
                0,
            )
            self.assertEqual(
                connection.execute("SELECT DISTINCT text FROM session_portable_history").fetchall()[
                    0
                ][0],
                "",
            )
        self.assertFalse(old_generation.exists())

    def test_budget_deferral_keeps_committed_batch_and_next_run_finishes(self) -> None:
        self._legacy_history(300)
        expected = self._logical_history()
        ticks = iter((0.0, 0.0, 3.0))
        with (
            patch(
                "service.chat.service.maintenance.time",
                SimpleNamespace(monotonic=lambda: next(ticks)),
            ),
            patch.object(
                ProductEventStore, "migrate_bodies", wraps=ProductEventStore.migrate_bodies
            ) as sparse_bodies,
        ):
            self.assertTrue(maintain_session_storage(self.database))
            sparse_bodies.assert_not_called()
        self.assertEqual(self._logical_history(), expected)
        with closing(sqlite3.connect(self.database)) as connection:
            pending = connection.execute(
                "SELECT count(*) FROM product_event WHERE payload_ref IS NULL"
            ).fetchone()[0]
            self.assertGreater(pending, 0)
            self.assertLess(pending, 300)
        self.assertFalse(maintain_session_storage(self.database))
        self.assertEqual(self._logical_history(), expected)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM product_event WHERE payload_ref IS NULL"
                ).fetchone()[0],
                0,
            )


class SessionMaintenanceContracts(unittest.IsolatedAsyncioTestCase):
    async def test_idle_admission_refuses_business_and_unready_workbench(self) -> None:
        activities = Activities()
        for domain in ActivityDomain:
            if domain in (ActivityDomain.REQUEST, ActivityDomain.RESOURCE):
                continue
            with self.subTest(domain=domain), activities.enter(domain):
                self.assertIsNone(activities.begin_if_idle())
                self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)
        unready = Activities(workbench_ready=lambda: False)
        self.assertIsNone(unready.begin_if_idle())
        self.assertEqual(unready.snapshot().phase, ActivityPhase.OPEN)

    async def test_idle_admission_requires_passive_and_resource_drain_before_seal(self) -> None:
        activities = Activities()
        with activities.observe_request():
            resource = activities.enter(ActivityDomain.RESOURCE)
            generation = activities.begin_if_idle()
            self.assertIsNotNone(generation)
            self.assertIsNone(activities.begin_if_idle())
            assert generation is not None
            with self.assertRaises(MaintenanceActive):
                activities.enter(ActivityDomain.TURN, root=True)
            self.assertFalse(activities.seal(generation))
            with resource:
                with activities.enter(ActivityDomain.RESOURCE):
                    self.assertFalse(activities.seal(generation))
            self.assertFalse(activities.seal(generation))
        self.assertTrue(activities.seal(generation))
        activities.resume(generation)

    async def test_business_admission_and_idle_begin_have_one_atomic_winner(self) -> None:
        def race() -> None:
            for _ in range(50):
                activities = Activities()
                ready = threading.Barrier(2)
                attempted = threading.Barrier(2)
                outcome: dict[str, bool] = {}

                def business(
                    ready: threading.Barrier = ready,
                    attempted: threading.Barrier = attempted,
                    activities: Activities = activities,
                    outcome: dict[str, bool] = outcome,
                ) -> None:
                    ready.wait()
                    try:
                        lease = activities.enter(ActivityDomain.TURN, root=True)
                    except MaintenanceActive:
                        outcome["admitted"] = False
                        attempted.wait()
                    else:
                        outcome["admitted"] = True
                        try:
                            attempted.wait()
                        finally:
                            lease.close()

                thread = threading.Thread(target=business)
                thread.start()
                ready.wait()
                generation = activities.begin_if_idle()
                attempted.wait()
                thread.join()
                self.assertEqual(generation is None, outcome["admitted"])
                if generation is not None:
                    self.assertTrue(activities.seal(generation))
                    activities.resume(generation)

        await asyncio.to_thread(race)

    async def test_cancelled_storage_callback_joins_physical_worker(self) -> None:
        started = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def physical() -> None:
            started.set()
            release.wait()
            finished.set()

        task = asyncio.create_task(await_storage_maintenance(physical))
        try:
            await asyncio.wait_for(asyncio.to_thread(started.wait), 1)
            task.cancel()
            await asyncio.sleep(INTERVAL)
            task.cancel()
            await asyncio.sleep(INTERVAL)
            self.assertFalse(task.done())
            self.assertFalse(finished.is_set())
        finally:
            release.set()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        self.assertTrue(finished.is_set())

    async def test_start_defers_first_callback_and_close_cancels_timer(self) -> None:
        called = asyncio.Event()

        async def maintain() -> None:
            called.set()

        service = SessionMaintenanceService(Activities(), maintain, interval=60)
        await service.start()
        await asyncio.sleep(INTERVAL)
        self.assertFalse(called.is_set())
        await asyncio.wait_for(service.aclose(), 1)
        self.assertFalse(called.is_set())

    async def test_maintenance_gate_pauses_and_busy_retries(self) -> None:
        activities = Activities()
        generation = activities.begin()
        attempts = 0
        completed = asyncio.Event()

        async def maintain() -> None:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise MaintenanceActive("busy")
            completed.set()

        service = SessionMaintenanceService(activities, maintain, interval=INTERVAL)
        await service.start()
        try:
            await asyncio.sleep(3 * INTERVAL)
            self.assertEqual(attempts, 0)
            activities.resume(generation)
            await asyncio.wait_for(completed.wait(), 1)
            self.assertGreaterEqual(attempts, 2)
        finally:
            await service.aclose()

    async def test_close_waits_for_disk_worker_even_if_close_is_cancelled(self) -> None:
        entered = asyncio.Event()
        release = threading.Event()
        finished = threading.Event()

        def disk() -> None:
            release.wait(3)
            finished.set()

        async def maintain() -> None:
            entered.set()
            await asyncio.to_thread(disk)

        service = SessionMaintenanceService(Activities(), maintain, interval=INTERVAL)
        await service.start()
        await asyncio.wait_for(entered.wait(), 1)
        closing = asyncio.create_task(service.aclose())
        try:
            await asyncio.sleep(INTERVAL)
            closing.cancel()
            await asyncio.sleep(INTERVAL)
            self.assertFalse(closing.done())
            self.assertFalse(finished.is_set())
        finally:
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await closing
        self.assertTrue(finished.is_set())
        await service.aclose()

    async def test_failure_is_logged_and_next_interval_retries(self) -> None:
        attempts = 0
        completed = asyncio.Event()

        async def maintain() -> None:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise OSError("disk unavailable")
            completed.set()

        service = SessionMaintenanceService(Activities(), maintain, interval=INTERVAL)
        with self.assertLogs("service.chat.service.maintenance", level="ERROR"):
            await service.start()
            try:
                await asyncio.wait_for(completed.wait(), 1)
            finally:
                await service.aclose()
        self.assertGreaterEqual(attempts, 2)

    async def test_owner_failure_during_close_is_not_swallowed(self) -> None:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def maintain() -> None:
            entered.set()
            await release.wait()
            raise OSError("disk flush failed")

        service = SessionMaintenanceService(Activities(), maintain, interval=INTERVAL)
        await service.start()
        await asyncio.wait_for(entered.wait(), 1)
        closing = asyncio.create_task(service.aclose())
        await asyncio.sleep(0)
        with self.assertLogs("service.chat.service.maintenance", level="ERROR"):
            release.set()
            with self.assertRaisesRegex(OSError, "disk flush failed"):
                await closing

    async def test_unresolved_maintenance_failure_before_shutdown_remains_fatal(self) -> None:
        activities = Activities()
        failed = asyncio.Event()

        async def maintain() -> None:
            generation = activities.begin_if_idle()
            assert generation is not None
            self.assertTrue(activities.seal(generation))
            failed.set()
            raise MaintenanceIncomplete("directory qualification unresolved")

        service = SessionMaintenanceService(activities, maintain, interval=INTERVAL)
        with self.assertLogs("service.chat.service.maintenance", level="ERROR"):
            await service.start()
            await asyncio.wait_for(failed.wait(), 1)
            # The owner failed before shutdown; cancelling the next idle wait
            # must not erase the failure and report a successful drain.
            await asyncio.sleep(INTERVAL * 2)
            with self.assertRaisesRegex(MaintenanceIncomplete, "qualification unresolved"):
                await service.aclose()
        self.assertEqual(activities.snapshot().phase, ActivityPhase.SEALED)


if __name__ == "__main__":
    unittest.main()
