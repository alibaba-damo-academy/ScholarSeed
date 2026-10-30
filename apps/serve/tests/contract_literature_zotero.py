"""Deterministic contracts for selective Zotero tree imports."""

from __future__ import annotations

import tempfile
import threading
import unittest
from email.message import Message
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.literature.api import catalogue
from service.literature.persistence import files as literature_files
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import AttachmentRole
from service.literature.service import zotero

COLLECTIONS = (
    {"key": "ROOT", "data": {"key": "ROOT", "name": "Same name"}},
    {
        "key": "CHILD",
        "data": {
            "key": "CHILD",
            "name": "Same name",
            "parentCollection": "ROOT",
        },
    },
    {"key": "OTHER", "data": {"key": "OTHER", "name": "Other"}},
)
ITEMS = (
    {
        "key": "DIRECT",
        "data": {
            "key": "DIRECT",
            "itemType": "journalArticle",
            "title": "Direct item",
            "collections": ["ROOT"],
        },
    },
    {
        "key": "CHILD_ONLY",
        "data": {
            "key": "CHILD_ONLY",
            "itemType": "journalArticle",
            "title": "Child item",
            "collections": ["CHILD"],
        },
    },
    {
        "key": "MULTI",
        "data": {
            "key": "MULTI",
            "itemType": "journalArticle",
            "title": "Multi collection item",
            "collections": ["CHILD", "OTHER"],
        },
    },
    {
        "key": "UNFILED",
        "data": {
            "key": "UNFILED",
            "itemType": "journalArticle",
            "title": "Unfiled item",
            "collections": [],
        },
    },
    {
        "key": "STALE_COLLECTION",
        "data": {
            "key": "STALE_COLLECTION",
            "itemType": "journalArticle",
            "title": "Stale collection item",
            "collections": ["DELETED"],
        },
    },
)
PDF_ATTACHMENT = {
    "key": "PDF",
    "data": {
        "key": "PDF",
        "itemType": "attachment",
        "contentType": zotero.PDF_CONTENT_TYPE,
        "parentItem": "DIRECT",
        "filename": "Paper name.pdf",
    },
}


class ZoteroTreeImportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="literature-zotero-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repository = LiteratureRepository(self.root / "literature.sqlite3")

    def import_library(self, **options: object) -> zotero.ZoteroImportResult:
        with (
            patch.object(zotero, "_all", side_effect=(ITEMS, COLLECTIONS)),
            patch.object(zotero, "SERVICE_LITERATURE_FILES_DIR", self.root / "files"),
            patch.object(zotero, "LiteratureRepository", return_value=self.repository),
        ):
            return zotero.import_zotero(**options)

    def test_preview_counts_unique_subtree_items_and_unfiled(self) -> None:
        with patch.object(zotero, "_all", side_effect=(ITEMS, COLLECTIONS)):
            preview = zotero.preview_zotero()

        roots = {node["key"]: node for node in preview.library["children"]}
        child = roots["ROOT"]["children"][0]
        self.assertEqual(preview.items, 5)
        self.assertEqual(preview.unfiled, {"count": 2})
        self.assertEqual(roots["ROOT"]["subtree_item_count"], 3)
        self.assertEqual(child["subtree_item_count"], 2)
        self.assertEqual(roots["OTHER"]["subtree_item_count"], 1)
        self.assertEqual((roots["ROOT"]["name"], child["name"]), ("Same name", "Same name"))

    def test_attachment_file_redirect_reads_the_local_pdf(self) -> None:
        attachment = self.root / "Paper name.pdf"
        attachment.write_bytes(b"%PDF-local")
        headers = Message()
        headers["Location"] = attachment.as_uri()
        redirect = HTTPError(
            "http://127.0.0.1:23119/api/users/0/items/ATTACHMENT/file",
            302,
            "undefined",
            headers,
            None,
        )

        with patch.object(zotero, "urlopen", side_effect=redirect):
            payload, response_headers = zotero._read(
                Request("http://127.0.0.1:23119/api/users/0/items/ATTACHMENT/file"),
                zotero.ZOTERO_MAX_PDF_BYTES,
            )

        self.assertEqual(payload, b"%PDF-local")
        self.assertEqual(response_headers["Location"], attachment.as_uri())

    def test_attachment_redirect_rejects_non_file_targets(self) -> None:
        headers = Message()
        headers["Location"] = "https://example.com/paper.pdf"
        redirect = HTTPError(
            "http://127.0.0.1:23119/api/users/0/items/ATTACHMENT/file",
            302,
            "undefined",
            headers,
            None,
        )

        with (
            patch.object(zotero, "urlopen", side_effect=redirect),
            self.assertRaisesRegex(zotero.ZoteroImportError, "ZOTERO_API_ERROR"),
        ):
            zotero._read(
                Request("http://127.0.0.1:23119/api/users/0/items/ATTACHMENT/file"),
                zotero.ZOTERO_MAX_PDF_BYTES,
            )

    def test_parent_selection_allows_child_exception_and_deduplicates_memberships(self) -> None:
        result = self.import_library(
            selection=(("ROOT", True), ("CHILD", False), ("OTHER", True)),
            include_unfiled=False,
            import_collections=False,
        )

        self.assertEqual(
            {item.title for item in result.items}, {"Direct item", "Multi collection item"}
        )
        self.assertEqual(len(result.items), 2)
        self.assertEqual(result.collections, 0)
        self.assertEqual(self.repository.collections(), [])
        self.assertTrue(all(not item.collections for item in self.repository.list()))

    def test_virtual_library_root_selects_every_real_collection(self) -> None:
        result = self.import_library(
            selection=((zotero.LIBRARY_KEY, True),),
            include_unfiled=False,
            import_collections=False,
        )

        self.assertEqual(
            {item.title for item in result.items},
            {"Direct item", "Child item", "Multi collection item"},
        )
        self.assertEqual(len(result.items), 3)

    def test_unfiled_includes_items_whose_collection_no_longer_exists(self) -> None:
        result = self.import_library(
            selection=((zotero.LIBRARY_KEY, True),),
            include_unfiled=True,
            import_collections=False,
        )

        self.assertEqual(len(result.items), 5)
        self.assertIn("Stale collection item", {item.title for item in result.items})

    def test_each_zotero_import_owns_an_independent_pdf_copy(self) -> None:
        """Repeated imports append items; deleting one cannot remove another's bytes."""
        rows = ITEMS + (PDF_ATTACHMENT,)
        files = self.root / "files"

        def imported(payload: bytes) -> zotero.ZoteroImportResult:
            with (
                patch.object(
                    zotero,
                    "_all",
                    side_effect=lambda name: rows if name == "items" else COLLECTIONS,
                ),
                patch.object(zotero, "_download_pdf", return_value=payload),
                patch.object(zotero, "SERVICE_LITERATURE_FILES_DIR", files),
                patch.object(zotero, "LiteratureRepository", return_value=self.repository),
            ):
                return zotero.import_zotero()

        payload = b"%PDF-1.4 zotero payload"
        revised = b"%PDF-1.4 zotero payload v2"
        copies = []
        identities = set()
        for expected in (payload, payload, revised):
            result = imported(expected)
            self.assertEqual(result.pdfs, 1)
            direct = next(item for item in result.items if item.title == "Direct item")
            self.assertNotIn(direct.id, identities)
            identities.add(direct.id)
            attachments = self.repository.attachments(direct.id)
            self.assertEqual(len(attachments), 1)
            attachment = attachments[0]
            path = Path(attachment["path"])
            self.assertEqual(path.parent, files)
            self.assertTrue(path.name.startswith(f"{direct.id}-"))
            self.assertEqual(path.suffix, ".pdf")
            self.assertEqual(path.read_bytes(), expected)
            self.assertEqual(attachment["revision"], f"sha256:{sha256(expected).hexdigest()}")
            self.assertEqual(attachment["role"], AttachmentRole.PRIMARY.value)
            self.assertEqual(attachment["name"], "Paper name.pdf")
            copies.append((direct.id, attachment, path, expected))
        self.assertEqual(len({path for _, _, path, _ in copies}), 3)
        self.assertEqual(set(files.iterdir()), {path for _, _, path, _ in copies})
        app = FastAPI()
        catalogue.register_global_routes(app)
        item_id, attachment, removed, _ = copies[0]
        with (
            patch.object(catalogue, "LiteratureRepository", return_value=self.repository),
            patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", files),
            TestClient(app) as client,
        ):
            response = client.delete(
                f"/api/v1/literatures/{item_id}/attachments/{attachment['id']}"
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(removed.exists())
        self.assertEqual(self.repository.attachments(item_id), [])
        for remaining_id, remaining, path, expected in copies[1:]:
            self.assertEqual(path.read_bytes(), expected)
            self.assertEqual(self.repository.attachments(remaining_id), [remaining])
        self.assertEqual(set(files.iterdir()), {copy[2] for copy in copies[1:]})

    def test_failed_pdf_copy_does_not_discard_the_bibliographic_item(self) -> None:
        attachment = {
            "key": "PDF",
            "data": {
                "key": "PDF",
                "itemType": "attachment",
                "contentType": zotero.PDF_CONTENT_TYPE,
                "parentItem": "DIRECT",
            },
        }
        with (
            patch.object(zotero, "_all", side_effect=(ITEMS + (attachment,), COLLECTIONS)),
            patch.object(
                zotero, "_download_pdf", side_effect=zotero.ZoteroImportError("ZOTERO_INVALID_PDF")
            ),
            patch.object(zotero, "SERVICE_LITERATURE_FILES_DIR", self.root / "files"),
            patch.object(zotero, "LiteratureRepository", return_value=self.repository),
        ):
            result = zotero.import_zotero()

        direct = next(item for item in result.items if item.title == "Direct item")
        self.assertEqual(result.pdfs, 0)
        self.assertEqual(direct.fulltext, zotero.FulltextStatus.NONE)

    def test_preserve_builds_ancestor_path_without_merging_equal_names(self) -> None:
        result = self.import_library(
            selection=(("CHILD", True),),
            include_unfiled=False,
            import_collections=True,
        )

        self.assertEqual(
            {item.title for item in result.items}, {"Child item", "Multi collection item"}
        )
        self.assertEqual(len(result.items), 2)
        self.assertEqual(result.collections, 2)
        collections = {entry["id"]: entry for entry in self.repository.collections()}
        self.assertEqual(set(collections), {"zotero:ROOT", "zotero:CHILD"})
        self.assertEqual(collections["zotero:ROOT"]["name"], "Same name")
        self.assertEqual(collections["zotero:CHILD"]["name"], "Same name")
        self.assertEqual(collections["zotero:CHILD"]["parent_id"], "zotero:ROOT")
        self.assertEqual(collections["zotero:ROOT"]["count"], 0)
        self.assertEqual(collections["zotero:CHILD"]["count"], 2)


class ZoteroTaskProjectionTests(unittest.TestCase):
    def test_import_failures_preserve_original_error_and_add_explicit_code(self):
        original_thread = threading.Thread
        for failure, expected_code, expected_error in (
            (
                zotero.ZoteroImportError("ZOTERO_UNAVAILABLE"),
                "ZOTERO_UNAVAILABLE",
                catalogue.ZOTERO_ERROR_MESSAGES["ZOTERO_UNAVAILABLE"],
            ),
            (zotero.ZoteroImportError("VENDOR_NEW_CODE"), "VENDOR_NEW_CODE", "Zotero 导入失败"),
            (
                RuntimeError("original internal failure"),
                catalogue.ZOTERO_IMPORT_FAILED,
                "Zotero 导入失败",
            ),
        ):
            with self.subTest(code=expected_code):
                app = FastAPI()
                catalogue.register_global_routes(app)
                threads = []

                def create_thread(*args, _threads=threads, **kwargs):
                    thread = original_thread(*args, **kwargs)
                    _threads.append(thread)
                    return thread

                with (
                    TestClient(app) as client,
                    patch.object(catalogue, "import_zotero", side_effect=failure),
                    patch.object(catalogue.threading, "Thread", side_effect=create_thread),
                ):
                    response = client.post("/api/v1/imports", json={"source": "zotero"})
                    self.assertEqual(response.status_code, 202)
                    for thread in threads:
                        thread.join(timeout=5)
                        self.assertFalse(thread.is_alive())
                    task = client.get(f"/api/v1/tasks/{response.json()['id']}").json()
                    self.assertEqual(task["status"], "failed")
                    self.assertEqual(task["error"], expected_error)
                    self.assertEqual(task["error_code"], expected_code)
                    self.assertEqual(task["completed_count"], 0)
                    self.assertEqual(task["progress"], 0.0)


if __name__ == "__main__":
    unittest.main()
