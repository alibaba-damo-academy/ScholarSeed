"""Folder creation preserves operating-system length failures as actionable codes."""

import errno
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.domain.model import MANAGED_RESOURCES_ROOT_RELATIVE, ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.assets import MARKDOWN_SUFFIX
from service.content.service.port import ContentService, ProjectRegistry
from service.content.service.utils import filesystem_error
from service.platform.content import AssetKind
from service.resources.api.routes import register_resource_routes


class FolderNames(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name).resolve()
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        registry.seed_workspace()
        self.content = ContentService(registry, catalog)
        self.project = self.content.create_project("folder-test")
        self.parent = MANAGED_RESOURCES_ROOT_RELATIVE

    def create(self, name):
        return self.content.create(self.project.id, self.parent, name, AssetKind.DIR)

    def test_real_names(self):
        for name in ("a" * 300, "中" * 300):
            with self.subTest(name=name), self.assertRaises(ContentError) as caught:
                self.create(name)
            self.assertEqual(caught.exception.code, "name_too_long")
        for name in ("notes", "笔记"):
            self.assertEqual(self.create(name).name, name)
            self.assertEqual(self.create(name).name, f"{name} (2)")

    @unittest.skipUnless(sys.platform == "darwin", "macOS native filename boundary")
    def test_duplicate_suffix_exceeds_filesystem_limit(self):
        name = "a" * 255
        self.create(name)
        with self.assertRaises(ContentError) as caught:
            self.create(name)
        self.assertEqual(caught.exception.code, "name_too_long")

    def test_http_length_failure(self):
        app = FastAPI()
        app.state.content = self.content
        register_resource_routes(app)
        with TestClient(app) as client:
            response = client.post(
                "/api/resource/node",
                json={
                    "project": self.project.id,
                    "parent": self.parent,
                    "name": "中" * 300,
                    "action": "create_folder",
                },
            )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("name_too_long", response.text)

    def test_error_classification_at_each_stage(self):
        windows_error = OSError(errno.EINVAL, "filename exceeds range")
        windows_error.winerror = 206
        for stage in ("unique_path", "mkdir"):
            for error, code in (
                (OSError(errno.ENAMETOOLONG, "too long"), "name_too_long"),
                (windows_error, "name_too_long"),
                (PermissionError(errno.EACCES, "denied"), "parent_not_writable"),
                (OSError(errno.ENOSPC, "full"), "write_failed"),
            ):
                target = (
                    "service.content.service.assets.unique_path"
                    if stage == "unique_path"
                    else "pathlib.Path.mkdir"
                )
                with self.subTest(stage=stage, code=code), patch(target, side_effect=error):
                    with self.assertRaises(ContentError) as caught:
                        self.create("new")
                    self.assertEqual(caught.exception.code, code)

    def test_windows_path_not_found_is_name_too_long_only_for_long_targets(self):
        windows_error = OSError(errno.ENOENT, "path not found")
        windows_error.winerror = 3
        long_name = "a" * 260
        with patch("pathlib.Path.exists", side_effect=windows_error):
            with self.assertRaises(ContentError) as caught:
                self.create(long_name)
        self.assertEqual(caught.exception.code, "name_too_long")
        with patch("pathlib.Path.exists", return_value=False), patch(
            "pathlib.Path.mkdir", side_effect=windows_error
        ):
            with self.assertRaises(ContentError) as caught:
                self.create(long_name)
        self.assertEqual(caught.exception.code, "name_too_long")
        self.assertEqual(
            filesystem_error(windows_error, "write_failed", Path("C:/short/target")).code,
            "write_failed",
        )

    def test_markdown_names_and_content(self):
        for create in (
            lambda name: self.content.create(self.project.id, self.parent, name, AssetKind.FILE),
            lambda name: self.content.create_text(self.project.id, self.parent, name, "正文"),
        ):
            for name in ("a" * 300, "中" * 300, "a" * 300 + ".md"):
                with self.subTest(name=name), self.assertRaises(ContentError) as caught:
                    create(name)
                self.assertEqual(caught.exception.code, "name_too_long")
        for name in ("note", "笔记"):
            node = self.content.create(self.project.id, self.parent, name, AssetKind.FILE)
            self.assertEqual(node.name, name + ".md")
            self.assertEqual(self.content.read_text(self.project.id, node.path), "# " + name + "\n")
            node = self.content.create_text(self.project.id, self.parent, name, "正文")
            self.assertEqual(node.name, name + " (2).md")
            self.assertEqual(self.content.read_text(self.project.id, node.path), "正文")

    @unittest.skipUnless(sys.platform == "darwin", "macOS native filename boundary")
    def test_markdown_suffix_boundaries(self):
        for name in ("a" * 253, "中" * 253):
            with self.assertRaises(ContentError) as caught:
                self.content.create(self.project.id, self.parent, name, AssetKind.FILE)
            self.assertEqual(caught.exception.code, "name_too_long")
        name = "a" * 252
        self.content.create(self.project.id, self.parent, name, AssetKind.FILE)
        with self.assertRaises(ContentError) as caught:
            self.content.create(self.project.id, self.parent, name, AssetKind.FILE)
        self.assertEqual(caught.exception.code, "name_too_long")
        resources = Path(self.project.root) / self.parent
        self.assertEqual([p.name for p in resources.iterdir()], [name + ".md"])

    def test_markdown_http_length_failure(self):
        app = FastAPI()
        app.state.content = self.content
        register_resource_routes(app)
        with TestClient(app) as client:
            for extra in ({}, {"content": "正文"}):
                response = client.post(
                    "/api/resource/node",
                    json=dict(
                        project=self.project.id,
                        parent=self.parent,
                        name="中" * 300,
                        action="create_document",
                        **extra,
                    ),
                )
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(response.json()["detail"], "name_too_long")

    def test_markdown_publication_length_failure_cleans_stage(self):
        windows_error = OSError(errno.EINVAL, "filename exceeds range")
        windows_error.winerror = 206
        for error in (OSError(errno.ENAMETOOLONG, "too long"), windows_error):
            with patch("service.content.service.port.publish_descriptor", side_effect=error):
                with self.assertRaises(ContentError) as caught:
                    self.content.create_text(self.project.id, self.parent, "note", "正文")
                self.assertEqual(caught.exception.code, "name_too_long")
            self.assertEqual(list((Path(self.project.root) / self.parent).iterdir()), [])

    def test_markdown_path_not_found_is_name_too_long(self):
        windows_error = OSError(errno.ENOENT, "path not found")
        windows_error.winerror = 3
        with patch("pathlib.Path.exists", return_value=False), patch(
            "service.content.service.port.publish_descriptor", side_effect=windows_error
        ):
            with self.assertRaises(ContentError) as caught:
                self.content.create_text(self.project.id, self.parent, "a" * 260, "正文")
        self.assertEqual(caught.exception.code, "name_too_long")
        self.assertEqual(list((Path(self.project.root) / self.parent).iterdir()), [])

    def test_rename_to_long_name_is_actionable(self):
        long_name = "新建文件夹" * 100
        folder = self.content.create(self.project.id, self.parent, "文件夹", AssetKind.DIR)
        with self.assertRaises(ContentError) as caught:
            self.content.rename(self.project.id, folder.path, long_name)
        self.assertEqual(caught.exception.code, "name_too_long")

        document = self.content.create(self.project.id, self.parent, "文档", AssetKind.FILE)
        with self.assertRaises(ContentError) as caught:
            self.content.rename(self.project.id, document.path, long_name + MARKDOWN_SUFFIX)
        self.assertEqual(caught.exception.code, "name_too_long")

    def test_destination_to_long_name_is_actionable(self):
        with self.assertRaises(ContentError) as caught:
            self.content.destination(self.project.id, self.parent, "新建文件夹" * 100)
        self.assertEqual(caught.exception.code, "name_too_long")

    def test_http_rename_length_failure(self):
        folder = self.content.create(self.project.id, self.parent, "文件夹", AssetKind.DIR)
        app = FastAPI()
        app.state.content = self.content
        register_resource_routes(app)
        with TestClient(app) as client:
            response = client.post(
                "/api/resource/node",
                json={
                    "project": self.project.id,
                    "path": folder.path,
                    "name": "新建文件夹" * 100,
                    "action": "rename",
                },
            )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["detail"], "name_too_long")


if __name__ == "__main__":
    unittest.main()
