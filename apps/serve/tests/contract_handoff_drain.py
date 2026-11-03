"""Real SQLite handoff workers remain counted after their awaiter is cancelled."""

from __future__ import annotations

import asyncio
import os
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from service.identity.api.handoff import _handoff_call, build_handoff_router
from service.identity.persistence import handoff
from service.identity.persistence.handoff import HandoffClaimStore
from service.identity.utils import HOST_PROCESS_HEADER, HOST_PROCESS_KEY_ENV
from service.persistence.project import DatabaseBindingError, connect
from service.platform.activity import Activities
from service.platform.http_activity import ServeApplication

WORKER_TIMEOUT_SECONDS = 10
CONCURRENT_RENEWALS = 2


class HandoffSchemaContract(unittest.TestCase):
    def rotate_sidecars(self, database, operation):
        ready = threading.Event()
        rotate = threading.Event()
        rotated = threading.Event()
        release = threading.Event()
        original_reader = handoff.reader
        sidecars = tuple(Path(str(database) + suffix) for suffix in ("-wal", "-shm"))

        def hold_generations():
            with closing(connect(database)) as keeper:
                keeper.execute("SELECT * FROM desktop_handoff_claims").fetchall()
                before = tuple((path.stat().st_dev, path.stat().st_ino) for path in sidecars)
                ready.set()
                self.assertTrue(rotate.wait(WORKER_TIMEOUT_SECONDS))
            self.assertTrue(all(not path.exists() for path in sidecars))
            with closing(connect(database)) as keeper:
                keeper.execute("SELECT * FROM desktop_handoff_claims").fetchall()
                after = tuple((path.stat().st_dev, path.stat().st_ino) for path in sidecars)
                self.assertNotEqual(before, after)
                rotated.set()
                self.assertTrue(release.wait(WORKER_TIMEOUT_SECONDS))

        @contextmanager
        def rotate_after_close(path):
            with original_reader(path) as connection:
                yield connection
            rotate.set()
            self.assertTrue(rotated.wait(WORKER_TIMEOUT_SECONDS))

        with ThreadPoolExecutor(max_workers=1) as workers:
            worker = workers.submit(hold_generations)
            try:
                self.assertTrue(ready.wait(WORKER_TIMEOUT_SECONDS))
                with patch.object(handoff, "reader", rotate_after_close):
                    return operation()
            finally:
                rotate.set()
                release.set()
                worker.result(timeout=WORKER_TIMEOUT_SECONDS)

    def test_runtime_renew_accepts_sqlite_sidecar_rotation(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "handoff.sqlite3"
            store = HandoffClaimStore(database)
            store.claim("state", "owner")
            lease = self.rotate_sidecars(database, lambda: store.renew("state", "owner"))
            self.assertIsNotNone(lease)
            self.assertIsNone(lease.code)

    def test_startup_inspection_rejects_sqlite_sidecar_rotation(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "handoff.sqlite3"
            store = HandoffClaimStore(database)
            store.claim("state", "owner")
            with self.assertRaisesRegex(DatabaseBindingError, "binding changed"):
                self.rotate_sidecars(database, lambda: store.inspect_schema(database))

    def test_runtime_renew_rejects_main_file_replacement_before_writer(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "handoff.sqlite3"
            replacement = Path(root) / "replacement.sqlite3"
            store = HandoffClaimStore(database)
            store.claim("state", "owner")
            replacement.write_bytes(database.read_bytes())
            original_reader = handoff.reader

            @contextmanager
            def replace_after_close(path):
                with original_reader(path) as connection:
                    yield connection
                os.replace(replacement, database)

            with (
                patch.object(handoff, "reader", replace_after_close),
                patch.object(handoff, "transaction", side_effect=AssertionError("opened writer")),
                self.assertRaisesRegex(DatabaseBindingError, "binding changed"),
            ):
                store.renew("state", "owner")

    def test_runtime_renew_rejects_orphan_sidecar_before_writer(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "handoff.sqlite3"
            sidecar = Path(str(database) + "-wal")
            sidecar.write_bytes(b"preserve orphaned data")
            with (
                patch.object(handoff, "transaction", side_effect=AssertionError("opened writer")),
                self.assertRaisesRegex(DatabaseBindingError, "sidecars exist without"),
            ):
                HandoffClaimStore(database).renew("state", "owner")
            self.assertFalse(database.exists())
            self.assertEqual(sidecar.read_bytes(), b"preserve orphaned data")

    def test_failed_first_claim_can_retry_same_store(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "handoff.sqlite3"
            store = HandoffClaimStore(database)
            with patch.object(store, "_purge_expired", side_effect=OSError("claim failed")):
                with self.assertRaisesRegex(OSError, "claim failed"):
                    store.claim("state", "owner")
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(
                    connection.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall(),
                    [],
                )
            self.assertIsNotNone(store.claim("state", "owner"))
            self.assertIsNotNone(store.renew("state", "owner"))

    def test_unknown_format_rejected_before_private_writer(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "handoff.sqlite3"
            store = HandoffClaimStore(database)
            store.claim("state", "owner")
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute("ALTER TABLE desktop_handoff_claims ADD COLUMN future_data TEXT")
                before = tuple(connection.iterdump())
            with patch(
                "service.identity.persistence.handoff.transaction",
                side_effect=AssertionError("opened writer"),
            ):
                with self.assertRaises(RuntimeError):
                    store.renew("state", "owner")
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(tuple(connection.iterdump()), before)

    def test_current_claim_does_not_execute_schema_ddl(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "handoff.sqlite3"
            store = HandoffClaimStore(database)
            store.claim("state", "owner")
            create = store._create_table

            def only_reference(connection):
                self.assertFalse(connection.execute("PRAGMA database_list").fetchone()[2])
                create(connection)

            with patch.object(HandoffClaimStore, "_create_table", side_effect=only_reference):
                self.assertIsNotNone(store.renew("state", "owner"))

    def test_wal_index_and_unknown_index_preserve_claim(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "handoff.sqlite3"
            store = HandoffClaimStore(database)
            store.claim("state", "owner")
            with closing(sqlite3.connect(database)) as writer:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("DROP INDEX desktop_handoff_claims_lease")
                writer.commit()
                wal = Path(str(database) + "-wal")
                before = database.read_bytes(), wal.read_bytes()
                schema = store.inspect_schema(database)
                self.assertFalse(schema.create_table)
                self.assertTrue(schema.create_index)
                self.assertEqual((database.read_bytes(), wal.read_bytes()), before)
                self.assertIsNotNone(store.renew("state", "owner"))
                self.assertFalse(store.inspect_schema(database).needs_write)
                writer.execute("DROP INDEX desktop_handoff_claims_lease")
                writer.execute(
                    "CREATE INDEX desktop_handoff_claims_lease ON desktop_handoff_claims(owner_id)"
                )
                writer.commit()
                before = tuple(writer.iterdump())
                with self.assertRaisesRegex(RuntimeError, "owned index"):
                    store.release("state", "owner")
                self.assertEqual(tuple(writer.iterdump()), before)

    def test_missing_inspection_does_not_create_paths(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "absent" / "handoff.sqlite3"
            self.assertTrue(HandoffClaimStore.inspect_schema(database).needs_write)
            self.assertFalse(database.parent.exists())


class HandoffDrainContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.activities = Activities()
        self.database = Path(self.home.name) / "handoff.sqlite3"
        self.store = HandoffClaimStore(self.database)
        self.store.claim("state", "owner")

    async def test_concurrent_endpoint_renewals_take_delivered_code_once(self):
        app = ServeApplication(activities=self.activities)
        app.include_router(build_handoff_router(self.store, activities=self.activities))
        self.store.deliver("state", "fixture-code", "other")
        barrier = threading.Barrier(CONCURRENT_RENEWALS)
        original_reader = handoff.reader

        @contextmanager
        def overlapping_reader(path):
            with original_reader(path) as connection:
                barrier.wait(timeout=WORKER_TIMEOUT_SECONDS)
                yield connection

        with (
            patch.dict(os.environ, {HOST_PROCESS_KEY_ENV: "fixture-host"}),
            patch.object(handoff, "reader", overlapping_reader),
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://fixture"
            ) as client:
                responses = await asyncio.gather(
                    *(
                        client.post(
                            "/api/auth/handoff/renew",
                            headers={HOST_PROCESS_HEADER: "fixture-host"},
                            json={"state": "state", "owner_id": "owner"},
                        )
                        for _ in range(CONCURRENT_RENEWALS)
                    )
                )
        self.assertEqual([response.status_code for response in responses], [200, 200])
        bodies = [response.json() for response in responses]
        self.assertTrue(all(body["status"] == "renewed" for body in bodies))
        self.assertEqual([body["code"] for body in bodies if "code" in body], ["fixture-code"])

    async def asyncTearDown(self):
        self.assertEqual(self.activities.snapshot().counts, {})
        self.home.cleanup()

    async def wait_for(self, predicate):
        async with asyncio.timeout(5):
            while not predicate():
                await asyncio.sleep(0.01)

    async def blocked_transaction(self, operation, *args):
        finished = threading.Event()
        blocker = sqlite3.connect(self.database)
        blocker.execute("BEGIN IMMEDIATE")
        errors = []

        def worker():
            try:
                return _handoff_call(self.activities, operation, *args)
            except BaseException as error:
                errors.append(error)
            finally:
                finished.set()

        task = asyncio.create_task(asyncio.to_thread(worker))
        try:
            await self.wait_for(lambda: self.activities.snapshot().counts.get("request", 0) == 1)
            generation = self.activities.begin()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            self.assertFalse(finished.is_set())
            self.assertFalse(self.activities.seal(generation))
        finally:
            blocker.rollback()
            blocker.close()
            await self.wait_for(finished.is_set)
            await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(errors, [])
        self.assertTrue(self.activities.seal(generation))

    async def test_claim_transaction_survives_waiter_cancellation(self):
        await self.blocked_transaction(self.store.claim, "new-state", "owner")
        self.assertIsNotNone(self.store.renew("new-state", "owner"))

    async def test_renew_transaction_survives_waiter_cancellation(self):
        await self.blocked_transaction(self.store.renew, "state", "owner")

    async def test_delivery_transaction_survives_waiter_cancellation(self):
        await self.blocked_transaction(self.store.deliver, "state", "fixture-code", "other")
        self.assertEqual(self.store.renew("state", "owner").code, "fixture-code")

    async def test_release_transaction_survives_waiter_cancellation(self):
        await self.blocked_transaction(self.store.release, "state", "owner")
        self.assertIsNone(self.store.renew("state", "owner"))

    async def test_sealed_worker_rejected_before_sql(self):
        generation = self.activities.begin()
        self.assertTrue(self.activities.seal(generation))
        with self.assertRaises(HTTPException) as error:
            await asyncio.to_thread(
                _handoff_call, self.activities, self.store.claim, "new", "owner"
            )
        self.assertEqual(error.exception.status_code, 503)
        self.assertIsNone(self.store.renew("new", "owner"))

    async def test_invalid_payload_releases_worker(self):
        with self.assertRaises(ValueError):
            await asyncio.to_thread(_handoff_call, self.activities, self.store.claim, "", "owner")
        self.assertTrue(self.activities.seal(self.activities.begin()))

    async def test_draining_allows_authenticated_delivery_and_cleanup(self):
        app = ServeApplication(activities=self.activities)
        app.include_router(build_handoff_router(self.store, activities=self.activities))
        generation = self.activities.begin()
        with patch.dict(os.environ, {HOST_PROCESS_KEY_ENV: "fixture-host"}):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://fixture"
            ) as client:
                response = await client.post(
                    "/api/auth/handoff/release", json={"state": "state", "owner_id": "owner"}
                )
                self.assertEqual(response.status_code, 403)
                headers = {HOST_PROCESS_HEADER: "fixture-host"}
                response = await client.post(
                    "/api/auth/handoff/deliver",
                    headers=headers,
                    json={"state": "state", "code": "fixture-code", "delivered_by": "other"},
                )
                self.assertEqual(response.json()["status"], "delivered")
                response = await client.post(
                    "/api/auth/handoff/renew",
                    headers=headers,
                    json={"state": "state", "owner_id": "owner"},
                )
                self.assertEqual(response.json()["code"], "fixture-code")
                response = await client.post(
                    "/api/auth/handoff/release",
                    headers=headers,
                    json={"state": "state", "owner_id": "owner"},
                )
                self.assertEqual(response.json()["status"], "released")
        self.assertTrue(self.activities.seal(generation))


if __name__ == "__main__":
    unittest.main()
