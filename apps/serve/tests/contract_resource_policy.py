"""Single-mode version admission contracts."""

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.service import settings as settings_module
from service.chat.service.settings import SettingsService
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.activity import Activities
from service.platform.resources import VERSION_MAX_BYTES, ManagementState
from service.resources.api.settings import register_version_setting_routes
from service.resources.domain.policy import AdmissionPolicy, VersionMode
from service.resources.service.history import ResourceVersionService
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore


def check_projected_policy_snapshot() -> None:
    defaults = ("*.md",)
    cases = (
        ({}, "notes.md", False, ManagementState.MANAGED),
        (
            {settings_module.VERSION_INCLUDE_PATTERNS_KEY: []},
            "notes.md",
            False,
            ManagementState.MIGRATION_REQUIRED,
        ),
        (
            {
                settings_module.VERSION_MODE_KEY: "whitelist",
                settings_module.VERSION_INCLUDE_PATTERNS_KEY: [],
            },
            "notes.md",
            False,
            ManagementState.UNSUPPORTED,
        ),
        (
            {
                settings_module.VERSION_MODE_KEY: "blacklist",
                settings_module.VERSION_IGNORE_PATTERNS_KEY: [" *.log ", ""],
            },
            "debug.log",
            False,
            ManagementState.IGNORED,
        ),
        (
            {
                settings_module.VERSION_MODE_KEY: "blacklist",
                settings_module.VERSION_IGNORE_PATTERNS_KEY: ["*.log"],
            },
            "debug.log",
            True,
            ManagementState.MANAGED,
        ),
        (
            {settings_module.VERSION_POLICY_MIGRATION_KEY: True},
            "notes.md",
            False,
            ManagementState.MIGRATION_REQUIRED,
        ),
        (
            {settings_module.VERSION_POLICY_MIGRATION_KEY: True},
            "notes.md",
            True,
            ManagementState.MANAGED,
        ),
    )
    settings = SettingsService(environ={})
    for values, path, manual, expected in cases:
        original = json.dumps(values, sort_keys=True)
        policy = SettingsService.version_policy_values(values)
        with patch.object(SettingsService, "_read", return_value=values):
            assert policy.mode == settings.version_mode()
            assert policy.include_patterns == settings.version_include_patterns()
            assert policy.ignore_patterns == settings.version_ignore_patterns()
            assert policy.migration_required == settings.version_migration_required()
        assert policy.classify(path, 1, manual=manual, default_patterns=defaults) is expected
        assert (
            policy.classify(path, policy.max_size_bytes + 1, manual=True, default_patterns=defaults)
            is ManagementState.OVERSIZED
        )
        assert json.dumps(values, sort_keys=True) == original


