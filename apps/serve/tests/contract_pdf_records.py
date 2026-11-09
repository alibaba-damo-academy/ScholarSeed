"""Final PDF record contract and literature-attachment ownership gates."""

from __future__ import annotations

import json
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.cutover import cutover_pdf_records
from service.literature.api.reading import register_reading_routes
from service.literature.persistence import files as literature_files
from service.literature.persistence.reading import AttachmentRecordCatalog
from service.literature.persistence.store import LiteratureRepository, inspect_schema
from service.literature.schema import (
    BINARY_MEDIA_TYPE,
    PDF_MEDIA_TYPE,
    AttachmentRole,
    LiteratureItem,
)
from service.literature.service.attachment import LiteratureAttachmentContent
from service.literature.service.pdf import LiteraturePdf
from service.platform.activity import Activities
from service.platform.content import RootKind
from service.platform.notifications import Change, ChangeHub, ChangeTopic
from service.platform.records import (
    EMPTY_RECORDS,
    RecordOwner,
    RecordTarget,
    decode_records,
    record_revision,
)
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.persistence.records import PdfRecordCatalog
from service.workbench.service.records import PdfRecordStore
from tests import pdf as pdf_fixture


def _stage_attachment(
    repository: LiteratureRepository,
    files: Path,
    literature_id: str,
    name: str,
    payload: bytes,
    **columns: Any,
) -> dict[str, Any]:
    """Write the literature-owned copy of one attachment and register its row."""
    published = literature_files.managed_object(literature_id, payload, Path(name).suffix)
    (files / published.name).write_bytes(payload)
    return repository.add_attachment(
        literature_id,
        name,
        str(files / published.name),
        revision=published.revision,
        **columns,
    )


def _records() -> dict:
    return {
        "schema_version": 1,
        "marks": [
            {
                "id": "mark-1",
                "style": "highlight",
                "color": "yellow",
                "page": 1,
                "quads": [[0.1, 0.1, 0.3, 0.2]],
                "text": "evidence",
                "anchor_state": "anchored",
                "created_at": 1.0,
                "updated_at": 1.0,
            }
        ],
        "comments": [
            {
                "id": "comment-1",
                "mark_id": "mark-1",
                "body": "note",
                "created_at": 1.0,
            }
        ],
        "notes": [],
    }


def test_records_v1_is_canonical_and_source_bound() -> None:
    records = decode_records(_records())
    assert records == _records()
    first = record_revision("sha256:source-a", records)
    assert first.startswith("sha256:")
    assert first != record_revision("sha256:source-b", records)
    assert EMPTY_RECORDS == {
        "schema_version": 1,
        "marks": [],
        "comments": [],
        "notes": [],
    }


def test_attachment_content_reads_managed_payload_once() -> None:
    root = Path(tempfile.mkdtemp())
    files = root / "files"
    files.mkdir()
    repository = LiteratureRepository(root / "literature.sqlite3")
    repository.save(LiteratureItem(id="paper", title="Paper"))
    attachment = _stage_attachment(
        repository,
        files,
        "paper",
        "paper.pdf",
        b"%PDF-1.4\nonce\n",
        kind="pdf",
        role=AttachmentRole.PRIMARY,
        media_type=PDF_MEDIA_TYPE,
    )
    content = LiteratureAttachmentContent(repository)

    with (
        patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", files),
        patch(
            "service.literature.service.attachment.read_attachment",
            wraps=literature_files.read_attachment,
        ) as read,
    ):
        payload, media_type, revision = content.read_attachment("paper", attachment["id"])

    assert payload == b"%PDF-1.4\nonce\n"
    assert media_type == PDF_MEDIA_TYPE
    assert revision == attachment["revision"]
    assert read.call_count == 1


def test_attachment_records_are_isolated_and_cascade_with_owner() -> None:
    database = Path(tempfile.mkdtemp()) / "literature.sqlite3"
    repository = LiteratureRepository(database)
    repository.save(LiteratureItem(id="paper", title="Paper"))
    first = repository.add_attachment(
        "paper", "first.pdf", "first.pdf", kind="pdf", revision="sha256:first"
    )
    second = repository.add_attachment(
        "paper", "second.pdf", "second.pdf", kind="pdf", revision="sha256:second"
    )
    catalog = AttachmentRecordCatalog(database)
    source_revision = "sha256:source"

    target = RecordTarget(RecordOwner.LITERATURE_ATTACHMENT, "paper", first["id"])
    empty = catalog.snapshot(target, source_revision)
    saved = catalog.commit(target, source_revision, _records(), empty.record_revision)
    other = catalog.snapshot(
        RecordTarget(RecordOwner.LITERATURE_ATTACHMENT, "paper", second["id"]),
        source_revision,
    )

    assert len(saved.records["marks"]) == 1
    assert other.records == EMPTY_RECORDS
    repository.delete_attachment("paper", first["id"])
    assert catalog.exists(first["id"]) is False


