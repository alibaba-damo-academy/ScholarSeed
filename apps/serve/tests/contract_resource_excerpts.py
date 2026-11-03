"""Contract tests for literature selections aggregated into resource Markdown."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.serve.tests import pdf as pdf_fixture
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.literature.persistence import files as literature_files
from service.literature.persistence.store import LiteratureRepository, edit_library
from service.literature.schema import (
    PDF_MEDIA_TYPE,
    AttachmentRole,
    FulltextStatus,
    LiteratureItem,
    LiteratureView,
)
from service.literature.service.reference import LiteratureReferenceService
from service.paths import PROJECT_DB_RELATIVE
from service.platform.activity import Activities
from service.platform.content import AssetKind, RootKind
from service.platform.excerpts import ExcerptSourceKind
from service.resources.api.routes import register_resource_routes
from service.resources.persistence.catalog import (
    EXCERPT_DOCUMENTS_TABLE,
    ResourceExcerptCatalog,
)
from service.resources.service.excerpts import ResourceExcerptService
from service.resources.service.writer import ResourceWriter

LITERATURE_ID = "0123456789abcdef"
LITERATURE_TITLE = "Attention Is All You Need"
SECOND_TEXT = "The model applies multi-head attention in parallel."


class ResourceExcerptContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="resource-excerpts-")
        root = Path(self.temporary.name)
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(root), catalog)
        self.content = ContentService(registry, catalog, activities=Activities())
        self.project = self.content.create_project("Excerpt API")
        with pdf_fixture.open() as document:
            document.new_page().insert_text((50, 50), "Contract source")
            pdf_payload = document.tobytes()
        self.revision = self.content.revision(pdf_payload)
        # 附件是文献独占的托管副本, 托管目录必须落在本次测试的临时根里。
        self.attachment_root = root / "literature-files"
        self.attachment_root.mkdir()
        self.attachment_root = self.attachment_root.resolve()
        store_patch = patch.object(
            literature_files,
            "SERVICE_LITERATURE_FILES_DIR",
            self.attachment_root,
        )
        store_patch.start()
        self.addCleanup(store_patch.stop)
        self.literature_database = root / "literature.sqlite3"
        self.literature_repository = LiteratureRepository(self.literature_database)
        with edit_library(self.project.id, self.literature_database) as edit:
            edit.view = LiteratureView(
                items=(
                    LiteratureItem(
                        id=LITERATURE_ID,
                        title=LITERATURE_TITLE,
                        authors="Ashish Vaswani et al.",
                        journal="NeurIPS",
                        year=2017,
                        fulltext=FulltextStatus.READY,
                    ),
                )
            )
        # 摘录校验的修订号来自文献自己那份副本的字节, 与项目里有没有同名文件无关。
        published = literature_files.managed_object(LITERATURE_ID, pdf_payload, ".pdf")
        (self.attachment_root / published.name).write_bytes(pdf_payload)
        self.literature_repository.add_attachment(
            LITERATURE_ID,
            "paper.pdf",
            str(self.attachment_root / published.name),
            "pdf",
            role=AttachmentRole.PRIMARY,
            media_type=PDF_MEDIA_TYPE,
            revision=published.revision,
        )
        self.app = FastAPI()
        self.app.state.content = self.content
        self._bind_service()
        register_resource_routes(self.app)
        self.client = TestClient(self.app)

    def tearDown(self) -> None:
        self.client.close()
        self.temporary.cleanup()

    def _bind_service(self) -> None:
        self.app.state.resource_excerpts = ResourceExcerptService(
            self.content,
            ResourceWriter(self.content),
            ResourceExcerptCatalog(self.content),
            {
                ExcerptSourceKind.LITERATURE: LiteratureReferenceService(
                    self.content, self.literature_repository
                )
            },
        )

    def _payload(self, selections: list[dict]) -> dict:
        return {
            "project": self.project.id,
            "location": {"parent": "文献摘录", "name": LITERATURE_TITLE},
            "source": {
                "kind": "literature",
                "literature_id": LITERATURE_ID,
                "document_revision": self.revision,
            },
            "selections": selections,
        }

    @staticmethod
    def _selection(text: str, page: int, *, with_quads: bool = False) -> dict:
        locator: dict = {"kind": "pdf", "page": page}
        if with_quads:
            locator["quads"] = [[0.12, 0.23, 0.78, 0.27]]
        return {"text": text, "locator": locator}

    def test_multiple_selections_create_one_resource_and_repeat_dedupes(self) -> None:
        selections = [
            self._selection("Scaled dot-product attention.", 3, with_quads=True),
            self._selection(SECOND_TEXT, 7),
        ]
        created = self.client.post(
            "/api/resource/excerpts",
            json=self._payload(selections),
        )

        self.assertEqual(created.status_code, 200, created.text)
        result = created.json()
        self.assertEqual(result["operation"], "created")
        self.assertEqual((result["added"], result["skipped"], result["total"]), (2, 0, 2))
        target = Path(self.project.root) / result["node"]["path"]
        body = target.read_text(encoding="utf-8")
        self.assertIn(LITERATURE_ID, body)
        self.assertIn("## 第 3 页", body)
        self.assertIn("## 第 7 页", body)
        self.assertIn("Scaled dot-product attention.", body)
        self.assertIn('"quads":[[0.12,0.23,0.78,0.27]]', body)

        repeated = self.client.post(
            "/api/resource/excerpts",
            json=self._payload(selections),
        )
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertEqual(repeated.json()["node"]["path"], result["node"]["path"])
        self.assertEqual(
            (
                repeated.json()["added"],
                repeated.json()["skipped"],
                repeated.json()["total"],
            ),
            (0, 2, 2),
        )
        self.assertEqual(target.read_text(encoding="utf-8"), body)

        database = Path(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE))
        with closing(sqlite3.connect(database)) as connection:
            count = connection.execute(
                f"SELECT COUNT(*) FROM {EXCERPT_DOCUMENTS_TABLE}"
            ).fetchone()[0]
        self.assertEqual(count, 1)

    def test_subsequent_request_appends_after_restart_and_move(self) -> None:
        created = self.client.post(
            "/api/resource/excerpts",
            json=self._payload([self._selection("First excerpt.", 2)]),
        ).json()
        original_path = created["node"]["path"]

        resources_root = self.content.root(self.project.id, RootKind.RESOURCES).path
        archive = self.content.create(
            self.project.id,
            resources_root,
            "归档",
            AssetKind.DIR,
        )
        moved = self.content.move(self.project.id, original_path, archive.path)
        self._bind_service()

        appended = self.client.post(
            "/api/resource/excerpts",
            json=self._payload([self._selection(SECOND_TEXT, 9)]),
        )

        self.assertEqual(appended.status_code, 200, appended.text)
        result = appended.json()
        self.assertEqual(result["operation"], "updated")
        self.assertEqual(result["node"]["path"], moved.path)
        self.assertEqual((result["added"], result["total"]), (1, 2))
        body = (Path(self.project.root) / moved.path).read_text(encoding="utf-8")
        self.assertIn("First excerpt.", body)
        self.assertIn(SECOND_TEXT, body)
        self.assertFalse((Path(self.project.root) / original_path).exists())

    def test_source_and_locator_failures_are_explicit(self) -> None:
        conflict_payload = self._payload([self._selection("Conflict.", 1)])
        conflict_payload["source"]["document_revision"] = "sha256:stale"
        conflict = self.client.post("/api/resource/excerpts", json=conflict_payload)
        self.assertEqual(conflict.status_code, 409, conflict.text)
        self.assertEqual(conflict.json()["detail"], "literature_revision_conflict")

        missing_payload = self._payload([self._selection("Missing.", 1)])
        missing_payload["source"]["literature_id"] = "missing"
        missing = self.client.post("/api/resource/excerpts", json=missing_payload)
        self.assertEqual(missing.status_code, 404, missing.text)
        self.assertEqual(missing.json()["detail"], "literature_not_found")

        invalid_page = self.client.post(
            "/api/resource/excerpts",
            json=self._payload([self._selection("Bad page.", 0)]),
        )
        self.assertEqual(invalid_page.status_code, 400, invalid_page.text)
        self.assertEqual(invalid_page.json()["detail"], "invalid_page")

        invalid_quad = self._payload([self._selection("Bad quad.", 1)])
        invalid_quad["selections"][0]["locator"]["quads"] = [[0.8, 0.2, 0.1, 0.3]]
        rejected = self.client.post("/api/resource/excerpts", json=invalid_quad)
        self.assertEqual(rejected.status_code, 400, rejected.text)
        self.assertEqual(rejected.json()["detail"], "invalid_locator")

        no_selections = self._payload([])
        empty = self.client.post("/api/resource/excerpts", json=no_selections)
        self.assertEqual(empty.status_code, 400, empty.text)
        self.assertEqual(empty.json()["detail"], "selections_required")


if __name__ == "__main__":
    unittest.main()
