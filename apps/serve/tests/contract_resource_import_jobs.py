"""Durable background resource-import job contracts."""

from __future__ import annotations

import asyncio
import errno
import json
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.bootstrap import recover_startup_rows
from service.content.api.routes import register_content_routes
from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.identity.utils import OWNERSHIP_AXIS_MACHINE, OWNERSHIP_AXIS_STATE
from service.platform.activity import Activities
from service.platform.content import ImportMode
from service.resources.api.jobs import register_resource_import_routes
from service.resources.domain.jobs import (
    TERMINAL_IMPORT_STATUSES,
    ImportJobPhase,
    ImportJobStatus,
    ImportSourceResult,
    ImportSourceStatus,
    VersionInitializationProgress,
)
from service.resources.persistence.jobs import ImportJobStore
from service.resources.service.jobs import ResourceImportService, public_import_job

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


async def _complete(service: ResourceImportService, job_id: str) -> None:
    await service.start()
    try:
        for _attempt in range(100):
            if service.get(job_id, owner_id="local").status in TERMINAL_IMPORT_STATUSES:
                return
            await asyncio.sleep(0.05)
    finally:
        await service.aclose()


class ImportShutdownContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="import-shutdown-")
        self.addCleanup(self.directory.cleanup)
        self.activities = Activities()
        root = Path(self.directory.name)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        self.content = ContentService(
            ProjectRegistry(str(workspace), catalog), catalog, activities=self.activities
        )
        self.store = ImportJobStore(root / "imports.sqlite3")
        self.service = ResourceImportService(self.content, self.store, activities=self.activities)

    async def wait_for(self, predicate):
        async with asyncio.timeout(3):
            while not predicate():
                await asyncio.sleep(0.005)

    async def assert_disk_call_drained(self, method):
        entered, release = threading.Event(), threading.Event()
        original = getattr(self.store, method)

        def blocked(*args):
            entered.set()
            if not release.wait(3):
                raise TimeoutError("test disk barrier")
            return original(*args)

        with patch.object(self.store, method, side_effect=blocked):
            await self.service.start()
            closed = None
            try:
                await self.wait_for(entered.is_set)
                closed = asyncio.create_task(self.service.aclose())
                await asyncio.sleep(0.03)
                self.assertFalse(
                    closed.done(), "close returned while the real SQLite worker was live"
                )
                self.assertTrue(self.activities.snapshot().counts)
            finally:
                release.set()
                if closed is not None:
                    await closed
                else:
                    await self.service.aclose()
                await self.wait_for(lambda: not self.activities.snapshot().counts)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_close_joins_expiry_poll_thread(self):
        await self.assert_disk_call_drained("interrupt_expired")

    async def test_close_joins_claim_thread(self):
        await self.assert_disk_call_drained("claim")

    async def test_close_deadline_keeps_worker_owned_until_rejoined(self):
        entered, release = threading.Event(), threading.Event()
        original = self.store.claim

        def blocked(*args):
            entered.set()
            release.wait(3)
            return original(*args)

        with patch.object(self.store, "claim", side_effect=blocked):
            await self.service.start()
            try:
                await self.wait_for(entered.is_set)
                with self.assertRaises(TimeoutError):
                    await asyncio.wait_for(self.service.aclose(), 0.03)
                self.assertTrue(self.activities.snapshot().counts)
            finally:
                release.set()
                await self.service.aclose()
                await self.wait_for(lambda: not self.activities.snapshot().counts)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_close_wakes_idle_poll_without_cancelling_disk_work(self):
        claimed = threading.Event()
        original = self.store.claim

        def claim(*args):
            value = original(*args)
            claimed.set()
            return value

        with (
            patch.object(self.store, "claim", side_effect=claim),
            patch("service.resources.service.jobs.IMPORT_IDLE_SECONDS", 30),
        ):
            await self.service.start()
            await self.wait_for(claimed.is_set)
            await asyncio.sleep(0.01)
            await asyncio.wait_for(self.service.aclose(), 0.5)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_close_drains_the_real_copy_owner_and_its_final_receipt(self):
        root = Path(self.directory.name)
        source = root / "source.txt"
        source.write_text("owned import")
        content = self.content
        project = content.create_project("shutdown")
        self.service = ResourceImportService(content, self.store, activities=self.activities)
        job = self.service.create(
            owner_id="local",
            project_id=project.id,
            mode=ImportMode.COPY,
            target_dir="",
            sources=(str(source),),
            idempotency_key="closing-copy",
        )
        entered, release = threading.Event(), threading.Event()
        original = content.import_sources

        def blocked(*args, **kwargs):
            entered.set()
            release.wait(3)
            return original(*args, **kwargs)

        with patch.object(content, "import_sources", side_effect=blocked):
            await self.service.start()
            closed = None
            try:
                await self.wait_for(entered.is_set)
                closed = asyncio.create_task(self.service.aclose())
                await asyncio.sleep(0.03)
                self.assertFalse(closed.done())
            finally:
                release.set()
                if closed is not None:
                    await closed
                else:
                    await self.service.aclose()
        self.assertEqual(self.activities.snapshot().counts, {})
        self.assertIn(self.store.get(job.job_id, "local").status, TERMINAL_IMPORT_STATUSES)

    async def test_close_wakes_maintenance_wait_without_resuming_admission(self):
        generation = self.activities.begin()
        await self.service.start()
        await asyncio.sleep(0)
        await asyncio.wait_for(self.service.aclose(), 0.5)
        self.assertEqual(self.activities.snapshot().generation, generation)
        self.assertEqual(self.activities.snapshot().counts, {})


