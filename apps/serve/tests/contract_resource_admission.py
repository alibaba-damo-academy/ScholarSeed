"""Manual admission contracts with real Content, CAS and project ledger."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.activity import Activities
from service.platform.resources import PendingOrigin, VersionOrigin, VersionPolicyMode
from service.resources.api.versions import RESOURCE_ADMISSION_ROUTE, register_version_routes
from service.resources.service.history import ResourceVersionError, ResourceVersionService
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore


class Settings:
    def version_mode(self):
        return VersionPolicyMode.WHITELIST.value

    def version_migration_required(self):
        return False

    def version_include_patterns(self):
        return ("*.md",)

    def version_ignore_patterns(self):
        return ()

    def max_versions_per_file(self):
        return 50

    def max_version_file_size_kb(self):
        return 1024


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "catalog.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog, activities=Activities())
        self.project = registry.create("admission")
        self.path = "resources/data.unknown"
        self.disk = Path(self.project.root) / self.path
        self.disk.parent.mkdir(parents=True, exist_ok=True)
        self.disk.write_bytes(b"initial bytes")
        self.service = ResourceVersionService(
            self.content,
            ResourceRetentionService(self.content, Settings()),
            WorkbenchFormatPolicy(),
            PdfRecordStore(self.content),
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_admit_repeat_revision_and_move(self):
        revision = self.content.stable_snapshot(self.project.id, self.path, 1024).revision
        result = self.service.admit(self.project.id, self.path, revision, "request")
        self.assertEqual(result.version.sequence, 1)
        self.assertTrue(self.service.manual_admitted(self.project.id, self.path))
        self.assertEqual(
            self.service.admit(self.project.id, self.path, revision, "request"), result
        )
        self.assertTrue(
            self.service.admit(self.project.id, self.path, revision, "another").unchanged
        )
        self.assertEqual(len(self.service.history(self.project.id, self.path)), 1)
        with self.assertRaises(ResourceVersionError):
            self.service.admit(self.project.id, self.path, "stale", "request")
        moved = "resources/moved.unknown"
        self.disk.rename(Path(self.project.root) / moved)
        self.service.record_moves(self.project.id, ((self.path, moved),))
        self.assertTrue(self.service.manual_admitted(self.project.id, moved))
        self.assertFalse(self.service.manual_admitted(self.project.id, self.path))

    def test_existing_pending_is_preserved(self):
        self.service.ensure_initial(self.project.id, self.path)
        self.disk.write_bytes(b"changed")
        self.service.record_changes(self.project.id, (self.path,))
        before = self.service.capability(self.project.id, self.path)
        revision = self.content.stable_snapshot(self.project.id, self.path, 1024).revision
        self.service.admit(self.project.id, self.path, revision, "existing")
        after = self.service.capability(self.project.id, self.path)
        self.assertEqual(before.pending, after.pending)
        self.assertEqual(len(self.service.history(self.project.id, self.path)), 1)

    def test_copy_and_replacement_do_not_inherit_selection(self):
        revision = self.content.stable_snapshot(self.project.id, self.path, 1024).revision
        self.service.admit(self.project.id, self.path, revision, "original")
        copied = "resources/copy.unknown"
        (Path(self.project.root) / copied).write_bytes(self.disk.read_bytes())
        self.service.record_changes(self.project.id, (copied,))
        self.assertFalse(self.service.manual_admitted(self.project.id, copied))
        self.disk.unlink()
        self.service.record_changes(self.project.id, (self.path,))
        self.disk.write_bytes(b"new file")
        self.service.record_changes(self.project.id, (self.path,))
        self.assertFalse(self.service.manual_admitted(self.project.id, self.path))

    def test_manual_unknown_file_edits_follow_shared_policy(self):
        supervisor = ResourceVersionSupervisor(
            self.content,
            self.service,
            WorkbenchFormatPolicy(),
            Settings(),
            activities=Activities(),
        )
        self.service.bind_admission_policy(supervisor)
        app = FastAPI()
        app.state.resource_versions = self.service
        app.state.resource_version_supervisor = supervisor
        register_version_routes(app)
        client = TestClient(app)
        fence = client.get(
            "/api/resource/capability", params={"project": self.project.id, "path": self.path}
        )
        self.assertEqual(fence.status_code, 200, fence.text)
        self.assertIsNotNone(fence.json()["disk_revision"])
        admitted = client.post(
            RESOURCE_ADMISSION_ROUTE,
            params={"project": self.project.id},
            headers={"Idempotency-Key": "unknown"},
            json={"path": self.path, "expected_disk_revision": fence.json()["disk_revision"]},
        )
        self.assertEqual(admitted.status_code, 200, admitted.text)
        self.assertFalse(admitted.json()["capability"]["can_preview_history"])
        self.disk.write_bytes(b"edited unknown bytes")
        self.service.record_changes(self.project.id, (self.path,))
        capability = self.service.capability(self.project.id, self.path)
        self.assertIsNotNone(capability.pending)
        self.assertEqual(len(self.service.history(self.project.id, self.path)), 1)
        result = self.service.seal(self.project.id, self.path, VersionOrigin.USER)
        self.assertEqual(result.version.sequence, 2)
        self.assertEqual(
            self.service.read(self.project.id, result.version.id)[0], b"edited unknown bytes"
        )

    def test_external_deletion_recreation_does_not_inherit(self):
        revision = self.content.stable_snapshot(self.project.id, self.path, 1024).revision
        self.service.admit(self.project.id, self.path, revision, "external")
        self.disk.unlink()
        self.service.observe(self.project.id, self.path)
        self.disk.write_bytes(b"recreated externally")
        self.service.observe(self.project.id, self.path)
        self.assertFalse(self.service.manual_admitted(self.project.id, self.path))

    def test_pending_without_history_is_not_accepted(self):
        self.service._accept_working(self.project.id, None, self.path, PendingOrigin.AGENT)
        identity = self.service.capability(self.project.id, self.path)
        revision = self.content.stable_snapshot(self.project.id, self.path, 1024).revision
        self.assertIsNone(self.service.admit(self.project.id, self.path, revision, "pending"))
        self.assertEqual(self.service.history(self.project.id, self.path), ())
        self.assertEqual(
            identity.pending, self.service.capability(self.project.id, self.path).pending
        )

    def test_public_api_and_semantic_replay_conflicts(self):
        app = FastAPI()
        app.state.resource_versions = self.service
        register_version_routes(app)
        client = TestClient(app)
        revision = self.content.stable_snapshot(self.project.id, self.path, 1024).revision
        url = RESOURCE_ADMISSION_ROUTE + "?project=" + self.project.id
        body = {"path": self.path, "expected_disk_revision": revision}
        self.assertEqual(client.post(url, json=body).status_code, 400)
        response = client.post(url, json=body, headers={"Idempotency-Key": "api"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["capability"]["manual_admitted"])
        self.assertEqual(response.json()["version"]["sequence"], 1)
        repeated = client.post(url, json=body, headers={"Idempotency-Key": "api"})
        self.assertEqual(response.json(), repeated.json())
        conflict = client.post(
            url,
            json={**body, "path": "resources/other.unknown"},
            headers={"Idempotency-Key": "api"},
        )
        self.assertEqual(conflict.status_code, 409)
        stale = client.post(
            url,
            json={**body, "expected_disk_revision": "stale"},
            headers={"Idempotency-Key": "stale"},
        )
        self.assertEqual(stale.status_code, 412)
        forbidden = client.post(
            url, json={**body, "path": "../escape"}, headers={"Idempotency-Key": "escape"}
        )
        self.assertNotEqual(forbidden.status_code, 200)

    def test_disk_changed_during_publication_has_no_admission(self):
        revision = self.content.stable_snapshot(self.project.id, self.path, 1024).revision
        original = self.content.snapshot

        def race(project, path):
            self.disk.write_bytes(b"raced bytes")
            return original(project, path)

        with patch.object(self.content, "snapshot", side_effect=race) as final_read:
            with self.assertRaises(ResourceVersionError):
                self.service.admit(self.project.id, self.path, revision, "race")
        final_read.assert_called_once_with(self.project.id, self.path)
        self.assertEqual(self.disk.read_bytes(), b"raced bytes")
        self.assertFalse(self.service.manual_admitted(self.project.id, self.path))
        self.assertEqual(self.service.history(self.project.id, self.path), ())


def main():
    result = unittest.TextTestRunner().run(
        unittest.defaultTestLoader.loadTestsFromTestCase(AdmissionTests)
    )
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
