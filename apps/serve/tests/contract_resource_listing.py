"""Flat resource listing completeness, durable attributes and provenance contracts."""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.service.settings import SettingsService
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
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

    def entries(self) -> dict[str, dict]:
        response = self.client.get("/api/resource/list", params={"project": self.project.id})
        self.assertEqual(response.status_code, 200, response.text)
        return {entry["path"]: entry for entry in response.json()["items"]}

    def test_flat_complete_pagination_depth_and_project_scope(self) -> None:
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
        original = self.content.repository_roots
        called = []

        def project_repositories(*args, **kwargs):
            with self.assertRaises(RuntimeError):
                asyncio.get_running_loop()
            called.append(True)
            return original(*args, **kwargs)

        with patch.object(self.content, "repository_roots", side_effect=project_repositories):
            rows = self.entries()
        self.assertTrue(called)
        self.assertIn("resources/worker.md", rows)

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
        reopened = ResourceListing(self.content).list(self.project.id)
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
