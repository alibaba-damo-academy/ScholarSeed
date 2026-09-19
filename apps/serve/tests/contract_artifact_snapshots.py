"""Real file-backed immutable object contracts, not UI/product acceptance."""

from __future__ import annotations

import os
import tempfile
import unittest
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service import snapshot
from service.content.service.native import publish_descriptor
from service.content.service.port import ContentService, ProjectRegistry
from service.content.service.snapshot import (
    INTEGRITY_MISMATCH,
    MAX_ARTIFACT_BYTES,
    SOURCE_CHANGED,
    TOO_LARGE,
)
from service.paths import PROJECT_ARTIFACT_OBJECTS_RELATIVE
from service.platform.content import ArtifactScope, ArtifactScopeKind


class ArtifactSnapshotContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="artifact-snapshot-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.workspace = self.base / "project"
        self.workspace.mkdir()
        catalog = ContentCatalog(self.base / "content.sqlite3")
        registry = ProjectRegistry(str(self.workspace), catalog)
        self.project = registry.seed_workspace()
        self.scope = ArtifactScope(ArtifactScopeKind.PROJECT, self.project.id)
        self.content = ContentService(registry, catalog)

    def test_versions_survive_rewrite_delete_and_service_reopen(self):
        source = self.workspace / "报告.csv"
        source.write_bytes(b"a,b\n1,2\n")
        first = self.content.capture_artifact(self.scope, source.name)
        source.write_bytes(b"a,b\n3,4\n")
        second = self.content.capture_artifact(self.scope, source.name)
        self.assertNotEqual(first.sha256, second.sha256)
        source.unlink()
        catalog = ContentCatalog(self.base / "content.sqlite3")
        restored = ContentService(ProjectRegistry(str(self.workspace), catalog), catalog)
        self.assertEqual(restored.read_artifact(first), b"a,b\n1,2\n")
        self.assertEqual(restored.read_artifact(second), b"a,b\n3,4\n")
        self.assertEqual(first.name, "报告.csv")
        self.assertEqual(first.media_type, "text/csv")
        self.assertEqual(first.size, 8)

    def test_dedup_does_not_overwrite_objects(self):
        source = self.workspace / "report.md"
        source.write_bytes(b"report")
        first = self.content.capture_artifact(self.scope, source.name)
        obj = self.workspace / PROJECT_ARTIFACT_OBJECTS_RELATIVE / first.sha256
        inode = obj.stat().st_ino
        second = self.content.capture_artifact(self.scope, source.name)
        self.assertEqual(first, second)
        self.assertEqual(obj.stat().st_ino, inode)
        self.assertEqual(list(obj.parent.iterdir()), [obj])

    def test_wrong_expected_revision_leaves_no_object(self):
        (self.workspace / "report.md").write_bytes(b"new")
        with self.assertRaisesRegex(ContentError, SOURCE_CHANGED):
            self.content.capture_artifact(self.scope, "report.md", sha256(b"old").hexdigest())
        self.assertEqual(list((self.workspace / PROJECT_ARTIFACT_OBJECTS_RELATIVE).iterdir()), [])

    def test_corrupt_object_is_not_repaired_from_working_file(self):
        (self.workspace / "report.md").write_bytes(b"report")
        handle = self.content.capture_artifact(self.scope, "report.md")
        obj = self.workspace / PROJECT_ARTIFACT_OBJECTS_RELATIVE / handle.sha256
        obj.chmod(0o600)
        obj.write_bytes(b"broken")
        with self.assertRaisesRegex(ContentError, INTEGRITY_MISMATCH):
            self.content.read_artifact(handle)
        with self.assertRaisesRegex(ContentError, INTEGRITY_MISMATCH):
            self.content.capture_artifact(self.scope, "report.md")
        self.assertEqual(obj.read_bytes(), b"broken")
        self.assertEqual(list(obj.parent.iterdir()), [obj])

    def test_escape_source_and_object_symlinks_rejected(self):
        outside = self.base / "secret.md"
        outside.write_bytes(b"private")
        (self.workspace / "escape.md").symlink_to(outside)
        for path in ("../secret.md", str(outside), "escape.md"):
            with self.subTest(path=path), self.assertRaises(ContentError):
                self.content.capture_artifact(self.scope, path)
        (self.workspace / "report.md").write_bytes(b"report")
        handle = self.content.capture_artifact(self.scope, "report.md")
        obj = self.workspace / PROJECT_ARTIFACT_OBJECTS_RELATIVE / handle.sha256
        obj.unlink()
        obj.symlink_to(outside)
        with self.assertRaises(ContentError):
            self.content.read_artifact(handle)
        with self.assertRaises(ContentError):
            self.content.read_artifact(replace(handle, sha256="../secret.md"))
        self.assertEqual(outside.read_bytes(), b"private")

    def test_snapshot_directory_cannot_redirect_outside_project(self):
        (self.workspace / "report.md").write_bytes(b"report")
        external = self.base / "external"
        external.mkdir()
        (self.workspace / ".scholarseed").symlink_to(external, target_is_directory=True)
        with self.assertRaises(ContentError):
            self.content.capture_artifact(self.scope, "report.md")
        self.assertEqual(list(external.iterdir()), [])

    def test_source_mutation_during_capture_rejects_incomplete_revision(self):
        source = self.workspace / "report.md"
        source.write_bytes(b"first")
        original = snapshot.os.fchmod

        def mutate_source(descriptor, mode):
            source.write_bytes(b"second version")
            original(descriptor, mode)

        # Deterministic scheduling seam; the source mutation and object store are real.
        with patch.object(snapshot.os, "fchmod", side_effect=mutate_source):
            with self.assertRaisesRegex(ContentError, SOURCE_CHANGED):
                self.content.capture_artifact(self.scope, source.name)
        objects = self.workspace / PROJECT_ARTIFACT_OBJECTS_RELATIVE
        self.assertEqual(list(objects.iterdir()), [])
        self.assertEqual(source.read_bytes(), b"second version")

    def test_oversized_source_is_rejected_before_copy(self):
        source = self.workspace / "large.bin"
        with source.open("wb") as stream:
            stream.truncate(MAX_ARTIFACT_BYTES + 1)
        with self.assertRaisesRegex(ContentError, TOO_LARGE):
            self.content.capture_artifact(self.scope, source.name)
        self.assertFalse((self.workspace / PROJECT_ARTIFACT_OBJECTS_RELATIVE).exists())

    def test_snapshot_stage_swap_never_installs_unverified_object(self):
        source = self.workspace / "report.md"
        source.write_bytes(b"trusted")
        replacement = self.workspace / "replacement.bin"
        replacement.write_bytes(b"unverified")
        objects = self.workspace / PROJECT_ARTIFACT_OBJECTS_RELATIVE
        changed = []

        def swap_then_publish(descriptor, directory, name):
            stage = next(objects.glob(".capture-*"))
            changed.append(stage)
            replacement.replace(stage)
            return publish_descriptor(descriptor, directory, name)

        with patch(
            "service.content.service.snapshot.publish_descriptor", side_effect=swap_then_publish
        ) as publish:
            with self.assertRaises(ContentError):
                self.content.capture_artifact(self.scope, source.name)
        publish.assert_called_once()
        self.assertEqual(changed[0].read_bytes(), b"unverified")
        target = objects / sha256(b"trusted").hexdigest()
        if target.exists():
            self.assertEqual(target.read_bytes(), b"trusted")

    def test_capture_syncs_the_final_object_inode(self):
        (self.workspace / "report.md").write_bytes(b"trusted")
        synced = []
        sync = os.fsync

        def record_sync(descriptor):
            identity = os.fstat(descriptor)
            synced.append((identity.st_dev, identity.st_ino))
            sync(descriptor)

        with patch("service.content.service.snapshot.os.fsync", side_effect=record_sync):
            handle = self.content.capture_artifact(self.scope, "report.md")
        identity = (self.workspace / PROJECT_ARTIFACT_OBJECTS_RELATIVE / handle.sha256).stat()
        self.assertIn((identity.st_dev, identity.st_ino), synced)


if __name__ == "__main__":
    unittest.main()
