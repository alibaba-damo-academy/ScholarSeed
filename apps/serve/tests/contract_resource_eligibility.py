"""Version eligibility is not evidence of file deletion."""

from __future__ import annotations

import os
import tempfile
import unittest
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.enumeration import scan_files
from service.content.service.port import ContentService, ProjectRegistry
from service.content.service.space import Mount, ProjectSpace
from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import ProjectDatabasePath, transaction
from service.platform.activity import Activities
from service.platform.content import RootKind
from service.platform.resources import (
    VERSION_MAX_BYTES,
    ManagementState,
    ReviewConflict,
    TurnOutcome,
    VersionOrigin,
)
from service.resources.persistence.version import VersionStore, VersionStoreConflict
from service.resources.service.activation import ResourceActivation
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionError, ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore


class Settings:
    mode = "whitelist"
    ignores: tuple[str, ...] = ()

    def set_blacklist(self, patterns: str) -> None:
        self.mode = "blacklist"
        self.ignores = tuple(patterns.splitlines())

    def max_versions_per_file(self) -> int:
        return 50

    def max_version_file_size_kb(self) -> int:
        return 1024

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return self.ignores

    def version_mode(self) -> str:
        return self.mode

    def version_migration_required(self) -> bool:
        return False

    def version_include_patterns(self) -> tuple[str, ...] | None:
        return None


class EligibilityContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="resource-eligibility-")
        root = Path(self.temporary.name)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog, activities=Activities())
        self.project = registry.create("纳管边界")
        self.resources = Path(self.project.root) / "resources"
        self.path = "resources/notes.md"
        self.target = self.resources / "notes.md"
        self.target.write_text("initial\n", encoding="utf-8")
        settings = self.settings = Settings()
        formats = WorkbenchFormatPolicy()
        self.retention = ResourceRetentionService(self.content, settings)
        annotations = PdfRecordStore(self.content)
        self.versions = ResourceVersionService(
            self.content,
            self.retention,
            formats,
            annotations,
        )
        self.supervisor = ResourceVersionSupervisor(
            self.content, self.versions, formats, settings, activities=Activities()
        )
        self.deliveries = ResourceDeliveryService(
            self.content, self.versions, self.supervisor, activities=self.supervisor._activities
        )
        self.supervisor.bind_preparation(
            ResourceActivation(
                self.content,
                ResourceRecoveryService(self.content, self.retention, annotations),
                self.versions,
                self.deliveries,
                self.retention,
                ResourceReviewMigration(self.content, self.versions),
            )
        )
        self.supervisor.scan_project(self.project.id)

    async def asyncTearDown(self) -> None:
        await self.supervisor.aclose()
        self.temporary.cleanup()

    async def test_owned_session_directory_does_not_reclassify_resources(self) -> None:
        self.content.bind_resource_changes(self.supervisor)
        root = self.content.root(self.project.id, RootKind.SESSIONS)
        with patch.object(
            self.supervisor, "_eligible", side_effect=AssertionError("unrelated scan")
        ):
            created = self.content.ensure_directory(self.project.id, root.path, "new-session")
        self.assertTrue(Path(self.content.resolve(self.project.id, created.path)).is_dir())

    async def test_batch_eligibility_reads_manual_state_once(self) -> None:
        (self.resources / "second.md").write_text("second", encoding="utf-8")
        with (
            patch.object(
                self.versions, "manual_admitted_states", wraps=self.versions.manual_admitted_states
            ) as batch,
            patch.object(
                self.versions, "manual_admitted", side_effect=AssertionError("per-file query")
            ),
            patch.object(self.settings, "version_mode", wraps=self.settings.version_mode) as mode,
        ):
            eligible = self.supervisor.eligible_paths(self.project.id)
        self.assertIn(self.path, eligible)
        self.assertEqual(batch.call_count, 1)
        self.assertEqual(mode.call_count, 1)

    async def test_write_only_walks_changed_subtree_and_keeps_siblings(self) -> None:
        changed = self.resources / "changed"
        sibling = self.resources / "sibling"
        changed.mkdir()
        sibling.mkdir()
        (changed / "one.md").write_text("changed", encoding="utf-8")
        (sibling / "two.md").write_text("sibling", encoding="utf-8")
        self.supervisor.record_changes(self.project.id, ("resources/sibling",))
        with patch("service.content.service.enumeration.os.walk", wraps=os.walk) as walk:
            self.supervisor.record_changes(self.project.id, ("resources/changed",))
        self.assertEqual([Path(call.args[0]) for call in walk.call_args_list], [changed])
        self.assertTrue(self.versions.history(self.project.id, "resources/changed/one.md"))
        self.assertTrue(self.versions.history(self.project.id, "resources/sibling/two.md"))

    async def test_scoped_scan_excludes_hidden_and_owned_directories(self) -> None:
        hidden = self.resources / ".hidden"
        hidden.mkdir()
        (hidden / "secret.md").write_text("hidden", encoding="utf-8")
        owned = self.content.root(self.project.id, RootKind.SESSIONS)
        Path(self.content.resolve(self.project.id, owned.path), "internal.md").write_text(
            "internal", encoding="utf-8"
        )
        self.assertEqual(
            self.content.scan_resources(self.project.id, paths=("resources/.hidden", owned.path)),
            (),
        )
        self.assertIn(
            self.path,
            {entry.path for entry in self.content.scan_resources(self.project.id, paths=("",))},
        )

    async def test_scoped_scan_includes_virtual_mounts_below_changed_parent(self) -> None:
        external = Path(self.temporary.name) / "external"
        external.mkdir()
        (external / "linked.md").write_text("linked", encoding="utf-8")
        scope = ProjectSpace(self.project, (Mount("resources/virtual/linked", external),))
        entries = scan_files(scope, paths=("resources/virtual",))
        self.assertEqual(
            tuple(entry.path for entry in entries), ("resources/virtual/linked/linked.md",)
        )
        self.assertEqual(scan_files(scope, paths=("resources/virtual-neighbor",)), ())

    async def begin(self) -> None:
        await self.deliveries.begin_turn("session", "turn", self.project.root)
        await self.deliveries.bind_turn("session", "turn", "vendor", "generation")

    async def hint(self, path: Path, kind: str = "update") -> None:
        await self.deliveries.record_change(
            "session", "vendor", str(path), kind, generation="generation"
        )

    async def finish(self):
        return await self.deliveries.finish_turn("session", "turn", TurnOutcome.COMPLETED)

    def store(self) -> VersionStore:
        return VersionStore(
            self.content.resolve(self.project.id, PROJECT_DB_RELATIVE), self.project.root
        )

    def captured_paths(self, result) -> list[str]:
        return [self.store().working_snapshot(file_id).path for file_id in result.file_ids]

    def oversized(self, path: Path) -> None:
        with path.open("wb") as stream:
            stream.truncate(VERSION_MAX_BYTES + 1)

    async def test_pdf_changes_do_not_join_mixed_review_or_lose_versions(self) -> None:
        pdf = self.resources / "source.pdf"
        pdf.write_bytes(b"%PDF-1.4\ninitial\n")
        self.supervisor.scan_project(self.project.id)
        initial = self.versions.history(self.project.id, "resources/source.pdf")
        self.assertEqual(len(initial), 1)
        await self.begin()
        self.assertNotIn(
            "resources/source.pdf",
            [
                entry.path
                for entry in self.versions.turn_baselines(self.project.id, "session", "turn")
            ],
        )
        pdf.write_bytes(b"%PDF-1.4\nchanged\n")
        self.target.write_text("agent\n", encoding="utf-8")
        await self.hint(pdf)
        await self.hint(self.target)
        with patch.object(
            self.versions, "capture_agent", wraps=self.versions.capture_agent
        ) as capture:
            result = await self.finish()
        self.assertEqual(self.captured_paths(result), [self.path])
        self.assertNotIn("resources/source.pdf", [call.args[1] for call in capture.call_args_list])
        saved = self.versions.seal(self.project.id, "resources/source.pdf", VersionOrigin.USER)
        self.assertFalse(saved.unchanged)
        self.assertEqual(len(self.versions.history(self.project.id, "resources/source.pdf")), 2)
        self.assertEqual(pdf.read_bytes(), b"%PDF-1.4\nchanged\n")
        chunks, media_type, size = self.versions.content(self.project.id, saved.version.id)
        self.assertEqual(b"".join(chunks), pdf.read_bytes())
        self.assertEqual(media_type, "application/pdf")
        self.assertEqual(size, pdf.stat().st_size)

    async def test_unreadable_pdf_does_not_block_baseline_or_mixed_review(self) -> None:
        pdf = self.resources / "source.pdf"
        pdf.write_bytes(b"%PDF-1.4\ninitial\n")
        self.supervisor.scan_project(self.project.id)
        capture = self.content.capture_stable

        def capture_readable(project_id, path, maximum, target):
            if path == "resources/source.pdf":
                raise ContentError("read_failed")
            return capture(project_id, path, maximum, target)

        with patch.object(self.content, "capture_stable", side_effect=capture_readable):
            await self.begin()
            self.target.write_text("agent\n", encoding="utf-8")
            await self.hint(self.target)
            result = await self.finish()
        self.assertEqual(self.captured_paths(result), [self.path])
        self.assertEqual(
            self.deliveries.finalizations(self.project.id, "session", cursor=None, limit=20),
            ((), None),
        )

    async def test_pdf_only_changes_leave_no_review_or_finalization_warning(self) -> None:
        pdf = self.resources / "source.pdf"
        pdf.write_bytes(b"%PDF-1.4\ninitial\n")
        await self.begin()
        pdf.unlink()
        added = self.resources / "added.pdf"
        added.write_bytes(b"%PDF-1.4\nnew\n")
        await self.hint(pdf, "delete")
        await self.hint(added, "create")
        result = await self.finish()
        self.assertFalse(result.review_ids)
        self.assertEqual(
            self.deliveries.finalizations(self.project.id, "session", cursor=None, limit=20),
            ((), None),
        )

    async def test_python_environment_paths_are_not_reviewable(self) -> None:
        paths = (
            ".scholarseed/python/commands/python",
            ".scholarseed/python/prepare.lock",
            ".scholarseed/python/environment.json",
            ".scholarseed/python/venv/lib/site-packages/package.py",
            "sessions/task/.scholarseed/python/venv/Lib/site-packages/package.py",
            "sessions/task/.scholarseed/python/venv/Scripts/python.exe",
        )
        for path in paths:
            with self.subTest(path=path):
                self.assertFalse(self.versions.reviewable(path))
        self.assertTrue(self.versions.reviewable("resources/python/example.py"))
        self.assertFalse(self.versions.reviewable("resources/source.PDF"))

    async def test_python_environment_cannot_join_mixed_capture_through_inventory(self) -> None:
        path = "sessions/task/.scholarseed/python/environment.json"
        target = Path(self.project.root) / path
        target.parent.mkdir(parents=True)
        target.write_text("{}", encoding="utf-8")
        self.versions.ensure_initial(self.project.id, path)
        eligible = (*self.supervisor.eligible_paths(self.project.id), path)
        with patch.object(self.supervisor, "eligible_paths", return_value=eligible):
            await self.begin()
            target.write_text('{"changed": true}', encoding="utf-8")
            self.target.write_text("agent\n", encoding="utf-8")
            await self.hint(target)
            await self.hint(self.target)
            result = await self.finish()
        self.assertEqual(self.captured_paths(result), [self.path])
        self.assertNotIn(
            path,
            [
                entry.path
                for entry in self.versions.turn_baselines(self.project.id, "session", "turn")
            ],
        )

    async def test_unmanaged_oversized_file_does_not_block_small_delivery(self) -> None:
        large = self.resources / "large.md"
        self.oversized(large)
        self.assertNotIn("resources/large.md", self.supervisor.eligible_paths(self.project.id))
        await self.begin()
        self.target.write_text("agent\n", encoding="utf-8")
        await self.hint(self.target)
        result = await self.finish()
        self.assertEqual(self.captured_paths(result), [self.path])
        self.assertEqual(self.versions.history(self.project.id, "resources/large.md"), ())

    async def test_failed_publication_retries_frozen_bytes_after_restart(self) -> None:
        await self.begin()
        self.target.write_text("terminal bytes\n", encoding="utf-8")
        terminal_bytes = self.target.read_bytes()
        await self.hint(self.target)
        with patch.object(
            VersionStore, "finalize_review", side_effect=RuntimeError("publish failed")
        ):
            with self.assertRaisesRegex(RuntimeError, "publish failed"):
                await self.finish()
        self.assertEqual(self.versions.turn_state(self.project.id, "session", "turn"), "finalizing")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)
        self.target.write_text("later external bytes\n", encoding="utf-8")
        rebuilt = ResourceDeliveryService(
            self.content, self.versions, self.supervisor, activities=self.supervisor._activities
        )
        rebuilt.recover_project(self.project.id, self.project.root)
        history = self.versions.history(self.project.id, self.path)
        self.assertEqual(len(history), 1)
        self.assertEqual(
            self.store().pending(history[0].file_id).review.candidate.object_id,
            "sha256:" + sha256(terminal_bytes).hexdigest(),
        )
        self.assertEqual(self.target.read_text(), "later external bytes\n")
        rebuilt.recover_project(self.project.id, self.project.root)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_failed_capture_unblocks_unrelated_discovery_without_recapture(self) -> None:
        await self.begin()
        new = self.resources / "failed.md"
        new.write_text("unarchived\n", encoding="utf-8")
        await self.hint(new, "create")
        with patch.object(self.content, "capture_stable", side_effect=ContentError("read_failed")):
            with self.assertRaisesRegex(ContentError, "read_failed"):
                await self.finish()
        unrelated = self.resources / "external.md"
        unrelated.write_text("external\n", encoding="utf-8")
        self.supervisor.scan_project(self.project.id)
        self.assertEqual(len(self.versions.history(self.project.id, "resources/external.md")), 1)
        self.assertEqual(self.versions.history(self.project.id, "resources/failed.md"), ())
        with self.assertRaisesRegex(VersionStoreConflict, "terminal_snapshot_unavailable"):
            await self.finish()
        self.assertEqual(self.versions.history(self.project.id, "resources/failed.md"), ())

    async def test_conflicting_terminal_cannot_discard_staged_success(self) -> None:
        await self.begin()
        self.target.write_text("terminal\n", encoding="utf-8")
        await self.hint(self.target)
        with patch.object(
            VersionStore, "finalize_review", side_effect=RuntimeError("publish failed")
        ):
            with self.assertRaises(RuntimeError):
                await self.finish()
        with self.assertRaisesRegex(VersionStoreConflict, "terminal_outcome_conflict"):
            await self.deliveries.finish_turn("session", "turn", TurnOutcome.FAILED)
        result = await self.finish()
        self.assertTrue(result.review_ids)

    async def test_frozen_replay_does_not_overwrite_newer_accepted_head(self) -> None:
        await self.begin()
        self.target.write_text("terminal\n", encoding="utf-8")
        await self.hint(self.target)
        with patch.object(
            VersionStore, "finalize_review", side_effect=RuntimeError("publish failed")
        ):
            with self.assertRaises(RuntimeError):
                await self.finish()
        self.target.write_text("newer accepted edit\n", encoding="utf-8")
        self.versions.seal(self.project.id, self.path, VersionOrigin.USER)
        before = self.versions.capability(self.project.id, self.path)
        with self.assertRaisesRegex(VersionStoreConflict, "terminal_head_conflict"):
            await self.finish()
        self.assertEqual(self.versions.capability(self.project.id, self.path), before)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 2)

    async def test_pending_new_file_identity_and_objects_survive_scan_and_gc(self) -> None:
        await self.begin()
        new = self.resources / "staged.md"
        new.write_text("frozen new bytes\n", encoding="utf-8")
        await self.hint(new, "create")
        with patch.object(
            VersionStore, "finalize_review", side_effect=RuntimeError("publish failed")
        ):
            with self.assertRaises(RuntimeError):
                await self.finish()
        store = VersionStore(
            self.content.resolve(self.project.id, PROJECT_DB_RELATIVE), self.project.root
        )
        staged = store.staged_delivery("session", "turn")
        self.assertIsNotNone(staged)
        assert staged is not None
        object_id = staged[0].snapshot.object_id
        assert object_id is not None
        new.write_text("later disk content\n", encoding="utf-8")
        self.supervisor.scan_project(self.project.id)
        for now_ms in (100, 200, 300):
            self.retention.collect(self.project.id, now_ms=now_ms, grace_ms=0)
        self.versions.verify_object(self.project.id, object_id)
        result = await self.finish()
        self.assertEqual(result.file_ids[0], staged[0].baseline.file_id)
        self.assertEqual(
            store.pending(result.file_ids[0]).review.candidate.object_id,
            object_id,
        )
        self.assertIsNone(store.staged_delivery("session", "turn"))
        with transaction(
            ProjectDatabasePath(
                Path(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)),
                Path(self.project.root),
            )
        ) as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM resources_turn_objects").fetchone()[0], 0
            )

    async def test_terminal_reads_body_only_once_before_freezing(self) -> None:
        await self.begin()
        self.target.write_text("once\n", encoding="utf-8")
        await self.hint(self.target)
        with patch.object(
            self.content, "capture_stable", wraps=self.content.capture_stable
        ) as capture:
            result = await self.finish()
        self.assertTrue(result.review_ids)
        self.assertEqual(capture.call_count, 1)

    async def test_completed_ledger_without_receipt_cannot_accept_failure(self) -> None:
        await self.begin()
        await self.finish()
        with transaction(
            ProjectDatabasePath(
                Path(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)),
                Path(self.project.root),
            )
        ) as connection:
            connection.execute("UPDATE resources_turns SET terminal_outcome = NULL")
        with self.assertRaisesRegex(VersionStoreConflict, "terminal_outcome_conflict"):
            await self.deliveries.finish_turn("session", "turn", TurnOutcome.FAILED)

    async def test_unknown_ledger_without_receipt_cannot_capture_later_bytes(self) -> None:
        await self.begin()
        await self.hint(self.target)
        with transaction(
            ProjectDatabasePath(
                Path(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)),
                Path(self.project.root),
            )
        ) as connection:
            connection.execute("UPDATE resources_turns SET state = 'unknown'")
        self.target.write_text("later bytes\n", encoding="utf-8")
        with self.assertRaisesRegex(VersionStoreConflict, "terminal_snapshot_unavailable"):
            await self.finish()
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_managed_file_becoming_large_does_not_block_admission(self) -> None:
        self.oversized(self.target)
        await self.begin()
        new = self.resources / "new.md"
        new.write_text("agent\n", encoding="utf-8")
        await self.hint(new, "create")
        result = await self.finish()
        self.assertEqual(self.captured_paths(result), ["resources/new.md"])
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_new_ignore_rule_is_not_a_deletion(self) -> None:
        await self.begin()
        self.target.write_text("agent but now ignored\n", encoding="utf-8")
        await self.hint(self.target)
        self.settings.set_blacklist("notes.md\n")
        result = await self.finish()
        self.assertFalse(result.file_ids)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)
        self.assertTrue(self.target.exists())

    async def test_capability_disables_new_versions_but_preserves_ignored_history(self) -> None:
        self.settings.set_blacklist("notes.md\n")
        ignored = self.supervisor.capability(self.project.id, self.path)
        self.assertEqual(ignored.management_state, ManagementState.IGNORED)
        self.assertFalse(ignored.can_version)
        self.assertTrue(ignored.can_preview_history)
        self.assertIsNotNone(ignored.file_id)

        self.settings.set_blacklist("")
        self.target.write_text("external after unignore\n", encoding="utf-8")
        managed = self.supervisor.capability(self.project.id, self.path)
        self.assertEqual(managed.management_state, ManagementState.MANAGED)
        self.assertTrue(managed.can_version)
        self.assertFalse(managed.drifted)
        self.assertEqual(managed.pending.origin.value, "external")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_capability_exposes_oversized_and_unsupported_states(self) -> None:
        self.oversized(self.target)
        oversized = self.supervisor.capability(self.project.id, self.path)
        self.assertEqual(oversized.management_state, ManagementState.OVERSIZED)
        self.assertFalse(oversized.can_version)
        archive = self.resources / "archive.zip"
        archive.write_bytes(b"not a supported workbench document")
        unsupported = self.supervisor.capability(self.project.id, "resources/archive.zip")
        self.assertEqual(unsupported.management_state, ManagementState.UNSUPPORTED)
        self.assertFalse(unsupported.can_version)

    async def test_spreadsheets_are_managed_version_formats(self) -> None:
        for name in ("results.csv", "results.xlsx"):
            path = self.resources / name
            path.write_bytes(b"spreadsheet")
            capability = self.supervisor.capability(self.project.id, f"resources/{name}")
            self.assertEqual(capability.management_state, ManagementState.MANAGED)
            self.assertTrue(capability.can_version)

    async def test_file_becoming_large_during_turn_is_not_a_deletion(self) -> None:
        await self.begin()
        self.oversized(self.target)
        await self.hint(self.target)
        result = await self.finish()
        self.assertFalse(result.file_ids)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_real_missing_file_still_creates_tombstone(self) -> None:
        await self.begin()
        self.target.unlink()
        await self.hint(self.target, "delete")
        result = await self.finish()
        self.assertEqual(len(result.file_ids), 1)
        self.assertEqual(
            self.store().pending(result.file_ids[0]).review.candidate.state.value, "tombstone"
        )

    async def test_reappeared_file_is_captured_before_turn_without_new_version(self) -> None:
        original = self.versions.history(self.project.id, self.path)
        for index, text in enumerate(("initial\n", "external replacement\n", "")):
            with self.subTest(text=text):
                self.target.unlink()
                self.versions.record_changes(self.project.id, (self.path,))
                self.target.write_text(text, encoding="utf-8")
                before = self.target.read_bytes()
                turn = f"reappeared-{index}"
                await self.deliveries.begin_turn("session", turn, self.project.root)
                baselines = self.versions.turn_baselines(self.project.id, "session", turn)
                self.assertEqual(len(baselines), 1)
                self.assertEqual(baselines[0].file_id, original[0].file_id)
                self.assertEqual(baselines[0].revision, f"sha256:{sha256(before).hexdigest()}")
                result = await self.deliveries.finish_turn("session", turn, TurnOutcome.COMPLETED)
                self.assertFalse(result.file_ids)
                self.assertEqual(self.versions.history(self.project.id, self.path), original)
                self.assertIsNone(self.store().finalization("session", turn))

    async def test_reappeared_file_review_uses_restored_bytes_not_deleted_head(self) -> None:
        self.target.unlink()
        self.versions.record_changes(self.project.id, (self.path,))
        self.target.write_text("external before\n", encoding="utf-8")
        before = self.target.read_bytes()
        await self.begin()
        self.target.write_text("agent after\n", encoding="utf-8")
        after = self.target.read_bytes()
        await self.hint(self.target)
        result = await self.finish()
        self.assertEqual(len(result.file_ids), 1)
        review = self.store().pending(result.file_ids[0]).review
        self.assertEqual(review.base.state.value, "present")
        self.assertEqual(review.base.object_id, "sha256:" + sha256(before).hexdigest())
        self.assertEqual(review.candidate.object_id, "sha256:" + sha256(after).hexdigest())
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_deleted_file_still_missing_is_not_resurrected_at_admission(self) -> None:
        self.target.unlink()
        self.versions.record_changes(self.project.id, (self.path,))
        await self.begin()
        self.assertFalse(self.versions.turn_baselines(self.project.id, "session", "turn"))
        result = await self.finish()
        self.assertFalse(result.file_ids)
        self.assertFalse(self.target.exists())
        self.assertEqual(
            self.store()
            .working_snapshot(self.versions.history(self.project.id, self.path)[0].file_id)
            .state.value,
            "tombstone",
        )

    async def test_reappeared_file_does_not_overwrite_pending_deletion_review(self) -> None:
        await self.begin()
        self.target.unlink()
        await self.hint(self.target, "delete")
        result = await self.finish()
        pending = self.store().pending(result.file_ids[0])
        self.target.write_text("external resurrection\n", encoding="utf-8")
        with self.assertRaisesRegex(ResourceVersionError, ReviewConflict.CANDIDATE_REVISION.value):
            await self.deliveries.begin_turn("session", "next", self.project.root)
        self.assertEqual(self.store().pending(result.file_ids[0]), pending)
        self.assertIsNone(self.store().turn_state("session", "next"))

    async def test_exact_size_limit_is_eligible(self) -> None:
        self.settings.max_version_file_size_kb = lambda: VERSION_MAX_BYTES // 1024
        with self.target.open("wb") as stream:
            stream.truncate(VERSION_MAX_BYTES)
        self.assertIn(self.path, self.supervisor.eligible_paths(self.project.id))

    async def test_ignored_history_is_not_read_into_turn_baselines(self) -> None:
        self.settings.set_blacklist("notes.md\n")
        await self.begin()
        self.assertEqual(self.versions.turn_baselines(self.project.id, "session", "turn"), ())
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_read_failure_is_not_a_tombstone_or_silent_success(self) -> None:
        await self.begin()
        await self.hint(self.target)
        with patch.object(self.content, "capture_stable", side_effect=ContentError("read_failed")):
            with self.assertRaisesRegex(ContentError, "read_failed"):
                await self.finish()
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_unignored_existing_history_is_not_misclassified_as_created(self) -> None:
        self.settings.set_blacklist("notes.md\n")
        await self.begin()
        self.settings.set_blacklist("")
        self.target.write_text("agent after unignore\n", encoding="utf-8")
        await self.hint(self.target)
        with self.assertRaisesRegex(VersionStoreConflict, "turn_baseline_unavailable"):
            await self.finish()
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_untracked_existing_file_is_not_created_after_service_reconstruction(
        self,
    ) -> None:
        self.settings.set_blacklist("untracked.md\n")
        existing = self.resources / "untracked.md"
        existing.write_text("existing ignored bytes\n", encoding="utf-8")
        await self.begin()
        self.settings.set_blacklist("")
        existing.write_text("agent changed bytes\n", encoding="utf-8")
        await self.hint(existing)
        self.deliveries = ResourceDeliveryService(
            self.content, self.versions, self.supervisor, activities=self.supervisor._activities
        )
        with self.assertRaisesRegex(VersionStoreConflict, "turn_baseline_unavailable"):
            await self.finish()
        self.assertEqual(self.versions.history(self.project.id, "resources/untracked.md"), ())

    async def test_shrunk_preexisting_file_cannot_create_a_destructive_revert(self) -> None:
        self.oversized(self.target)
        await self.begin()
        self.target.write_text("agent shrank old file\n", encoding="utf-8")
        await self.hint(self.target)
        with self.assertRaisesRegex(VersionStoreConflict, "turn_baseline_unavailable"):
            await self.finish()
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_move_over_excluded_existing_destination_requires_its_before_state(self) -> None:
        self.settings.set_blacklist("destination.md\n")
        destination = self.resources / "destination.md"
        destination.write_text("prior destination\n", encoding="utf-8")
        await self.begin()
        self.settings.set_blacklist("")
        destination.write_bytes(self.target.read_bytes())
        self.target.unlink()
        await self.hint(self.target, "delete")
        await self.hint(destination, "create")
        with self.assertRaisesRegex(VersionStoreConflict, "turn_baseline_unavailable"):
            await self.finish()
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_legacy_turn_without_inventory_does_not_guess_creation(self) -> None:
        await self.begin()
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        with transaction(
            ProjectDatabasePath(Path(database), Path(self.project.root))
        ) as connection:
            connection.execute("UPDATE resources_turns SET initial_paths_json = NULL")
        new = self.resources / "new.md"
        new.write_text("new after legacy admission\n", encoding="utf-8")
        await self.hint(new, "create")
        with self.assertRaisesRegex(VersionStoreConflict, "turn_baseline_unavailable"):
            await self.finish()
        self.assertEqual(self.versions.history(self.project.id, "resources/new.md"), ())

    async def test_repeated_admission_preserves_the_original_inventory(self) -> None:
        await self.begin()
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        store = VersionStore(database, self.project.root)
        inventory = store.turn_inventory("session", "turn")
        (self.resources / "later.md").write_text("later\n", encoding="utf-8")
        await self.deliveries.begin_turn("session", "turn", self.project.root)
        self.assertEqual(store.turn_inventory("session", "turn"), inventory)

    async def test_missing_baseline_blocks_every_member_without_partial_versions(self) -> None:
        self.settings.set_blacklist("excluded.md\n")
        excluded = self.resources / "excluded.md"
        excluded.write_text("excluded before\n", encoding="utf-8")
        await self.begin()
        self.target.write_text("safe change\n", encoding="utf-8")
        await self.hint(self.target)
        excluded.write_text("unknown before\n", encoding="utf-8")
        await self.hint(excluded)
        self.settings.set_blacklist("")
        with self.assertRaisesRegex(VersionStoreConflict, "turn_baseline_unavailable"):
            await self.finish()
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)
        self.assertEqual(self.versions.history(self.project.id, "resources/excluded.md"), ())


if __name__ == "__main__":
    unittest.main()
