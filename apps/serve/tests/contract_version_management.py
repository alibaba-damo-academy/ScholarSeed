"""Version aliases and explicit deletion keep immutable history boundaries."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.resources import VersionOrigin, VersionPolicyMode
from service.resources.api.versions import register_version_routes
from service.resources.service.history import ResourceVersionService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

PASS = 0
FAIL = 0


class VersionSettings:
    mode = VersionPolicyMode.WHITELIST.value

    def version_mode(self) -> str:
        return self.mode

    def version_migration_required(self) -> bool:
        return False

    def max_versions_per_file(self) -> int:
        return 50

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return ()

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
    root = Path(tempfile.mkdtemp(prefix="version-management-"))
    try:
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        content = ContentService(registry, catalog)
        project = registry.create("版本管理")
        target = Path(project.root) / "resources" / "notes.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("v1\n", encoding="utf-8")
        settings = VersionSettings()
        retention = ResourceRetentionService(content, settings)
        versions = ResourceVersionService(
            content,
            retention,
            WorkbenchFormatPolicy(),
            PdfRecordStore(content),
        )
        first = versions.ensure_initial(project.id, "resources/notes.md").version
        target.write_text("v2\n", encoding="utf-8")
        second = versions.seal(
            project.id, "resources/notes.md", VersionOrigin.EXTERNAL_CONFIRMED
        ).version

        app = FastAPI()
        app.state.resource_versions = versions
        register_version_routes(app)
        client = TestClient(app)

        alias_response = client.patch(
            f"/api/resource/versions/{first.id}/metadata",
            params={"project": project.id},
            headers={"Idempotency-Key": "alias-v1"},
            json={"alias": "首版说明", "expected_revision": 0},
        )
        alias_version = alias_response.json().get("version", {})
        check(
            "alias is mutable presentation metadata",
            alias_response.status_code == 200
            and alias_version.get("alias") == "首版说明"
            and alias_version.get("metadata_revision") == 1
            and alias_version.get("sequence") == 1
            and alias_version.get("object_id") == first.object_id,
            alias_response.text,
        )

        replay = client.patch(
            f"/api/resource/versions/{first.id}/metadata",
            params={"project": project.id},
            headers={"Idempotency-Key": "alias-v1"},
            json={"alias": "首版说明", "expected_revision": 0},
        )
        check(
            "alias update is idempotent",
            replay.status_code == 200 and replay.json() == alias_response.json(),
            replay.text,
        )

        stale_alias = client.patch(
            f"/api/resource/versions/{first.id}/metadata",
            params={"project": project.id},
            headers={"Idempotency-Key": "alias-v1-stale"},
            json={"alias": "过期写入", "expected_revision": 0},
        )
        check(
            "alias compare-and-swap rejects stale revision",
            stale_alias.status_code == 409
            and stale_alias.json().get("error", {}).get("code") == "version_metadata_conflict",
            stale_alias.text,
        )

        filtered = client.get(
            f"/api/resource/files/{first.file_id}/versions",
            params={"project": project.id, "q": "首版", "order": "oldest"},
        )
        check(
            "history search includes aliases and reports total",
            filtered.status_code == 200
            and filtered.json().get("total") == 1
            and [item.get("sequence") for item in filtered.json().get("versions", [])] == [1],
            filtered.text,
        )

        current_preview = client.post(
            f"/api/resource/versions/{second.id}/delete/preview",
            params={"project": project.id},
        )
        check(
            "current version cannot be deleted",
            current_preview.status_code == 200
            and current_preview.json().get("deletable") is False
            and "current_version" in current_preview.json().get("blockers", []),
            current_preview.text,
        )

        delete_preview = client.post(
            f"/api/resource/versions/{first.id}/delete/preview",
            params={"project": project.id},
        )
        preview = delete_preview.json()
        check(
            "old version deletion returns an exact preflight token",
            delete_preview.status_code == 200
            and preview.get("deletable") is True
            and bool(preview.get("preflight_token")),
            delete_preview.text,
        )
        deleted = client.request(
            "DELETE",
            f"/api/resource/versions/{first.id}",
            params={"project": project.id},
            headers={"Idempotency-Key": "delete-v1"},
            json={"preflight_token": preview.get("preflight_token")},
        )
        check(
            "confirmed deletion frees one history slot",
            deleted.status_code == 200
            and deleted.json().get("deleted") is True
            and deleted.json().get("remaining_count") == 1,
            deleted.text,
        )

        target.write_text("v3\n", encoding="utf-8")
        third = versions.seal(
            project.id, "resources/notes.md", VersionOrigin.EXTERNAL_CONFIRMED
        ).version
        check(
            "deletion never renumbers or reuses sequence",
            third.sequence == 3
            and [item.sequence for item in versions.history_for_file(project.id, first.file_id)]
            == [3, 2],
        )
    finally:
        shutil.rmtree(root)
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
