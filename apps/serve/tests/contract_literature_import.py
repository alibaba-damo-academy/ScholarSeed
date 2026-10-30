"""Admission contracts: invalid inputs cannot leave formal library copies."""

from __future__ import annotations

import base64
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.serve.tests import pdf as pdf_fixture
from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.content.service.utils import read_regular
from service.literature.api.catalogue import register_global_routes
from service.literature.api.reading import register_reading_routes
from service.literature.domain.model import (
    LIBRARY_INVALID,
    LIBRARY_UNAVAILABLE,
    MAX_BATCH_RECORDS,
    LiteratureError,
)
from service.literature.persistence.files import LiteratureFileBatch, managed_object
from service.literature.persistence.imports import IMPORT_TABLE, ImportState, LiteratureImports
from service.literature.persistence.store import (
    LiteratureRepository,
    connect,
    edit_library,
    load_library,
)
from service.literature.schema import (
    AttachmentRole,
    FulltextStatus,
    ImportSource,
    LiteratureItem,
    LiteratureView,
)
from service.literature.service import zotero
from service.literature.service.arxiv import ArxivDownloadError, normalize_arxiv_id
from service.literature.service.attachment import (
    ARXIV_ALREADY_ATTACHED,
    LiteratureAttachmentContent,
)
from service.literature.service.extractor import extract_pdf_metadata
from service.literature.service.fulltext import FulltextDownload
from service.literature.service.importer import (
    LiteratureImportError,
    import_from_bytes,
    import_from_paths,
    parse_import,
    plan_artifact_import,
)
from service.literature.service.pdf import LiteraturePdf
from service.platform.activity import Activities
from service.platform.content import RootKind
from service.workbench.domain.model import WorkbenchFormatPolicy

BIB = (
    b"@article{a,title={Admitted research},author={Ada Researcher},"
    b"year={2026},keywords={generated, imported}}"
)
RIS = (
    b"TY  - JOUR\nTI  - Admitted research\nAU  - Ada Researcher\nPY  - 2026\n"
    b"KW  - generated\nKW  - imported\nER  -\n"
)
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
# 每个把托管目录常量按值 import 进去的模块都要单独指过来, 少一个就会把副本写进
# 真实的 SCHOLARSEED_HOME。
LITERATURE_FILE_OWNERS = (
    "service.literature.persistence.files",
    "service.literature.persistence.imports",
    "service.literature.service.attachment",
)


class LiteratureImportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="literature-import-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.database = self.root / "literature.sqlite3"
        repository_init = LiteratureRepository.__init__

        def isolated_repository_init(
            repository: LiteratureRepository,
            database: Path | str = self.database,
        ) -> None:
            repository_init(repository, database)

        repository_patch = patch.object(
            LiteratureRepository,
            "__init__",
            isolated_repository_init,
        )
        repository_patch.start()
        self.addCleanup(repository_patch.stop)
        catalog = ContentCatalog(self.root / "content.sqlite3")
        registry = ProjectRegistry(str(self.root), catalog)
        self.content = ContentService(registry, catalog, activities=Activities())
        self.project = self.content.create_project("文献准入")
        self.library = Path(
            self.content.resolve(
                self.project.id,
                self.content.root(self.project.id, RootKind.LITERATURE).path,
            )
        )
        self.files = self.root / "literature-files"
        for owner in LITERATURE_FILE_OWNERS:
            owner_patch = patch(f"{owner}.SERVICE_LITERATURE_FILES_DIR", self.files)
            owner_patch.start()
            self.addCleanup(owner_patch.stop)

    def source(self, name: str, data: bytes) -> Path:
        path = self.root / name
        path.write_bytes(data)
        return path

    def test_bibliography_formats_preserve_metadata_with_independent_identity(self) -> None:
        bib = parse_import("source.BIB", BIB).items[0]
        ris = parse_import("source.RIS", RIS).items[0]
        self.assertEqual((bib.title, bib.authors, bib.year), (ris.title, ris.authors, ris.year))
        self.assertNotEqual(bib.id, ris.id)
        self.assertEqual(bib.fulltext, FulltextStatus.NONE)
        self.assertEqual(ris.fulltext, FulltextStatus.NONE)
        for item in (bib, ris):
            self.assertEqual(item.tags, ())
            self.assertEqual(item.collection, "")
            self.assertEqual(item.collections, ())

    def test_global_pdf_upload_extracts_only_title_and_author(self) -> None:
        document = pdf_fixture.open()
        document.new_page()
        document.set_metadata({"title": "Imported research", "author": "Ada Researcher"})
        payload = document.tobytes()
        document.close()
        app = FastAPI()
        register_global_routes(app)

        response = TestClient(app).post(
            "/api/v1/imports/pdf",
            files={"file": ("paper.pdf", payload, "application/pdf")},
        )

        self.assertEqual(response.status_code, 201, response.text)
        imported = LiteratureRepository().get(response.json()["id"])
        self.assertIsNotNone(imported)
        assert imported is not None
        self.assertEqual(
            (imported.title, imported.authors), ("Imported research", "Ada Researcher")
        )
        self.assertEqual((imported.journal, imported.year, imported.doi), ("", None, ""))

    def test_project_pdf_upload_links_current_project(self) -> None:
        document = pdf_fixture.open()
        document.new_page()
        document.set_metadata({"title": "Project PDF", "author": "Ada Researcher"})
        payload = document.tobytes()
        document.close()
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)

        files = self.root / "project-pdf-files"
        with patch("service.literature.api.catalogue.SERVICE_LITERATURE_FILES_DIR", files):
            response = TestClient(app).post(
                "/api/v1/imports/pdf",
                params={"project_id": self.project.id},
                files={"file": ("paper.pdf", payload, "application/pdf")},
            )

        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(
            [item.id for item in LiteratureRepository().list(project_id=self.project.id)],
            [response.json()["id"]],
        )

    def test_attachment_upload_persists_real_pdf_and_png_types_and_serves_exact_content(
        self,
    ) -> None:
        repository = LiteratureRepository()
        item = repository.save(LiteratureItem(id="attachment-paper", title="Attachment paper"))
        with pdf_fixture.open() as document:
            document.new_page()
            pdf_payload = document.tobytes()
        files = self.root / "managed-attachments"
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        register_reading_routes(
            app,
            repository,
            LiteratureAttachmentContent(repository),
            LiteraturePdf(repository),
            WorkbenchFormatPolicy(),
        )
        with (
            patch("service.literature.api.catalogue.SERVICE_LITERATURE_FILES_DIR", files),
            patch("service.literature.persistence.files.SERVICE_LITERATURE_FILES_DIR", files),
        ):
            client = TestClient(app)
            pdf = client.post(
                f"/api/v1/literatures/{item.id}/attachments",
                files={"file": ("paper.pdf", pdf_payload, "application/pdf")},
            )
            png = client.post(
                f"/api/v1/literatures/{item.id}/attachments",
                files={"file": ("figure.png", PNG, "image/png")},
            )

            self.assertEqual(pdf.status_code, 201, pdf.text)
            self.assertEqual(png.status_code, 201, png.text)
            self.assertEqual(pdf.json()["media_type"], "application/pdf")
            self.assertEqual(png.json()["media_type"], "image/png")
            self.assertEqual(png.json()["kind"], "image")
            content_route = f"/api/v1/literatures/{item.id}/attachments/{png.json()['id']}/content"
            opened = client.get(content_route)
            self.assertEqual(opened.status_code, 200, opened.text)
            self.assertEqual(opened.headers["content-type"], "image/png")
            self.assertEqual(opened.content, PNG)
            head = client.head(content_route)
            self.assertEqual(head.status_code, 200, head.text)
            self.assertEqual(int(head.headers["content-length"]), len(PNG))
            partial = client.get(content_route, headers={"Range": "bytes=0-7"})
            self.assertEqual(partial.status_code, 206, partial.text)
            self.assertEqual(partial.content, PNG[:8])
            self.assertEqual(partial.headers["content-range"], f"bytes 0-7/{len(PNG)}")
            location = client.get(
                f"/api/v1/literatures/{item.id}/attachments/{png.json()['id']}/location"
            )
            self.assertEqual(location.status_code, 200, location.text)
            stored_png = repository.attachment(item.id, png.json()["id"])
            assert stored_png is not None
            self.assertEqual(location.json(), {"absolute": str(Path(stored_png.path).resolve())})
            self.assertEqual(
                client.get(
                    f"/api/v1/literatures/other/attachments/{png.json()['id']}/content"
                ).status_code,
                404,
            )
            self.assertEqual(
                client.get(
                    f"/api/v1/literatures/other/attachments/{png.json()['id']}/location"
                ).status_code,
                404,
            )
            self.assertEqual(
                client.get(
                    f"/api/v1/literatures/{item.id}/attachments/{png.json()['id']}/records"
                ).status_code,
                415,
            )

    def test_primary_upload_never_replaces_a_usable_primary_attachment(self) -> None:
        """产品上传腿的主附件不变式: 已有可用全文时 409, 不静默降级旧文件。

        ``literature/fulltext-attach`` (bridge) 与这条 ``?primary=true`` 腿共用附件域
        owner ``attach_primary_pdf`` 的同一判据, 所以同一条不变式的另一半契约打在
        ``tests/contract_literature_curation.py``; 这里钉的是 HTTP 入口的结果。
        """

        repository = LiteratureRepository()
        item = repository.save(LiteratureItem(id="primary-paper", title="Primary paper"))
        with pdf_fixture.open() as document:
            document.new_page()
            first = document.tobytes()
        with pdf_fixture.open() as document:
            document.new_page()
            document.set_metadata({"title": "Replacement"})
            second = document.tobytes()
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        client = TestClient(app)
        route = f"/api/v1/literatures/{item.id}/attachments"

        created = client.post(
            route,
            params={"primary": "true"},
            files={"file": ("paper.pdf", first, "application/pdf")},
        )
        self.assertEqual(created.status_code, 201, created.text)
        refused = client.post(
            route,
            params={"primary": "true"},
            files={"file": ("replacement.pdf", second, "application/pdf")},
        )

        self.assertEqual(refused.status_code, 409, refused.text)
        self.assertEqual(refused.json()["detail"]["code"], ARXIV_ALREADY_ATTACHED)
        rows = repository.attachments(item.id)
        # 旧主附件既没被换掉, 也没被降级成补充材料; 库里始终只有一行。
        self.assertEqual([row["id"] for row in rows], [created.json()["id"]])
        self.assertEqual(rows[0]["role"], AttachmentRole.PRIMARY.value)
        self.assertEqual(Path(rows[0]["path"]).read_bytes(), first)
        self.assertEqual(repository.get(item.id).fulltext, FulltextStatus.READY)

        # 行在而字节丢 (lost) 是「需要补救」: 允许补挂, 且旧行连文件带派生索引一起清掉。
        Path(rows[0]["path"]).unlink()
        recovered = client.post(
            route,
            params={"primary": "true"},
            files={"file": ("recovered.pdf", second, "application/pdf")},
        )
        self.assertEqual(recovered.status_code, 201, recovered.text)
        self.assertNotEqual(recovered.json()["id"], created.json()["id"])
        self.assertEqual(
            [row["id"] for row in repository.attachments(item.id)], [recovered.json()["id"]]
        )

    def test_attachment_open_uses_the_same_workbench_format_policy_as_resources(self) -> None:
        repository = LiteratureRepository()
        item = repository.save(LiteratureItem(id="format-paper", title="Format paper"))
        files = self.root / "format-attachments"
        formats = WorkbenchFormatPolicy()
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        register_reading_routes(
            app,
            repository,
            LiteratureAttachmentContent(repository),
            LiteraturePdf(repository),
            formats,
        )
        cases = (
            ("notes.md", b"# Notes\n", "text/markdown", "markdown"),
            ("analysis.py", b"print('evidence')\n", "text/x-python", "code"),
            ("data.tsv", b"run\tvalue\n1\t2\n", "text/tab-separated-values", "table"),
            (
                "paper.docx",
                b"office-package",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "office",
            ),
            (
                "results.xlsx",
                b"spreadsheet-package",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "spreadsheet",
            ),
            ("legacy.xls", b"legacy-spreadsheet", "application/vnd.ms-excel", "office"),
            ("figure.jpg", b"jpeg-bytes", "image/jpeg", "image"),
            ("opaque.bin", b"prefix\x00suffix", "application/octet-stream", "unsupported"),
        )
        with (
            patch("service.literature.api.catalogue.SERVICE_LITERATURE_FILES_DIR", files),
            patch("service.literature.persistence.files.SERVICE_LITERATURE_FILES_DIR", files),
        ):
            client = TestClient(app)
            for name, payload, media_type, viewer in cases:
                with self.subTest(name=name):
                    uploaded = client.post(
                        f"/api/v1/literatures/{item.id}/attachments",
                        files={"file": (name, payload, media_type)},
                    )
                    self.assertEqual(uploaded.status_code, 201, uploaded.text)
                    self.assertEqual(uploaded.json()["media_type"], media_type)
                    opened = client.get(
                        f"/api/v1/literatures/{item.id}/attachments/"
                        f"{uploaded.json()['id']}/open"
                    )
                    self.assertEqual(opened.status_code, 200, opened.text)
                    projection = opened.json()
                    expected = formats.project(name, payload)
                    self.assertEqual(projection["viewer"], viewer)
                    self.assertEqual(projection["viewer"], expected.viewer)
                    self.assertEqual(projection["processor"], expected.processor)
                    self.assertEqual(
                        projection["capabilities"],
                        {
                            "can_preview": expected.can_preview,
                            "can_edit": expected.can_edit,
                            "can_select": expected.can_select,
                            "can_annotate": expected.can_annotate,
                            "can_save": expected.can_save,
                            "can_version": False,
                            "can_diff": False,
                            "pending": list(expected.pending),
                        },
                    )
                    self.assertEqual(projection["revision"], opened.headers["etag"].strip('"'))

    def test_markdown_attachment_open_and_save_share_workbench_capabilities(self) -> None:
        repository = LiteratureRepository()
        item = repository.save(LiteratureItem(id="editable-paper", title="Editable paper"))
        files = self.root / "editable-attachments"
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        register_reading_routes(
            app,
            repository,
            LiteratureAttachmentContent(repository),
            LiteraturePdf(repository),
            WorkbenchFormatPolicy(),
        )
        with (
            patch("service.literature.api.catalogue.SERVICE_LITERATURE_FILES_DIR", files),
            patch("service.literature.persistence.files.SERVICE_LITERATURE_FILES_DIR", files),
            patch("service.literature.service.attachment.SERVICE_LITERATURE_FILES_DIR", files),
        ):
            client = TestClient(app)
            uploaded = client.post(
                f"/api/v1/literatures/{item.id}/attachments",
                files={"file": ("notes.md", b"# Before\n", "text/markdown")},
            )
            self.assertEqual(uploaded.status_code, 201, uploaded.text)
            route = f"/api/v1/literatures/{item.id}/attachments/{uploaded.json()['id']}"
            opened = client.get(f"{route}/open")
            self.assertEqual(opened.status_code, 200, opened.text)
            self.assertTrue(opened.json()["capabilities"]["can_edit"])
            self.assertTrue(opened.json()["capabilities"]["can_save"])
            revision = opened.json()["revision"]

            saved = client.put(
                f"{route}/content",
                content=b"# After\n",
                headers={
                    "Content-Type": "application/octet-stream",
                    "If-Match": f'"{revision}"',
                },
            )
            self.assertEqual(saved.status_code, 204, saved.text)
            self.assertEqual(client.get(f"{route}/content").content, b"# After\n")
            stale = client.put(
                f"{route}/content",
                content=b"# Stale\n",
                headers={
                    "Content-Type": "application/octet-stream",
                    "If-Match": f'"{revision}"',
                },
            )
            self.assertEqual(stale.status_code, 412, stale.text)

    def test_attachment_upload_rejects_supported_type_mismatch(self) -> None:
        repository = LiteratureRepository()
        item = repository.save(LiteratureItem(id="mismatch-paper", title="Mismatch paper"))
        files = self.root / "mismatch-attachments"
        app = FastAPI()
        register_global_routes(app)
        with patch("service.literature.api.catalogue.SERVICE_LITERATURE_FILES_DIR", files):
            response = TestClient(app).post(
                f"/api/v1/literatures/{item.id}/attachments",
                files={"file": ("figure.pdf", PNG, "application/pdf")},
            )

        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "literature_attachment_type_mismatch")
        self.assertEqual(repository.attachments(item.id), [])

    def test_arxiv_identifiers_are_normalized_without_accepting_arbitrary_urls(self) -> None:
        expected = "2401.12345v2"
        for value in (
            expected,
            f"arXiv:{expected}",
            f"https://arxiv.org/abs/{expected}",
            f"https://arxiv.org/pdf/{expected}.pdf",
            f"https://export.arxiv.org/pdf/{expected}.pdf",
        ):
            self.assertEqual(normalize_arxiv_id(value), expected)
        with self.assertRaises(ArxivDownloadError):
            normalize_arxiv_id("https://example.com/paper.pdf")

    def test_arxiv_fulltext_download_creates_primary_attachment(self) -> None:
        repository = LiteratureRepository(self.root / "arxiv.sqlite3")
        item = repository.save(
            LiteratureItem(id="arxiv-paper", title="Arxiv paper", arxiv="2401.12345")
        )
        document = pdf_fixture.open()
        document.new_page()
        payload = document.tobytes()
        document.close()
        files = self.root / "attachments"
        app = FastAPI()
        register_global_routes(app)

        with (
            patch(
                "service.literature.api.catalogue.LiteratureRepository",
                return_value=repository,
            ),
            patch(
                "service.literature.api.catalogue.SERVICE_LITERATURE_FILES_DIR",
                files,
            ),
            # 投影的 availability/size 以 files 域的托管根判定, 测试换了批次根就要一起换。
            patch(
                "service.literature.persistence.files.SERVICE_LITERATURE_FILES_DIR",
                files,
            ),
            # 主附件的暂存根归 attachment owner 持有 (attach_primary_pdf), 少指一个就会
            # 把副本写进真实的 SCHOLARSEED_HOME。
            patch(
                "service.literature.service.attachment.SERVICE_LITERATURE_FILES_DIR",
                files,
            ),
            patch(
                "service.literature.api.catalogue.fetch_identifier_pdf",
                return_value=FulltextDownload(content=payload, arxiv=item.arxiv),
            ),
        ):
            response = TestClient(app).post(f"/api/v1/literatures/{item.id}/attachments/arxiv")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNotNone(response.json()["primary_attachment"])
        self.assertEqual(response.json()["primary_attachment"]["size"], len(payload))
        stored = repository.get(item.id)
        assert stored is not None
        # 拿到主 PDF 即全文就位: add_attachment 与 delete_attachment 在同一个事务里
        # 对称收敛 fulltext, 否则「无全文」计数会对挂着主附件的条目撒谎。
        self.assertEqual(stored.fulltext, FulltextStatus.READY)
        primary = repository.primary_attachment(item.id)
        assert primary is not None
        self.assertTrue(Path(primary.path).is_file())
        self.assertEqual(len(repository.attachments(item.id)), 1)

    def test_global_pdf_upload_accepts_missing_author(self) -> None:
        document = pdf_fixture.open()
        document.new_page()
        document.set_metadata({"title": "Title without author"})
        payload = document.tobytes()
        document.close()
        app = FastAPI()
        register_global_routes(app)

        response = TestClient(app).post(
            "/api/v1/imports/pdf",
            files={"file": ("paper.pdf", payload, "application/pdf")},
        )

        self.assertEqual(response.status_code, 201, response.text)
        imported = LiteratureRepository().get(response.json()["id"])
        self.assertEqual(imported.title, "Title without author")
        self.assertEqual(imported.authors, "")

    def test_blank_pdf_upload_uses_filename_without_last_extension(self) -> None:
        with pdf_fixture.open() as document:
            document.new_page()
            payload = document.tobytes()
        app = FastAPI()
        register_global_routes(app)
        response = TestClient(app).post(
            "/api/v1/imports/pdf",
            files={"file": ("我的论文.v2.PDF", payload, "application/pdf")},
        )
        self.assertEqual(response.status_code, 201, response.text)
        imported = LiteratureRepository().get(response.json()["id"])
        self.assertEqual(imported.title, "我的论文.v2")
        self.assertEqual(imported.authors, "")
        self.assertEqual((imported.arxiv, imported.doi), ("", ""))

    def test_pdf_identifiers_are_persisted_by_both_import_paths(self) -> None:
        with pdf_fixture.open() as document:
            page = document.new_page()
            document.set_metadata({"title": "Identifier extraction", "author": "Ada"})
            page.insert_text((30, 500), "arXiv:2609.09925v1", rotate=90)
            page.insert_text((70, 780), "https://doi.org/10.1234/example.2026")
            payload = document.tobytes()
        metadata = extract_pdf_metadata(payload)
        self.assertEqual(metadata.arxiv, "2609.09925v1")
        self.assertEqual(metadata.doi, "10.1234/example.2026")
        parsed = parse_import("paper.pdf", payload).items[0]
        self.assertEqual((parsed.arxiv, parsed.doi), (metadata.arxiv, metadata.doi))
        app = FastAPI()
        register_global_routes(app)
        response = TestClient(app).post(
            "/api/v1/imports/pdf",
            files={"file": ("paper.pdf", payload, "application/pdf")},
        )
        self.assertEqual(response.status_code, 201, response.text)
        imported = LiteratureRepository().get(response.json()["id"])
        self.assertEqual((imported.arxiv, imported.doi), (metadata.arxiv, metadata.doi))

    def test_pdf_body_mentions_and_second_page_identifiers_are_ignored(self) -> None:
        with pdf_fixture.open() as document:
            page = document.new_page()
            for position, text in (
                (100, "First body line with sufficient text for detection."),
                (140, "Another body line with sufficient text for detection."),
                (180, "We refer to arXiv:2609.09925 and doi 10.1234/cited here."),
                (220, "Final body line with sufficient text for detection."),
            ):
                page.insert_text((60, position), text)
            document.new_page().insert_text((60, 100), "arXiv:2609.12345")
            payload = document.tobytes()
        metadata = extract_pdf_metadata(payload)
        self.assertEqual((metadata.arxiv, metadata.doi), ("", ""))

    def test_pdf_conflicting_identifiers_are_not_selected(self) -> None:
        with pdf_fixture.open() as document:
            page = document.new_page()
            page.insert_text((30, 500), "arXiv:2609.09925v1 arXiv:2609.12345v2", rotate=90)
            page.insert_text((60, 780), "10.1234/first 10.1234/second")
            payload = document.tobytes()
        metadata = extract_pdf_metadata(payload)
        self.assertEqual((metadata.arxiv, metadata.doi), ("", ""))

    def test_pdf_identifiers_include_links_and_xmp(self) -> None:
        with pdf_fixture.open() as document:
            page = document.new_page()
            page.insert_link(
                {
                    "kind": pdf_fixture.LINK_URI,
                    "from": pdf_fixture.Rect(20, 20, 180, 35),
                    "uri": "https://arxiv.org/abs/2609.09925v2",
                }
            )
            document.set_xml_metadata(
                '<x:xmpmeta xmlns:x="adobe:ns:meta/">10.1234/xmp-paper</x:xmpmeta>'
            )
            payload = document.tobytes()
        metadata = extract_pdf_metadata(payload)
        self.assertEqual((metadata.arxiv, metadata.doi), ("2609.09925v2", "10.1234/xmp-paper"))

    def test_pdf_legacy_arxiv_and_duplicate_doi_are_normalized(self) -> None:
        with pdf_fixture.open() as document:
            page = document.new_page()
            page.insert_text((30, 500), "arXiv:hep-th/9901001v3", rotate=90)
            page.insert_text((60, 780), "doi: 10.1234 / same-paper.")
            page.insert_link(
                {
                    "kind": pdf_fixture.LINK_URI,
                    "from": pdf_fixture.Rect(60, 780, 250, 795),
                    "uri": "https://doi.org/10.1234/same-paper",
                }
            )
            payload = document.tobytes()
        metadata = extract_pdf_metadata(payload)
        self.assertEqual((metadata.arxiv, metadata.doi), ("hep-th/9901001v3", "10.1234/same-paper"))

    def test_invalid_file_is_not_imported_as_a_pdf(self) -> None:
        app = FastAPI()
        register_global_routes(app)
        response = TestClient(app).post(
            "/api/v1/imports/pdf",
            files={"file": ("fake.pdf", b"not a PDF", "application/pdf")},
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["detail"]["code"], "PDF_INVALID")

    def test_pdf_body_never_supplies_missing_title_or_author(self) -> None:
        document = pdf_fixture.open()
        page = document.new_page(width=612, height=792)
        page.insert_text((72, 100), "The Google File System", fontsize=20)
        page.insert_text(
            (72, 135),
            "Sanjay Ghemawat, Howard Gobioff, and Shun-Tak Leung",
            fontsize=12,
        )
        document.set_metadata({"title": "paper.dvi"})
        payload = document.tobytes()
        document.close()

        metadata = extract_pdf_metadata(payload)

        self.assertEqual(metadata.title, "")
        self.assertEqual(metadata.author, "")
        self.assertEqual(metadata.source, "metadata")

        imported = parse_import("unrelated-filename.pdf", payload)
        self.assertEqual(imported.items[0].title, "unrelated-filename")
        self.assertEqual(imported.items[0].authors, "")

    def test_pdf_partial_metadata_is_not_replaced_or_completed_from_body(self) -> None:
        for embedded, expected in (
            ({"title": "Embedded metadata title"}, ("Embedded metadata title", "")),
            ({"author": "Metadata Author"}, ("", "Metadata Author")),
        ):
            with self.subTest(metadata=embedded):
                with pdf_fixture.open() as document:
                    page = document.new_page()
                    page.insert_text((72, 100), "Body title must be ignored", fontsize=20)
                    page.insert_text((72, 135), "Body Author", fontsize=12)
                    document.set_metadata(embedded)
                    payload = document.tobytes()
                metadata = extract_pdf_metadata(payload)
                self.assertEqual((metadata.title, metadata.author), expected)

    def test_pdf_import_uses_shared_unicode_metadata_extraction(self) -> None:
        with pdf_fixture.open() as document:
            document.new_page()
            document.set_metadata(
                {
                    "title": "中文论文标题与元数据",
                    "author": "张三; 李四",
                    "subject": "Not a journal",
                    "keywords": "Not library metadata",
                }
            )
            payload = document.tobytes()
        metadata = extract_pdf_metadata(payload)
        item = parse_import("paper.pdf", payload).items[0]
        self.assertEqual(item.title, metadata.title)
        self.assertEqual(item.authors, metadata.author)
        self.assertEqual(item.journal, "")
        self.assertEqual(item.doi, "")

    def test_global_bibliography_upload_imports_every_bib_and_ris_entry(self) -> None:
        app = FastAPI()
        register_global_routes(app)

        response = TestClient(app).post(
            "/api/v1/imports/bibliography",
            files=[
                ("files", ("papers.bib", BIB, "application/x-bibtex")),
                (
                    "files",
                    (
                        "papers.ris",
                        b"TY  - JOUR\nTI  - Second research\nAU  - Grace Scholar\nPY  - 2025\nER  -\n",
                        "application/x-research-info-systems",
                    ),
                ),
            ],
        )

        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["count"], 2)
        stored = LiteratureRepository().list()
        self.assertEqual(
            {(item.title, item.authors, item.year) for item in stored},
            {
                ("Admitted research", "Ada Researcher", 2026),
                ("Second research", "Grace Scholar", 2025),
            },
        )
        self.assertTrue(all(not item.tags and not item.collections for item in stored))

    def test_project_bibliography_upload_links_bib_and_ris_to_current_project(self) -> None:
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)

        response = TestClient(app).post(
            "/api/v1/imports/bibliography",
            params={"project_id": self.project.id},
            files=[
                ("files", ("papers.bib", BIB, "application/x-bibtex")),
                (
                    "files",
                    (
                        "papers.ris",
                        b"TY  - JOUR\nTI  - Project RIS\nAU  - Grace Scholar\nPY  - 2025\nER  -\n",
                        "application/x-research-info-systems",
                    ),
                ),
            ],
        )

        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(len(LiteratureRepository().list(project_id=self.project.id)), 2)

    def test_card_import_appends_and_never_rewrites_the_existing_row(self) -> None:
        repository = LiteratureRepository(self.root / "cards.sqlite3")
        item = replace(parse_import("paper.bib", BIB).items[0], abstract="User annotation")
        repository.save_all((item,))
        collection = repository.create_collection("Card research")
        app = FastAPI()
        register_global_routes(app)
        client = TestClient(app)
        with patch(
            "service.literature.api.catalogue.LiteratureRepository", return_value=repository
        ):
            response = client.post(
                "/api/v1/imports/bibliography",
                params={"collection_id": collection["id"]},
                files={"files": ("paper.bib", BIB, "application/x-bibtex")},
            )
        self.assertEqual(response.status_code, 201, response.text)
        payload = response.json()
        # 文献库不做重复判定（proposal 91）：同一张卡片再入库就是新的一条，
        # 预览探测与 resolved_ids 一并移除，前端不再声称"已在库"。
        self.assertNotIn("resolved_ids", payload)
        self.assertEqual(payload["count"], 1)
        self.assertNotEqual(payload["items"][0]["id"], item.id)
        reopened = LiteratureRepository(repository.database)
        stored = reopened.list()
        self.assertEqual(len(stored), 2)
        self.assertEqual(
            next(stored_item for stored_item in stored if stored_item.id == item.id).abstract,
            item.abstract,
        )
        classified = reopened.list(collection_ids=(collection["id"],))
        self.assertEqual([entry.id for entry in classified], [payload["items"][0]["id"]])

    def test_card_import_missing_collection_does_not_write(self) -> None:
        repository = LiteratureRepository(self.root / "cards.sqlite3")
        app = FastAPI()
        register_global_routes(app)
        with patch(
            "service.literature.api.catalogue.LiteratureRepository", return_value=repository
        ):
            response = TestClient(app).post(
                "/api/v1/imports/bibliography",
                params={"collection_id": "removed-collection"},
                files={"files": ("paper.bib", BIB, "application/x-bibtex")},
            )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(repository.list(), ())

    def test_global_bibliography_upload_is_atomic_when_one_file_is_invalid(self) -> None:
        app = FastAPI()
        register_global_routes(app)
        before = LiteratureRepository().list()

        response = TestClient(app).post(
            "/api/v1/imports/bibliography",
            files=[
                ("files", ("valid.bib", BIB, "application/x-bibtex")),
                ("files", ("invalid.ris", b"\xff", "application/x-research-info-systems")),
            ],
        )

        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "BIBLIOGRAPHY_INVALID")
        self.assertEqual(LiteratureRepository().list(), before)

    def test_attachment_batch_failure_removes_only_new_files(self) -> None:
        files = self.root / "batch-files"
        files.mkdir()
        unrelated = files / "unrelated.pdf"
        unrelated.write_bytes(b"original")
        first = managed_object("paper-a", b"new attachment", ".pdf")
        second = managed_object("paper-b", b"other attachment", ".pdf")
        with self.assertRaisesRegex(RuntimeError, "catalogue unavailable"):
            with LiteratureFileBatch(files) as batch:
                batch.stage(first.name, b"new attachment")
                batch.stage(second.name, b"other attachment")
                with patch.object(
                    LiteratureRepository,
                    "save_all",
                    side_effect=RuntimeError("catalogue unavailable"),
                ):
                    batch.commit(())
        # 名字里带 uuid, 一次批次只可能创建属于自己的文件: 回滚删掉它们, 目录里别
        # 人的文件一个都不能少。
        self.assertEqual(unrelated.read_bytes(), b"original")
        self.assertEqual(list(files.iterdir()), [unrelated])

    def test_zotero_desktop_import_copies_pdf_and_preserves_metadata(self) -> None:
        with pdf_fixture.open() as document:
            document.new_page()
            pdf = document.tobytes()
        items = (
            {
                "key": "PARENT1",
                "data": {
                    "key": "PARENT1",
                    "itemType": "journalArticle",
                    "title": "Local Zotero research",
                    "creators": [{"firstName": "Ada", "lastName": "Scholar"}],
                    "publicationTitle": "Local Journal",
                    "date": "2025-07",
                    "DOI": "10.1000/local",
                    "collections": ["COL1"],
                    "tags": [{"tag": "local"}],
                },
            },
            {
                "key": "PDF1",
                "data": {
                    "key": "PDF1",
                    "itemType": "attachment",
                    "parentItem": "PARENT1",
                    "contentType": "application/pdf",
                    "filename": "paper.pdf",
                },
            },
        )
        collections = ({"key": "COL1", "data": {"key": "COL1", "name": "Methods"}},)
        files = self.root / "zotero-files"
        with (
            patch.object(zotero, "_all", side_effect=(items, collections)),
            patch.object(zotero, "_download_pdf", return_value=pdf),
            patch.object(zotero, "SERVICE_LITERATURE_FILES_DIR", files),
        ):
            result = zotero.import_zotero()

        self.assertEqual(result.pdfs, 1)
        self.assertEqual(len(result.items), 1)
        item = result.items[0]
        self.assertEqual(
            (item.title, item.authors, item.journal, item.year),
            ("Local Zotero research", "Ada Scholar", "Local Journal", 2025),
        )
        self.assertEqual(item.collections, ("Methods",))
        self.assertEqual(item.tags, ())
        primary = LiteratureRepository().primary_attachment(item.id)
        assert primary is not None
        self.assertEqual(Path(primary.path).read_bytes(), pdf)

    def test_invalid_second_source_leaves_no_first_copy(self) -> None:
        first = self.source("first.bib", BIB)
        second = self.source("invalid.pdf", b"not a PDF")
        with self.assertRaises(LiteratureImportError) as caught:
            import_from_paths(
                self.content, self.project.id, (str(first), str(second)), ImportSource.LOCAL_FILE
            )
        self.assertEqual(caught.exception.code, "invalid_pdf")
        self.assertEqual(list(self.library.iterdir()), [])

    def test_empty_and_unsupported_sources_leave_no_copy(self) -> None:
        for name, data, code in (
            ("empty.bib", b"", "no_records_parsed"),
            ("bad.bib", b"@article{a,title={Truncated}", "invalid_bibtex"),
            ("bad.ris", b"\xff", "not_text_file"),
            ("source.json", b"{}", "unsupported_format"),
        ):
            with self.subTest(name=name):
                source = self.source(name, data)
                with self.assertRaises(LiteratureImportError) as caught:
                    import_from_paths(
                        self.content, self.project.id, (str(source),), ImportSource.LOCAL_FILE
                    )
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(list(self.library.iterdir()), [])

    def test_directory_is_not_imported_as_a_file(self) -> None:
        with self.assertRaises(LiteratureImportError):
            import_from_paths(
                self.content, self.project.id, (str(self.root),), ImportSource.LOCAL_FILE
            )
        self.assertEqual(list(self.library.iterdir()), [])

    def test_missing_titles_are_counted_not_silently_discarded(self) -> None:
        result = parse_import("source.bib", BIB + b"\n@article{b,author={No Title}}")
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.skipped, 1)
        result = parse_import("source.ris", RIS + b"TY  - JOUR\nAU  - No Title\nER  -\n")
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.skipped, 1)

    def test_unclosed_ris_records_are_not_silently_combined(self) -> None:
        with self.assertRaises(LiteratureImportError) as caught:
            parse_import("source.ris", RIS.replace(b"ER  -\n", b"") + RIS)
        self.assertEqual(caught.exception.code, "invalid_ris")

    def test_batch_byte_limit_stops_reading_before_materialization(self) -> None:
        first = self.source("first.bib", BIB)
        second = self.source("second.bib", BIB)
        unread = self.root / "must-not-read.bib"
        with patch("service.literature.service.importer.MAX_IMPORT_BYTES", len(BIB)):
            with self.assertRaises(LiteratureImportError) as caught:
                import_from_paths(
                    self.content,
                    self.project.id,
                    (str(first), str(second), str(unread)),
                    ImportSource.LOCAL_FILE,
                )
        self.assertEqual(caught.exception.code, "import_too_large")
        self.assertEqual(list(self.library.iterdir()), [])

    def test_record_limit_rejects_whole_batch_without_truncation(self) -> None:
        source = self.source("many.bib", BIB * (MAX_BATCH_RECORDS + 1))
        with self.assertRaises(LiteratureImportError) as caught:
            import_from_paths(
                self.content, self.project.id, (str(source),), ImportSource.LOCAL_FILE
            )
        self.assertEqual(caught.exception.code, "too_many_records")
        self.assertEqual(list(self.library.iterdir()), [])

    def test_materialized_bytes_are_the_bytes_that_were_admitted(self) -> None:
        source = self.source("source.bib", BIB)
        read = self.content.read_import_source

        def replace_after_read(project_id: str, path: str):
            result = read(project_id, path)
            source.write_bytes(b"later unrelated contents")
            return result

        with patch.object(self.content, "read_import_source", side_effect=replace_after_read):
            outcome = import_from_paths(
                self.content, self.project.id, (str(source),), ImportSource.LOCAL_FILE
            )
        self.assertEqual(outcome.items[0].title, "Admitted research")
        self.assertEqual((self.library / source.name).read_bytes(), BIB)

    def test_explicit_import_read_does_not_authorize_project_read(self) -> None:
        source = self.source("selected.bib", BIB)
        observed = self.content.read_import_source(self.project.id, str(source))
        self.assertEqual(observed.content, BIB)
        self.assertEqual(list(self.library.iterdir()), [])
        with self.assertRaises(ContentError):
            self.content.read_bytes(self.project.id, "../selected.bib")

    def test_real_pdf_is_published_to_the_project_and_owned_by_literature(self) -> None:
        with pdf_fixture.open() as document:
            document.new_page()
            document.set_metadata({"title": "A readable research document"})
            payload = document.tobytes()
        source = self.source("research.pdf", payload)
        result = import_from_paths(
            self.content, self.project.id, (str(source),), ImportSource.LOCAL_FILE
        )
        item = result.items[0]
        self.assertEqual(item.fulltext, FulltextStatus.READY)
        self.assertEqual(item.title, "A readable research document")
        primary = LiteratureRepository().primary_attachment(item.id)
        assert primary is not None
        published = self.content.asset(self.project.id, result.asset_ids[0])
        # 项目里那份照旧发布 (资料库视图与导入台账指着它); 文献附件是自己独占的一
        # 份托管副本 —— 同样的字节, 不同的文件。
        self.assertEqual(
            self.content.read_asset_bytes(self.project.id, result.asset_ids[0])[0], payload
        )
        owned = Path(primary.path)
        self.assertTrue(owned.is_relative_to(self.files))
        self.assertNotEqual(owned, Path(self.content.resolve(self.project.id, published.path)))
        self.assertEqual(owned.read_bytes(), payload)

    def test_project_file_rename_never_moves_the_literature_attachment(self) -> None:
        with pdf_fixture.open() as document:
            document.new_page().insert_text((50, 50), "Original literature PDF")
            payload = document.tobytes()
        source = self.source("identity.pdf", payload)
        receipt = import_from_paths(
            self.content, self.project.id, (str(source),), ImportSource.LOCAL_FILE
        )
        stored = load_library(self.project.id).items[0]
        primary = LiteratureRepository().primary_attachment(stored.id)
        assert primary is not None
        note = LiteratureRepository().create_note(stored.id, "User-owned annotation")
        published = self.content.asset(self.project.id, receipt.asset_ids[0])
        renamed = self.content.rename(self.project.id, published.path, "renamed.pdf")
        resolver = LiteraturePdf()
        self.assertEqual(resolver.read(stored)[0], payload)
        app = FastAPI()
        app.state.content = self.content
        register_global_routes(app)
        register_reading_routes(
            app,
            LiteratureRepository(),
            LiteratureAttachmentContent(),
            resolver,
            WorkbenchFormatPolicy(),
        )
        with TestClient(app) as client:
            query = {"project": self.project.id}
            location = client.get(
                f"/api/v1/literatures/{stored.id}/attachments/{primary.id}/location"
            )
            self.assertEqual(location.status_code, 200, location.text)
            self.assertEqual(
                location.json(),
                {"absolute": str(Path(primary.path).resolve())},
            )
            opened = client.get(
                f"/api/v1/literatures/{stored.id}/attachments/{primary.id}/content",
                params=query,
            )
            self.assertEqual(opened.status_code, 200, opened.text)
            self.assertEqual(opened.content, payload)
            # 项目里那份被改名、甚至被删掉, 文献读的始终是自己那份副本。
            Path(self.content.resolve(self.project.id, renamed.path)).unlink()
            self.assertEqual(resolver.read(stored)[0], payload)
            opened = client.get(
                f"/api/v1/literatures/{stored.id}/attachments/{primary.id}/content",
                params=query,
            )
            self.assertEqual(opened.status_code, 200, opened.text)
            self.assertEqual(opened.content, payload)
        unchanged = load_library(self.project.id).items[0]
        unchanged_primary = LiteratureRepository().primary_attachment(unchanged.id)
        assert unchanged_primary is not None
        self.assertEqual(unchanged_primary.path, primary.path)
        self.assertEqual(Path(unchanged_primary.path).read_bytes(), payload)
        self.assertEqual(unchanged.notes, (note,))

    def test_pdf_read_verifies_open_descriptor_after_identity_lookup(self) -> None:
        source = self.source("source.bib", BIB)
        receipt = import_from_paths(
            self.content, self.project.id, (str(source),), ImportSource.LOCAL_FILE
        )
        asset_id = receipt.asset_ids[0]
        asset = self.content.asset(self.project.id, asset_id)
        path = Path(self.content.resolve(self.project.id, asset.path))
        replacement = self.source("replacement.bib", RIS)

        def swapped_read(parent, name, limit, *, verify=None):
            replacement.replace(path)
            return read_regular(parent, name, limit, verify=verify)

        with patch("service.content.service.identity.read_regular", side_effect=swapped_read):
            with self.assertRaises(ContentError):
                self.content.read_asset_bytes(self.project.id, asset_id)

    def test_completed_receipt_survives_deleted_source_and_removed_record(self) -> None:
        source = self.source("source.bib", BIB)
        receipt = import_from_paths(
            self.content,
            self.project.id,
            (str(source),),
            ImportSource.LOCAL_FILE,
            "explicit-request",
        )
        source.unlink()
        with edit_library(self.project.id) as edit:
            edit.view = LiteratureView()
        with patch.object(
            self.content, "materialize", side_effect=AssertionError("must not recreate")
        ):
            replay = import_from_paths(
                self.content,
                self.project.id,
                (str(source),),
                ImportSource.LOCAL_FILE,
                "explicit-request",
            )
        self.assertEqual(receipt, replay)
        self.assertEqual(load_library(self.project.id).items, ())
        self.assertEqual(len(list(self.library.iterdir())), 1)

    def test_concurrent_same_request_commits_one_outcome(self) -> None:
        source = self.source("source.bib", BIB)

        def submit(_):
            return import_from_paths(
                self.content,
                self.project.id,
                (str(source),),
                ImportSource.LOCAL_FILE,
                "concurrent-request",
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            receipts = list(executor.map(submit, range(2)))
        self.assertEqual(receipts[0], receipts[1])
        self.assertEqual(len(list(self.library.iterdir())), 1)
        self.assertEqual(len(load_library(self.project.id).items), 1)

    def test_same_operation_id_is_isolated_between_projects(self) -> None:
        source = self.source("shared.bib", BIB)
        other = self.content.create_project("另一个文献项目")
        operation_id = "shared-operation"

        first = import_from_paths(
            self.content,
            self.project.id,
            (str(source),),
            ImportSource.LOCAL_FILE,
            operation_id,
        )
        second = import_from_paths(
            self.content,
            other.id,
            (str(source),),
            ImportSource.LOCAL_FILE,
            operation_id,
        )

        self.assertEqual((first.added, first.skipped, first.total), (1, 0, 1))
        self.assertEqual((second.added, second.skipped, second.total), (1, 0, 1))
        self.assertNotEqual(first.items[0].id, second.items[0].id)
        self.assertEqual(len(load_library(self.project.id).items), 1)
        self.assertEqual(len(load_library(other.id).items), 1)
        with closing(connect(self.database)) as connection, connection:
            states = connection.execute(
                f"SELECT project_id,state FROM {IMPORT_TABLE} WHERE operation_id=?",
                (operation_id,),
            ).fetchall()
        self.assertEqual({row["project_id"] for row in states}, {self.project.id, other.id})
        self.assertTrue(all(row["state"] == ImportState.COMPLETED.value for row in states))

    def test_snapshot_failure_rolls_back_completed_receipt(self) -> None:
        source = self.source("source.bib", BIB)
        # The persistence owner encodes the final snapshot only after setting the receipt.
        with patch(
            "service.literature.persistence.store.encode",
            side_effect=LiteratureError(LIBRARY_INVALID),
        ):
            with self.assertRaises(LiteratureError):
                import_from_paths(
                    self.content,
                    self.project.id,
                    (str(source),),
                    ImportSource.LOCAL_FILE,
                    "rollback-request",
                )
        self.assertEqual(load_library(self.project.id).items, ())
        recovered = import_from_paths(
            self.content,
            self.project.id,
            (str(source),),
            ImportSource.LOCAL_FILE,
            "rollback-request",
        )
        self.assertEqual((recovered.added, recovered.skipped, recovered.total), (1, 0, 1))
        self.assertTrue(
            all(item.updated_at == item.added_at for item in load_library(self.project.id).items)
        )
        self.assertEqual(
            tuple(replace(item, updated_at=0) for item in load_library(self.project.id).items),
            recovered.items,
        )
        self.assertEqual(len(list(self.library.iterdir())), 1)

    def test_pdf_renamed_after_materialization_is_recovered_at_current_path(self) -> None:
        with pdf_fixture.open() as document:
            document.new_page()
            payload = document.tobytes()
        source = self.source("original.pdf", payload)
        with patch(
            "service.literature.persistence.store.encode",
            side_effect=LiteratureError(LIBRARY_INVALID),
        ):
            with self.assertRaises(LiteratureError):
                import_from_paths(
                    self.content,
                    self.project.id,
                    (str(source),),
                    ImportSource.LOCAL_FILE,
                    "rename-recovery",
                )
        root = self.content.root(self.project.id, RootKind.LITERATURE).path
        renamed = self.content.rename(self.project.id, f"{root}/original.pdf", "renamed.pdf")
        receipt = import_from_paths(
            self.content,
            self.project.id,
            (str(source),),
            ImportSource.LOCAL_FILE,
            "rename-recovery",
        )
        item = load_library(self.project.id).items[0]
        primary = LiteratureRepository().primary_attachment(item.id)
        assert primary is not None
        self.assertEqual(
            self.content.asset(self.project.id, receipt.asset_ids[0]).path, renamed.path
        )
        self.assertTrue(receipt.items[0].has_pdf)
        self.assertEqual(
            self.content.read_asset_bytes(self.project.id, receipt.asset_ids[0])[0], payload
        )
        self.assertEqual(Path(primary.path).read_bytes(), payload)

    def test_bad_preparation_count_is_rejected_before_any_materialization(self) -> None:
        source = self.source("source.bib", BIB)
        with patch.object(self.content, "materialize", side_effect=ContentError("read_failed")):
            with self.assertRaises(LiteratureImportError):
                import_from_paths(
                    self.content,
                    self.project.id,
                    (str(source),),
                    ImportSource.LOCAL_FILE,
                    "bad-preparation",
                )
        with closing(connect(self.database)) as connection, connection:
            connection.execute(
                f"UPDATE {IMPORT_TABLE} SET skipped = -1 WHERE project_id = ?",
                (self.project.id,),
            )
        prepared_files = {path.name: path.read_bytes() for path in self.library.iterdir()}
        with patch.object(self.content, "materialize", side_effect=AssertionError("no writes")):
            with self.assertRaises(LiteratureError):
                import_from_paths(
                    self.content,
                    self.project.id,
                    (str(source),),
                    ImportSource.LOCAL_FILE,
                    "bad-preparation",
                )
        self.assertEqual(
            {path.name: path.read_bytes() for path in self.library.iterdir()}, prepared_files
        )
        self.assertFalse((self.library / "source.bib").exists())

    def test_uncommitted_batch_preparations_are_released_on_failure(self) -> None:
        first = self.source("first.bib", BIB)
        second = self.source("second.ris", RIS)
        prepare = self.content.prepare_bytes
        calls = 0

        def fail_second(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise ContentError("write_failed")
            return prepare(*args, **kwargs)

        with patch.object(self.content, "prepare_bytes", side_effect=fail_second):
            with self.assertRaises(LiteratureImportError):
                import_from_paths(
                    self.content,
                    self.project.id,
                    (str(first), str(second)),
                    ImportSource.LOCAL_FILE,
                    "prepare-failure",
                )
        self.assertEqual(list(self.library.iterdir()), [])

    def test_partial_materialization_resumes_same_targets_without_source_reads(self) -> None:
        first = self.source("first.bib", BIB)
        second = self.source("second.ris", RIS)
        materialize = self.content.materialize
        calls = 0

        def interrupt_second(prepared):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise ContentError("read_failed")
            return materialize(prepared)

        sources = (str(first), str(second))
        with patch.object(self.content, "materialize", side_effect=interrupt_second):
            with self.assertRaises(LiteratureImportError):
                import_from_paths(
                    self.content, self.project.id, sources, ImportSource.LOCAL_FILE, "recover-batch"
                )
        self.assertEqual(load_library(self.project.id).items, ())
        with patch.object(
            self.content, "read_import_source", side_effect=AssertionError("no source read")
        ):
            receipt = import_from_paths(
                self.content, self.project.id, sources, ImportSource.LOCAL_FILE, "recover-batch"
            )
        self.assertEqual((receipt.added, receipt.skipped, receipt.total), (2, 0, 2))
        self.assertEqual(len({item.id for item in receipt.items}), 2)
        self.assertEqual(
            sorted(path.name for path in self.library.iterdir()), ["first.bib", "second.ris"]
        )
        persisted = load_library(self.project.id).items
        self.assertTrue(all(item.updated_at == item.added_at for item in persisted))
        self.assertEqual(tuple(replace(item, updated_at=0) for item in persisted), receipt.items)
        with (
            patch.object(
                self.content, "read_import_source", side_effect=AssertionError("no source read")
            ),
            patch.object(
                self.content, "materialize", side_effect=AssertionError("no duplicate write")
            ),
        ):
            replay = import_from_paths(
                self.content, self.project.id, sources, ImportSource.LOCAL_FILE, "recover-batch"
            )
        self.assertEqual(replay, receipt)
        self.assertEqual(load_library(self.project.id).items, persisted)

    def test_artifact_collection_id_survives_pending_import_and_rename(self) -> None:
        repository = LiteratureRepository()
        collection = repository.create_collection("Pending global")
        plan = plan_artifact_import("artifact", "paper.bib", BIB, collection_id=collection["id"])
        with patch.object(self.content, "materialize", side_effect=ContentError("write_failed")):
            with self.assertRaises(LiteratureImportError):
                import_from_bytes(self.content, self.project.id, plan, "paper.bib", BIB)
        repository.rename_collection(collection["id"], "Renamed global")
        receipt = LiteratureImports(self.content).resume(
            self.project.id, plan.operation_id, plan.fingerprint
        )
        self.assertIsNotNone(receipt)
        with closing(connect(self.database)) as connection:
            self.assertEqual(
                [
                    tuple(row)
                    for row in connection.execute(
                        "SELECT collection_id,literature_id FROM literature_collection_items"
                    )
                ],
                [(collection["id"], receipt.items[0].id)],
            )

    def test_collection_import_failure_rolls_back_items_membership_and_receipt(self) -> None:
        repository = LiteratureRepository()
        collection = repository.create_collection("Atomic global")
        plan = plan_artifact_import("artifact", "paper.bib", BIB, collection_id=collection["id"])
        with patch.object(
            LiteratureImports,
            "_decode_receipt",
            side_effect=sqlite3.OperationalError("write failed"),
        ):
            with self.assertRaises(LiteratureError) as caught:
                import_from_bytes(self.content, self.project.id, plan, "paper.bib", BIB)
        self.assertEqual(caught.exception.code, LIBRARY_UNAVAILABLE)
        self.assertEqual(load_library(self.project.id).items, ())
        with closing(connect(self.database)) as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM literature_collection_items").fetchone()[
                    0
                ],
                0,
            )
            self.assertEqual(
                tuple(connection.execute(f"SELECT state,result FROM {IMPORT_TABLE}").fetchone()),
                (ImportState.PREPARED.value, None),
            )
        receipt = LiteratureImports(self.content).resume(
            self.project.id, plan.operation_id, plan.fingerprint
        )
        self.assertEqual(receipt.added, 1)

    def test_deleted_collection_rejects_pending_import_without_committing_items(self) -> None:
        repository = LiteratureRepository()
        collection = repository.create_collection("Deleted global")
        plan = plan_artifact_import("artifact", "paper.bib", BIB, collection_id=collection["id"])
        with patch.object(self.content, "materialize", side_effect=ContentError("write_failed")):
            with self.assertRaises(LiteratureImportError):
                import_from_bytes(self.content, self.project.id, plan, "paper.bib", BIB)
        repository.delete_collection(collection["id"])
        with self.assertRaises(LiteratureError):
            LiteratureImports(self.content).resume(
                self.project.id, plan.operation_id, plan.fingerprint
            )
        self.assertEqual(load_library(self.project.id).items, ())
        with closing(connect(self.database)) as connection:
            self.assertEqual(
                connection.execute(f"SELECT state FROM {IMPORT_TABLE}").fetchone()[0],
                ImportState.PREPARED.value,
            )

    def test_collection_schema_upgrade_preserves_receipts_and_extra_columns(self) -> None:
        source = self.source("legacy.bib", BIB)
        receipt = import_from_paths(
            self.content, self.project.id, (str(source),), ImportSource.LOCAL_FILE, "legacy"
        )
        with closing(connect(self.database)) as connection, connection:
            connection.execute(f"ALTER TABLE {IMPORT_TABLE} DROP COLUMN collection_id")
            connection.execute(
                f"ALTER TABLE {IMPORT_TABLE} ADD COLUMN retained TEXT DEFAULT 'retained'"
            )
        replay = import_from_paths(
            self.content, self.project.id, (str(source),), ImportSource.LOCAL_FILE, "legacy"
        )
        self.assertEqual(replay, receipt)
        with closing(connect(self.database)) as connection:
            self.assertEqual(
                tuple(
                    connection.execute(
                        f"SELECT collection_id,retained FROM {IMPORT_TABLE}"
                    ).fetchone()
                ),
                ("", "retained"),
            )

    def test_collection_id_import_preserves_existing_same_named_project_children(self) -> None:
        repository = LiteratureRepository()
        parents = [
            repository.create_collection(name, project_id=self.project.id)
            for name in ("First", "Second")
        ]
        children = [
            repository.create_collection("Same", parent_id=parent["id"], project_id=self.project.id)
            for parent in parents
        ]
        before = repository.collections(self.project.id)
        plan = plan_artifact_import("artifact", "paper.bib", BIB, collection_id=children[1]["id"])
        receipt = import_from_bytes(self.content, self.project.id, plan, "paper.bib", BIB)
        after = repository.collections(self.project.id)
        self.assertEqual(
            [(row["id"], row["parent_id"]) for row in after],
            [(row["id"], row["parent_id"]) for row in before],
        )
        with closing(connect(self.database)) as connection:
            self.assertEqual(
                [
                    tuple(row)
                    for row in connection.execute(
                        "SELECT collection_id,literature_id FROM literature_collection_items"
                    )
                ],
                [(children[1]["id"], receipt.items[0].id)],
            )


if __name__ == "__main__":
    unittest.main()
