"""Flat resource listing completeness, durable attributes and provenance contracts."""

from __future__ import annotations

import asyncio
import os
import sqlite3
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

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
from service.resources.api.routes import register_resource_routes
from service.resources.domain.model import ResourceLocationRef
from service.resources.persistence.catalog import (
    initialize_resource_catalog,
    inspect_resource_catalog,
)
from service.resources.persistence.listing import (
    LISTING_TABLE,
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

    def entries(self) -> dict[str, dict]:
        return {entry["path"]: entry for entry in self.listing_payload()["items"]}

    def listing_changes(self, *paths: str) -> dict | None:
        response = self.client.post(
            "/api/resource/list/changes", json={"project": self.project.id, "paths": paths}
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

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

        def count_scans(path):
            if path in (self.resources, nested):
                scans.append(path)
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

        def classify_after_traversal(project, roots, *, include_repositories, track_parents=False):
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
        reopened, _, _ = ResourceListing(self.content).snapshot(
            self.project.id, track_parents=False
        )
        self.assertEqual(
            next(entry for entry in reopened if entry.path == renamed_path).source, "imported"
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
