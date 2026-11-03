"""Global resource-version settings and newest-N retention contracts."""

from __future__ import annotations

import asyncio
import json
import shutil
import sqlite3
import tempfile
from hashlib import sha256
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.constants import MAX_VERSION_FILE_SIZE_KB_KEY, MAX_VERSIONS_PER_FILE_KEY
from service.chat.service import settings as settings_module
from service.chat.service.settings import SettingsService
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE, PROJECT_VERSIONS_RELATIVE
from service.platform.activity import Activities
from service.platform.resources import ManagementState, RestorePolicy, TurnOutcome, VersionOrigin
from service.platform.storage import filesystem_path
from service.resources.api.settings import register_version_setting_routes
from service.resources.persistence.objects import CasEntryKind, CasLayout, CasStore
from service.resources.service.activation import ResourceActivation
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService, RetentionError
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

from .historical import historical_delivery

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="resource-version-retention-"))
    original_settings_file = settings_module.SERVE_SETTINGS_FILE
    try:
        settings_module.SERVE_SETTINGS_FILE = root / "home" / "service" / "settings.json"
        settings = SettingsService(environ={})
        check("global version limit defaults to 50", settings.max_versions_per_file() == 50)
        check(
            "global maximum versioned file size defaults to 50 MB stored as KB",
            settings.max_version_file_size_kb() == 50 * 1024,
        )
        settings_module.SERVE_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        settings_module.SERVE_SETTINGS_FILE.write_text(
            json.dumps({MAX_VERSIONS_PER_FILE_KEY: 100, MAX_VERSION_FILE_SIZE_KB_KEY: 1024}),
            encoding="utf-8",
        )
        check(
            "saved user version limit and file size keep their persisted KB values",
            settings.max_versions_per_file() == 100 and settings.max_version_file_size_kb() == 1024,
        )
        settings_module.SERVE_SETTINGS_FILE.unlink()
        check(
            "global include rules default to the registered format allowlist",
            settings.version_include_patterns() is None,
        )
        check(
            "global ignore rules default to common transient artifacts",
            {"*.log", "core", "core.*", "*.pid", "*.tmp", "logs/", "build/", ".cache/"}
            <= set(settings.version_ignore_patterns()),
            repr(settings.version_ignore_patterns()),
        )
        settings.set_file_version_settings(50, ("*.md",), ())
        check(
            "an explicitly empty personal blacklist overrides the defaults",
            settings.version_ignore_patterns() == (),
        )
        settings_module.SERVE_SETTINGS_FILE.unlink()
        settings = SettingsService(environ={})

        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        content = ContentService(registry, catalog, activities=Activities())
        project = registry.create("保留策略")
        target = Path(project.root) / "resources" / "notes.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        retention = ResourceRetentionService(content, settings)
        annotations = PdfRecordStore(content)
        versions = ResourceVersionService(content, retention, WorkbenchFormatPolicy(), annotations)
        first_file_id = ""
        for sequence in range(1, 5):
            target.write_text(f"version {sequence}\n", encoding="utf-8")
            expectations = {}
            if sequence == 2:
                versions.observe(project.id, "resources/notes.md")
                current = versions.capability(project.id, "resources/notes.md")
                expectations = {
                    "expected_revision": current.disk_revision,
                    "expected_version_id": current.version_id,
                    "expected_pending_revision": current.pending.revision,
                }
            sealed = versions.seal(
                project.id,
                "resources/notes.md",
                VersionOrigin.USER,
                idempotency_key="expiring-seal" if sequence == 2 else None,
                operation_target=first_file_id if sequence == 2 else None,
                **expectations,
            )
            first_file_id = sealed.version.file_id

        supervisor = ResourceVersionSupervisor(
            content, versions, WorkbenchFormatPolicy(), settings, activities=Activities()
        )
        preview = retention.preview(2, ("*.md", "*.pdf"), ("*.log",))
        check("lowering limit previews exact version deletions", preview.delete_versions == 2)
        check("retention preview counts distinct affected files", preview.affected_files == 1)
        check(
            "preview does not delete before confirmation",
            len(versions.history(project.id, "resources/notes.md")) == 4,
        )

        target.write_text("version 5\n", encoding="utf-8")
        versions.seal(project.id, "resources/notes.md", VersionOrigin.USER)
        before_cleanup = versions.history(project.id, "resources/notes.md")
        expired_object_ids = {
            item.object_id for item in before_cleanup[2:] if item.object_id is not None
        }
        stale_rejected = False
        try:
            retention.apply(2, ("*.md", "*.pdf"), ("*.log",), preview.token)
        except RetentionError as exc:
            stale_rejected = exc.code == "retention_preview_stale"
        check("changed impact invalidates an old preview token", stale_rejected)

        current = retention.preview(2, ("*.md", "*.pdf"), ("*.log",))
        applied = retention.apply(2, ("*.md", "*.pdf"), ("*.log",), current.token)
        history = versions.history(project.id, "resources/notes.md")
        check(
            "confirmed cleanup keeps only newest N", [item.sequence for item in history] == [5, 4]
        )
        check("cleanup reports applied counts", applied.delete_versions == 3)
        with sqlite3.connect(content.resolve(project.id, PROJECT_DB_RELATIVE)) as connection:
            expired_receipts = connection.execute(
                "SELECT count(*) FROM resources_operations WHERE idempotency_key = ?",
                ("expiring-seal",),
            ).fetchone()[0]
        check("retention removes receipts whose result Version expired", expired_receipts == 0)
        check("global limit persists", settings.max_versions_per_file() == 2)
        check(
            "global include rules persist", settings.version_include_patterns() == ("*.md", "*.pdf")
        )
        check("global ignore rules persist", settings.version_ignore_patterns() == ("*.log",))
        target.write_text("version 6\n", encoding="utf-8")
        versions.seal(project.id, "resources/notes.md", VersionOrigin.USER)
        check(
            "ordinary version seals enforce the current limit immediately",
            [item.sequence for item in versions.history(project.id, "resources/notes.md")]
            == [6, 5],
        )
        cas = CasStore(content.resolve(project.id, PROJECT_VERSIONS_RELATIVE))
        canonical_objects = cas.inventory(CasEntryKind.OBJECT)
        check(
            "retention moves unreachable objects out of the canonical CAS",
            expired_object_ids.isdisjoint(canonical_objects),
        )
        trash_root = (
            filesystem_path(content.resolve(project.id, PROJECT_VERSIONS_RELATIVE)) / "trash"
        )
        check(
            "first GC pass preserves unreachable bytes in epoch trash",
            any(item.is_file() for item in trash_root.rglob("*")),
        )
        retention.collect(project.id, grace_ms=0)
        check(
            "second GC pass deletes objects after the grace period",
            not any(item.is_file() for item in trash_root.rglob("*")),
        )

        large_target = Path(project.root) / "resources" / "report.pdf"
        large_payload = bytes(range(251)) * 38_000
        large_target.write_bytes(large_payload)
        first_large = versions.seal(project.id, "resources/report.pdf", VersionOrigin.USER).version
        changed_payload = bytearray(large_payload)
        changed_payload[len(changed_payload) // 2 : len(changed_payload) // 2 + 4096] = b"x" * 4096
        large_target.write_bytes(changed_payload)
        second_large = versions.seal(project.id, "resources/report.pdf", VersionOrigin.USER).version
        first_descriptor = cas.verify(first_large.object_id or "")
        second_descriptor = cas.verify(second_large.object_id or "")
        shared_chunks = {item.chunk_id for item in first_descriptor.chunks} & {
            item.chunk_id for item in second_descriptor.chunks
        }
        check(
            "large PDF versions use CHUNKED CAS with shared chunks",
            first_descriptor.layout is CasLayout.CHUNKED and bool(shared_chunks),
        )
        large_preview = retention.preview(1, ("*.md", "*.pdf"), ("*.log",))
        retention.apply(1, ("*.md", "*.pdf"), ("*.log",), large_preview.token)
        with cas.open(second_large.object_id or "") as stream:
            restored_large = stream.read()
        check(
            "GC retains chunks shared by the newest version",
            restored_large == bytes(changed_payload)
            and shared_chunks.issubset(cas.inventory(CasEntryKind.CHUNK)),
        )

        delivery_target = Path(project.root) / "resources" / "delivery.md"
        delivery_target.write_text("delivery 1\n", encoding="utf-8")
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

        async def create_deliveries() -> None:
            for sequence in range(2, 5):
                turn_id = f"retention-{sequence}"
                await deliveries.begin_turn("retention-session", turn_id, project.root)
                await deliveries.bind_turn(
                    "retention-session", turn_id, turn_id, "fixture-generation"
                )
                delivery_target.write_text(f"delivery {sequence}\n", encoding="utf-8")
                await deliveries.record_change(
                    "retention-session",
                    turn_id,
                    str(delivery_target),
                    "update",
                    generation="fixture-generation",
                )
                capture = await deliveries.finish_turn(
                    "retention-session", turn_id, TurnOutcome.COMPLETED
                )
                historical_delivery(content, project.id, capture)
                retention.enforce(project.id)

        asyncio.run(create_deliveries())
        retained_deliveries = recovery.deliveries(project.id, 10)
        check(
            "retention removes every historical Delivery referencing an expired version",
            retained_deliveries == (),
            repr(retained_deliveries),
        )
        expired_delivery_objects = {
            f"sha256:{sha256(f'delivery {sequence}\n'.encode()).hexdigest()}"
            for sequence in range(1, 4)
        }
        check(
            "deleted Delivery audit rows do not pin expired CAS objects",
            expired_delivery_objects.isdisjoint(cas.inventory(CasEntryKind.OBJECT)),
        )
        delivery_preview = retention.preview(2, ("*.md", "*.pdf"), ("*.log",))
        check(
            "retention leaves no expired version or historical Delivery references",
            delivery_preview.delete_versions == 0 and delivery_preview.delete_deliveries == 0,
        )
        retention.apply(2, ("*.md", "*.pdf"), ("*.log",), delivery_preview.token)
        notes_history = versions.history(project.id, "resources/notes.md")
        restore_preview = recovery.preview_version(project.id, notes_history[-1].id)
        recovery.restore_version(
            project.id,
            notes_history[-1].id,
            RestorePolicy.STRICT,
            restore_preview.preflight_token,
        )
        check(
            "restore-created versions enforce the current limit",
            len(versions.history(project.id, "resources/notes.md")) == 2,
        )

        invalid_rejected = False
        try:
            retention.preview(0, ("*.md",), ())
        except RetentionError as exc:
            invalid_rejected = exc.code == "invalid_max_versions"
        check("limit below 1 is rejected", invalid_rejected)

        app = FastAPI()
        (target.parent / "ignored.log").write_text("ignored\n", encoding="utf-8")
        with (target.parent / "oversized.pdf").open("wb") as oversized:
            oversized.truncate(50 * 1024 * 1024 + 1)
        supervisor.scan_project(project.id)
        register_version_setting_routes(
            app, settings=settings, retention=retention, supervisor=supervisor
        )
        client = TestClient(app)
        loaded = client.get("/api/serve/settings/file-versions")
        check(
            "settings API returns the one global value",
            loaded.status_code == 200
            and loaded.json().get("max_versions_per_file") == 2
            and loaded.json().get("max_file_size_kb") == 50 * 1024
            and loaded.json().get("include_patterns") == ["*.md", "*.pdf"]
            and loaded.json().get("ignore_patterns") == ["*.log"],
            loaded.text,
        )
        check(
            "settings API derives common types from the Workbench registry",
            "*.md" in loaded.json().get("common_patterns", [])
            and "*.docx" in loaded.json().get("common_patterns", [])
            and "*.jsonl" in loaded.json().get("common_patterns", [])
            and "*.png" not in loaded.json().get("common_patterns", []),
            loaded.text,
        )
        summary = loaded.json().get("scan_summary", {})
        check(
            "settings API projects the latest scan status without persisting it as settings",
            summary.get("status") == "idle"
            and summary.get("projects") == 1
            and summary.get("managed", 0) > 0
            and summary.get("unsupported", 0) >= 1
            and summary.get("oversized") == 1,
            loaded.text,
        )
        invalid = client.post(
            "/api/serve/settings/file-versions/preview",
            json={
                "mode": "whitelist",
                "max_versions_per_file": 1001,
                "include_patterns": "*.md",
                "ignore_patterns": "",
            },
        )
        check(
            "settings API rejects values above 1000",
            invalid.status_code == 400
            and invalid.json().get("error", {}).get("code") == "invalid_max_versions",
            invalid.text,
        )
        invalid_size = client.post(
            "/api/serve/settings/file-versions/preview",
            json={
                "mode": "whitelist",
                "max_versions_per_file": 2,
                "max_file_size_kb": 0,
                "include_patterns": "*.md",
                "ignore_patterns": "",
            },
        )
        check(
            "settings API rejects a maximum file size below 1 KB",
            invalid_size.status_code == 400
            and invalid_size.json().get("error", {}).get("code") == "invalid_max_file_size",
            invalid_size.text,
        )
        maximum_size = client.post(
            "/api/serve/settings/file-versions",
            json={
                "mode": "whitelist",
                "max_versions_per_file": 2,
                "max_file_size_kb": 2 * 1024 * 1024,
                "include_patterns": "*.md",
                "ignore_patterns": "",
            },
        )
        check(
            "settings API accepts the 2 GiB maximum stored as KB",
            maximum_size.status_code == 200
            and maximum_size.json().get("max_file_size_kb") == 2 * 1024 * 1024,
            maximum_size.text,
        )
        oversized_setting = client.post(
            "/api/serve/settings/file-versions",
            json={
                "mode": "whitelist",
                "max_versions_per_file": 2,
                "max_file_size_kb": 2 * 1024 * 1024 + 1,
                "include_patterns": "*.md",
                "ignore_patterns": "",
            },
        )
        check(
            "settings API rejects values above 2 GiB",
            oversized_setting.status_code == 400
            and oversized_setting.json().get("error", {}).get("code") == "invalid_max_file_size",
            oversized_setting.text,
        )
        empty_include = client.post(
            "/api/serve/settings/file-versions",
            json={
                "mode": "whitelist",
                "max_versions_per_file": 2,
                "include_patterns": "",
                "ignore_patterns": "*.log",
            },
        )
        check(
            "settings save persists an empty whitelist without impact preview",
            empty_include.status_code == 200
            and empty_include.json().get("delete_versions") == 0
            and settings.version_include_patterns() == (),
            empty_include.text,
        )
        before_direct = {
            "notes": tuple(item.id for item in versions.history(project.id, "resources/notes.md")),
            "pdf": tuple(item.id for item in versions.history(project.id, "resources/report.pdf")),
        }
        change_payload = {
            "mode": "whitelist",
            "max_versions_per_file": 3,
            "max_file_size_kb": 16384,
            "include_patterns": "*.md\n*.pdf\n*.docx",
            "ignore_patterns": "*.log\n*.cpp",
        }
        change_preview = client.post(
            "/api/serve/settings/file-versions/preview", json=change_payload
        )
        raised = client.post(
            "/api/serve/settings/file-versions",
            json={
                "mode": "whitelist",
                "preview_token": change_preview.json()["token"],
                "max_versions_per_file": 3,
                "max_file_size_kb": 16384,
                "include_patterns": "*.md\n*.pdf\n*.docx",
                "ignore_patterns": "*.log\n*.cpp",
            },
        )
        after_direct = {
            "notes": tuple(item.id for item in versions.history(project.id, "resources/notes.md")),
            "pdf": tuple(item.id for item in versions.history(project.id, "resources/report.pdf")),
        }
        check(
            "confirmed rule change preserves all historical versions",
            raised.status_code == 200
            and raised.json().get("delete_versions") == 0
            and raised.json().get("delete_deliveries") == 0
            and raised.json().get("affected_files") == 0
            and settings.max_versions_per_file() == 3
            and settings.max_version_file_size_kb() == 16384
            and supervisor.admission_state(project.id, "resources/report.pdf")
            is ManagementState.MANAGED
            and settings.version_include_patterns() == ("*.md", "*.pdf", "*.docx")
            and settings.version_ignore_patterns() == ("*.log", "*.cpp")
            and after_direct == before_direct,
            raised.text,
        )

        def unexpected_policy_impact(
            _mode: str,
            _includes: tuple[str, ...],
            _ignores: tuple[str, ...],
            _file_size_kb: int,
        ) -> tuple[tuple[tuple[str, str], ...], tuple[tuple[str, str], ...]]:
            raise AssertionError("settings save must not calculate policy impact")

        def unexpected_retention_plan(_limit: int) -> tuple[object, ...]:
            raise AssertionError("settings save must not inspect project history")

        retention.bind_policy_impact(unexpected_policy_impact)
        retention._plans = unexpected_retention_plan  # type: ignore[method-assign]
        lower_limit = client.post(
            "/api/serve/settings/file-versions",
            json={
                "mode": "whitelist",
                "max_versions_per_file": 1,
                "include_patterns": "*.md\n*.pdf\n*.docx",
                "ignore_patterns": "*.log\n*.cpp",
            },
        )
        check(
            "lowering the limit only updates configuration and preserves history",
            lower_limit.status_code == 200
            and lower_limit.json().get("delete_versions") == 0
            and lower_limit.json().get("delete_deliveries") == 0
            and lower_limit.json().get("affected_files") == 0
            and settings.max_versions_per_file() == 1
            and {
                "notes": tuple(
                    item.id for item in versions.history(project.id, "resources/notes.md")
                ),
                "pdf": tuple(
                    item.id for item in versions.history(project.id, "resources/report.pdf")
                ),
            }
            == before_direct,
            lower_limit.text,
        )
    finally:
        settings_module.SERVE_SETTINGS_FILE = original_settings_file
        shutil.rmtree(root, ignore_errors=True)

    print(f"\ncontract_resource_retention: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
