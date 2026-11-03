"""PDF executor shutdown retains its real worker through lifespan cancellation."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import sqlite3
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import httpx

from service.platform.activity import Activities, ActivityDomain, MaintenanceActive
from service.platform.citations import CitationDocument
from service.platform.http_activity import ServeApplication
from service.platform.pdf import pdf_document_info
from service.workbench.service.indexing import PdfIndexService
from tests import pdf as pdf_fixture

WAIT_SECONDS = 10


async def eventually(condition) -> None:
    async with asyncio.timeout(WAIT_SECONDS):
        while not condition():
            await asyncio.sleep(0.001)


class IndexShutdownContracts(unittest.IsolatedAsyncioTestCase):
    def fixture(self, *, workbench_ready=None):
        temporary = tempfile.TemporaryDirectory(prefix="index-direct-")
        self.addCleanup(temporary.cleanup)
        database = Path(temporary.name) / "index.sqlite3"
        content = Mock()
        content.resolve.return_value = str(database)
        activities = Activities(workbench_ready=workbench_ready)
        indexes = PdfIndexService(content, activities=activities)
        self.addCleanup(indexes.close)
        with pdf_fixture.open() as pdf:
            pdf.new_page().insert_text((50, 50), "Shutdown waits for this page.")
            payload = pdf.tobytes()
        document = CitationDocument(
            "project",
            "paper.pdf",
            "Paper",
            "sha256:" + hashlib.sha256(payload).hexdigest(),
            payload,
        )
        return indexes, activities, document, database

    async def test_warming_status_read_cannot_create_pdf_schema(self):
        ready = False
        indexes, activities, document, database = self.fixture(workbench_ready=lambda: ready)
        with activities.enter(ActivityDomain.STARTUP):
            with self.assertRaises(MaintenanceActive):
                indexes.status(document)
        self.assertFalse(database.exists())
        self.assertFalse(indexes._jobs)
        ready = True
        self.assertEqual(indexes.status(document)["state"], "unindexed")
        self.assertTrue(database.exists())

    async def test_direct_http_call_during_maintenance_returns_503_without_creating_database(self):
        indexes, activities, document, database = self.fixture()
        app = ServeApplication(activities=activities)

        @app.get("/index")
        def index():
            return indexes.status(document)

        generation = activities.begin()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/index")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": "update_maintenance"})
        self.assertEqual(response.headers["Retry-After"], "1")
        self.assertFalse(database.exists())
        self.assertTrue(activities.seal(generation))

    async def test_close_waits_for_direct_metadata_commit(self) -> None:
        indexes, activities, document, database = self.fixture()
        parsed, release = threading.Event(), threading.Event()

        def parse(payload):
            result = pdf_document_info(payload)
            parsed.set()
            if not release.wait(WAIT_SECONDS):
                raise TimeoutError("test did not release metadata commit")
            return result

        with patch("service.workbench.service.indexing.pdf_document_info", side_effect=parse):
            reading = asyncio.create_task(asyncio.to_thread(indexes.page_count, document))
            closing = None
            try:
                await eventually(parsed.is_set)
                generation = activities.begin()
                closing = asyncio.create_task(indexes.aclose())
                await eventually(lambda: indexes._closed)
                await asyncio.sleep(0)
                self.assertFalse(closing.done())
                self.assertFalse(activities.seal(generation))
                release.set()
                self.assertEqual(await reading, 1)
                await closing
                with contextlib.closing(sqlite3.connect(database)) as connection:
                    self.assertEqual(
                        connection.execute(
                            "SELECT page_count FROM workbench_pdf_metadata"
                        ).fetchone(),
                        (1,),
                    )
                self.assertTrue(activities.seal(generation))
            finally:
                release.set()
                await asyncio.gather(
                    reading, *([closing] if closing else []), return_exceptions=True
                )

    async def test_closed_service_refuses_all_public_database_entries(self) -> None:
        indexes, _, document, database = self.fixture()
        await indexes.aclose()
        with patch("service.workbench.service.indexing.SERVICE_LITERATURE_DATABASE", database):
            for operation in (
                lambda: indexes.status(document),
                lambda: indexes.index(document),
                lambda: indexes.page_count(document),
                lambda: indexes.pages(document, 1, 1),
                lambda: indexes.prepare(document),
                lambda: indexes.forget_literature((document.revision,)),
            ):
                with self.assertRaisesRegex(ValueError, "pdf_index_closed"):
                    operation()
        self.assertFalse(database.exists())

    async def test_close_cannot_miss_a_parser_being_spawned(self) -> None:
        indexes, _, document, _ = self.fixture()
        spawned, release = threading.Event(), threading.Event()
        original = subprocess.Popen
        processes = []

        def spawning(*args, **kwargs):
            process = original(*args, **kwargs)
            processes.append(process)
            spawned.set()
            if not release.wait(WAIT_SECONDS):
                process.kill()
                process.wait()
                raise TimeoutError("test did not release parser registration")
            return process

        with patch("service.workbench.service.indexing.subprocess.Popen", side_effect=spawning):
            reading = asyncio.create_task(asyncio.to_thread(indexes.pages, document, 1, 1))
            closing = None
            try:
                await eventually(spawned.is_set)
                closing = asyncio.create_task(indexes.aclose())
                # The close thread must either hold admission closed or still
                # wait for the same lock as the in-flight Popen registration.
                for _ in range(10):
                    await asyncio.sleep(0.001)
                self.assertFalse(closing.done())
                release.set()
                await asyncio.gather(reading, return_exceptions=True)
                await closing
                self.assertTrue(all(process.poll() is not None for process in processes))
                self.assertFalse(indexes._processes)
            finally:
                release.set()
                await asyncio.gather(
                    reading, *([closing] if closing else []), return_exceptions=True
                )
                for process in processes:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=WAIT_SECONDS)

    async def test_parser_transport_failure_reaps_the_real_child_and_closes_pipes(self) -> None:
        indexes, activities, document, _ = self.fixture()
        indexes.page_count(document)
        original = subprocess.Popen
        processes = []
        patchers = []

        def broken_transport(*args, **kwargs):
            process = original(*args, **kwargs)
            processes.append(process)
            patcher = patch.object(
                process, "communicate", side_effect=OSError("injected parser transport failure")
            )
            patcher.start()
            patchers.append(patcher)
            return process

        try:
            with patch(
                "service.workbench.service.indexing.subprocess.Popen", side_effect=broken_transport
            ):
                with self.assertRaisesRegex(OSError, "injected parser transport failure"):
                    await asyncio.to_thread(indexes.pages, document, 1, 1)
            self.assertEqual(len(processes), 1)
            process = processes[0]
            self.assertIsNotNone(process.poll())
            self.assertTrue(process.stdin.closed)
            self.assertTrue(process.stderr.closed)
            self.assertFalse(indexes._processes)
            self.assertFalse(activities.snapshot().counts)
            await indexes.aclose()
        finally:
            for patcher in patchers:
                patcher.stop()
            for process in processes:
                with process:
                    if process.poll() is None:
                        process.kill()

    async def test_repeated_cancellation_waits_for_actual_executor_completion(self) -> None:
        with tempfile.TemporaryDirectory(prefix="index-shutdown-") as directory:
            activities = Activities()
            indexes = PdfIndexService(Mock(), activities=activities)
            entered, release = threading.Event(), threading.Event()
            output = Path(directory) / "settled"

            def worker() -> None:
                entered.set()
                if not release.wait(WAIT_SECONDS):
                    raise TimeoutError("test did not release its worker")
                output.write_text("finished", encoding="utf-8")

            job = activities.submit(indexes._executor, ActivityDomain.INDEX, worker)
            closing = other = None
            try:
                await eventually(entered.is_set)
                generation = activities.begin()
                closing = asyncio.create_task(indexes.aclose())
                other = asyncio.create_task(indexes.aclose())
                await eventually(lambda: indexes._closed)
                for _ in range(3):
                    closing.cancel()
                    await asyncio.sleep(0)
                    await asyncio.sleep(0)
                    self.assertFalse(closing.done())
                    self.assertFalse(other.done())
                    self.assertFalse(output.exists())
                    self.assertFalse(activities.seal(generation))
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await closing
                await other
                job.result(timeout=WAIT_SECONDS)
                self.assertEqual(output.read_text(encoding="utf-8"), "finished")
                self.assertTrue(activities.seal(generation))
                with self.assertRaises(RuntimeError):
                    indexes._executor.submit(lambda: None)
                # A completed close is safe to await again without new activity.
                await indexes.aclose()
            finally:
                release.set()
                if closing is not None:
                    await asyncio.gather(closing, other, return_exceptions=True)
                indexes.close()

    async def test_shutdown_error_and_cancellation_are_both_preserved(self) -> None:
        indexes = PdfIndexService(Mock(), activities=Activities())
        entered, release = threading.Event(), threading.Event()
        original = indexes.close
        failure = OSError("injected shutdown receipt failure")

        def fail_after_close() -> None:
            entered.set()
            if not release.wait(WAIT_SECONDS):
                raise TimeoutError("test did not release its close")
            original()
            raise failure

        with patch.object(indexes, "close", side_effect=fail_after_close) as close:
            pending = asyncio.create_task(indexes.aclose())
            try:
                await eventually(entered.is_set)
                pending.cancel()
                await asyncio.sleep(0)
                self.assertFalse(pending.done())
                release.set()
                with self.assertRaises(BaseExceptionGroup) as caught:
                    await pending
                self.assertIs(caught.exception.exceptions[0], failure)
                self.assertIsInstance(caught.exception.exceptions[1], asyncio.CancelledError)
                with self.assertRaises(OSError) as repeated:
                    await indexes.aclose()
                self.assertIs(repeated.exception, failure)
                close.assert_called_once()
            finally:
                release.set()
                await asyncio.gather(pending, return_exceptions=True)
                original()


if __name__ == "__main__":
    unittest.main()