def check_legacy_default_migration() -> None:
    with tempfile.TemporaryDirectory(prefix="legacy-default-policy-") as temporary:
        root = Path(temporary)
        original = settings_module.SERVE_SETTINGS_FILE
        settings_module.SERVE_SETTINGS_FILE = root / "settings.json"
        try:
            settings_module.SERVE_SETTINGS_FILE.write_text(
                json.dumps({"default_permission_mode": "ask"}), encoding="utf-8"
            )
            settings = SettingsService(environ={})
            workspace = root / "workspace"
            workspace.mkdir()
            catalog = ContentCatalog(root / "content.sqlite3")
            registry = ProjectRegistry(str(workspace), catalog)
            content = ContentService(registry, catalog, activities=Activities())
            project = registry.create("legacy defaults")
            resources = Path(project.root) / "resources"
            (resources / "notes.md").write_text("old archived notes", encoding="utf-8")
            retention = ResourceRetentionService(content, settings)
            versions = ResourceVersionService(
                content, retention, WorkbenchFormatPolicy(), PdfRecordStore(content)
            )
            versions.ensure_initial(project.id, "resources/notes.md")
            (resources / "custom.raw").write_bytes(b"already manually managed")
            revision = content.stable_snapshot(
                project.id, "resources/custom.raw", VERSION_MAX_BYTES
            ).revision
            versions.admit(project.id, "resources/custom.raw", revision, "legacy-manual-admission")
            assert versions.manual_admitted(project.id, "resources/custom.raw")
            (resources / "server.log").write_text("previously ignored log", encoding="utf-8")
            (resources / "gitignored.md").write_text("previously gitignored", encoding="utf-8")
            (resources / ".gitignore").write_text("gitignored.md", encoding="utf-8")
            settings.initialize(existing_projects=bool(content.projects()))
            assert settings.version_migration_required()
            assert SettingsService(environ={}).version_migration_required()
            supervisor = ResourceVersionSupervisor(
                content,
                versions,
                WorkbenchFormatPolicy(),
                settings,
                activities=Activities(),
            )
            assert supervisor.version_include_patterns() == supervisor.common_version_patterns()
            assert supervisor.scan_project(project.id).created == 0
            assert versions.history(project.id, "resources/server.log") == ()
            assert versions.history(project.id, "resources/gitignored.md") == ()
            app = FastAPI()
            register_version_setting_routes(
                app, settings=settings, retention=retention, supervisor=supervisor
            )
            client = TestClient(app)
            payload = {
                "mode": "whitelist",
                "max_versions_per_file": 50,
                "include_patterns": supervisor.common_version_patterns(),
                "ignore_patterns": settings.version_ignore_patterns(),
            }
            preview = client.post("/api/serve/settings/file-versions/preview", json=payload)
            assert preview.status_code == 200, preview.text
            assert "resources/custom.raw" not in {
                entry["path"] for entry in preview.json()["removed_paths"]
            }
            assert {entry["path"] for entry in preview.json()["added_paths"]} == {
                "resources/server.log",
                "resources/gitignored.md",
            }
            assert client.post("/api/serve/settings/file-versions", json=payload).status_code == 200
            assert not settings.version_migration_required()
            assert versions.history(project.id, "resources/server.log") == ()
            assert versions.history(project.id, "resources/gitignored.md") == ()
            assert supervisor.scan_project(project.id).created == 2
            assert len(versions.history(project.id, "resources/notes.md")) == 1
            settings_module.SERVE_SETTINGS_FILE.unlink()
            fresh = SettingsService(environ={})
            fresh.initialize(existing_projects=False)
            fresh.initialize(existing_projects=True)
            assert not fresh.version_migration_required()
            assert fresh.version_mode() == "whitelist"
            fresh_supervisor = ResourceVersionSupervisor(
                content,
                versions,
                WorkbenchFormatPolicy(),
                fresh,
                activities=Activities(),
            )
            assert (
                fresh_supervisor.version_include_patterns()
                == fresh_supervisor.common_version_patterns()
            )
        finally:
            settings_module.SERVE_SETTINGS_FILE = original