class ImportSchemaContract(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.database = Path(fixture.name) / "imports.sqlite3"

    def test_catalog_receipt_rolls_back_with_authorization(self):
        root = self.database.parent
        workspace, source = root / "workspace", root / "source"
        workspace.mkdir()
        source.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        content = ContentService(
            ProjectRegistry(str(workspace), catalog), catalog, activities=Activities()
        )
        project = content.create_project("receipt")
        plans = content.plan_import_roots(project.id, (str(source),), "resources")
        with patch(
            "service.content.persistence.catalog.json.dumps",
            side_effect=OSError("receipt disk failure"),
        ):
            with self.assertRaises(OSError):
                content.commit_import_roots(plans, receipt=("operation", "request"))
        self.assertEqual(content.external_roots(project.id), ())
        self.assertEqual(content.root_receipts(), ())

    def test_link_receipt_survives_process_death_and_recovers_without_reauthorization(self):
        root = self.database.parent
        workspace, source = root / "workspace", root / "source"
        workspace.mkdir()
        source.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        activities = Activities()
        content = ContentService(
            ProjectRegistry(str(workspace), catalog), catalog, activities=activities
        )
        project = content.create_project("receipt")
        store = ImportJobStore(self.database)
        service = ResourceImportService(content, store, activities=activities)
        job = service.create(
            owner_id="local",
            project_id=project.id,
            mode=ImportMode.LINK,
            target_dir="resources",
            sources=(str(source),),
            idempotency_key="receipt",
        )
        claimed = store.claim(service._worker_id, 30)
        request = service.link_receipt(claimed)
        script = """
import os, sys
from pathlib import Path
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.activity import Activities
catalog = ContentCatalog(Path(sys.argv[1]))
content = ContentService(ProjectRegistry(sys.argv[2], catalog), catalog, activities=Activities())
plans = content.plan_import_roots(sys.argv[3], (sys.argv[4],), 'resources')
content.commit_import_roots(plans, receipt=(sys.argv[5], sys.argv[6]))
os._exit(74)
"""
        child = subprocess.run(
            [
                sys.executable,
                "-c",
                script,
                str(catalog.path),
                str(workspace),
                project.id,
                str(source),
                job.job_id,
                request,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(child.returncode, 74, child.stdout + child.stderr)
        receipts = content.root_receipts()
        self.assertEqual(len(receipts), 1)
        self.assertEqual(
            store.get(job.job_id, "local").source_results[0].status, ImportSourceStatus.PENDING
        )
        registered = content.external_roots(project.id)[0]
        content.revoke_root(registered.root_id)
        # A failed result write may already have been projected as failure before shutdown.
        store.mark_pending_sources(
            job.job_id,
            service._worker_id,
            claimed.lease_generation,
            ImportSourceStatus.FAILED,
            error="storage_io_failed",
        )
        store.update(
            job.job_id,
            service._worker_id,
            claimed.lease_generation,
            status=ImportJobStatus.FAILED,
            phase=ImportJobPhase.COMPLETED,
            completed_items=0,
            completed_bytes=0,
            total_bytes=0,
            error="storage_io_failed",
        )
        receipt = receipts[0]
        mounts = tuple((row.project_id, row.mount_path) for row in receipt.roots)
        before = store.get(job.job_id, "local")
        wrong = json.loads(request)
        wrong["target_dir"] = "other"
        with self.assertRaises(ValueError):
            store.recover_link(job.job_id, json.dumps(wrong), mounts)
        self.assertEqual(store.get(job.job_id, "local"), before)

        def recover():
            recover_startup_rows(
                catalog.recovery_transaction,
                store.recovery_transaction,
                now=1234.0,
                recover_operations=True,
            )

        # The same receipt mutator must work on a private copy without repairing
        # the source. Freeze only the fixture clock to compare every stored row.
        with (
            closing(sqlite3.connect(self.database)) as source_db,
            closing(sqlite3.connect(":memory:")) as projected,
            closing(sqlite3.connect(catalog.path)) as content_db,
            closing(sqlite3.connect(":memory:")) as projected_content,
        ):
            source_db.backup(projected)
            content_db.backup(projected_content)
            projected.row_factory = sqlite3.Row
            projected_content.row_factory = sqlite3.Row
            original = tuple(source_db.iterdump())
            original_content = tuple(content_db.iterdump())
            with self.assertRaisesRegex(ValueError, "requires a transaction"):
                ImportJobStore.recover_link_rows(projected, job.job_id, request, mounts, now=1234.0)

            @contextmanager
            def transaction(connection):
                with connection:
                    connection.execute("BEGIN IMMEDIATE")
                    yield connection

            recover_link_rows = ImportJobStore.recover_link_rows

            def fail_after_result(*args, **kwargs):
                recover_link_rows(*args, **kwargs)
                raise OSError("result commit failed")

            with patch.object(ImportJobStore, "recover_link_rows", side_effect=fail_after_result):
                with self.assertRaisesRegex(OSError, "result commit failed"):
                    recover_startup_rows(
                        lambda: transaction(projected_content),
                        lambda: transaction(projected),
                        now=1234.0,
                        recover_operations=True,
                    )
            self.assertEqual(tuple(projected.iterdump()), original)
            self.assertEqual(tuple(projected_content.iterdump()), original_content)

            recover_startup_rows(
                lambda: transaction(projected_content),
                lambda: transaction(projected),
                now=1234.0,
                recover_operations=True,
            )
            ImportJobStore.inspect_rows(projected)
            ContentCatalog.inspect_rows(projected_content)
            expected_recovery = tuple(projected.iterdump())
            expected_content = tuple(projected_content.iterdump())
            self.assertEqual(tuple(source_db.iterdump()), original)
            self.assertEqual(tuple(content_db.iterdump()), original_content)
            self.assertEqual(store.get(job.job_id, "local"), before)

        with patch.object(
            ContentCatalog, "acknowledge_root_receipt_rows", side_effect=OSError("ack failure")
        ):
            with self.assertRaises(OSError):
                recover()
        with closing(sqlite3.connect(self.database)) as source_db:
            self.assertEqual(tuple(source_db.iterdump()), expected_recovery)
        recovered = store.get(job.job_id, "local")
        self.assertEqual(recovered.status, ImportJobStatus.PARTIAL)
        self.assertEqual(recovered.error, "resource_import_interrupted")
        self.assertEqual(recovered.source_results[0].status, ImportSourceStatus.SUCCEEDED)
        self.assertEqual(recovered.source_results[0].target_path, registered.mount_path)
        self.assertEqual(len(content.root_receipts()), 1)

        recover()
        with closing(sqlite3.connect(catalog.path)) as content_db:
            self.assertEqual(tuple(content_db.iterdump()), expected_content)
        self.assertEqual(store.get(job.job_id, "local"), recovered)
        self.assertEqual(content.root_receipts(), ())
        self.assertEqual(content.external_roots(project.id), ())
        self.assertIsNotNone(catalog.external_root(registered.root_id).revoked_at)
        self.assertTrue(source.is_dir())

    def test_process_death_during_source_batch_leaves_no_partial_receipts(self):
        store = ImportJobStore(self.database)
        job = store.create(
            owner_id="local",
            project_id="project",
            mode=ImportMode.LINK,
            target_dir="resources",
            sources=("a", "b"),
            request_digest="crash",
            idempotency_key="crash",
        )
        claimed = store.claim("worker", 30)
        before = store.get(job.job_id, "local")
        events = store.events(job.job_id, 0)
        script = """
import os, sys
from pathlib import Path
from service.resources.persistence.jobs import ImportJobStore
from service.resources.domain.jobs import ImportSourceResult, ImportSourceStatus
store = ImportJobStore(Path(sys.argv[1]))
append = store._append
calls = 0
def crash(*args):
    global calls
    append(*args)
    calls += 1
    if calls == 1:
        os._exit(73)
store._append = crash
store.record_source_results(sys.argv[2], 'worker', int(sys.argv[3]), tuple(
    ImportSourceResult(i, ImportSourceStatus.SUCCEEDED, '', name)
    for i, name in enumerate(('resources/a', 'resources/b'))
))
"""
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                script,
                str(self.database),
                job.job_id,
                str(claimed.lease_generation),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 73, result.stdout + result.stderr)
        recovered = ImportJobStore(self.database)
        self.assertEqual(recovered.get(job.job_id, "local"), before)
        self.assertEqual(recovered.events(job.job_id, 0), events)

    def test_source_batch_rolls_back_receipts_and_events_on_late_failure(self):
        for failure in ("source", "event"):
            with self.subTest(failure=failure):
                store = ImportJobStore(self.database.parent / (failure + ".sqlite3"))
                job = store.create(
                    owner_id="local",
                    project_id="project",
                    mode=ImportMode.LINK,
                    target_dir="resources",
                    sources=("a", "b"),
                    request_digest="batch",
                    idempotency_key="batch",
                )
                claimed = store.claim("worker", 30)
                before = store.get(job.job_id, "local")
                events = store.events(job.job_id, 0)
                results = tuple(
                    ImportSourceResult(index, ImportSourceStatus.SUCCEEDED, "", name)
                    for index, name in enumerate(("resources/a", "resources/b"))
                )
                with closing(sqlite3.connect(store.database)) as connection, connection:
                    if failure == "source":
                        connection.execute("""CREATE TRIGGER fail_batch BEFORE UPDATE ON
                            resource_import_results WHEN NEW.source_index = 1
                            BEGIN SELECT RAISE(ABORT, 'late source failure'); END""")
                    else:
                        connection.execute("""CREATE TRIGGER fail_batch BEFORE INSERT ON
                            resource_import_events WHEN NEW.event_type = 'job.source_result'
                            AND EXISTS (SELECT 1 FROM resource_import_results
                            WHERE source_index = 1 AND status = 'succeeded')
                            BEGIN SELECT RAISE(ABORT, 'late event failure'); END""")
                with self.assertRaises(sqlite3.IntegrityError):
                    store.record_source_results(
                        job.job_id, "worker", claimed.lease_generation, results
                    )
                self.assertEqual(store.get(job.job_id, "local"), before)
                self.assertEqual(store.events(job.job_id, 0), events)
                with closing(sqlite3.connect(store.database)) as connection, connection:
                    connection.execute("DROP TRIGGER fail_batch")
                self.assertFalse(
                    store.record_source_results(
                        job.job_id, "worker", claimed.lease_generation + 1, results
                    )
                )
                invalid = (
                    *results[:1],
                    ImportSourceResult(2, ImportSourceStatus.SUCCEEDED, "", "c"),
                )
                self.assertFalse(
                    store.record_source_results(
                        job.job_id, "worker", claimed.lease_generation, invalid
                    )
                )
                self.assertEqual(store.get(job.job_id, "local"), before)
                self.assertTrue(
                    store.record_source_results(
                        job.job_id, "worker", claimed.lease_generation, results
                    )
                )
                self.assertEqual(store.get(job.job_id, "local").source_results, results)
                self.assertEqual(len(store.events(job.job_id, 0)), len(events) + 2)

    def test_link_claim_rejects_stale_generation_cancel_and_expired_worker(self):
        root = self.database.parent
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        activities = Activities()
        content = ContentService(
            ProjectRegistry(str(workspace), catalog), catalog, activities=activities
        )
        project = content.create_project("LINK fence")
        store = ImportJobStore(self.database)
        service = ResourceImportService(content, store, activities=activities)
        for case in ("generation", "cancel", "expired", "owner"):
            with self.subTest(case=case):
                job = service.create(
                    owner_id="local",
                    project_id=project.id,
                    mode=ImportMode.LINK,
                    target_dir="resources",
                    sources=(str(root / case),),
                    idempotency_key=case,
                )
                claimed = store.claim(service._worker_id, -1 if case == "expired" else 30)
                self.assertEqual(claimed.job_id, job.job_id)
                if case == "cancel":
                    store.request_cancel(job.job_id, "local")
                if case == "expired":
                    store.interrupt_expired()
                before = store.get(job.job_id, "local")
                with patch.object(
                    store, "update", side_effect=AssertionError("stale LINK renewed claim")
                ):
                    with self.assertRaises(ContentError):
                        service.link_request(
                            job.job_id,
                            "other" if case == "owner" else "local",
                            claimed.lease_generation + (case == "generation"),
                        )
                self.assertEqual(store.get(job.job_id, "local"), before)

    def test_current_constructor_does_not_open_write_connection(self):
        ImportJobStore(self.database)
        with patch.object(
            ImportJobStore, "_connection", side_effect=AssertionError("unexpected write")
        ):
            ImportJobStore(self.database)

    def test_missing_inspection_does_not_create_database(self):
        missing = self.database.parent / "absent" / "imports.sqlite3"
        self.assertTrue(ImportJobStore.inspect_schema(missing).needs_write)
        self.assertFalse(missing.parent.exists())

    def test_interrupted_additive_initialization_rolls_back_ddl(self):
        ImportJobStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("ALTER TABLE resource_import_jobs DROP COLUMN event_seq")
            before = tuple(connection.iterdump())
        original = ImportJobStore.initialize_schema

        def interrupted(connection):
            original(connection)
            raise OSError("interrupted initialization")

        with patch.object(ImportJobStore, "initialize_schema", side_effect=interrupted):
            with self.assertRaises(OSError):
                ImportJobStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def job(self, sources=("source-a", "source-b")):
        return ImportJobStore(self.database).create(
            owner_id="local",
            project_id="project",
            mode=ImportMode.COPY,
            target_dir="resources",
            sources=sources,
            request_digest="digest",
            idempotency_key="key",
        )

    def test_both_backfills_restore_data_and_reach_current_format(self):
        job = self.job()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("DELETE FROM resource_import_results")
            connection.execute("UPDATE resource_import_jobs SET event_seq=0")
            expected_seq = connection.execute(
                "SELECT MAX(seq) FROM resource_import_events"
            ).fetchone()[0]
        schema = ImportJobStore.inspect_schema(self.database)
        self.assertTrue(schema.results_backfill)
        self.assertTrue(schema.events_backfill)
        restored = ImportJobStore(self.database).get(job.job_id, "local")
        self.assertEqual(len(restored.source_results), 2)
        self.assertEqual(restored.event_seq, expected_seq)
        self.assertFalse(ImportJobStore.inspect_schema(self.database).needs_write)

    def test_wal_inspection_is_visible_without_source_writes(self):
        self.job()
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("ALTER TABLE resource_import_jobs DROP COLUMN event_seq")
            writer.execute("DROP INDEX resource_import_events_job_seq")
            writer.commit()
            wal = Path(str(self.database) + "-wal")
            before = self.database.read_bytes(), wal.read_bytes()
            schema = ImportJobStore.inspect_schema(self.database)
            self.assertEqual(schema.add_columns, ("event_seq",))
            self.assertEqual(schema.create_indexes, ("resource_import_events_job_seq",))
            self.assertTrue(schema.events_backfill)
            self.assertEqual((self.database.read_bytes(), wal.read_bytes()), before)
            ImportJobStore(self.database)
            self.assertFalse(ImportJobStore.inspect_schema(self.database).needs_write)

    def test_unknown_structure_and_invalid_migration_sources_preserve_database(self):
        for index, statements in enumerate(
            (
                "ALTER TABLE resource_import_jobs ADD COLUMN future_scope TEXT",
                "DROP INDEX resource_import_events_job_seq; CREATE INDEX resource_import_events_job_seq ON resource_import_events(event_type)",
                "DELETE FROM resource_import_results; UPDATE resource_import_jobs SET sources_json='{}'; ALTER TABLE resource_import_jobs DROP COLUMN event_seq",
            )
        ):
            with self.subTest(index=index):
                self.database = self.database.with_name(f"unknown-{index}.sqlite3")
                self.job()
                with closing(sqlite3.connect(self.database)) as connection, connection:
                    connection.executescript(statements)
                    before = tuple(connection.iterdump())
                with patch.object(
                    ImportJobStore, "_connection", side_effect=AssertionError("unexpected write")
                ):
                    with self.assertRaises(RuntimeError):
                        ImportJobStore(self.database)
                with closing(sqlite3.connect(self.database)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)

    def test_partial_results_and_zero_events_do_not_trigger_replay(self):
        self.job()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("DELETE FROM resource_import_results WHERE source_index=1")
            connection.execute("DELETE FROM resource_import_events")
            connection.execute("UPDATE resource_import_jobs SET event_seq=0")
        self.assertFalse(ImportJobStore.inspect_schema(self.database).needs_write)
        with patch.object(
            ImportJobStore, "_connection", side_effect=AssertionError("unexpected write")
        ):
            ImportJobStore(self.database)

    def test_connection_initialization_failure_closes_handle(self):
        store = ImportJobStore(self.database)
        connection = sqlite3.connect(self.database)
        connection.set_authorizer(
            lambda action, *_: (
                sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_PRAGMA else sqlite3.SQLITE_OK
            )
        )
        with patch("service.resources.persistence.jobs.sqlite3.connect", return_value=connection):
            with self.assertRaises(sqlite3.DatabaseError):
                with store._connection():
                    self.fail("connection initialization should fail")
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")


def test_content_routes_queue_directory_transactions_without_runtime_confirmation() -> None:
    sessions = SimpleNamespace(
        project_session_ids=Mock(),
        publish_writable_roots=AsyncMock(side_effect=RuntimeError("settings confirmation timeout")),
    )
    operations = SimpleNamespace(submit=Mock(return_value="queued-operation"))
    app = FastAPI()
    app.state.session_service = sessions
    app.state.content_operations = operations
    register_content_routes(app)
    with TestClient(app) as client:
        for response in (
            client.post(
                "/api/content/roots",
                json={"project": "project", "source": "source", "mount": "linked.md"},
            ),
            client.delete("/api/content/roots/root?project=project"),
        ):
            assert response.status_code == 202
            assert response.json() == {"operation": "queued-operation", "state": "queued"}
    assert operations.submit.call_count == 2
    sessions.publish_writable_roots.assert_not_awaited()
    sessions.project_session_ids.assert_not_called()


def main() -> int:
    test_content_routes_queue_directory_transactions_without_runtime_confirmation()
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.TestSuite(
            unittest.defaultTestLoader.loadTestsFromTestCase(case)
            for case in (ImportSchemaContract, ImportShutdownContract)
        )
    )
    if not result.wasSuccessful():
        return 1
    root = Path(tempfile.mkdtemp(prefix="resource-import-jobs-"))
    workspace = root / "workspace"
    workspace.mkdir()
    catalog = ContentCatalog(root / "content.sqlite3")
    activities = Activities()
    content = ContentService(
        ProjectRegistry(str(workspace), catalog), catalog, activities=activities
    )
    project = content.create_project("导入任务")
    source = root / "source"
    source.mkdir()
    (source / "a.md").write_text("alpha\n", encoding="utf-8")
    (source / "b.md").write_text("beta\n", encoding="utf-8")
    source_bytes = {entry.name: entry.read_bytes() for entry in source.iterdir()}
    store = ImportJobStore(root / "imports.sqlite3")
    service = ResourceImportService(content, store, activities=activities)

    async def link_under_maintenance(job):
        # This fixture exercises job ownership, not native directory qualification.
        generation = activities.begin()
        assert activities.seal(generation), "LINK retained an import execution lease"
        try:

            def link():
                current = service.link_request(job.job_id, job.owner_id, job.lease_generation)
                sources = tuple(
                    current.sources[row.source_index]
                    for row in current.source_results
                    if row.status is ImportSourceStatus.PENDING
                )
                plans = content.plan_import_roots(current.project_id, sources, current.target_dir)
                service.record_links(current, content.commit_import_roots(plans))

            activities.run_maintenance(generation, link)
        finally:
            activities.resume(generation)

    service.bind_linker(link_under_maintenance)
    version_progress: list[VersionInitializationProgress] = []

    def initialize_versions(
        _project_id: str,
        _paths: tuple[str, ...],
        observer,
    ) -> None:
        discovered = VersionInitializationProgress(
            discovered_items=2, completed_items=0, total_items=0
        )
        version_progress.append(discovered)
        observer(discovered)
        for done in range(1, 3):
            progress = VersionInitializationProgress(
                discovered_items=2, completed_items=done, total_items=2
            )
            version_progress.append(progress)
            observer(progress)

    service.bind_version_initializer(initialize_versions)

    started = time.monotonic()
    job = service.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(source),),
        idempotency_key="copy-source",
    )
    check("admission persists before returning", job.status is ImportJobStatus.QUEUED)
    check("admission does not perform copy", time.monotonic() - started < 0.2)
    replay = service.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(source),),
        idempotency_key="copy-source",
    )
    check("idempotent admission returns the same job", replay.job_id == job.job_id)
    legacy_store = ImportJobStore(root / "legacy-import-jobs.sqlite3")
    legacy_job = legacy_store.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(source),),
        request_digest="legacy-digest",
        idempotency_key="legacy-active",
    )
    with sqlite3.connect(legacy_store.database) as connection:
        connection.execute(
            "DELETE FROM resource_import_results WHERE job_id = ?", (legacy_job.job_id,)
        )
    migrated = ImportJobStore(legacy_store.database).get(legacy_job.job_id, "local")
    check(
        "additive migration restores pending outcomes for active pre-result jobs",
        migrated is not None
        and len(migrated.source_results) == 1
        and migrated.source_results[0].status is ImportSourceStatus.PENDING,
        repr(migrated),
    )
    public_job = public_import_job(job)
    check(
        "public projection exposes safe source names without absolute paths",
        public_job["source_names"] == [source.name]
        and public_job["source_summary"]
        == {"total": 1, "succeeded": 0, "failed": 0, "cancelled": 0}
        and public_job["source_results"][0]["source_name"] == source.name
        and public_job["source_results"][0]["status"] == "pending"
        and str(source) not in repr(public_job),
        repr(public_job),
    )

    first = store.claim("worker-a", 60)
    second = store.claim("worker-b", 60)
    check("atomic claim fences a second worker", first is not None and second is None)
    store.update(
        job.job_id,
        "worker-a",
        first.lease_generation if first is not None else 0,
        status=ImportJobStatus.QUEUED,
        phase=first.phase if first is not None else job.phase,
        completed_items=0,
        completed_bytes=0,
        total_bytes=0,
    )
    asyncio.run(_complete(service, job.job_id))
    completed = service.get(job.job_id, owner_id="local")
    progress_events = store.events(job.job_id, job.event_seq)
    scan_events = [
        event
        for event in progress_events
        if event.data.get("phase") == "scanning" and event.data.get("scan_discovered_items", 0) > 0
    ]
    check(
        "background worker publishes copied files",
        completed.status is ImportJobStatus.COMPLETED
        and completed.completed_items == 2
        and completed.total_items == 2
        and completed.completed_bytes == sum(map(len, source_bytes.values()))
        and completed.scan_discovered_items >= 3
        and completed.version_discovered_items == 2
        and completed.version_completed_items == 2
        and completed.version_total_items == 2
        and completed.source_results[0].status is ImportSourceStatus.SUCCEEDED
        and version_progress
        == [
            VersionInitializationProgress(2, 0, 0),
            VersionInitializationProgress(2, 1, 2),
            VersionInitializationProgress(2, 2, 2),
        ]
        and all(
            (Path(project.root) / "resources" / "source" / name).read_bytes() == payload
            for name, payload in source_bytes.items()
        ),
        repr(completed),
    )

    good_source = root / "good.md"
    missing_source = root / "missing.md"
    good_source.write_text("good\n", encoding="utf-8")
    partial_job = service.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(good_source), str(missing_source)),
        idempotency_key="partial-copy",
    )
    asyncio.run(_complete(service, partial_job.job_id))
    partial = service.get(partial_job.job_id, owner_id="local")
    check(
        "copy jobs persist one outcome per selected source and continue after a planning failure",
        partial.status is ImportJobStatus.PARTIAL
        and [result.status for result in partial.source_results]
        == [ImportSourceStatus.SUCCEEDED, ImportSourceStatus.FAILED]
        and partial.source_results[1].error == "source_not_found"
        and partial.source_results[0].target_path.endswith("good.md"),
        repr(partial),
    )
    missing_source.write_text("now present\n", encoding="utf-8")
    retried = service.retry(partial.job_id, owner_id="local")
    asyncio.run(_complete(service, partial.job_id))
    after_retry = service.get(partial.job_id, owner_id="local")
    check(
        "retry selects only failed sources and does not duplicate a previous success",
        retried.source_results[0].status is ImportSourceStatus.SUCCEEDED
        and retried.source_results[1].status is ImportSourceStatus.PENDING
        and after_retry.status is ImportJobStatus.COMPLETED
        and all(
            result.status is ImportSourceStatus.SUCCEEDED for result in after_retry.source_results
        )
        and (Path(project.root) / "resources" / "good.md").is_file()
        and not (Path(project.root) / "resources" / "good (2).md").exists()
        and (Path(project.root) / "resources" / "missing.md").is_file(),
        repr(after_retry),
    )
    check(
        "durable events carry phase-specific counters after the snapshot cursor",
        bool(progress_events)
        and bool(scan_events)
        and progress_events[-1].seq == completed.event_seq
        and progress_events[-1].data["scan_discovered_items"] >= 3
        and progress_events[-1].data["version_discovered_items"] == 2
        and progress_events[-1].data["version_completed_items"] == 2,
        repr(progress_events[-1] if progress_events else None),
    )

    link_project = content.create_project("关联任务")
    link_source = root / "linked-source"
    link_source.mkdir()
    (link_source / "linked.md").write_text("linked\n", encoding="utf-8")
    linked_job = service.create(
        owner_id="local",
        project_id=link_project.id,
        mode=ImportMode.LINK,
        target_dir="resources",
        sources=(str(link_source),),
        idempotency_key="link-source",
    )
    asyncio.run(_complete(service, linked_job.job_id))
    linked = service.get(linked_job.job_id, owner_id="local")
    link_phases = list(
        dict.fromkeys(
            event.data.get("phase")
            for event in store.events(linked_job.job_id, linked_job.event_seq)
        )
    )
    check(
        "link jobs expose linking, versioning and completion in order",
        linked.status is ImportJobStatus.COMPLETED
        and linked.completed_items == 1
        and link_phases == ["linking", "versioning", "completed"],
        repr(link_phases),
    )

    copy_after_link_job = service.create(
        owner_id="local",
        project_id=link_project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(link_source),),
        idempotency_key="copy-after-link",
    )
    asyncio.run(_complete(service, copy_after_link_job.job_id))
    copy_after_link = service.get(copy_after_link_job.job_id, owner_id="local")
    check(
        "copy after link renames instead of colliding with the virtual mount",
        copy_after_link.status is ImportJobStatus.COMPLETED
        and copy_after_link.source_results[0].target_path == "resources/linked-source (2)"
        and (Path(link_project.root) / "resources" / "linked-source (2)" / "linked.md").is_file()
        and not (Path(link_project.root) / "resources" / "linked-source").exists(),
        repr(copy_after_link),
    )

    copy_then_link_project = content.create_project("先复制后关联")
    copied_first_job = service.create(
        owner_id="local",
        project_id=copy_then_link_project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(link_source),),
        idempotency_key="copy-before-link",
    )
    asyncio.run(_complete(service, copied_first_job.job_id))
    linked_second_job = service.create(
        owner_id="local",
        project_id=copy_then_link_project.id,
        mode=ImportMode.LINK,
        target_dir="resources",
        sources=(str(link_source),),
        idempotency_key="link-after-copy",
    )
    asyncio.run(_complete(service, linked_second_job.job_id))
    copied_first = service.get(copied_first_job.job_id, owner_id="local")
    linked_second = service.get(linked_second_job.job_id, owner_id="local")
    check(
        "link after copy renames instead of rejecting the occupied local name",
        copied_first.status is ImportJobStatus.COMPLETED
        and copied_first.source_results[0].target_path == "resources/linked-source"
        and linked_second.status is ImportJobStatus.COMPLETED
        and linked_second.source_results[0].target_path == "resources/linked-source (2)"
        and content.external_roots(copy_then_link_project.id)[0].mount_path
        == "resources/linked-source (2)",
        repr(linked_second),
    )

    queued = service.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.LINK,
        target_dir="resources",
        sources=(str(source),),
        idempotency_key="cancel-source",
    )
    cancelled = service.cancel(queued.job_id, owner_id="local")
    check("queued cancellation becomes terminal", cancelled.status is ImportJobStatus.CANCELLED)

    orphan = service.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.LINK,
        target_dir="resources",
        sources=(str(source),),
        idempotency_key="orphan-source",
    )
    claimed_orphan = store.claim("orphaned-worker", 0.01)
    time.sleep(0.02)
    interrupted = store.interrupt_expired()
    orphan_after_restart = service.get(orphan.job_id, owner_id="local")
    check(
        "restart fails orphaned filesystem work instead of replaying side effects",
        claimed_orphan is not None
        and interrupted == 1
        and orphan_after_restart.status is ImportJobStatus.FAILED
        and orphan_after_restart.error == "resource_import_interrupted",
        repr(orphan_after_restart),
    )

    for key, error, expected in (
        ("disk-full", OSError(errno.ENOSPC, "full"), "disk_full"),
        ("storage-io", sqlite3.OperationalError("disk I/O error"), "storage_io_failed"),
    ):
        if isinstance(error, sqlite3.Error):
            error.sqlite_errorcode = sqlite3.SQLITE_IOERR
        failed_job = service.create(
            owner_id="local",
            project_id=project.id,
            mode=ImportMode.COPY,
            target_dir="resources",
            sources=(str(source),),
            idempotency_key=key,
        )
        with patch.object(content, "import_sources", side_effect=error):
            asyncio.run(_complete(service, failed_job.job_id))
        failed = service.get(failed_job.job_id, owner_id="local")
        check(
            f"background failure preserves actionable storage reason: {expected}",
            failed.status is ImportJobStatus.FAILED
            and failed.error == expected
            and failed.source_results[0].error == expected,
            repr(failed),
        )

    copy_full_job = service.create(
        owner_id="local",
        project_id=project.id,
        mode=ImportMode.COPY,
        target_dir="resources",
        sources=(str(source),),
        idempotency_key="copy-disk-full",
    )
    with patch(
        "service.content.service.port._stable_source",
        side_effect=OSError(errno.ENOSPC, "full"),
    ):
        asyncio.run(_complete(service, copy_full_job.job_id))
    copy_full = service.get(copy_full_job.job_id, owner_id="local")
    check(
        "file-copy ENOSPC remains disk_full through the ContentError boundary",
        copy_full.status is ImportJobStatus.FAILED
        and copy_full.error == "disk_full"
        and copy_full.source_results[0].error == "disk_full",
        repr(copy_full),
    )

    first_root = root / "first" / "duplicate"
    second_root = root / "second" / "duplicate"
    first_root.mkdir(parents=True)
    second_root.mkdir(parents=True)
    try:
        content.authorize_roots(
            project.id,
            (str(first_root), str(second_root)),
            (first_root.name, second_root.name),
        )
    except ContentError as error:
        atomic_error = error.code
    else:
        atomic_error = ""
    check(
        "batch link conflict leaves zero partial authorization",
        atomic_error == "root_exists" and content.external_roots(project.id) == (),
        atomic_error,
    )

    api_store = ImportJobStore(root / "api-imports.sqlite3")
    api_service = ResourceImportService(content, api_store, activities=Activities())
    app = FastAPI()
    app.state.content = content
    app.state.resource_imports = api_service
    app.state.auth_enabled = False
    setattr(app.state, OWNERSHIP_AXIS_STATE, OWNERSHIP_AXIS_MACHINE)
    register_resource_import_routes(app)
    with TestClient(app) as client:
        response = client.post(
            "/api/resource/import-jobs",
            headers={"Idempotency-Key": "api-copy"},
            json={
                "project": project.id,
                "mode": "copy",
                "sources": [str(source)],
                "target_dir": "",
            },
        )
    check(
        "HTTP admission returns 202 and a queued job",
        response.status_code == 202
        and response.json()["job"]["status"] == "queued"
        and response.json()["job"]["event_seq"] > 0
        and response.json()["job"]["scan_discovered_items"] == 0,
        response.text,
    )

    print(f"\nresource import jobs: {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
