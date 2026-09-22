"""GC must never delete a CAS object still pinned by a terminal restore member.

Regression for Bug 86886990. ``VersionStore.plan_gc`` built its live-object set
from every non-cascading foreign key referrer, but filtered ``resources_restore_members``
by ``restores.state IN ('prepared','applying','needs_attention')``. Restore rows are
never pruned and their object foreign keys carry no ``ON DELETE CASCADE``, so once a
restore reached a terminal state (``committed``/``conflicted``/``aborted``) the objects
its members referenced were left unprotected. When such an object also became
unreachable from versions and passed the GC grace window, ``DELETE FROM
resources_objects`` raised ``sqlite3.IntegrityError: FOREIGN KEY constraint failed``
inside ``plan_gc``. Because ``GET /api/resource/tree`` runs activation (and therefore
GC) before reading, the whole resource tree 500'd: the project showed no directory and
re-imports hung in the "settling" state forever.

The second contract pins the resilience boundary: activation is a read prerequisite,
while GC is best-effort maintenance, so a GC failure must not block project activation.
"""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import unittest
from pathlib import Path
from typing import Callable

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE, PROJECT_VERSIONS_RELATIVE
from service.platform.resources import RestorePolicy, VersionOrigin
from service.resources.persistence.objects import CasEntryKind, CasStore
from service.resources.service.activation import ResourceActivation
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

POLL_SECONDS = 0.05
WAIT_SECONDS = 20


class _Settings:
    """Newest-2 versioning so an ordinary seal expires the object under test."""

    def max_versions_per_file(self) -> int:
        return 2

    def max_version_file_size_kb(self) -> int:
        return 1024

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return ()

    def version_include_patterns(self) -> tuple[str, ...] | None:
        return None

    def version_mode(self) -> str:
        return "whitelist"

    def version_migration_required(self) -> bool:
        return False

    def set_file_version_settings(
        self,
        max_versions_per_file: int,
        include_patterns: tuple[str, ...],
        ignore_patterns: tuple[str, ...],
        mode: str = "whitelist",
        *,
        max_file_size_kb: int = 1024,
    ) -> None:
        del max_versions_per_file, include_patterns, ignore_patterns, mode, max_file_size_kb


class _FailingRetention:
    """Stands in for a retention service whose GC pass blows up.

    Activation only ever calls ``collect`` on retention, so this isolates the
    resilience boundary without touching the real recovery steps.
    """

    def collect(self, project_id: str) -> int:
        del project_id
        raise sqlite3.IntegrityError("FOREIGN KEY constraint failed")


async def _eventually(predicate: Callable[[], bool]) -> None:
    async with asyncio.timeout(WAIT_SECONDS):
        while not predicate():
            await asyncio.sleep(POLL_SECONDS)


class _ResourceFixture:
    """Real file-backed content/version/recovery/retention stack for one project."""

    def __init__(self, temporary: tempfile.TemporaryDirectory[str]) -> None:
        root = Path(temporary.name)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog)
        self.project = registry.create("GC 恢复对象")
        self.target = Path(self.project.root) / "resources" / "notes.md"
        self.target.parent.mkdir(parents=True, exist_ok=True)
        self.settings = _Settings()
        self.formats = WorkbenchFormatPolicy()
        self.annotations = PdfRecordStore(self.content)
        self.retention = ResourceRetentionService(self.content, self.settings)
        self.versions = ResourceVersionService(
            self.content, self.retention, self.formats, self.annotations
        )
        self.recovery = ResourceRecoveryService(self.content, self.retention, self.annotations)

    def seal(self, text: str):
        self.target.write_text(text, encoding="utf-8")
        return self.versions.seal(self.project.id, "resources/notes.md", VersionOrigin.USER).version

    def database(self) -> str:
        return self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)

    def cas(self) -> CasStore:
        return CasStore(self.content.resolve(self.project.id, PROJECT_VERSIONS_RELATIVE))


class RestoreMemberGcContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="resource-gc-restore-fk-")
        self.fixture = _ResourceFixture(self.temporary)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_terminal_restore_member_object_survives_gc(self) -> None:
        fixture = self.fixture
        fixture.seal("version 1\n")
        pinned = fixture.seal("version 2\n")

        history = fixture.versions.history(fixture.project.id, "resources/notes.md")
        preview = fixture.recovery.preview_version(fixture.project.id, history[-1].id)
        fixture.recovery.restore_version(
            fixture.project.id,
            history[-1].id,
            RestorePolicy.STRICT,
            preview.preflight_token,
        )

        # Expire the version that referenced ``pinned`` so it is unreachable from
        # versions but still referenced by the now-committed restore member.
        fixture.seal("version 3\n")
        fixture.retention.enforce(fixture.project.id)

        before_object = pinned.object_id
        assert before_object is not None
        with sqlite3.connect(fixture.database()) as connection:
            restore_states = [
                str(row[0]) for row in connection.execute("SELECT state FROM resources_restores")
            ]
            pinned_by_member = connection.execute(
                "SELECT count(*) FROM resources_restore_members WHERE before_object_id = ?",
                (before_object,),
            ).fetchone()[0]
            reachable_from_versions = connection.execute(
                "SELECT count(*) FROM resources_versions WHERE object_id = ?",
                (before_object,),
            ).fetchone()[0]
        self.assertIn("committed", restore_states, "expected a terminal committed restore")
        self.assertEqual(
            pinned_by_member, 1, "expected the committed restore member to pin the object"
        )
        self.assertEqual(
            reachable_from_versions, 0, "expected the pinned object to be version-unreachable"
        )

        # First pass marks the unreachable object trashed; second pass (grace 0) deletes it.
        fixture.retention.collect(fixture.project.id, grace_ms=0)
        fixture.retention.collect(fixture.project.id, grace_ms=0)

        self.assertIn(
            before_object,
            fixture.cas().inventory(CasEntryKind.OBJECT),
            "GC must preserve an object still referenced by a terminal restore member",
        )


class ActivationGcResilienceContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="resource-gc-resilience-")
        self.fixture = _ResourceFixture(self.temporary)
        self.fixture.seal("stable bytes\n")
        self.supervisor = ResourceVersionSupervisor(
            self.fixture.content, self.fixture.versions, self.fixture.formats, self.fixture.settings
        )

    async def asyncTearDown(self) -> None:
        await self.supervisor.aclose()
        self.temporary.cleanup()

    async def test_gc_failure_does_not_block_project_activation(self) -> None:
        fixture = self.fixture
        deliveries = ResourceDeliveryService(fixture.content, fixture.versions, self.supervisor)
        self.supervisor.bind_preparation(
            ResourceActivation(
                fixture.content,
                fixture.recovery,
                fixture.versions,
                deliveries,
                _FailingRetention(),
                ResourceReviewMigration(fixture.content, fixture.versions),
            )
        )
        await self.supervisor.start()
        # Must not raise even though the GC pass fails; the project stays readable.
        await self.supervisor.activate_project(fixture.project.id)
        await _eventually(
            lambda: bool(fixture.versions.history(fixture.project.id, "resources/notes.md"))
        )
        version = fixture.versions.history(fixture.project.id, "resources/notes.md")[0]
        self.assertEqual(
            fixture.versions.read(fixture.project.id, version.id)[0], b"stable bytes\n"
        )


if __name__ == "__main__":
    unittest.main()
