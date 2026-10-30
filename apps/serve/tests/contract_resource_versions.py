"""Resource version ledger contracts; directory-command HTTP composition is tested separately."""

from __future__ import annotations

import shutil
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE, PROJECT_VERSIONS_RELATIVE
from service.platform.activity import Activities
from service.platform.resources import (
    VERSION_MAX_BYTES,
    ResourceVersionReadError,
    RestorePolicy,
    VersionOrigin,
    VersionPolicyMode,
)
from service.resources.api.routes import register_resource_routes
from service.resources.api.versions import register_version_routes
from service.resources.domain.jobs import VersionInitializationProgress
from service.resources.domain.version import DiskObservation, ObservationState
from service.resources.persistence.version import InitialVersionPlan, VersionStore
from service.resources.service.activation import ResourceActivation
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.api.routes import register_workbench_routes
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

from .records import pdf_records

PASS = 0
FAIL = 0


class SimulatedProcessExit(BaseException):
    """Abrupt test-only exit after durable file application."""


class VersionSettings:
    mode = VersionPolicyMode.WHITELIST.value
    ignores: tuple[str, ...] = ()

    def version_mode(self) -> str:
        return self.mode

    def version_migration_required(self) -> bool:
        return False

    def max_versions_per_file(self) -> int:
        return 50

    def max_version_file_size_kb(self) -> int:
        return 1024

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return self.ignores

    def version_include_patterns(self) -> tuple[str, ...]:
        return WorkbenchFormatPolicy().version_patterns()


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="resource-version-ledger-"))
    try:
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        content = ContentService(registry, catalog, activities=Activities())
        project = registry.create("版本项目")
        target = Path(project.root) / "resources" / "notes.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"v1\n")
        settings = VersionSettings()
        formats = WorkbenchFormatPolicy()
        retention = ResourceRetentionService(content, settings)
        annotations = PdfRecordStore(content)
        versions = ResourceVersionService(content, retention, formats, annotations)
        supervisor = ResourceVersionSupervisor(
            content, versions, formats, settings, activities=Activities()
        )
        versions.bind_admission_policy(supervisor)
        recovery = ResourceRecoveryService(content, retention, annotations)
        deliveries = ResourceDeliveryService(
            content, versions, supervisor, activities=supervisor._activities
        )
        supervisor.bind_preparation(
            ResourceActivation(
                content,
                recovery,
                versions,
                deliveries,
                retention,
                ResourceReviewMigration(content, versions),
            )
        )
        app = FastAPI()
        app.state.content = content
        app.state.resource_versions = versions
        app.state.resource_recovery = recovery
        app.state.resource_version_supervisor = supervisor
        register_resource_routes(app)
        register_version_routes(app)
        register_workbench_routes(app)
        client = TestClient(app)

        first = versions.ensure_initial(project.id, "resources/notes.md")
        if first.version.object_id is None:
            raise AssertionError("present version requires an object identity")
        first_revision = first.version.object_id
        check("first managed snapshot creates v1", first.version.sequence == 1)
        check(
            "initial version records its source", first.version.origin is VersionOrigin.INITIAL_SCAN
        )
        check("initial seal is not unchanged", not first.unchanged)

        repeated = versions.ensure_initial(project.id, "resources/notes.md")
        check("repeated initial discovery is idempotent", repeated.unchanged)
        check(
            "repeated discovery returns the same version", repeated.version.id == first.version.id
        )

        target.write_bytes(b"external v2\n")
        second = versions.seal(project.id, "resources/notes.md", VersionOrigin.EXTERNAL_CONFIRMED)
        check("confirmed external bytes append v2", second.version.sequence == 2)
        check(
            "v2 points at a different object", second.version.object_id != first.version.object_id
        )

        unchanged = versions.seal(project.id, "resources/notes.md", VersionOrigin.USER)
        check("explicit save of unchanged bytes does not append a duplicate", unchanged.unchanged)
        history = versions.history(project.id, "resources/notes.md")
        check("history is newest first", [item.sequence for item in history] == [2, 1])
        check("one stable file keeps one file_id", len({item.file_id for item in history}) == 1)

        pair = versions.read_pair(project.id, first.version.id, second.version.id)
        check(
            "pair retains immutable version identities",
            pair.before.version == first.version and pair.after.version == second.version,
        )
        check(
            "pair reads exact historical bytes",
            pair.before.content == b"v1\n" and pair.after.content == b"external v2\n",
        )
        check(
            "revision lookup reads retained historical bytes",
            versions.read_revision(
                project.id,
                "resources/notes.md",
                first_revision,
            )
            == b"v1\n",
        )
        check(
            "revision lookup does not cross path identity",
            versions.read_revision(project.id, "resources/other.md", first_revision) is None,
        )
        check(
            "pair includes media types",
            pair.before.media_type == pair.after.media_type and bool(pair.before.media_type),
        )
        for before_id, after_id, expected in (
            (second.version.id, first.version.id, "version_order_invalid"),
            (first.version.id, first.version.id, "version_order_invalid"),
            ("missing-version", second.version.id, "version_not_found"),
            (first.version.id, "missing-version", "version_not_found"),
        ):
            try:
                versions.read_pair(project.id, before_id, after_id)
            except ResourceVersionReadError as exc:
                check(f"pair rejects {expected}", exc.code == expected)
            else:
                check(f"pair rejects {expected}", False)

        tree_response = client.get("/api/resource/tree", params={"project": project.id})
        tree_nodes = tree_response.json().get("nodes", [])
        notes_node = next(
            (node for node in tree_nodes if node.get("path") == "resources/notes.md"), None
        )
        check(
            "resource tree projects managed version state without exposing identity",
            tree_response.status_code == 200
            and notes_node is not None
            and notes_node.get("version")
            == {
                "management_state": "managed",
                "manual_admitted": False,
                "drifted": False,
                "snapshot_state": "saved",
                "pending_origin": None,
                "needs_review": False,
            },
            tree_response.text,
        )
        check(
            "resource tree awaits project activation before reading files",
            project.id in supervisor._prepared,
        )

        target.write_bytes(b"tree drift\n")
        supervisor.observe_path(project.id, "resources/notes.md")
        drift_tree = client.get("/api/resource/tree", params={"project": project.id}).json()
        drift_node = next(
            (
                node
                for node in drift_tree.get("nodes", [])
                if node.get("path") == "resources/notes.md"
            ),
            None,
        )
        check(
            "resource tree reflects adopted external pending without creating a version",
            drift_node is not None
            and drift_node.get("version", {}).get("drifted") is False
            and drift_node["version"]["snapshot_state"] == "pending"
            and drift_node["version"]["pending_origin"] == "external"
            and drift_node["version"]["needs_review"] is False
            and versions.capability(project.id, "resources/notes.md").pending.origin.value
            == "external"
            and len(versions.history(project.id, "resources/notes.md")) == 2,
            str(drift_tree),
        )

        (target.parent / ".gitignore").write_text("notes.md\n", encoding="utf-8")
        ignored_tree = client.get("/api/resource/tree", params={"project": project.id}).json()
        ignored_node = next(
            (
                node
                for node in ignored_tree.get("nodes", [])
                if node.get("path") == "resources/notes.md"
            ),
            None,
        )
        check(
            "resource tree ignores Git rules while preserving pending history",
            ignored_node is not None
            and ignored_node.get("version")
            == {
                "management_state": "managed",
                "manual_admitted": False,
                "drifted": False,
                "snapshot_state": "pending",
                "pending_origin": "external",
                "needs_review": False,
            }
            and len(versions.history(project.id, "resources/notes.md")) == 2,
            str(ignored_tree),
        )
        (target.parent / ".gitignore").unlink()
        target.write_bytes(b"external v2\n")
        supervisor.capability(project.id, "resources/notes.md")

        database = Path(content.resolve(project.id, PROJECT_DB_RELATIVE))
        cas_root = Path(content.resolve(project.id, PROJECT_VERSIONS_RELATIVE))
        check(
            "ledger is project-local", database.is_file() and database.is_relative_to(project.root)
        )
        check("CAS is project-local", cas_root.is_dir() and cas_root.is_relative_to(project.root))

        connection = sqlite3.connect(database)
        try:
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'resources_%'"
                )
            }
            version_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(resources_versions)")
            }
            object_rows = connection.execute(
                "SELECT object_id, layout FROM resources_objects"
            ).fetchall()
        finally:
            connection.close()
        check(
            "ledger creates owner-prefixed core tables",
            {
                "resources_files",
                "resources_file_paths",
                "resources_objects",
                "resources_observations",
                "resources_heads",
                "resources_operations",
                "resources_versions",
            }
            <= tables,
            str(sorted(tables)),
        )
        check(
            "Version schema stores object_id but not CAS layout",
            "object_id" in version_columns and "layout" not in version_columns,
        )
        check(
            "physical layout stays in resources_objects including unsealed snapshots",
            {row[0] for row in object_rows}
            == {
                first.version.object_id,
                second.version.object_id,
                content.revision(b"tree drift\n"),
            }
            and all(row[1] for row in object_rows),
        )

        capability_response = client.get(
            "/api/resource/capability",
            params={"project": project.id, "path": "resources/notes.md"},
        )
        capability = capability_response.json()
        check(
            "capability API projects the live managed state",
            capability_response.status_code == 200
            and capability.get("management_state") == "managed"
            and capability.get("can_version") is True,
            capability_response.text,
        )
        response = client.get(
            f"/api/resource/files/{capability['file_id']}/versions",
            params={"project": project.id},
        )
        response_versions = response.json().get("versions", [])
        check(
            "history API exposes versions without physical layout",
            response.status_code == 200
            and [item["sequence"] for item in response_versions] == [2, 1]
            and all("layout" not in item and "codec" not in item for item in response_versions),
            response.text,
        )
        seal_payload = {
            "path": "resources/notes.md",
            "expected_disk_revision": capability["working_revision"],
            "expected_version_id": capability["version_id"],
            "expected_pending_revision": None,
        }
        missing_seal_key = client.post(
            f"/api/resource/files/{capability['file_id']}/versions",
            params={"project": project.id},
            json=seal_payload,
        )
        check(
            "mutating Version POST requires an idempotency key",
            missing_seal_key.status_code == 400
            and missing_seal_key.json().get("error", {}).get("code") == "idempotency_key_required",
            missing_seal_key.text,
        )
        sealed = client.post(
            f"/api/resource/files/{capability['file_id']}/versions",
            params={"project": project.id},
            headers={"Idempotency-Key": "seal-unchanged"},
            json=seal_payload,
        )
        check(
            "explicit version API reports unchanged instead of duplicating content",
            sealed.status_code == 200 and sealed.json().get("unchanged") is True,
            sealed.text,
        )
        content_response = client.get(
            f"/api/resource/versions/{first.version.id}/content",
            params={"project": project.id},
        )
        check(
            "version content API returns original complete bytes",
            content_response.status_code == 200 and content_response.content == b"v1\n",
            f"status={content_response.status_code} body={content_response.content!r}",
        )
        detail_response = client.get(
            f"/api/resource/versions/{first.version.id}",
            params={"project": project.id},
        )
        check(
            "version detail API resolves one stable version id",
            detail_response.status_code == 200 and detail_response.json().get("sequence") == 1,
            detail_response.text,
        )
        head_response = client.head(
            f"/api/resource/versions/{first.version.id}/content",
            params={"project": project.id},
        )
        range_response = client.get(
            f"/api/resource/versions/{first.version.id}/content",
            params={"project": project.id},
            headers={"Range": "bytes=0-1"},
        )
        check(
            "version content supports HEAD and byte ranges",
            head_response.status_code == 200
            and head_response.headers.get("content-length") == "3"
            and head_response.headers.get("accept-ranges") == "bytes"
            and range_response.status_code == 206
            and range_response.content == b"v1"
            and range_response.headers.get("content-range") == "bytes 0-1/3",
        )

        copy_response = client.post(
            "/api/workbench/managed-copy",
            params={"project": project.id, "name": "notes.md"},
            headers={
                "Content-Type": "application/octet-stream",
                "Idempotency-Key": "both-changed-copy",
            },
            content=b"memory side preserved\n",
        )
        copied = copy_response.json()
        copied_path = copied.get("path", "")
        app.state.resource_versions = ResourceVersionService(
            content, retention, formats, annotations
        )
        rebuilt_supervisor = ResourceVersionSupervisor(
            content,
            app.state.resource_versions,
            formats,
            settings,
            activities=Activities(),
        )
        rebuilt_supervisor.bind_preparation(
            ResourceActivation(
                content,
                recovery,
                app.state.resource_versions,
                deliveries,
                retention,
                ResourceReviewMigration(content, app.state.resource_versions),
            )
        )
        app.state.resource_version_supervisor = rebuilt_supervisor
        copied_replay = client.post(
            "/api/workbench/managed-copy",
            params={"project": project.id, "name": "notes.md"},
            headers={
                "Content-Type": "application/octet-stream",
                "Idempotency-Key": "both-changed-copy",
            },
            content=b"memory side preserved\n",
        )
        copied_conflict = client.post(
            "/api/workbench/managed-copy",
            params={"project": project.id, "name": "notes.md"},
            headers={
                "Content-Type": "application/octet-stream",
                "Idempotency-Key": "both-changed-copy",
            },
            content=b"different memory bytes\n",
        )
        copied_name_conflict = client.post(
            "/api/workbench/managed-copy",
            params={"project": project.id, "name": "renamed.md"},
            headers={
                "Content-Type": "application/octet-stream",
                "Idempotency-Key": "both-changed-copy",
            },
            content=b"memory side preserved\n",
        )
        copied_history = versions.history(project.id, copied_path) if copied_path else ()
        check(
            "BOTH_CHANGED managed copy preserves disk and creates one complete v1",
            copy_response.status_code == 200
            and copied_path == "resources/notes (2).md"
            and target.read_bytes() == b"external v2\n"
            and (Path(project.root) / copied_path).read_bytes() == b"memory side preserved\n"
            and len(copied_history) == 1
            and copied_history[0].sequence == 1
            and versions.read(project.id, copied_history[0].id)[0] == b"memory side preserved\n"
            and copied_replay.json() == copied
            and copied_conflict.status_code == 409
            and copied_name_conflict.status_code == 409,
            f"copy_status={copy_response.status_code} copy={copy_response.text} "
            f"replay_status={copied_replay.status_code} replay={copied_replay.text} "
            f"conflict_status={copied_conflict.status_code} conflict={copied_conflict.text} "
            f"name_conflict_status={copied_name_conflict.status_code} "
            f"name_conflict={copied_name_conflict.text} "
            f"disk={target.read_bytes()!r} copied_bytes={(Path(project.root) / copied_path).read_bytes()!r} "
            f"history={copied_history!r}",
        )
        diff_response = client.get(
            f"/api/resource/versions/{first.version.id}/diff",
            params={"project": project.id, "base_version_id": second.version.id},
        )
        check(
            "text version API returns a server-side line diff",
            diff_response.status_code == 200
            and any("external v2" in line for line in diff_response.json().get("lines", [])),
            diff_response.text,
        )

        target.write_bytes(b"unarchived external bytes\n")
        preview = client.post(
            f"/api/resource/versions/{first.version.id}/restore/preview",
            params={"project": project.id},
            json={},
        )
        token = preview.json().get("preflight_token")
        check(
            "restore preview reports a newer disk conflict without writing",
            preview.status_code == 200
            and preview.json().get("conflict") is True
            and target.read_bytes() == b"unarchived external bytes\n"
            and bool(token),
            preview.text,
        )
        missing_restore_key = client.post(
            f"/api/resource/versions/{first.version.id}/restore",
            params={"project": project.id},
            json={"policy": RestorePolicy.STRICT.value, "preflight_token": token},
        )
        check(
            "single restore requires an idempotency key",
            missing_restore_key.status_code == 400
            and missing_restore_key.json().get("error", {}).get("code")
            == "idempotency_key_required",
            missing_restore_key.text,
        )
        strict = client.post(
            f"/api/resource/versions/{first.version.id}/restore",
            params={"project": project.id},
            headers={"Idempotency-Key": "restore-v1-strict"},
            json={"policy": RestorePolicy.STRICT.value, "preflight_token": token},
        )
        check(
            "strict restore rejects the whole operation on conflict",
            strict.status_code == 409 and target.read_bytes() == b"unarchived external bytes\n",
            strict.text,
        )
        forced = client.post(
            f"/api/resource/versions/{first.version.id}/restore",
            params={"project": project.id},
            headers={"Idempotency-Key": "restore-v1-force"},
            json={"policy": RestorePolicy.FORCE.value, "preflight_token": token},
        )
        forced_version = forced.json().get("version", {})
        check(
            "forced restore writes source bytes and appends a new version",
            forced.status_code == 200
            and target.read_bytes() == b"v1\n"
            and forced_version.get("sequence") == 3
            and forced_version.get("origin") == VersionOrigin.RESTORE.value
            and forced_version.get("restored_from_id") == first.version.id,
            forced.text,
        )
        app.state.resource_recovery = ResourceRecoveryService(content, retention, annotations)
        with patch.object(
            content,
            "stable_snapshot",
            side_effect=AssertionError("a committed restore replay must not read current disk"),
        ):
            forced_replay = client.post(
                f"/api/resource/versions/{first.version.id}/restore",
                params={"project": project.id},
                headers={"Idempotency-Key": "restore-v1-force"},
                json={"policy": RestorePolicy.FORCE.value, "preflight_token": token},
            )
        check(
            "single restore replay survives service reconstruction without another version",
            forced_replay.status_code == 200
            and forced_replay.json() == forced.json()
            and len(versions.history(project.id, "resources/notes.md")) == 3,
            forced_replay.text,
        )
        restored_tree = client.get("/api/resource/tree", params={"project": project.id}).json()
        restored_node = next(
            (
                node
                for node in restored_tree.get("nodes", [])
                if node.get("path") == "resources/notes.md"
            ),
            None,
        )
        check(
            "accepted restore clears the superseded external drift projection",
            restored_node is not None and restored_node.get("version", {}).get("drifted") is False,
            str(restored_tree),
        )
        check(
            "single-file restore does not create a Delivery",
            "delivery_id" not in forced.json(),
            forced.text,
        )

        target.write_bytes(b"externally accepted\n")
        external_capability = client.get(
            "/api/resource/capability",
            params={"project": project.id, "path": "resources/notes.md"},
        ).json()
        check(
            "capability adopts stable external bytes as pending without sealing",
            external_capability.get("disk_revision")
            == content.snapshot(project.id, "resources/notes.md").revision
            and external_capability.get("working_revision")
            == external_capability.get("disk_revision")
            and external_capability.get("snapshot_state") == "pending"
            and external_capability.get("pending", {}).get("origin") == "external",
            str(external_capability),
        )
        external = client.post(
            f"/api/resource/files/{capability['file_id']}/versions",
            params={"project": project.id},
            headers={"Idempotency-Key": "seal-external-v4"},
            json={
                "path": "resources/notes.md",
                "origin": VersionOrigin.EXTERNAL_CONFIRMED.value,
                "expected_disk_revision": external_capability.get("disk_revision"),
                "expected_version_id": forced_version.get("id"),
                "expected_pending_revision": external_capability["pending"]["revision"],
            },
        )
        check(
            "external bytes become a version only after explicit confirmation",
            external.status_code == 200
            and external.json().get("version", {}).get("origin")
            == VersionOrigin.EXTERNAL_CONFIRMED.value
            and external.json().get("version", {}).get("sequence") == 4,
            external.text,
        )
        versions = ResourceVersionService(content, retention, formats, annotations)
        supervisor = ResourceVersionSupervisor(
            content, versions, formats, settings, activities=Activities()
        )
        app.state.resource_versions = versions
        app.state.resource_version_supervisor = supervisor
        with patch.object(
            content,
            "stable_snapshot",
            side_effect=AssertionError("a committed replay must not read current disk"),
        ):
            external_replay = client.post(
                f"/api/resource/files/{capability['file_id']}/versions",
                params={"project": project.id},
                headers={"Idempotency-Key": "seal-external-v4"},
                json={
                    "path": "resources/notes.md",
                    "origin": VersionOrigin.EXTERNAL_CONFIRMED.value,
                    "expected_disk_revision": external_capability.get("disk_revision"),
                    "expected_version_id": forced_version.get("id"),
                    "expected_pending_revision": external_capability["pending"]["revision"],
                },
            )
        external_conflict = client.post(
            f"/api/resource/files/{capability['file_id']}/versions",
            params={"project": project.id},
            headers={"Idempotency-Key": "seal-external-v4"},
            json={
                "path": "resources/notes.md",
                "origin": VersionOrigin.USER.value,
                "expected_disk_revision": external_capability.get("disk_revision"),
                "expected_version_id": forced_version.get("id"),
                "expected_pending_revision": external_capability["pending"]["revision"],
            },
        )
        check(
            "seal replay returns its durable receipt and rejects key reuse",
            external_replay.status_code == 200
            and external_replay.json() == external.json()
            and external_conflict.status_code == 409
            and external_conflict.json().get("error", {}).get("code") == "idempotency_conflict"
            and len(versions.history(project.id, "resources/notes.md")) == 4,
            f"replay={external_replay.text} conflict={external_conflict.text}",
        )

        ignored_path = "resources/ignored.md"
        ignored_target = Path(project.root) / ignored_path
        ignored_target.write_text("kept history\n", encoding="utf-8")
        ignored_v1 = versions.ensure_initial(project.id, ignored_path).version
        settings.mode = VersionPolicyMode.BLACKLIST.value
        settings.ignores = ("ignored.md",)
        ignored_capability = client.get(
            "/api/resource/capability",
            params={"project": project.id, "path": ignored_path},
        )
        ignored_payload = ignored_capability.json()
        rejected = client.post(
            f"/api/resource/files/{ignored_v1.file_id}/versions",
            params={"project": project.id},
            headers={"Idempotency-Key": "seal-ignored"},
            json={
                "path": ignored_path,
                "expected_version_id": ignored_v1.id,
                "expected_disk_revision": ignored_payload["disk_revision"],
                "expected_pending_revision": None,
            },
        )
        check(
            "ignored history remains visible while new version creation is rejected",
            ignored_capability.status_code == 200
            and ignored_payload.get("management_state") == "ignored"
            and ignored_payload.get("can_version") is False
            and ignored_payload.get("can_preview_history") is True
            and rejected.status_code == 409
            and rejected.json().get("error", {}).get("code") == "version_management_disabled"
            and len(versions.history(project.id, ignored_path)) == 1,
            f"capability={ignored_capability.text} rejected={rejected.text}",
        )

        settings.mode = VersionPolicyMode.WHITELIST.value
        settings.ignores = ()
        pdf = Path(project.root) / "resources" / "paper.pdf"
        pdf.write_bytes(b"%PDF-1.4\nunchanged source\n")
        empty_annotations = annotations.snapshot(project.id, "resources/paper.pdf")
        annotations.commit(
            project.id,
            "resources/paper.pdf",
            pdf_records(1, "first"),
            empty_annotations.record_revision,
        )
        pdf_v1 = versions.ensure_initial(project.id, "resources/paper.pdf").version
        current_annotations = annotations.snapshot(project.id, "resources/paper.pdf")
        annotations.commit(
            project.id,
            "resources/paper.pdf",
            pdf_records(1, "second"),
            current_annotations.record_revision,
        )
        stable_pdf = content.stable_snapshot(project.id, "resources/paper.pdf", VERSION_MAX_BYTES)
        VersionStore(content.resolve(project.id, PROJECT_DB_RELATIVE), project.root).observe(
            pdf_v1.file_id,
            DiskObservation(
                ObservationState.PRESENT,
                revision=stable_pdf.revision,
                size_bytes=stable_pdf.size,
                mtime_ns=stable_pdf.mtime_ns,
                mode_bits=stable_pdf.mode_bits,
                annotation_revision=annotations.snapshot(
                    project.id, "resources/paper.pdf"
                ).record_revision,
            ),
        )
        with patch.object(supervisor, "activate_project"):
            pdf_tree = client.get("/api/resource/tree", params={"project": project.id}).json()
        pdf_tree_node = next(
            node for node in pdf_tree["nodes"] if node["path"] == "resources/paper.pdf"
        )
        check(
            "PDF annotation-only observation stays out of resource tree drift",
            pdf_tree_node["version"]["drifted"] is False,
            str(pdf_tree_node["version"]),
        )
        annotation_only_seal = versions.seal(project.id, "resources/paper.pdf", VersionOrigin.USER)
        check(
            "PDF annotation-only change remains outside file version history",
            pdf_v1.annotation_object_id is None
            and annotation_only_seal.unchanged
            and annotation_only_seal.version.id == pdf_v1.id
            and len(versions.history(project.id, "resources/paper.pdf")) == 1,
        )
        pdf_preview = app.state.resource_recovery.preview_version(project.id, pdf_v1.id)
        pdf_restored = app.state.resource_recovery.restore_version(
            project.id,
            pdf_v1.id,
            RestorePolicy.STRICT,
            pdf_preview.preflight_token,
        )
        check(
            "PDF restore changes source history without rolling back live records",
            pdf_restored.version.annotation_object_id is None
            and annotations.snapshot(project.id, "resources/paper.pdf").records["comments"]
            == pdf_records(1, "second")["comments"]
            and pdf.read_bytes() == b"%PDF-1.4\nunchanged source\n",
        )

        linked_root = root / "linked-history"
        linked_root.mkdir()
        linked_pdf = linked_root / "linked.pdf"
        linked_pdf.write_bytes(b"%PDF-1.4\nlinked historical bytes\n")
        linked = content.authorize_root(project.id, str(linked_root), "linked-history")
        linked_path = f"{linked.mount_path}/linked.pdf"
        linked_empty = annotations.snapshot(project.id, linked_path)
        annotations.commit(
            project.id,
            linked_path,
            pdf_records(2, "retained after revoke"),
            linked_empty.record_revision,
        )
        linked_v1 = versions.ensure_initial(project.id, linked_path).version
        content.revoke_root(linked.root_id)

        first_link_source = root / "first-linked.json"
        first_link_source.write_bytes(b'{"linked": true}\n')
        first_link_response = content.authorize_root(
            project.id, str(first_link_source), "first-linked.json"
        )
        initial_plan = InitialVersionPlan.for_recovery(
            "a" * 64,
            "first-link-authorization",
            project.id,
            first_link_response.mount_path,
            now_ms=1234000,
        )
        supervisor.reconcile_linked_root(
            project.id,
            first_link_response.mount_path,
            observed_at_ms=initial_plan.now_ms,
            recovery_attempt="a" * 64,
            recovery_operation="first-link-authorization",
        )
        first_link_capability = versions.capability(project.id, "resources/first-linked.json")
        check(
            "root authorization creates a new linked file's initial version before returning",
            bool(first_link_response.root_id)
            and first_link_capability.managed
            and not first_link_capability.drifted
            and len(versions.history(project.id, "resources/first-linked.json")) == 1,
            str(first_link_response),
        )
        first_link_version = versions.history(project.id, first_link_response.mount_path)[0]
        check(
            "authorization recovery uses the exact first-version plan and frozen clock",
            first_link_version.id == initial_plan.version_id
            and first_link_version.file_id == initial_plan.file_id
            and first_link_version.created_at_ms == initial_plan.now_ms,
        )

        relinked_source = root / "relinked.md"
        relinked_source.write_bytes(b"linked baseline\n")
        relinked = content.authorize_root(project.id, str(relinked_source), "relinked.md")
        relinked_v1 = versions.ensure_initial(project.id, relinked.mount_path).version
        content.revoke_root(relinked.root_id)
        versions.observe(project.id, relinked.mount_path)
        check(
            "revoked linked file becomes an unsealed tombstone while retaining history",
            not versions.capability(project.id, relinked.mount_path).drifted
            and versions.capability(project.id, relinked.mount_path).pending is not None
            and len(versions.history(project.id, relinked.mount_path)) == 1,
        )
        restored_response = content.authorize_root(project.id, str(relinked_source), "relinked.md")
        supervisor.reconcile_linked_root(project.id, restored_response.mount_path)
        check(
            "root authorization reconciles an unchanged restored file before returning",
            bool(restored_response.root_id)
            and not versions.capability(project.id, relinked.mount_path).drifted
            and versions.history(project.id, relinked.mount_path)[0].id == relinked_v1.id,
            str(restored_response),
        )

        content.revoke_root(relinked.root_id)
        versions.observe(project.id, relinked.mount_path)
        relinked_source.write_bytes(b"changed while detached\n")
        changed_response = content.authorize_root(project.id, str(relinked_source), "relinked.md")
        supervisor.reconcile_linked_root(project.id, changed_response.mount_path)
        check(
            "root authorization captures detached changes as pending without sealing",
            bool(changed_response.root_id)
            and not versions.capability(project.id, relinked.mount_path).drifted
            and versions.capability(project.id, relinked.mount_path).pending is not None
            and versions.capability(project.id, relinked.mount_path).disk_revision
            == content.revision(b"changed while detached\n")
            and len(versions.history(project.id, relinked.mount_path)) == 1,
            str(changed_response),
        )

        relinked_directory = root / "relinked-directory"
        relinked_directory.mkdir()
        unchanged_child = relinked_directory / "unchanged.md"
        changed_child = relinked_directory / "changed.md"
        unchanged_child.write_bytes(b"unchanged baseline\n")
        changed_child.write_bytes(b"changed baseline\n")
        directory_root = content.authorize_root(
            project.id, str(relinked_directory), "relinked-directory"
        )
        unchanged_path = f"{directory_root.mount_path}/unchanged.md"
        changed_path = f"{directory_root.mount_path}/changed.md"
        versions.ensure_initial(project.id, unchanged_path)
        versions.ensure_initial(project.id, changed_path)
        content.revoke_root(directory_root.root_id)
        versions.observe(project.id, unchanged_path)
        versions.observe(project.id, changed_path)
        changed_child.write_bytes(b"changed while directory detached\n")
        directory_response = content.authorize_root(
            project.id, str(relinked_directory), "relinked-directory"
        )
        supervisor.reconcile_linked_root(project.id, directory_response.mount_path)
        check(
            "root authorization reconciles every existing identity below a restored directory",
            bool(directory_response.root_id)
            and not versions.capability(project.id, unchanged_path).drifted
            and not versions.capability(project.id, changed_path).drifted
            and versions.capability(project.id, changed_path).pending is not None
            and len(versions.history(project.id, changed_path)) == 1
            and len(versions.history(project.id, unchanged_path)) == 1,
            str(directory_response),
        )

        collision = Path(project.root) / "resources" / "linked.pdf"
        collision.write_bytes(b"existing local bytes\n")
        saved = client.post(
            f"/api/resource/versions/{linked_v1.id}/save-as",
            params={"project": project.id},
            headers={"Idempotency-Key": "save-linked-v1"},
            json={"target_dir": "", "name": "linked.pdf"},
        )
        saved_version = saved.json().get("version", {})
        saved_path = str(saved_version.get("path") or "")
        saved_replay = client.post(
            f"/api/resource/versions/{linked_v1.id}/save-as",
            params={"project": project.id},
            headers={"Idempotency-Key": "save-linked-v1"},
            json={"target_dir": "", "name": "linked.pdf"},
        )
        saved_conflict = client.post(
            f"/api/resource/versions/{linked_v1.id}/save-as",
            params={"project": project.id},
            headers={"Idempotency-Key": "save-linked-v1"},
            json={"target_dir": "", "name": "different.pdf"},
        )
        check(
            "revoked linked history saves exact PDF without copying version annotations",
            saved.status_code == 200
            and saved_path == "resources/linked (2).pdf"
            and saved_version.get("sequence") == 1
            and saved_version.get("file_id") != linked_v1.file_id
            and saved_version.get("restored_from_id") == linked_v1.id
            and (Path(project.root) / saved_path).read_bytes()
            == b"%PDF-1.4\nlinked historical bytes\n"
            and not annotations.snapshot(project.id, saved_path).records["comments"]
            and collision.read_bytes() == b"existing local bytes\n"
            and saved_replay.json() == saved.json()
            and saved_conflict.status_code == 409
            and saved_conflict.json().get("error", {}).get("code") == "idempotency_conflict",
            f"saved={saved.text} replay={saved_replay.text} conflict={saved_conflict.text}",
        )
        try:
            with patch.object(VersionStore, "commit_restore", side_effect=SimulatedProcessExit):
                app.state.resource_recovery.save_as_version(
                    project.id,
                    linked_v1.id,
                    "",
                    "crash.pdf",
                    "save-linked-crash",
                )
        except SimulatedProcessExit:
            pass
        replay_recovery = ResourceRecoveryService(content, retention, annotations)
        recovered = replay_recovery.recover_pending(project.id)
        crash_history = versions.history(project.id, "resources/crash.pdf")
        check(
            "restart rolls a save-as manifest forward without duplicating its reserved identity",
            len(recovered) == 1
            and len(crash_history) == 1
            and crash_history[0].sequence == 1
            and crash_history[0].restored_from_id == linked_v1.id
            and not annotations.snapshot(project.id, "resources/crash.pdf").records["comments"],
        )

        progress_target = Path(project.root) / "resources" / "progress.md"
        progress_target.write_text("progress\n", encoding="utf-8")
        initialization_progress: list[VersionInitializationProgress] = []
        with patch.object(content, "scan_resources", wraps=content.scan_resources) as scan:
            supervisor.initialize_paths(
                project.id,
                ("resources/progress.md",),
                initialization_progress.append,
            )
        check(
            "path initialization scans once and reports discovery before exact initialization",
            scan.call_count == 1
            and initialization_progress
            == [
                VersionInitializationProgress(0, 0, 0),
                VersionInitializationProgress(1, 0, 0),
                VersionInitializationProgress(1, 0, 1),
                VersionInitializationProgress(1, 1, 1),
            ],
            repr(initialization_progress),
        )

        with sqlite3.connect(database) as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS another_domain (id TEXT PRIMARY KEY)")
            connection.execute("INSERT INTO another_domain (id) VALUES ('kept')")
        versions.ensure_initial(project.id, "resources/notes.md")
        with sqlite3.connect(database) as connection:
            kept = connection.execute("SELECT id FROM another_domain").fetchone()
        check("idempotent schema ensure preserves other domain tables", kept == ("kept",))
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print(f"\ncontract_resource_versions: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
