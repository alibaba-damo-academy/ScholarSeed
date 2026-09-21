"""Real file-backed payload import, nested roots, revision and retry contracts."""

from __future__ import annotations

import base64
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.serve.tests import pdf as pdf_fixture
from apps.serve.tests.contract_pdf_records import _records
from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.literature.api.reading import register_reading_routes
from service.literature.persistence import files as literature_files
from service.literature.persistence.reading import AttachmentRecordCatalog
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import (
    PDF_MEDIA_TYPE,
    PNG_MEDIA_TYPE,
    AttachmentRole,
    LiteratureItem,
)
from service.literature.service.attachment import LiteratureAttachmentContent
from service.literature.service.pdf import LiteraturePdf
from service.literature.service.records import AttachmentRecords
from service.platform.content import RootKind
from service.platform.records import EMPTY_RECORDS, RecordOwner, RecordTarget
from service.platform.resources import VersionOrigin, VersionPolicyMode
from service.resources.service.history import ResourceVersionService
from service.resources.service.importer import ResourceImportError, ResourceImportService
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class Settings:
    def max_versions_per_file(self) -> int:
        return 50

    def max_version_file_size_kb(self) -> int:
        return 1024

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return ()

    def version_mode(self) -> VersionPolicyMode:
        return VersionPolicyMode.WHITELIST

    def version_migration_required(self) -> bool:
        return False

    def version_include_patterns(self) -> tuple[str, ...] | None:
        return None


