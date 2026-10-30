"""Project-local recovery must not recreate a registered but unavailable root."""

from __future__ import annotations

import asyncio
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Callable
from unittest.mock import patch

from service.content.domain.model import ContentError, resolve_root
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import transaction
from service.platform.activity import Activities, ActivityPhase
from service.platform.content import ContentPort, RootKind
from service.resources.service.activation import ResourceActivation
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import (
    ResourceRetentionService,
    RetentionError,
)
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

    def set_file_version_settings(
        self,
        max_versions_per_file: int,
        include_patterns: tuple[str, ...],
        ignore_patterns: tuple[str, ...],
        mode: str = "whitelist",
        *,
        max_file_size_kb: int = 1024,
    ) -> None:
        del max_versions_per_file, include_patterns, ignore_patterns, mode, max_file_size_kb


POLL_SECONDS = 0.05
WAIT_SECONDS = 20
CLOSE_SECONDS = 0.5


async def eventually(predicate: Callable[[], bool]) -> None:
    async with asyncio.timeout(WAIT_SECONDS):
        while not predicate():
            await asyncio.sleep(POLL_SECONDS)


class ActivationContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="resource-activation-")
        root = Path(self.temporary.name)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog, activities=Activities())
        self.project = registry.create("离线项目")
        self.project_root = Path(self.project.root)
        settings, formats = Settings(), WorkbenchFormatPolicy()
        self.retention = ResourceRetentionService(self.content, settings)
        self.versions = ResourceVersionService(
            self.content, self.retention, formats, PdfRecordStore(self.content)
        )
        self.recovery = ResourceRecoveryService(
            self.content, self.retention, PdfRecordStore(self.content)
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_root_disappears_between_resolution_and_directory_creation(self) -> None:
        offline = self.project_root.with_name(self.project_root.name + "-offline")

        def move_after_resolution(*args):
            location = resolve_root(*args)
            self.project_root.rename(offline)
            return location

        with patch("service.content.service.port.resolve_root", side_effect=move_after_resolution):
            with self.assertRaisesRegex(ContentError, "root_unavailable"):
                self.content.root(self.project.id, RootKind.RESOURCES)
        self.assertFalse(self.project_root.exists())
        self.assertTrue((offline / "resources").is_dir())

    def test_tree_read_cannot_recreate_root_after_database_existence_check(self) -> None:
        database = Path(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE))
        with transaction(database):
            pass
        original = Path.is_file
        offline = self.project_root.with_name(self.project_root.name + "-offline")

        def move_after_check(path):
            present = original(path)
            if path == database and present:
                self.project_root.rename(offline)
            return present

        with patch.object(Path, "is_file", move_after_check):
            with self.assertRaisesRegex(ContentError, "root_unavailable"):
                self.content.tree(self.project.id)
        self.assertFalse(self.project_root.exists())
        self.assertTrue((offline / PROJECT_DB_RELATIVE).is_file())

    def test_known_offline_project_rejects_file_paths_without_recreating_root(self) -> None:
        offline = self.project_root.with_name(self.project_root.name + "-offline")
        self.project_root.rename(offline)
        try:
            operations = (
                lambda: self.content.resolve(
                    self.project.id, ".scholarseed/service/project.sqlite3"
                ),
                lambda: self.content.root(self.project.id, RootKind.RESOURCES),
                lambda: self.retention.collect(self.project.id),
                lambda: self.recovery.recover_pending(self.project.id),
                lambda: self.versions.recover_working_mutations(self.project.id),
            )
            for operation in operations:
                with self.subTest(operation=operation):
                    with self.assertRaisesRegex(ContentError, "root_unavailable"):
                        operation()
                    self.assertFalse(self.project_root.exists())
            self.assertFalse(self.content.project(self.project.id).available)
            self.assertEqual(self.content.external_roots(self.project.id), ())
            with self.assertRaisesRegex(RetentionError, "projects_unavailable"):
                self.retention.preview(50, ("*.md",), ())
        finally:
            if self.project_root.exists():
                self.fail("an offline operation recreated the registered project root")
            offline.rename(self.project_root)


class LifecycleContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="resource-lifecycle-")
        root = Path(self.temporary.name)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog, activities=Activities())
        self.project = registry.create("恢复上线")
        self.project_root = Path(self.project.root)
        self.target = self.project_root / "resources" / "notes.md"
        self.target.write_text("stable offline bytes\n", encoding="utf-8", newline="\n")
        settings, formats = Settings(), WorkbenchFormatPolicy()
        retention = ResourceRetentionService(self.content, settings)
        annotations = PdfRecordStore(self.content)
        self.versions = ResourceVersionService(self.content, retention, formats, annotations)
        self.supervisor = ResourceVersionSupervisor(
            self.content, self.versions, formats, settings, activities=Activities()
        )
        deliveries = ResourceDeliveryService(
            self.content, self.versions, self.supervisor, activities=self.supervisor._activities
        )
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

    async def asyncTearDown(self) -> None:
        await self.supervisor.aclose()
        self.temporary.cleanup()

    async def test_drain_preserves_pending_scan_until_resume(self) -> None:
        gate = self.supervisor._activities
        generation = gate.begin()
        self.supervisor.schedule_scan(self.project.id)
        await asyncio.sleep(0)
        self.assertEqual(self.versions.history(self.project.id, "resources/notes.md"), ())
        self.assertIn(self.project.id, self.supervisor._discover)
        self.assertFalse(self.supervisor._tasks)
        self.assertTrue(gate.seal(generation))
        gate.resume(generation)
        await eventually(lambda: bool(self.versions.history(self.project.id, "resources/notes.md")))
        await eventually(lambda: not gate.snapshot().counts)
        version = self.versions.history(self.project.id, "resources/notes.md")[0]
        self.assertEqual(
            self.versions.read(self.project.id, version.id)[0], b"stable offline bytes\n"
        )

    async def test_drain_finishes_current_scan_but_defers_later_changes(self) -> None:
        gate = self.supervisor._activities
        started, release = threading.Event(), threading.Event()
        original = self.supervisor._process
        calls = []

        def process(*args):
            original(*args)
            calls.append(args)
            if len(calls) == 1:
                started.set()
                if not release.wait(5):
                    raise TimeoutError("scan release was not signalled")

        self.supervisor._process = process
        self.supervisor.schedule_scan(self.project.id)
        try:
            self.assertTrue(await asyncio.to_thread(started.wait, 5))
            generation = gate.begin()
            self.assertFalse(gate.seal(generation))
            (self.project_root / "resources" / "later.md").write_text("later bytes\n")
            self.supervisor.schedule_scan(self.project.id)
        finally:
            release.set()
        await eventually(lambda: not gate.snapshot().counts)
        self.assertEqual(len(calls), 1)
        self.assertIn(self.project.id, self.supervisor._discover)
        self.assertEqual(self.versions.history(self.project.id, "resources/later.md"), ())
        self.assertTrue(gate.seal(generation))
        gate.resume(generation)
        await eventually(lambda: bool(self.versions.history(self.project.id, "resources/later.md")))
        await eventually(lambda: not gate.snapshot().counts)
        self.assertGreaterEqual(len(calls), 2)

    async def test_close_does_not_wait_forever_for_maintenance_resume(self) -> None:
        self.supervisor._activities.begin()
        self.supervisor.schedule_scan(self.project.id)
        await asyncio.sleep(0)
        await asyncio.wait_for(self.supervisor.aclose(), 2)
        self.assertFalse(self.supervisor._resume_tasks)
        self.assertFalse(self.supervisor._tasks)

    async def test_start_does_not_prepare_historical_projects(self) -> None:
        await self.supervisor.start()
        await asyncio.sleep(POLL_SECONDS)
        self.assertNotIn(self.project.id, self.supervisor._prepared)
        self.assertEqual(self.versions.history(self.project.id, "resources/notes.md"), ())

    async def test_close_registry_while_maintenance_remains_sealed(self) -> None:
        gate = self.supervisor._activities
        generation = gate.begin()
        self.assertTrue(gate.seal(generation))
        waiting = asyncio.Event()
        original = gate.wait_open

        async def wait_open() -> None:
            waiting.set()
            await original()

        with patch.object(gate, "wait_open", side_effect=wait_open):
            await self.supervisor.start()
            await asyncio.wait_for(waiting.wait(), WAIT_SECONDS)
            await asyncio.wait_for(self.supervisor.aclose(), CLOSE_SECONDS)
        self.assertTrue(self.supervisor._registry_task.done())
        self.assertEqual(gate.snapshot().phase, ActivityPhase.SEALED)

    async def test_close_registry_before_workbench_is_ready(self) -> None:
        gate = Activities(workbench_ready=lambda: False)
        self.supervisor._activities = gate
        await self.supervisor.start()
        await eventually(lambda: bool(gate._waiters))
        await asyncio.wait_for(self.supervisor.aclose(), CLOSE_SECONDS)
        self.assertFalse(gate.workbench_ready)
        self.assertFalse(gate._waiters)

    async def test_close_registry_during_refresh_interval(self) -> None:
        waiting = asyncio.Event()
        gate = self.supervisor._activities
        original = gate.wait_open

        async def wait_open() -> None:
            await original()
            waiting.set()

        with patch.object(gate, "wait_open", side_effect=wait_open):
            await self.supervisor.start()
            await asyncio.wait_for(waiting.wait(), WAIT_SECONDS)
            await asyncio.wait_for(self.supervisor.aclose(), CLOSE_SECONDS)
        self.assertFalse(self.supervisor._registry_task.cancelled())

    async def test_close_registry_drains_active_disk_call(self) -> None:
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        original = self.content.project
        self.supervisor._prepared.add(self.project.id)

        def project(project_id):
            entered.set()
            if not release.wait(WAIT_SECONDS):
                raise TimeoutError("registry disk call was not released")
            result = original(project_id)
            finished.set()
            return result

        with patch.object(self.content, "project", side_effect=project):
            await self.supervisor.start()
            try:
                await eventually(entered.is_set)
                closed = asyncio.create_task(self.supervisor.aclose())
                await asyncio.sleep(POLL_SECONDS)
                self.assertFalse(closed.done(), "registry disk operation must finish before close")
            finally:
                release.set()
            await asyncio.wait_for(closed, WAIT_SECONDS)
        self.assertTrue(finished.is_set())
        self.assertFalse(self.supervisor._activities.snapshot().counts)

    async def test_explicit_activation_prepares_project_before_initial_scan(self) -> None:
        await self.supervisor.start()
        await self.supervisor.activate_project(self.project.id)
        await eventually(lambda: bool(self.versions.history(self.project.id, "resources/notes.md")))
        version = self.versions.history(self.project.id, "resources/notes.md")[0]
        self.assertEqual(
            self.versions.read(self.project.id, version.id)[0], b"stable offline bytes\n"
        )

    async def test_later_available_project_waits_for_explicit_activation(self) -> None:
        offline = self.project_root.with_name(self.project_root.name + "-offline")
        self.project_root.rename(offline)
        await self.supervisor.start()
        await asyncio.sleep(POLL_SECONDS)
        self.assertFalse(self.project_root.exists())
        offline.rename(self.project_root)
        await asyncio.sleep(POLL_SECONDS)
        self.assertEqual(self.versions.history(self.project.id, "resources/notes.md"), ())
        await self.supervisor.activate_project(self.project.id)
        await eventually(lambda: bool(self.versions.history(self.project.id, "resources/notes.md")))
        version = self.versions.history(self.project.id, "resources/notes.md")[0]
        self.assertEqual(
            self.versions.read(self.project.id, version.id)[0], b"stable offline bytes\n"
        )