def test_exact_attachment_routes_enforce_parent_media_and_two_revisions() -> None:
    root = Path(tempfile.mkdtemp())
    files = root / "files"
    files.mkdir()
    database = root / "literature.sqlite3"
    changes: list[Change] = []
    hub = ChangeHub("records-test")
    hub.publish = changes.extend
    repository = LiteratureRepository(database, changes=hub)
    repository.save(LiteratureItem(id="paper", title="Paper"))
    # 同一条文献的两行附件各有各的托管副本: "替换其中一份字节"只可能改变它自己那
    # 一行的修订号, 这正是 records 路由要守的口径。
    pdf = _stage_attachment(
        repository,
        files,
        "paper",
        "paper.pdf",
        b"%PDF-1.4\nattachment\n",
        kind="pdf",
        role=AttachmentRole.PRIMARY,
        media_type=PDF_MEDIA_TYPE,
    )
    binary = _stage_attachment(
        repository,
        files,
        "paper",
        "data.bin",
        b"%PDF-1.4\nattachment\n",
        media_type=BINARY_MEDIA_TYPE,
    )
    app = FastAPI()
    with patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", files):
        register_reading_routes(
            app,
            repository,
            LiteratureAttachmentContent(repository),
            LiteraturePdf(repository),
            WorkbenchFormatPolicy(),
        )
        client = TestClient(app)
        route = f"/api/v1/literatures/paper/attachments/{pdf['id']}/records"

        opened = client.get(route)
        assert opened.status_code == 200
        snapshot = opened.json()
        assert snapshot["record_target"] == {
            "owner": "literature_attachment",
            "scope_id": "paper",
            "subject_id": pdf["id"],
        }
        saved = client.put(
            route,
            headers={"If-Match": f'"{snapshot["record_revision"]}"'},
            json={
                "expected_source_revision": snapshot["source_revision"],
                "records": _records(),
            },
        )
        assert saved.status_code == 200
        assert Change(ChangeTopic.RECORDS, subject=pdf["id"]) in changes
        changes.clear()
        assert len(saved.json()["records"]["marks"]) == 1
        stale_record_write = client.put(
            route,
            headers={"If-Match": f'"{snapshot["record_revision"]}"'},
            json={
                "expected_source_revision": snapshot["source_revision"],
                "records": _records(),
            },
        )
        assert stale_record_write.status_code == 412
        assert changes == []
        Path(pdf["path"]).write_bytes(b"%PDF-1.4\nreplacement\n")
        stale = client.get(route)
        assert stale.status_code == 200
        assert stale.json()["records"]["marks"][0]["anchor_state"] == "stale"
        source_conflict = client.put(
            route,
            headers={"If-Match": f'"{saved.json()["record_revision"]}"'},
            json={
                "expected_source_revision": saved.json()["source_revision"],
                "records": _records(),
            },
        )
        assert source_conflict.status_code == 409
        assert changes == []
        assert (
            client.get(f"/api/v1/literatures/missing/attachments/{pdf['id']}/records").status_code
            == 404
        )
        assert (
            client.get(f"/api/v1/literatures/paper/attachments/{binary['id']}/content").status_code
            == 200
        )
        assert (
            client.get(f"/api/v1/literatures/paper/attachments/{binary['id']}/records").status_code
            == 415
        )