def run() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "catalog.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        project = registry.create("Import")
        content = ContentService(registry, catalog)
        settings = Settings()
        formats = WorkbenchFormatPolicy()
        versions = ResourceVersionService(
            content, ResourceRetentionService(content, settings), formats, PdfRecordStore(content)
        )
        supervisor = ResourceVersionSupervisor(content, versions, formats, settings)
        content.bind_resource_changes(supervisor)
        importer = ResourceImportService(content, versions, supervisor)
        resource_root = content.root(project.id, RootKind.RESOURCES).path
        folder = content.ensure_directory(project.id, resource_root, "Papers").path
        source = b"%PDF-1.4\nsource"
        preview = importer.preview_payload(project.id, folder, "new.pdf", source)
        target = Path(project.root) / preview.path
        assert not target.exists(), "preflight must not create the target"
        created = importer.import_payload(
            project.id, folder, "new.pdf", source, preview.token, "create"
        )
        assert created.path == f"{folder}/new.pdf"
        assert target.read_bytes() == source
        history_count = len(versions.history(project.id, created.path))
        replay = importer.import_payload(
            project.id, folder, "new.pdf", source, preview.token, "create"
        )
        assert replay.path == created.path
        assert len(versions.history(project.id, created.path)) == history_count
        image_preview = importer.preview_payload(project.id, folder, "figure.png", PNG)
        image = importer.import_payload(
            project.id,
            folder,
            "figure.png",
            PNG,
            image_preview.token,
            "create-image",
        )
        assert Path(content.resolve(project.id, image.path)).read_bytes() == PNG
        assert versions.history(project.id, image.path) == ()
        importer.finish_payload(project.id, image.path, image.revision)
        image_retry = importer.import_payload(
            project.id,
            folder,
            "figure.png",
            PNG,
            image_preview.token,
            "create-image",
        )
        assert image_retry == image
        assert versions.history(project.id, image.path) == ()
        conflict = importer.preview_payload(project.id, folder, "new.pdf", source)
        assert conflict.conflict and conflict.suggested_name == "new (2).pdf"
        try:
            importer.import_payload(
                project.id, folder, "new.pdf", source, conflict.token, "conflict"
            )
        except ResourceImportError as error:
            assert error.code == "name_exists"
        else:
            raise AssertionError("conflicting create overwrote target")
        replacement = b"%PDF-1.4\nreplacement"
        preview = importer.preview_payload(
            project.id, folder, "different.pdf", replacement, replace_path=created.path
        )
        replaced = importer.import_payload(
            project.id,
            folder,
            "different.pdf",
            replacement,
            preview.token,
            "replace",
            replace_path=created.path,
        )
        assert replaced.path == created.path
        assert target.read_bytes() == replacement
        history = versions.history(project.id, created.path)
        assert len(history) > history_count
        assert versions.read(project.id, history[-1].id)[0] == source
        importer.import_payload(
            project.id,
            folder,
            "different.pdf",
            replacement,
            preview.token,
            "replace",
            replace_path=created.path,
        )
        assert len(versions.history(project.id, created.path)) == len(history)
        stale = importer.preview_payload(
            project.id, folder, "new.pdf", source, replace_path=created.path
        )
        versions.commit_working(
            project.id, created.path, b"%PDF-1.4\nother", replaced.revision, "other"
        )
        try:
            importer.import_payload(
                project.id,
                folder,
                "new.pdf",
                source,
                stale.token,
                "stale",
                replace_path=created.path,
            )
        except ResourceImportError as error:
            assert error.code == "import_plan_stale"
        else:
            raise AssertionError("stale plan overwrote a newer file")
        external = root / "external.pdf"
        external.write_bytes(source)
        linked = content.authorize_root_at(project.id, str(external), folder, "linked.pdf")
        assert linked.mount_path == f"{folder}/linked.pdf"
        assert content.read_bytes(project.id, linked.mount_path)[0] == source
        assert not (Path(project.root) / linked.mount_path).exists()
        content.revoke_root(linked.root_id)
        assert external.read_bytes() == source
        for name in ("../escape.pdf", "a/b.pdf", "C:\\escape.pdf"):
            try:
                content.authorize_root_at(project.id, str(external), folder, name)
            except ContentError:
                pass
            else:
                raise AssertionError("invalid mount admitted")
        embedded_records = _records()
        embedded_records["marks"][0]["color"] = "purple"
        with pdf_fixture.open() as document:
            document.new_page()
            document.embfile_add(
                "scholarseed-annotations.json", json.dumps(embedded_records).encode()
            )
            source = document.tobytes()
        files = root / "files"
        files.mkdir()
        # 附件只认文献托管目录, 这里把它 pin 到临时目录 (真实 home 一律不碰)。
        with patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", files):
            repository = LiteratureRepository(root / "literature.sqlite3")
            repository.save(LiteratureItem(id="paper", title="Paper"))
            published = literature_files.managed_object("paper", source, ".pdf")
            (files / published.name).write_bytes(source)
            attachment = repository.add_attachment(
                "paper",
                "source.pdf",
                str(files / published.name),
                kind="pdf",
                revision=published.revision,
                role=AttachmentRole.PRIMARY,
                media_type=PDF_MEDIA_TYPE,
            )
            pdf = LiteraturePdf(repository)
            record_store = PdfRecordStore(
                content,
                shared_records=AttachmentRecords(
                    LiteratureAttachmentContent(repository), repository
                ),
            )
            source_catalog = AttachmentRecordCatalog(repository.database)
            source_target = RecordTarget(
                RecordOwner.LITERATURE_ATTACHMENT, "paper", attachment["id"]
            )
            assert (
                AttachmentRecords(LiteratureAttachmentContent(repository), repository)
                .snapshot_target(source_target)
                .records
                == embedded_records
            )
            empty = source_catalog.snapshot(source_target, content.revision(source))
            source_catalog.commit(
                source_target, content.revision(source), _records(), empty.record_revision
            )
            app = FastAPI()
            app.state.content = content
            app.state.pdf_records = record_store
            app.state.resource_importer = importer
            app.state.resource_version_supervisor = supervisor
            register_reading_routes(
                app, repository, LiteratureAttachmentContent(repository), pdf, formats
            )
            client = TestClient(app)
            route = f"/api/v1/literatures/paper/attachments/{attachment['id']}/import-to-project"
            body = {
                "project": project.id,
                "parent": folder,
                "name": "api.pdf",
                "copy_records": True,
            }
            prepared = client.post(route, json=body)
            assert prepared.status_code == 200, prepared.text
            frozen = prepared.json()
            assert not Path(content.resolve(project.id, frozen["path"])).exists()
            commit = {
                **body,
                "preview": False,
                "token": frozen["token"],
                "source_record_revision": frozen["source_record_revision"],
            }
            missing_key = client.post(route, json=commit)
            assert missing_key.status_code == 400
            copied = client.post(route, json=commit, headers={"Idempotency-Key": "api-copy"})
            assert copied.status_code == 200, copied.text
            asset = content.identify(project.id, copied.json()["path"]).asset.asset_id
            assert record_store.snapshot_asset(project.id, asset).records == _records()
            count = len(versions.history(project.id, copied.json()["path"]))
            retry = client.post(route, json=commit, headers={"Idempotency-Key": "api-copy"})
            assert retry.status_code == 200, retry.text
            assert len(versions.history(project.id, copied.json()["path"])) == count
            replacement_source = b"%PDF-1.4\nnew-generation"
            Path(attachment["path"]).write_bytes(replacement_source)
            body = {
                "project": project.id,
                "parent": folder,
                "name": "other.pdf",
                "replace_path": copied.json()["path"],
                "copy_records": False,
            }
            frozen = client.post(route, json=body).json()
            replaced = client.post(
                route,
                json={
                    **body,
                    "preview": False,
                    "token": frozen["token"],
                    "target_record_revision": frozen["target_record_revision"],
                },
                headers={"Idempotency-Key": "api-preserve"},
            )
            assert replaced.status_code == 200, replaced.text
            preserved = record_store.snapshot_asset(project.id, asset)
            assert preserved.records["marks"][0]["anchor_state"] == "stale"
            assert preserved.records["comments"] == _records()["comments"]
            forbidden = client.post(route, json={**body, "copy_records": True})
            assert forbidden.status_code == 422, "record replacement needs separate confirmation"
            record_store.commit_asset(
                project.id,
                asset,
                EMPTY_RECORDS,
                preserved.record_revision,
                content.revision(replacement_source),
            )
            importer.finish_payload(
                project.id, copied.json()["path"], content.revision(replacement_source)
            )
            source_snapshot = source_catalog.snapshot(
                source_target, content.revision(replacement_source)
            )
            body = {**body, "copy_records": True, "replace_records": True}
            frozen = client.post(route, json=body).json()
            execution = {
                **body,
                "preview": False,
                "token": frozen["token"],
                "source_record_revision": frozen["source_record_revision"],
                "target_record_revision": frozen["target_record_revision"],
            }
            copied_records = client.post(
                route, json=execution, headers={"Idempotency-Key": "api-replace-records"}
            )
            assert copied_records.status_code == 200, copied_records.text
            assert record_store.snapshot_asset(project.id, asset).records == source_snapshot.records
            repeated_records = client.post(
                route, json=execution, headers={"Idempotency-Key": "api-replace-records"}
            )
            assert repeated_records.status_code == 200, repeated_records.text
            assert (
                record_store.snapshot_asset(project.id, asset).record_target.owner
                is RecordOwner.PROJECT_ASSET
            )
            del app.state.pdf_records
            png_published = literature_files.managed_object("paper", PNG, ".png")
            (files / png_published.name).write_bytes(PNG)
            png_attachment = repository.add_attachment(
                "paper",
                "source.png",
                str(files / png_published.name),
                kind="image",
                revision=png_published.revision,
                media_type=PNG_MEDIA_TYPE,
            )
            png_route = (
                f"/api/v1/literatures/paper/attachments/{png_attachment['id']}" "/import-to-project"
            )
            png_body = {
                "project": project.id,
                "parent": folder,
                "name": "api-image.png",
            }
            png_preflight = client.post(png_route, json=png_body)
            assert png_preflight.status_code == 200, png_preflight.text
            png_import = client.post(
                png_route,
                json={
                    **png_body,
                    "preview": False,
                    "token": png_preflight.json()["token"],
                },
                headers={"Idempotency-Key": "api-image"},
            )
            assert png_import.status_code == 200, png_import.text
            assert content.read_bytes(project.id, png_import.json()["path"])[0] == PNG
            assert versions.history(project.id, png_import.json()["path"]) == ()
            png_retry = client.post(
                png_route,
                json={
                    **png_body,
                    "preview": False,
                    "token": png_preflight.json()["token"],
                },
                headers={"Idempotency-Key": "api-image"},
            )
            assert png_retry.status_code == 200, png_retry.text
            unsupported_records = client.post(
                png_route, json={**png_body, "name": "records.png", "copy_records": True}
            )
            assert unsupported_records.status_code == 409, unsupported_records.text
            assert unsupported_records.json()["detail"]["code"] == "attachment_records_unsupported"
            print("PASS generic payload and attachment API, PDF annotations, revisions and retry")


if __name__ == "__main__":
    run()
