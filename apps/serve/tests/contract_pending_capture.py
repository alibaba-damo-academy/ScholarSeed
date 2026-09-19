"""Agent terminal capture produces review candidates, never automatic versions."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE
from service.platform.resources import (
    FileState,
    PendingOrigin,
    ReviewDecision,
    ReviewOutcome,
    TurnOutcome,
)
from service.resources.api.versions import register_version_routes
from service.resources.persistence.version import VersionStore
from service.resources.service.activation import ResourceActivation
from service.resources.service.context import MAX_RESOURCE_CONTEXT_CHARS, resource_turn_context
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.history import ResourceVersionError, ResourceVersionService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.service.records import PdfRecordStore


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


class PendingCaptureTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "catalog.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog)
        self.project = registry.create("pending capture")
        self.path = "resources/notes.md"
        self.file = Path(self.project.root) / self.path
        self.file.write_bytes(b"initial")
        policy, settings = WorkbenchFormatPolicy(), Settings()
        self.versions = ResourceVersionService(
            self.content,
            ResourceRetentionService(self.content, settings),
            policy,
            PdfRecordStore(self.content),
        )
        self.initial = self.versions.ensure_initial(self.project.id, self.path).version
        self.store = VersionStore(
            self.content.resolve(self.project.id, PROJECT_DB_RELATIVE), self.project.root
        )
        self.supervisor = ResourceVersionSupervisor(self.content, self.versions, policy, settings)
        self.capture = ResourceDeliveryService(self.content, self.versions, self.supervisor)
        retention = ResourceRetentionService(self.content, settings)
        self.supervisor.bind_preparation(
            ResourceActivation(
                self.content,
                ResourceRecoveryService(self.content, retention, PdfRecordStore(self.content)),
                self.versions,
                self.capture,
                retention,
                ResourceReviewMigration(self.content, self.versions),
            )
        )

    async def asyncTearDown(self) -> None:
        await self.supervisor.aclose()
        self.temp.cleanup()

    async def _change(self, turn: str, content: bytes) -> None:
        await self.capture.begin_turn("session", turn, self.project.root)
        await self.capture.bind_turn("session", turn, turn, "generation")
        self.file.write_bytes(content)
        await self.capture.record_change(
            "session", turn, str(self.file), "update", generation="generation"
        )

    async def test_completed_capture_never_auto_seals(self) -> None:
        await self._change("turn", b"agent")
        receipt = await self.capture.finish_turn("session", "turn", TurnOutcome.COMPLETED)
        self.assertEqual(receipt.file_ids, (self.initial.file_id,))
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)
        self.assertEqual(self.store.deliveries(10), ())
        self.assertFalse((Path(self.project.root) / ".scholarseed/service/documents").exists())
        current = self.store.pending(self.initial.file_id)
        self.assertEqual(current.origin, PendingOrigin.AGENT)
        self.assertTrue(current.needs_review)
        self.assertEqual(current.review.base.object_id, self.initial.object_id)
        self.assertEqual(
            current.review.candidate, self.store.working_snapshot(self.initial.file_id)
        )
        self.assertEqual(
            await self.capture.finish_turn("session", "turn", TurnOutcome.COMPLETED), receipt
        )

    async def test_next_turn_context_is_scoped_and_frozen(self) -> None:
        first = await self.capture.begin_turn("session", "first", self.project.root)
        self.assertEqual(first.model_context, "")
        await self.capture.finish_turn("session", "first", TurnOutcome.COMPLETED)
        await self._change("change", b"agent")
        await self.capture.finish_turn("session", "change", TurnOutcome.COMPLETED)
        pending = self.store.pending(self.initial.file_id)
        with patch("service.resources.service.delivery.emit") as emitted:
            context = await self.capture.begin_turn("session", "next", self.project.root)
        fields = emitted.call_args.kwargs
        self.assertEqual(
            fields["context_sha256"], hashlib.sha256(context.model_context.encode()).hexdigest()
        )
        self.assertEqual(fields["context_chars"], len(context.model_context))
        self.assertNotIn("model_context", fields)
        rows = json.loads(context.model_context.split("\n", 1)[1])["files"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["file_id"], self.initial.file_id)
        self.assertEqual(rows[0]["snapshot_state"], "pending")
        self.assertEqual(rows[0]["review_id"], pending.review.id)
        self.assertNotIn("content", rows[0])
        self.assertNotIn("base_object_id", rows[0])
        other = await self.capture.begin_turn("other", "next", self.project.root)
        self.assertEqual(other.model_context, "")
        await self.capture.finish_turn("other", "next", TurnOutcome.COMPLETED)
        await self.capture.finish_turn("session", "next", TurnOutcome.COMPLETED)
        self._reject(self.initial.file_id)
        replay = await self.capture.begin_turn("session", "next", self.project.root)
        self.assertEqual(replay, context)
        changed = await self.capture.begin_turn("session", "after-reject", self.project.root)
        rows = json.loads(changed.model_context.split("\n", 1)[1])["files"]
        self.assertEqual(rows[0]["snapshot_state"], "saved")
        self.assertFalse(rows[0]["needs_review"])

    def test_resource_context_budget_reports_omissions(self) -> None:
        state = self.store.capability_states((self.path,))[self.path]
        states = {f"resources/{index:04d}-" + "长路径" * 100: state for index in range(200)}
        with (
            patch.object(self.store, "session_review_paths", return_value=tuple(states)),
            patch.object(self.store, "capability_states", return_value=states),
        ):
            text = resource_turn_context(self.store, "session")
            self.assertEqual(text, resource_turn_context(self.store, "session"))
        self.assertLessEqual(len(text), MAX_RESOURCE_CONTEXT_CHARS)
        payload = json.loads(text.split("\n", 1)[1])
        self.assertGreater(payload["omitted_count"], 0)
        self.assertEqual(len(payload["files"]) + payload["omitted_count"], len(states))

    async def test_failed_and_interrupted_capture_actual_changes(self) -> None:
        for outcome in (TurnOutcome.FAILED, TurnOutcome.INTERRUPTED):
            await self._change(outcome.value, outcome.value.encode())
            await self.capture.finish_turn("session", outcome.value, outcome)
            current = self.store.pending(self.initial.file_id)
            self.assertTrue(current.needs_review)
            self.assertEqual(current.review.terminal_outcome, outcome)
            self.assertEqual(current.review.base.object_id, self.initial.object_id)
        self.assertEqual(len(self.versions.history(self.project.id, self.path)), 1)

    async def test_unknown_does_not_close_admission_or_discard_baseline(self) -> None:
        await self._change("unknown", b"still possibly writing")
        await self.capture.finish_turn("session", "unknown", TurnOutcome.UNKNOWN)
        self.assertIsNone(self.store.pending(self.initial.file_id))
        self.assertIn(self.store.turn_state("session", "unknown"), ("accepted", "running"))
        await self.capture.finish_turn("session", "unknown", TurnOutcome.INTERRUPTED)
        self.assertTrue(self.store.pending(self.initial.file_id).needs_review)

    async def test_pre_agent_user_draft_is_exact_baseline(self) -> None:
        revision = self.versions.capability(self.project.id, self.path).working_revision
        self.versions.commit_working(
            self.project.id, self.path, b"user draft", revision, "user-draft"
        )
        baseline = self.store.working_snapshot(self.initial.file_id)
        await self._change("draft-turn", b"agent over user draft")
        await self.capture.finish_turn("session", "draft-turn", TurnOutcome.COMPLETED)
        review = self.store.pending(self.initial.file_id).review
        self.assertEqual(review.base, baseline)
        self.assertEqual(review.base_origin, PendingOrigin.USER)
        self.assertNotEqual(review.base.object_id, self.initial.object_id)
        self._reject(self.initial.file_id)
        self.assertEqual(self.file.read_bytes(), b"user draft")
        self.assertEqual(self.store.working_snapshot(self.initial.file_id), baseline)
        restored = self.store.pending(self.initial.file_id)
        self.assertEqual(restored.origin, PendingOrigin.USER)
        self.assertFalse(restored.needs_review)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    async def test_one_file_conflict_does_not_block_another_review(self) -> None:
        other = self.file.with_name("independent.md")
        other_path = str(other.relative_to(self.project.root))
        other.write_bytes(b"other baseline")
        initial_other = self.versions.ensure_initial(self.project.id, other_path).version
        await self._change("two-files", b"first candidate")
        other.write_bytes(b"second candidate")
        await self.capture.record_change(
            "session", "two-files", str(other), "update", generation="generation"
        )
        await self.capture.finish_turn("session", "two-files", TurnOutcome.COMPLETED)
        first_pending = self.store.pending(self.initial.file_id)
        second_pending = self.store.pending(initial_other.file_id)
        self.file.write_bytes(b"external first-file edit")
        with self.assertRaises(ResourceVersionError):
            self.versions.seal_review(
                self.project.id,
                self.initial.file_id,
                self.path,
                ReviewDecision(
                    first_pending.review.id, first_pending.revision, ReviewOutcome.ACCEPTED
                ),
                first_pending.review.candidate_revision,
                "first-conflict",
            )
        sealed = self.versions.seal_review(
            self.project.id,
            initial_other.file_id,
            other_path,
            ReviewDecision(
                second_pending.review.id, second_pending.revision, ReviewOutcome.ACCEPTED
            ),
            second_pending.review.candidate_revision,
            "second-accepted",
        )
        self.assertEqual(sealed.version.sequence, 2)
        self.assertEqual(other.read_bytes(), b"second candidate")
        self.assertIsNone(self.store.pending(initial_other.file_id))
        self.assertEqual(self.store.pending(self.initial.file_id), first_pending)
        self.assertEqual(self.file.read_bytes(), b"external first-file edit")
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    def _reject(self, file_id: str) -> None:
        pending = self.store.pending(file_id)
        recovery = ResourceRecoveryService(
            self.content,
            ResourceRetentionService(self.content, Settings()),
            PdfRecordStore(self.content),
        )
        recovery.reject_review(
            self.project.id,
            file_id,
            ReviewDecision(pending.review.id, pending.revision, ReviewOutcome.REJECTED),
            self.store.head(file_id)[1],
            "reject-" + file_id,
        )

    async def test_created_candidate_can_be_rejected_without_any_version(self) -> None:
        await self.capture.begin_turn("session", "create", self.project.root)
        await self.capture.bind_turn("session", "create", "create", "generation")
        target = self.file.with_name("created.md")
        target.write_bytes(b"created by Agent")
        await self.capture.record_change(
            "session", "create", str(target), "create", generation="generation"
        )
        result = await self.capture.finish_turn("session", "create", TurnOutcome.COMPLETED)
        self.assertEqual(len(result.file_ids), 1)
        file_id = result.file_ids[0]
        self.assertEqual(self.store.pending(file_id).review.base.state, FileState.TOMBSTONE)
        self.assertEqual(self.store.history_for_file(file_id), ())
        self.supervisor.scan_project(self.project.id)
        self.assertEqual(self.store.history_for_file(file_id), ())
        self.assertTrue(self.store.pending(file_id).needs_review)
        self._reject(file_id)
        self.assertFalse(target.exists())
        self.assertEqual(self.store.history_for_file(file_id), ())

    async def test_deleted_candidate_restores_original_without_version(self) -> None:
        await self.capture.begin_turn("session", "delete", self.project.root)
        await self.capture.bind_turn("session", "delete", "delete", "generation")
        self.file.unlink()
        await self.capture.record_change(
            "session", "delete", str(self.file), "delete", generation="generation"
        )
        await self.capture.finish_turn("session", "delete", TurnOutcome.INTERRUPTED)
        self.assertEqual(
            self.store.pending(self.initial.file_id).review.candidate.state, FileState.TOMBSTONE
        )
        self._reject(self.initial.file_id)
        self.assertEqual(self.file.read_bytes(), b"initial")
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)

    async def test_moved_candidate_reject_restores_path_and_identity(self) -> None:
        await self._move_and_reject("resources/moved.md")

    async def test_cross_directory_move_reject_restores_path_and_identity(self) -> None:
        await self._move_and_reject("resources/nested/moved.md")

    async def _move_and_reject(self, target_path: str) -> None:
        await self.capture.begin_turn("session", "move", self.project.root)
        await self.capture.bind_turn("session", "move", "move", "generation")
        target = Path(self.project.root) / target_path
        target.parent.mkdir(parents=True, exist_ok=True)
        self.file.rename(target)
        for path, kind in ((self.file, "delete"), (target, "create")):
            await self.capture.record_change(
                "session", "move", str(path), kind, generation="generation"
            )
        self.supervisor.scan_project(self.project.id)
        discovered = self.store.identity(target_path)
        self.assertIsNotNone(discovered)
        self.assertEqual(self.store.pending(discovered[0]).origin, PendingOrigin.EXTERNAL)
        result = await self.capture.finish_turn("session", "move", TurnOutcome.COMPLETED)
        self.assertEqual(result.file_ids, (self.initial.file_id,))
        self.assertEqual(self.store.pending(self.initial.file_id).review.base.path, self.path)
        self.assertEqual(
            self.store.pending(self.initial.file_id).review.candidate.path, target_path
        )
        self._reject(self.initial.file_id)
        self.assertEqual(self.file.read_bytes(), b"initial")
        self.assertFalse(target.exists())
        self.assertEqual(self.store.identity(self.path)[0], self.initial.file_id)
        self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 1)
        self.assertIsNone(self.store.pending(self.initial.file_id))

    async def test_deleted_candidate_can_be_accepted_through_http(self) -> None:
        await self.capture.begin_turn("session", "accept-delete", self.project.root)
        await self.capture.bind_turn("session", "accept-delete", "accept-delete", "generation")
        self.file.unlink()
        await self.capture.record_change(
            "session", "accept-delete", str(self.file), "delete", generation="generation"
        )
        await self.capture.finish_turn("session", "accept-delete", TurnOutcome.COMPLETED)
        current = self.store.pending(self.initial.file_id)
        app = FastAPI()
        app.state.resource_versions = self.versions
        register_version_routes(app)
        payload = {
            "path": self.path,
            "review_id": current.review.id,
            "pending_revision": current.revision,
            "expected_disk_revision": None,
        }
        with TestClient(app) as client:
            url = f"/api/resource/files/{self.initial.file_id}/review/accept"
            response = client.post(
                url,
                params={"project": self.project.id},
                json=payload,
                headers={"Idempotency-Key": "accept-delete"},
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["version"]["state"], "tombstone")
            self.assertEqual(response.json()["version"]["origin"], "agent")
            self.assertEqual(len(self.store.history_for_file(self.initial.file_id)), 2)
            self.assertIsNone(self.store.pending(self.initial.file_id))
            self.assertFalse(self.file.exists())
            self.file.write_bytes(b"external recreation after accepted deletion")
            replay = client.post(
                url,
                params={"project": self.project.id},
                json=payload,
                headers={"Idempotency-Key": "accept-delete"},
            )
            self.assertEqual(replay.json(), response.json())
            self.assertEqual(self.file.read_bytes(), b"external recreation after accepted deletion")


if __name__ == "__main__":
    unittest.main()