def test_startup_cutover_preserves_catalogue_and_removes_obsolete_records() -> None:
    root = Path(tempfile.mkdtemp())
    literature = root / "literature.sqlite3"
    connection = sqlite3.connect(literature)
    connection.executescript("""CREATE TABLE literature_items(
        id TEXT PRIMARY KEY,citation_key TEXT NOT NULL DEFAULT '',item_type TEXT NOT NULL,
        bib_type TEXT NOT NULL,title TEXT NOT NULL,subtitle TEXT NOT NULL DEFAULT '',
        authors TEXT NOT NULL DEFAULT '',publication TEXT NOT NULL DEFAULT '',year INTEGER,
        published_date TEXT NOT NULL DEFAULT '',abstract TEXT NOT NULL DEFAULT '',
        doi TEXT NOT NULL DEFAULT '',arxiv TEXT NOT NULL DEFAULT '',isbn TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',volume TEXT NOT NULL DEFAULT '',number TEXT NOT NULL DEFAULT '',
        pages TEXT NOT NULL DEFAULT '',publisher TEXT NOT NULL DEFAULT '',address TEXT NOT NULL DEFAULT '',
        fulltext TEXT NOT NULL DEFAULT 'none',pdf_path TEXT NOT NULL DEFAULT '',
        pdf_asset_id TEXT NOT NULL DEFAULT '',created_at REAL NOT NULL,updated_at REAL NOT NULL,
        version INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE literature_attachments(
        id TEXT PRIMARY KEY,literature_id TEXT NOT NULL REFERENCES literature_items(id) ON DELETE CASCADE,
        name TEXT NOT NULL,path TEXT NOT NULL DEFAULT '',asset_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'file',created_at REAL NOT NULL);
        CREATE TABLE literature_marks(id TEXT PRIMARY KEY,attachment_id TEXT NOT NULL REFERENCES literature_attachments(id) ON DELETE CASCADE,text TEXT NOT NULL,page INTEGER,
        created_at REAL NOT NULL);
        CREATE TABLE literature_reading_records(literature_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE literature_attachment_records(
        attachment_id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision TEXT NOT NULL);
        INSERT INTO literature_items(id,item_type,bib_type,title,authors,fulltext,pdf_path,
        pdf_asset_id,created_at,updated_at) VALUES(
        'paper','document','misc','Preserved paper','Researcher','ready','paper.pdf','asset',1,1);
        INSERT INTO literature_attachments VALUES(
        'attachment','paper','paper.pdf','paper.pdf','asset','pdf',1);
        INSERT INTO literature_marks VALUES('old-mark','attachment','old',1,1);
        INSERT INTO literature_reading_records VALUES('paper','{}');
        INSERT INTO literature_attachment_records VALUES('attachment','{}','old');""")
    connection.close()
    project = root / "project.sqlite3"
    connection = sqlite3.connect(project)
    connection.executescript("""CREATE TABLE content_asset(asset_id TEXT PRIMARY KEY);
        INSERT INTO content_asset VALUES('asset');
        CREATE TABLE workbench_pdf_record(
        asset_id TEXT PRIMARY KEY REFERENCES content_asset(asset_id),payload BLOB NOT NULL,revision TEXT NOT NULL,updated_at REAL NOT NULL);
        INSERT INTO workbench_pdf_record VALUES('asset','{}','old',1);""")
    connection.close()

    backups = cutover_pdf_records(literature, (project,))

    assert len(backups) == 2
    assert all(path.exists() for path in backups)
    assert inspect_schema(literature).needs_write  # Remaining library tables are absent.
    assert LiteratureRepository(literature).get("paper").title == "Preserved paper"
    assert not inspect_schema(literature).needs_write
    with closing(sqlite3.connect(literature)) as current, current:
        tables = {
            row[0] for row in current.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "literature_marks" not in tables
        assert "literature_reading_records" not in tables
        assert {row[1] for row in current.execute("PRAGMA table_info(literature_items)")} & {
            "pdf_path",
            "pdf_asset_id",
        } == set()
        attachment = current.execute(
            "SELECT role,media_type,revision FROM literature_attachments WHERE id='attachment'"
        ).fetchone()
        assert attachment == ("primary", "application/pdf", "")
        assert current.execute("SELECT count(*) FROM literature_items").fetchone()[0] == 1
        assert (
            current.execute("SELECT count(*) FROM literature_attachment_records").fetchone()[0] == 0
        )
    with closing(sqlite3.connect(project)) as current, current:
        assert {row[1] for row in current.execute("PRAGMA table_info(workbench_pdf_record)")} == {
            "asset_id",
            "record_revision",
            "source_revision",
            "payload",
            "updated_at",
        }
        assert current.execute("SELECT count(*) FROM workbench_pdf_record").fetchone()[0] == 0


def test_explicit_copy_creates_independent_project_owner_and_optional_snapshot() -> None:
    root = Path(tempfile.mkdtemp())
    content_catalog = ContentCatalog(root / "content.sqlite3")
    content = ContentService(
        ProjectRegistry(str(root / "projects"), content_catalog),
        content_catalog,
        activities=Activities(),
    )
    target_project = content.create_project("Copy")
    with pdf_fixture.open() as document:
        document.new_page()
        document.embfile_add("scholarseed-annotations.json", json.dumps(_records()).encode())
        source_bytes = document.tobytes()
    files = root / "files"
    files.mkdir()
    database = root / "literature.sqlite3"
    repository = LiteratureRepository(database)
    repository.save(LiteratureItem(id="paper", title="Paper"))
    attachment = _stage_attachment(
        repository,
        files,
        "paper",
        "source.pdf",
        source_bytes,
        kind="pdf",
        role=AttachmentRole.PRIMARY,
        media_type=PDF_MEDIA_TYPE,
    )
    literature_records = AttachmentRecordCatalog(database)
    source_target = RecordTarget(RecordOwner.LITERATURE_ATTACHMENT, "paper", attachment["id"])

    class ManagedCopies:
        def create_managed_copy(
            self, project_id: str, name: str, payload: bytes, idempotency_key: str
        ) -> SimpleNamespace:
            del idempotency_key
            parent = content.root(project_id, RootKind.RESOURCES).path
            prepared = content.prepare_bytes(project_id, parent, name, payload)
            asset = content.materialize(prepared)
            snapshot = content.snapshot(project_id, asset.path)
            return SimpleNamespace(
                project_id=project_id,
                path=asset.path,
                revision=snapshot.revision,
            )

    with patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", files):
        pdf = LiteraturePdf(repository)
        _payload, _media_type, source_revision = pdf.read_attachment("paper", attachment["id"])
        empty = literature_records.snapshot(source_target, source_revision)
        edited_records = _records()
        edited_records["marks"][0]["color"] = "purple"
        literature_records.commit(
            source_target, source_revision, edited_records, empty.record_revision
        )
        project_records = PdfRecordStore(content, PdfRecordCatalog(content))
        app = FastAPI()
        app.state.content = content
        app.state.pdf_records = project_records
        app.state.resource_version_supervisor = ManagedCopies()
        register_reading_routes(
            app,
            repository,
            LiteratureAttachmentContent(repository),
            pdf,
            WorkbenchFormatPolicy(),
        )
        client = TestClient(app)
        copied = client.post(
            f"/api/v1/literatures/paper/attachments/{attachment['id']}/copy-to-project",
            params={"project": target_project.id, "name": "copied.pdf", "copy_records": True},
            headers={"Idempotency-Key": "copy-operation"},
        )

        omitted = client.post(
            f"/api/v1/literatures/paper/attachments/{attachment['id']}/copy-to-project",
            params={
                "project": target_project.id,
                "name": "without-records.pdf",
                "copy_records": False,
            },
            headers={"Idempotency-Key": "without-records"},
        )
        assert omitted.status_code == 200, omitted.text
        assert (
            project_records.snapshot_asset(
                target_project.id, omitted.json()["target_target"]["subject_id"]
            ).records
            == EMPTY_RECORDS
        )
        assert copied.status_code == 200, copied.text
        receipt = copied.json()
        assert receipt["source_target"] == source_target.response()
        assert receipt["target_target"]["owner"] == "project_asset"
        assert receipt["records_copied"] is True
        target = project_records.snapshot_asset(
            target_project.id, receipt["target_target"]["subject_id"]
        )
        assert target.records == edited_records
        changed_source = literature_records.snapshot(source_target, source_revision)
        literature_records.commit(
            source_target,
            source_revision,
            EMPTY_RECORDS,
            changed_source.record_revision,
        )
        assert (
            project_records.snapshot_asset(
                target_project.id, receipt["target_target"]["subject_id"]
            ).records
            == edited_records
        )


def test_embedded_records_initialize_both_owners_without_overwriting_edits() -> None:
    root = Path(tempfile.mkdtemp())
    content_catalog = ContentCatalog(root / "content.sqlite3")
    content = ContentService(
        ProjectRegistry(str(root / "projects"), content_catalog),
        content_catalog,
        activities=Activities(),
    )
    project = content.create_project("Roundtrip")
    path = Path(content.resolve(project.id, "roundtrip.pdf"))
    original = _records()
    original["comments"] = [
        {
            "id": "comment",
            "mark_id": original["marks"][0]["id"],
            "body": "原始批注",
            "created_at": 1,
        }
    ]
    original["notes"] = [
        {
            "id": "note",
            "title": "笔记",
            "body": "正文",
            "excerpts": [
                {"id": "excerpt", "mark_id": original["marks"][0]["id"], "text": "引用", "page": 1}
            ],
        }
    ]
    with pdf_fixture.open() as document:
        document.new_page()
        document.embfile_add("scholarseed-annotations.json", json.dumps(original).encode())
        exported = document.tobytes()
    path.write_bytes(exported)
    project_store = PdfRecordStore(content, PdfRecordCatalog(content))
    imported = project_store.snapshot(project.id, "roundtrip.pdf")
    assert imported.records == decode_records(original)
    assert path.read_bytes() == exported
    edited = project_store.commit_asset(
        project.id,
        imported.record_target.subject_id,
        EMPTY_RECORDS,
        imported.record_revision,
        imported.source_revision,
    )
    assert (
        PdfRecordStore(content, PdfRecordCatalog(content))
        .snapshot(project.id, "roundtrip.pdf")
        .records
        == EMPTY_RECORDS
    )
    assert edited.record_revision != imported.record_revision

    files = root / "files"
    files.mkdir()
    repository = LiteratureRepository(root / "literature.sqlite3")
    repository.save(LiteratureItem(id="paper", title="Paper"))
    # 同一批字节在项目里已有一份, 文献侧再存自己独占的一份: 嵌入式批注从文献的
    # 副本里读出来, 项目那份文件从头到尾不被动。
    attachment = _stage_attachment(
        repository,
        files,
        "paper",
        path.name,
        exported,
        kind="pdf",
        media_type=PDF_MEDIA_TYPE,
    )
    app = FastAPI()
    with patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", files):
        register_reading_routes(
            app,
            repository,
            LiteratureAttachmentContent(repository),
            LiteraturePdf(repository),
            WorkbenchFormatPolicy(),
        )
        client = TestClient(app)
        route = f"/api/v1/literatures/paper/attachments/{attachment['id']}/records"
        response = client.get(route)
        assert response.status_code == 200, response.text
        assert response.json()["records"] == decode_records(original)
        assert client.get(route).json() == response.json()
        saved = client.put(
            route,
            headers={"If-Match": f'"{response.json()["record_revision"]}"'},
            json={
                "expected_source_revision": response.json()["source_revision"],
                "records": EMPTY_RECORDS,
            },
        )
        assert saved.status_code == 200, saved.text
        assert client.get(route).json()["records"] == EMPTY_RECORDS
    assert path.read_bytes() == exported


def test_invalid_embedded_records_initialize_an_empty_snapshot_without_blocking() -> None:
    root = Path(tempfile.mkdtemp())
    catalog = ContentCatalog(root / "content.sqlite3")
    content = ContentService(
        ProjectRegistry(str(root / "projects"), catalog), catalog, activities=Activities()
    )
    project = content.create_project("Invalid")
    store_catalog = PdfRecordCatalog(content)
    store = PdfRecordStore(content, store_catalog)
    for index, invalid in enumerate(
        (
            b"not json",
            b'{"schema_version":99}',
            b'{"schema_version":1,"marks":[],"comments":[{"id":"orphan","mark_id":"missing"}],"notes":[]}',
        )
    ):
        path = f"invalid-{index}.pdf"
        with pdf_fixture.open() as document:
            document.new_page()
            document.embfile_add("scholarseed-annotations.json", invalid)
            Path(content.resolve(project.id, path)).write_bytes(document.tobytes())
        binding = content.identify(project.id, path)
        snapshot = store.snapshot(project.id, path)
        assert snapshot.records == EMPTY_RECORDS
        assert store_catalog.get(project.id, binding.asset.asset_id) is not None


def run() -> None:
    test_embedded_records_initialize_both_owners_without_overwriting_edits()
    test_invalid_embedded_records_initialize_an_empty_snapshot_without_blocking()
    test_records_v1_is_canonical_and_source_bound()
    test_attachment_content_reads_managed_payload_once()
    test_attachment_records_are_isolated_and_cascade_with_owner()
    test_exact_attachment_routes_enforce_parent_media_and_two_revisions()
    test_startup_cutover_preserves_catalogue_and_removes_obsolete_records()
    test_explicit_copy_creates_independent_project_owner_and_optional_snapshot()


if __name__ == "__main__":
    run()
