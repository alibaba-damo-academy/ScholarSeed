"""Version-pair isolation against real project storage, retention and CAS failures."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from unittest.mock import patch

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE, PROJECT_VERSIONS_RELATIVE
from service.platform.activity import Activities
from service.platform.resources import ResourceVersionReadError, VersionOrigin
from service.resources.persistence.objects import (
    CHUNK_PREFERRED_MIN_BYTES,
    CasLayout,
    CasStore,
)
from service.resources.service.history import ResourceVersionService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

WAIT_SECONDS = 5


class Settings:
    limit = 50

    def max_versions_per_file(self) -> int:
        return self.limit

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


class VersionPairContracts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="version-pair-")
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "catalog.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog, activities=Activities())
        self.project = registry.create("Pair contracts")
        self.settings = Settings()
        self.retention = ResourceRetentionService(self.content, self.settings)
        self.versions = ResourceVersionService(
            self.content, self.retention, WorkbenchFormatPolicy(), PdfRecordStore(self.content)
        )

    def seal(self, payload: bytes, path: str = "resources/test.docx"):
        target = Path(self.project.root) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        return self.versions.seal(self.project.id, path, VersionOrigin.USER).version

    def test_different_files_rejected_even_for_identical_bytes(self):
        before = self.seal(b"same")
        after = self.seal(b"same", "resources/other.docx")
        with self.assertRaises(ResourceVersionReadError) as error:
            self.versions.read_pair(self.project.id, before.id, after.id)
        self.assertEqual(error.exception.code, "version_file_mismatch")

    def test_tombstone_rejected_before_object_read(self):
        before, after = self.seal(b"before"), self.seal(b"after")
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE resources_versions SET file_state = ?, object_id = NULL WHERE version_id = ?",
                ("tombstone", after.id),
            )
        with self.assertRaises(ResourceVersionReadError) as error:
            self.versions.read_pair(self.project.id, before.id, after.id)
        self.assertEqual(error.exception.code, "version_is_tombstone")

    def test_pair_outlives_retention_without_pinning_sources(self):
        before, after = self.seal(b"before"), self.seal(b"after")
        pair = self.versions.read_pair(self.project.id, before.id, after.id)
        self.settings.limit = 1
        self.retention.enforce(self.project.id)
        self.assertEqual((pair.before.content, pair.after.content), (b"before", b"after"))
        with self.assertRaises(ResourceVersionReadError) as error:
            self.versions.read_pair(self.project.id, before.id, after.id)
        self.assertEqual(error.exception.code, "version_not_found")

    def test_retention_cannot_enter_between_the_two_reads(self):
        before, after = self.seal(b"before"), self.seal(b"after")
        reading, release, attempted, finished = Event(), Event(), Event(), Event()
        original = CasStore.open

        def paused_open(cas, object_id):
            result = original(cas, object_id)
            if object_id == before.object_id:
                reading.set()
                if not release.wait(WAIT_SECONDS):
                    raise TimeoutError("test did not release pair read")
            return result

        def retain():
            self.settings.limit = 1
            attempted.set()
            self.retention.enforce(self.project.id)
            finished.set()

        with patch.object(CasStore, "open", paused_open), ThreadPoolExecutor(2) as executor:
            read = executor.submit(self.versions.read_pair, self.project.id, before.id, after.id)
            try:
                self.assertTrue(reading.wait(WAIT_SECONDS))
                cleanup = executor.submit(retain)
                self.assertTrue(attempted.wait(WAIT_SECONDS))
                self.assertFalse(finished.is_set())
            finally:
                release.set()
            pair = read.result(WAIT_SECONDS)
            cleanup.result(WAIT_SECONDS)
        self.assertTrue(finished.is_set())
        self.assertEqual((pair.before.content, pair.after.content), (b"before", b"after"))
        self.assertEqual(len(self.versions.history(self.project.id, before.path)), 1)

    def test_corrupt_second_object_does_not_return_partial_pair(self):
        before, after = self.seal(b"before"), self.seal(b"after")
        root = self.content.resolve(self.project.id, PROJECT_VERSIONS_RELATIVE)
        object_directory = next(
            Path(root).glob(f"cas/v1/objects/sha256/*/{after.object_id.split(':')[1]}")
        )
        (object_directory / "payload").write_bytes(b"corrupt")
        with self.assertRaises(ResourceVersionReadError) as error:
            self.versions.read_pair(self.project.id, before.id, after.id)
        self.assertEqual(error.exception.code, "resource_versions_unavailable")

    def test_chunked_bytes_use_the_same_snapshot_contract(self):
        previous = b"a" * CHUNK_PREFERRED_MIN_BYTES
        current = b"b" + previous[1:]
        before, after = self.seal(previous), self.seal(current)
        cas = CasStore(self.content.resolve(self.project.id, PROJECT_VERSIONS_RELATIVE))
        self.assertEqual(cas.verify(before.object_id).layout, CasLayout.CHUNKED)
        pair = self.versions.read_pair(self.project.id, before.id, after.id)
        self.assertEqual((pair.before.content, pair.after.content), (previous, current))


if __name__ == "__main__":
    unittest.main()
