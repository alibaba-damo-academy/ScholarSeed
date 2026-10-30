"""Watcher maintenance uses real files and owns native waits through shutdown."""

from __future__ import annotations

import asyncio
import hashlib
import io
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service import events, identity
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.activity import Activities, ActivityDomain, MaintenanceActive
from service.platform.content import (
    ArtifactScope,
    ArtifactScopeKind,
    AssetKind,
    ImportMode,
    RootKind,
)


async def eventually(predicate):
    async with asyncio.timeout(6):
        while not predicate():
            await asyncio.sleep(0.01)


class ContentDrainContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="content-drain-")
        self.root = Path(self.temporary.name)
        workspace = self.root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(self.root / "content.sqlite3")
        self.gate = Activities()
        self.content = ContentService(
            ProjectRegistry(str(workspace), catalog), catalog, activities=self.gate
        )
        self.project = self.content.create_project("drain")
        self.path = Path(self.project.root) / "resources" / "note.md"
        self.path.write_bytes(b"initial")
        self.hub = self.content._events

    async def asyncTearDown(self):
        await self.content.close_events()
        await eventually(lambda: not self.gate.snapshot().counts)
        self.temporary.cleanup()

    async def test_native_watcher_pauses_publication_and_rescans_after_resume(self):
        self.assertTrue(events.WATCHFILES_AVAILABLE)
        # Closing native handles necessarily drops events during maintenance;
        # the public RESCAN (which preserves the cursor) reconciles that gap.
        published = []
        original_emit = self.hub._emit

        async def emit(project, event):
            published.append(event)
            await original_emit(project, event)

        with patch.object(self.hub, "_emit", emit):
            await self.content.refresh_events(self.project.id)
            await eventually(lambda: bool(self.gate.snapshot().counts))
            generation = self.gate.begin()
            await asyncio.wait_for(self.gate.wait_execution_drained(), 3)
            cursor = self.content.event_cursor(self.project.id)
            before = len(published)
            self.path.write_bytes(b"changed during maintenance")
            await asyncio.sleep(0.65)
            self.assertEqual(self.content.event_cursor(self.project.id), cursor)
            self.assertEqual(len(published), before)
            self.assertTrue(self.gate.seal(generation))
            self.gate.resume(generation)
            await eventually(lambda: len(published) > before)
            self.assertEqual(published[-1].kind.value, "rescan")

    async def test_polling_pauses_snapshot_and_reconciles_changes(self):
        with (
            patch.object(events, "WATCHFILES_AVAILABLE", False),
            patch.object(events, "POLL_INTERVAL_SECONDS", 0.02),
        ):
            original = self.hub._snapshot
            snapshots = []
            published = []
            original_emit = self.hub._emit

            async def emit(project, event):
                published.append(event)
                await original_emit(project, event)

            def snapshot(project):
                result = original(project)
                snapshots.append(result)
                return result

            with (
                patch.object(self.hub, "_snapshot", snapshot),
                patch.object(self.hub, "_emit", emit),
            ):
                await self.content.refresh_events(self.project.id)
                await eventually(lambda: bool(snapshots))
                generation = self.gate.begin()
                await asyncio.wait_for(self.gate.wait_execution_drained(), 2)
                before = len(snapshots)
                before_events = len(published)
                self.path.write_bytes(b"changed while polling paused")
                await asyncio.sleep(0.08)
                self.assertEqual(len(snapshots), before)
                self.assertEqual(len(published), before_events)
                self.gate.resume(generation)
                await eventually(lambda: len(published) > before_events)
                self.assertEqual(published[-1].kind.value, "rescan")
                await self.content.close_events()

    async def test_shutdown_waits_for_owned_native_iteration(self):
        started, release, closed = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def watcher(*args, **kwargs):
            try:
                started.set()
                await release.wait()
                yield set()
            finally:
                closed.set()

        with (
            patch.object(events, "WATCHFILES_AVAILABLE", True),
            patch.object(events, "awatch", watcher),
        ):
            await self.content.refresh_events(self.project.id)
            await asyncio.wait_for(started.wait(), 2)
            generation = self.gate.begin()
            shutdown = asyncio.create_task(self.content.close_events())
            try:
                await asyncio.sleep(0.02)
                self.assertFalse(shutdown.done())
                self.assertFalse(self.gate.seal(generation))
            finally:
                release.set()
                await asyncio.wait_for(shutdown, 2)
            self.assertTrue(closed.is_set())
            self.assertTrue(self.gate.seal(generation))

    async def test_maintenance_closes_native_handles_before_releasing_occupancy(self):
        started, iteration, closing, release = (asyncio.Event() for _ in range(4))

        async def watcher(*args, **kwargs):
            try:
                started.set()
                await iteration.wait()
                yield set()
            finally:
                closing.set()
                await release.wait()

        with patch.object(events, "awatch", watcher):
            await self.content.refresh_events(self.project.id)
            await asyncio.wait_for(started.wait(), 2)
            generation = self.gate.begin()
            iteration.set()
            shutdown = None
            try:
                await asyncio.wait_for(closing.wait(), 2)
                self.assertFalse(self.gate.seal(generation))
                shutdown = asyncio.create_task(self.content.close_events())
                await asyncio.sleep(0)
                shutdown.cancel()
                await asyncio.sleep(0)
                shutdown.cancel()
                await asyncio.sleep(0)
                self.assertFalse(shutdown.done())
                self.assertFalse(self.gate.seal(generation))
            finally:
                release.set()
                if shutdown is None:
                    await self.content.close_events()
                else:
                    try:
                        await asyncio.wait_for(shutdown, 2)
                    except asyncio.CancelledError:
                        pass
            self.assertTrue(self.gate.seal(generation))

    async def test_cancelled_poll_keeps_actual_snapshot_thread_registered(self):
        started, release = threading.Event(), threading.Event()
        original = self.hub._snapshot

        def snapshot(project):
            started.set()
            release.wait(5)
            return original(project)

        with (
            patch.object(events, "WATCHFILES_AVAILABLE", False),
            patch.object(self.hub, "_snapshot", snapshot),
        ):
            await self.content.refresh_events(self.project.id)
            await eventually(started.is_set)
            generation = self.gate.begin()
            await self.content.close_events()
            try:
                self.assertFalse(self.gate.seal(generation))
            finally:
                release.set()
            await asyncio.wait_for(self.gate.wait_execution_drained(), 2)
            self.assertTrue(self.gate.seal(generation))

    async def test_close_does_not_wait_for_maintenance_to_resume(self):
        generation = self.gate.begin()
        await self.content.refresh_events(self.project.id)
        await asyncio.sleep(0)
        await asyncio.wait_for(self.content.close_events(), 2)
        self.assertTrue(self.gate.seal(generation))
        self.assertEqual(self.gate._waiters, set())

    async def test_new_topology_mutations_are_rejected_before_any_write(self):
        external = self.root / "external"
        external.mkdir()
        linked = self.content.authorize_root(self.project.id, str(external), "linked")
        legacy = self.root / "legacy"
        legacy.mkdir()
        (legacy / "keep.txt").write_bytes(b"unchanged")
        adopted = self.content.adopt_project(str(legacy))
        actions = {
            "create": lambda: self.content.create_project("blocked"),
            "adopt": lambda: self.content.adopt_project(str(external)),
            "forget": lambda: self.content.forget_project(self.project.id),
            "begin_forget": lambda: self.content.begin_project_forget(
                self.project.id, operation_id="blocked"
            ),
            "rename": lambda: self.content.rename_project(self.project.id, "blocked"),
            "archive": lambda: self.content.set_project_archived(self.project.id, True),
            "authorize": lambda: self.content.authorize_root(self.project.id, str(legacy), "new"),
            "authorize_at": lambda: self.content.authorize_root_at(
                self.project.id, str(legacy), "resources", "new"
            ),
            "authorize_many": lambda: self.content.authorize_roots(
                self.project.id, (str(legacy),), ("new",)
            ),
            "authorize_import": lambda: self.content.plan_import_roots(
                self.project.id, (str(legacy),), "resources"
            ),
            "revoke": lambda: self.content.revoke_root(linked.root_id),
            "commit_revoke": lambda: self.content.commit_root_revocation(
                linked.root_id, self.project.id, operation_id="blocked"
            ),
            "migrate": lambda: self.content.migrate_project(adopted.id),
        }
        with closing(sqlite3.connect(self.root / "content.sqlite3")) as connection:
            before = tuple(connection.iterdump())
        paths = sorted(str(path.relative_to(self.root)) for path in self.root.rglob("*"))
        generation = self.gate.begin()
        for name, action in actions.items():
            with self.subTest(operation=name):
                with self.assertRaises(MaintenanceActive):
                    action()
                with closing(sqlite3.connect(self.root / "content.sqlite3")) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)
                self.assertEqual(
                    sorted(str(path.relative_to(self.root)) for path in self.root.rglob("*")), paths
                )
                self.assertEqual((legacy / "keep.txt").read_bytes(), b"unchanged")
        self.assertTrue(self.gate.seal(generation))

    async def test_inflight_project_creation_holds_execution_until_catalog_commit(self):
        entered, release = threading.Event(), threading.Event()
        original = self.content._registry.create

        def create(name):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("creation release not signalled")
            return original(name)

        with patch.object(self.content._registry, "create", create):
            task = asyncio.create_task(asyncio.to_thread(self.content.create_project, "inflight"))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                generation = self.gate.begin()
                self.assertFalse(self.gate.seal(generation))
                self.assertEqual(self.gate.snapshot().counts, {ActivityDomain.RESOURCE.value: 1})
            finally:
                release.set()
                project = await task
        self.assertTrue(Path(project.root).is_dir())
        self.assertEqual(self.content.project(project.id).id, project.id)
        self.assertTrue(self.gate.seal(generation))

    async def test_existing_import_can_finish_topology_change_during_drain(self):
        with self.gate.enter(ActivityDomain.IMPORT, root=True):
            generation = self.gate.begin()
            project = self.content.create_project("continuation")
            self.assertTrue(Path(project.root).is_dir())
            self.assertEqual(self.gate.snapshot().counts, {ActivityDomain.IMPORT.value: 1})
        self.assertTrue(self.gate.seal(generation))

    async def test_failed_topology_change_releases_its_execution_lease(self):
        with self.assertRaises(ContentError):
            self.content.create_project("")
        self.assertEqual(self.gate.snapshot().counts, {})
        generation = self.gate.begin()
        self.assertTrue(self.gate.seal(generation))

    async def test_new_file_mutations_are_rejected_before_any_write(self):
        project, path = self.project.id, "resources/note.md"
        revision = self.content.snapshot(project, path).revision
        prepared = self.content.prepare_bytes(project, "resources", "staged.txt", b"staged")
        actions = {
            "publish_working_bytes": lambda: self.content.publish_working_bytes(
                ArtifactScope(ArtifactScopeKind.PROJECT, project), "blocked.txt", b"new"
            ),
            "write_text": lambda: self.content.write_text(project, path, "changed"),
            "create_bytes": lambda: self.content.create_bytes(
                project, "resources", "new.bin", b"new"
            ),
            "prepare_bytes": lambda: self.content.prepare_bytes(
                project, "resources", "next.txt", b"new"
            ),
            "publish_prepared": lambda: self.content.publish_prepared(prepared),
            "materialize": lambda: self.content.materialize(prepared),
            "release_prepared": lambda: self.content.release_prepared(prepared),
            "commit_bytes": lambda: self.content.commit_bytes(project, path, b"changed", revision),
            "commit_optional_bytes": lambda: self.content.commit_optional_bytes(
                project, path, b"changed", revision, b""
            ),
            "delete_bytes": lambda: self.content.delete_bytes(project, path, revision),
            "apply_bytes": lambda: self.content.apply_bytes(
                project, path, b"changed", revision, force=False, mode_bits=None
            ),
            "apply_stream": lambda: self.content.apply_stream(
                project,
                path,
                io.BytesIO(b"changed"),
                7,
                "sha256:" + hashlib.sha256(b"changed").hexdigest(),
                revision,
                force=False,
                mode_bits=None,
            ),
            "remove_bytes": lambda: self.content.remove_bytes(project, path, revision, force=False),
            "ensure_directory": lambda: self.content.ensure_directory(project, "resources", "new"),
            "create": lambda: self.content.create(project, "resources", "folder", AssetKind.DIR),
            "create_text": lambda: self.content.create_text(project, "resources", "new.md", "new"),
            "rename": lambda: self.content.rename(project, path, "renamed.md"),
            "move": lambda: self.content.move(project, path, ""),
            "copy": lambda: self.content.copy(project, path, "resources"),
            "import_sources": lambda: self.content.import_sources(
                project, (str(self.path),), "resources", ImportMode.COPY
            ),
        }
        before = {
            str(p.relative_to(self.root)): p.read_bytes()
            for p in self.root.rglob("*")
            if p.is_file()
        }
        generation = self.gate.begin()
        for name, action in actions.items():
            with self.subTest(operation=name):
                with self.assertRaises(MaintenanceActive):
                    action()
                self.assertEqual(
                    {
                        str(p.relative_to(self.root)): p.read_bytes()
                        for p in self.root.rglob("*")
                        if p.is_file()
                    },
                    before,
                )
        self.assertTrue(self.gate.seal(generation))

    async def test_stream_write_keeps_lease_until_actual_io_and_notification_finish(self):
        entered, release = threading.Event(), threading.Event()
        notified, finish = threading.Event(), threading.Event()
        payload = b"replacement bytes"
        original = self.content._wrote

        class PausedStream(io.BytesIO):
            def read(self, size=-1):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("stream release not signalled")
                return super().read(size)

        def wrote(project, path):
            notified.set()
            if not finish.wait(5):
                raise TimeoutError("notification release not signalled")
            return original(project, path)

        with patch.object(self.content, "_wrote", wrote):
            task = asyncio.create_task(
                asyncio.to_thread(
                    self.content.apply_stream,
                    self.project.id,
                    "resources/note.md",
                    PausedStream(payload),
                    len(payload),
                    "sha256:" + hashlib.sha256(payload).hexdigest(),
                    self.content.snapshot(self.project.id, "resources/note.md").revision,
                    force=False,
                    mode_bits=None,
                )
            )
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                generation = self.gate.begin()
                self.assertFalse(self.gate.seal(generation))
                self.assertEqual(self.path.read_bytes(), b"initial")
                release.set()
                self.assertTrue(await asyncio.to_thread(notified.wait, 5))
                self.assertFalse(self.gate.seal(generation))
                self.assertEqual(self.path.read_bytes(), payload)
            finally:
                release.set()
                finish.set()
                await task
        self.assertTrue(self.gate.seal(generation))

    async def test_existing_parent_can_publish_and_release_prepared_content_during_drain(self):
        with self.gate.enter(ActivityDomain.IMPORT, root=True):
            prepared = self.content.prepare_bytes(
                self.project.id, "resources", "ready.txt", b"ready"
            )
            generation = self.gate.begin()
            created = self.content.materialize(prepared)
            self.assertEqual((Path(self.project.root) / created.path).read_bytes(), b"ready")
            self.content.release_prepared(prepared)
            self.assertEqual(self.gate.snapshot().counts, {ActivityDomain.IMPORT.value: 1})
        self.assertTrue(self.gate.seal(generation))

    async def test_failed_file_write_releases_execution_and_preserves_bytes(self):
        with self.assertRaises(ContentError):
            self.content.commit_bytes(self.project.id, "resources/note.md", b"changed", "stale")
        self.assertEqual(self.path.read_bytes(), b"initial")
        self.assertEqual(self.gate.snapshot().counts, {})

    async def test_implicit_content_writes_rejected_before_mutation(self):
        project, path = self.project.id, "resources/note.md"
        binding = self.content.identify(project, path)
        scope = ArtifactScope(ArtifactScopeKind.PROJECT, project)
        target = io.BytesIO(b"untouched target")
        actions = {
            "identify": lambda: self.content.identify(project, path),
            "asset": lambda: self.content.asset(project, binding.asset.asset_id),
            "asset_status": lambda: self.content.asset_status(project, binding.asset.asset_id),
            "read_asset_bytes": lambda: self.content.read_asset_bytes(
                project, binding.asset.asset_id
            ),
            "rebind_asset": lambda: self.content.rebind_asset(project, path, "resources/new.md"),
            "root": lambda: self.content.root(project, RootKind.ARTIFACTS),
            "within_root": lambda: self.content.within_root(project, RootKind.ARTIFACTS, "new.txt"),
            "capture_stable": lambda: self.content.capture_stable(project, path, 1024, target),
            "capture_artifact": lambda: self.content.capture_artifact(scope, path),
        }
        before = {
            str(p.relative_to(self.root)): p.read_bytes()
            for p in self.root.rglob("*")
            if p.is_file()
        }
        generation = self.gate.begin()
        for name, action in actions.items():
            with self.subTest(operation=name):
                with self.assertRaises(MaintenanceActive):
                    action()
                self.assertEqual(
                    {
                        str(p.relative_to(self.root)): p.read_bytes()
                        for p in self.root.rglob("*")
                        if p.is_file()
                    },
                    before,
                )
                self.assertEqual(target.getvalue(), b"untouched target")
        self.assertTrue(self.gate.seal(generation))

    async def test_capture_waits_for_target_flush_before_releasing_execution(self):
        entered, release = threading.Event(), threading.Event()

        class PausedTarget(io.BytesIO):
            def flush(self):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError("capture flush release not signalled")
                super().flush()

        target = PausedTarget()
        task = asyncio.create_task(
            asyncio.to_thread(
                self.content.capture_stable, self.project.id, "resources/note.md", 1024, target
            )
        )
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 5))
            generation = self.gate.begin()
            self.assertFalse(self.gate.seal(generation))
        finally:
            release.set()
            captured = await task
        self.assertEqual(captured.size, len(b"initial"))
        self.assertEqual(target.read(), b"initial")
        self.assertFalse(target.closed)
        self.assertTrue(self.gate.seal(generation))
        target.close()

    async def test_identity_recovery_transaction_remains_admitted(self):
        entered, release = threading.Event(), threading.Event()
        binding = self.content.identify(self.project.id, "resources/note.md")
        original = identity._recover

        def recover(*args, **kwargs):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("identity recovery release not signalled")
            return original(*args, **kwargs)

        with patch.object(identity, "_recover", recover):
            task = asyncio.create_task(
                asyncio.to_thread(
                    self.content.read_asset_bytes, self.project.id, binding.asset.asset_id
                )
            )
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                generation = self.gate.begin()
                self.assertFalse(self.gate.seal(generation))
            finally:
                release.set()
                payload, _ = await task
        self.assertEqual(payload, b"initial")
        self.assertTrue(self.gate.seal(generation))

    async def test_admitted_parent_can_capture_and_resolve_identity_during_drain(self):
        with self.gate.enter(ActivityDomain.RESOURCE, root=True):
            generation = self.gate.begin()
            binding = self.content.identify(self.project.id, "resources/note.md")
            payload, _ = self.content.read_asset_bytes(self.project.id, binding.asset.asset_id)
            scope = ArtifactScope(ArtifactScopeKind.PROJECT, self.project.id)
            captured = self.content.capture_artifact(scope, "resources/note.md")
            self.assertEqual(self.content.read_artifact(captured), payload)
        self.assertTrue(self.gate.seal(generation))


if __name__ == "__main__":
    unittest.main()