def main() -> int:
    white = AdmissionPolicy(VersionMode.WHITELIST, ("*.md",), ("*.md",))
    assert white.classify("notes.md", 1) is ManagementState.MANAGED
    assert white.classify("blob.custom", 1) is ManagementState.UNSUPPORTED
    black = AdmissionPolicy(VersionMode.BLACKLIST, (), ("*.custom",))
    assert black.classify("notes.md", 1) is ManagementState.MANAGED
    assert black.classify("blob.custom", 1) is ManagementState.IGNORED
    assert black.classify("blob.custom", 1, manual=True) is ManagementState.MANAGED
    assert (
        black.classify("blob.custom", VERSION_MAX_BYTES + 1, manual=True)
        is ManagementState.OVERSIZED
    )
    assert (
        AdmissionPolicy(
            VersionMode.BLACKLIST,
            (),
            (),
            max_size_bytes=1024,
        ).classify("blob.custom", 1025)
        is ManagementState.OVERSIZED
    )
    assert (
        AdmissionPolicy(VersionMode.WHITELIST, (), ()).classify("notes.md", 1)
        is ManagementState.UNSUPPORTED
    )
    assert (
        AdmissionPolicy(VersionMode.BLACKLIST, (), ()).classify("blob.custom", 1)
        is ManagementState.MANAGED
    )
    with tempfile.TemporaryDirectory(prefix="resource-policy-") as temporary:
        root = Path(temporary)
        original = settings_module.SERVE_SETTINGS_FILE
        settings_module.SERVE_SETTINGS_FILE = root / "settings.json"
        try:
            settings = SettingsService(environ={})
            assert settings.version_include_patterns() is None
            assert not settings.version_migration_required()
            settings_module.SERVE_SETTINGS_FILE.write_text(
                json.dumps(
                    {
                        "file_version_include": ["*.md"],
                        "file_version_ignore": ["excluded.md"],
                    }
                ),
                encoding="utf-8",
            )
            assert settings.version_migration_required()
            workspace = root / "workspace"
            workspace.mkdir()
            catalog = ContentCatalog(root / "content.sqlite3")
            registry = ProjectRegistry(str(workspace), catalog)
            content = ContentService(registry, catalog, activities=Activities())
            project = registry.create("policy")
            resources = Path(project.root) / "resources"
            resources.mkdir(exist_ok=True)
            (resources / "excluded.md").write_text("excluded", encoding="utf-8")
            (resources / "git.md").write_text("git excluded", encoding="utf-8")
            (resources / ".gitignore").write_text("git.md", encoding="utf-8")
            (resources / "unknown.custom").write_bytes(b"raw bytes")
            retention = ResourceRetentionService(content, settings)
            versions = ResourceVersionService(
                content, retention, WorkbenchFormatPolicy(), PdfRecordStore(content)
            )
            supervisor = ResourceVersionSupervisor(
                content,
                versions,
                WorkbenchFormatPolicy(),
                settings,
                activities=Activities(),
            )
            assert (
                supervisor.admission_state(project.id, "resources/git.md")
                is ManagementState.MIGRATION_REQUIRED
            )
            assert (
                supervisor.admission_state(project.id, ".scholarseed/service/project.sqlite3")
                is ManagementState.UNAVAILABLE
            )
            assert supervisor.scan_project(project.id).created == 0
            app = FastAPI()
            register_version_setting_routes(
                app, settings=settings, retention=retention, supervisor=supervisor
            )
            client = TestClient(app)
            payload = {
                "mode": "whitelist",
                "max_versions_per_file": 50,
                "include_patterns": ["*.md"],
                "ignore_patterns": ["excluded.md"],
            }
            preview = client.post("/api/serve/settings/file-versions/preview", json=payload)
            assert preview.status_code == 200, preview.text
            assert {entry["path"] for entry in preview.json()["added_paths"]} == {
                "resources/excluded.md",
                "resources/git.md",
            }
            assert client.post("/api/serve/settings/file-versions", json=payload).status_code == 200
            assert not settings.version_migration_required()
            (resources / "new.md").write_text("changed impact", encoding="utf-8")
            (resources / ".gitignore").write_text("git.md\nnew.md", encoding="utf-8")
            assert "file_version_policy_legacy" in json.loads(
                settings_module.SERVE_SETTINGS_FILE.read_text()
            )
            assert (
                supervisor.admission_state(project.id, "resources/excluded.md")
                is ManagementState.MANAGED
            )
            empty = {**payload, "include_patterns": []}
            assert client.post("/api/serve/settings/file-versions", json=empty).status_code == 200
            assert settings.version_include_patterns() == ()
            assert supervisor.version_include_patterns() == ()
            black = {**empty, "mode": "blacklist", "ignore_patterns": []}
            assert client.post("/api/serve/settings/file-versions", json=black).status_code == 200
            assert (
                supervisor.admission_state(project.id, "resources/unknown.custom")
                is ManagementState.MANAGED
            )
        finally:
            settings_module.SERVE_SETTINGS_FILE = original
    check_legacy_default_migration()
    check_projected_policy_snapshot()
    print("single-mode admission and configuration-only migration contracts passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
