"""Persistent archive failures exposed through the resource HTTP boundary."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import threading
import unittest
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE
from service.platform.activity import Activities, MaintenanceActive
from service.platform.resources import PendingOrigin, TurnOutcome, VersionOrigin
from service.resources.api.versions import register_version_routes
from service.resources.persistence.objects import CasStore
from service.resources.persistence.version import VersionStore
from service.resources.service.activation import ResourceActivation
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore


class Settings:
    def max_versions_per_file(self) -> int:
        return 50

    def max_version_file_size_kb(self) -> int:
        return 1024

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return ()

    def version_mode(self) -> str:
        return "whitelist"

    def version_migration_required(self) -> bool:
        return False

    def version_include_patterns(self) -> tuple[str, ...] | None:
        return None


class FinalizationContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="resource-finalization-")
        root = Path(self.temporary.name)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog, activities=Activities())
        self.project = registry.create("归档状态")
        self.other = registry.create("其他项目")
        self.target = Path(self.project.root) / "resources/notes.md"
        self.target.write_bytes(b"initial\n")
        settings, formats = Settings(), WorkbenchFormatPolicy()
        retention = ResourceRetentionService(self.content, settings)
        annotations = PdfRecordStore(self.content)
        self.versions = ResourceVersionService(
            self.content,
            retention,
            formats,
            annotations,
        )
        self.supervisor = ResourceVersionSupervisor(
            self.content, self.versions, formats, settings, activities=Activities()
        )
        self.deliveries = ResourceDeliveryService(
            self.content, self.versions, self.supervisor, activities=self.supervisor._activities
        )
        self.supervisor.bind_preparation(
            ResourceActivation(
                self.content,
                ResourceRecoveryService(self.content, retention, annotations),
                self.versions,
                self.deliveries,
                retention,
                ResourceReviewMigration(self.content, self.versions),
            )
        )
        app = FastAPI()
        self.app = app
        app.state.resource_deliveries = self.deliveries
        self.resumed_finalizations: list[tuple[str, str]] = []

        async def resume(session_id: str, turn_id: str) -> None:
            self.resumed_finalizations.append((session_id, turn_id))

        app.state.resume_resource_finalization = resume
        register_version_routes(app)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        )
        self.params = {"project": self.project.id, "session_id": "session"}
        self.url = "/api/resource/finalizations"

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        await self.supervisor.aclose()
        self.temporary.cleanup()

    async def begin(self, turn: str = "turn") -> None:
        await self.deliveries.begin_turn("session", turn, self.project.root)
        await self.deliveries.bind_turn("session", turn, turn, "generation")
        self.target.write_bytes(b"terminal bytes\n")
        await self.deliveries.record_change(
            "session", turn, str(self.target), "update", generation="generation"
        )

    async def test_unchanged_turn_records_resource_finalization_timings(self) -> None:
        self.target.with_name("other.md").write_bytes(b"other\n")
        await self.deliveries.begin_turn("session", "turn", self.project.root)
        prefix = "resources.versions.delivery.timing "

        with (
            self.assertLogs("service.resources.service.delivery", level="INFO") as logs,
            patch.object(
                CasStore, "put_stream", autospec=True, side_effect=CasStore.put_stream
            ) as put,
            patch.object(CasStore, "verify", autospec=True, side_effect=CasStore.verify) as verify,
            patch.object(CasStore, "spool", autospec=True, side_effect=CasStore.spool) as spool,
        ):
            result = await self.deliveries.finish_turn("session", "turn", TurnOutcome.COMPLETED)

        put.assert_not_called()
        verify.assert_not_called()
        spool.assert_called_once()
        records = [record.getMessage() for record in logs.records]
        timings = [
            json.loads(record.removeprefix(prefix))
            for record in records
            if record.startswith(prefix)
        ]
        self.assertEqual(len(timings), 1)
        timing = timings[0]
        self.assertEqual(timing["session_id"], "session")
        self.assertEqual(timing["turn_id"], "turn")
        self.assertEqual(timing["compared_count"], 2)
        self.assertEqual(timing["compared_bytes"], len(b"initial\nother\n"))
        self.assertEqual(timing["unchanged_count"], 2)
        self.assertEqual(timing["snapshot_count"], 0)
        self.assertEqual(timing["snapshot_bytes"], 0)
        self.assertEqual(timing["review_file_count"], 0)
        self.assertEqual(result.file_ids, ())
        phase_keys = ("worker_wait_ms", "writer_wait_ms", "scan_ms", "snapshot_ms", "other_ms")
        self.assertTrue(all(timing[key] >= 0 for key in phase_keys))
        self.assertAlmostEqual(
            sum(timing[key] for key in phase_keys), timing["total_ms"], delta=0.01
        )

    async def assert_external_edit_finalized(self, expected: bytes) -> None:
        result = await self.deliveries.finish_turn("session", "turn", TurnOutcome.COMPLETED)
        self.assertEqual(result.file_ids, ())
        store = self.deliveries._store(self.project.id)
        path = "resources/notes.md"
        working = store.capability_states((path,))[path]
        self.assertEqual(working.working_revision, f"sha256:{sha256(expected).hexdigest()}")
        pending = store.pending(working.file_id)
        self.assertIsNotNone(pending)
        self.assertEqual(pending.origin, PendingOrigin.EXTERNAL)
        self.assertFalse(pending.needs_review)

    async def test_unchanged_next_baseline_verifies_its_existing_object_once(self) -> None:
        await self.deliveries.begin_turn("session", "first", self.project.root)
        await self.deliveries.finish_turn("session", "first", TurnOutcome.COMPLETED)
        with (
            patch.object(
                CasStore, "put_stream", autospec=True, side_effect=CasStore.put_stream
            ) as put,
            patch.object(CasStore, "verify", autospec=True, side_effect=CasStore.verify) as verify,
        ):
            await self.deliveries.begin_turn("session", "second", self.project.root)
        put.assert_not_called()
        verify.assert_called_once()
        self.assertEqual(
            verify.call_args.args[1], f"sha256:{sha256(self.target.read_bytes()).hexdigest()}"
        )

    async def test_same_size_external_edit_with_restored_mtime_is_captured(self) -> None:
        await self.deliveries.begin_turn("session", "turn", self.project.root)
        baseline = self.target.stat()
        updated = b"updated\n"
        self.target.write_bytes(updated)
        os.utime(self.target, ns=(baseline.st_atime_ns, baseline.st_mtime_ns))
        current = self.target.stat()
        self.assertEqual(current.st_size, baseline.st_size)
        self.assertEqual(current.st_mtime_ns, baseline.st_mtime_ns)
        await self.assert_external_edit_finalized(updated)

    async def test_atomic_replacement_with_same_size_and_mtime_is_captured(self) -> None:
        await self.deliveries.begin_turn("session", "turn", self.project.root)
        baseline = self.target.stat()
        updated = b"swapped\n"
        replacement = self.target.with_name("replacement.tmp")
        replacement.write_bytes(updated)
        os.utime(replacement, ns=(baseline.st_atime_ns, baseline.st_mtime_ns))
        replacement.replace(self.target)
        current = self.target.stat()
        self.assertEqual(current.st_size, baseline.st_size)
        self.assertEqual(current.st_mtime_ns, baseline.st_mtime_ns)
        await self.assert_external_edit_finalized(updated)

    async def test_next_turn_keeps_the_external_baseline_and_previous_terminal(self) -> None:
        stage = self.enterContext(
            patch.object(
                VersionStore,
                "stage_delivery",
                autospec=True,
                side_effect=VersionStore.stage_delivery,
            )
        )
        await self.begin("first")
        first_result = await self.deliveries.finish_turn("session", "first", TurnOutcome.COMPLETED)
        terminal = self.target.read_bytes()
        store = self.deliveries._store(self.project.id)
        (first,) = stage.call_args.args[-1]
        self.assertEqual(first.snapshot.revision, f"sha256:{sha256(terminal).hexdigest()}")

        metadata = self.target.stat()
        external = b"external bytes\n"
        self.assertEqual(len(external), len(terminal))
        replacement = self.target.with_name("outside.tmp")
        replacement.write_bytes(external)
        os.utime(replacement, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
        replacement.replace(self.target)
        self.assertEqual(self.target.stat().st_mtime_ns, metadata.st_mtime_ns)

        await self.deliveries.begin_turn("session", "second", self.project.root)
        await self.deliveries.bind_turn("session", "second", "second", "generation")
        (baseline,) = store.turn_baselines("session", "second")
        self.assertEqual(baseline.revision, f"sha256:{sha256(external).hexdigest()}")
        updated = b"second agent edit\n"
        self.target.write_bytes(updated)
        await self.deliveries.record_change(
            "session", "second", str(self.target), "update", generation="generation"
        )
        await self.deliveries.finish_turn("session", "second", TurnOutcome.COMPLETED)
        (second,) = stage.call_args.args[-1]
        self.assertEqual(second.baseline, baseline)
        self.assertEqual(second.snapshot.revision, f"sha256:{sha256(updated).hexdigest()}")
        self.assertEqual([call.args[2] for call in stage.call_args_list], ["first", "second"])
        self.assertEqual(store.review_result("session", "first"), first_result)

    def test_capture_batch_reads_the_current_mount_grant(self) -> None:
        external = Path(self.temporary.name) / "outside"
        external.mkdir()
        (external / "note.md").write_bytes(b"external\n")
        grant = self.content.authorize_root(self.project.id, str(external), "linked")
        path = f"{grant.mount_path}/note.md"
        with self.content.capture_stable_batch(self.project.id) as capture:
            stream = BytesIO()
            capture(path, 1024, stream)
            self.assertEqual(stream.read(), b"external\n")
            self.content.revoke_root(grant.root_id)
            with self.assertRaises(ContentError):
                capture(path, 1024, BytesIO())

    async def test_turn_scans_once_and_records_prior_presence_outside_version_policy(self) -> None:
        self.target.with_name("opaque.bin").write_bytes(b"unmanaged input")
        repository = self.target.parent / "repository"
        repository.mkdir()
        (repository / ".git").mkdir()
        (repository / "notes.md").write_bytes(b"git-managed input")

        with (
            patch.object(
                self.content, "scan_resource_inventory", wraps=self.content.scan_resource_inventory
            ) as scan,
            self.assertLogs("service.resources.service.delivery", level="INFO") as logs,
        ):
            await self.deliveries.begin_turn("session", "turn", self.project.root)

        scan.assert_called_once()
        prefix = "resources.versions.baseline.timing "
        (timing,) = [
            json.loads(record.getMessage().removeprefix(prefix))
            for record in logs.records
            if record.getMessage().startswith(prefix)
        ]
        self.assertEqual(timing["baseline_count"], 1)
        self.assertTrue(all(timing[key] >= 0 for key in ("scan_ms", "capture_ms", "total_ms")))
        store = VersionStore(
            self.content.resolve(self.project.id, PROJECT_DB_RELATIVE), self.project.root
        )
        self.assertEqual(
            store.turn_inventory("session", "turn"), {"resources/notes.md", "resources/opaque.bin"}
        )
        baselines = store.turn_baselines("session", "turn")
        self.assertEqual([baseline.path for baseline in baselines], ["resources/notes.md"])

    async def test_cancelled_finalization_remains_busy_until_snapshot_is_committed(self) -> None:
        await self.begin()
        gate = self.supervisor._activities
        entered, release = threading.Event(), threading.Event()
        original = self.deliveries._finish

        def finish(*args):
            entered.set()
            if not release.wait(10):
                raise TimeoutError("finalization thread was not released")
            return original(*args)

        with patch.object(self.deliveries, "_finish", side_effect=finish):
            task = asyncio.create_task(
                self.deliveries.finish_turn("session", "turn", TurnOutcome.COMPLETED)
            )
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 10))
                generation = gate.begin()
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertFalse(gate.seal(generation))
                with self.assertRaises(MaintenanceActive):
                    await self.deliveries.retry_finalization(
                        self.project.id, "session", "turn", "retry"
                    )
            finally:
                release.set()
                async with asyncio.timeout(10):
                    while gate.snapshot().counts:
                        await asyncio.sleep(0.01)
        result = self.deliveries._store(self.project.id).review_result("session", "turn")
        self.assertIsNotNone(result)
        self.assertTrue(result.file_ids)
        self.assertTrue(gate.seal(generation))

    async def fail_capture(self, turn: str = "turn") -> None:
        await self.begin(turn)
        with patch.object(
            self.content, "capture_from_space", side_effect=ContentError("read_failed")
        ):
            with self.assertRaises(ContentError):
                await self.deliveries.finish_turn("session", turn, TurnOutcome.COMPLETED)

    async def test_missing_snapshot_is_visible_and_never_blindly_retried(self) -> None:
        await self.fail_capture()
        response = await self.client.get(self.url, params=self.params)
        self.assertEqual(response.status_code, 200)
        entry = response.json()["entries"][0]
        self.assertEqual(entry["error"], "read_failed")
        self.assertEqual(entry["terminal_outcome"], "completed")
        self.assertEqual(entry["paths"], ["resources/notes.md"])
        self.assertFalse(entry["retryable"])
        self.assertFalse(entry["snapshot_available"])
        missing_key = await self.client.post(self.url + "/turn/retry", params=self.params)
        self.assertEqual(missing_key.status_code, 400)
        self.assertEqual(missing_key.json()["error"]["code"], "idempotency_key_required")
        retry = await self.client.post(
            self.url + "/turn/retry",
            params=self.params,
            headers={"Idempotency-Key": "missing-snapshot"},
        )
        self.assertEqual(retry.status_code, 409)
        self.assertEqual(self.resumed_finalizations, [])
        self.assertEqual(len(self.versions.history(self.project.id, "resources/notes.md")), 1)
        for params in (
            {**self.params, "session_id": "other"},
            {**self.params, "project": self.other.id},
        ):
            other = await self.client.get(self.url, params=params)
            self.assertEqual(other.json()["entries"], [])
            retry = await self.client.post(
                self.url + "/turn/retry",
                params=params,
                headers={"Idempotency-Key": f"missing-{params['project']}-{params['session_id']}"},
            )
            self.assertEqual(retry.status_code, 404)

    async def test_finalization_read_does_not_wait_for_project_writer(self) -> None:
        for turn in ("first", "second"):
            await self.fail_capture(turn)
        entered, release = threading.Event(), threading.Event()

        def hold_writer() -> None:
            with self.versions.writer(self.project.id):
                entered.set()
                if not release.wait(10):
                    raise TimeoutError("project writer was not released")

        async def read_pages() -> list[dict]:
            params = {**self.params, "limit": 1}
            response = await self.client.get(self.url, params=params)
            self.assertEqual(response.status_code, 200)
            first = response.json()
            self.assertEqual(first["next_cursor"], "second")
            response = await self.client.get(
                self.url, params={**params, "cursor": first["next_cursor"]}
            )
            self.assertEqual(response.status_code, 200)
            second = response.json()
            self.assertIsNone(second["next_cursor"])
            return first["entries"] + second["entries"]

        holder = asyncio.create_task(asyncio.to_thread(hold_writer))
        request = None
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 5))
            request = asyncio.create_task(read_pages())
            done, _ = await asyncio.wait({request}, timeout=2)
            self.assertIn(request, done, "finalization GET waited for the project writer")
            entries = request.result()
            self.assertFalse(holder.done())
        finally:
            release.set()
            await holder
            if request is not None:
                await request

        self.assertEqual([entry["turn_id"] for entry in entries], ["second", "first"])
        for entry in entries:
            self.assertEqual(entry["error"], "read_failed")
            self.assertEqual(entry["terminal_outcome"], "completed")
            self.assertEqual(entry["paths"], ["resources/notes.md"])
            self.assertFalse(entry["retryable"])
            self.assertFalse(entry["snapshot_available"])

    async def test_retry_only_publishes_frozen_objects_and_is_idempotent(self) -> None:
        await self.begin()
        with patch.object(
            VersionStore, "finalize_review", side_effect=RuntimeError("publish failed")
        ):
            with self.assertRaises(RuntimeError):
                await self.deliveries.finish_turn("session", "turn", TurnOutcome.COMPLETED)
        response = await self.client.get(self.url, params=self.params)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["entries"][0]["retryable"])
        self.target.write_bytes(b"later external bytes\n")
        for _ in range(2):
            retry = await self.client.post(
                self.url + "/turn/retry",
                params=self.params,
                headers={"Idempotency-Key": "retry-frozen-turn"},
            )
            self.assertEqual(retry.status_code, 200)
        self.assertEqual(self.resumed_finalizations, [("session", "turn")] * 2)
        self.assertEqual(
            (await self.client.get(self.url, params=self.params)).json()["entries"], []
        )
        history = self.versions.history(self.project.id, "resources/notes.md")
        self.assertEqual(len(history), 1)
        store = VersionStore(
            self.content.resolve(self.project.id, PROJECT_DB_RELATIVE), self.project.root
        )
        candidate = store.pending(history[0].file_id).review.candidate
        self.assertEqual(candidate.object_id, "sha256:" + sha256(b"terminal bytes\n").hexdigest())
        self.assertEqual(self.target.read_bytes(), b"later external bytes\n")

    async def test_retry_returns_committed_receipt_when_resume_notification_fails(self) -> None:
        await self.begin()
        with patch.object(
            VersionStore, "finalize_review", side_effect=RuntimeError("publish failed")
        ):
            with self.assertRaises(RuntimeError):
                await self.deliveries.finish_turn("session", "turn", TurnOutcome.COMPLETED)
        retry_url = self.url + "/turn/retry"
        headers = {"Idempotency-Key": "retry-notification-failure"}
        with (
            patch.object(
                self.app.state,
                "resume_resource_finalization",
                new=AsyncMock(side_effect=RuntimeError("resume unavailable")),
            ) as notify,
            self.assertLogs("service.resources.api.versions", level="WARNING") as logs,
        ):
            committed = await self.client.post(retry_url, params=self.params, headers=headers)

        notify.assert_awaited_once_with("session", "turn")
        self.assertEqual(committed.status_code, 200)
        self.assertTrue(committed.json()["file_ids"])
        (diagnostic,) = logs.records
        self.assertEqual(
            diagnostic.getMessage(),
            f"resource_finalization_resume_failed project_id={self.project.id} "
            "session_id=session turn_id=turn failure_type=RuntimeError",
        )
        self.assertIsNotNone(diagnostic.exc_info)
        with patch.object(VersionStore, "finalize_review", side_effect=AssertionError) as publish:
            repeated = await self.client.post(retry_url, params=self.params, headers=headers)
        publish.assert_not_called()
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.json(), committed.json())
        self.assertEqual(self.resumed_finalizations, [("session", "turn")])

    async def test_failed_archive_listing_has_stable_bounded_pagination(self) -> None:
        for turn in ("first", "second", "third"):
            await self.fail_capture(turn)
        first = await self.client.get(self.url, params={**self.params, "limit": 2})
        self.assertEqual(first.status_code, 200)
        page = first.json()
        self.assertEqual(len(page["entries"]), 2)
        second = await self.client.get(
            self.url, params={**self.params, "limit": 2, "cursor": page["next_cursor"]}
        )
        self.assertIsNone(second.json()["next_cursor"])
        self.assertEqual(
            {e["turn_id"] for e in page["entries"] + second.json()["entries"]},
            {"first", "second", "third"},
        )
        invalid = await self.client.get(self.url, params={**self.params, "cursor": "absent"})
        self.assertEqual(invalid.status_code, 400)

    async def test_newer_head_disables_retry_without_hiding_original_failure(self) -> None:
        await self.begin()
        with patch.object(
            VersionStore, "finalize_review", side_effect=RuntimeError("publish failed")
        ):
            with self.assertRaises(RuntimeError):
                await self.deliveries.finish_turn("session", "turn", TurnOutcome.COMPLETED)
        self.target.write_bytes(b"new user version\n")
        self.versions.seal(self.project.id, "resources/notes.md", VersionOrigin.USER)
        response = await self.client.get(self.url, params=self.params)
        entry = response.json()["entries"][0]
        self.assertEqual(entry["error"], "RuntimeError")
        self.assertTrue(entry["snapshot_available"])
        self.assertFalse(entry["retryable"])
        retry = await self.client.post(
            self.url + "/turn/retry",
            params=self.params,
            headers={"Idempotency-Key": "newer-head"},
        )
        self.assertEqual(retry.status_code, 409)
        self.assertEqual(retry.json()["error"]["code"], "terminal_not_retryable")
        self.assertEqual(len(self.versions.history(self.project.id, "resources/notes.md")), 2)

    async def test_finalization_page_keeps_one_snapshot_across_a_head_change(self) -> None:
        await self.begin()
        with patch.object(
            VersionStore, "finalize_review", side_effect=RuntimeError("publish failed")
        ):
            with self.assertRaises(RuntimeError):
                await self.deliveries.finish_turn("session", "turn", TurnOutcome.COMPLETED)

        selected, resume = threading.Event(), threading.Event()
        project_row = VersionStore._finalization

        def pause_projection(connection, row):
            selected.set()
            if not resume.wait(10):
                raise TimeoutError("finalization projection was not resumed")
            return project_row(connection, row)

        def change_head() -> None:
            self.target.write_bytes(b"new user version\n")
            self.versions.seal(self.project.id, "resources/notes.md", VersionOrigin.USER)

        with patch.object(VersionStore, "_finalization", side_effect=pause_projection):
            request = asyncio.create_task(self.client.get(self.url, params=self.params))
            writer = None
            try:
                self.assertTrue(await asyncio.to_thread(selected.wait, 5))
                writer = asyncio.create_task(asyncio.to_thread(change_head))
                done, _ = await asyncio.wait({writer}, timeout=2)
                self.assertIn(writer, done, "project writer waited for the finalization projection")
                writer.result()
            finally:
                resume.set()
                previous = await request
                if writer is not None:
                    await writer

        self.assertEqual(previous.status_code, 200)
        self.assertTrue(previous.json()["entries"][0]["retryable"])
        current = await self.client.get(self.url, params=self.params)
        self.assertEqual(current.status_code, 200)
        self.assertFalse(current.json()["entries"][0]["retryable"])


if __name__ == "__main__":
    unittest.main()
