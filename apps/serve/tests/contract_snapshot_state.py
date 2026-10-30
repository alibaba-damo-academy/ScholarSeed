"""Snapshot archival state uses real project heads, independently of disk drift."""

from __future__ import annotations

import asyncio
import sqlite3
import stat
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import transaction
from service.platform.activity import Activities
from service.platform.resources import (
    VERSION_MAX_BYTES,
    FileState,
    PendingOrigin,
    PendingReview,
    ReviewDecision,
    ReviewOutcome,
    SnapshotState,
    TurnOutcome,
    VersionOrigin,
)
from service.resources.api.routes import register_resource_routes
from service.resources.api.versions import register_version_routes
from service.resources.domain.version import (
    DiskObservation,
    ObservationState,
    SnapshotVersion,
    TurnBaseline,
)
from service.resources.persistence import pending
from service.resources.persistence.version import VersionStore, VersionStoreConflict
from service.resources.service.activation import ResourceActivation
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionError, ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryError, ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore

from .records import pdf_records


class Settings:
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


class SnapshotStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        evidence_path = patch("service.resources.service.events.TRACE_DIR", root / "trace")
        evidence_path.start()
        self.addCleanup(evidence_path.stop)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "catalog.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog, activities=Activities())
        self.project = registry.create("snapshot state")
        self.path = "resources/example.docx"
        self.file = Path(self.project.root) / self.path
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_bytes(b"original complete document bytes")
        self.versions = ResourceVersionService(
            self.content,
            ResourceRetentionService(self.content, Settings()),
            WorkbenchFormatPolicy(),
            PdfRecordStore(self.content),
        )
        self.initial = self.versions.ensure_initial(self.project.id, self.path).version
        self.store = VersionStore(
            self.content.resolve(self.project.id, PROJECT_DB_RELATIVE), self.project.root
        )
        self.recovery = ResourceRecoveryService(
            self.content,
            ResourceRetentionService(self.content, Settings()),
            PdfRecordStore(self.content),
        )

    def _toggle_file_mode(self) -> None:
        before = stat.S_IMODE(self.file.stat().st_mode)
        # Windows chmod exposes the read-only attribute, not executable bits.
        bit = stat.S_IWRITE if sys.platform == "win32" else stat.S_IXUSR
        self.file.chmod(before ^ bit)
        self.assertNotEqual(stat.S_IMODE(self.file.stat().st_mode), before)

    def test_editor_save_creates_a_version_without_external_drift(self) -> None:
        before = self.versions.capability(self.project.id, self.path)
        self.assertEqual(before.snapshot_state, SnapshotState.SAVED)
        self.versions.commit_working(
            self.project.id,
            self.path,
            b"user draft",
            before.working_revision,
            "write-draft",
            automatic_version=True,
        )
        current = self.versions.capability(self.project.id, self.path)
        self.assertFalse(current.drifted)
        self.assertEqual(current.snapshot_state, SnapshotState.SAVED)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 2)
        self.assertEqual(
            self.versions.capability_states(self.project.id, (self.path,))[
                self.path
            ].snapshot_state,
            SnapshotState.SAVED,
        )

    def _save_at(self, timestamp: int, content: bytes, key: str) -> None:
        with patch("service.resources.persistence.version._now_ms", return_value=timestamp):
            self.versions.commit_working(
                self.project.id,
                self.path,
                content,
                self.store.head(self.initial.file_id)[1],
                key,
                automatic_version=True,
            )

    def test_editor_saves_replace_one_version_within_a_fixed_minute(self) -> None:
        started = self.initial.created_at_ms + 1000
        self._save_at(started, b"first save", "minute-first")
        first = self.versions.history(self.project.id, self.path)[0]
        self._save_at(started + 30000, b"second save", "minute-second")
        self._save_at(started + 59999, b"latest save", "minute-latest")
        history = self.versions.history(self.project.id, self.path)
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0].id, first.id)
        self.assertEqual(history[0].sequence, first.sequence)
        self.assertEqual(history[0].created_at_ms, started)
        self.assertEqual(self.versions.read(self.project.id, first.id)[0], b"latest save")
        self.assertEqual(history[1], self.initial)
        self.assertEqual(self.file.read_bytes(), b"latest save")
        self.assertEqual(self.store.snapshot_state(self.initial.file_id), SnapshotState.SAVED)
        self._save_at(started + 60000, b"next minute", "minute-next")
        history = self.versions.history(self.project.id, self.path)
        self.assertEqual([version.sequence for version in history], [3, 2, 1])
        self.assertNotEqual(history[0].id, first.id)
        self.assertEqual(self.versions.read(self.project.id, first.id)[0], b"latest save")

    def test_reopened_service_keeps_the_save_window(self) -> None:
        started = self.initial.created_at_ms + 1000
        self._save_at(started, b"before restart", "restart-first")
        first = self.versions.history(self.project.id, self.path)[0]
        self.versions = ResourceVersionService(
            self.content,
            ResourceRetentionService(self.content, Settings()),
            WorkbenchFormatPolicy(),
            PdfRecordStore(self.content),
        )
        self._save_at(started + 1000, b"after restart", "restart-second")
        history = self.versions.history(self.project.id, self.path)
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0].id, first.id)
        self.assertEqual(self.versions.read(self.project.id, first.id)[0], b"after restart")

    def test_clock_rollback_does_not_overwrite_a_future_version(self) -> None:
        started = self.initial.created_at_ms + 1000
        self._save_at(started, b"first save", "clock-first")
        self._save_at(started - 1, b"clock rollback", "clock-backwards")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 3)

    def test_unchanged_save_and_retry_do_not_extend_the_window(self) -> None:
        started = self.initial.created_at_ms + 1000
        revision = self.store.head(self.initial.file_id)[1]
        self._save_at(started, b"first save", "retry-first")
        first = self.versions.history(self.project.id, self.path)[0]
        with patch("service.resources.persistence.version._now_ms", return_value=started + 1000):
            self.versions.commit_working(
                self.project.id,
                self.path,
                b"first save",
                revision,
                "retry-first",
                automatic_version=True,
            )
        self._save_at(started + 59999, b"first save", "retry-unchanged")
        self.assertEqual(self.versions.history(self.project.id, self.path)[0], first)
        self._save_at(started + 60000, b"next save", "retry-next")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 3)

    def test_interrupted_save_recovers_into_the_existing_minute_version(self) -> None:
        started = self.initial.created_at_ms + 1000
        self._save_at(started, b"first save", "recovery-first")
        first = self.versions.history(self.project.id, self.path)[0]
        with patch.object(
            VersionStore, "commit_working_mutation", side_effect=RuntimeError("interrupted")
        ):
            with self.assertRaises(RuntimeError):
                self._save_at(started + 1000, b"recovered save", "recovery-second")
        with patch("service.resources.persistence.version._now_ms", return_value=started + 2000):
            self.versions.recover_working_mutations(self.project.id)
        history = self.versions.history(self.project.id, self.path)
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0].id, first.id)
        self.assertEqual(self.versions.read(self.project.id, first.id)[0], b"recovered save")
        self.assertEqual(self.store.working_mutation("recovery-second").state, "ledger_committed")

    def test_named_version_is_not_overwritten(self) -> None:
        started = self.initial.created_at_ms + 1000
        self._save_at(started, b"named save", "alias-first")
        first = self.versions.history(self.project.id, self.path)[0]
        self.store.update_alias(first.id, "checkpoint", 0, "test", "alias", "alias-digest")
        self._save_at(started + 1000, b"later save", "alias-second")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 3)
        self.assertEqual(self.versions.read(self.project.id, first.id)[0], b"named save")

    def test_review_baseline_is_not_overwritten(self) -> None:
        started = self.initial.created_at_ms + 1000
        self._save_at(started, b"saved baseline", "review-first")
        self.initial = self.versions.history(self.project.id, self.path)[0]
        review = self._review(saved_base=True)
        self._save_at(started + 1000, b"review edit", "review-second")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 3)
        self.assertEqual(self.store.pending(self.initial.file_id).review.base, review.base)
        self.assertEqual(self.versions.read(self.project.id, self.initial.id)[0], b"saved baseline")

    def test_explicit_snapshot_is_not_coalesced(self) -> None:
        self.file.write_bytes(b"explicit snapshot")
        first = self.versions.seal(self.project.id, self.path, VersionOrigin.USER).version
        self._save_at(first.created_at_ms + 1000, b"editor save", "explicit-next")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 3)
        self.assertEqual(self.versions.read(self.project.id, first.id)[0], b"explicit snapshot")

    def test_additive_upgrade_preserves_legacy_versions(self) -> None:
        started = self.initial.created_at_ms + 1000
        self._save_at(started, b"legacy save", "legacy-first")
        first = self.versions.history(self.project.id, self.path)[0]
        with transaction(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)) as connection:
            connection.execute("ALTER TABLE resources_versions DROP COLUMN editor_save")
        self.store.ensure()
        self.store.ensure()
        self.assertEqual(self.versions.history(self.project.id, self.path)[0], first)
        with transaction(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)) as connection:
            rows = connection.execute("SELECT editor_save FROM resources_versions").fetchall()
            self.assertEqual([tuple(row) for row in rows], [(0,), (0,)])
        self._save_at(started + 1000, b"new save", "legacy-second")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 3)
        self.assertEqual(self.versions.read(self.project.id, first.id)[0], b"legacy save")

    def test_unknown_columns_reject_additive_upgrade_without_writing(self) -> None:
        database = Path(self.content.resolve(self.project.id, PROJECT_DB_RELATIVE))
        with closing(sqlite3.connect(database)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("ALTER TABLE resources_versions DROP COLUMN editor_save")
            writer.execute("ALTER TABLE resources_versions ADD COLUMN user_asset TEXT")
            writer.execute("UPDATE resources_versions SET user_asset = 'preserved'")
            writer.commit()
            wal = Path(str(database) + "-wal")
            before = database.read_bytes(), wal.read_bytes()
            logical_before = tuple(writer.iterdump())
            for operation in (
                lambda: VersionStore.inspect_schema(database),
                self.store.ensure,
                self.store.ensure,
            ):
                with self.assertRaisesRegex(RuntimeError, "unsupported resource version"):
                    operation()
                self.assertEqual((database.read_bytes(), wal.read_bytes()), before)
                self.assertEqual(tuple(writer.iterdump()), logical_before)

    def test_active_turn_baseline_freezes_the_editor_version(self) -> None:
        started = self.initial.created_at_ms + 1000
        self._save_at(started, b"turn baseline", "turn-first")
        first = self.versions.history(self.project.id, self.path)[0]
        baseline = TurnBaseline(
            file_id=first.file_id,
            path=self.path,
            revision=first.object_id,
            object_id=first.object_id,
            mode_bits=first.mode_bits,
            version_id=first.id,
        )
        descriptor = self.versions._cas(self.project.id).verify(first.object_id)
        self.store.begin_turn(
            "baseline-session", "baseline-turn", ((baseline, descriptor, None),), (self.path,)
        )
        self._save_at(started + 1000, b"user edit during turn", "turn-second")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 3)
        self.assertEqual(self.versions.read(self.project.id, first.id)[0], b"turn baseline")

    def test_different_files_keep_independent_save_windows(self) -> None:
        started = self.initial.created_at_ms + 1000
        self._save_at(started, b"first file save", "files-first")
        first = self.versions.history(self.project.id, self.path)[0]
        other_path = "resources/other.docx"
        (Path(self.project.root) / other_path).write_bytes(b"other initial")
        other_initial = self.versions.ensure_initial(self.project.id, other_path).version
        for offset, content in ((1000, b"other save"), (2000, b"other latest")):
            with patch(
                "service.resources.persistence.version._now_ms", return_value=started + offset
            ):
                self.versions.commit_working(
                    self.project.id,
                    other_path,
                    content,
                    self.store.head(other_initial.file_id)[1],
                    content.decode(),
                    automatic_version=True,
                )
        self.assertEqual(self.versions.history(self.project.id, self.path)[0], first)
        other_history = self.versions.history(self.project.id, other_path)
        self.assertEqual(len(other_history), 2)
        self.assertEqual(
            self.versions.read(self.project.id, other_history[0].id)[0], b"other latest"
        )

    def test_concurrent_saves_keep_revision_conflict_protection(self) -> None:
        started = self.initial.created_at_ms + 1000
        self._save_at(started, b"first save", "concurrent-first")
        first = self.versions.history(self.project.id, self.path)[0]
        expected_revision = self.store.head(self.initial.file_id)[1]

        def save(content: bytes) -> bytes | str:
            try:
                self.versions.commit_working(
                    self.project.id,
                    self.path,
                    content,
                    expected_revision,
                    content.decode(),
                    automatic_version=True,
                )
            except ResourceVersionError as exc:
                return exc.code
            return content

        with patch("service.resources.persistence.version._now_ms", return_value=started + 1000):
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(save, (b"concurrent-a", b"concurrent-b")))
        self.assertEqual(results.count("revision_conflict"), 1)
        winner = next(result for result in results if isinstance(result, bytes))
        self.assertEqual(self.file.read_bytes(), winner)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 2)
        self.assertEqual(self.versions.read(self.project.id, first.id)[0], winner)

    def test_coalesced_save_logs_update_instead_of_creation(self) -> None:
        started = self.initial.created_at_ms + 1000
        self._save_at(started, b"first save", "event-first")
        with patch("service.resources.service.history.emit") as emit_event:
            self._save_at(started + 1000, b"updated save", "event-second")
        events = [call.args[1].value for call in emit_event.call_args_list]
        self.assertIn("resources.versions.version.updated", events)
        self.assertNotIn("resources.versions.version.created", events)

    def test_editor_save_keeps_external_pending_for_explicit_confirmation(self) -> None:
        self.file.write_bytes(b"settled external contents")
        self.assertTrue(self.versions.observe(self.project.id, self.path))
        current = self.versions.capability(self.project.id, self.path)
        self.versions.commit_working(
            self.project.id,
            self.path,
            b"user edit after external change",
            current.working_revision,
            "write-after-external",
            automatic_version=True,
        )
        pending = self.versions.capability(self.project.id, self.path).pending
        self.assertIsNotNone(pending)
        self.assertEqual(pending.origin, PendingOrigin.EXTERNAL)
        current = self.versions.capability(self.project.id, self.path)
        self.versions.commit_working(
            self.project.id,
            self.path,
            b"second user edit after external change",
            current.working_revision,
            "second-write-after-external",
            automatic_version=True,
        )
        self.assertEqual(
            self.versions.capability(self.project.id, self.path).pending.origin,
            PendingOrigin.EXTERNAL,
        )
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    def test_capability_detects_metadata_only_disk_changes(self) -> None:
        before = self.file.stat().st_mode & 0o777
        self._toggle_file_mode()
        current = self.versions.capability(self.project.id, self.path)
        self.assertTrue(current.drifted)
        self.assertEqual(current.disk_revision, current.working_revision)
        self.file.chmod(before)
        self.assertFalse(self.versions.capability(self.project.id, self.path).drifted)

    def test_seal_and_restart_reconstruct_saved_state(self) -> None:
        current = self.versions.capability(self.project.id, self.path)
        self.versions.commit_working(
            self.project.id, self.path, b"draft", current.working_revision, "write"
        )
        self.versions.seal(self.project.id, self.path, VersionOrigin.USER)
        reopened = VersionStore(
            self.content.resolve(self.project.id, PROJECT_DB_RELATIVE), self.project.root
        )
        self.assertEqual(reopened.snapshot_state(self.initial.file_id), SnapshotState.SAVED)
        self.assertIsNone(reopened.pending(self.initial.file_id))

    def test_pending_origin_survives_restart_without_creating_a_version(self) -> None:
        current = self.versions.capability(self.project.id, self.path)
        self.versions.commit_working(
            self.project.id, self.path, b"user draft", current.working_revision, "draft-origin"
        )
        reopened = VersionStore(
            self.content.resolve(self.project.id, PROJECT_DB_RELATIVE), self.project.root
        )
        pending = reopened.pending(self.initial.file_id)
        self.assertIsNotNone(pending)
        self.assertEqual(pending.origin, PendingOrigin.USER)
        self.assertFalse(pending.needs_review)
        self.assertEqual(len(reopened.history_for_file(self.initial.file_id)), 1)

    def test_writing_original_bytes_clears_pending_metadata(self) -> None:
        original = self.file.read_bytes()
        before = self.versions.capability(self.project.id, self.path)
        self.versions.commit_working(
            self.project.id, self.path, b"user draft", before.working_revision, "draft-roundtrip"
        )
        current = self.versions.capability(self.project.id, self.path)
        self.versions.commit_working(
            self.project.id, self.path, original, current.working_revision, "original-roundtrip"
        )
        self.assertEqual(self.store.snapshot_state(self.initial.file_id), SnapshotState.SAVED)
        self.assertIsNone(self.store.pending(self.initial.file_id))

    def test_external_drift_does_not_relabel_the_stored_working_snapshot(self) -> None:
        self.file.write_bytes(b"external bytes not yet adopted")
        current = self.versions.capability(self.project.id, self.path)
        self.assertTrue(current.drifted)
        self.assertEqual(current.snapshot_state, SnapshotState.SAVED)

    def test_settled_external_change_is_pending_without_a_new_version(self) -> None:
        self.file.write_bytes(b"settled external contents")
        self.assertTrue(self.versions.observe(self.project.id, self.path))
        current = self.versions.capability(self.project.id, self.path)
        self.assertEqual(current.snapshot_state, SnapshotState.PENDING)
        self.assertEqual(current.pending.origin, PendingOrigin.EXTERNAL)
        self.assertFalse(current.drifted)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)
        revision = current.pending.revision
        self.versions.observe(self.project.id, self.path)
        self.assertEqual(
            self.versions.capability(self.project.id, self.path).pending.revision, revision
        )

    def test_external_deletion_is_pending_and_discard_restores_saved_file(self) -> None:
        self.file.unlink()
        self.versions.observe(self.project.id, self.path)
        current = self.versions.capability(self.project.id, self.path)
        self.assertEqual(current.pending.origin, PendingOrigin.EXTERNAL)
        self.assertFalse(current.drifted)
        self._discard("external-deletion")
        self.assertEqual(self.file.read_bytes(), b"original complete document bytes")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    def test_mode_change_seals_a_distinct_snapshot(self) -> None:
        self._toggle_file_mode()
        sealed = self.versions.seal(self.project.id, self.path, VersionOrigin.USER)
        self.assertFalse(sealed.unchanged)
        self.assertEqual(sealed.version.sequence, 2)
        self.assertEqual(sealed.version.object_id, self.initial.object_id)
        self.assertNotEqual(sealed.version.mode_bits, self.initial.mode_bits)

    def test_external_mode_change_is_pending_without_sealing(self) -> None:
        self._toggle_file_mode()
        self.versions.observe(self.project.id, self.path)
        current = self.versions.capability(self.project.id, self.path)
        self.assertEqual(current.pending.origin, PendingOrigin.EXTERNAL)
        self.assertFalse(current.drifted)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    def test_external_observation_preserves_open_review_and_working_head(self) -> None:
        self._review()
        before = self.store.pending(self.initial.file_id)
        head = self.store.working_snapshot(self.initial.file_id)
        self.file.write_bytes(b"external conflicting content")
        self.versions.observe(self.project.id, self.path)
        self.assertEqual(self.store.pending(self.initial.file_id), before)
        self.assertEqual(self.store.working_snapshot(self.initial.file_id), head)
        self.assertTrue(self.versions.capability(self.project.id, self.path).drifted)

    def test_external_observation_does_not_adopt_an_active_turn_write(self) -> None:
        self.store.begin_turn("active-session", "active-turn", (), (self.path,))
        head = self.store.working_snapshot(self.initial.file_id)
        self.file.write_bytes(b"unfinished Agent write")
        self.versions.observe(self.project.id, self.path)
        self.assertEqual(self.store.working_snapshot(self.initial.file_id), head)
        self.assertIsNone(self.store.pending(self.initial.file_id))
        self.assertTrue(self.versions.capability(self.project.id, self.path).drifted)

    def test_external_return_to_saved_snapshot_clears_pending(self) -> None:
        self.file.write_bytes(b"temporary external change")
        self.versions.observe(self.project.id, self.path)
        self.file.write_bytes(b"original complete document bytes")
        self.versions.observe(self.project.id, self.path)
        self.assertIsNone(self.store.pending(self.initial.file_id))
        self.assertEqual(self.store.snapshot_state(self.initial.file_id), SnapshotState.SAVED)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    def test_path_change_seals_a_distinct_snapshot(self) -> None:
        target = "resources/renamed.docx"
        self.file.rename(Path(self.project.root) / target)
        self.store.move_identity(self.initial.file_id, target, VersionOrigin.USER.value)
        sealed = self.versions.seal(self.project.id, target, VersionOrigin.USER)
        self.assertFalse(sealed.unchanged)
        self.assertEqual(sealed.version.sequence, 2)
        self.assertEqual(sealed.version.file_id, self.initial.file_id)

    def test_complete_identity_includes_annotations_and_presence(self) -> None:
        identity = self.store.working_snapshot(self.initial.file_id)
        self.assertEqual(identity.state, FileState.PRESENT)
        self.assertNotEqual(identity, replace(identity, annotation_object_id="sha256:annotation"))
        self.assertNotEqual(identity, replace(identity, state=FileState.TOMBSTONE, object_id=None))

    def test_annotation_only_change_does_not_enter_file_version_state(self) -> None:
        path = "resources/annotations.pdf"
        source = Path(self.project.root) / path
        source.write_bytes(b"%PDF-1.4\nunchanged source\n")
        annotations = PdfRecordStore(self.content)
        initial = self.versions.ensure_initial(self.project.id, path).version
        self.assertEqual(self.store.snapshot_state(initial.file_id), SnapshotState.SAVED)
        record_states = (
            pdf_records(1, "added"),
            pdf_records(1, "updated"),
            {"schema_version": 1, "marks": [], "comments": [], "notes": []},
        )
        for records in record_states:
            baseline = annotations.snapshot(self.project.id, path)
            annotations.commit(
                self.project.id,
                path,
                records,
                baseline.record_revision,
            )
            observed = self.versions.observe(self.project.id, path)
            working = self.store.working_snapshot(initial.file_id)
            self.assertEqual(working.object_id, initial.object_id)
            self.assertEqual(working.annotation_object_id, initial.annotation_object_id)
            self.assertFalse(observed)
            self.assertFalse(self.versions.capability(self.project.id, path).drifted)
            self.assertIsNone(self.store.pending(initial.file_id))
            self.assertEqual(self.store.snapshot_state(initial.file_id), SnapshotState.SAVED)
            self.assertEqual(len(self.store.history_for_file(initial.file_id)), 1)
        reloaded = PdfRecordStore(self.content).snapshot(self.project.id, path)
        self.assertEqual(reloaded.records, record_states[-1])
        stable = self.content.stable_snapshot(self.project.id, path, VERSION_MAX_BYTES)
        self.store.observe(
            initial.file_id,
            DiskObservation(
                ObservationState.PRESENT,
                revision=stable.revision,
                size_bytes=stable.size,
                mtime_ns=stable.mtime_ns,
                mode_bits=stable.mode_bits,
                annotation_revision=reloaded.record_revision,
            ),
        )
        self.assertFalse(self.versions.capability_states(self.project.id, (path,))[path].drifted)
        sealed = self.versions.seal(self.project.id, path, VersionOrigin.USER)
        self.assertTrue(sealed.unchanged)
        self.assertEqual(sealed.version.id, initial.id)
        self.assertEqual(len(self.store.history_for_file(initial.file_id)), 1)
        self.assertEqual(self.store.snapshot_state(initial.file_id), SnapshotState.SAVED)

    def test_legacy_annotation_pending_is_not_rewritten_by_observation(self) -> None:
        cas = self.versions._cas(self.project.id)
        stable = self.content.stable_snapshot(self.project.id, self.path, VERSION_MAX_BYTES)
        with cas.writer():
            annotation_object_id = cas.put(b'{"legacy":true}', "application/json")
            annotation_descriptor = cas.verify(annotation_object_id)
            self.store.accept_working(
                self.initial.file_id,
                SnapshotVersion(
                    path=self.path,
                    media_type=stable.media_type,
                    revision=self.initial.object_id,
                    object_id=self.initial.object_id,
                    mode_bits=self.initial.mode_bits,
                    mtime_ns=None,
                    origin=VersionOrigin.EXTERNAL_CONFIRMED,
                    annotation_revision=annotation_object_id,
                    annotation_object_id=annotation_object_id,
                ),
                None,
                annotation_descriptor,
                PendingOrigin.EXTERNAL.value,
            )
        legacy_pending = self.store.pending(self.initial.file_id)
        self.assertIsNotNone(legacy_pending)
        self.assertFalse(self.versions.observe(self.project.id, self.path))
        self.assertEqual(self.store.pending(self.initial.file_id), legacy_pending)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def _write(self, content: bytes, key: str) -> None:
        current = self.versions.capability(self.project.id, self.path)
        self.versions.commit_working(
            self.project.id, self.path, content, current.working_revision, key
        )

    def _capture(self, review: PendingReview) -> None:
        with transaction(
            self.content.resolve(self.project.id, PROJECT_DB_RELATIVE), immediate=True
        ) as connection:
            pending.capture(connection, self.initial.file_id, review, 1)

    def _review(self, *, saved_base: bool = False) -> PendingReview:
        if not saved_base:
            self._write(b"unsaved user baseline", "baseline")
        baseline = self.store.working_snapshot(self.initial.file_id)
        baseline_revision = self.store.head(self.initial.file_id)[1]
        self._write(b"agent candidate", "candidate")
        candidate = self.store.working_snapshot(self.initial.file_id)
        review = PendingReview(
            id="review-one",
            group_id="group-one",
            session_id="session-one",
            first_turn_id="turn-one",
            turn_id="turn-one",
            terminal_outcome=TurnOutcome.COMPLETED,
            origin=PendingOrigin.AGENT,
            base=baseline,
            candidate=candidate,
            base_revision=baseline_revision,
            candidate_revision=self.store.head(self.initial.file_id)[1],
            base_origin=None if saved_base else PendingOrigin.USER,
            base_version_id=self.initial.id,
            edited_by_user=False,
        )
        self._capture(review)
        return review

    def _reconcile(self, action: str, *, token: str | None = None, key: str = "reconcile") -> None:
        preview = self.recovery.preview_review_conflict(self.project.id, self.initial.file_id)
        self.recovery.reconcile_review(
            self.project.id, self.initial.file_id, action, token or preview.token, key
        )

    def test_editor_save_does_not_accept_an_agent_review(self) -> None:
        review = self._review(saved_base=True)
        current = self.versions.capability(self.project.id, self.path)
        self.versions.commit_working(
            self.project.id,
            self.path,
            b"user revision of agent candidate",
            current.working_revision,
            "save-reviewed-candidate",
            automatic_version=True,
        )
        pending_snapshot = self.store.pending(self.initial.file_id)
        self.assertTrue(pending_snapshot.needs_review)
        self.assertTrue(pending_snapshot.review.edited_by_user)
        self.assertEqual(pending_snapshot.review, replace(review, edited_by_user=True))
        self.assertGreater(pending_snapshot.revision, current.pending.revision)
        history = self.versions.history(self.project.id, self.path)
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0].origin, VersionOrigin.USER)
        self.assertEqual(
            self.versions.read(self.project.id, history[0].id)[0],
            b"user revision of agent candidate",
        )
        self.assertEqual(self.store.snapshot_state(self.initial.file_id), SnapshotState.SAVED)
        self.assertEqual(
            self.versions.capability_states(self.project.id, (self.path,))[
                self.path
            ].snapshot_state,
            SnapshotState.SAVED,
        )
        self.versions.commit_working(
            self.project.id,
            self.path,
            b"user revision of agent candidate",
            current.working_revision,
            "save-reviewed-candidate",
            automatic_version=True,
        )
        self.assertEqual(self.versions.history(self.project.id, self.path), history)
        reopened = VersionStore(
            self.content.resolve(self.project.id, PROJECT_DB_RELATIVE), self.project.root
        )
        self.assertEqual(reopened.pending(self.initial.file_id), pending_snapshot)
        self.assertEqual(reopened.snapshot_state(self.initial.file_id), SnapshotState.SAVED)
        saved = self.versions.capability(self.project.id, self.path)
        self.versions.commit_working(
            self.project.id,
            self.path,
            b"user revision of agent candidate",
            saved.working_revision,
            "save-identical-reviewed-candidate",
            automatic_version=True,
        )
        self.assertEqual(self.versions.history(self.project.id, self.path), history)
        self._decide(ReviewOutcome.REVISED, "revise-saved-review")
        self.assertIsNone(self.store.pending(self.initial.file_id))
        self.assertEqual(self.file.read_bytes(), b"user revision of agent candidate")
        self.assertIn(history[0], self.versions.history(self.project.id, self.path))

    def test_undo_and_accept_after_editor_save_preserve_user_version(self) -> None:
        review = self._review(saved_base=True)
        self.versions.commit_working(
            self.project.id,
            self.path,
            b"saved user revision",
            self.store.head(self.initial.file_id)[1],
            "save-before-undo",
            automatic_version=True,
        )
        saved = self.versions.history(self.project.id, self.path)[0]
        self.assertEqual(saved.origin, VersionOrigin.USER)
        self._reconcile("restore_candidate")
        self.assertEqual(self.file.read_bytes(), b"agent candidate")
        self.assertEqual(self.store.pending(self.initial.file_id).review.base, review.base)
        self.assertEqual(
            self.store.pending(self.initial.file_id).review.candidate, review.candidate
        )
        self.assertEqual(self.store.snapshot_state(self.initial.file_id), SnapshotState.PENDING)
        self._decide(ReviewOutcome.ACCEPTED, "accept-after-undo")
        self.assertIsNone(self.store.pending(self.initial.file_id))
        self.assertIn(saved, self.versions.history(self.project.id, self.path))
        self.assertEqual(self.versions.read(self.project.id, saved.id)[0], b"saved user revision")

    def test_interrupted_editor_save_recovers_version_without_completing_review(self) -> None:
        review = self._review(saved_base=True)
        revision = self.store.head(self.initial.file_id)[1]
        with patch.object(
            VersionStore, "commit_working_mutation", side_effect=RuntimeError("after disk write")
        ):
            with self.assertRaisesRegex(RuntimeError, "after disk write"):
                self.versions.commit_working(
                    self.project.id,
                    self.path,
                    b"recoverable saved revision",
                    revision,
                    "interrupted-review-save",
                    automatic_version=True,
                )
        self.assertEqual(self.file.read_bytes(), b"recoverable saved revision")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)
        self.assertEqual(len(self.versions.recover_working_mutations(self.project.id)), 1)
        self.assertEqual(self.versions.recover_working_mutations(self.project.id), ())
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 2)
        self.assertEqual(
            self.store.pending(self.initial.file_id).review,
            replace(review, edited_by_user=True),
        )
        self.assertEqual(self.store.snapshot_state(self.initial.file_id), SnapshotState.SAVED)

    def test_keep_external_content_preserves_review_without_writing_or_sealing(self) -> None:
        review = self._review()
        self.file.write_bytes(b"external content")
        with patch.object(
            self.recovery, "_apply_member", side_effect=AssertionError("must not write")
        ):
            self._reconcile("keep_current")
        current = self.store.pending(self.initial.file_id)
        self.assertEqual(current.review.base, review.base)
        self.assertEqual(current.review.candidate, review.candidate)
        self.assertTrue(current.review.edited_by_user)
        self.assertFalse(self.versions.capability(self.project.id, self.path).drifted)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)
        self.assertEqual(self.file.read_bytes(), b"external content")

    def test_restore_candidate_keeps_review_and_exact_metadata(self) -> None:
        review = self._review()
        self.file.write_bytes(b"external content")
        self._toggle_file_mode()
        self._reconcile("restore_candidate")
        current = self.store.pending(self.initial.file_id)
        self.assertEqual(current.review.id, review.id)
        self.assertFalse(current.review.edited_by_user)
        self.assertEqual(current.review.base, review.base)
        self.assertEqual(self.store.working_snapshot(self.initial.file_id), review.candidate)
        self.assertEqual(self.file.read_bytes(), b"agent candidate")
        self.assertEqual(self.file.stat().st_mode & 0o777, review.candidate.mode_bits)
        history = self.versions.history(self.project.id, self.path)
        self.assertEqual(len(history), 2)
        self.assertTrue(history[0].review_backup)
        self.assertEqual(history[0].source_review_id, review.id)
        self.assertEqual(
            b"".join(self.versions.content(self.project.id, history[0].id)[0]), b"external content"
        )

    def test_review_reconciliation_rejects_stale_metadata_preflight(self) -> None:
        review = self._review()
        self.file.write_bytes(b"external content")
        preview = self.recovery.preview_review_conflict(self.project.id, self.initial.file_id)
        self._toggle_file_mode()
        with (
            self.assertRaisesRegex(ResourceRecoveryError, "preflight_stale"),
            self.assertLogs("scholarseed.resources.recovery", level="INFO") as logs,
        ):
            self._reconcile("restore_candidate", token=preview.token)
        conflicts = [record for record in logs.records if record.msg.endswith("review.conflict")]
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0].review_id, review.id)
        self.assertEqual(conflicts[0].result_code, "preflight_stale")
        self.assertEqual(self.file.read_bytes(), b"external content")
        self.assertEqual(self.store.working_snapshot(self.initial.file_id), review.candidate)

    def test_review_reconciliation_replay_does_not_overwrite_later_edits(self) -> None:
        self._review()
        self.file.write_bytes(b"external content")
        preview = self.recovery.preview_review_conflict(self.project.id, self.initial.file_id)
        self._reconcile("restore_candidate", token=preview.token)
        after = self.store.pending(self.initial.file_id)
        self.file.write_bytes(b"later content")
        self.recovery.reconcile_review(
            self.project.id, self.initial.file_id, "restore_candidate", preview.token, "reconcile"
        )
        self.assertEqual(self.file.read_bytes(), b"later content")
        self.assertEqual(self.store.pending(self.initial.file_id), after)
        with self.assertRaises(ResourceRecoveryError):
            self.recovery.reconcile_review(
                self.project.id, self.initial.file_id, "keep_current", preview.token, "reconcile"
            )

    def test_reconciliation_after_user_edit_restores_agent_not_user_draft(self) -> None:
        review = self._review()
        self._write(b"user edited candidate", "edit-candidate")
        self.file.write_bytes(b"outside replacement")
        self._reconcile("restore_candidate")
        self.assertEqual(self.file.read_bytes(), b"agent candidate")
        self.assertEqual(
            self.store.pending(self.initial.file_id).review.candidate, review.candidate
        )
        self.assertFalse(self.store.pending(self.initial.file_id).review.edited_by_user)

    def test_keep_external_deletion_can_be_explicitly_saved_as_user_revision(self) -> None:
        review = self._review()
        self.file.unlink()
        self._reconcile("keep_current")
        current = self.store.pending(self.initial.file_id)
        self.assertTrue(current.review.edited_by_user)
        self.assertFalse(self.file.exists())
        self.assertEqual(current.review.base, review.base)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)
        result = self.versions.seal_review(
            self.project.id,
            self.initial.file_id,
            self.path,
            ReviewDecision(current.review.id, current.revision, ReviewOutcome.REVISED),
            None,
            "revise-deletion",
        )
        self.assertEqual(result.version.origin, VersionOrigin.USER)
        self.assertEqual(result.version.source_review_id, review.id)
        self.assertEqual(result.version.state, FileState.TOMBSTONE)

    def test_restore_candidate_recovers_external_deletion(self) -> None:
        self._review()
        self.file.unlink()
        self._reconcile("restore_candidate")
        self.assertEqual(self.file.read_bytes(), b"agent candidate")
        history = self.store.history_for_file(self.initial.file_id)
        self.assertEqual(len(history), 2)
        self.assertTrue(history[0].review_backup)

    def test_reconciliation_crash_after_file_apply_recovers_open_review(self) -> None:
        review = self._review()
        self.file.write_bytes(b"outside content")
        with patch.object(
            VersionStore, "commit_restore", side_effect=RuntimeError("simulated crash")
        ):
            with self.assertRaisesRegex(RuntimeError, "simulated crash"):
                self._reconcile("restore_candidate")
        self.assertEqual(self.file.read_bytes(), b"agent candidate")
        reopened = ResourceRecoveryService(
            self.content,
            ResourceRetentionService(self.content, Settings()),
            PdfRecordStore(self.content),
        )
        self.assertEqual(len(reopened.recover_pending(self.project.id)), 1)
        self.assertEqual(self.store.pending(self.initial.file_id).review.id, review.id)
        self.assertFalse(self.store.pending(self.initial.file_id).review.edited_by_user)
        history = self.store.history_for_file(self.initial.file_id)
        self.assertEqual(len(history), 2)
        self.assertTrue(history[0].review_backup)

    def test_reconciliation_crash_cannot_overwrite_a_newer_external_file(self) -> None:
        self._review()
        self.file.write_bytes(b"outside content")
        with patch.object(
            VersionStore, "commit_restore", side_effect=RuntimeError("simulated crash")
        ):
            with self.assertRaises(RuntimeError):
                self._reconcile("restore_candidate")
        self.file.write_bytes(b"newer outside content")
        self.assertEqual(self.recovery.recover_pending(self.project.id), ())
        self.assertEqual(self.file.read_bytes(), b"newer outside content")
        self.assertTrue(self.store.pending(self.initial.file_id).needs_review)

    def test_reconciliation_http_requires_fenced_choice_and_idempotency(self) -> None:
        self._review()
        self.file.write_bytes(b"outside content")
        client = self._client()
        route = f"/api/resource/files/{self.initial.file_id}/review"
        preview = client.get(f"{route}/conflict", params={"project": self.project.id})
        self.assertEqual(preview.status_code, 200, preview.text)
        payload = {"action": "keep_current", "token": preview.json()["token"]}
        missing = client.post(
            f"{route}/reconcile", params={"project": self.project.id}, json=payload
        )
        self.assertEqual(missing.status_code, 400, missing.text)
        response = client.post(
            f"{route}/reconcile",
            params={"project": self.project.id},
            json=payload,
            headers={"Idempotency-Key": "http-keep"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(self.store.pending(self.initial.file_id).review.edited_by_user)

    def test_reconciliation_resumes_prepared_manifest_without_reinterpreting_choice(self) -> None:
        review = self._review()
        self.file.write_bytes(b"outside content")
        with patch.object(self.recovery, "_execute", side_effect=RuntimeError("before apply")):
            with self.assertRaisesRegex(RuntimeError, "before apply"):
                self._reconcile("keep_current")
        self.assertEqual(len(self.store.pending_restores()), 1)
        self.assertEqual(len(self.recovery.recover_pending(self.project.id)), 1)
        self.assertEqual(self.file.read_bytes(), b"outside content")
        self.assertEqual(self.store.pending(self.initial.file_id).review.base, review.base)
        self.assertTrue(self.store.pending(self.initial.file_id).review.edited_by_user)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def test_reconciliation_resume_rejects_a_newer_pending_revision(self) -> None:
        review = self._review()
        self.file.write_bytes(b"outside content")
        with patch.object(self.recovery, "_execute", side_effect=RuntimeError("before apply")):
            with self.assertRaises(RuntimeError):
                self._reconcile("restore_candidate")
        self._capture(review)
        self.assertEqual(self.recovery.recover_pending(self.project.id), ())
        self.assertEqual(self.file.read_bytes(), b"outside content")

    def test_keep_external_baseline_still_requires_review_decision(self) -> None:
        review = self._review(saved_base=True)
        self.file.write_bytes(b"original complete document bytes")
        self._reconcile("keep_current")
        current = self.store.pending(self.initial.file_id)
        self.assertEqual(
            self.versions.capability(self.project.id, self.path).snapshot_state,
            SnapshotState.SAVED,
        )
        self.assertTrue(current.needs_review)
        with self.assertRaises(ResourceVersionError):
            self.versions.seal_review(
                self.project.id,
                self.initial.file_id,
                self.path,
                ReviewDecision(review.id, current.revision, ReviewOutcome.ACCEPTED),
                review.base_revision,
                "bad-accept",
            )
        with self.assertRaises(ResourceRecoveryError):
            self.recovery.reject_review(
                self.project.id,
                self.initial.file_id,
                ReviewDecision(review.id, current.revision, ReviewOutcome.REJECTED),
                review.base_revision,
                "bad-reject",
            )
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def test_restore_candidate_reconciles_a_moved_working_file(self) -> None:
        review = self._review()
        moved_path = "resources/moved.docx"
        moved = Path(self.project.root) / moved_path
        self.file.rename(moved)
        self.store.move_identity(self.initial.file_id, moved_path, VersionOrigin.USER.value)
        moved.write_bytes(b"external content at new path")
        self._reconcile("restore_candidate")
        self.assertFalse(moved.exists())
        self.assertEqual(self.file.read_bytes(), b"agent candidate")
        self.assertEqual(self.store.working_snapshot(self.initial.file_id), review.candidate)
        self.assertEqual(self.store.identity(self.path)[0], self.initial.file_id)
        history = self.store.history_for_file(self.initial.file_id)
        self.assertEqual(len(history), 2)
        self.assertTrue(history[0].review_backup)

    def test_restore_candidate_does_not_overwrite_occupied_original_path(self) -> None:
        self._review()
        moved_path = "resources/moved.docx"
        moved = Path(self.project.root) / moved_path
        self.file.rename(moved)
        self.store.move_identity(self.initial.file_id, moved_path, VersionOrigin.USER.value)
        moved.write_bytes(b"external content at new path")
        self.file.write_bytes(b"unrelated file at original path")
        with self.assertRaisesRegex(ResourceRecoveryError, "restore_conflict"):
            self._reconcile("restore_candidate")
        self.assertEqual(moved.read_bytes(), b"external content at new path")
        self.assertEqual(self.file.read_bytes(), b"unrelated file at original path")

    def test_reconciliation_commit_rejects_annotation_revision_race(self) -> None:
        self._review()
        self.file.write_bytes(b"outside content")
        original = self.recovery._restored_snapshot

        def changed_annotation(*args):
            snapshot, descriptor, annotation = original(*args)
            return (
                replace(snapshot, annotation_revision="sha256:concurrent-annotation"),
                descriptor,
                annotation,
            )

        with patch.object(self.recovery, "_restored_snapshot", side_effect=changed_annotation):
            with self.assertRaisesRegex(ResourceRecoveryError, "preflight_stale"):
                self._reconcile("keep_current")
        self.assertEqual(self.file.read_bytes(), b"outside content")
        self.assertFalse(self.store.pending(self.initial.file_id).review.edited_by_user)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def test_reconciliation_replay_waits_for_new_active_agent_turn(self) -> None:
        self._review()
        self.file.write_bytes(b"outside content")
        preview = self.recovery.preview_review_conflict(self.project.id, self.initial.file_id)
        with patch.object(self.recovery, "_execute", side_effect=RuntimeError("before apply")):
            with self.assertRaises(RuntimeError):
                self._reconcile("restore_candidate", token=preview.token)
        self.store.begin_turn("new-session", "new-turn", (), (self.path,))
        with self.assertRaisesRegex(ResourceRecoveryError, "review_turn_active"):
            self.recovery.reconcile_review(
                self.project.id,
                self.initial.file_id,
                "restore_candidate",
                preview.token,
                "reconcile",
            )
        self.assertEqual(self.recovery.recover_pending(self.project.id), ())
        self.assertEqual(self.store.pending_restores()[0].state.value, "prepared")
        self.assertEqual(self.file.read_bytes(), b"outside content")

    def test_user_edit_keeps_review_candidate_and_first_baseline(self) -> None:
        review = self._review()
        self._write(b"user revised result", "revised")
        current = self.store.pending(self.initial.file_id)
        self.assertEqual(current.origin, PendingOrigin.AGENT)
        self.assertTrue(current.needs_review)
        self.assertTrue(current.review.edited_by_user)
        self.assertEqual(current.review.base, review.base)
        self.assertEqual(current.review.candidate, review.candidate)
        self.assertEqual(current.review.base_origin, PendingOrigin.USER)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def test_continuous_turn_preserves_first_review_and_updates_candidate(self) -> None:
        review = self._review()
        self._write(b"next candidate", "next-candidate")
        candidate = self.store.working_snapshot(self.initial.file_id)
        self._capture(
            replace(
                review,
                id="review-two",
                group_id="group-two",
                turn_id="turn-two",
                base=review.candidate,
                candidate=candidate,
                base_origin=None,
            )
        )
        current = self.store.pending(self.initial.file_id).review
        self.assertEqual(current.id, review.id)
        self.assertEqual(current.group_id, review.group_id)
        self.assertEqual(current.base, review.base)
        self.assertEqual(current.base_origin, PendingOrigin.USER)
        self.assertEqual(current.candidate, candidate)
        self.assertEqual(current.turn_id, "turn-two")

    def test_gc_pins_review_objects_even_after_working_head_moves(self) -> None:
        review = self._review()
        self._write(b"user revised result", "gc-revised")
        pinned = frozenset((review.base.object_id, review.candidate.object_id))
        plan = self.store.plan_gc("review-gc", pinned, frozenset(), now_ms=10**15, grace_ms=0)
        removed = {entry.identifier for entry in (*plan.trash, *plan.delete)}
        self.assertFalse(pinned & removed)

    def test_retention_rechecks_new_review_pins_after_preview(self) -> None:
        self._write(b"second version", "second")
        self.versions.seal(self.project.id, self.path, VersionOrigin.USER)
        version_ids, _, delivery_ids = self.store.retention_plan(1)
        self.assertIn(self.initial.id, version_ids)
        self._review()
        self.assertNotIn(self.initial.id, self.store.retention_plan(1)[0])
        with self.assertRaises(VersionStoreConflict) as failure:
            self.store.apply_retention(version_ids, delivery_ids)
        self.assertEqual(failure.exception.code, "retention_preview_stale")
        self.assertIsNotNone(self.store.version(self.initial.id))

    def test_ordinary_seal_cannot_bypass_an_open_review(self) -> None:
        review = self._review()
        with self.assertRaises(ResourceVersionError) as failure:
            self.versions.seal(self.project.id, self.path, VersionOrigin.USER)
        self.assertEqual(str(failure.exception), "pending_review_requires_decision")
        self.assertEqual(self.store.pending(self.initial.file_id).review.id, review.id)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def _decide(self, outcome: ReviewOutcome, key: str):
        current = self.store.pending(self.initial.file_id)
        return self.versions.seal(
            self.project.id,
            self.path,
            VersionOrigin.USER,
            expected_revision=self.store.head(self.initial.file_id)[1],
            idempotency_key=key,
            operation_target=self.initial.file_id,
            review_decision=ReviewDecision(current.review.id, current.revision, outcome),
        )

    def test_accept_seals_agent_version_and_closes_review_atomically(self) -> None:
        review = self._review()
        sealed = self._decide(ReviewOutcome.ACCEPTED, "accept-review")
        self.assertEqual(sealed.version.origin, VersionOrigin.AGENT)
        self.assertEqual(sealed.version.source_review_id, review.id)
        self.assertEqual(sealed.version.review_outcome, ReviewOutcome.ACCEPTED)
        self.assertEqual(sealed.version.turn_id, review.turn_id)
        self.assertIsNone(self.store.pending(self.initial.file_id))
        self.assertEqual(self.store.snapshot_state(self.initial.file_id), SnapshotState.SAVED)

    def test_review_commit_emits_exact_provenance_once(self) -> None:
        review = self._review()
        revision = self.store.pending(self.initial.file_id).revision
        with self.assertLogs("scholarseed.resources.versions", level="INFO") as logs:
            self._decide(ReviewOutcome.ACCEPTED, "accept-evidence")
        records = [record for record in logs.records if record.msg.endswith("review.accept")]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].review_id, review.id)
        self.assertEqual(records[0].file_id, self.initial.file_id)
        self.assertEqual(records[0].session_id, review.session_id)
        self.assertEqual(records[0].turn_id, review.turn_id)
        self.assertEqual(records[0].pending_revision, revision)

    def test_review_user_edit_emits_working_and_candidate_revisions_separately(self) -> None:
        review = self._review()
        with self.assertLogs("scholarseed.resources.versions", level="INFO") as logs:
            self._write(b"revised by user", "edit-evidence")
        records = [record for record in logs.records if record.msg.endswith("pending.updated")]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].review_id, review.id)
        self.assertEqual(records[0].candidate_revision, review.candidate_revision)
        self.assertEqual(records[0].revision, self.store.head(self.initial.file_id)[1])
        self.assertNotEqual(records[0].revision, records[0].candidate_revision)
        self.assertTrue(records[0].edited_by_user)
        with self.assertLogs("scholarseed.resources.versions", level="INFO") as sealed_logs:
            self._decide(ReviewOutcome.REVISED, "revise-evidence")
        self.assertEqual(
            len(
                [record for record in sealed_logs.records if record.msg.endswith("review.revised")]
            ),
            1,
        )

    def test_reject_commit_keeps_original_review_correlation(self) -> None:
        review = self._review()
        current = self.store.pending(self.initial.file_id)
        decision = ReviewDecision(review.id, current.revision, ReviewOutcome.REJECTED)
        expected = self.store.head(self.initial.file_id)[1]
        with self.assertLogs("scholarseed.resources.recovery", level="INFO") as logs:
            self.recovery.reject_review(
                self.project.id, self.initial.file_id, decision, expected, "reject-evidence"
            )
        records = [record for record in logs.records if record.msg.endswith("review.reject")]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].review_id, review.id)
        self.assertEqual(records[0].session_id, review.session_id)
        self.assertEqual(records[0].pending_revision, current.revision)
        with patch("service.resources.service.recovery.emit") as emitted:
            self.recovery.reject_review(
                self.project.id, self.initial.file_id, decision, expected, "reject-evidence"
            )
        emitted.assert_not_called()

    def test_user_move_and_delete_emit_pending_review_updates(self) -> None:
        review = self._review()
        destination = self.file.with_name("review-moved.docx")
        destination_path = str(destination.relative_to(self.project.root))
        self.file.rename(destination)
        with self.assertLogs("scholarseed.resources.versions", level="INFO") as logs:
            self.versions.record_moves(self.project.id, ((self.path, destination_path),))
            destination.unlink()
            self.versions.record_changes(self.project.id, (destination_path,))
        updates = [record for record in logs.records if record.msg.endswith("pending.updated")]
        self.assertEqual(len(updates), 2)
        self.assertEqual({record.review_id for record in updates}, {review.id})
        self.assertLess(updates[0].pending_revision, updates[1].pending_revision)
        self.assertIsNone(updates[1].revision)

    def test_external_disk_conflict_is_recorded_without_a_success_event(self) -> None:
        review = self._review()
        current = self.store.pending(self.initial.file_id)
        self.file.write_bytes(b"external content")
        with (
            self.assertRaises(ResourceRecoveryError),
            self.assertLogs("scholarseed.resources.recovery", level="INFO") as logs,
        ):
            self.recovery.reject_review(
                self.project.id,
                self.initial.file_id,
                ReviewDecision(review.id, current.revision, ReviewOutcome.REJECTED),
                review.candidate_revision,
                "reject-conflict-evidence",
            )
        conflicts = [record for record in logs.records if record.msg.endswith("review.conflict")]
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0].review_id, review.id)
        self.assertFalse(any(record.msg.endswith("review.reject") for record in logs.records))
        self.assertEqual(self.file.read_bytes(), b"external content")

    def test_user_edit_cannot_be_accepted_as_original_agent_candidate(self) -> None:
        self._review()
        self._write(b"user revision", "edit-before-accept")
        with self.assertRaises(ResourceVersionError) as failure:
            self._decide(ReviewOutcome.ACCEPTED, "invalid-accept")
        self.assertEqual(failure.exception.code, "review_revision_conflict")
        self.assertIsNotNone(self.store.pending(self.initial.file_id))
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)
        revised = self._decide(ReviewOutcome.REVISED, "revise-review")
        self.assertEqual(revised.version.origin, VersionOrigin.USER)
        self.assertEqual(revised.version.review_outcome, ReviewOutcome.REVISED)
        self.assertIsNone(self.store.pending(self.initial.file_id))

    def test_review_receipt_replays_after_disk_and_pending_have_changed(self) -> None:
        self._review()
        current = self.store.pending(self.initial.file_id)
        decision = ReviewDecision(current.review.id, current.revision, ReviewOutcome.ACCEPTED)
        expected = self.store.head(self.initial.file_id)[1]
        arguments = dict(
            expected_revision=expected,
            idempotency_key="receipt-review",
            operation_target=self.initial.file_id,
            review_decision=decision,
        )
        first = self.versions.seal(self.project.id, self.path, VersionOrigin.USER, **arguments)
        self._write(b"new user draft after acceptance", "post-acceptance")
        replay = self.versions.seal(self.project.id, self.path, VersionOrigin.USER, **arguments)
        self.assertEqual(first, replay)
        self.assertEqual(self.store.pending(self.initial.file_id).origin, PendingOrigin.USER)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 2)
        with self.assertRaises(ResourceVersionError) as failure:
            self.versions.seal(
                self.project.id,
                self.path,
                VersionOrigin.USER,
                **{
                    **arguments,
                    "review_decision": replace(decision, outcome=ReviewOutcome.REVISED),
                },
            )
        self.assertEqual(failure.exception.code, "idempotency_conflict")

    def test_stale_pending_revision_never_seals_or_clears_review(self) -> None:
        review = self._review()
        current = self.store.pending(self.initial.file_id)
        with self.assertRaises(ResourceVersionError) as failure:
            self.versions.seal(
                self.project.id,
                self.path,
                VersionOrigin.USER,
                expected_revision=self.store.head(self.initial.file_id)[1],
                idempotency_key="stale-review",
                operation_target=self.initial.file_id,
                review_decision=ReviewDecision(
                    review.id, current.revision - 1, ReviewOutcome.ACCEPTED
                ),
            )
        self.assertEqual(failure.exception.code, "pending_revision_conflict")
        self.assertEqual(self.store.pending(self.initial.file_id), current)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def test_receipt_failure_rolls_back_version_and_review_completion(self) -> None:
        self._review()
        before = self.store.pending(self.initial.file_id)
        with transaction(
            self.content.resolve(self.project.id, PROJECT_DB_RELATIVE), immediate=True
        ) as connection:
            connection.execute("""
                CREATE TRIGGER fail_review_receipt BEFORE INSERT ON resources_operations
                WHEN NEW.idempotency_key = 'failed-review-receipt'
                BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END
            """)
        with self.assertRaises(sqlite3.IntegrityError):
            self._decide(ReviewOutcome.ACCEPTED, "failed-review-receipt")
        self.assertEqual(self.store.pending(self.initial.file_id), before)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def _discard(self, key: str) -> None:
        current = self.store.pending(self.initial.file_id)
        self.recovery.discard_pending(
            self.project.id,
            self.initial.file_id,
            current.revision,
            self.store.head(self.initial.file_id)[1],
            key,
            version_id=self.initial.id,
        )

    def test_discard_returns_to_saved_without_creating_version(self) -> None:
        original = self.file.read_bytes()
        self._write(b"ordinary user draft", "ordinary-draft")
        self._discard("discard-draft")
        self.assertEqual(self.file.read_bytes(), original)
        self.assertIsNone(self.store.pending(self.initial.file_id))
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)
        self.assertEqual(self.store.snapshot_state(self.initial.file_id), SnapshotState.SAVED)

    def test_discard_restores_user_deleted_file_without_new_version(self) -> None:
        original = self.file.read_bytes()
        self.file.unlink()
        self.versions.record_changes(self.project.id, (self.path,))
        self._discard("discard-deletion")
        self.assertEqual(self.file.read_bytes(), original)
        self.assertIsNone(self.store.pending(self.initial.file_id))
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def test_discard_restores_saved_path_after_user_move(self) -> None:
        original = self.file.read_bytes()
        destination = self.file.with_name("moved.docx")
        destination_path = str(destination.relative_to(self.project.root))
        self.file.rename(destination)
        self.versions.record_moves(self.project.id, ((self.path, destination_path),))
        self._discard("discard-move")
        self.assertEqual(self.file.read_bytes(), original)
        self.assertFalse(destination.exists())
        self.assertEqual(self.store.identity(self.path)[0], self.initial.file_id)
        self.assertIsNone(self.store.pending(self.initial.file_id))
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def test_discard_cannot_bypass_agent_review(self) -> None:
        self._review()
        with self.assertRaises(ResourceRecoveryError):
            self._discard("discard-review")
        self.assertEqual(self.file.read_bytes(), b"agent candidate")
        self.assertTrue(self.store.pending(self.initial.file_id).needs_review)

    def test_discard_does_not_overwrite_external_bytes_or_mode_changes(self) -> None:
        self._write(b"ordinary draft", "ordinary-draft")
        self.file.write_bytes(b"external newer file")
        with self.assertRaises(ResourceRecoveryError):
            self._discard("discard-external")
        self.assertEqual(self.file.read_bytes(), b"external newer file")
        self.file.write_bytes(b"ordinary draft")
        self._toggle_file_mode()
        with self.assertRaises(ResourceRecoveryError):
            self._discard("discard-external-mode")
        self.assertIsNotNone(self.store.pending(self.initial.file_id))

    def test_discard_crash_recovery_does_not_seal(self) -> None:
        original = self.file.read_bytes()
        self._write(b"ordinary draft", "ordinary-draft")
        with patch.object(
            VersionStore, "commit_restore", side_effect=RuntimeError("simulated crash")
        ):
            with self.assertRaisesRegex(RuntimeError, "simulated crash"):
                self._discard("discard-crash")
        self.assertEqual(self.file.read_bytes(), original)
        self.assertIsNotNone(self.store.pending(self.initial.file_id))
        self.assertEqual(len(self.recovery.recover_pending(self.project.id)), 1)
        self.assertIsNone(self.store.pending(self.initial.file_id))
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def test_discard_receipt_does_not_overwrite_later_edit(self) -> None:
        self._write(b"ordinary draft", "ordinary-draft")
        current = self.store.pending(self.initial.file_id)
        revision = self.store.head(self.initial.file_id)[1]
        self._discard("discard-replay")
        self._write(b"newer draft", "after-discard")
        self.recovery.discard_pending(
            self.project.id,
            self.initial.file_id,
            current.revision,
            revision,
            "discard-replay",
            version_id=self.initial.id,
        )
        self.assertEqual(self.file.read_bytes(), b"newer draft")
        self.assertIsNotNone(self.store.pending(self.initial.file_id))

    def _reject(self, key: str) -> None:
        current = self.store.pending(self.initial.file_id)
        self.recovery.reject_review(
            self.project.id,
            self.initial.file_id,
            ReviewDecision(current.review.id, current.revision, ReviewOutcome.REJECTED),
            self.store.head(self.initial.file_id)[1],
            key,
        )

    def test_reject_restores_unsaved_user_baseline_as_version(self) -> None:
        self._review()
        self._reject("reject-original")
        self.assertEqual(self.file.read_bytes(), b"unsaved user baseline")
        history = self.store.history_for_file(self.initial.file_id)
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0].origin, VersionOrigin.RESTORE)
        self.assertEqual(history[0].object_id, self.store.head(self.initial.file_id)[1])
        self.assertIsNotNone(history[0].source_review_id)
        current = self.store.pending(self.initial.file_id)
        self.assertEqual(current.origin, PendingOrigin.USER)
        self.assertFalse(current.needs_review)
        self.assertEqual(self.store.snapshot_state(self.initial.file_id), SnapshotState.SAVED)

    def test_reject_never_overwrites_later_external_edit(self) -> None:
        self._review()
        self.file.write_bytes(b"external edit")
        with self.assertRaises(ResourceRecoveryError):
            self._reject("reject-conflict")
        self.assertEqual(self.file.read_bytes(), b"external edit")
        self.assertTrue(self.store.pending(self.initial.file_id).needs_review)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def test_reject_crash_after_disk_apply_recovers_without_sealing(self) -> None:
        review = self._review()
        with patch.object(
            VersionStore, "commit_restore", side_effect=RuntimeError("simulated crash")
        ):
            with self.assertRaisesRegex(RuntimeError, "simulated crash"):
                self._reject("reject-crash")
        self.assertEqual(self.file.read_bytes(), b"unsaved user baseline")
        self.assertEqual(self.store.pending(self.initial.file_id).review.id, review.id)
        restarted = ResourceRecoveryService(
            self.content,
            ResourceRetentionService(self.content, Settings()),
            PdfRecordStore(self.content),
        )
        recovered = restarted.recover_pending(self.project.id)
        self.assertEqual(len(recovered), 1)
        self.assertFalse(self.store.pending(self.initial.file_id).needs_review)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 2)
        self.assertEqual(restarted.recover_pending(self.project.id), ())

    def test_reject_receipt_replay_does_not_overwrite_a_new_user_draft(self) -> None:
        self._review()
        state = self.store.pending(self.initial.file_id)
        decision = ReviewDecision(state.review.id, state.revision, ReviewOutcome.REJECTED)
        revision = self.store.head(self.initial.file_id)[1]
        self.recovery.reject_review(
            self.project.id, self.initial.file_id, decision, revision, "reject-replay"
        )
        self._write(b"new draft after reject", "new-after-reject")
        self.recovery.reject_review(
            self.project.id, self.initial.file_id, decision, revision, "reject-replay"
        )
        self.assertEqual(self.file.read_bytes(), b"new draft after reject")
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 2)

    def test_reject_detects_external_permission_change(self) -> None:
        self._review()
        self._toggle_file_mode()
        with self.assertRaises(ResourceRecoveryError):
            self._reject("reject-mode-conflict")
        self.assertEqual(self.file.read_bytes(), b"agent candidate")
        self.assertTrue(self.store.pending(self.initial.file_id).needs_review)

    def test_reject_to_sealed_baseline_returns_saved_without_new_version(self) -> None:
        original = self.file.read_bytes()
        self._review(saved_base=True)
        self._reject("reject-saved")
        self.assertEqual(self.file.read_bytes(), original)
        self.assertIsNone(self.store.pending(self.initial.file_id))
        self.assertEqual(self.store.snapshot_state(self.initial.file_id), SnapshotState.SAVED)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def test_reject_recovery_preserves_competing_external_bytes(self) -> None:
        self._review()
        with patch.object(
            VersionStore, "commit_restore", side_effect=RuntimeError("simulated crash")
        ):
            with self.assertRaises(RuntimeError):
                self._reject("reject-crash-external")
        self.file.write_bytes(b"external bytes after crash")
        manifest = self.store.pending_restores()[0]
        restarted = ResourceRecoveryService(
            self.content,
            ResourceRetentionService(self.content, Settings()),
            PdfRecordStore(self.content),
        )
        self.assertEqual(restarted.recover_pending(self.project.id), ())
        self.assertEqual(self.store.restore_transaction(manifest.id).state.value, "needs_attention")
        self.assertEqual(restarted.recover_pending(self.project.id), ())
        self.assertEqual(self.file.read_bytes(), b"external bytes after crash")
        self.assertTrue(self.store.pending(self.initial.file_id).needs_review)

    def _client(self) -> TestClient:
        app = FastAPI()
        app.state.resource_versions = self.versions
        app.state.resource_recovery = self.recovery
        register_version_routes(app)
        client = TestClient(app)
        self.addCleanup(client.close)
        return client

    def _seal_payload(self) -> dict:
        current = self.versions.capability(self.project.id, self.path)
        return {
            "path": self.path,
            "expected_disk_revision": current.disk_revision,
            "expected_version_id": current.version_id,
            "expected_pending_revision": current.pending.revision if current.pending else None,
        }

    def _seal_http(self, payload: dict, key: str = "seal-pending"):
        return self._client().post(
            f"/api/resource/files/{self.initial.file_id}/versions",
            params={"project": self.project.id},
            headers={"Idempotency-Key": key},
            json=payload,
        )

    def test_ordinary_seal_requires_explicit_nullable_snapshot_fences(self) -> None:
        self._write(b"pending", "pending")
        payload = self._seal_payload()
        for field in ("expected_disk_revision", "expected_version_id", "expected_pending_revision"):
            with self.subTest(field=field):
                missing = {key: value for key, value in payload.items() if key != field}
                self.assertEqual(self._seal_http(missing, field).status_code, 400)
        for value in (True, 0, -1, "1"):
            with self.subTest(value=value):
                invalid = {**payload, "expected_pending_revision": value}
                self.assertEqual(self._seal_http(invalid, str(value)).status_code, 400)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    def test_ordinary_seal_rejects_stale_pending_even_when_bytes_match_again(self) -> None:
        self._write(b"pending", "pending")
        payload = self._seal_payload()
        self._write(b"new pending", "new-pending")
        self._write(b"pending", "back-to-pending")
        response = self._seal_http(payload)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["error"]["code"], "pending_revision_conflict")
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    def test_ordinary_seal_rejects_unobserved_metadata_and_null_version_mismatch(self) -> None:
        self._write(b"pending", "pending")
        payload = self._seal_payload()
        self._toggle_file_mode()
        response = self._seal_http(payload)
        self.assertEqual(response.status_code, 412, response.text)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)
        self._toggle_file_mode()
        response = self._seal_http({**payload, "expected_version_id": None}, "null-version")
        self.assertEqual(response.status_code, 412, response.text)

    def test_deleted_pending_can_be_sealed_and_replayed_without_reading_disk(self) -> None:
        self.file.unlink()
        self.versions.observe(self.project.id, self.path)
        payload = self._seal_payload()
        response = self._seal_http(payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["version"]["state"], "tombstone")
        self.assertEqual(response.json()["version"]["sequence"], 2)
        self.assertIsNone(self.store.pending(self.initial.file_id))
        self.assertFalse(self.file.exists())
        with patch.object(
            self.content, "stable_snapshot", side_effect=AssertionError("receipt first")
        ):
            replay = self._seal_http(payload)
        self.assertEqual(replay.json(), response.json())
        changed = self._seal_http({**payload, "expected_pending_revision": None})
        self.assertEqual(changed.status_code, 409, changed.text)
        self.assertEqual(changed.json()["error"]["code"], "idempotency_conflict")

    def test_first_pending_snapshot_seals_with_an_explicit_null_version_fence(self) -> None:
        path = "resources/unsealed.docx"
        target = Path(self.project.root) / path
        target.write_bytes(b"unsealed external document")
        self.versions._accept_working(self.project.id, None, path, PendingOrigin.EXTERNAL)
        current = self.versions.capability(self.project.id, path)
        self.assertIsNone(current.version_id)
        response = self._client().post(
            f"/api/resource/files/{current.file_id}/versions",
            params={"project": self.project.id},
            headers={"Idempotency-Key": "first-pending-seal"},
            json={
                "path": path,
                "expected_disk_revision": current.disk_revision,
                "expected_version_id": None,
                "expected_pending_revision": current.pending.revision,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["version"]["sequence"], 1)
        self.assertIsNone(self.store.pending(current.file_id))

    def test_ordinary_seal_does_not_bypass_an_open_agent_review(self) -> None:
        self._review()
        response = self._seal_http(self._seal_payload())
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["error"]["code"], "pending_review_requires_decision")
        self.assertIsNotNone(self.store.pending(self.initial.file_id).review)

    def test_deleted_version_history_remains_listed_without_disk_or_pending(self) -> None:
        self.file.unlink()
        self.versions.observe(self.project.id, self.path)
        sealed = self._seal_http(self._seal_payload())
        self.assertEqual(sealed.status_code, 200)
        client = self._client()
        with patch.object(
            self.content, "stable_snapshot", side_effect=AssertionError("ledger only")
        ):
            response = client.get(
                "/api/resource/files",
                params={
                    "project": self.project.id,
                    "state": "tombstone",
                    "limit": 1,
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json(),
            {
                "items": [
                    {
                        "file_id": self.initial.file_id,
                        "path": self.path,
                        "state": "tombstone",
                        "version_id": sealed.json()["version"]["id"],
                    }
                ],
                "next_cursor": None,
            },
        )
        self.assertEqual(
            client.get(
                "/api/resource/files",
                params={
                    "project": self.project.id,
                    "state": "tombstone",
                    "after_file_id": self.initial.file_id,
                },
            ).json()["items"],
            [],
        )
        self.assertEqual(
            client.get(
                "/api/resource/files",
                params={
                    "project": self.project.id,
                    "state": "present",
                },
            ).json()["items"],
            [],
        )
        self.assertEqual(
            client.get(
                "/api/resource/files",
                params={
                    "project": self.project.id,
                    "state": "invalid",
                },
            ).status_code,
            422,
        )

    def test_versioned_file_list_excludes_unversioned_tombstones_and_tracks_restoration(
        self,
    ) -> None:
        path = "resources/no-version.docx"
        target = Path(self.project.root) / path
        target.write_bytes(b"never saved")
        self.versions._accept_working(self.project.id, None, path, PendingOrigin.EXTERNAL)
        target.unlink()
        self.versions.observe(self.project.id, path)
        client = self._client()
        self.assertEqual(
            client.get(
                "/api/resource/files",
                params={
                    "project": self.project.id,
                    "state": "tombstone",
                },
            ).json()["items"],
            [],
        )
        self.file.unlink()
        self.versions.observe(self.project.id, self.path)
        self._discard("restore-listed-file")
        self.assertEqual(
            client.get(
                "/api/resource/files",
                params={
                    "project": self.project.id,
                    "state": "tombstone",
                },
            ).json()["items"],
            [],
        )
        self.assertEqual(
            len(
                client.get(
                    "/api/resource/files",
                    params={
                        "project": self.project.id,
                        "state": "present",
                    },
                ).json()["items"]
            ),
            1,
        )

    def test_versioned_file_list_pages_deleted_identities_without_duplicates(self) -> None:
        self.file.unlink()
        self.versions.observe(self.project.id, self.path)
        other_path = "resources/other-history.docx"
        other = Path(self.project.root) / other_path
        other.write_bytes(b"other saved document")
        saved = self.versions.ensure_initial(self.project.id, other_path).version
        other.unlink()
        self.versions.observe(self.project.id, other_path)
        client = self._client()
        first = client.get(
            "/api/resource/files",
            params={
                "project": self.project.id,
                "state": "tombstone",
                "limit": 1,
            },
        ).json()
        self.assertIsNotNone(first["next_cursor"])
        second = client.get(
            "/api/resource/files",
            params={
                "project": self.project.id,
                "state": "tombstone",
                "limit": 1,
                "after_file_id": first["next_cursor"],
            },
        ).json()
        self.assertIsNone(second["next_cursor"])
        self.assertEqual(
            {row["file_id"] for row in first["items"] + second["items"]},
            {self.initial.file_id, saved.file_id},
        )

    def test_pending_list_survives_disk_deletion_and_does_not_read_file_bytes(self) -> None:
        self._review()
        self.file.unlink()
        self.versions.record_changes(self.project.id, (self.path,))
        client = self._client()
        with patch.object(
            self.content, "stable_snapshot", side_effect=AssertionError("list must not read bytes")
        ):
            response = client.get(
                "/api/resource/pending", params={"project": self.project.id, "limit": 1}
            )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(len(data["items"]), 1)
        self.assertEqual(data["items"][0]["path"], self.path)
        self.assertEqual(data["items"][0]["state"], "tombstone")
        self.assertEqual(data["items"][0]["pending"]["file_id"], self.initial.file_id)
        self.assertIsNotNone(data["items"][0]["pending"]["review"])
        self.assertIsNone(data["next_cursor"])
        self.assertEqual(
            client.get(
                "/api/resource/pending",
                params={
                    "project": self.project.id,
                    "after_file_id": self.initial.file_id,
                },
            ).json()["items"],
            [],
        )
        self.assertEqual(
            client.get(
                "/api/resource/pending",
                params={
                    "project": self.project.id,
                    "limit": 0,
                },
            ).status_code,
            422,
        )

    def test_pending_list_pagination_has_no_duplicate_or_missing_file(self) -> None:
        self._write(b"first draft", "first-draft")
        other = self.file.with_name("second.md")
        other.write_bytes(b"second baseline")
        path = str(other.relative_to(self.project.root))
        initial = self.versions.ensure_initial(self.project.id, path).version
        self.versions.commit_working(
            self.project.id, path, b"second draft", initial.object_id, "second-draft"
        )
        client = self._client()
        first = client.get(
            "/api/resource/pending", params={"project": self.project.id, "limit": 1}
        ).json()
        self.assertIsNotNone(first["next_cursor"])
        second = client.get(
            "/api/resource/pending",
            params={
                "project": self.project.id,
                "limit": 1,
                "after_file_id": first["next_cursor"],
            },
        ).json()
        self.assertIsNone(second["next_cursor"])
        actual = [item["pending"]["file_id"] for page in (first, second) for item in page["items"]]
        self.assertEqual(actual, sorted((self.initial.file_id, initial.file_id)))

    def test_discard_http_requires_explicit_snapshot_and_replays(self) -> None:
        original = self.file.read_bytes()
        self._write(b"ordinary draft", "ordinary-draft")
        current = self.store.pending(self.initial.file_id)
        client = self._client()
        url = f"/api/resource/files/{self.initial.file_id}/pending/discard"
        payload = {
            "pending_revision": current.revision,
            "version_id": self.initial.id,
            "expected_disk_revision": self.store.head(self.initial.file_id)[1],
        }
        params, headers = {"project": self.project.id}, {"Idempotency-Key": "http-discard"}
        self.assertEqual(client.post(url, params=params, json=payload).status_code, 400)
        self.assertEqual(
            client.post(
                url, params=params, json={**payload, "pending_revision": True}, headers=headers
            ).status_code,
            400,
        )
        stale = client.post(
            url,
            params=params,
            json={**payload, "pending_revision": current.revision + 1},
            headers=headers,
        )
        self.assertEqual(stale.status_code, 409)
        result = client.post(url, params=params, json=payload, headers=headers)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(self.file.read_bytes(), original)
        self._write(b"newer draft", "after-http-discard")
        self.assertEqual(
            client.post(url, params=params, json=payload, headers=headers).json(), {"ok": True}
        )
        self.assertEqual(self.file.read_bytes(), b"newer draft")
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def test_capability_and_review_http_use_the_same_pending_identity(self) -> None:
        self._review()
        client = self._client()
        capability = client.get(
            "/api/resource/capability", params={"project": self.project.id, "path": self.path}
        ).json()
        state = capability["pending"]
        self.assertEqual(state["review"]["id"], self.store.pending(self.initial.file_id).review.id)
        self.assertEqual(capability["snapshot_state"], "pending")
        payload = {
            "path": self.path,
            "review_id": state["review"]["id"],
            "pending_revision": state["revision"],
            "expected_disk_revision": capability["disk_revision"],
        }
        url = f"/api/resource/files/{self.initial.file_id}/review/accept"
        self.assertEqual(
            client.post(url, params={"project": self.project.id}, json=payload).status_code, 400
        )
        accepted = client.post(
            url,
            params={"project": self.project.id},
            json=payload,
            headers={"Idempotency-Key": "http-accept"},
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(accepted.json()["version"]["origin"], "agent")
        replay = client.post(
            url,
            params={"project": self.project.id},
            json=payload,
            headers={"Idempotency-Key": "http-accept"},
        )
        self.assertEqual(accepted.json(), replay.json())

    def test_review_base_http_reads_exact_unsaved_baseline(self) -> None:
        review = self._review()
        response = self._client().get(
            f"/api/resource/files/{self.initial.file_id}/review/{review.id}/base",
            params={"project": self.project.id},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"unsaved user baseline")

    def test_review_http_reject_restores_draft_as_version(self) -> None:
        review = self._review()
        client = self._client()
        current = self.store.pending(self.initial.file_id)
        payload = {
            "review_id": review.id,
            "pending_revision": current.revision,
            "expected_disk_revision": review.candidate_revision,
        }
        url = f"/api/resource/files/{self.initial.file_id}/review/reject"
        response = client.post(
            url,
            params={"project": self.project.id},
            json=payload,
            headers={"Idempotency-Key": "http-reject"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.file.read_bytes(), b"unsaved user baseline")
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 2)
        restored = self.store.pending(self.initial.file_id)
        self.assertEqual(restored.origin, PendingOrigin.USER)
        self.assertIsNone(restored.review)
        replay = client.post(
            url,
            params={"project": self.project.id},
            json=payload,
            headers={"Idempotency-Key": "http-reject"},
        )
        self.assertEqual(response.json(), replay.json())

    def test_review_http_stale_decision_does_not_discard_user_edit(self) -> None:
        review = self._review()
        revision = self.store.pending(self.initial.file_id).revision
        self._write(b"latest user revision", "http-user-edit")
        client = self._client()
        for action in ("accept", "reject", "revise"):
            with self.subTest(action=action):
                response = client.post(
                    f"/api/resource/files/{self.initial.file_id}/review/{action}",
                    params={"project": self.project.id},
                    headers={"Idempotency-Key": f"http-stale-{action}"},
                    json={
                        "path": self.path,
                        "review_id": review.id,
                        "pending_revision": revision,
                        "expected_disk_revision": review.candidate_revision,
                    },
                )
                # Sealing checks disk If-Match first; rejection checks its frozen review first.
                self.assertEqual(
                    response.status_code, 409 if action == "reject" else 412, response.text
                )
                self.assertEqual(self.file.read_bytes(), b"latest user revision")
                self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def test_review_http_revise_seals_user_result_with_agent_provenance(self) -> None:
        review = self._review()
        self._write(b"reviewed user result", "http-revise-edit")
        current = self.versions.capability(self.project.id, self.path)
        bulk = self.versions.capability_states(self.project.id, (self.path,))[self.path]
        self.assertEqual(bulk.pending, current.pending)
        response = self._client().post(
            f"/api/resource/files/{self.initial.file_id}/review/revise",
            params={"project": self.project.id},
            headers={"Idempotency-Key": "http-revise"},
            json={
                "path": self.path,
                "review_id": review.id,
                "pending_revision": current.pending.revision,
                "expected_disk_revision": current.disk_revision,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        version = response.json()["version"]
        self.assertEqual(version["origin"], "user")
        self.assertEqual(version["source_review_id"], review.id)
        self.assertEqual(version["review_outcome"], "revised")
        self.assertIsNone(self.store.pending(self.initial.file_id))

    def test_tree_projects_review_lineage_without_reading_document_bytes(self) -> None:
        self._review()
        app = FastAPI()
        app.state.content = self.content
        supervisor = ResourceVersionSupervisor(
            self.content,
            self.versions,
            WorkbenchFormatPolicy(),
            Settings(),
            activities=Activities(),
        )
        retention = ResourceRetentionService(self.content, Settings())
        supervisor.bind_preparation(
            ResourceActivation(
                self.content,
                self.recovery,
                self.versions,
                ResourceDeliveryService(
                    self.content, self.versions, supervisor, activities=supervisor._activities
                ),
                retention,
                ResourceReviewMigration(self.content, self.versions),
            )
        )
        asyncio.run(supervisor.prepare_project(self.project.id))
        app.state.resource_version_supervisor = supervisor
        register_resource_routes(app)
        with TestClient(app) as client:
            for edited in (False, True):
                if edited:
                    self._write(b"user edits pending agent candidate", "tree-review-edit")
                # This contract isolates list serialization from asynchronous discovery;
                # real watcher/discovery lifecycle is covered by contract_resource_observation.
                with (
                    patch.object(supervisor, "schedule_scan") as schedule,
                    patch.object(
                        self.content,
                        "stable_snapshot",
                        side_effect=AssertionError("tree must not read bytes"),
                    ),
                ):
                    response = client.get("/api/resource/tree", params={"project": self.project.id})
                    schedule.assert_called_once_with(self.project.id)
                self.assertEqual(response.status_code, 200, response.text)
                node = next(node for node in response.json()["nodes"] if node["path"] == self.path)
                self.assertEqual(
                    node["version"],
                    {
                        "management_state": "managed",
                        "manual_admitted": False,
                        "drifted": False,
                        "snapshot_state": "pending",
                        "pending_origin": "agent",
                        "needs_review": True,
                    },
                )

    def test_bulk_review_drift_includes_external_permission_changes(self) -> None:
        self._review()
        self._toggle_file_mode()
        self.versions.observe(self.project.id, self.path)
        single = self.versions.capability(self.project.id, self.path)
        bulk = self.versions.capability_states(self.project.id, (self.path,))[self.path]
        self.assertTrue(single.drifted)
        self.assertTrue(bulk.drifted)
        self.assertEqual(bulk.snapshot_state, SnapshotState.PENDING)
        self.assertEqual(bulk.pending, single.pending)


if __name__ == "__main__":
    unittest.main()
