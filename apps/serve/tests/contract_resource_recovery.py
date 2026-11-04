"""Delivery recovery preflight and conflict-policy contracts."""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.activity import Activities
from service.platform.resources import RestorePolicy, TurnOutcome, VersionOrigin
from service.resources.api.versions import register_version_routes
from service.resources.service.activation import ResourceActivation
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryError, ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

from .historical import historical_delivery
from .records import pdf_records

PASS = 0
FAIL = 0


class SimulatedProcessExit(BaseException):
    """Test-only abrupt exit that bypasses ordinary recovery error handling."""


class RecoverySettings:
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


class HistoricalFormats(WorkbenchFormatPolicy):
    """Capture the old PDF review format solely to seed retained Delivery rows."""

    def reviewable(self, path: str) -> bool:
        return path.endswith(".pdf") or super().reviewable(path)


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


async def exercise() -> None:
    root = Path(tempfile.mkdtemp(prefix="resource-recovery-"))
    try:
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        content = ContentService(registry, catalog, activities=Activities())
        project = registry.create("恢复项目")
        resources = Path(project.root) / "resources"
        clean = resources / "clean.md"
        conflict = resources / "conflict.md"
        clean.write_text("clean before\n", encoding="utf-8")
        conflict.write_text("conflict before\n", encoding="utf-8")

        settings = RecoverySettings()
        retention = ResourceRetentionService(content, settings)
        annotations = PdfRecordStore(content)
        versions = ResourceVersionService(content, retention, HistoricalFormats(), annotations)
        supervisor = ResourceVersionSupervisor(
            content, versions, WorkbenchFormatPolicy(), settings, activities=Activities()
        )
        deliveries = ResourceDeliveryService(
            content, versions, supervisor, activities=supervisor._activities
        )
        recovery = ResourceRecoveryService(content, retention, annotations)
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
        content.bind_resource_changes(supervisor)
        await deliveries.begin_turn("session-r", "turn-r", project.root)
        await deliveries.bind_turn("session-r", "turn-r", "turn-r", "fixture-generation")
        clean.write_text("clean after\n", encoding="utf-8")
        conflict.write_text("conflict after\n", encoding="utf-8")
        for target in (clean, conflict):
            await deliveries.record_change(
                "session-r", "turn-r", str(target), "update", generation="fixture-generation"
            )
        delivered = historical_delivery(
            content,
            project.id,
            await deliveries.finish_turn("session-r", "turn-r", TurnOutcome.COMPLETED),
        )
        assert delivered.delivery is not None

        conflict.write_text("external bytes\n", encoding="utf-8")
        preview = recovery.preview_delivery(project.id, delivered.delivery.id)
        check(
            "preflight reports exact conflict member",
            len(preview.members) == 2 and sum(item.conflict for item in preview.members) == 1,
        )
        try:
            recovery.restore_delivery(
                project.id,
                delivered.delivery.id,
                RestorePolicy.STRICT,
                preview.preflight_token,
            )
        except ResourceRecoveryError as exc:
            strict_error = exc.code
        else:
            strict_error = ""
        check(
            "strict conflict rejects the whole set",
            strict_error == "delivery_restore_conflict",
        )
        check(
            "strict rejection performs zero writes",
            clean.read_text(encoding="utf-8") == "clean after\n"
            and conflict.read_text(encoding="utf-8") == "external bytes\n",
        )

        skipped = recovery.restore_delivery(
            project.id,
            delivered.delivery.id,
            RestorePolicy.SKIP_CONFLICTS,
            preview.preflight_token,
            "delivery-skip-once",
        )
        check(
            "skip-conflicts restores only safe files",
            clean.read_text(encoding="utf-8") == "clean before\n"
            and conflict.read_text(encoding="utf-8") == "external bytes\n",
        )
        check(
            "skip-conflicts identifies skipped file",
            len(skipped.versions) == 1 and len(skipped.skipped_file_ids) == 1,
        )
        check(
            "Delivery rollback creates versions but no Delivery",
            versions.history(project.id, "resources/clean.md")[0].origin.value == "delivery_revert",
        )
        recovery = ResourceRecoveryService(content, retention, annotations)
        with patch.object(
            recovery,
            "preview_delivery",
            side_effect=AssertionError("committed replay must not recompute preflight"),
        ):
            skipped_replay = recovery.restore_delivery(
                project.id,
                delivered.delivery.id,
                RestorePolicy.SKIP_CONFLICTS,
                preview.preflight_token,
                "delivery-skip-once",
            )
        check(
            "Delivery rollback replay returns the same versions and skipped members",
            skipped_replay == skipped
            and len(versions.history(project.id, "resources/clean.md")) == 3,
        )

        force_preview = recovery.preview_delivery(project.id, delivered.delivery.id)
        forced = recovery.restore_delivery(
            project.id,
            delivered.delivery.id,
            RestorePolicy.FORCE,
            force_preview.preflight_token,
        )
        check(
            "force restores all members",
            clean.read_text(encoding="utf-8") == "clean before\n"
            and conflict.read_text(encoding="utf-8") == "conflict before\n",
        )
        check(
            "force appends a source-linked version per file",
            len(forced.versions) == 2
            and all(item.source_delivery_id == delivered.delivery.id for item in forced.versions)
            and forced.skipped_file_ids == (),
        )

        original_path = "resources/原文件.md"
        renamed_path = "resources/新文件.md"
        original_file = resources / "原文件.md"
        renamed_file = resources / "新文件.md"
        original_file.write_text("historical content\n", encoding="utf-8")
        original = versions.ensure_initial(project.id, original_path).version
        assert original is not None
        content.rename(project.id, original_path, "新文件.md")
        renamed_file.write_text("renamed content\n", encoding="utf-8")
        versions.seal(project.id, renamed_path, VersionOrigin.USER)
        rename_preview = recovery.preview_version(project.id, original.id)
        rename_restore = recovery.restore_version(
            project.id,
            original.id,
            RestorePolicy.STRICT,
            rename_preview.preflight_token,
            "single-name-restore",
        )
        check(
            "single restore restores historical name and bytes with stable identity",
            original_file.exists()
            and original_file.read_text(encoding="utf-8") == "historical content\n"
            and not renamed_file.exists()
            and rename_restore.version.path == original_path
            and rename_restore.version.file_id == original.file_id,
        )
        restarted = ResourceRecoveryService(content, retention, annotations)
        replayed = restarted.restore_version(
            project.id,
            original.id,
            RestorePolicy.STRICT,
            rename_preview.preflight_token,
            "single-name-restore",
        )
        check(
            "renamed restore replay adds no duplicate version",
            replayed.version.id == rename_restore.version.id,
        )

        content.rename(project.id, original_path, "新文件.md")
        renamed_file.write_text("keep current bytes\n", encoding="utf-8")
        versions.seal(project.id, renamed_path, VersionOrigin.USER)
        free_preview = recovery.preview_version(project.id, original.id)
        original_file.write_text("other file bytes\n", encoding="utf-8")
        occupied_preview = recovery.preview_version(project.id, original.id)
        check(
            "preflight identifies historical path occupancy",
            occupied_preview.conflict and occupied_preview.path_conflict,
        )
        for policy in (RestorePolicy.STRICT, RestorePolicy.FORCE):
            error = ""
            try:
                recovery.restore_version(
                    project.id, original.id, policy, occupied_preview.preflight_token
                )
            except ResourceRecoveryError as exc:
                error = exc.code
            check(
                f"{policy.value} refuses to overwrite historical path occupant",
                error == "restore_conflict"
                and original_file.read_text(encoding="utf-8") == "other file bytes\n"
                and renamed_file.read_text(encoding="utf-8") == "keep current bytes\n",
            )
        stale_error = ""
        try:
            recovery.restore_version(
                project.id, original.id, RestorePolicy.FORCE, free_preview.preflight_token
            )
        except ResourceRecoveryError as exc:
            stale_error = exc.code
        check(
            "historical path occupied after preview invalidates the token",
            stale_error == "preflight_stale",
        )
        original_file.unlink()
        interrupted_preview = recovery.preview_version(project.id, original.id)
        with patch.object(content, "apply_stream", side_effect=SimulatedProcessExit):
            try:
                recovery.restore_version(
                    project.id,
                    original.id,
                    RestorePolicy.STRICT,
                    interrupted_preview.preflight_token,
                    "single-name-interrupted",
                )
            except SimulatedProcessExit:
                pass
        check(
            "interrupted path restore preserves current bytes at the journaled target",
            original_file.read_text(encoding="utf-8") == "keep current bytes\n"
            and not renamed_file.exists(),
        )
        recovered = ResourceRecoveryService(content, retention, annotations).restore_version(
            project.id,
            original.id,
            RestorePolicy.STRICT,
            interrupted_preview.preflight_token,
            "single-name-interrupted",
        )
        check(
            "restart completes interrupted rename and publishes historical path",
            recovered.version.path == original_path
            and original_file.read_text(encoding="utf-8") == "historical content\n"
            and not renamed_file.exists(),
        )
        check(
            "restored history retains identity and links the source version",
            versions.history(project.id, original_path)[0].id == recovered.version.id
            and recovered.version.restored_from_id == original.id,
        )

        moved_from = resources / "move-from.md"
        moved_to = resources / "move-to.md"
        deleted = resources / "deleted.md"
        created = resources / "created.md"
        moved_from.write_text("move bytes\n", encoding="utf-8")
        deleted.write_text("delete bytes\n", encoding="utf-8")
        await deliveries.begin_turn("session-r", "turn-structural", project.root)
        await deliveries.bind_turn(
            "session-r", "turn-structural", "turn-structural", "fixture-generation"
        )
        moved_from.rename(moved_to)
        deleted.unlink()
        created.write_text("create bytes\n", encoding="utf-8")
        for target in (moved_from, moved_to, deleted, created):
            await deliveries.record_change(
                "session-r",
                "turn-structural",
                str(target),
                "update",
                generation="fixture-generation",
            )
        structural = historical_delivery(
            content,
            project.id,
            await deliveries.finish_turn("session-r", "turn-structural", TurnOutcome.COMPLETED),
        )
        assert structural.delivery is not None
        structural_preview = recovery.preview_delivery(project.id, structural.delivery.id)
        structural_result = recovery.restore_delivery(
            project.id,
            structural.delivery.id,
            RestorePolicy.STRICT,
            structural_preview.preflight_token,
        )
        check(
            "rollback removes files created by the Agent",
            not created.exists(),
        )
        check(
            "rollback recreates files deleted by the Agent",
            deleted.read_text(encoding="utf-8") == "delete bytes\n",
        )
        check(
            "rollback reverses moves with stable identity",
            moved_from.read_text(encoding="utf-8") == "move bytes\n" and not moved_to.exists(),
        )
        check(
            "structural rollback appends one version per member",
            len(structural_result.versions) == 3,
        )

        pdf_before = resources / "pdf-before.pdf"
        pdf_after = resources / "pdf-after.pdf"
        pdf_before.write_bytes(b"%PDF-1.4\nannotated move\n")
        empty_pdf_annotations = annotations.snapshot(project.id, "resources/pdf-before.pdf")
        annotations.commit(
            project.id,
            "resources/pdf-before.pdf",
            pdf_records(4, "restore the path"),
            empty_pdf_annotations.record_revision,
        )
        versions.ensure_initial(project.id, "resources/pdf-before.pdf")
        await deliveries.begin_turn("session-r", "turn-pdf-move", project.root)
        await deliveries.bind_turn(
            "session-r", "turn-pdf-move", "turn-pdf-move", "fixture-generation"
        )
        pdf_before.rename(pdf_after)
        for target in (pdf_before, pdf_after):
            await deliveries.record_change(
                "session-r",
                "turn-pdf-move",
                str(target),
                "move",
                generation="fixture-generation",
            )
        pdf_move_delivery = historical_delivery(
            content,
            project.id,
            await deliveries.finish_turn("session-r", "turn-pdf-move", TurnOutcome.COMPLETED),
        )
        assert pdf_move_delivery.delivery is not None
        pdf_move_preview = recovery.preview_delivery(project.id, pdf_move_delivery.delivery.id)
        recovery.restore_delivery(
            project.id,
            pdf_move_delivery.delivery.id,
            RestorePolicy.STRICT,
            pdf_move_preview.preflight_token,
        )
        restored_pdf_records = annotations.snapshot(project.id, "resources/pdf-before.pdf")
        check(
            "Delivery rollback restores a moved PDF and its stable records",
            pdf_before.is_file()
            and pdf_before.read_bytes() == b"%PDF-1.4\nannotated move\n"
            and not pdf_after.exists()
            and restored_pdf_records.record_target.subject_id
            == empty_pdf_annotations.record_target.subject_id
            and restored_pdf_records.records["comments"]
            == pdf_records(4, "restore the path")["comments"],
            (
                f"before={pdf_before.exists()} after={pdf_after.exists()} "
                "asset="
                f"{restored_pdf_records.record_target.subject_id}/"
                f"{empty_pdf_annotations.record_target.subject_id} "
                f"comments={restored_pdf_records.records['comments']}"
            ),
        )

        pdf_version = versions.history(project.id, "resources/pdf-before.pdf")[0]
        renamed_pdf = content.rename(project.id, "resources/pdf-before.pdf", "pdf-edited.pdf")
        current_pdf = content.snapshot(project.id, renamed_pdf.path)
        edited_pdf_bytes = b"%PDF-1.4\nmodified after move\n"
        content.apply_bytes(
            project.id,
            renamed_pdf.path,
            edited_pdf_bytes,
            current_pdf.revision,
            force=False,
            mode_bits=None,
            notify=False,
        )
        versions.seal(project.id, renamed_pdf.path, VersionOrigin.USER)
        pdf_restore_preview = recovery.preview_version(project.id, pdf_version.id)
        edited_pdf = resources / "pdf-edited.pdf"
        pdf_inode = edited_pdf.stat().st_ino
        with patch.object(content, "apply_stream", side_effect=SimulatedProcessExit):
            try:
                recovery.restore_version(
                    project.id,
                    pdf_version.id,
                    RestorePolicy.STRICT,
                    pdf_restore_preview.preflight_token,
                    "pdf-name-interrupted",
                )
            except SimulatedProcessExit:
                pass
        check(
            "interrupted PDF restore keeps the same asset and current bytes before replacement",
            not edited_pdf.exists()
            and pdf_before.stat().st_ino == pdf_inode
            and pdf_before.read_bytes() == edited_pdf_bytes
            and content.identify(project.id, "resources/pdf-before.pdf").asset.asset_id
            == empty_pdf_annotations.record_target.subject_id,
        )
        ResourceRecoveryService(content, retention, annotations).restore_version(
            project.id,
            pdf_version.id,
            RestorePolicy.STRICT,
            pdf_restore_preview.preflight_token,
            "pdf-name-interrupted",
        )
        restored_pdf = annotations.snapshot(project.id, "resources/pdf-before.pdf")
        check(
            "restarted PDF restore replaces bytes while preserving its annotation identity",
            pdf_before.read_bytes() == b"%PDF-1.4\nannotated move\n"
            and restored_pdf.record_target.subject_id
            == empty_pdf_annotations.record_target.subject_id
            and restored_pdf.records["comments"] == pdf_records(4, "restore the path")["comments"],
        )

        created_pdf = resources / "created.pdf"
        await deliveries.begin_turn("session-r", "turn-pdf-create", project.root)
        await deliveries.bind_turn(
            "session-r", "turn-pdf-create", "turn-pdf-create", "fixture-generation"
        )
        created_pdf.write_bytes(b"%PDF-1.4\ncreated with annotations\n")
        empty_created_annotations = annotations.snapshot(project.id, "resources/created.pdf")
        annotations.commit(
            project.id,
            "resources/created.pdf",
            pdf_records(5, "retain records on rollback"),
            empty_created_annotations.record_revision,
        )
        await deliveries.record_change(
            "session-r",
            "turn-pdf-create",
            str(created_pdf),
            "create",
            generation="fixture-generation",
        )
        pdf_create_delivery = historical_delivery(
            content,
            project.id,
            await deliveries.finish_turn("session-r", "turn-pdf-create", TurnOutcome.COMPLETED),
        )
        assert pdf_create_delivery.delivery is not None
        pdf_create_preview = recovery.preview_delivery(project.id, pdf_create_delivery.delivery.id)
        recovery.restore_delivery(
            project.id,
            pdf_create_delivery.delivery.id,
            RestorePolicy.STRICT,
            pdf_create_preview.preflight_token,
        )
        retained_created_records = annotations.snapshot_asset(
            project.id, empty_created_annotations.record_target.subject_id
        )
        check(
            "Delivery rollback to tombstone removes the PDF but retains its records",
            not created_pdf.exists()
            and retained_created_records.source_state == "missing"
            and retained_created_records.records["comments"]
            == pdf_records(5, "retain records on rollback")["comments"],
        )

        tombstone = versions.history(project.id, "resources/created.md")[0]
        created.write_text("external resurrection\n", encoding="utf-8")
        tombstone_preview = recovery.preview_version(project.id, tombstone.id)
        tombstone_restore = recovery.restore_version(
            project.id,
            tombstone.id,
            RestorePolicy.FORCE,
            tombstone_preview.preflight_token,
        )
        check(
            "single-file restore supports a tombstone version",
            not created.exists()
            and tombstone_restore.version.origin.value == "restore"
            and tombstone_restore.version.state.value == "tombstone",
        )

        crash_a = resources / "crash-a.md"
        crash_b = resources / "crash-b.md"
        crash_a.write_text("a before\n", encoding="utf-8")
        crash_b.write_text("b before\n", encoding="utf-8")
        await deliveries.begin_turn("session-r", "turn-crash", project.root)
        await deliveries.bind_turn("session-r", "turn-crash", "turn-crash", "fixture-generation")
        crash_a.write_text("a after\n", encoding="utf-8")
        crash_b.write_text("b after\n", encoding="utf-8")
        for target in (crash_a, crash_b):
            await deliveries.record_change(
                "session-r", "turn-crash", str(target), "update", generation="fixture-generation"
            )
        crash_delivery = historical_delivery(
            content,
            project.id,
            await deliveries.finish_turn("session-r", "turn-crash", TurnOutcome.COMPLETED),
        )
        assert crash_delivery.delivery is not None
        crash_preview = recovery.preview_delivery(project.id, crash_delivery.delivery.id)
        versions_before_crash = sum(
            len(versions.history(project.id, path))
            for path in ("resources/crash-a.md", "resources/crash-b.md")
        )
        original_apply = content.apply_stream
        apply_count = 0

        def crash_after_first_apply(*args, **kwargs):
            nonlocal apply_count
            receipt = original_apply(*args, **kwargs)
            apply_count += 1
            if apply_count == 1:
                raise SimulatedProcessExit()
            return receipt

        content.apply_stream = crash_after_first_apply  # type: ignore[method-assign]
        try:
            recovery.restore_delivery(
                project.id,
                crash_delivery.delivery.id,
                RestorePolicy.STRICT,
                crash_preview.preflight_token,
                "delivery-crash-once",
            )
        except SimulatedProcessExit:
            pass
        finally:
            content.apply_stream = original_apply  # type: ignore[method-assign]
        check(
            "interrupted Delivery restore exposes no partial versions",
            sum(
                len(versions.history(project.id, path))
                for path in ("resources/crash-a.md", "resources/crash-b.md")
            )
            == versions_before_crash,
        )
        recovered = ResourceRecoveryService(content, retention, annotations).recover_pending(
            project.id
        )
        check(
            "restart reconciliation rolls an interrupted restore forward",
            len(recovered) == 1
            and crash_a.read_text(encoding="utf-8") == "a before\n"
            and crash_b.read_text(encoding="utf-8") == "b before\n",
        )
        check(
            "reconciled Delivery publishes all versions atomically",
            sum(
                len(versions.history(project.id, path))
                for path in ("resources/crash-a.md", "resources/crash-b.md")
            )
            == versions_before_crash + 2,
        )
        replay_recovery = ResourceRecoveryService(content, retention, annotations)
        with patch.object(
            replay_recovery,
            "preview_delivery",
            side_effect=AssertionError("recovered operation replay must use its receipt"),
        ):
            recovered_replay = replay_recovery.restore_delivery(
                project.id,
                crash_delivery.delivery.id,
                RestorePolicy.STRICT,
                crash_preview.preflight_token,
                "delivery-crash-once",
            )
        check(
            "recovered prepared operation publishes and replays one durable receipt",
            len(recovered_replay.versions) == 2
            and sum(
                len(versions.history(project.id, path))
                for path in ("resources/crash-a.md", "resources/crash-b.md")
            )
            == versions_before_crash + 2,
        )

        app = FastAPI()
        app.state.resource_versions = versions
        app.state.resource_recovery = recovery
        register_version_routes(app)
        client = TestClient(app)
        listed = client.get("/api/resource/deliveries", params={"project": project.id})
        check(
            "Delivery API exposes logical groups and members",
            listed.status_code == 200 and len(listed.json().get("deliveries", [])) == 5,
            listed.text,
        )
        api_preview = client.post(
            f"/api/resource/deliveries/{structural.delivery.id}/revert/preview",
            params={"project": project.id},
        )
        check(
            "Delivery API exposes all-member preflight",
            api_preview.status_code == 200 and len(api_preview.json().get("members", [])) == 3,
            api_preview.text,
        )
        missing_delivery_key = client.post(
            f"/api/resource/deliveries/{structural.delivery.id}/revert",
            params={"project": project.id},
            json={
                "policy": RestorePolicy.STRICT.value,
                "preflight_token": api_preview.json().get("preflight_token"),
            },
        )
        check(
            "Delivery revert HTTP requires an idempotency key",
            missing_delivery_key.status_code == 400
            and missing_delivery_key.json().get("error", {}).get("code")
            == "idempotency_key_required",
            missing_delivery_key.text,
        )
        delivery_detail = client.get(
            f"/api/resource/deliveries/{structural.delivery.id}",
            params={"project": project.id},
        )
        check(
            "Delivery detail API resolves one logical group",
            delivery_detail.status_code == 200
            and len(delivery_detail.json().get("members", [])) == 3,
            delivery_detail.text,
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main() -> int:
    asyncio.run(exercise())
    print(f"\ncontract_resource_recovery: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
