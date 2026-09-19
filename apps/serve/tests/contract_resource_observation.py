"""Resource observation contracts using real disk, SQLite and Content watchers."""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Callable
from unittest.mock import patch

from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE
from service.resources.service.activation import ResourceActivation
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

POLL_SECONDS = 0.05
WAIT_SECONDS = 6


class Settings:
    mode = "whitelist"
    ignores: tuple[str, ...] = ("*.log",)

    def set_blacklist(self, patterns: str) -> None:
        self.mode = "blacklist"
        self.ignores = tuple(patterns.splitlines())

    def max_versions_per_file(self) -> int:
        return 50

    def max_version_file_size_kb(self) -> int:
        return 1024

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return self.ignores

    def version_mode(self) -> str:
        return self.mode

    def version_migration_required(self) -> bool:
        return False

    def version_include_patterns(self) -> tuple[str, ...] | None:
        return None


async def eventually(predicate: Callable[[], bool]) -> None:
    async with asyncio.timeout(WAIT_SECONDS):
        while not predicate():
            await asyncio.sleep(POLL_SECONDS)


class ObservationContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="resource-observation-")
        self.root = Path(self.temporary.name)
        workspace = self.root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(self.root / "content.sqlite3")
        self.registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(self.registry, catalog)
        self.project = self.registry.create("观察项目")
        self.resources = Path(self.project.root) / "resources"
        self.path = "resources/notes.md"
        self.target = self.resources / "notes.md"
        self.target.write_text("initial\n", encoding="utf-8")
        settings = self.settings = Settings()
        retention = ResourceRetentionService(self.content, settings)
        annotations = PdfRecordStore(self.content)
        self.versions = ResourceVersionService(
            self.content,
            retention,
            WorkbenchFormatPolicy(),
            annotations,
        )
        self.supervisor = ResourceVersionSupervisor(
            self.content, self.versions, WorkbenchFormatPolicy(), settings
        )
        deliveries = ResourceDeliveryService(self.content, self.versions, self.supervisor)
        self.supervisor.bind_preparation(
            ResourceActivation(
                self.content,
                ResourceRecoveryService(self.content, retention, annotations),
                self.versions,
                deliveries,
                retention,
                ResourceReviewMigration(self.content, self.versions),
            )
        )
        self.supervisor.scan_project(self.project.id)

    async def asyncTearDown(self) -> None:
        await self.supervisor.aclose()
        self.temporary.cleanup()

    def observations(self) -> list[sqlite3.Row]:
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        with sqlite3.connect(database) as connection:
            connection.row_factory = sqlite3.Row
            return list(connection.execute("""SELECT o.*, f.current_path AS observed_path
                   FROM resources_observations o JOIN resources_files f USING(file_id)
                   WHERE reason = 'external'"""))

    async def test_open_adopts_external_pending_without_advancing_version(self) -> None:
        initial = self.versions.capability(self.project.id, self.path)
        self.target.write_text("external\n", encoding="utf-8")
        self.supervisor.observe_path(self.project.id, self.path)
        changed = self.versions.capability(self.project.id, self.path)
        rows = self.observations()
        self.assertEqual(len(rows), 0)
        self.assertEqual(
            changed.working_revision, self.content.snapshot(self.project.id, self.path).revision
        )
        self.assertFalse(changed.drifted)
        self.assertNotEqual(changed.working_revision, initial.working_revision)
        self.assertEqual(changed.pending.origin.value, "external")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)
        for text in ("external\n", "next\n", "next\n"):
            self.target.write_text(text, encoding="utf-8")
            self.supervisor.observe_path(self.project.id, self.path)
            self.versions.capability(self.project.id, self.path)
        self.assertEqual(len(self.observations()), 1, "external observation storage is bounded")

    async def test_scan_and_drift_publish_stable_structured_event_names(self) -> None:
        with self.assertLogs("scholarseed.resources.versions", level="INFO") as scan_logs:
            self.supervisor.scan_project(self.project.id)
        scan_output = "\n".join(scan_logs.output)
        self.assertIn("resources.versions.scan.started", scan_output)
        self.assertIn("resources.versions.scan.progress", scan_output)
        self.assertIn("resources.versions.scan.completed", scan_output)

        self.target.write_text("observable drift\n", encoding="utf-8")
        with self.assertLogs("scholarseed.resources.versions", level="INFO") as drift_logs:
            self.supervisor._process(self.project.id, {self.path}, False)
        self.assertIn("resources.versions.observe.drift", "\n".join(drift_logs.output))

    async def test_supervisor_observes_without_a_renderer_subscriber(self) -> None:
        await self.supervisor.start()
        await self.supervisor.activate_project(self.project.id)
        await asyncio.sleep(0.7)
        self.target.write_text("external without renderer\n", encoding="utf-8")
        revision = self.content.snapshot(self.project.id, self.path).revision
        await eventually(
            lambda: self.versions.capability(self.project.id, self.path).working_revision
            == revision
        )
        self.assertEqual(
            self.versions.capability(self.project.id, self.path).pending.origin.value, "external"
        )
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)
        self.target.unlink()
        await eventually(
            lambda: self.versions._store(self.project.id)
            .working_snapshot(self.versions.history(self.project.id, self.path)[0].file_id)
            .state.value
            == "tombstone"
        )
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_supervisor_discovers_new_files_without_resource_tree_requests(self) -> None:
        await self.supervisor.start()
        await self.supervisor.activate_project(self.project.id)
        await asyncio.sleep(0.7)
        (self.resources / "new.md").write_text("discovered\n", encoding="utf-8")
        await eventually(lambda: bool(self.versions.history(self.project.id, "resources/new.md")))
        self.assertEqual(self.versions.history(self.project.id, "resources/new.md")[0].sequence, 1)

    async def test_scoped_blacklist_removal_discovers_new_but_defers_old_history(self) -> None:
        code = self.resources / "code"
        code.mkdir()
        old = code / "old.md"
        old.write_text("archived\n", encoding="utf-8")
        self.supervisor.scan_project(self.project.id)
        self.settings.set_blacklist("code/*.md\n")
        (code / "new.md").write_text("ignored new\n", encoding="utf-8")
        await self.supervisor.start()
        await self.supervisor.activate_project(self.project.id)
        await asyncio.sleep(0.7)
        old.write_text("changed while ignored\n", encoding="utf-8")
        await asyncio.sleep(0.7)
        self.assertFalse(
            any(row["observed_path"] == "resources/code/old.md" for row in self.observations())
        )
        self.settings.set_blacklist("")
        await self.supervisor.schedule_all()
        await eventually(
            lambda: bool(self.versions.history(self.project.id, "resources/code/new.md"))
        )
        self.assertFalse(
            any(row["observed_path"] == "resources/code/old.md" for row in self.observations())
        )
        self.supervisor.observe_path(self.project.id, "resources/code/old.md")
        current = self.versions.capability(self.project.id, "resources/code/old.md")
        self.assertFalse(current.drifted)
        self.assertEqual(current.pending.origin.value, "external")
        self.assertEqual(len(self.versions.history(self.project.id, "resources/code/old.md")), 1)

    async def test_global_policy_change_retires_a_forgotten_prepared_project(self) -> None:
        await self.supervisor.start()
        await self.supervisor.activate_project(self.project.id)

        with patch.object(self.content, "project", side_effect=ContentError("unknown_project")):
            await self.supervisor.schedule_all()

        self.assertNotIn(self.project.id, self.supervisor._prepared)
        self.assertNotIn(self.project.id, self.supervisor._streams)

    async def test_new_project_waits_for_activation_and_authorized_root_is_watched(self) -> None:
        await self.supervisor.start()
        other = self.registry.create("后建项目")
        (Path(other.root) / "resources" / "later.md").write_text("later\n", encoding="utf-8")
        await asyncio.sleep(0.7)
        self.assertEqual(self.versions.history(other.id, "resources/later.md"), ())
        await self.supervisor.activate_project(other.id)
        await eventually(lambda: bool(self.versions.history(other.id, "resources/later.md")))
        await self.supervisor.activate_project(self.project.id)
        linked = self.root / "linked"
        linked.mkdir()
        self.content.authorize_root(self.project.id, str(linked), "linked")
        (linked / "linked.md").write_text("linked\n", encoding="utf-8")
        await eventually(
            lambda: bool(self.versions.history(self.project.id, "resources/linked/linked.md"))
        )
        (linked / "linked.md").write_text("linked external edit\n", encoding="utf-8")
        revision = self.content.snapshot(self.project.id, "resources/linked/linked.md").revision
        await eventually(
            lambda: self.versions.capability(
                self.project.id, "resources/linked/linked.md"
            ).working_revision
            == revision
        )

    async def test_shutdown_drains_the_real_worker_before_returning(self) -> None:
        entered = threading.Event()
        release = threading.Event()
        original = self.supervisor._process

        def delayed(*args: object) -> None:
            entered.set()
            release.wait(WAIT_SECONDS)
            original(*args)

        with patch.object(self.supervisor, "_process", side_effect=delayed):
            self.supervisor.schedule_scan(self.project.id)
            await eventually(entered.is_set)
            closed = asyncio.create_task(self.supervisor.aclose())
            try:
                await asyncio.sleep(0.1)
                self.assertFalse(closed.done(), "closing must await the actual disk worker")
            finally:
                release.set()
                await closed

    async def test_forget_retires_an_inflight_worker_without_observation_failure(self) -> None:
        await self.supervisor.start()
        await self.supervisor.activate_project(self.project.id)
        await eventually(lambda: self.project.id in self.supervisor._prepared)
        await eventually(lambda: self.project.id not in self.supervisor._tasks)
        entered = threading.Event()
        release = threading.Event()
        original = self.supervisor._process

        def delayed(*args: object) -> None:
            entered.set()
            release.wait(WAIT_SECONDS)
            original(*args)

        with (
            patch.object(self.supervisor, "_process", side_effect=delayed),
            patch("service.resources.service.observe._log.exception") as logged_failure,
        ):
            self.supervisor.schedule_scan(self.project.id)
            await eventually(entered.is_set)
            self.content.forget_project(self.project.id)
            await self.supervisor._refresh_active_projects()
            release.set()
            await eventually(lambda: self.project.id not in self.supervisor._tasks)

        self.assertFalse(logged_failure.called, logged_failure.call_args_list)
        self.assertNotIn(self.project.id, self.supervisor._streams)
        self.assertNotIn(self.project.id, self.supervisor._prepared)
        self.assertNotIn(self.project.id, self.supervisor._dirty)
        self.assertNotIn(self.project.id, self.supervisor._eligible_cache)
        self.assertNotIn(self.project.id, self.supervisor._prepare_locks)
        self.assertTrue(
            Path(self.project.root).is_dir(), "forget must not recreate or delete roots"
        )

        survivor = self.registry.create("继续观察项目")
        survivor_target = Path(survivor.root) / "resources" / "survivor.md"
        survivor_target.write_text("survives retirement\n", encoding="utf-8")
        await self.supervisor.activate_project(survivor.id)
        await eventually(lambda: bool(self.versions.history(survivor.id, "resources/survivor.md")))

    async def test_ignored_open_does_not_persist_observation(self) -> None:
        self.settings.set_blacklist("notes.md\n")
        self.target.write_text("ignored change\n", encoding="utf-8")
        self.assertFalse(self.supervisor.observe_path(self.project.id, self.path))
        self.assertEqual(self.observations(), [])


if __name__ == "__main__":
    unittest.main()
