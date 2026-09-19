"""Legacy review cutover uses verified immutable evidence, never guesses bytes."""

from __future__ import annotations

import hashlib
import json
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import transaction
from service.platform.resources import (
    ReviewDecision,
    ReviewOutcome,
    SnapshotState,
    TurnOutcome,
    VersionOrigin,
)
from service.resources.api.versions import register_version_routes
from service.resources.persistence import migration
from service.resources.persistence.version import VersionStoreConflict
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.service.records import PdfRecordStore

from . import contract_pending_capture as capture_fixture
from .historical import historical_delivery


class ReviewMigrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.fixture = capture_fixture.PendingCaptureTests()
        await self.fixture.asyncSetUp()
        self.addAsyncCleanup(self.fixture.asyncTearDown)
        self.migration = ResourceReviewMigration(self.fixture.content, self.fixture.versions)

    async def legacy(self, *, archive: bool = True) -> None:
        f = self.fixture
        await f._change("legacy-turn", b"agent candidate")
        capture = await f.capture.finish_turn("session", "legacy-turn", TurnOutcome.COMPLETED)
        if archive:
            historical_delivery(f.content, f.project.id, capture)
        before, after = (
            hashlib.sha256(value).hexdigest() for value in (b"initial", b"agent candidate")
        )
        for digest, value in ((before, b"initial"), (after, b"agent candidate")):
            path = (
                Path(f.project.root) / ".scholarseed/service/documents/blobs" / digest[:2] / digest
            )
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
        with transaction(f.content.resolve(f.project.id, PROJECT_DB_RELATIVE)) as connection:
            connection.executescript("""
                CREATE TABLE documents_change_sets (
                    id TEXT PRIMARY KEY, project_id TEXT, session_id TEXT, turn_id TEXT,
                    latest_session_id TEXT, latest_turn_id TEXT, state TEXT, revision INTEGER,
                    baseline_complete INTEGER
                );
                CREATE TABLE documents_change_files (
                    change_set_id TEXT, path TEXT, change_kind TEXT, before_sha256 TEXT,
                    before_blob TEXT, after_sha256 TEXT, after_blob TEXT, decision TEXT
                );
            """)
            connection.execute(
                "INSERT INTO documents_change_sets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "legacy",
                    f.project.id,
                    "session",
                    "legacy-turn",
                    "session",
                    "legacy-turn",
                    "pending",
                    0,
                    1,
                ),
            )
            connection.execute(
                "INSERT INTO documents_change_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("legacy", f.path, "modified", before, before, after, after, "revert"),
            )

    async def test_matching_legacy_review_migrates_without_executing_saved_decision(self) -> None:
        await self.legacy()
        f = self.fixture
        versions = f.store.history_for_file(f.initial.file_id)
        self.migration.prepare(f.project.id)
        review = f.store.pending(f.initial.file_id).review
        self.assertEqual(review.base.object_id, f.initial.object_id)
        self.assertEqual(
            review.candidate.object_id, f.content.snapshot(f.project.id, f.path).revision
        )
        self.assertEqual(f.file.read_bytes(), b"agent candidate")
        self.assertEqual(f.store.history_for_file(f.initial.file_id), versions)
        self.assertEqual(self.migration.records(f.project.id)[0].status, "migrated")
        self.assertEqual(f.store.snapshot_state(f.initial.file_id), SnapshotState.PENDING)
        self.assertEqual(
            f.store.capability_states((f.path,))[f.path].snapshot_state, SnapshotState.PENDING
        )
        original = f.store.pending(f.initial.file_id)
        self.migration.prepare(f.project.id)
        self.assertEqual(f.store.pending(f.initial.file_id), original)

    async def test_disk_conflict_is_a_blocker_not_a_rollback(self) -> None:
        await self.legacy()
        f = self.fixture
        f.file.write_bytes(b"external newer file")
        self.migration.prepare(f.project.id)
        self.assertEqual(f.file.read_bytes(), b"external newer file")
        self.assertEqual(f.store.pending(f.initial.file_id).origin.value, "external")
        self.assertEqual(self.migration.records(f.project.id)[0].blocker, "legacy_disk_conflict")

    async def test_rejected_migration_keeps_history_and_does_not_reopen(self) -> None:
        await self.legacy()
        f = self.fixture
        versions = f.store.history_for_file(f.initial.file_id)
        self.assertEqual(len(versions), 2)
        blobs = Path(f.project.root) / ".scholarseed/service/documents/blobs"
        original_blobs = {path: path.read_bytes() for path in blobs.rglob("*") if path.is_file()}
        with transaction(f.content.resolve(f.project.id, PROJECT_DB_RELATIVE)) as connection:
            source = tuple(connection.execute("SELECT * FROM documents_change_files").fetchone())
        self.migration.prepare(f.project.id)
        f._reject(f.initial.file_id)
        self.assertEqual(f.file.read_bytes(), b"initial")
        self.assertEqual(f.store.history_for_file(f.initial.file_id), versions)
        pending = f.store.pending(f.initial.file_id)
        self.assertFalse(pending.needs_review)
        self.assertEqual(pending.origin.value, "user")
        self.assertEqual(f.store.snapshot_state(f.initial.file_id), SnapshotState.PENDING)
        self.migration.prepare(f.project.id)
        self.assertEqual(f.store.pending(f.initial.file_id), pending)
        with transaction(f.content.resolve(f.project.id, PROJECT_DB_RELATIVE)) as connection:
            self.assertEqual(
                tuple(connection.execute("SELECT * FROM documents_change_files").fetchone()), source
            )
        self.assertEqual({path: path.read_bytes() for path in original_blobs}, original_blobs)

    async def test_explicit_resolution_preserves_legacy_bytes_and_replays_before_disk_read(
        self,
    ) -> None:
        await self.legacy()
        f = self.fixture
        with transaction(f.content.resolve(f.project.id, PROJECT_DB_RELATIVE)) as connection:
            connection.execute("UPDATE documents_change_sets SET baseline_complete = 0")
        self.migration.prepare(f.project.id)
        record = self.migration.records(f.project.id)[0]
        version = f.store.history_for_file(f.initial.file_id)[0]
        request = migration.MigrationResolution(
            record.source_id,
            record.path,
            record.source_digest,
            f.initial.file_id,
            version.id,
            "resolve-legacy",
        )
        result = self.migration.resolve(f.project.id, request)
        self.assertEqual(result.status, "resolved")
        self.assertEqual(f.file.read_bytes(), b"agent candidate")
        self.assertEqual(f.store.history_for_file(f.initial.file_id)[0], version)
        f.file.write_bytes(b"later external change")
        self.assertEqual(self.migration.resolve(f.project.id, request), result)
        self.assertEqual(f.file.read_bytes(), b"later external change")
        self.migration.prepare(f.project.id)
        self.assertEqual(self.migration.records(f.project.id)[0].status, "resolved")
        with transaction(f.content.resolve(f.project.id, PROJECT_DB_RELATIVE)) as connection:
            self.assertEqual(
                connection.execute("SELECT decision FROM documents_change_files").fetchone()[0],
                "revert",
            )
            self.assertEqual(
                connection.execute("SELECT decision FROM resources_review_migrations").fetchone()[
                    0
                ],
                "revert",
            )

    async def test_resolution_rejects_unsaved_current_snapshot(self) -> None:
        await self.legacy()
        f = self.fixture
        f.file.write_bytes(b"unsealed external content")
        self.migration.prepare(f.project.id)
        record = self.migration.records(f.project.id)[0]
        version = f.store.history_for_file(f.initial.file_id)[0]
        request = migration.MigrationResolution(
            record.source_id,
            record.path,
            record.source_digest,
            f.initial.file_id,
            version.id,
            "not-saved",
        )
        with self.assertRaisesRegex(migration.MigrationError, "legacy_resolution_not_saved"):
            self.migration.resolve(f.project.id, request)
        self.assertEqual(f.file.read_bytes(), b"unsealed external content")

    async def blocked_resolution(self) -> migration.MigrationResolution:
        await self.legacy()
        f = self.fixture
        with transaction(f.content.resolve(f.project.id, PROJECT_DB_RELATIVE)) as connection:
            connection.execute("UPDATE documents_change_sets SET baseline_complete = 0")
        self.migration.prepare(f.project.id)
        record = self.migration.records(f.project.id)[0]
        return migration.MigrationResolution(
            record.source_id,
            record.path,
            record.source_digest,
            f.initial.file_id,
            f.store.identity(f.path)[2],
            "confirm",
        )

    async def test_resolution_requires_unchanged_source_even_at_same_revision(self) -> None:
        request = await self.blocked_resolution()
        f = self.fixture
        with transaction(f.content.resolve(f.project.id, PROJECT_DB_RELATIVE)) as connection:
            connection.execute("UPDATE documents_change_files SET decision = 'accept'")
        with self.assertRaisesRegex(migration.MigrationError, "legacy_source_changed"):
            self.migration.resolve(f.project.id, request)
        self.assertEqual(self.migration.records(f.project.id)[0].status, "blocked")

    async def test_resolution_checks_disk_mode_and_current_version(self) -> None:
        request = await self.blocked_resolution()
        f = self.fixture
        with self.assertRaisesRegex(migration.MigrationError, "legacy_resolution_not_saved"):
            self.migration.resolve(f.project.id, replace(request, version_id=f.initial.id))
        mode = f.file.stat().st_mode & 0o777
        f.file.chmod(mode ^ 0o100)
        with self.assertRaisesRegex(migration.MigrationError, "legacy_disk_conflict"):
            self.migration.resolve(f.project.id, request)
        f.file.chmod(mode)
        f.file.write_bytes(b"racing external bytes")
        with self.assertRaisesRegex(migration.MigrationError, "legacy_disk_conflict"):
            self.migration.resolve(f.project.id, request)
        self.assertEqual(f.file.read_bytes(), b"racing external bytes")

    async def test_resolution_cannot_hide_an_active_turn_or_competing_review(self) -> None:
        request = await self.blocked_resolution()
        f = self.fixture
        await f._change("competing", b"new agent candidate")
        with self.assertRaisesRegex(migration.MigrationError, "legacy_turn_active"):
            self.migration.resolve(f.project.id, request)
        await f.capture.finish_turn("session", "competing", TurnOutcome.COMPLETED)
        pending = f.store.pending(f.initial.file_id)
        with self.assertRaisesRegex(migration.MigrationError, "legacy_resolution_not_saved"):
            self.migration.resolve(f.project.id, request)
        self.assertEqual(f.store.pending(f.initial.file_id), pending)

    async def test_save_then_resolve_and_changed_retry_intent_conflicts(self) -> None:
        request = await self.blocked_resolution()
        f = self.fixture
        f.file.write_bytes(b"user selected final content")
        f.versions.observe(f.project.id, f.path)
        current = f.store.pending(f.initial.file_id)
        version = f.versions.seal(
            f.project.id,
            f.path,
            VersionOrigin.USER,
            expected_revision=f.content.snapshot(f.project.id, f.path).revision,
            expected_version_id=request.version_id,
            expected_pending_revision=current.revision,
            idempotency_key="user-save",
            operation_target=f.initial.file_id,
        ).version
        request = replace(request, version_id=version.id)
        self.assertEqual(self.migration.resolve(f.project.id, request).status, "resolved")
        with self.assertRaisesRegex(migration.MigrationError, "legacy_resolution_conflict"):
            self.migration.resolve(f.project.id, replace(request, version_id=f.initial.id))
        self.assertEqual(f.file.read_bytes(), b"user selected final content")

    async def test_discard_then_resolve_creates_no_version(self) -> None:
        request = await self.blocked_resolution()
        f = self.fixture
        before = f.store.history_for_file(f.initial.file_id)
        f.file.write_bytes(b"unwanted external content")
        f.versions.observe(f.project.id, f.path)
        recovery = ResourceRecoveryService(
            f.content,
            ResourceRetentionService(f.content, capture_fixture.Settings()),
            PdfRecordStore(f.content),
        )
        recovery.discard_pending(
            f.project.id,
            f.initial.file_id,
            f.store.pending(f.initial.file_id).revision,
            f.content.snapshot(f.project.id, f.path).revision,
            "user-discard",
            version_id=request.version_id,
        )
        self.assertEqual(self.migration.resolve(f.project.id, request).status, "resolved")
        self.assertEqual(f.file.read_bytes(), b"agent candidate")
        self.assertEqual(f.store.history_for_file(f.initial.file_id), before)

    async def test_resolution_receipt_rolls_back_and_http_replays(self) -> None:
        request = await self.blocked_resolution()
        f = self.fixture
        original = migration.resolve

        def fail_after_write(*args):
            original(*args)
            raise RuntimeError("receipt transaction failed")

        with patch.object(migration, "resolve", side_effect=fail_after_write):
            with self.assertRaisesRegex(RuntimeError, "receipt transaction failed"):
                self.migration.resolve(f.project.id, request)
        self.assertEqual(self.migration.records(f.project.id)[0].status, "blocked")
        app = FastAPI()
        app.state.resource_review_migration = self.migration
        register_version_routes(app)
        body = {
            key: getattr(request, key)
            for key in ("source_id", "path", "source_digest", "file_id", "version_id")
        }
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            endpoint = "/api/resource/review-migrations/resolve"
            params = {"project": f.project.id}
            self.assertEqual(
                (await client.post(endpoint, params=params, json=body)).status_code, 400
            )
            headers = {"Idempotency-Key": request.idempotency_key}
            result = await client.post(endpoint, params=params, json=body, headers=headers)
            self.assertEqual(result.status_code, 200)
            f.file.unlink()
            self.assertEqual(
                (await client.post(endpoint, params=params, json=body, headers=headers)).json(),
                result.json(),
            )

    async def test_accepted_migration_cannot_reopen_on_restart(self) -> None:
        await self.legacy()
        f = self.fixture
        self.migration.prepare(f.project.id)
        pending = f.store.pending(f.initial.file_id)
        result = f.versions.seal_review(
            f.project.id,
            f.initial.file_id,
            f.path,
            ReviewDecision(pending.review.id, pending.revision, ReviewOutcome.ACCEPTED),
            f.content.snapshot(f.project.id, f.path).revision,
            "accept-migrated-review",
        )
        self.assertEqual(result.version.source_review_id, pending.review.id)
        self.assertIsNone(f.store.pending(f.initial.file_id))
        ResourceReviewMigration(f.content, f.versions).prepare(f.project.id)
        self.assertIsNone(f.store.pending(f.initial.file_id))
        self.assertEqual(f.store.snapshot_state(f.initial.file_id), SnapshotState.SAVED)

    async def test_existing_review_is_not_overwritten(self) -> None:
        await self.legacy(archive=False)
        f = self.fixture
        original = f.store.pending(f.initial.file_id)
        self.migration.prepare(f.project.id)
        self.assertEqual(f.store.pending(f.initial.file_id), original)
        self.assertEqual(self.migration.records(f.project.id)[0].blocker, "legacy_review_conflict")

    async def test_missing_terminal_proof_does_not_invent_metadata(self) -> None:
        await self.legacy()
        f = self.fixture
        with transaction(f.content.resolve(f.project.id, PROJECT_DB_RELATIVE)) as connection:
            connection.execute("UPDATE resources_turns SET terminal_outcome = NULL")
        self.migration.prepare(f.project.id)
        self.assertIsNone(f.store.pending(f.initial.file_id))
        self.assertEqual(self.migration.records(f.project.id)[0].blocker, "legacy_evidence_missing")

    async def test_corrupt_baseline_blob_is_preserved_and_reported(self) -> None:
        await self.legacy()
        f = self.fixture
        digest = hashlib.sha256(b"initial").hexdigest()
        blob = Path(f.project.root) / ".scholarseed/service/documents/blobs" / digest[:2] / digest
        blob.write_bytes(b"corrupt")
        self.migration.prepare(f.project.id)
        self.assertIsNone(f.store.pending(f.initial.file_id))
        self.assertEqual(blob.read_bytes(), b"corrupt")
        self.assertEqual(self.migration.records(f.project.id)[0].blocker, "legacy_blob_invalid")

    async def test_unknown_delivery_attribution_is_not_promoted_to_agent(self) -> None:
        await self.legacy()
        f = self.fixture
        with transaction(f.content.resolve(f.project.id, PROJECT_DB_RELATIVE)) as connection:
            connection.execute("UPDATE resources_delivery_members SET attribution = 'unknown'")
        self.migration.prepare(f.project.id)
        self.assertIsNone(f.store.pending(f.initial.file_id))
        self.assertEqual(self.migration.records(f.project.id)[0].blocker, "legacy_evidence_invalid")

    async def test_unknown_manifest_attribution_is_not_promoted_to_agent(self) -> None:
        await self.legacy()
        f = self.fixture
        manifest = {"members": [{"attribution": "unknown", "baseline": {"path": f.path}}]}
        with transaction(f.content.resolve(f.project.id, PROJECT_DB_RELATIVE)) as connection:
            connection.execute(
                "UPDATE resources_turns SET finalization_manifest_json = ?", (json.dumps(manifest),)
            )
        self.migration.prepare(f.project.id)
        self.assertIsNone(f.store.pending(f.initial.file_id))
        self.assertEqual(self.migration.records(f.project.id)[0].blocker, "legacy_evidence_invalid")

    async def test_pending_and_receipt_rollback_together(self) -> None:
        await self.legacy()
        f = self.fixture
        with patch.object(migration, "receipt", side_effect=RuntimeError("receipt failure")):
            with self.assertRaisesRegex(RuntimeError, "receipt failure"):
                self.migration.prepare(f.project.id)
        self.assertIsNone(f.store.pending(f.initial.file_id))
        self.assertEqual(self.migration.records(f.project.id), ())
        self.assertEqual(f.file.read_bytes(), b"agent candidate")
        self.migration.prepare(f.project.id)
        self.assertEqual(self.migration.records(f.project.id)[0].status, "migrated")

    async def test_blocked_review_pins_history_until_recheck_succeeds(self) -> None:
        await self.legacy()
        f = self.fixture
        f.file.write_bytes(b"external newer file")
        self.migration.prepare(f.project.id)
        self.assertEqual(f.store.retention_plan(1), ((), (), ()))
        f.file.write_bytes(b"agent candidate")
        f.versions.observe(f.project.id, f.path)
        self.migration.prepare(f.project.id)
        self.assertEqual(self.migration.records(f.project.id)[0].status, "migrated")

    async def test_retention_revalidates_legacy_protection_after_preview(self) -> None:
        await self.legacy()
        f = self.fixture
        with transaction(f.content.resolve(f.project.id, PROJECT_DB_RELATIVE)) as connection:
            connection.execute("UPDATE documents_change_sets SET state = 'accepted'")
        versions, _, deliveries = f.store.retention_plan(1)
        self.assertTrue(versions)
        with transaction(f.content.resolve(f.project.id, PROJECT_DB_RELATIVE)) as connection:
            connection.execute("UPDATE documents_change_sets SET state = 'pending'")
        with self.assertRaisesRegex(VersionStoreConflict, "retention_preview_stale"):
            f.store.apply_retention(versions, deliveries)
        self.migration.prepare(f.project.id)
        self.assertEqual(self.migration.records(f.project.id)[0].status, "migrated")

    async def test_http_reports_blockers_and_rechecks_without_legacy_routes(self) -> None:
        await self.legacy()
        f = self.fixture
        app = FastAPI()
        app.state.resource_review_migration = self.migration
        register_version_routes(app)
        f.file.write_bytes(b"external newer file")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            endpoint = "/api/resource/review-migrations"
            params = {"project": f.project.id}
            self.assertEqual((await client.get(endpoint, params=params)).json(), {"items": []})
            result = await client.post(endpoint + "/recheck", params=params)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["items"][0]["blocker"], "legacy_disk_conflict")
            self.assertEqual(f.file.read_bytes(), b"external newer file")
            f.file.write_bytes(b"agent candidate")
            f.versions.observe(f.project.id, f.path)
            result = await client.post(endpoint + "/recheck", params=params)
            self.assertEqual(result.json()["items"][0]["status"], "migrated")
            self.assertEqual((await client.get("/api/review", params=params)).status_code, 404)


if __name__ == "__main__":
    unittest.main()