class SelectivePreparation:
    def __init__(self, content: ContentPort, failing_project: str) -> None:
        self._content = content
        self._failing_project = failing_project
        self.attempts: list[str] = []

    def prepare(self, project_id: str) -> None:
        self.attempts.append(project_id)
        if project_id == self._failing_project:
            raise RuntimeError("preparation_failed")
        self._content.project(project_id)


class IsolationContract(unittest.IsolatedAsyncioTestCase):
    async def test_one_project_activation_does_not_touch_another(self) -> None:
        with tempfile.TemporaryDirectory(prefix="resource-isolation-") as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            catalog = ContentCatalog(root / "content.sqlite3")
            registry = ProjectRegistry(str(workspace), catalog)
            content = ContentService(registry, catalog, activities=Activities())
            failing = registry.create("失败项目")
            healthy = registry.create("正常项目")
            (Path(healthy.root) / "resources" / "healthy.md").write_text(
                "healthy\n", encoding="utf-8"
            )
            settings, formats = Settings(), WorkbenchFormatPolicy()
            retention = ResourceRetentionService(content, settings)
            versions = ResourceVersionService(content, retention, formats, PdfRecordStore(content))
            supervisor = ResourceVersionSupervisor(
                content, versions, formats, settings, activities=Activities()
            )
            preparation = SelectivePreparation(content, failing.id)
            supervisor.bind_preparation(preparation)
            try:
                await supervisor.start()
                await supervisor.activate_project(healthy.id)
                await eventually(lambda: bool(versions.history(healthy.id, "resources/healthy.md")))
                self.assertEqual(preparation.attempts.count(failing.id), 0)
                self.assertEqual(preparation.attempts.count(healthy.id), 1)
                healthy_root = Path(healthy.root)
                offline = healthy_root.with_name(healthy_root.name + "-offline")
                # The initial version is visible before the scanning thread finishes.
                # Windows requires its database handles to close before directory rename.
                await eventually(lambda: not supervisor._activities.snapshot().counts)
                healthy_root.rename(offline)
                await supervisor._refresh_active_projects()
                self.assertFalse(healthy_root.exists())
                offline.rename(healthy_root)
                await supervisor._refresh_active_projects()
                self.assertEqual(preparation.attempts.count(healthy.id), 1)
                await supervisor.activate_project(healthy.id)
                self.assertEqual(preparation.attempts.count(healthy.id), 2)
            finally:
                await supervisor.aclose()


if __name__ == "__main__":
    unittest.main()
