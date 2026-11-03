"""Persistent archive failures exposed through the resource HTTP boundary."""

from __future__ import annotations

import asyncio
import tempfile
import threading
import unittest
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE
from service.platform.activity import Activities, MaintenanceActive
from service.platform.resources import TurnOutcome, VersionOrigin
from service.resources.api.versions import register_version_routes
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
        app.state.resource_deliveries = self.deliveries
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
        with patch.object(self.content, "capture_stable", side_effect=ContentError("read_failed")):
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

    async def test_finalization_read_uses_the_terminal_writer_boundary(self) -> None:
        await self.begin()
        await self.deliveries.finish_turn("session", "turn", TurnOutcome.COMPLETED)
        with patch.object(self.versions, "writer", wraps=self.versions.writer) as writer:
            response = await self.client.get(self.url, params=self.params)
        self.assertEqual(response.json()["entries"], [])
        writer.assert_called_once_with(self.project.id)

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


if __name__ == "__main__":
    unittest.main()
