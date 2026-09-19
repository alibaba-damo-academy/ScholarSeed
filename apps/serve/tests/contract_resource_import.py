"""Local resource import collision and versioned-replace contracts."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.resources import SnapshotState
from service.resources.api.routes import register_resource_routes
from service.resources.service.history import ResourceVersionService
from service.resources.service.importer import ResourceImportService
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

PASS = 0
FAIL = 0


class VersionSettings:
    def max_versions_per_file(self) -> int:
        return 50

    def max_version_file_size_kb(self) -> int:
        return 1024

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return ()

    def version_mode(self) -> str:
        return "whitelist"

    def version_migration_required(self) -> bool:
        return False

    def version_include_patterns(self) -> tuple[str, ...] | None:
        return None


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="resource-import-contract-"))
    try:
        workspace = root / "workspace"
        workspace.mkdir()
        sources = root / "sources"
        sources.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        project = registry.create("导入项目")
        content = ContentService(registry, catalog)
        settings = VersionSettings()
        formats = WorkbenchFormatPolicy()
        retention = ResourceRetentionService(content, settings)
        versions = ResourceVersionService(content, retention, formats, PdfRecordStore(content))
        supervisor = ResourceVersionSupervisor(content, versions, formats, settings)
        content.bind_resource_changes(supervisor)
        importer = ResourceImportService(content, versions, supervisor)
        app = FastAPI()
        app.state.content = content
        app.state.resource_versions = versions
        app.state.resource_version_supervisor = supervisor
        app.state.resource_importer = importer
        register_resource_routes(app)
        client = TestClient(app)

        ordinary_source = sources / "ordinary.md"
        ordinary_source.write_bytes(b"ordinary\n")
        ordinary = client.post(
            "/api/resource/import",
            json={"project": project.id, "mode": "copy", "sources": [str(ordinary_source)]},
        )
        ordinary_target = Path(project.root) / "resources" / ordinary_source.name
        ordinary_history = versions.history(project.id, "resources/ordinary.md")
        check(
            "non-conflicting COPY completes in one request and creates v1",
            ordinary.status_code == 200
            and ordinary.json().get("status") == "completed"
            and ordinary.json().get("project_id") == project.id
            and ordinary_target.read_bytes() == b"ordinary\n"
            and [item.sequence for item in ordinary_history] == [1],
            ordinary.text,
        )

        pdf_source = sources / "ordinary.pdf"
        pdf_source.write_bytes(b"%PDF-1.4\ninitial PDF bytes\n")
        pdf = client.post(
            "/api/resource/import",
            json={"project": project.id, "mode": "copy", "sources": [str(pdf_source)]},
        )
        pdf_path = "resources/ordinary.pdf"
        pdf_history = versions.history(project.id, pdf_path)
        pdf_capability = versions.capability(project.id, pdf_path)
        check(
            "PDF COPY creates a clean source-only initial v1",
            pdf.status_code == 200
            and pdf.json().get("status") == "completed"
            and [item.sequence for item in pdf_history] == [1]
            and pdf_history[0].annotation_object_id is None
            and pdf_capability.snapshot_state is SnapshotState.SAVED
            and pdf_capability.pending is None,
            pdf.text,
        )

        rename_source = sources / "rename.md"
        rename_source.write_bytes(b"incoming rename\n")
        rename_target = Path(project.root) / "resources" / rename_source.name
        rename_target.write_bytes(b"existing rename\n")
        rename_preview = client.post(
            "/api/resource/import",
            json={"project": project.id, "mode": "copy", "sources": [str(rename_source)]},
        )
        rename_body = rename_preview.json()
        rename_conflict = (rename_body.get("conflicts") or [{}])[0]
        check(
            "collision preview writes nothing and freezes the rename candidate",
            rename_preview.status_code == 200
            and rename_body.get("status") == "needs_resolution"
            and rename_target.read_bytes() == b"existing rename\n"
            and not (rename_target.parent / "rename (2).md").exists()
            and rename_conflict.get("suggested_name") == "rename (2).md",
            rename_preview.text,
        )
        rename_execute = client.post(
            "/api/resource/import",
            headers={"Idempotency-Key": "rename-import"},
            json={
                "project": project.id,
                "mode": "copy",
                "sources": [str(rename_source)],
                "plan_token": rename_body.get("plan_token"),
                "decisions": [{"source_index": 0, "action": "rename"}],
            },
        )
        renamed_target = rename_target.parent / "rename (2).md"
        check(
            "rename decision preserves the original and creates the frozen target",
            rename_execute.status_code == 200
            and rename_target.read_bytes() == b"existing rename\n"
            and renamed_target.read_bytes() == b"incoming rename\n"
            and [item.sequence for item in versions.history(project.id, "resources/rename (2).md")]
            == [1],
            rename_execute.text,
        )
        rename_replay = client.post(
            "/api/resource/import",
            headers={"Idempotency-Key": "rename-import"},
            json={
                "project": project.id,
                "mode": "copy",
                "sources": [str(rename_source)],
                "plan_token": rename_body.get("plan_token"),
                "decisions": [{"source_index": 0, "action": "rename"}],
            },
        )
        check(
            "rename confirmation replay returns the original result without a third name",
            rename_replay.status_code == 200
            and rename_replay.json().get("imported", [{}])[0].get("path")
            == "resources/rename (2).md"
            and not (rename_target.parent / "rename (3).md").exists(),
            rename_replay.text,
        )

        replace_source = sources / "replace.md"
        replace_source.write_bytes(b"incoming replacement\n")
        replace_target = Path(project.root) / "resources" / replace_source.name
        replace_target.write_bytes(b"recoverable original\n")
        replace_preview = client.post(
            "/api/resource/import",
            json={"project": project.id, "mode": "copy", "sources": [str(replace_source)]},
        )
        replace_body = replace_preview.json()
        replace_conflict = (replace_body.get("conflicts") or [{}])[0]
        check(
            "file collision advertises versioned replacement",
            replace_preview.status_code == 200
            and replace_conflict.get("can_replace_with_version") is True,
            replace_preview.text,
        )
        replace_request = {
            "project": project.id,
            "mode": "copy",
            "sources": [str(replace_source)],
            "plan_token": replace_body.get("plan_token"),
            "decisions": [{"source_index": 0, "action": "replace"}],
        }
        replaced = client.post(
            "/api/resource/import",
            headers={"Idempotency-Key": "replace-import"},
            json=replace_request,
        )
        replace_history = versions.history(project.id, "resources/replace.md")
        historical = [versions.read(project.id, item.id)[0] for item in replace_history]
        check(
            "replace preserves old bytes and appends the new bytes on one file identity",
            replaced.status_code == 200
            and replace_target.read_bytes() == b"incoming replacement\n"
            and [item.sequence for item in replace_history] == [2, 1]
            and len({item.file_id for item in replace_history}) == 1
            and historical == [b"incoming replacement\n", b"recoverable original\n"],
            replaced.text,
        )
        replaced_replay = client.post(
            "/api/resource/import",
            headers={"Idempotency-Key": "replace-import"},
            json=replace_request,
        )
        check(
            "replace replay is idempotent and does not append v3",
            replaced_replay.status_code == 200
            and len(versions.history(project.id, "resources/replace.md")) == 2,
            replaced_replay.text,
        )

        stale_source = sources / "stale.md"
        stale_source.write_bytes(b"stale incoming\n")
        stale_target = Path(project.root) / "resources" / stale_source.name
        stale_target.write_bytes(b"stale original\n")
        stale_preview = client.post(
            "/api/resource/import",
            json={"project": project.id, "mode": "copy", "sources": [str(stale_source)]},
        ).json()
        stale_target.write_bytes(b"newer user edit\n")
        stale_execute = client.post(
            "/api/resource/import",
            headers={"Idempotency-Key": "stale-import"},
            json={
                "project": project.id,
                "mode": "copy",
                "sources": [str(stale_source)],
                "plan_token": stale_preview.get("plan_token"),
                "decisions": [{"source_index": 0, "action": "replace"}],
            },
        )
        check(
            "target changes after preview are rejected without overwriting the newer bytes",
            stale_execute.status_code == 409
            and stale_execute.json().get("detail") == "import_plan_stale"
            and stale_target.read_bytes() == b"newer user edit\n",
            stale_execute.text,
        )

        source_stale = sources / "source-stale.md"
        source_stale.write_bytes(b"first source generation\n")
        source_stale_target = Path(project.root) / "resources" / source_stale.name
        source_stale_target.write_bytes(b"existing target\n")
        source_preview = client.post(
            "/api/resource/import",
            json={"project": project.id, "mode": "copy", "sources": [str(source_stale)]},
        ).json()
        source_stale.write_bytes(b"second source generation\n")
        source_execute = client.post(
            "/api/resource/import",
            headers={"Idempotency-Key": "source-stale-import"},
            json={
                "project": project.id,
                "mode": "copy",
                "sources": [str(source_stale)],
                "plan_token": source_preview.get("plan_token"),
                "decisions": [{"source_index": 0, "action": "replace"}],
            },
        )
        check(
            "source changes after preview invalidate the plan before target mutation",
            source_execute.status_code == 409
            and source_execute.json().get("detail") == "import_plan_stale"
            and source_stale_target.read_bytes() == b"existing target\n",
            source_execute.text,
        )

        batch_new = sources / "batch-new.md"
        batch_conflict = sources / "batch-conflict.md"
        batch_new.write_bytes(b"new item\n")
        batch_conflict.write_bytes(b"conflicting item\n")
        batch_existing = Path(project.root) / "resources" / batch_conflict.name
        batch_existing.write_bytes(b"existing item\n")
        batch_preview = client.post(
            "/api/resource/import",
            json={
                "project": project.id,
                "mode": "copy",
                "sources": [str(batch_new), str(batch_conflict)],
            },
        )
        check(
            "one collision keeps the entire first batch request read-only",
            batch_preview.status_code == 200
            and batch_preview.json().get("status") == "needs_resolution"
            and not (Path(project.root) / "resources" / batch_new.name).exists()
            and batch_existing.read_bytes() == b"existing item\n",
            batch_preview.text,
        )

        directory_source = sources / "dataset"
        directory_source.mkdir()
        (directory_source / "row.txt").write_bytes(b"row\n")
        directory_target = Path(project.root) / "resources" / directory_source.name
        directory_target.mkdir()
        (directory_target / "kept.txt").write_bytes(b"kept\n")
        directory_preview_response = client.post(
            "/api/resource/import",
            json={
                "project": project.id,
                "mode": "copy",
                "sources": [str(directory_source)],
            },
        )
        directory_preview = directory_preview_response.json()
        directory_conflict = (directory_preview.get("conflicts") or [{}])[0]
        directory_rename = client.post(
            "/api/resource/import",
            headers={"Idempotency-Key": "directory-import"},
            json={
                "project": project.id,
                "mode": "copy",
                "sources": [str(directory_source)],
                "plan_token": directory_preview.get("plan_token"),
                "decisions": [{"source_index": 0, "action": "rename"}],
            },
        )
        check(
            "directory collisions only allow an exact renamed tree copy",
            directory_conflict.get("can_replace_with_version") is False
            and directory_rename.status_code == 200
            and (directory_target / "kept.txt").read_bytes() == b"kept\n"
            and (directory_target.parent / "dataset (2)" / "row.txt").read_bytes() == b"row\n",
            directory_rename.text,
        )

        unsupported_source = sources / "unsupported.bin"
        unsupported_source.write_bytes(b"new binary")
        unsupported_target = Path(project.root) / "resources" / unsupported_source.name
        unsupported_target.write_bytes(b"old binary")
        unsupported_preview = client.post(
            "/api/resource/import",
            json={
                "project": project.id,
                "mode": "copy",
                "sources": [str(unsupported_source)],
            },
        ).json()
        unsupported_replace = client.post(
            "/api/resource/import",
            headers={"Idempotency-Key": "unsupported-import"},
            json={
                "project": project.id,
                "mode": "copy",
                "sources": [str(unsupported_source)],
                "plan_token": unsupported_preview.get("plan_token"),
                "decisions": [{"source_index": 0, "action": "replace"}],
            },
        )
        check(
            "unsupported target cannot be forced through the versioned replace branch",
            unsupported_preview.get("conflicts", [{}])[0].get("can_replace_with_version") is False
            and unsupported_replace.status_code == 409
            and unsupported_replace.json().get("detail") == "replace_not_supported"
            and unsupported_target.read_bytes() == b"old binary",
            unsupported_replace.text,
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print(f"\nresult: {PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
