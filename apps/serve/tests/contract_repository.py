"""Git ownership contracts with real repositories and file-backed ledgers."""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.activity import Activities
from service.platform.content import ImportMode
from service.platform.resources import ManagementState, RestorePolicy, VersionOrigin
from service.resources.api.routes import register_resource_routes
from service.resources.service.history import ResourceVersionError, ResourceVersionService
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryError, ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

from .contract_resource_versions import VersionSettings


class RepositoryContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="repository-contract-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        workspace = self.root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(self.root / "content.sqlite3")
        self.registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(self.registry, catalog, activities=Activities())
        self.project = self.registry.create("Git资料")
        self.resources = Path(self.project.root) / "resources"
        self.repo = self.resources / "代码"
        self.repo.mkdir()
        subprocess.run(["git", "init", str(self.repo)], check=True, capture_output=True)
        self.path = "resources/代码/notes.md"
        (self.repo / "notes.md").write_text("initial\n", encoding="utf-8")
        settings = VersionSettings()
        formats = WorkbenchFormatPolicy()
        self.versions = ResourceVersionService(
            self.content,
            ResourceRetentionService(self.content, settings),
            formats,
            PdfRecordStore(self.content),
        )
        self.supervisor = ResourceVersionSupervisor(
            self.content, self.versions, formats, settings, activities=Activities()
        )
        self.versions.bind_admission_policy(self.supervisor)

    def test_discovery_and_direct_mutations_exclude_git(self) -> None:
        (self.resources / "ordinary.md").write_text("ordinary", encoding="utf-8")
        self.supervisor.scan_project(self.project.id)
        self.assertEqual(self.versions.history(self.project.id, self.path), ())
        self.assertEqual(len(self.versions.history(self.project.id, "resources/ordinary.md")), 1)
        self.assertEqual(
            self.supervisor.capability(self.project.id, self.path).management_state,
            ManagementState.GIT,
        )
        self.assertIsNone(self.versions.ensure_initial(self.project.id, self.path))
        revision = self.content.stable_snapshot(self.project.id, self.path, 1024).revision
        for mutate in (
            lambda: self.versions.admit(self.project.id, self.path, revision, "manual"),
            lambda: self.versions.seal(self.project.id, self.path, VersionOrigin.USER),
        ):
            with self.assertRaises(ResourceVersionError):
                mutate()
        receipt = self.versions.commit_working(
            self.project.id, self.path, b"edited\n", revision, "save"
        )
        self.assertEqual(
            receipt.revision,
            self.content.stable_snapshot(self.project.id, self.path, 1024).revision,
        )
        self.assertEqual((self.repo / "notes.md").read_bytes(), b"edited\n")
        self.assertEqual(self.versions.history(self.project.id, self.path), ())
        self.assertFalse(self.versions.is_managed(self.project.id, self.path))

    def test_old_history_frozen_after_repository_appears(self) -> None:
        shutil.rmtree(self.repo / ".git")
        first = self.versions.ensure_initial(self.project.id, self.path)
        before = self.versions.pending(self.project.id, first.version.file_id)
        subprocess.run(["git", "init", str(self.repo)], check=True, capture_output=True)
        revision = self.content.stable_snapshot(self.project.id, self.path, 1024).revision
        self.versions.commit_working(self.project.id, self.path, b"new\n", revision, "old-save")
        self.versions.record_changes(self.project.id, (self.path,))
        self.assertFalse(self.versions.observe(self.project.id, self.path))
        self.assertEqual(self.versions.history(self.project.id, self.path), (first.version,))
        self.assertEqual(self.versions.pending(self.project.id, first.version.file_id), before)
        (self.repo / "notes.md").unlink()
        self.versions.record_changes(self.project.id, (self.path,))
        self.assertEqual(self.versions.history(self.project.id, self.path), (first.version,))

    def test_gitfile_and_nested_roots_and_missing_paths(self) -> None:
        nested = self.repo / "nested"
        nested.mkdir()
        (nested / ".git").write_text("gitdir: /unavailable/repository\n", encoding="utf-8")
        paths = (
            "resources/代码",
            self.path,
            "resources/代码/nested",
            "resources/代码/nested/gone.md",
        )
        self.assertEqual(
            self.content.repository_roots(self.project.id, paths),
            {
                paths[0]: paths[0],
                paths[1]: paths[0],
                paths[2]: paths[2],
                paths[3]: paths[2],
            },
        )
        self.assertEqual(
            self.content.repository_roots(self.project.id, ("resources/new.md",)),
            {"resources/new.md": None},
        )

    def test_copy_and_link_preserve_ownership_and_grant_boundary(self) -> None:
        external = self.root / "external"
        external.mkdir()
        subprocess.run(["git", "init", str(external)], check=True, capture_output=True)
        (external / "notes.md").write_text("external", encoding="utf-8")
        self.content.bind_resource_changes(self.supervisor)
        copied = self.content.import_sources(
            self.project.id, (str(external),), "resources", ImportMode.COPY
        )[0]
        copied_path = copied.path + "/notes.md"
        self.assertEqual(
            self.content.repository_roots(self.project.id, (copied.path,))[copied.path], copied.path
        )
        self.assertEqual(self.versions.history(self.project.id, copied_path), ())
        linked = self.content.authorize_root(self.project.id, str(external), "linked")
        linked_path = linked.mount_path + "/notes.md"
        self.assertEqual(
            self.content.repository_roots(self.project.id, (linked_path,))[linked_path],
            linked.mount_path,
        )
        subdirectory = external / "subset"
        subdirectory.mkdir()
        (subdirectory / "notes.md").write_text("subset", encoding="utf-8")
        roots = self.content.external_roots(self.project.id)
        with self.assertRaises(ContentError) as failure:
            self.content.authorize_root(self.project.id, str(subdirectory), "subset")
        self.assertEqual(failure.exception.code, "source_overlap")
        self.assertEqual(self.content.external_roots(self.project.id), roots)
        self.assertEqual((subdirectory / "notes.md").read_bytes(), b"subset")
        boundary = self.root / "grant-boundary"
        boundary.mkdir()
        subprocess.run(["git", "init", str(boundary)], check=True, capture_output=True)
        authorized_subset = boundary / "subset"
        authorized_subset.mkdir()
        (authorized_subset / "notes.md").write_text("subset", encoding="utf-8")
        subset = self.content.authorize_root(self.project.id, str(authorized_subset), "isolated")
        subset_path = subset.mount_path + "/notes.md"
        self.assertIsNone(
            self.content.repository_roots(self.project.id, (subset_path,))[subset_path]
        )
        self.supervisor.scan_project(self.project.id)
        self.assertEqual(self.versions.history(self.project.id, copied_path), ())
        self.assertEqual(self.versions.history(self.project.id, linked_path), ())

    def test_repository_discovery_stops_at_the_authorized_root(self) -> None:
        external = self.root / "external"
        external.mkdir()
        subprocess.run(["git", "init", str(external)], check=True, capture_output=True)
        subdirectory = external / "subset"
        subdirectory.mkdir()
        (subdirectory / "notes.md").write_text("subset", encoding="utf-8")
        subset = self.content.authorize_root(self.project.id, str(subdirectory), "subset")
        subset_path = subset.mount_path + "/notes.md"
        paths = (subset.mount_path, subset_path, subset.mount_path + "/missing.md")
        self.assertEqual(
            self.content.repository_roots(self.project.id, paths),
            dict.fromkeys(paths),
        )
        self.assertTrue((external / ".git").is_dir())
        self.assertEqual(len(self.content.external_roots(self.project.id)), 1)
        subprocess.run(["git", "init", str(subdirectory)], check=True, capture_output=True)
        self.assertEqual(
            self.content.repository_roots(self.project.id, paths),
            dict.fromkeys(paths, subset.mount_path),
        )

    def test_restore_cannot_overwrite_git_file(self) -> None:
        shutil.rmtree(self.repo / ".git")
        first = self.versions.ensure_initial(self.project.id, self.path)
        recovery = ResourceRecoveryService(
            self.content,
            ResourceRetentionService(self.content, VersionSettings()),
            PdfRecordStore(self.content),
        )
        preview = recovery.preview_version(self.project.id, first.version.id)
        subprocess.run(["git", "init", str(self.repo)], check=True, capture_output=True)
        with self.assertRaises(ResourceRecoveryError) as failure:
            recovery.restore_version(
                self.project.id, first.version.id, RestorePolicy.STRICT, preview.preflight_token
            )
        self.assertEqual(failure.exception.code, "git_version_disabled")
        self.assertEqual(self.versions.history(self.project.id, self.path), (first.version,))

    def test_tree_marks_only_repository_roots(self) -> None:
        (self.repo / "src").mkdir()
        app = FastAPI()
        app.state.content = self.content
        register_resource_routes(app)
        with TestClient(app) as client:
            response = client.get(
                "/api/resource/tree", params={"project": self.project.id, "depth": 3}
            )
        self.assertEqual(response.status_code, 200, response.text)
        node = next(node for node in response.json()["nodes"] if node["name"] == "代码")
        self.assertTrue(node["git_repository"])
        self.assertTrue(all(not child.get("git_repository") for child in node["children"]))


if __name__ == "__main__":
    unittest.main()
