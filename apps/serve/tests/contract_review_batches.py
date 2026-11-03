"""Durable review batches reuse pending/CAS truth and existing review primitives."""

from __future__ import annotations

import base64
import subprocess
import tempfile
import unittest
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
    PendingOrigin,
    ReviewAction,
    ReviewBatchDecision,
    ReviewBatchState,
    ReviewMemberState,
    TurnOutcome,
)
from service.resources.api.versions import register_version_routes
from service.resources.persistence.version import VersionStore, VersionStoreConflict
from service.resources.service.activation import ResourceActivation
from service.resources.service.batch import ResourceReviewBatchError, ResourceReviewBatchService
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


class ReviewBatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_recovered_runtime_tool_event_is_durable_and_idempotent(self) -> None:
        await self.delivery.begin_turn("session", "replay", self.project.root)
        await self.delivery.bind_turn("session", "replay", "native-replay", "generation")
        for _ in range(2):
            await self.delivery.record_tool_call(
                "session",
                "native-replay",
                {"command": "same"},
                generation="generation",
                event_id="original-runtime-event",
            )
        self.assertEqual(len(self.store.turn_tool_calls("session", "replay")), 1)
        with self.assertRaisesRegex(VersionStoreConflict, "runtime_event_conflict"):
            await self.delivery.record_tool_call(
                "session",
                "native-replay",
                {"command": "different"},
                generation="generation",
                event_id="original-runtime-event",
            )

    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        workspace = root / "workspace"
        workspace.mkdir()
        catalog = ContentCatalog(root / "catalog.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        self.content = ContentService(registry, catalog, activities=Activities())
        self.project = registry.create("review batches")
        self.policy = WorkbenchFormatPolicy()
        self.settings = Settings()
        self.retention = ResourceRetentionService(self.content, self.settings)
        self.annotations = PdfRecordStore(self.content)
        self.versions = ResourceVersionService(
            self.content, self.retention, self.policy, self.annotations
        )
        self.recovery = ResourceRecoveryService(self.content, self.retention, self.annotations)
        self.supervisor = ResourceVersionSupervisor(
            self.content,
            self.versions,
            self.policy,
            self.settings,
            activities=Activities(),
        )
        self.delivery = ResourceDeliveryService(
            self.content, self.versions, self.supervisor, activities=self.supervisor._activities
        )
        self.batches = ResourceReviewBatchService(self.content, self.versions, self.recovery)
        self.supervisor.bind_preparation(
            ResourceActivation(
                self.content,
                self.recovery,
                self.versions,
                self.delivery,
                self.retention,
                ResourceReviewMigration(self.content, self.versions),
            )
        )
        self.store = VersionStore(
            self.content.resolve(self.project.id, PROJECT_DB_RELATIVE), self.project.root
        )

    async def asyncTearDown(self) -> None:
        await self.supervisor.aclose()
        self.temp.cleanup()

    async def _capture(self, turn_id: str, changes: dict[str, bytes]) -> object:
        await self.delivery.begin_turn("session", turn_id, self.project.root)
        await self.delivery.bind_turn("session", turn_id, turn_id, "generation")
        for path, content in changes.items():
            target = Path(self.project.root) / path
            target.write_bytes(content)
            await self.delivery.record_change(
                "session", turn_id, str(target), "update", generation="generation"
            )
        return await self.delivery.finish_turn("session", turn_id, TurnOutcome.COMPLETED)

    def _seed(self, path: str, content: bytes) -> str:
        target = Path(self.project.root) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return self.versions.ensure_initial(self.project.id, path).version.file_id

    async def test_capture_persists_batch_and_immutable_contents(self) -> None:
        file_id = self._seed("resources/notes.md", b"base")
        result = await self._capture("turn", {"resources/notes.md": b"candidate"})
        self.assertIsNotNone(result.batch_id)
        batch = self.batches.batch(self.project.id, result.batch_id)
        self.assertEqual(batch.state, ReviewBatchState.OPEN)
        self.assertEqual(batch.members[0].file_id, file_id)
        self.assertIs(batch.members[0].origin, PendingOrigin.AGENT)
        self.assertEqual(
            self.batches.content(self.project.id, batch.id, file_id, "base")[0], b"base"
        )
        self.assertEqual(
            self.batches.content(self.project.id, batch.id, file_id, "candidate")[0],
            b"candidate",
        )
        self.assertEqual(
            self.batches.content(self.project.id, batch.id, file_id, "current")[0],
            b"candidate",
        )
        self.assertTrue(self.batches.has_open_for_workdir(self.project.root))

        decision = ReviewBatchDecision(
            file_id,
            batch.members[0].review_id,
            batch.members[0].pending_revision,
            ReviewAction.ACCEPT,
            batch.members[0].candidate_revision,
        )
        completed = self.batches.commit(self.project.id, batch.id, (decision,), "accept-batch")
        self.assertEqual(completed.batch.state, ReviewBatchState.COMPLETED)
        self.assertFalse(self.batches.has_open_for_workdir(self.project.root))
        self.assertEqual(
            self.batches.content(self.project.id, batch.id, file_id, "base")[0], b"base"
        )
        self.assertEqual(
            self.batches.content(self.project.id, batch.id, file_id, "candidate")[0],
            b"candidate",
        )

    async def test_completed_decisions_replay_without_reapplying_files(self) -> None:
        for actions in (
            (ReviewAction.REJECT,),
            (ReviewAction.ACCEPT,),
            (ReviewAction.ACCEPT, ReviewAction.REJECT),
            (ReviewAction.REVISE,),
        ):
            with self.subTest(actions=actions):
                paths = tuple(
                    f"resources/replay-{actions[0].value}-{index}.md"
                    for index in range(len(actions))
                )
                for path in paths:
                    self._seed(path, b"base")
                receipt = await self._capture(str(actions), {path: b"candidate" for path in paths})
                if ReviewAction.REVISE in actions:
                    member = self.batches.batch(self.project.id, receipt.batch_id).members[0]
                    self.versions.commit_working(
                        self.project.id,
                        member.path,
                        b"user revision",
                        member.candidate_revision,
                        "replay-revise-save",
                    )
                batch = self.batches.batch(self.project.id, receipt.batch_id)
                decisions = tuple(
                    ReviewBatchDecision(
                        member.file_id,
                        member.review_id,
                        member.pending_revision,
                        action,
                        self.batches.content(self.project.id, batch.id, member.file_id, "current")[
                            2
                        ],
                    )
                    for member, action in zip(batch.members, actions)
                )
                key = f"first:{batch.id}"
                completed = self.batches.commit(self.project.id, batch.id, decisions, key)
                self.assertEqual(completed.batch.state, ReviewBatchState.COMPLETED)
                history = {
                    member.file_id: len(self.store.history_for_file(member.file_id))
                    for member in batch.members
                }
                for path in paths:
                    (Path(self.project.root) / path).write_bytes(b"later user edit")
                for replay_key in (key, f"retry:{batch.id}"):
                    replay = self.batches.commit(self.project.id, batch.id, decisions, replay_key)
                    self.assertEqual(replay.batch.state, ReviewBatchState.COMPLETED)
                    self.assertEqual(replay.results, completed.results)
                for member in batch.members:
                    self.assertEqual(
                        (Path(self.project.root) / member.path).read_bytes(), b"later user edit"
                    )
                    self.assertEqual(
                        len(self.store.history_for_file(member.file_id)), history[member.file_id]
                    )

    async def test_completed_members_repair_applying_batch_on_receipt_and_new_request(self) -> None:
        file_id = self._seed("resources/stuck.md", b"base")
        receipt = await self._capture("stuck", {"resources/stuck.md": b"candidate"})
        batch = self.batches.batch(self.project.id, receipt.batch_id)
        member = batch.members[0]
        decision = ReviewBatchDecision(
            file_id,
            member.review_id,
            member.pending_revision,
            ReviewAction.REJECT,
            member.candidate_revision,
        )
        completed = self.batches.commit(self.project.id, batch.id, (decision,), "first-stuck")
        target = Path(self.project.root) / member.path
        target.write_bytes(b"later user edit")
        database = self.content.resolve(self.project.id, PROJECT_DB_RELATIVE)
        for key in ("first-stuck", "retry-stuck"):
            with self.subTest(key=key):
                with transaction(database, immediate=True) as connection:
                    connection.execute(
                        "UPDATE resources_review_batches SET state = ? WHERE batch_id = ?",
                        (ReviewBatchState.APPLYING.value, batch.id),
                    )
                replay = self.batches.commit(self.project.id, batch.id, (decision,), key)
                self.assertEqual(replay.batch.state, ReviewBatchState.COMPLETED)
                self.assertEqual(replay.results, completed.results)
                self.assertFalse(self.batches.has_open_for_workdir(self.project.root))
                self.assertEqual(target.read_bytes(), b"later user edit")
                self.assertEqual(len(self.store.history_for_file(file_id)), 1)

    async def test_external_terminal_diff_stays_pending_without_review_batch(self) -> None:
        file_id = self._seed("resources/external.md", b"base")
        await self.delivery.begin_turn("session", "external", self.project.root)
        (Path(self.project.root) / "resources/external.md").write_bytes(b"external")

        result = await self.delivery.finish_turn("session", "external", TurnOutcome.COMPLETED)

        self.assertEqual(result.file_ids, ())
        self.assertEqual(result.review_ids, ())
        self.assertIsNone(result.batch_id)
        self.assertEqual(result.paths, ())
        pending = self.store.pending(file_id)
        self.assertIsNotNone(pending)
        self.assertIs(pending.origin, PendingOrigin.EXTERNAL)
        self.assertIsNone(pending.review)
        self.assertFalse(self.batches.has_open_for_workdir(self.project.root))

    async def test_mixed_file_set_excludes_only_pure_external_member(self) -> None:
        agent_file_id = self._seed("resources/agent.md", b"agent base")
        external_file_id = self._seed("resources/external.md", b"external base")
        await self.delivery.begin_turn("session", "mixed-set", self.project.root)
        await self.delivery.bind_turn("session", "mixed-set", "mixed-set", "generation")
        agent = Path(self.project.root) / "resources/agent.md"
        external = Path(self.project.root) / "resources/external.md"
        agent.write_bytes(b"agent candidate")
        external.write_bytes(b"external candidate")
        await self.delivery.record_change(
            "session", "mixed-set", str(agent), "update", generation="generation"
        )

        result = await self.delivery.finish_turn("session", "mixed-set", TurnOutcome.COMPLETED)

        batch = self.batches.batch(self.project.id, result.batch_id)
        self.assertEqual(result.file_ids, (agent_file_id,))
        self.assertEqual(result.paths, ("resources/agent.md",))
        self.assertEqual(tuple(member.file_id for member in batch.members), (agent_file_id,))
        self.assertIs(batch.members[0].origin, PendingOrigin.AGENT)
        external_pending = self.store.pending(external_file_id)
        self.assertIsNotNone(external_pending)
        self.assertIs(external_pending.origin, PendingOrigin.EXTERNAL)
        self.assertIsNone(external_pending.review)

    async def test_write_tool_call_filename_keeps_agent_review(self) -> None:
        file_id = self._seed("resources/李白.md", b"")
        await self.delivery.begin_turn("session", "tool-call", self.project.root)
        await self.delivery.bind_turn("session", "tool-call", "tool-call", "generation")
        target = Path(self.project.root) / "resources/李白.md"
        target.write_bytes("静夜思\n".encode())
        await self.delivery.record_tool_call(
            "session",
            "tool-call",
            {"command": "python write_document.py resources/李白.md"},
            generation="generation",
        )

        result = await self.delivery.finish_turn("session", "tool-call", TurnOutcome.COMPLETED)

        batch = self.batches.batch(self.project.id, result.batch_id)
        self.assertEqual(result.file_ids, (file_id,))
        self.assertEqual(result.paths, ("resources/李白.md",))
        self.assertIs(batch.members[0].origin, PendingOrigin.AGENT)

    async def test_write_tool_call_filename_keeps_created_agent_review(self) -> None:
        await self.delivery.begin_turn("session", "tool-call-create", self.project.root)
        await self.delivery.bind_turn(
            "session", "tool-call-create", "tool-call-create", "generation"
        )
        created = Path(self.project.root) / "resources/新建.md"
        created.parent.mkdir(parents=True, exist_ok=True)
        created.write_bytes("新建内容\n".encode())
        await self.delivery.record_tool_call(
            "session",
            "tool-call-create",
            {"command": "python write_document.py resources/新建.md"},
            generation="generation",
        )

        result = await self.delivery.finish_turn(
            "session", "tool-call-create", TurnOutcome.COMPLETED
        )

        batch = self.batches.batch(self.project.id, result.batch_id)
        self.assertEqual(result.paths, ("resources/新建.md",))
        self.assertIs(batch.members[0].origin, PendingOrigin.AGENT)

    async def test_turn_candidate_inventory_excludes_git_and_preserves_external_bytes(self) -> None:
        ordinary = Path(self.project.root) / "resources/ordinary.md"
        ordinary.parent.mkdir(parents=True, exist_ok=True)
        ordinary.write_bytes(b"ordinary")
        repository = Path(self.project.root) / "resources/code"
        repository.mkdir()
        subprocess.run(["git", "init", str(repository)], check=True, capture_output=True)
        (repository / "tracked.md").write_bytes(b"tracked")

        await self.delivery.begin_turn("session", "git-inventory", self.project.root)

        inventory = self.store.turn_inventory("session", "git-inventory")
        self.assertIn("resources/ordinary.md", inventory)
        self.assertNotIn("resources/code/tracked.md", inventory)
        baselines = self.store.turn_baselines("session", "git-inventory")
        self.assertEqual(tuple(item.path for item in baselines), ("resources/ordinary.md",))

        await self.delivery.bind_turn("session", "git-inventory", "git-inventory", "generation")
        ordinary.write_bytes(b"ordinary changed")
        (repository / "tracked.md").write_bytes(b"tracked changed")
        for target in (ordinary, repository / "tracked.md"):
            await self.delivery.record_change(
                "session", "git-inventory", str(target), "update", generation="generation"
            )
        result = await self.delivery.finish_turn("session", "git-inventory", TurnOutcome.COMPLETED)
        self.assertEqual(result.paths, ("resources/ordinary.md",))
        self.assertEqual(self.versions.history(self.project.id, "resources/code/tracked.md"), ())
        self.assertEqual((repository / "tracked.md").read_bytes(), b"tracked changed")

    async def test_agent_file_with_later_external_bytes_remains_in_review_batch(self) -> None:
        file_id = self._seed("resources/mixed.md", b"base")
        await self.delivery.begin_turn("session", "mixed-file", self.project.root)
        await self.delivery.bind_turn("session", "mixed-file", "mixed-file", "generation")
        target = Path(self.project.root) / "resources/mixed.md"
        target.write_bytes(b"agent candidate")
        await self.delivery.record_change(
            "session", "mixed-file", str(target), "update", generation="generation"
        )
        target.write_bytes(b"external after agent")

        result = await self.delivery.finish_turn("session", "mixed-file", TurnOutcome.COMPLETED)

        batch = self.batches.batch(self.project.id, result.batch_id)
        self.assertEqual(tuple(member.file_id for member in batch.members), (file_id,))
        self.assertIs(batch.members[0].origin, PendingOrigin.AGENT)
        self.assertEqual(
            self.batches.content(self.project.id, batch.id, file_id, "candidate")[0],
            b"external after agent",
        )

    async def test_pure_accept_is_transaction_atomic(self) -> None:
        first = self._seed("resources/first.md", b"first base")
        second = self._seed("resources/second.md", b"second base")
        result = await self._capture(
            "atomic",
            {
                "resources/first.md": b"first candidate",
                "resources/second.md": b"second candidate",
            },
        )
        batch = self.batches.batch(self.project.id, result.batch_id)
        decisions = tuple(
            ReviewBatchDecision(
                member.file_id,
                member.review_id,
                member.pending_revision,
                ReviewAction.ACCEPT,
                member.candidate_revision,
            )
            for member in batch.members
        )
        (Path(self.project.root) / "resources/second.md").write_bytes(b"external")
        with self.assertRaisesRegex(ResourceReviewBatchError, "review_revision_conflict"):
            self.batches.commit(self.project.id, batch.id, decisions, "atomic")
        self.assertEqual(len(self.store.history_for_file(first)), 1)
        self.assertEqual(len(self.store.history_for_file(second)), 1)
        self.assertEqual(self.batches.batch(self.project.id, batch.id).state, ReviewBatchState.OPEN)

    async def test_mixed_decision_persists_progress_and_resumes(self) -> None:
        first = self._seed("resources/first.md", b"first base")
        self._seed("resources/second.md", b"second base")
        result = await self._capture(
            "mixed",
            {
                "resources/first.md": b"first candidate",
                "resources/second.md": b"second candidate",
            },
        )
        batch = self.batches.batch(self.project.id, result.batch_id)
        members = {member.path: member for member in batch.members}
        accepted_member = members["resources/first.md"]
        rejected_member = members["resources/second.md"]
        decisions = (
            ReviewBatchDecision(
                accepted_member.file_id,
                accepted_member.review_id,
                accepted_member.pending_revision,
                ReviewAction.ACCEPT,
                accepted_member.candidate_revision,
            ),
            ReviewBatchDecision(
                rejected_member.file_id,
                rejected_member.review_id,
                rejected_member.pending_revision,
                ReviewAction.REJECT,
                rejected_member.candidate_revision,
            ),
        )
        original = self.recovery.reject_review
        with patch.object(
            self.recovery,
            "reject_review",
            side_effect=ResourceReviewBatchError("injected_failure"),
        ):
            failed = self.batches.commit(self.project.id, batch.id, decisions, "mixed")
        self.assertEqual(failed.batch.state, ReviewBatchState.FAILED)
        states = {item.file_id: item.state for item in failed.results}
        self.assertEqual(states[accepted_member.file_id], ReviewMemberState.COMPLETED)
        self.assertEqual(states[rejected_member.file_id], ReviewMemberState.FAILED)
        self.assertEqual(len(self.store.history_for_file(first)), 2)

        with patch.object(self.recovery, "reject_review", wraps=original) as reject:
            completed = self.batches.commit(self.project.id, batch.id, decisions, "mixed")
        self.assertEqual(reject.call_count, 1)
        self.assertEqual(completed.batch.state, ReviewBatchState.COMPLETED)
        self.assertEqual(len(self.store.history_for_file(first)), 2)

    async def test_external_reject_restores_base_without_intermediate_reconcile(self) -> None:
        file_id = self._seed("resources/external.md", b"base")
        receipt = await self._capture("external-reject", {"resources/external.md": b"candidate"})
        batch = self.batches.batch(self.project.id, receipt.batch_id)
        member = batch.members[0]
        target = Path(self.project.root) / member.path
        target.write_bytes(b"external")
        expected = self.batches.content(self.project.id, batch.id, file_id, "current")[2]
        decision = ReviewBatchDecision(
            file_id,
            member.review_id,
            member.pending_revision,
            ReviewAction.REJECT,
            expected,
        )

        with patch.object(
            self.recovery, "reconcile_review", wraps=self.recovery.reconcile_review
        ) as reconcile:
            completed = self.batches.commit(
                self.project.id, batch.id, (decision,), "external-reject"
            )

        self.assertEqual(reconcile.call_count, 0)
        self.assertEqual(completed.batch.state, ReviewBatchState.COMPLETED)
        self.assertEqual(target.read_bytes(), b"base")
        history = self.store.history_for_file(file_id)
        self.assertEqual(
            [version.origin.value for version in history],
            ["restore", "external_confirmed", "initial_scan"],
        )
        self.assertTrue(history[1].review_backup)
        self.assertEqual(
            b"".join(self.versions.content(self.project.id, history[1].id)[0]), b"external"
        )

    async def test_failed_member_can_be_redecided_before_retry(self) -> None:
        file_id = self._seed("resources/redecide.md", b"base")
        receipt = await self._capture("redecide", {"resources/redecide.md": b"candidate"})
        batch = self.batches.batch(self.project.id, receipt.batch_id)
        member = batch.members[0]
        rejected = ReviewBatchDecision(
            file_id,
            member.review_id,
            member.pending_revision,
            ReviewAction.REJECT,
            member.candidate_revision,
        )
        with patch.object(
            self.recovery,
            "reject_review",
            side_effect=ResourceReviewBatchError("injected_failure"),
        ):
            failed = self.batches.commit(self.project.id, batch.id, (rejected,), "reject-fails")
        self.assertEqual(failed.batch.members[0].state, ReviewMemberState.FAILED)

        accepted = ReviewBatchDecision(
            file_id,
            member.review_id,
            member.pending_revision,
            ReviewAction.ACCEPT,
            member.candidate_revision,
        )
        completed = self.batches.commit(self.project.id, batch.id, (accepted,), "accept-retry")

        self.assertEqual(completed.batch.state, ReviewBatchState.COMPLETED)
        self.assertEqual(completed.batch.members[0].action, ReviewAction.ACCEPT)
        self.assertEqual(len(self.store.history_for_file(file_id)), 2)

        with self.assertRaisesRegex(ResourceReviewBatchError, "review_batch_decision_conflict"):
            self.batches.commit(self.project.id, batch.id, (rejected,), "completed-cannot-change")

    async def test_http_list_detail_candidate_and_decisions(self) -> None:
        file_id = self._seed("resources/http.md", b"base")
        receipt = await self._capture("http", {"resources/http.md": b"candidate"})
        app = FastAPI()
        app.state.resource_versions = self.versions
        app.state.resource_recovery = self.recovery
        app.state.resource_review_batches = self.batches
        register_version_routes(app)
        with TestClient(app) as client:
            listing = client.get(
                "/api/resource/review-batches",
                params={"project": self.project.id, "state": "open"},
            )
            self.assertEqual(listing.status_code, 200, listing.text)
            self.assertEqual(listing.json()["items"][0]["id"], receipt.batch_id)
            detail = client.get(
                f"/api/resource/review-batches/{receipt.batch_id}",
                params={"project": self.project.id},
            )
            member = detail.json()["members"][0]
            candidate = client.get(
                f"/api/resource/review-batches/{receipt.batch_id}/members/{file_id}/candidate",
                params={"project": self.project.id},
            )
            self.assertEqual(candidate.content, b"candidate")
            self.assertEqual(
                candidate.headers["X-ScholarSeed-Content-Revision"],
                member["candidate_revision"],
            )
            decided = client.post(
                f"/api/resource/review-batches/{receipt.batch_id}/commit",
                params={"project": self.project.id},
                headers={"Idempotency-Key": "http-decision"},
                json={
                    "decisions": [
                        {
                            "file_id": file_id,
                            "review_id": member["review_id"],
                            "pending_revision": member["pending_revision"],
                            "action": "accept",
                            "expected_disk_revision": member["candidate_revision"],
                        }
                    ]
                },
            )
            self.assertEqual(decided.status_code, 200, decided.text)
            self.assertEqual(decided.json()["batch"]["state"], "completed")

    async def test_commit_requires_complete_decision_vector(self) -> None:
        self._seed("resources/first.md", b"first base")
        self._seed("resources/second.md", b"second base")
        receipt = await self._capture(
            "subset",
            {
                "resources/first.md": b"first candidate",
                "resources/second.md": b"second candidate",
            },
        )
        batch = self.batches.batch(self.project.id, receipt.batch_id)
        first, second = batch.members
        accept = ReviewBatchDecision(
            first.file_id,
            first.review_id,
            first.pending_revision,
            ReviewAction.ACCEPT,
            first.candidate_revision,
        )
        with self.assertRaisesRegex(ResourceReviewBatchError, "review_batch_members_mismatch"):
            self.batches.commit(self.project.id, batch.id, (accept,), "subset-accept")
        rejected = self.batches.commit(
            self.project.id,
            batch.id,
            (
                accept,
                ReviewBatchDecision(
                    second.file_id,
                    second.review_id,
                    second.pending_revision,
                    ReviewAction.REJECT,
                    second.candidate_revision,
                ),
            ),
            "subset-reject",
        )
        self.assertEqual(rejected.batch.state, ReviewBatchState.COMPLETED)

    async def test_save_refresh_then_revise_uses_live_pending_revision(self) -> None:
        file_id = self._seed("resources/revise.md", b"base")
        receipt = await self._capture("revise", {"resources/revise.md": b"candidate"})
        original = self.batches.batch(self.project.id, receipt.batch_id).members[0]
        saved = self.versions.commit_working(
            self.project.id,
            original.path,
            b"user revision",
            original.candidate_revision,
            "workbench-save",
        )
        refreshed = self.batches.batch(self.project.id, receipt.batch_id).members[0]
        self.assertTrue(refreshed.edited_by_user)
        self.assertGreater(refreshed.pending_revision, original.pending_revision)
        revised = self.batches.commit(
            self.project.id,
            receipt.batch_id,
            (
                ReviewBatchDecision(
                    file_id,
                    refreshed.review_id,
                    refreshed.pending_revision,
                    ReviewAction.REVISE,
                    saved.revision,
                ),
            ),
            "revised",
        )
        self.assertEqual(revised.batch.state, ReviewBatchState.COMPLETED)
        self.assertEqual(self.store.history_for_file(file_id)[0].review_outcome.value, "revised")

    async def test_accept_restores_and_versions_agent_candidate_after_external_change(
        self,
    ) -> None:
        file_id = self._seed("resources/external.md", b"base")
        receipt = await self._capture("external", {"resources/external.md": b"candidate"})
        member = self.batches.batch(self.project.id, receipt.batch_id).members[0]
        target = Path(self.project.root) / member.path
        target.write_bytes(b"external final")
        current = self.batches.content(self.project.id, receipt.batch_id, file_id, "current")
        completed = self.batches.commit(
            self.project.id,
            receipt.batch_id,
            (
                ReviewBatchDecision(
                    file_id,
                    member.review_id,
                    member.pending_revision,
                    ReviewAction.ACCEPT,
                    current[2],
                ),
            ),
            "accept-external",
        )
        self.assertEqual(completed.batch.state, ReviewBatchState.COMPLETED)
        self.assertEqual(target.read_bytes(), b"candidate")
        history = self.store.history_for_file(file_id)
        self.assertEqual(history[0].review_outcome.value, "accepted")
        self.assertTrue(history[1].review_backup)
        self.assertEqual(
            b"".join(self.versions.content(self.project.id, history[1].id)[0]), b"external final"
        )
        self.assertNotIn(history[1].id, self.store.retention_plan(1)[0])

    async def test_accept_external_revision_preserves_a_later_external_edit(self) -> None:
        file_id = self._seed("resources/stale-external-accept.md", b"base")
        receipt = await self._capture(
            "stale-external-accept", {"resources/stale-external-accept.md": b"candidate"}
        )
        member = self.batches.batch(self.project.id, receipt.batch_id).members[0]
        target = Path(self.project.root) / member.path
        target.write_bytes(b"external revision")
        current_revision = self.batches.content(
            self.project.id, receipt.batch_id, file_id, "current"
        )[2]
        target.write_bytes(b"later external edit")

        failed = self.batches.commit(
            self.project.id,
            receipt.batch_id,
            (
                ReviewBatchDecision(
                    file_id,
                    member.review_id,
                    member.pending_revision,
                    ReviewAction.ACCEPT,
                    current_revision,
                ),
            ),
            "accept-stale-external-revision",
        )

        self.assertEqual(failed.batch.state, ReviewBatchState.FAILED)
        self.assertEqual(failed.batch.members[0].error, "review_disk_revision_conflict")
        self.assertEqual(target.read_bytes(), b"later external edit")

    async def test_revise_applies_submitted_draft_only_at_commit_and_backs_up_disk(self) -> None:
        file_id = self._seed("resources/draft.md", b"base")
        receipt = await self._capture("draft", {"resources/draft.md": b"candidate"})
        member = self.batches.batch(self.project.id, receipt.batch_id).members[0]
        target = Path(self.project.root) / member.path
        target.write_bytes(b"external")
        current_revision = self.batches.content(
            self.project.id, receipt.batch_id, file_id, "current"
        )[2]
        decision = ReviewBatchDecision(
            file_id,
            member.review_id,
            member.pending_revision,
            ReviewAction.REVISE,
            current_revision,
            b"external plus review edits",
        )
        self.assertEqual(target.read_bytes(), b"external")
        completed = self.batches.commit(
            self.project.id, receipt.batch_id, (decision,), "submit-draft"
        )
        self.assertEqual(completed.batch.state, ReviewBatchState.COMPLETED)
        self.assertEqual(target.read_bytes(), b"external plus review edits")
        history = self.store.history_for_file(file_id)
        self.assertEqual(history[0].review_outcome.value, "revised")
        self.assertTrue(history[1].review_backup)
        self.assertEqual(
            b"".join(self.versions.content(self.project.id, history[1].id)[0]), b"external"
        )
        replay = self.batches.commit(self.project.id, receipt.batch_id, (decision,), "submit-draft")
        self.assertEqual(replay.batch.state, ReviewBatchState.COMPLETED)
        self.assertEqual(self.store.history_for_file(file_id), history)

    async def test_http_commit_decodes_revised_content_without_precommit_write(self) -> None:
        file_id = self._seed("resources/http-draft.md", b"base")
        receipt = await self._capture("http-draft", {"resources/http-draft.md": b"candidate"})
        member = self.batches.batch(self.project.id, receipt.batch_id).members[0]
        target = Path(self.project.root) / member.path
        target.write_bytes(b"external")
        expected = self.batches.content(self.project.id, receipt.batch_id, file_id, "current")[2]
        app = FastAPI()
        app.state.resource_versions = self.versions
        app.state.resource_recovery = self.recovery
        app.state.resource_review_batches = self.batches
        register_version_routes(app)
        with TestClient(app) as client:
            result = client.post(
                f"/api/resource/review-batches/{receipt.batch_id}/commit",
                params={"project": self.project.id},
                headers={"Idempotency-Key": "http-draft"},
                json={
                    "decisions": [
                        {
                            "file_id": file_id,
                            "review_id": member.review_id,
                            "pending_revision": member.pending_revision,
                            "action": "revise",
                            "expected_disk_revision": expected,
                            "revised_content": base64.b64encode(b"review draft").decode("ascii"),
                        }
                    ]
                },
            )
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(target.read_bytes(), b"review draft")

    async def test_revise_retry_after_draft_write_does_not_duplicate_backup(self) -> None:
        file_id = self._seed("resources/retry-draft.md", b"base")
        receipt = await self._capture("retry-draft", {"resources/retry-draft.md": b"candidate"})
        member = self.batches.batch(self.project.id, receipt.batch_id).members[0]
        target = Path(self.project.root) / member.path
        target.write_bytes(b"external")
        current_revision = self.batches.content(
            self.project.id, receipt.batch_id, file_id, "current"
        )[2]
        first = ReviewBatchDecision(
            file_id,
            member.review_id,
            member.pending_revision,
            ReviewAction.REVISE,
            current_revision,
            b"review draft",
        )
        with patch.object(
            self.versions, "seal_review", side_effect=ResourceVersionError("injected_failure")
        ):
            failed = self.batches.commit(self.project.id, receipt.batch_id, (first,), "draft-fails")
        self.assertEqual(failed.batch.state, ReviewBatchState.FAILED)
        self.assertEqual(target.read_bytes(), b"review draft")
        replayed = self.batches.commit(self.project.id, receipt.batch_id, (first,), "draft-fails")
        self.assertEqual(replayed.batch.state, ReviewBatchState.COMPLETED)
        refreshed = self.batches.batch(self.project.id, receipt.batch_id).members[0]
        second = ReviewBatchDecision(
            file_id,
            refreshed.review_id,
            refreshed.pending_revision,
            ReviewAction.REVISE,
            current_revision,
            b"review draft",
        )
        completed = self.batches.commit(self.project.id, receipt.batch_id, (second,), "draft-retry")
        self.assertEqual(completed.batch.state, ReviewBatchState.COMPLETED)
        self.assertEqual(
            sum(version.review_backup for version in self.store.history_for_file(file_id)), 1
        )

    async def test_accept_all_restores_persisted_user_and_external_revisions(self) -> None:
        first_id = self._seed("resources/accept-user.md", b"first base")
        second_id = self._seed("resources/accept-external.md", b"second base")
        receipt = await self._capture(
            "accept-mixed-revisions",
            {
                "resources/accept-user.md": b"first candidate",
                "resources/accept-external.md": b"second candidate",
            },
        )
        members = {
            member.file_id: member
            for member in self.batches.batch(self.project.id, receipt.batch_id).members
        }
        first = members[first_id]
        second = members[second_id]
        saved = self.versions.commit_working(
            self.project.id,
            first.path,
            b"persisted user revision",
            first.candidate_revision,
            "accept-user-save",
            automatic_version=True,
        )
        saved_version = self.store.history_for_file(first_id)[0]
        self.assertEqual(
            self.versions.read(self.project.id, saved_version.id)[0], b"persisted user revision"
        )
        second_target = Path(self.project.root) / second.path
        second_target.write_bytes(b"external revision")
        second_revision = self.batches.content(
            self.project.id, receipt.batch_id, second_id, "current"
        )[2]
        refreshed = {
            member.file_id: member
            for member in self.batches.batch(self.project.id, receipt.batch_id).members
        }

        completed = self.batches.commit(
            self.project.id,
            receipt.batch_id,
            tuple(
                ReviewBatchDecision(
                    file_id,
                    refreshed[file_id].review_id,
                    refreshed[file_id].pending_revision,
                    ReviewAction.ACCEPT,
                    revision,
                )
                for file_id, revision in (
                    (first_id, saved.revision),
                    (second_id, second_revision),
                )
            ),
            "accept-all-mixed-revisions",
        )

        self.assertEqual(
            completed.batch.state,
            ReviewBatchState.COMPLETED,
            tuple((member.path, member.error) for member in completed.batch.members),
        )
        self.assertEqual((Path(self.project.root) / first.path).read_bytes(), b"first candidate")
        self.assertEqual(second_target.read_bytes(), b"second candidate")
        outcomes = {
            version.file_id: version.review_outcome.value
            for version in self.store.history_for_file(first_id)
            + self.store.history_for_file(second_id)
            if version.review_outcome is not None
        }
        self.assertEqual(outcomes, {first_id: "accepted", second_id: "accepted"})
        self.assertIn(saved_version, self.store.history_for_file(first_id))

    async def test_revise_can_version_the_actual_externally_changed_file(self) -> None:
        file_id = self._seed("resources/external-revise.md", b"base")
        receipt = await self._capture(
            "external-revise", {"resources/external-revise.md": b"candidate"}
        )
        member = self.batches.batch(self.project.id, receipt.batch_id).members[0]
        target = Path(self.project.root) / member.path
        target.write_bytes(b"external final")
        current = self.batches.content(self.project.id, receipt.batch_id, file_id, "current")
        completed = self.batches.commit(
            self.project.id,
            receipt.batch_id,
            (
                ReviewBatchDecision(
                    file_id,
                    member.review_id,
                    member.pending_revision,
                    ReviewAction.REVISE,
                    current[2],
                ),
            ),
            "revise-external",
        )
        self.assertEqual(completed.batch.state, ReviewBatchState.COMPLETED)
        self.assertEqual(target.read_bytes(), b"external final")
        self.assertEqual(
            self.store.history_for_file(file_id)[0].review_outcome.value,
            "revised",
        )

    async def test_reject_discards_external_changes_and_restores_the_base(self) -> None:
        file_id = self._seed("resources/external-reject.md", b"base")
        receipt = await self._capture(
            "external-reject", {"resources/external-reject.md": b"candidate"}
        )
        member = self.batches.batch(self.project.id, receipt.batch_id).members[0]
        target = Path(self.project.root) / member.path
        target.write_bytes(b"external final")
        current_revision = self.batches.content(
            self.project.id, receipt.batch_id, file_id, "current"
        )[2]
        completed = self.batches.commit(
            self.project.id,
            receipt.batch_id,
            (
                ReviewBatchDecision(
                    file_id,
                    member.review_id,
                    member.pending_revision,
                    ReviewAction.REJECT,
                    current_revision,
                ),
            ),
            "reject-external",
        )
        self.assertEqual(completed.batch.state, ReviewBatchState.COMPLETED)
        self.assertEqual(target.read_bytes(), b"base")

    async def test_reject_all_restores_persisted_user_and_candidate_files_to_their_bases(
        self,
    ) -> None:
        first_id = self._seed("resources/external-reject-first.md", b"first base")
        second_id = self._seed("resources/external-reject-second.md", b"second base")
        receipt = await self._capture(
            "external-reject-all",
            {
                "resources/external-reject-first.md": b"first candidate",
                "resources/external-reject-second.md": b"second candidate",
            },
        )
        batch = self.batches.batch(self.project.id, receipt.batch_id)
        members = {member.file_id: member for member in batch.members}
        first_target = Path(self.project.root) / members[first_id].path
        second_target = Path(self.project.root) / members[second_id].path
        first_saved = self.versions.commit_working(
            self.project.id,
            members[first_id].path,
            b"first user revision",
            members[first_id].candidate_revision,
            "workbench-save",
            automatic_version=True,
        )
        saved_version = self.store.history_for_file(first_id)[0]
        self.assertEqual(
            self.versions.read(self.project.id, saved_version.id)[0], b"first user revision"
        )
        refreshed = self.batches.batch(self.project.id, batch.id)
        members = {member.file_id: member for member in refreshed.members}

        completed = self.batches.commit(
            self.project.id,
            batch.id,
            (
                ReviewBatchDecision(
                    first_id,
                    members[first_id].review_id,
                    members[first_id].pending_revision,
                    ReviewAction.REJECT,
                    first_saved.revision,
                ),
                ReviewBatchDecision(
                    second_id,
                    members[second_id].review_id,
                    members[second_id].pending_revision,
                    ReviewAction.REJECT,
                    members[second_id].candidate_revision,
                ),
            ),
            "reject-external-all",
        )

        self.assertEqual(
            completed.batch.state,
            ReviewBatchState.COMPLETED,
            tuple((member.path, member.error) for member in completed.batch.members),
        )
        self.assertTrue(
            all(member.state is ReviewMemberState.COMPLETED for member in completed.batch.members)
        )
        self.assertEqual(first_target.read_bytes(), b"first base")
        self.assertEqual(second_target.read_bytes(), b"second base")
        self.assertIn(saved_version, self.store.history_for_file(first_id))
        self.assertEqual(
            self.versions.read(self.project.id, saved_version.id)[0], b"first user revision"
        )

    async def test_reject_persisted_user_revision_preserves_a_later_external_edit(self) -> None:
        file_id = self._seed("resources/stale-user-reject.md", b"base")
        receipt = await self._capture(
            "stale-user-reject", {"resources/stale-user-reject.md": b"candidate"}
        )
        member = self.batches.batch(self.project.id, receipt.batch_id).members[0]
        saved = self.versions.commit_working(
            self.project.id,
            member.path,
            b"user revision",
            member.candidate_revision,
            "workbench-save",
        )
        refreshed = self.batches.batch(self.project.id, receipt.batch_id).members[0]
        target = Path(self.project.root) / member.path
        target.write_bytes(b"later external edit")

        failed = self.batches.commit(
            self.project.id,
            receipt.batch_id,
            (
                ReviewBatchDecision(
                    file_id,
                    refreshed.review_id,
                    refreshed.pending_revision,
                    ReviewAction.REJECT,
                    saved.revision,
                ),
            ),
            "reject-stale-user-revision",
        )

        self.assertEqual(failed.batch.state, ReviewBatchState.FAILED)
        self.assertEqual(failed.batch.members[0].error, "review_revision_conflict")
        self.assertEqual(target.read_bytes(), b"later external edit")

    async def test_reject_after_revised_version_restores_that_version(self) -> None:
        file_id = self._seed("resources/sequential-reject.md", b"base")
        first = await self._capture(
            "sequential-revise", {"resources/sequential-reject.md": b"first candidate"}
        )
        first_member = self.batches.batch(self.project.id, first.batch_id).members[0]
        target = Path(self.project.root) / first_member.path
        target.write_bytes(b"first external")
        first_current = self.batches.content(self.project.id, first.batch_id, file_id, "current")[2]
        revised = self.batches.commit(
            self.project.id,
            first.batch_id,
            (
                ReviewBatchDecision(
                    file_id,
                    first_member.review_id,
                    first_member.pending_revision,
                    ReviewAction.REVISE,
                    first_current,
                ),
            ),
            "sequential-revise",
        )
        self.assertEqual(revised.batch.state, ReviewBatchState.COMPLETED)

        second = await self._capture(
            "sequential-reject", {"resources/sequential-reject.md": b"second candidate"}
        )
        second_member = self.batches.batch(self.project.id, second.batch_id).members[0]
        target.write_bytes(b"second external")
        second_current = self.batches.content(self.project.id, second.batch_id, file_id, "current")[
            2
        ]
        rejected = self.batches.commit(
            self.project.id,
            second.batch_id,
            (
                ReviewBatchDecision(
                    file_id,
                    second_member.review_id,
                    second_member.pending_revision,
                    ReviewAction.REJECT,
                    second_current,
                ),
            ),
            "sequential-reject",
        )
        self.assertEqual(rejected.batch.state, ReviewBatchState.COMPLETED)
        self.assertEqual(target.read_bytes(), b"first external")

    async def test_created_and_deleted_tombstone_contents_are_empty(self) -> None:
        await self.delivery.begin_turn("session", "create", self.project.root)
        await self.delivery.bind_turn("session", "create", "create", "generation")
        created = Path(self.project.root) / "resources/created.md"
        created.parent.mkdir(parents=True, exist_ok=True)
        created.write_bytes(b"created")
        await self.delivery.record_change(
            "session", "create", str(created), "create", generation="generation"
        )
        create_receipt = await self.delivery.finish_turn("session", "create", TurnOutcome.COMPLETED)
        create_member = self.batches.batch(self.project.id, create_receipt.batch_id).members[0]
        self.assertEqual(
            self.batches.content(
                self.project.id, create_receipt.batch_id, create_member.file_id, "base"
            )[0],
            b"",
        )

        deleted_id = self._seed("resources/deleted.md", b"deleted base")
        await self.delivery.begin_turn("session", "delete", self.project.root)
        await self.delivery.bind_turn("session", "delete", "delete", "generation")
        deleted = Path(self.project.root) / "resources/deleted.md"
        deleted.unlink()
        await self.delivery.record_change(
            "session", "delete", str(deleted), "delete", generation="generation"
        )
        delete_receipt = await self.delivery.finish_turn("session", "delete", TurnOutcome.COMPLETED)
        self.assertEqual(
            self.batches.content(self.project.id, delete_receipt.batch_id, deleted_id, "candidate")[
                0
            ],
            b"",
        )


if __name__ == "__main__":
    unittest.main()
