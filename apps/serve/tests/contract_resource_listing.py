"""Flat resource listing completeness, durable attributes and provenance contracts."""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import aclosing, closing
from dataclasses import replace
from pathlib import Path
from threading import Event
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

from service.chat.service.settings import SettingsService
from service.content.domain.model import (
    PATH_OUTSIDE_AUTHORIZED_ROOT_ERROR,
    PATH_OUTSIDE_PROJECT_ERROR,
    ROOT_BUSY_ERROR,
    ContentError,
)
from service.content.persistence.catalog import ContentCatalog
from service.content.service import tree
from service.content.service.port import ContentService, ProjectRegistry
from service.content.service.space import ProjectSpace
from service.content.service.tree import PAGE_SIZE
from service.paths import PROJECT_DB_RELATIVE
from service.platform.activity import Activities
from service.platform.content import AssetKind
from service.resources.api import routes
from service.resources.api.routes import register_resource_routes
from service.resources.domain.model import ResourceLocationRef
from service.resources.persistence.catalog import (
    initialize_resource_catalog,
    inspect_resource_catalog,
)
from service.resources.persistence.listing import (
    LISTING_TABLE,
    ResourceListingCatalog,
    ResourceSource,
)
from service.resources.service.history import ResourceVersionService
from service.resources.service.listing import ResourceListing
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.retention import ResourceRetentionService
from service.resources.service.writer import ResourceWriter
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore


class ResourceListingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="resource-listing-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        workspace = self.root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(self.root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog, activities=Activities())
        self.project = self.content.create_project("列表契约")
        self.resources = Path(self.project.root) / "resources"
        self.database = Path(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE))
        app = FastAPI()
        app.state.content = self.content
        app.state.activities = Activities()
        register_resource_routes(app)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def listing_payload(self, *, incremental: bool = False) -> dict:
        params = {"project": self.project.id}
        if incremental:
            params["incremental"] = "true"
        response = self.client.get("/api/resource/list", params=params)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def directory_payload(self, path: str = "", *, versions: bool = True) -> dict:
        response = self.client.get(
            "/api/resource/list",
            params={
                "project": self.project.id,
                "directory": path,
                "versions": versions,
                "incremental": True,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def search_listing_frames(self, *, candidate_completion: bool = False) -> list[dict]:
        response = self.client.get(
            "/api/resource/list/search",
            params={
                "project": self.project.id,
                **({"candidate_completion": True} if candidate_completion else {}),
            },
            headers={"Accept": "text/event-stream"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))
        return [
            json.loads(line.removeprefix("data: "))
            for line in response.text.splitlines()
            if line.startswith("data: ")
        ]

    def entries(self) -> dict[str, dict]:
        return {entry["path"]: entry for entry in self.listing_payload()["items"]}

    def listing_changes(self, *paths: str) -> dict | None:
        response = self.client.post(
            "/api/resource/list/changes", json={"project": self.project.id, "paths": paths}
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_search_stream_reuses_one_ordered_traversal_and_full_listing_fields(self) -> None:
        repository = self.resources / "repository"
        repository.mkdir()
        (repository / ".git").mkdir()
        (repository / "deep-needle.md").touch()
        ResourceWriter(self.content).write_markdown(
            self.project.id, ResourceLocationRef("", "imported.md"), "# root"
        )
        settings = SettingsService()
        formats = WorkbenchFormatPolicy()
        versions = ResourceVersionService(
            self.content,
            ResourceRetentionService(self.content, settings),
            formats,
            PdfRecordStore(self.content),
        )
        supervisor = ResourceVersionSupervisor(
            self.content, versions, formats, settings, activities=Activities()
        )
        self.client.app.state.resource_version_supervisor = supervisor
        original = tree._listing
        scanned = []

        def record_scan(space, directory, relative, origin):
            scanned.append(relative)
            return original(space, directory, relative, origin)

        with patch.object(supervisor, "activate_project") as activate:
            expected = self.listing_payload(incremental=True)
            activate.reset_mock()
            with (
                patch.object(supervisor, "prepare_project") as prepare,
                patch.object(tree, "_listing", side_effect=record_scan),
            ):
                frames = self.search_listing_frames()
            prepare.assert_called_once_with(self.project.id)
            activate.assert_not_called()

        self.assertEqual(scanned, ["resources", "resources/repository"])
        self.assertTrue(frames[:-1])
        self.assertTrue(all(frame["type"] == "batch" for frame in frames[:-1]))
        provisional = [row for frame in frames[:-1] for row in frame["items"]]
        self.assertEqual(
            [row["path"] for row in provisional], [row["path"] for row in expected["items"]]
        )
        self.assertEqual(provisional[1]["source"], ResourceSource.IMPORTED.value)
        self.assertTrue(all("version" not in row for row in provisional))
        self.assertEqual(frames[-1], {"type": "complete", **expected})

    def test_search_candidates_complete_before_reconciling_the_full_catalog(self) -> None:
        directory = self.resources / "deep"
        directory.mkdir()
        (directory / "last-needle.md").touch()
        expected = self.listing_payload(incremental=True)
        synchronize = ResourceListingCatalog.synchronize

        async def stream() -> None:
            loop = asyncio.get_running_loop()
            sync_started = asyncio.Event()
            resume_sync = Event()

            def hold_sync(catalog, project, nodes):
                loop.call_soon_threadsafe(sync_started.set)
                if not resume_sync.wait(timeout=5):
                    raise RuntimeError("test did not release catalog synchronization")
                return synchronize(catalog, project, nodes)

            frames = routes._listing_stream_frames(
                self.content, self.project.id, None, Activities(), candidate_completion=True
            )
            with patch.object(ResourceListingCatalog, "synchronize", hold_sync):
                async with aclosing(frames):
                    try:
                        first, last, ready = [
                            json.loads(
                                (await asyncio.wait_for(anext(frames), 3)).removeprefix("data: ")
                            )
                            for _ in range(3)
                        ]
                        await asyncio.wait_for(sync_started.wait(), timeout=3)
                        self.assertEqual(first["type"], "batch")
                        self.assertEqual(last["type"], "batch")
                        self.assertEqual(last["items"][0]["name"], "last-needle.md")
                        self.assertEqual(
                            ready, {"type": "candidates_complete", "items": [], "linked_roots": {}}
                        )
                    finally:
                        resume_sync.set()
                    terminal = json.loads((await anext(frames)).removeprefix("data: "))
                    self.assertEqual(terminal, {"type": "complete", **expected})

        asyncio.run(stream())

    def test_search_candidate_completion_corrects_provenance_changed_during_traversal(self) -> None:
        (self.resources / "folder").mkdir()
        (self.resources / "root-needle.md").touch()
        nodes = self.content.flat_resource_tree(self.project.id, ("resources",)).nodes
        asset = next(node.asset for node in nodes if node.asset.name == "root-needle.md")
        catalog = ResourceListingCatalog(self.content)
        original = tree._listing

        def update_provenance(space, directory, relative, origin):
            if relative == "resources/folder":
                catalog.record(self.project.id, (asset,), ResourceSource.IMPORTED)
            return original(space, directory, relative, origin)

        with patch.object(tree, "_listing", side_effect=update_provenance):
            frames = self.search_listing_frames(candidate_completion=True)
        row = next(row for row in frames[0]["items"] if row["path"] == asset.path)
        self.assertIsNone(row["source"])
        self.assertEqual(
            frames[-2],
            {
                "type": "candidates_complete",
                "items": [{**row, "source": ResourceSource.IMPORTED.value}],
                "linked_roots": {},
            },
        )
        self.assertEqual(frames[-1], {"type": "complete", **self.listing_payload(incremental=True)})

    def test_search_stream_checks_link_grants_before_sending_candidates(self) -> None:
        outside = self.root.resolve() / "outside"
        outside.mkdir()
        (outside / "linked-needle.md").touch()
        mount = self.content.authorize_root_at(self.project.id, str(outside), "", "linked")

        frames = self.search_listing_frames()
        provisional = [
            (row, frame["linked_roots"])
            for frame in frames
            if frame["type"] == "batch"
            for row in frame["items"]
        ]
        candidate, roots = next(
            (row, roots)
            for row, roots in provisional
            if row["path"] == f"{mount.mount_path}/linked-needle.md"
        )
        self.assertEqual(candidate["link_root_id"], mount.root_id)
        self.assertEqual(roots[mount.root_id]["mount_path"], mount.mount_path)
        self.assertEqual(frames[-1]["type"], "complete")

        original = tree._listing

        def revoke_before_linked_batch(space, directory, relative, origin):
            rows = original(space, directory, relative, origin)
            if relative == mount.mount_path:
                self.content.revoke_root(mount.root_id, self.project.id)
            return rows

        with patch.object(tree, "_listing", side_effect=revoke_before_linked_batch):
            frames = self.search_listing_frames()
        self.assertEqual(frames[-1], {"type": "error", "detail": ROOT_BUSY_ERROR, "status": 409})
        self.assertFalse(
            any(
                row["name"] == "linked-needle.md" for frame in frames[:-1] for row in frame["items"]
            )
        )

        mount = self.content.authorize_root_at(self.project.id, str(outside), "", "linked")
        run_in_threadpool = routes.run_in_threadpool

        async def revoke_after_enqueue(operation):
            await run_in_threadpool(self.content.revoke_root, mount.root_id, self.project.id)
            return await run_in_threadpool(operation)

        with patch.object(routes, "run_in_threadpool", side_effect=revoke_after_enqueue) as recheck:
            frames = self.search_listing_frames()
        recheck.assert_called_once()
        self.assertEqual(frames, [{"type": "error", "detail": ROOT_BUSY_ERROR, "status": 409}])

        mount = self.content.authorize_root_at(self.project.id, str(outside), "", "linked")
        rechecks = 0

        async def revoke_on_candidate_completion(operation):
            nonlocal rechecks
            rechecks += 1
            if rechecks == 3:
                await run_in_threadpool(self.content.revoke_root, mount.root_id, self.project.id)
            return await run_in_threadpool(operation)

        with patch.object(routes, "run_in_threadpool", side_effect=revoke_on_candidate_completion):
            frames = self.search_listing_frames(candidate_completion=True)
        self.assertEqual(rechecks, 3)
        self.assertEqual([frame["type"] for frame in frames], ["batch", "batch", "error"])
        self.assertEqual(frames[-1], {"type": "error", "detail": ROOT_BUSY_ERROR, "status": 409})

    def test_flat_listing_reads_one_grant_inventory_per_linked_batch(self) -> None:
        local = self.resources / "local"
        local.mkdir()
        (local / "local.md").touch()
        outside = self.root.resolve() / "outside"
        nested = outside / "nested"
        nested.mkdir(parents=True)
        (nested / "linked.md").touch()
        self.content.authorize_root_at(self.project.id, str(outside), "", "linked")
        missing = self.root.resolve() / "missing"
        missing.mkdir()
        self.content.authorize_root_at(self.project.id, str(missing), "", "missing-link")
        missing.rmdir()
        expected = self.content.external_roots(self.project.id)
        self.assertEqual([root.available for root in expected], [True, False])

        original = tree.flat_tree
        inventories = []
        batches = []

        def observe_tree(*args, on_directory, **kwargs):
            def observe_batch(nodes, repositories):
                before = read_grants.call_count
                on_directory(nodes, repositories)
                inventories.append(read_grants.call_count - before)

            return original(*args, on_directory=observe_batch, **kwargs)

        with (
            patch.object(
                self.content._catalog, "external_roots", wraps=self.content._catalog.external_roots
            ) as read_grants,
            patch.object(tree, "flat_tree", side_effect=observe_tree),
        ):
            self.content.flat_resource_tree(
                self.project.id,
                ("resources",),
                on_directory=lambda _nodes, _repositories, roots: batches.append(roots),
            )

        self.assertEqual(batches.count(expected), 3)
        self.assertEqual(batches.count(()), 1)
        self.assertEqual(inventories, [1 if roots else 0 for roots in batches])

    def test_search_stream_rechecks_link_grants_when_traversal_occupies_the_executor(self) -> None:
        outside = self.root.resolve() / "outside"
        outside.mkdir()
        for i in range(5):
            directory = outside / str(i)
            directory.mkdir()
            (directory / "linked-needle.md").touch()
        self.content.authorize_root_at(self.project.id, str(outside), "", "linked")

        async def stream() -> list[dict]:
            loop = asyncio.get_running_loop()
            loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
            frames = routes._listing_stream_frames(
                self.content, self.project.id, None, Activities()
            )
            return [json.loads(frame.removeprefix("data: ")) async for frame in frames]

        frames = asyncio.run(asyncio.wait_for(stream(), timeout=3))
        self.assertEqual(frames[-1]["type"], "complete")
        self.assertEqual(
            sum(
                row["name"] == "linked-needle.md" for frame in frames[:-1] for row in frame["items"]
            ),
            5,
        )

    def test_search_does_not_reconcile_mount_revoked_during_candidate_completion(self) -> None:
        outside = self.root.resolve() / "outside"
        outside.mkdir()
        (outside / "linked-needle.md").touch()
        mount = self.content.authorize_root_at(self.project.id, str(outside), "", "linked")

        def revoke(_entries, _repositories, roots):
            self.assertEqual(tuple(root.root_id for root in roots), (mount.root_id,))
            self.content.revoke_root(mount.root_id, self.project.id)

        with (
            patch.object(ResourceListingCatalog, "synchronize") as synchronize,
            self.assertRaises(ContentError) as error,
        ):
            ResourceListing(self.content).progressive_snapshot(
                self.project.id,
                lambda *_: None,
                lambda: None,
                flush=lambda: None,
                complete_candidates=revoke,
            )
        self.assertEqual(error.exception.code, ROOT_BUSY_ERROR)
        synchronize.assert_not_called()

    def test_search_stream_disconnect_releases_worker_blocked_on_full_queue(self) -> None:
        outside = self.root.resolve() / "outside"
        outside.mkdir()
        for i in range(5):
            directory = outside / str(i)
            directory.mkdir()
            (directory / "linked-needle.md").touch()
        self.content.authorize_root_at(self.project.id, str(outside), "", "linked")

        async def disconnect() -> None:
            loop = asyncio.get_running_loop()
            activities = Activities()
            attempted = asyncio.Event()
            puts = []
            submit = asyncio.run_coroutine_threadsafe

            def record_put(operation, event_loop):
                future = submit(operation, event_loop)
                puts.append(future)
                if len(puts) == routes.LISTING_STREAM_BUFFER_SIZE + 2:
                    loop.call_soon_threadsafe(attempted.set)
                return future

            async def send(message):
                if message["type"] == "http.response.body":
                    await asyncio.wait_for(attempted.wait(), timeout=3)
                    self.assertFalse(puts[-1].done())
                    raise OSError("client disconnected")

            response = routes._ListingStream(
                routes._listing_stream_frames(self.content, self.project.id, None, activities)
            )
            with (
                patch.object(asyncio, "run_coroutine_threadsafe", side_effect=record_put),
                self.assertRaises(ClientDisconnect),
            ):
                await response({"type": "http", "asgi": {"spec_version": "2.4"}}, None, send)
            await loop.shutdown_default_executor(timeout=3)
            self.assertTrue(puts[-1].cancelled())
            self.assertFalse(activities.snapshot().counts)

        asyncio.run(disconnect())

    def test_directory_listing_projects_one_group_before_optional_versions(self) -> None:
        folder = self.resources / "folder"
        nested = folder / "nested"
        nested.mkdir(parents=True)
        (nested / "deep.md").touch()
        (folder / "child.md").touch()
        (folder / ".git").mkdir()
        ResourceWriter(self.content).write_markdown(
            self.project.id, ResourceLocationRef("", "root.md"), "# root"
        )

        settings = SettingsService()
        formats = WorkbenchFormatPolicy()
        versions = ResourceVersionService(
            self.content,
            ResourceRetentionService(self.content, settings),
            formats,
            PdfRecordStore(self.content),
        )
        supervisor = ResourceVersionSupervisor(
            self.content, versions, formats, settings, activities=Activities()
        )
        self.client.app.state.resource_version_supervisor = supervisor
        original = tree._listing
        scanned = []

        def record_scan(space, directory, relative, origin):
            scanned.append(relative)
            return original(space, directory, relative, origin)

        with (
            patch.object(supervisor, "activate_project") as activate,
            patch.object(supervisor, "prepare_project") as prepare,
            patch.object(
                supervisor, "capability_states", wraps=supervisor.capability_states
            ) as capabilities,
            patch.object(tree, "_listing", side_effect=record_scan),
            patch.object(tree, "_child_total") as count,
        ):
            first = self.directory_payload(versions=False)
            activate.assert_not_called()
            prepare.assert_not_called()
            capabilities.assert_not_called()
            count.assert_not_called()
            self.assertEqual(scanned, ["resources"])
            self.assertEqual(first["directory"], "resources")
            self.assertEqual(
                [row["path"] for row in first["items"]], ["resources/folder", "resources/root.md"]
            )

            scanned.clear()
            root = self.directory_payload()
            self.assertEqual(scanned, ["resources"])
            scanned.clear()
            child = self.directory_payload("resources/folder")
            self.assertEqual(scanned, ["resources/folder"])
            count.assert_not_called()
            self.assertEqual(child["directory"], "resources/folder")
            self.assertEqual(
                [row["path"] for row in child["items"]],
                ["resources/folder/nested", "resources/folder/child.md"],
            )
            scoped_version_calls = [call.args[1] for call in capabilities.call_args_list]
            self.assertEqual(
                scoped_version_calls,
                [
                    ("resources/folder", "resources/root.md"),
                    ("resources/folder/nested", "resources/folder/child.md"),
                ],
            )
            full = self.listing_payload(incremental=True)
            self.assertEqual(activate.call_count, 2)
            prepare.assert_called_once_with(self.project.id)

        self.assertNotIn("directory", full)
        full_groups = {
            scope: [row for row in full["items"] if row["path"].rpartition("/")[0] == scope]
            for scope in ("resources", "resources/folder")
        }
        for loaded in (root, child):
            self.assertEqual(loaded["items"], full_groups[loaded["directory"]])
            self.assertEqual(loaded["linked_roots"], full["linked_roots"])
        self.assertEqual(
            first["items"],
            [
                {key: value for key, value in row.items() if key != "version"}
                for row in root["items"]
            ],
        )
        self.assertEqual(root["items"][1]["source"], ResourceSource.IMPORTED.value)
        self.assertEqual(root["items"][0]["version"]["management_state"], "git")
        self.assertEqual(first["incremental"]["supported"], os.name == "posix")
        self.assertEqual(
            first["incremental"]["parents"], ["resources"] if os.name == "posix" else []
        )

    def test_directory_listing_distinguishes_the_legacy_root_from_the_complete_list(self) -> None:
        legacy = self.root / "legacy"
        (legacy / "folder").mkdir(parents=True)
        (legacy / "folder" / "nested.md").touch()
        (legacy / "root.md").touch()
        project = self.content.adopt_project(str(legacy))
        full = self.client.get("/api/resource/list", params={"project": project.id})
        first = self.client.get(
            "/api/resource/list",
            params={"project": project.id, "directory": "", "versions": "false"},
        )
        self.assertEqual(full.status_code, 200, full.text)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["directory"], "")
        self.assertEqual(
            first.json()["items"],
            [row for row in full.json()["items"] if "/" not in row["path"]],
        )

    def test_directory_listing_keeps_catalog_rows_outside_its_group(self) -> None:
        folder = self.resources / "folder"
        folder.mkdir()
        (folder / "nested").mkdir()
        (folder / "nested" / "descendant.md").touch()
        (folder / "removed.md").touch()
        (self.resources / "other.md").touch()
        self.listing_payload()
        (folder / "removed.md").unlink()
        self.directory_payload("resources/folder", versions=False)
        with closing(sqlite3.connect(self.database)) as connection:
            paths = {row[0] for row in connection.execute(f"SELECT path FROM {LISTING_TABLE}")}
        self.assertIn("resources/other.md", paths)
        self.assertIn("resources/folder/nested/descendant.md", paths)
        self.assertNotIn("resources/folder/removed.md", paths)

    @unittest.skipUnless(os.name == "posix", "Incremental listings require POSIX directories")
    def test_directory_listing_seeds_incremental_without_loading_ancestors(self) -> None:
        folder = self.resources / "new" / "nested"
        folder.mkdir(parents=True)
        child = self.directory_payload("resources/new/nested", versions=False)
        self.assertEqual(
            child["incremental"], {"parents": ["resources/new/nested"], "supported": True}
        )
        (folder / "created.md").touch()
        path = "resources/new/nested/created.md"
        change = self.listing_changes(path)
        self.assertIsNotNone(change)
        assert change is not None
        self.assertEqual(change["groups"], [{"parent": "resources/new/nested", "paths": [path]}])
        self.assertEqual(change["items"], self.directory_payload("resources/new/nested")["items"])

    @unittest.skipUnless(os.name == "posix", "Requires native POSIX symlink creation")
    def test_directory_listing_uses_canonical_alias_scope_and_checks_grants(self) -> None:
        target = self.resources / "target"
        target.mkdir()
        (target / "child.md").touch()
        (self.resources / "alias").symlink_to("target", target_is_directory=True)

        outside = self.root.resolve() / "outside"
        outside.mkdir()
        (outside / "private.md").touch()
        (self.resources / "outside-alias").symlink_to(outside, target_is_directory=True)

        alias = self.directory_payload("resources/alias")
        self.assertEqual(alias["directory"], "resources/target")
        self.assertEqual(alias["items"], self.directory_payload("resources/target")["items"])
        self.assertFalse(alias["incremental"]["supported"])

        for path in ("resources/outside-alias", "../outside", "resources/.git"):
            with self.subTest(path=path):
                response = self.client.get(
                    "/api/resource/list", params={"project": self.project.id, "directory": path}
                )
                self.assertEqual(response.status_code, 400, response.text)

    def test_directory_listing_expands_only_authorized_linked_scope(self) -> None:
        outside = self.root.resolve() / "outside"
        outside.mkdir()
        (outside / "linked.md").touch()
        (outside / "nested").mkdir()
        (outside / "nested" / "not-loaded.md").touch()
        mount = self.content.authorize_root_at(self.project.id, str(outside), "", "node_modules")
        root = self.directory_payload()
        self.assertEqual([row["path"] for row in root["items"]], [mount.mount_path])
        linked = self.directory_payload(mount.mount_path)
        self.assertEqual(linked["directory"], mount.mount_path)
        self.assertEqual(
            [row["path"] for row in linked["items"]],
            [f"{mount.mount_path}/nested", f"{mount.mount_path}/linked.md"],
        )
        self.assertTrue(all(row["link_root_id"] == mount.root_id for row in linked["items"]))
        self.assertEqual(linked["linked_roots"], root["linked_roots"])
        self.assertFalse(linked["incremental"]["supported"])

        original = tree._listing

        def revoke_during_scope(space, directory, relative, origin):
            self.content.revoke_root(mount.root_id, self.project.id)
            return original(space, directory, relative, origin)

        with patch.object(tree, "_listing", side_effect=revoke_during_scope):
            revoked = self.client.get(
                "/api/resource/list",
                params={"project": self.project.id, "directory": mount.mount_path},
            )
        self.assertEqual(revoked.status_code, 409, revoked.text)
        self.assertEqual(revoked.json()["detail"], ROOT_BUSY_ERROR)

    @unittest.skipUnless(os.name == "posix", "Requires POSIX file observations and symlinks")
    def test_flat_listing_reuses_regular_file_facts_for_version_projection(self) -> None:
        settings = SettingsService()
        formats = WorkbenchFormatPolicy()
        versions = ResourceVersionService(
            self.content,
            ResourceRetentionService(self.content, settings),
            formats,
            PdfRecordStore(self.content),
        )
        supervisor = ResourceVersionSupervisor(
            self.content, versions, formats, settings, activities=Activities()
        )
        self.client.app.state.resource_version_supervisor = supervisor
        local = self.resources / "local.md"
        local.write_text("local", encoding="utf-8")
        (self.resources / "linked.md").symlink_to(local.name)
        (self.resources / "broken.md").symlink_to("missing.md")
        outside = Path(self.project.root) / "outside.md"
        outside.touch()
        (self.resources / "outside-link.md").symlink_to(outside)
        hidden = self.resources / ".hidden"
        hidden.mkdir()
        (hidden / "note.md").touch()
        (self.resources / "directory-alias").symlink_to(hidden.name, target_is_directory=True)
        (self.resources / "unsupported.bin").touch()
        (self.resources / "unusual\\name.md").touch()
        os.mkfifo(self.resources / "pipe.md")
        os.link(local, self.resources / "hardlink.md")
        with (self.resources / "large.md").open("wb") as stream:
            stream.truncate(supervisor.max_size_bytes() + 1)
        repository = self.resources / "git"
        nested = repository / "nested"
        nested.mkdir(parents=True)
        (repository / ".git").mkdir()
        (nested / ".git").mkdir()
        (nested / "tracked.md").touch()

        original = self.content.flat_resource_tree

        def without_observations(project, roots, **options):
            options["observe_entries"] = False
            return original(project, roots, **options)

        with patch.object(supervisor, "activate_project"):
            with patch.object(self.content, "flat_resource_tree", side_effect=without_observations):
                expected = self.listing_payload(incremental=True)
            with patch.object(
                self.content, "resource_entries", wraps=self.content.resource_entries
            ) as inspect_paths:
                actual = self.listing_payload(incremental=True)

        self.assertEqual(actual, expected)
        inspect_paths.assert_called_once()
        inspected = set(inspect_paths.call_args.args[1])
        self.assertIn("resources/linked.md", inspected)
        self.assertIn("resources/.hidden/note.md", inspected)
        self.assertIn("resources/unusual\\name.md", inspected)
        self.assertTrue(
            inspected.isdisjoint(
                {
                    "resources/local.md",
                    "resources/large.md",
                    "resources/unsupported.bin",
                    "resources/hardlink.md",
                    "resources/pipe.md",
                }
            )
        )

    @unittest.skipUnless(os.name == "posix", "Requires POSIX directory descriptors")
    def test_flat_listing_observations_stay_with_the_pinned_directory(self) -> None:
        nested = self.resources / "nested"
        nested.mkdir()
        (nested / "local.md").write_bytes(b"local")
        outside = self.root.resolve() / "outside"
        outside.mkdir()
        (outside / "private.md").touch()
        original = tree._listing

        def replace_before_listing(space, directory, relative, origin):
            if relative == "resources/nested":
                nested.rename(self.resources / "retired")
                nested.symlink_to(outside, target_is_directory=True)
            return original(space, directory, relative, origin)

        with patch.object(tree, "_listing", side_effect=replace_before_listing):
            result = self.content.flat_resource_tree(
                self.project.id, ("resources",), observe_entries=True
            )
        local = result.observed_entries["resources/nested/local.md"]
        self.assertIsNotNone(local)
        assert local is not None
        self.assertEqual(local.size, len(b"local"))
        self.assertNotIn("resources/nested/private.md", result.observed_entries)
        self.assertNotIn("resources/nested/private.md", {node.asset.path for node in result.nodes})

    @unittest.skipUnless(os.name == "posix", "Incremental listings require POSIX directories")
    def test_listing_changes_read_only_affected_parents(self) -> None:
        empty = self.resources / "empty"
        empty.mkdir()
        repository = self.resources / "git"
        repository.mkdir()
        (repository / ".git").mkdir()
        (repository / "modified.md").touch()
        (repository / "moved.md").touch()
        (repository / "deleted.md").touch()
        other = self.resources / "other"
        other.mkdir()
        (other / "unrelated.md").touch()
        initial = self.listing_payload(incremental=True)
        self.assertEqual(
            initial.pop("incremental"),
            {
                "supported": True,
                "parents": ["resources", "resources/empty", "resources/git", "resources/other"],
            },
        )
        self.assertEqual(initial, self.listing_payload())

        (repository / "modified.md").write_text("updated", encoding="utf-8")
        (repository / "moved.md").rename(empty / "renamed.md")
        (repository / "deleted.md").unlink()
        (empty / "added.md").touch()
        changed = (
            "resources/git/modified.md",
            "resources/git/deleted.md",
            "resources/git/moved.md",
            "resources/empty/renamed.md",
            "resources/empty/added.md",
        )
        with patch.object(tree, "_listing", wraps=tree._listing) as visits:
            delta = self.listing_changes(*changed, changed[0])
        assert delta is not None
        self.assertEqual(
            [call.args[2] for call in visits.call_args_list], ["resources/git", "resources/empty"]
        )
        final = self.listing_payload()
        final_by_path = {item["path"]: item for item in final["items"]}
        self.assertEqual(
            {item["path"]: item for item in delta["items"]},
            {path: final_by_path[path] for path in changed if path in final_by_path},
        )
        self.assertEqual(
            delta["groups"],
            [
                {
                    "parent": parent,
                    "paths": [path for path in final_by_path if path.rpartition("/")[0] == parent],
                }
                for parent in ("resources/git", "resources/empty")
            ],
        )

    @unittest.skipUnless(os.name == "posix", "Incremental listings require POSIX directories")
    def test_listing_changes_fall_back_for_directory_alias_and_scope(self) -> None:
        removed = self.resources / "removed"
        removed.mkdir()
        named = self.resources / "MixedCase"
        named.mkdir()
        (named / "file.md").touch()
        (self.resources / "plain.md").touch()
        self.assertTrue(self.listing_payload(incremental=True)["incremental"]["supported"])
        removed.rmdir()
        self.assertIsNone(self.listing_changes("resources/removed"))
        (self.resources / "directory").mkdir()
        (self.resources / "directory" / "unlisted.md").touch()
        self.assertIsNone(self.listing_changes("resources/directory"))
        self.assertIsNone(self.listing_changes("resources/directory/unlisted.md"))
        self.assertIsNone(self.listing_changes("resources/mixedcase/file.md"))
        self.assertIsNone(self.listing_changes("resources/.gitignore"))
        self.assertIsNone(self.listing_changes("resources/./plain.md"))
        self.assertIsNone(self.listing_changes("resources/../external.md"))
        self.assertIsNone(self.listing_changes("outside.md"))
        alias = self.resources / "alias.md"
        alias.symlink_to("plain.md")
        self.assertIsNone(self.listing_changes("resources/alias.md"))
        self.assertFalse(self.listing_payload(incremental=True)["incremental"]["supported"])
        alias.unlink()
        os.link(self.resources / "plain.md", alias)
        self.assertIsNone(self.listing_changes("resources/alias.md"))
        self.assertFalse(self.listing_payload(incremental=True)["incremental"]["supported"])

    def test_listing_changes_fall_back_for_external_mounts(self) -> None:
        source = self.root / "outside"
        source.mkdir()
        (source / "file.md").touch()
        self.content.authorize_root_at(self.project.id, str(source), "resources", source.name)
        listing = self.listing_payload(incremental=True)
        self.assertEqual(listing.pop("incremental"), {"parents": [], "supported": False})
        self.assertEqual(listing, self.listing_payload())
        self.assertIsNone(self.listing_changes("resources/outside/file.md"))

    @unittest.skipUnless(os.name == "posix", "Incremental listings require POSIX directories")
    def test_listing_changes_fall_back_for_unsupported_directory_names(self) -> None:
        for name in ("CON", "trailing."):
            (self.resources / name).mkdir()
        self.assertTrue(self.listing_payload(incremental=True)["incremental"]["supported"])

        for name in ("CON", "trailing."):
            with self.subTest(name=name):
                (self.resources / name / "created.md").touch()
                path = f"resources/{name}/created.md"
                self.assertIsNone(self.listing_changes(path))
                self.assertEqual(self.entries()[path]["kind"], AssetKind.FILE.value)

    def test_flat_complete_pagination_depth_and_project_scope(self) -> None:
        registered = self.content.projects()
        for parameters, expected, detail in (
            ({}, 422, None),
            ({"project": ""}, 422, None),
            ({"project": "current"}, 400, "no_project_selected"),
            ({"project": "unknown-project"}, 404, "unknown_project"),
            ({"project": self.project.root}, 404, "unknown_project"),
            ([("project", self.project.id), ("project", "")], 422, None),
            ([("project", self.project.id), ("project", "current")], 400, "no_project_selected"),
            (
                [("project", self.project.id), ("project", "unknown-project")],
                404,
                "unknown_project",
            ),
        ):
            response = self.client.get("/api/resource/list", params=parameters)
            self.assertEqual(response.status_code, expected, f"{parameters}: {response.text}")
            if expected == 422:
                self.assertEqual(response.json()["detail"][0]["loc"], ["query", "project"])
                self.assertEqual(
                    response.json()["detail"][0]["type"],
                    "missing" if not parameters else "string_too_short",
                )
            else:
                self.assertEqual(response.json(), {"detail": detail})
            self.assertEqual(self.content.projects(), registered)
        response = self.client.get(
            "/api/resource/list",
            params=[("project", "unknown-project"), ("project", self.project.id)],
        )
        self.assertEqual(response.status_code, 200, response.text)
        deep = self.resources / "一" / "二" / "三" / "四"
        deep.mkdir(parents=True)
        (deep / "深处.csv").write_text("name,value\n验证,1\n", encoding="utf-8")
        for index in range(PAGE_SIZE + 3):
            (self.resources / f"file-{index:03}.md").write_text("# test", encoding="utf-8")
        other = self.content.create_project("其他项目")
        self.content.create_text(other.id, "resources", "不可见.md", "private")
        rows = self.entries()
        self.assertEqual(len(rows), PAGE_SIZE + 8)
        self.assertIn("resources/一/二/三/四/深处.csv", rows)
        self.assertIn(f"resources/file-{PAGE_SIZE + 2:03}.md", rows)
        self.assertNotIn("resources/不可见.md", rows)
        self.assertEqual(rows["resources/一"]["kind"], AssetKind.DIR.value)
        self.assertIsNone(rows["resources/一"]["updated_at"])
        self.assertIsNone(rows["resources/file-000.md"]["source"])

    def test_listing_disk_projection_runs_outside_event_loop(self) -> None:
        (self.resources / "worker.md").write_text("# worker", encoding="utf-8")
        original = self.content.flat_resource_tree
        called = []

        def project_tree(*args, **kwargs):
            with self.assertRaises(RuntimeError):
                asyncio.get_running_loop()
            called.append(True)
            return original(*args, **kwargs)

        with patch.object(self.content, "flat_resource_tree", side_effect=project_tree):
            rows = self.entries()
        self.assertTrue(called)
        self.assertIn("resources/worker.md", rows)

    def test_wide_flat_listing_reads_each_directory_once(self) -> None:
        nested = self.resources / "nested"
        nested.mkdir()
        for index in range(PAGE_SIZE + 1):
            (nested / f"file-{index:03}.md").touch()
        scans = []
        original = os.scandir
        directories = {}
        for directory in (self.resources, nested):
            identity = directory.stat()
            directories[identity.st_dev, identity.st_ino] = directory

        def count_scans(path):
            if isinstance(path, int):
                identity = os.fstat(path)
                path_key = directories.get((identity.st_dev, identity.st_ino))
            else:
                path_key = path
            if path_key in (self.resources, nested):
                scans.append(path_key)
            return original(path)

        with patch("service.content.service.tree.os.scandir", side_effect=count_scans):
            rows = self.entries()

        self.assertEqual(len(rows), PAGE_SIZE + 2)
        self.assertEqual(scans, [self.resources, nested])

    @unittest.skipUnless(os.name == "posix", "Windows uses reparse-aware path resolution")
    def test_ordinary_files_skip_individual_path_resolution(self) -> None:
        nested = self.resources / "repository" / "nested"
        nested.mkdir(parents=True)
        (nested.parent / ".git").mkdir()
        paths = set()
        for index in range(32):
            (nested / f"note-{index}.md").touch()
            paths.add(f"resources/repository/nested/note-{index}.md")
        original = ProjectSpace.absolute
        resolved = []

        def record_resolution(scope, path, **options):
            resolved.append(path)
            return original(scope, path, **options)

        with patch.object(ProjectSpace, "absolute", record_resolution):
            rows = self.entries()

        self.assertTrue(paths <= rows.keys())
        self.assertTrue(rows["resources/repository"]["git_repository"])
        self.assertFalse(paths.intersection(resolved))

    @unittest.skipUnless(os.name == "posix", "Requires native POSIX directory symlinks")
    def test_plain_directories_share_resolution_between_tree_and_git(self) -> None:
        repository = self.resources / "repository"
        nested = repository / "nested"
        nested.mkdir(parents=True)
        (repository / ".git").mkdir()
        (nested / ".git").write_text("gitdir: /unavailable/repository\n", encoding="utf-8")
        (nested / "note.md").touch()
        (self.resources / "alias").symlink_to("repository/nested", target_is_directory=True)
        original = ProjectSpace.absolute
        resolved = []
        reused_roots = []

        def record_resolution(scope, path, **options):
            resolved.append(path)
            if options.get("reuse_project_root"):
                reused_roots.append(path)
            return original(scope, path, **options)

        with patch.object(ProjectSpace, "absolute", record_resolution):
            flat = self.content.flat_resource_tree(
                self.project.id, ("resources",), include_repositories=True
            )

        paths = tuple(node.asset.path for node in flat.nodes)
        self.assertEqual(flat.repositories, self.content.repository_roots(self.project.id, paths))
        self.assertEqual(flat.repositories["resources/alias"], "resources/repository/nested")
        self.assertEqual(paths.count("resources/repository/nested/note.md"), 1)
        self.assertEqual(resolved.count("resources/alias"), 2)
        self.assertEqual(resolved.count("resources/repository"), 1)
        self.assertEqual(resolved.count("resources/repository/nested"), 1)
        self.assertEqual(reused_roots, ["resources/repository", "resources/repository/nested"])

    def test_git_classification_preserves_flat_payload_and_grant_boundaries(self) -> None:
        repository = self.resources / "repository"
        nested = repository / "nested"
        nested.mkdir(parents=True)
        (repository / ".git").mkdir()
        (repository / "first.md").touch()
        (nested / ".git").write_text("gitdir: /unavailable/repository\n", encoding="utf-8")
        (nested / "second.md").touch()
        (self.resources / "local.md").touch()

        external = self.root.resolve() / "external"
        subset = external / "subset"
        subset.mkdir(parents=True)
        (external / ".git").mkdir()
        (subset / "isolated.md").touch()
        linked_repository = self.root.resolve() / "linked-repository"
        linked_repository.mkdir()
        (linked_repository / ".git").mkdir()
        (linked_repository / "linked.md").touch()
        linked_file = external / "single.md"
        linked_file.touch()
        for source in (subset, linked_repository, linked_file):
            self.content.authorize_root_at(self.project.id, str(source), "repository", source.name)

        settings = SettingsService()
        formats = WorkbenchFormatPolicy()
        versions = ResourceVersionService(
            self.content,
            ResourceRetentionService(self.content, settings),
            formats,
            PdfRecordStore(self.content),
        )
        supervisor = ResourceVersionSupervisor(
            self.content, versions, formats, settings, activities=Activities()
        )
        self.client.app.state.resource_version_supervisor = supervisor
        original = self.content.flat_resource_tree

        def classify_after_traversal(
            project, roots, *, include_repositories, track_parents=False, observe_entries=False
        ):
            result = original(project, roots, track_parents=track_parents)
            paths = tuple(node.asset.path for node in result.nodes)
            return replace(result, repositories=self.content.repository_roots(project, paths))

        with patch.object(supervisor, "activate_project"):
            with patch.object(
                self.content, "flat_resource_tree", side_effect=classify_after_traversal
            ):
                expected = self.listing_payload()
            with patch.object(self.content, "repository_roots") as batch:
                actual = self.listing_payload()
                batch.assert_not_called()

        self.assertEqual(actual, expected)
        rows = {row["path"]: row for row in actual["items"]}
        self.assertEqual(
            {path for path, row in rows.items() if row["git_repository"]},
            {
                "resources/repository",
                "resources/repository/nested",
                "resources/repository/linked-repository",
            },
        )
        self.assertEqual(
            {path for path, row in rows.items() if row["version"]["management_state"] == "git"},
            {
                "resources/repository",
                "resources/repository/first.md",
                "resources/repository/nested",
                "resources/repository/nested/second.md",
                "resources/repository/linked-repository",
                "resources/repository/linked-repository/linked.md",
            },
        )
        self.assertFalse(any(path.endswith("/.git") for path in rows))

    @unittest.skipUnless(os.name == "posix", "Requires native POSIX symlink creation")
    def test_flat_git_classification_uses_resolved_symlink_target(self) -> None:
        repository = self.resources / "repository"
        repository.mkdir()
        (repository / ".git").mkdir()
        (repository / "tracked.md").touch()
        (self.resources / "local.md").touch()
        (repository / "local-alias.md").symlink_to("../local.md")
        (self.resources / "tracked-alias.md").symlink_to("repository/tracked.md")
        (self.resources / "directory-alias").symlink_to("repository", target_is_directory=True)
        outside = Path(self.project.root) / "private.md"
        outside.touch()
        (repository / "outside-alias.md").symlink_to(outside)

        result = self.content.flat_resource_tree(
            self.project.id, ("resources",), include_repositories=True
        )
        paths = tuple(node.asset.path for node in result.nodes)

        self.assertEqual(result.repositories, self.content.repository_roots(self.project.id, paths))
        for path, repository_root in {
            "resources/repository/local-alias.md": None,
            "resources/repository/outside-alias.md": None,
            "resources/tracked-alias.md": "resources/repository",
            "resources/directory-alias": "resources/repository",
        }.items():
            self.assertEqual(result.repositories[path], repository_root)

    def test_flat_listing_discards_metadata_if_mount_is_revoked_during_scan(self) -> None:
        external = self.root.resolve() / "external"
        external.mkdir()
        (external / "private.md").touch()
        mount = self.content.authorize_root_at(self.project.id, str(external), "", "linked")
        original = os.scandir

        def revoke_after_open(path):
            opened = original(path)
            if path == external:
                self.content.revoke_root(mount.root_id, self.project.id)
            return opened

        with patch("service.content.service.tree.os.scandir", side_effect=revoke_after_open):
            response = self.client.get("/api/resource/list", params={"project": self.project.id})

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": ROOT_BUSY_ERROR})
        self.assertEqual(self.entries(), {})

    def test_flat_listing_skips_descendants_of_directory_aliases_outside_their_grant(self) -> None:
        outside = self.root.resolve() / "outside"
        outside.mkdir()
        (outside / ".git").mkdir()
        (outside / "outside.md").touch()
        granted = self.root.resolve() / "granted"
        granted.mkdir()

        for parent, denied in (
            (self.resources, PATH_OUTSIDE_PROJECT_ERROR),
            (granted, PATH_OUTSIDE_AUTHORIZED_ROOT_ERROR),
        ):
            with self.subTest(denied=denied):
                mount = (
                    None
                    if parent == self.resources
                    else self.content.authorize_root_at(self.project.id, str(parent), "", "linked")
                )
                prefix = mount.mount_path if mount is not None else "resources"
                alias = parent / "alias"
                if os.name == "nt":
                    subprocess.run(
                        ["cmd.exe", "/d", "/c", "mklink", "/J", str(alias), str(outside)],
                        check=True,
                        capture_output=True,
                    )
                else:
                    alias.symlink_to(outside, target_is_directory=True)
                try:
                    (parent / "sibling.md").touch()
                    with patch("service.content.service.tree.os.scandir", wraps=os.scandir) as scan:
                        snapshot = self.listing_payload(incremental=True)
                    self.assertNotIn(outside, [call.args[0] for call in scan.call_args_list])
                    logical = f"{prefix}/alias"
                    children = [
                        row for row in snapshot["items"] if row["path"].rpartition("/")[0] == prefix
                    ]
                    self.assertEqual([row["name"] for row in children], ["alias", "sibling.md"])
                    self.assertEqual(children[0]["kind"], "dir")
                    self.assertFalse(children[0]["git_repository"])
                    self.assertEqual(children[0]["link_root_id"], mount.root_id if mount else None)
                    self.assertFalse(
                        any(row["path"].startswith(f"{logical}/") for row in snapshot["items"])
                    )
                    self.assertEqual(snapshot["incremental"], {"parents": [], "supported": False})
                    self.assertIsNone(self.listing_changes(f"{prefix}/sibling.md"))
                    with self.assertRaises(ContentError) as root_error:
                        self.content.flat_resource_tree(self.project.id, (logical,))
                    self.assertEqual(root_error.exception.code, denied)
                    with self.assertRaises(ContentError) as read_error:
                        self.content.read_text(self.project.id, f"{logical}/outside.md")
                    self.assertEqual(read_error.exception.code, denied)
                finally:
                    if os.name == "nt":
                        alias.rmdir()
                    else:
                        alias.unlink()

    def test_capability_batch_does_not_read_settings_per_file(self) -> None:
        settings = SettingsService()
        formats = WorkbenchFormatPolicy()
        versions = ResourceVersionService(
            self.content,
            ResourceRetentionService(self.content, settings),
            formats,
            PdfRecordStore(self.content),
        )
        supervisor = ResourceVersionSupervisor(
            self.content, versions, formats, settings, activities=Activities()
        )
        paths = tuple(f"resources/file-{index}.md" for index in range(8))
        for path in paths:
            (Path(self.project.root) / path).write_text("# file", encoding="utf-8")
        counts = []
        for selected in (paths[:1], paths):
            with patch.object(settings, "_read", return_value={}) as reads:
                states = supervisor.capability_states(self.project.id, selected)
            counts.append(reads.call_count)
            self.assertEqual(set(states), set(selected))
            self.assertTrue(all(state.can_version for state in states.values()))
        self.assertGreater(counts[0], 0)
        self.assertEqual(counts[0], counts[1])

    def test_attributes_survive_refresh_rename_copy_and_catalog_reopen(self) -> None:
        created = self.client.post(
            "/api/resource/node",
            json={"project": self.project.id, "action": "create_document", "name": "手动.md"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        source = self.root / "导入.csv"
        source.write_text("name,value\n导入,1", encoding="utf-8")
        imported = ResourceWriter(self.content).import_file(
            self.project.id, str(source), ResourceLocationRef(parent="", name=source.name)
        )
        before = self.entries()
        self.assertEqual(before[imported.path]["source"], ResourceSource.IMPORTED.value)
        self.assertEqual(before[imported.path]["file_type"], "CSV")
        self.assertEqual(before["resources/手动.md"]["source"], ResourceSource.CREATED.value)
        self.assertIsInstance(before[imported.path]["updated_at"], float)
        renamed = self.client.post(
            "/api/resource/node",
            json={
                "project": self.project.id,
                "action": "rename",
                "path": imported.path,
                "name": "改名.csv",
            },
        )
        self.assertEqual(renamed.status_code, 200, renamed.text)
        renamed_path = renamed.json()["node"]["path"]
        copied = self.client.post(
            "/api/resource/node",
            json={"project": self.project.id, "action": "copy", "path": renamed_path},
        )
        self.assertEqual(copied.status_code, 200, copied.text)
        copied_path = copied.json()["node"]["path"]
        after = self.entries()
        self.assertNotIn(imported.path, after)
        self.assertEqual(after[renamed_path]["source"], "imported")
        self.assertEqual(after[copied_path]["source"], "imported")
        with sqlite3.connect(self.database) as connection:
            connection.execute("CREATE TABLE unrelated (extra TEXT)")
            connection.execute("INSERT INTO unrelated VALUES ('preserved')")
            stored = connection.execute(
                f"SELECT name,kind,file_type,source,updated_at,origin FROM {LISTING_TABLE} WHERE path=?",
                (renamed_path,),
            ).fetchone()
        self.assertEqual(
            stored,
            tuple(
                after[renamed_path][key]
                for key in ("name", "kind", "file_type", "source", "updated_at", "origin")
            ),
        )
        reopened = ResourceListing(self.content).snapshot(self.project.id, track_parents=False)
        self.assertEqual(
            next(entry for entry in reopened.entries if entry.path == renamed_path).source,
            "imported",
        )
        initialize_resource_catalog(self.database, Path(self.project.root))
        self.assertFalse(inspect_resource_catalog(self.database).needs_write)
        with sqlite3.connect(self.database) as connection:
            self.assertEqual(
                connection.execute("SELECT extra FROM unrelated").fetchone(), ("preserved",)
            )

    def test_directory_import_children_inherit_but_unknown_source_is_not_guessed(self) -> None:
        folder = self.content.create(self.project.id, "resources", "导入目录", AssetKind.DIR)
        self.content.create_text(self.project.id, folder.path, "子文件.md", "# child")
        ResourceListing(self.content).record_import(self.project.id, (folder,))
        self.content.create_text(self.project.id, folder.path, "后来新增.md", "# external")
        self.content.create_text(self.project.id, "resources", "外部创建.md", "# unknown")
        rows = self.entries()
        self.assertEqual(rows[f"{folder.path}/子文件.md"]["source"], "imported")
        self.assertIsNone(rows[f"{folder.path}/后来新增.md"]["source"])
        self.assertIsNone(rows["resources/外部创建.md"]["source"])
        self.assertEqual(rows, self.entries())


def main() -> int:
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(ResourceListingTests)
    )
    return int(not result.wasSuccessful())


if __name__ == "__main__":
    raise SystemExit(main())
