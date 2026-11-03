"""Product full-text gate contract: candidate files pause, ask and resume (not acceptance)."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

from service.assistant.service.authorization import (
    AUTHORIZATION_REQUIRED,
    LITERATURE_REVIEW_FULLTEXT,
    PRECISE_SEARCH_FULLTEXT,
    RESEARCH_IDEA_FULLTEXT,
    AuthorizationDisposition,
    AuthorizationState,
    FulltextAuthorization,
    FulltextAuthorizer,
    authorize_sources,
    derive_granted_scope,
)
from service.chat.constants import (
    PRODUCT_TURN_OUTCOME_INTERRUPTED,
    PRODUCT_TURN_OUTCOME_UNKNOWN,
)
from service.chat.persistence.catalog import (
    HilStatus,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.runtime.interaction import SessionInteractions
from service.chat.service.tasks import ProductTaskLease, verified_authorization_context
from service.literature.api.gate import (
    CONTINUATION_PLAN,
    CONTINUATION_REJECTED,
    FulltextGate,
)
from service.literature.service.checkpoint import (
    active_policies,
    discover_triggers,
    policy_for,
    read_checkpoint,
)
from service.literature.service.result import AGENTIC_SEARCH_ORIGIN, SEARCH_CARD
from service.literature.service.review import CORPUS, METADATA, QUERY, RETRIEVAL
from service.platform.activity import Activities, ActivityDomain, ActivityLease
from service.platform.context import FulltextTaskContext, ProductTaskType

SESSION_ID = "gate-session"
AUTHORIZE = "一键授权"
REJECT = "拒绝"
PRECISE_RUN = ".precise-literature-search/runs/run1"
WAIT_SECONDS = 5.0
POLL_SECONDS = 0.01
PAST_SECONDS = 60


def write(path: Path, value: dict | str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        value if isinstance(value, str) else json.dumps(value, ensure_ascii=False),
        encoding="utf-8",
    )


def age(path: Path) -> None:
    past = time.time() - PAST_SECONDS
    os.utime(path, (past, past))


class RecordingTurns:
    def __init__(self) -> None:
        self.posts: list[dict[str, Any]] = []

    async def post(
        self,
        session_id: str,
        body: dict[str, Any],
        *,
        side: bool,
        expected_submission_id: str = "",
        expected_interrupt_generation: int | None = None,
        continuation_activity: ActivityLease | None = None,
    ) -> tuple[dict[str, Any], int]:
        self.posts.append({"session_id": session_id, "body": body, "side": side})
        return {"ok": True}, 202


class FulltextGateContract(unittest.TestCase):
    def test_idea_authorization_uses_turn_component_without_task_lease(self) -> None:
        live = self.live(ProductTaskType.RESEARCH_IDEA.value)
        reference = {
            "plugin": "research-idea-partner",
            "component": "authorization",
            "fingerprint": "verified",
        }
        live.component_for.return_value = reference
        live.interactions = SimpleNamespace(request_product_input=AsyncMock(return_value={}))
        papers = (
            {"id": "paper-one", "label": "First paper"},
            {"id": "outside", "label": "Excluded"},
        )
        asyncio.run(
            authorize_sources(
                live,
                self.authorizer,
                turn_id="native-turn-1",
                snapshot_id="snapshot-1",
                authorization_type=RESEARCH_IDEA_FULLTEXT,
                refs=("paper-one",),
                papers=papers,
            )
        )
        question = live.interactions.request_product_input.call_args.args[0]
        live.component_for.assert_awaited_once_with(
            "literature.authorization", interaction_id=question["id"]
        )
        self.assertEqual(question["component"], reference)
        self.assertEqual(question["component_data"], {"papers": [papers[0]], "scope_count": 1})
        self.assertNotIn("papers", question)

    def test_duplicate_bridge_checkpoint_shares_one_authorization_wait(self) -> None:
        async def scenario() -> None:
            live = self.live(ProductTaskType.LITERATURE_REVIEW.value)
            gate = FulltextGate(
                self.authorizer, RecordingTurns(), activities=self.activities, poll_seconds=0
            )
            arguments = {
                "turn_id": "native-turn-1",
                "snapshot_id": "snapshot-1",
                "authorization_type": LITERATURE_REVIEW_FULLTEXT,
                "refs": ("paper", "artifact-hash"),
                "source_count": 1,
            }
            first = asyncio.create_task(gate.authorize_sources(live, **arguments))
            while not self.catalog.pending_hil(SESSION_ID):
                await asyncio.sleep(0)
            second = asyncio.create_task(gate.authorize_sources(live, **arguments))
            await asyncio.sleep(POLL_SECONDS)
            pending = self.catalog.pending_hil(SESSION_ID)
            self.assertEqual(len(pending), 1)
            self.assertFalse(second.done())
            await live.interactions.resolve(
                None,
                pending[0].product_request_id,
                {"answers": {pending[0].product_request_id: AUTHORIZE}},
            )
            first_result, second_result = await asyncio.gather(first, second)
            self.assertEqual(first_result, second_result)
            self.assertEqual(first_result[1].value, "authorized")
            self.assertEqual(len(self.catalog.turn_hil(SESSION_ID, "native-turn-1")), 1)

        asyncio.run(scenario())

    def test_bridge_wait_survives_http_cancel_but_stop_cancels_continuation(self) -> None:
        async def scenario() -> None:
            live = self.live(ProductTaskType.LITERATURE_REVIEW.value)
            cleanup = asyncio.Event()
            live.current_task = asyncio.create_task(cleanup.wait())
            turns = RecordingTurns()
            gate = FulltextGate(self.authorizer, turns, activities=self.activities, poll_seconds=0)
            request = asyncio.create_task(
                gate.authorize_sources(
                    live,
                    turn_id="native-turn-1",
                    snapshot_id="snapshot-1",
                    authorization_type=LITERATURE_REVIEW_FULLTEXT,
                    refs=("paper", "artifact-hash"),
                    source_count=1,
                )
            )
            while not self.catalog.pending_hil(SESSION_ID):
                await asyncio.sleep(0)
            pending = self.catalog.pending_hil(SESSION_ID)[0]
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)
            live.ledger.active_turn_id = ""
            live.running = False
            self.catalog.update_status(
                SESSION_ID,
                SessionStatus.COMPLETED,
                turn_id="native-turn-1",
                turn_status="completed",
            )
            response = await live.interactions.resolve(
                None,
                pending.product_request_id,
                {"answers": {pending.product_request_id: AUTHORIZE}},
            )
            self.assertIsNotNone(response)
            await asyncio.sleep(0)
            live.interrupt_generation += 1
            cleanup.set()
            await asyncio.gather(*gate._bridge_tasks)
            self.assertEqual(turns.posts, [])

        asyncio.run(scenario())

    def test_cancel_notification_failure_settles_all_bridge_waiters(self) -> None:
        async def scenario() -> None:
            live = self.live("literature_review")
            turns = RecordingTurns()
            gate = FulltextGate(self.authorizer, turns, activities=self.activities, poll_seconds=0)
            requests = [
                asyncio.create_task(
                    gate.authorize_sources(
                        live,
                        turn_id="native-turn-1",
                        snapshot_id="snapshot-1",
                        authorization_type=LITERATURE_REVIEW_FULLTEXT,
                        refs=(ref,),
                        source_count=1,
                    )
                )
                for ref in ("paper-one", "paper-two")
            ]
            async with asyncio.timeout(WAIT_SECONDS):
                while len(self.catalog.pending_hil(SESSION_ID)) != len(requests):
                    await asyncio.sleep(POLL_SECONDS)
            pending = self.catalog.pending_hil(SESSION_ID)
            published = []
            finished = []
            live.interactions._finish_component = finished.append

            async def failed_publish(kind, payload, **kwargs):
                self.assertEqual(len(finished), len(requests))
                published.append(payload)
                raise RuntimeError("notification unavailable")

            live.interactions._publish = failed_publish
            live.turn_activity.close()
            generation = self.activities.begin()
            with self.assertRaises(ExceptionGroup) as failure:
                await live.interactions.cancel_product_requests()
            self.assertEqual(len(failure.exception.exceptions), len(requests))
            self.assertEqual(len(published), len(requests))
            results = await asyncio.wait_for(asyncio.gather(*requests), WAIT_SECONDS)
            self.assertTrue(all(result[2].get("cancelled") for result in results))
            self.assertTrue(
                all(
                    self.catalog.hil(row.product_request_id).status is HilStatus.RESOLVED
                    for row in pending
                )
            )
            self.assertEqual(live.interactions._product_waiters, {})
            self.assertEqual(live.interactions._product_activities, {})
            self.assertCountEqual(
                [question["id"] for question in finished],
                [row.payload["questions"][0]["id"] for row in pending],
            )
            await live.interactions.cancel_product_requests()
            self.assertEqual(len(finished), len(requests))
            self.assertEqual(len(published), len(requests))
            self.assertEqual(turns.posts, [])
            self.assertTrue(self.activities.seal(generation))

        asyncio.run(scenario())

    def test_cancel_recovers_durable_decision_without_overwriting_it(self) -> None:
        async def scenario() -> None:
            live = self.live("literature_review")
            decision = {"answers": {"recovered-question": REJECT}}
            finished = []
            live.interactions._finish_component = finished.append
            request = asyncio.create_task(
                live.interactions.request_product_input(
                    {"id": "recovered-question", "questions": []},
                    turn_id="native-turn-1",
                )
            )
            async with asyncio.timeout(WAIT_SECONDS):
                while not self.catalog.pending_hil(SESSION_ID):
                    await asyncio.sleep(POLL_SECONDS)
            self.assertTrue(self.catalog.resolve_hil("recovered-question", decision))
            await live.interactions.cancel_product_requests()
            self.assertEqual(await asyncio.wait_for(request, WAIT_SECONDS), decision)
            self.assertEqual(self.catalog.hil("recovered-question").decision, decision)
            self.assertEqual(live.interactions._product_waiters, {})
            self.assertEqual([question["id"] for question in finished], ["recovered-question"])

        asyncio.run(scenario())

    def test_bridge_authorization_continues_only_completed_origin(self) -> None:
        async def scenario(authorization_type, task_type, completed, answer) -> None:
            live = self.live(task_type)
            turns = RecordingTurns()
            gate = FulltextGate(self.authorizer, turns, activities=self.activities, poll_seconds=0)
            waiting = asyncio.create_task(
                gate.authorize_sources(
                    live,
                    turn_id="native-turn-1",
                    snapshot_id="snapshot-1",
                    authorization_type=authorization_type,
                    refs=("paper-one",),
                    source_count=1,
                )
            )
            while not self.catalog.pending_hil(SESSION_ID):
                await asyncio.sleep(0)
            pending = self.catalog.pending_hil(SESSION_ID)[0]
            if completed:
                live.current_task.done = lambda: True
                live.ledger.active_turn_id = ""
                live.running = False
                self.catalog.update_status(
                    SESSION_ID,
                    SessionStatus.COMPLETED,
                    turn_id="native-turn-1",
                    turn_status="completed",
                )
            await live.interactions.resolve(
                None, pending.product_request_id, {"answers": {pending.product_request_id: answer}}
            )
            await waiting
            expected = int(
                completed and (answer == AUTHORIZE or authorization_type == RESEARCH_IDEA_FULLTEXT)
            )
            self.assertEqual(len(turns.posts), expected)
            if expected:
                self.assertEqual(turns.posts[0]["body"]["task_type"], task_type)
            if completed:
                self.assertNotEqual(self.catalog.get(SESSION_ID).status, SessionStatus.RUNNING)

        for authorization_type, task_type in (
            (LITERATURE_REVIEW_FULLTEXT, ProductTaskType.LITERATURE_REVIEW.value),
            (PRECISE_SEARCH_FULLTEXT, ProductTaskType.PRECISE_SEARCH.value),
            (RESEARCH_IDEA_FULLTEXT, ProductTaskType.RESEARCH_IDEA.value),
        ):
            for completed, answer in ((False, AUTHORIZE), (True, AUTHORIZE), (True, REJECT)):
                with self.subTest(
                    authorization_type=authorization_type, completed=completed, answer=answer
                ):
                    self.setUp()
                    asyncio.run(scenario(authorization_type, task_type, completed, answer))

    def setUp(self) -> None:
        self.activities = Activities()
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "workdir"
        self.root.mkdir()
        database = Path(temporary.name) / "sessions.sqlite3"
        self.catalog = SessionCatalogStore(database)
        self.catalog.register(
            SESSION_ID,
            SessionPrincipal("owner"),
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root / "outputs"),
            codex_version="contract",
            model_id="contract",
            policy_id="workspace-write",
            status=SessionStatus.RUNNING,
            title="gate",
            created_at=1.0,
        )
        self.authorizer = FulltextAuthorizer(database, self.catalog)

    # Fixtures written in the exact shapes the skills produce.

    def precise_selection(self, *, download: bool = True) -> Path:
        run = self.root / PRECISE_RUN
        write(
            run / "state.json",
            {
                "run_id": "run1",
                "search_round": 1,
                "paths": {
                    "intent": "intent.json",
                    "latest_metadata": "search/round-001/metadata.json",
                    "latest_search_report": "search/round-001/report.md",
                    "selection": "selection.json",
                },
            },
        )
        write(run / "intent.json", {"confirmed": True, "precise_intent": "方法"})
        write(
            run / "search/round-001/metadata.json",
            {
                "run_id": "run1",
                "round": 1,
                "status": "success",
                "is_placeholder": False,
                "papers": [
                    {"id": "p1", "title": "Paper One", "is_placeholder": False},
                    {"id": "p2", "title": "Paper Two", "is_placeholder": False},
                ],
            },
        )
        write(run / "search/round-001/report.md", "# report")
        selection = run / "selection.json"
        write(
            selection,
            {
                "run_id": "run1",
                "metadata_path": "search/round-001/metadata.json",
                "selected_paper_ids": ["p1"],
                "confirmed_by_user": True,
                "download_open": download,
                "download_paid": False,
            },
        )
        return selection

    def review_selection(self, binding: dict | None = None) -> Path:
        workspace = self.root / "survey"
        write(
            workspace / ".slr-binding.json",
            binding if binding is not None else {"schema_version": 1, "run_id": "review-run"},
        )
        write(
            workspace / "_status/retrieval_adapt.json",
            {"stage": "retrieval_adapt", "status": "SUCCESS"},
        )
        write(workspace / QUERY, {"query": "对比方法"})
        write(
            workspace / METADATA,
            {"papers": [{"paper_id": "r1", "title": "Review One", "source": "paperhub"}]},
        )
        write(workspace / RETRIEVAL, {"input_count": 1, "degradations": []})
        selection = workspace / CORPUS
        write(selection, {"r1": {"title": "Review One"}})
        return selection

    def start_download(self, *, via_state: bool = False) -> None:
        run = self.root / PRECISE_RUN
        if via_state:
            state = json.loads((run / "state.json").read_text(encoding="utf-8"))
            write(run / "state.json", {**state, "status": "DOWNLOADING_OPEN"})
        else:
            write(run / "downloads/manifest.json", {"items": []})

    def start_fulltext(self) -> None:
        # The skill's full-text stage opens its log as soon as it starts.
        write(self.root / "survey/_logs/fulltext.log", "[slr] fetch_fulltext.py")

    def agentic_metadata(self) -> Path:
        result = self.root / "agentic-search-results/topic"
        metadata = result / "metadata.json"
        write(
            metadata,
            {
                "search_summary": {"query": "新想法", "total_rounds": 2, "pool_size": 9},
                "papers": [
                    {"paper_id": "a1", "title": "Idea One", "tier": 1, "access": "open"},
                    {"paper_id": "a2", "title": "Idea Two", "tier": 2},
                ],
            },
        )
        write(result / "report.md", "# report")
        return metadata

    def live(self, task_type: str, *, running: bool = True) -> SimpleNamespace:
        events: list[tuple[str, dict[str, Any]]] = []
        cards: list[tuple[str, dict[str, Any]]] = []
        interrupts: list[bool] = []

        async def publish(kind: str, payload: dict[str, Any], **_kwargs: Any) -> None:
            events.append((kind, payload))

        async def publish_artifact(path: str, _role: str, **kwargs: Any) -> dict[str, Any]:
            return {"artifact_id": path, "path": path, "sha256": kwargs["expected_sha256"]}

        async def display_card(kind: str, content: Any, **_kwargs: Any) -> dict[str, Any]:
            cards.append((kind, content.data))
            return {"card_id": "card"}

        async def wait_terminal(_turn_id: str) -> str:
            return "interrupted"

        live = SimpleNamespace(
            id=SESSION_ID,
            component_for=AsyncMock(return_value=None),
            runtime_id="codex",
            runtime_workdir=self.root,
            catalog=self.catalog,
            last_submission_id="client-turn-1",
            ledger=SimpleNamespace(active_turn_id="native-turn-1", wait_terminal=wait_terminal),
            active_assistant_snapshot_id="snapshot-1",
            active_task_type=task_type,
            active_product_turn_id="client-turn-1",
            product_turn_generation=1,
            active_task_lease=(
                ProductTaskLease(
                    task_type=ProductTaskType(task_type),
                    turn_id="client-turn-1",
                    generation=1,
                    source="skill_run",
                    workspace=PRECISE_RUN if task_type == "precise_search" else "survey",
                    run_id="run1" if task_type == "precise_search" else "review-run",
                )
                if task_type in ("precise_search", "literature_review")
                else None
            ),
            active_assistant_revision=None,
            active_turn_started_at=time.time() - PAST_SECONDS / 2,
            running=running,
            interrupting=False,
            interrupt_generation=0,
            terminating=False,
            terminated=False,
            current_task=SimpleNamespace(done=lambda: False),
            publish=publish,
            publish_artifact=publish_artifact,
            display_card=display_card,
            events=events,
            cards=cards,
            interrupts=interrupts,
        )

        async def interrupt(*, cleanup_background_processes: bool = False) -> None:
            assert cleanup_background_processes
            interrupts.append(True)
            live.running = False
            live.current_task.done = lambda: True
            live.active_assistant_snapshot_id = ""
            live.active_task_lease = None
            live.current_task = None

        live.turn_activity = self.activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        live.interrupt = interrupt
        live.interactions = SessionInteractions(SESSION_ID, self.catalog, publish)
        return live

    def run_gate(self, gate: FulltextGate, live: SimpleNamespace, answer: str | None) -> list[Any]:
        async def scenario() -> list[Any]:
            gate.observe(live)
            asked = []
            if answer is not None:
                deadline = time.monotonic() + WAIT_SECONDS
                while not self.catalog.pending_hil(SESSION_ID):
                    if time.monotonic() > deadline:
                        raise AssertionError("authorization question was not asked")
                    await asyncio.sleep(POLL_SECONDS)
                pending = self.catalog.pending_hil(SESSION_ID)
                asked = [row.payload["questions"][0] for row in pending]
                await live.interactions.resolve(
                    None,
                    pending[0].product_request_id,
                    {"answers": {asked[0]["id"]: answer}},
                )
            await gate.wait_idle(SESSION_ID)
            return asked

        return asyncio.run(scenario())

    def test_cancelled_scan_retains_thread_and_serialization_until_exit(self) -> None:
        async def scenario() -> None:
            live = self.live(ProductTaskType.LITERATURE_REVIEW.value)
            gate = FulltextGate(
                self.authorizer, RecordingTurns(), activities=self.activities, poll_seconds=0
            )
            entered, release = threading.Event(), threading.Event()

            def pending(_live):
                entered.set()
                if not release.wait(WAIT_SECONDS):
                    raise AssertionError("scan release timed out")

            with patch.object(gate, "_pending", side_effect=pending):
                gate.observe(live)
                task = gate._tasks[live.id]
                while not entered.is_set():
                    await asyncio.sleep(POLL_SECONDS)
                live.turn_activity.close()
                live.turn_activity = None
                generation = self.activities.begin()
                task.cancel()
                await asyncio.sleep(POLL_SECONDS)
                self.assertFalse(task.done())
                self.assertFalse(self.activities.seal(generation))
                gate.observe(live)
                self.assertIs(gate._tasks[live.id], task)
                release.set()
                await gate.wait_idle(live.id)
                self.assertTrue(self.activities.seal(generation))

        asyncio.run(scenario())

    def test_periodic_ticks_do_not_prevent_a_slow_scan_from_finishing(self) -> None:
        async def scenario() -> None:
            live = self.live(ProductTaskType.LITERATURE_REVIEW.value)
            gate = FulltextGate(
                self.authorizer,
                RecordingTurns(),
                activities=self.activities,
                poll_seconds=POLL_SECONDS,
            )

            def pending(_live):
                time.sleep(POLL_SECONDS * 5)

            with patch.object(gate, "_pending", side_effect=pending):
                try:
                    gate.observe(live)
                    await asyncio.wait_for(gate.wait_idle(live.id), WAIT_SECONDS)
                finally:
                    live.running = False
                    for watcher in tuple(gate._watchers.values()):
                        watcher.cancel()
                    await asyncio.gather(*tuple(gate._watchers.values()), return_exceptions=True)
                    await gate.wait_idle(live.id)

        asyncio.run(scenario())

    def test_post_turn_scan_waits_for_resume_without_accessing_files(self) -> None:
        async def scenario() -> None:
            live = self.live(ProductTaskType.LITERATURE_REVIEW.value)
            live.turn_activity.close()
            live.turn_activity = None
            gate = FulltextGate(
                self.authorizer, RecordingTurns(), activities=self.activities, poll_seconds=0
            )
            generation = self.activities.begin()
            with patch.object(gate, "_pending", return_value=None) as pending:
                gate.observe(live)
                await asyncio.sleep(POLL_SECONDS)
                pending.assert_not_called()
                self.assertTrue(self.activities.seal(generation))
                self.activities.resume(generation)
                await gate.wait_idle(live.id)
                pending.assert_called_once_with(live)

        asyncio.run(scenario())

    def test_bridge_wait_survives_request_cancel_and_origin_turn_exit_during_drain(self) -> None:
        async def scenario() -> None:
            live = self.live(ProductTaskType.LITERATURE_REVIEW.value)
            gate = FulltextGate(
                self.authorizer, RecordingTurns(), activities=self.activities, poll_seconds=0
            )
            request = asyncio.create_task(
                gate.authorize_sources(
                    live,
                    turn_id="native-turn-1",
                    snapshot_id="snapshot-1",
                    authorization_type=LITERATURE_REVIEW_FULLTEXT,
                    refs=("paper",),
                    source_count=1,
                )
            )
            while not self.catalog.pending_hil(SESSION_ID):
                await asyncio.sleep(POLL_SECONDS)
            pending = self.catalog.pending_hil(SESSION_ID)[0]
            activity = live.interactions.product_activity(pending.product_request_id)
            self.assertIsNotNone(activity)
            live.turn_activity.close()
            live.turn_activity = None
            generation = self.activities.begin()
            request.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await request
            self.assertFalse(self.activities.seal(generation))
            with self.activities.continue_from(activity, ActivityDomain.TURN):
                await live.interactions.resolve(
                    None,
                    pending.product_request_id,
                    {
                        "answers": {pending.product_request_id: AUTHORIZE},
                    },
                )
            await asyncio.gather(*tuple(gate._bridge_tasks))
            self.assertIsNone(live.interactions.product_activity(pending.product_request_id))
            self.assertTrue(self.activities.seal(generation))

        asyncio.run(scenario())

    # Discovery and validation.

    def directory_alias(self, alias: Path, target: Path) -> None:
        if os.name == "nt":
            subprocess.run(
                ["cmd.exe", "/d", "/c", "mklink", "/J", str(alias), str(target)],
                check=True,
                capture_output=True,
            )
            self.addCleanup(alias.rmdir)
        else:
            alias.symlink_to(target, target_is_directory=True)
            self.addCleanup(alias.unlink)

    def test_checkpoint_discovery_rejects_root_alias(self) -> None:
        self.precise_selection()
        alias = self.root.parent / "aliased-workdir"
        self.directory_alias(alias, self.root)
        self.assertEqual(discover_triggers(alias, "precise_search"), ())

    def test_checkpoint_discovery_rejects_ancestor_alias(self) -> None:
        selection = self.precise_selection()
        run = selection.parent
        moved = self.root.parent / "external-run"
        run.rename(moved)
        self.directory_alias(run, moved)
        self.assertEqual(discover_triggers(self.root, "precise_search"), ())

    def test_checkpoint_consumption_rejects_marker_ancestor_alias(self) -> None:
        selection = self.review_selection()
        external = self.root.parent / "external-logs"
        write(external / "fulltext.log", "outside")
        self.directory_alias(self.root / "survey/_logs", external)
        policy = policy_for(LITERATURE_REVIEW_FULLTEXT)
        self.assertFalse(
            policy.consumption_started(self.root, selection.relative_to(self.root).as_posix(), 0)
        )

    def test_policies_observe_only_their_task_and_unambiguous_files(self) -> None:
        self.assertEqual(
            {policy.authorization_type for policy in active_policies("")},
            {PRECISE_SEARCH_FULLTEXT, LITERATURE_REVIEW_FULLTEXT},
        )
        self.assertEqual(
            [policy.authorization_type for policy in active_policies("research_idea")],
            [RESEARCH_IDEA_FULLTEXT],
        )
        self.agentic_metadata()
        self.assertEqual(discover_triggers(self.root, ProductTaskType.LITERATURE_REVIEW.value), ())
        self.assertEqual(discover_triggers(self.root, ""), ())
        found = discover_triggers(self.root, ProductTaskType.RESEARCH_IDEA.value)
        self.assertEqual(
            [trigger for _policy, trigger, _mtime in found],
            ["agentic-search-results/topic/metadata.json"],
        )

    def test_each_skill_file_is_validated_by_its_owning_reader(self) -> None:
        self.precise_selection()
        self.review_selection()
        prepared = {
            policy.authorization_type: read_checkpoint(self.root, policy, trigger, modified)
            for policy, trigger, modified in discover_triggers(self.root, "")
        }
        precise = prepared[PRECISE_SEARCH_FULLTEXT]
        review = prepared[LITERATURE_REVIEW_FULLTEXT]
        self.assertIsNotNone(precise)
        self.assertIsNotNone(review)
        self.assertEqual([source.id for source in precise.content.sources], ["p1"])
        # The selection digest travels in decision values, never in the ledger scope.
        self.assertEqual(tuple(precise.content.refs), ("paper:p1",))
        self.assertEqual(
            {artifact.field for artifact in precise.content.artifacts},
            {"report", "metadata", "selection"},
        )
        self.assertEqual([source.id for source in review.content.sources], ["r1"])
        self.agentic_metadata()
        (idea,) = discover_triggers(self.root, "research_idea")
        idea_checkpoint = read_checkpoint(self.root, *idea)
        self.assertEqual(idea_checkpoint.content.card.origin, AGENTIC_SEARCH_ORIGIN)
        self.assertEqual(idea_checkpoint.content.refs, ("paper:a1", "paper:a2"))

    def test_review_workspace_without_launcher_run_id_still_gates(self) -> None:
        # Refreshed skill releases bind only the skill path and version.
        self.review_selection({"skill": "/skills/literature-review", "version": "1.1.0"})
        (found,) = discover_triggers(self.root, ProductTaskType.LITERATURE_REVIEW.value)
        checkpoint = read_checkpoint(self.root, *found)
        self.assertIsNotNone(checkpoint)
        self.assertTrue(checkpoint.content.card.run_id.startswith("slr-"))
        self.assertEqual([source.id for source in checkpoint.content.sources], ["r1"])
        again = read_checkpoint(self.root, *found)
        self.assertEqual(again.content.card.run_id, checkpoint.content.card.run_id)

    def test_metadata_only_partial_and_unusable_files_do_not_gate(self) -> None:
        self.precise_selection(download=False)
        selection = self.review_selection()
        write(selection.parent.parent / "_status/retrieval_adapt.json", {"status": "RUNNING"})
        for policy, trigger, modified in discover_triggers(self.root, ""):
            self.assertIsNone(read_checkpoint(self.root, policy, trigger, modified), trigger)
        write(selection, "{")
        write(
            selection.parent.parent / "_status/retrieval_adapt.json",
            {"stage": "retrieval_adapt", "status": "SUCCESS"},
        )
        for policy, trigger, modified in discover_triggers(self.root, ""):
            self.assertIsNone(read_checkpoint(self.root, policy, trigger, modified), trigger)

    # Pause, ask and resume.

    def test_authorized_selection_interrupts_asks_and_resumes_with_scoped_grant(self) -> None:
        self.precise_selection()
        self.start_download()
        live = self.live("precise_search")
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns, activities=self.activities)
        asked = self.run_gate(gate, live, AUTHORIZE)
        self.assertEqual(live.interrupts, [True])
        self.assertEqual(asked[0]["header"], "精准检索授权")
        self.assertEqual(live.cards[0][0], SEARCH_CARD)
        self.assertTrue(live.cards[0][1]["selection"]["artifact_id"])
        (post,) = turns.posts
        self.assertFalse(post["side"])
        self.assertEqual(post["body"]["task_type"], "precise_search")
        self.assertIn(CONTINUATION_PLAN, post["body"]["input"][0]["text"])
        self.assertIn(CONTINUATION_PLAN, CONTINUATION_REJECTED)
        continuation = post["body"]["client_user_message_id"]
        self.assertTrue(
            self.authorizer.granted_scope(
                session_id=SESSION_ID,
                authorization_type=PRECISE_SEARCH_FULLTEXT,
                refs=read_checkpoint(self.root, *discover_triggers(self.root, "")[0]).content.refs,
            )
        )
        self.authorizer.require(
            session_id=SESSION_ID,
            snapshot_id="later-snapshot",
            turn_id="later-native-turn",
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            ref_id="paper:p1",
            client_turn_id=continuation,
        )
        with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
            self.authorizer.require(
                session_id=SESSION_ID,
                snapshot_id="later-snapshot",
                turn_id="later-native-turn",
                authorization_type=PRECISE_SEARCH_FULLTEXT,
                ref_id="paper:p1",
                client_turn_id="unrelated-turn",
            )
        self.assertEqual(self.catalog.get(SESSION_ID).status, SessionStatus.INTERRUPTED)
        # The resumed task writes the same set again: it is never asked twice.
        live.last_submission_id = continuation
        live.running = True
        live.active_turn_started_at = 0.0
        self.run_gate(gate, live, None)
        self.assertEqual(len(turns.posts), 1)
        self.assertEqual(live.interrupts, [True])

    def test_authorization_is_created_only_after_interrupted_turn_terminal_cleanup(self) -> None:
        self.review_selection()
        self.start_fulltext()
        live = self.live("literature_review")
        terminal_waiting = asyncio.Event()
        release_terminal = asyncio.Event()
        original_interrupt = live.interrupt

        async def interrupt(*, cleanup_background_processes: bool = False) -> None:
            await original_interrupt(cleanup_background_processes=cleanup_background_processes)
            live.ledger.active_turn_id = ""

        async def wait_terminal(turn_id: str) -> str:
            self.assertEqual(turn_id, "native-turn-1")
            terminal_waiting.set()
            await release_terminal.wait()
            # This is the old turn's terminal cleanup. A newly-created authorization
            # would be expired here and reproduce Aone 87043686.
            self.catalog.expire_pending_hil(SESSION_ID)
            return "interrupted"

        live.interrupt = interrupt
        live.ledger.wait_terminal = wait_terminal
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns, activities=self.activities, poll_seconds=0)

        async def scenario() -> None:
            gate.observe(live)
            await asyncio.wait_for(terminal_waiting.wait(), WAIT_SECONDS)
            self.assertEqual(self.catalog.pending_hil(SESSION_ID), ())
            release_terminal.set()
            deadline = time.monotonic() + WAIT_SECONDS
            while not self.catalog.pending_hil(SESSION_ID):
                if time.monotonic() > deadline:
                    raise AssertionError("authorization question was not asked after terminal")
                await asyncio.sleep(POLL_SECONDS)
            pending = self.catalog.pending_hil(SESSION_ID)
            question = pending[0].payload["questions"][0]
            decision = await live.interactions.resolve(
                None,
                pending[0].product_request_id,
                {"answers": {question["id"]: AUTHORIZE}},
            )
            self.assertIsNotNone(decision)
            await gate.wait_idle(SESSION_ID)

        asyncio.run(scenario())
        self.assertEqual(len(turns.posts), 1)

    def test_completed_native_turn_waits_for_product_cleanup_without_client_terminal(self) -> None:
        self.review_selection()
        self.start_fulltext()
        live = self.live("literature_review")
        live.ledger.active_turn_id = ""
        interrupted = asyncio.Event()
        release_cleanup = asyncio.Event()
        terminal_ids: list[str] = []

        async def wait_terminal(turn_id: str) -> str:
            terminal_ids.append(turn_id)
            # Only a native turn can produce a ledger terminal; the client ID never will.
            await asyncio.Future()
            return "completed"

        async def cleanup() -> None:
            await release_cleanup.wait()
            self.catalog.expire_pending_hil(SESSION_ID)
            live.running = False
            live.current_task = None
            live.turn_activity.close()

        async def interrupt(*, cleanup_background_processes: bool = False) -> None:
            self.assertTrue(cleanup_background_processes)
            interrupted.set()

        live.ledger.wait_terminal = wait_terminal
        live.interrupt = interrupt
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns, activities=self.activities, poll_seconds=0)

        async def scenario() -> None:
            live.current_task = asyncio.create_task(cleanup())
            gate.observe(live)
            await asyncio.wait_for(interrupted.wait(), WAIT_SECONDS)
            self.assertEqual(self.catalog.pending_hil(SESSION_ID), ())
            self.assertEqual(self.activities.snapshot().counts.get("bridge"), 1)
            self.assertEqual(terminal_ids, [])
            release_cleanup.set()
            deadline = time.monotonic() + WAIT_SECONDS
            while not self.catalog.pending_hil(SESSION_ID):
                if time.monotonic() > deadline:
                    raise AssertionError("authorization blocked after product cleanup")
                await asyncio.sleep(POLL_SECONDS)
            pending = self.catalog.pending_hil(SESSION_ID)[0]
            question = pending.payload["questions"][0]
            await live.interactions.resolve(
                None,
                pending.product_request_id,
                {"answers": {question["id"]: REJECT}},
            )
            await asyncio.wait_for(gate.wait_idle(SESSION_ID), WAIT_SECONDS)
            self.assertEqual(self.activities.snapshot().counts, {})
            self.assertEqual(turns.posts, [])

        asyncio.run(scenario())

    def test_controlled_interrupt_reconciles_unknown_before_continuation(self) -> None:
        self.precise_selection()
        self.start_download()
        live = self.live("precise_search")

        async def wait_terminal(turn_id: str) -> str:
            self.catalog.update_status(
                SESSION_ID,
                SessionStatus.ERROR,
                turn_id=turn_id,
                turn_status=PRODUCT_TURN_OUTCOME_UNKNOWN,
            )
            return PRODUCT_TURN_OUTCOME_UNKNOWN

        live.ledger.wait_terminal = wait_terminal
        reconciled: list[str] = []

        async def reconcile_controlled_interrupt(turn_id: str) -> bool:
            reconciled.append(turn_id)
            self.catalog.update_status(
                SESSION_ID,
                SessionStatus.INTERRUPTED,
                turn_id=turn_id,
                turn_status=PRODUCT_TURN_OUTCOME_INTERRUPTED,
            )
            return True

        live.ledger.reconcile_controlled_interrupt = reconcile_controlled_interrupt
        turns = RecordingTurns()
        self.run_gate(
            FulltextGate(self.authorizer, turns, activities=self.activities, poll_seconds=0),
            live,
            AUTHORIZE,
        )

        record = self.catalog.get(SESSION_ID)
        self.assertEqual(reconciled, ["native-turn-1"])
        self.assertEqual(record.status, SessionStatus.INTERRUPTED)
        self.assertEqual(record.last_turn_status, PRODUCT_TURN_OUTCOME_INTERRUPTED)
        self.assertEqual(len(turns.posts), 1)

    def test_rejected_task_does_not_resume_or_ask_again_on_manual_continue(self) -> None:
        self.review_selection()
        self.start_fulltext()
        live = self.live("literature_review")
        live.user_id = "owner"
        live.project_id = "project"
        live.active_task_lease = replace(live.active_task_lease, persistent_run=True)
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns, activities=self.activities)
        asked = self.run_gate(gate, live, REJECT)
        self.assertEqual(asked[0]["header"], "综述检索授权")
        self.assertEqual(turns.posts, [])
        self.run_gate(gate, live, None)
        self.assertEqual(len(self.catalog.turn_hil(SESSION_ID, "native-turn-1")), 1)
        live.last_submission_id = "client-turn-2"
        live.active_product_turn_id = "client-turn-2"
        live.active_task_lease = ProductTaskLease(
            task_type=ProductTaskType.LITERATURE_REVIEW,
            turn_id="client-turn-2",
            generation=1,
            source="skill_run",
            workspace="survey",
            run_id="review-run",
            persistent_run=True,
        )
        live.current_task = SimpleNamespace(done=lambda: False)
        live.ledger.active_turn_id = "native-turn-2"
        live.running = True
        live.active_turn_started_at = time.time()
        self.run_gate(gate, live, None)
        self.assertEqual(len(live.interrupts), 1)

    def test_interrupt_captures_verified_context_before_cleanup(self) -> None:
        self.precise_selection()
        self.start_download()
        live = self.live("precise_search")
        live.user_id = "owner"
        live.project_id = "project"
        live.active_task_lease = replace(live.active_task_lease, persistent_run=True)
        context = verified_authorization_context(live, ProductTaskType.PRECISE_SEARCH)
        self.run_gate(
            FulltextGate(self.authorizer, RecordingTurns(), activities=self.activities),
            live,
            AUTHORIZE,
        )
        self.assertIsNone(live.active_task_lease)
        self.assertEqual(live.active_assistant_snapshot_id, "")
        restarted = FulltextAuthorizer(
            self.catalog.database, SessionCatalogStore(self.catalog.database)
        )
        restarted.require(
            session_id=SESSION_ID,
            snapshot_id="snapshot-2",
            turn_id="native-turn-2",
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            ref_id="paper:p1",
            task_context=context,
        )

    def test_persistent_task_without_project_asks_before_granting_fulltext(self) -> None:
        self.precise_selection()
        self.start_download()
        live = self.live("precise_search")
        live.user_id = "owner"
        live.project_id = ""
        live.active_task_lease = replace(live.active_task_lease, persistent_run=True)
        context = verified_authorization_context(live, ProductTaskType.PRECISE_SEARCH)
        scope = {
            "session_id": SESSION_ID,
            "snapshot_id": "snapshot-1",
            "turn_id": "native-turn-1",
            "authorization_type": PRECISE_SEARCH_FULLTEXT,
            "task_context": context,
            "ref_id": "paper:p1",
        }
        with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
            self.authorizer.require(**scope)
        asked = self.run_gate(
            FulltextGate(self.authorizer, RecordingTurns(), activities=self.activities),
            live,
            AUTHORIZE,
        )
        self.assertEqual(len(asked), 1)
        self.authorizer.require(**scope)

    def test_background_checkpoint_from_another_run_cannot_use_active_lease(self) -> None:
        self.precise_selection()
        self.start_download()
        live = self.live("precise_search")
        live.active_task_lease = replace(
            live.active_task_lease, workspace="another-run", run_id="another-run"
        )
        self.run_gate(
            FulltextGate(
                self.authorizer, RecordingTurns(), activities=self.activities, poll_seconds=0
            ),
            live,
            None,
        )
        self.assertEqual(live.interrupts, [])
        self.assertEqual(self.catalog.pending_hil(SESSION_ID), ())

    def test_expired_challenge_is_renewed_and_active_other_scope_is_preserved(self) -> None:
        live = self.live("precise_search")
        live.user_id = "owner"
        live.project_id = "project"
        live.active_task_lease = replace(live.active_task_lease, persistent_run=True)
        context = verified_authorization_context(live, ProductTaskType.PRECISE_SEARCH)
        scope = dict(
            session_id=SESSION_ID,
            snapshot_id="snapshot-1",
            turn_id="native-turn-1",
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            task_context=context,
        )
        first = self.authorizer.prepare(**scope, refs=("paper:p1",))

        def record(challenge: FulltextAuthorization) -> None:
            self.catalog.record_hil(
                product_request_id=challenge.question_id,
                session_id=SESSION_ID,
                vendor_request_id=challenge.question_id,
                vendor_turn_id=challenge.turn_id,
                vendor_item_id=None,
                method="contract",
                payload={"questions": [{"id": challenge.question_id}]},
            )

        record(first)
        second = self.authorizer.prepare(**scope, refs=("paper:p2",))
        self.catalog.resolve_hil(first.question_id, {"answers": {first.question_id: AUTHORIZE}})
        self.authorizer.require(**scope, ref_id="paper:p1")
        record(second)
        self.catalog.expire_pending_hil(SESSION_ID)
        renewed = self.authorizer.prepare(
            **{**scope, "turn_id": "native-turn-2", "snapshot_id": "snapshot-2"}, refs=("paper:p2",)
        )
        self.assertNotEqual(renewed.question_id, second.question_id)
        self.assertEqual(self.authorizer.effective_scope(**scope, refs=("paper:p2",)).allowed, ())

    def test_checkpoint_owned_candidates_wait_without_interrupting(self) -> None:
        self.precise_selection()
        self.agentic_metadata()
        precise = self.live("precise_search")
        idea = self.live("research_idea")
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns, activities=self.activities, poll_seconds=0)
        # Selected but not downloading: the task waits on its selection checkpoint.
        self.run_gate(gate, precise, None)
        # Idea full text is enforced per source by the bridge; its metadata never interrupts.
        self.run_gate(gate, idea, None)
        self.assertEqual(precise.interrupts, [])
        self.assertEqual(idea.interrupts, [])
        self.assertEqual(self.catalog.pending_hil(SESSION_ID), ())
        self.start_download(via_state=True)
        asked = self.run_gate(gate, precise, REJECT)
        self.assertEqual(asked[0]["header"], "精准检索授权")
        self.assertEqual(precise.interrupts, [True])
        self.assertEqual(turns.posts, [])

    def test_files_from_an_earlier_turn_do_not_gate_a_new_session(self) -> None:
        age(self.precise_selection())
        live = self.live("precise_search")
        live.active_turn_started_at = time.time()
        turns = RecordingTurns()
        self.run_gate(FulltextGate(self.authorizer, turns, activities=self.activities), live, None)
        self.assertEqual(live.interrupts, [])
        self.assertEqual(self.catalog.pending_hil(SESSION_ID), ())

    def test_review_waiting_on_its_checkpoint_is_not_interrupted(self) -> None:
        selection = self.review_selection()
        live = self.live("literature_review")
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns, activities=self.activities, poll_seconds=0)
        # A full-text run from before this selection does not count as consuming it.
        self.start_fulltext()
        age(self.root / "survey/_logs/fulltext.log")
        self.run_gate(gate, live, None)
        self.assertEqual(live.interrupts, [])
        self.assertEqual(self.catalog.pending_hil(SESSION_ID), ())
        self.assertEqual(turns.posts, [])
        self.assertTrue(selection.is_file())

    def test_candidates_written_during_a_long_tool_call_are_gated_by_polling(self) -> None:
        live = self.live("literature_review")
        turns = RecordingTurns()
        gate = FulltextGate(
            self.authorizer, turns, activities=self.activities, poll_seconds=POLL_SECONDS
        )

        async def scenario() -> None:
            # The turn started a single command; no tool completion follows the file.
            gate.observe(live)
            await gate.wait_idle(SESSION_ID)
            self.assertEqual(live.interrupts, [])
            self.review_selection()
            # While the task waits on its retrieval checkpoint the turn is left running.
            await asyncio.sleep(POLL_SECONDS * 20)
            await gate.wait_idle(SESSION_ID)
            self.assertEqual(live.interrupts, [])
            self.assertEqual(self.catalog.pending_hil(SESSION_ID), ())
            self.start_fulltext()
            deadline = time.monotonic() + WAIT_SECONDS
            while not self.catalog.pending_hil(SESSION_ID):
                if time.monotonic() > deadline:
                    raise AssertionError("authorization question was not asked")
                await asyncio.sleep(POLL_SECONDS)
            pending = self.catalog.pending_hil(SESSION_ID)
            question = pending[0].payload["questions"][0]
            await live.interactions.resolve(
                None, pending[0].product_request_id, {"answers": {question["id"]: AUTHORIZE}}
            )
            await gate.wait_idle(SESSION_ID)

        asyncio.run(scenario())
        self.assertEqual(live.interrupts, [True])
        (post,) = turns.posts
        self.assertEqual(post["body"]["task_type"], "literature_review")

    def test_continuation_claims_the_interrupted_turns_context_revision(self) -> None:
        # A non-default selection (e.g. web search scope) requires an explicit revision.
        self.review_selection()
        self.start_fulltext()
        live = self.live("literature_review")
        live.active_assistant_revision = 1

        async def interrupt(*, cleanup_background_processes: bool = False) -> None:
            assert cleanup_background_processes
            live.interrupts.append(True)
            live.running = False
            live.active_assistant_revision = None
            live.current_task.done = lambda: True

        live.interrupt = interrupt
        turns = RecordingTurns()
        self.run_gate(
            FulltextGate(self.authorizer, turns, activities=self.activities, poll_seconds=0),
            live,
            AUTHORIZE,
        )
        (post,) = turns.posts
        self.assertEqual(post["body"]["assistant_context_revision"], 1)

    def test_scope_already_asked_in_this_turn_is_not_asked_again(self) -> None:
        self.review_selection()
        self.start_fulltext()
        live = self.live("literature_review")
        (found,) = discover_triggers(self.root, "literature_review")
        refs = read_checkpoint(self.root, *found).content.refs
        # A blocking bridge checkpoint has already challenged this exact set.
        challenge = self.authorizer.prepare(
            session_id=SESSION_ID,
            snapshot_id="snapshot-1",
            turn_id="native-turn-1",
            authorization_type=LITERATURE_REVIEW_FULLTEXT,
            refs=refs,
        )
        self.catalog.record_hil(
            product_request_id=challenge.question_id,
            session_id=SESSION_ID,
            vendor_request_id=challenge.question_id,
            vendor_turn_id=challenge.turn_id,
            vendor_item_id=None,
            method="contract",
            payload={"questions": [{"id": challenge.question_id}]},
        )
        turns = RecordingTurns()
        self.run_gate(
            FulltextGate(self.authorizer, turns, activities=self.activities, poll_seconds=0),
            live,
            None,
        )
        self.assertEqual(live.interrupts, [])
        self.assertEqual(
            tuple(item.product_request_id for item in self.catalog.pending_hil(SESSION_ID)),
            (challenge.question_id,),
        )

    def test_cancelled_question_neither_grants_nor_resumes(self) -> None:
        self.precise_selection()
        self.start_download()
        live = self.live("precise_search")
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns, activities=self.activities)

        async def scenario() -> None:
            gate.observe(live)
            deadline = time.monotonic() + WAIT_SECONDS
            while not self.catalog.pending_hil(SESSION_ID):
                if time.monotonic() > deadline:
                    raise AssertionError("authorization question was not asked")
                await asyncio.sleep(POLL_SECONDS)
            await live.interactions.cancel_product_requests()
            await gate.wait_idle(SESSION_ID)

        asyncio.run(scenario())
        self.assertEqual(turns.posts, [])

    def test_same_turn_decided_scope_does_not_suppress_new_checkpoint_refs(self) -> None:
        selection = self.precise_selection()
        self.start_download()
        live = self.live("precise_search")
        scope = dict(
            session_id=SESSION_ID,
            snapshot_id="snapshot-1",
            turn_id="native-turn-1",
            authorization_type=PRECISE_SEARCH_FULLTEXT,
        )
        challenge = self.authorizer.prepare(**scope, refs=("paper:p1",))
        self.catalog.record_hil(
            product_request_id=challenge.question_id,
            session_id=SESSION_ID,
            vendor_request_id=challenge.question_id,
            vendor_turn_id=challenge.turn_id,
            vendor_item_id=None,
            method="contract",
            payload={"questions": [{"id": challenge.question_id}]},
        )
        self.catalog.resolve_hil(
            challenge.question_id, {"answers": {challenge.question_id: AUTHORIZE}}
        )
        content = json.loads(selection.read_text())
        content["selected_paper_ids"] = ["p1", "p2"]
        write(selection, content)
        self.start_download()
        self.assertIsNotNone(
            FulltextGate(
                self.authorizer, RecordingTurns(), activities=self.activities, poll_seconds=0
            )._pending(live)
        )


class SubsetDerivationContract(unittest.TestCase):
    """The granted subset is derived from the durable decision, never from the row."""

    QUESTION_ID = "precise-search-fulltext:subset"
    REFS = ("paper:p1", "paper:p2")

    def _authorization(self, authorization_type: str = PRECISE_SEARCH_FULLTEXT):
        return FulltextAuthorization(
            authorization_id="a1",
            session_id="s1",
            snapshot_id="snap1",
            turn_id="t1",
            authorization_type=authorization_type,
            refs=self.REFS,
            scope_digest="d1",
            question_id=self.QUESTION_ID,
            state=AuthorizationState.PENDING,
            created_at=0.0,
        )

    def _authorizer(self, decision: dict | None):
        catalog = SimpleNamespace(
            turn_hil=lambda session_id, turn_id: [
                SimpleNamespace(
                    status=HilStatus.RESOLVED,
                    decision=decision,
                    payload={"questions": [{"id": self.QUESTION_ID}]},
                )
            ]
        )
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        return FulltextAuthorizer(Path(temporary.name) / "auth.sqlite3", catalog)

    @staticmethod
    def _decision(**values: Any) -> dict:
        return {"answers": {SubsetDerivationContract.QUESTION_ID: AUTHORIZE}, "values": values}

    def test_selected_subset_narrows_the_grant(self) -> None:
        authorizer = self._authorizer(self._decision(selected_paper_ids=["paper:p2"]))
        self.assertEqual(authorizer.granted_refs(self._authorization()), ("paper:p2",))

    def test_absent_values_keep_the_challenged_set(self) -> None:
        authorizer = self._authorizer({"answers": {self.QUESTION_ID: AUTHORIZE}})
        self.assertEqual(authorizer.granted_refs(self._authorization()), self.REFS)

    def test_oversized_or_malformed_selection_fails_closed(self) -> None:
        for values in (
            {"selected_paper_ids": ["paper:p2", "paper:p9"]},
            {"selected_paper_ids": "paper:p2"},
            {"selected_paper_ids": [""]},
        ):
            authorizer = self._authorizer(self._decision(**values))
            self.assertEqual(authorizer.granted_refs(self._authorization()), ())

    def test_rejection_grants_nothing(self) -> None:
        authorizer = self._authorizer(
            {"answers": {self.QUESTION_ID: REJECT}, "values": {"selected_paper_ids": ["paper:p1"]}}
        )
        self.assertEqual(authorizer.granted_refs(self._authorization()), ())

    def test_non_subset_policy_ignores_values(self) -> None:
        authorizer = self._authorizer(self._decision(selected_paper_ids=["paper:p2"]))
        authorization = self._authorization(RESEARCH_IDEA_FULLTEXT)
        self.assertEqual(authorizer.granted_refs(authorization), self.REFS)
        self.assertEqual(
            derive_granted_scope(authorization, self._decision(selected_paper_ids=["paper:p2"])),
            self.REFS,
        )


class CrossTurnGrantContract(unittest.TestCase):
    """A durable allow is spendable only by the turn that holds it.

    Reusing an earlier turn's answer without asking produced `disposition=authorized`
    with an empty derived subset, so a resumed run could neither acquire nor read.
    """

    REFS = ("paper:p1", "paper:p2")

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.answers: dict[str, dict] = {}
        database = Path(temporary.name) / "sessions.sqlite3"
        # prepare() carries a foreign key into the session catalog, so register the session
        # in the same database the authorizer writes to.
        SessionCatalogStore(database).register(
            "s1",
            SessionPrincipal("local"),
            runtime_id="codex",
            vendor_thread_id="s1",
            vendor_session_id=None,
            runtime_workdir=temporary.name,
            project_path=None,
            output_root=str(Path(temporary.name) / "outputs"),
            codex_version="contract",
            model_id="contract",
            policy_id="on-request",
            status=SessionStatus.READY,
            title="contract",
            created_at=1.0,
        )
        catalog = SimpleNamespace(
            turn_hil=lambda session_id, turn_id: [
                SimpleNamespace(
                    status=HilStatus.RESOLVED,
                    decision=decision,
                    payload={"questions": [{"id": question_id}]},
                )
                for question_id, decision in self.answers.items()
            ]
        )
        self.authorizer = FulltextAuthorizer(database, catalog)

    def _allow(self, question_id: str, selected: list[str]) -> dict:
        decision = {
            "answers": {question_id: AUTHORIZE},
            "values": {"selected_paper_ids": selected},
        }
        self.answers[question_id] = decision
        return decision

    def test_earlier_grant_is_not_spendable_and_scope_still_looks_reusable(self) -> None:
        first = self.authorizer.prepare(
            session_id="s1",
            snapshot_id="snap1",
            turn_id="t1",
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            refs=self.REFS,
        )
        self._allow(first.question_id, ["paper:p2"])
        scope = {
            "session_id": "s1",
            "authorization_type": PRECISE_SEARCH_FULLTEXT,
            "refs": self.REFS,
        }
        # Session-level reuse says "already allowed"; the later turn can spend nothing.
        self.assertTrue(self.authorizer.granted_scope(**scope))
        self.assertEqual(
            self.authorizer.turn_granted_refs(snapshot_id="snap1", turn_id="t1", **scope),
            ("paper:p2",),
        )
        self.assertEqual(
            self.authorizer.turn_granted_refs(snapshot_id="snap2", turn_id="t2", **scope), ()
        )

    def test_a_new_turn_asks_again_instead_of_reporting_an_empty_grant(self) -> None:
        first = self.authorizer.prepare(
            session_id="s1",
            snapshot_id="snap1",
            turn_id="t1",
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            refs=self.REFS,
        )
        self._allow(first.question_id, ["paper:p2"])

        asked: list[dict] = []

        async def request_product_input(question: dict, *, turn_id: str, activity=None) -> dict:
            asked.append(question)
            return self._allow(str(question["id"]), list(self.REFS))

        live = SimpleNamespace(
            id="s1",
            active_product_turn_id="client-t2",
            component_for=AsyncMock(return_value=None),
            interactions=SimpleNamespace(request_product_input=request_product_input),
        )
        challenge, disposition, decision = asyncio.run(
            authorize_sources(
                live,
                self.authorizer,
                turn_id="t2",
                snapshot_id="snap2",
                authorization_type=PRECISE_SEARCH_FULLTEXT,
                refs=self.REFS,
            )
        )
        self.assertEqual(len(asked), 1, "a new turn must publish its own card")
        self.assertEqual(challenge.turn_id, "t2")
        self.assertIs(disposition, AuthorizationDisposition.AUTHORIZED)
        self.assertIsNotNone(decision)
        self.assertEqual(
            self.authorizer.turn_granted_refs(
                session_id="s1",
                snapshot_id="snap2",
                turn_id="t2",
                authorization_type=PRECISE_SEARCH_FULLTEXT,
                refs=self.REFS,
                client_turn_id="client-t2",
            ),
            self.REFS,
        )

    def test_the_same_turn_is_not_asked_twice(self) -> None:
        first = self.authorizer.prepare(
            session_id="s1",
            snapshot_id="snap1",
            turn_id="t1",
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            refs=self.REFS,
        )
        self._allow(first.question_id, list(self.REFS))

        async def request_product_input(question: dict, *, turn_id: str, activity=None) -> dict:
            raise AssertionError("an already granted turn must not be asked again")

        live = SimpleNamespace(
            id="s1",
            active_product_turn_id="client-t1",
            component_for=AsyncMock(return_value=None),
            interactions=SimpleNamespace(request_product_input=request_product_input),
        )
        _challenge, disposition, decision = asyncio.run(
            authorize_sources(
                live,
                self.authorizer,
                turn_id="t1",
                snapshot_id="snap1",
                authorization_type=PRECISE_SEARCH_FULLTEXT,
                refs=self.REFS,
            )
        )
        self.assertIs(disposition, AuthorizationDisposition.AUTHORIZED)
        self.assertIsNone(decision)


class TaskConsentContract(CrossTurnGrantContract):
    def setUp(self) -> None:
        super().setUp()
        self.context = FulltextTaskContext(
            owner_id="owner",
            project_id="project",
            session_id="s1",
            workdir="/project",
            task_type=ProductTaskType.PRECISE_SEARCH,
            workspace="run",
            run_id="run-1",
        )

    def scope(self, context: FulltextTaskContext | None = None) -> dict:
        return {
            "session_id": "s1",
            "snapshot_id": "snap2",
            "turn_id": "t2",
            "authorization_type": PRECISE_SEARCH_FULLTEXT,
            "refs": self.REFS,
            "task_context": context or self.context,
        }

    def consent(self, refs: tuple[str, ...], selected: list[str]) -> FulltextAuthorization:
        challenge = self.authorizer.prepare(
            session_id="s1",
            snapshot_id="snap1",
            turn_id="t1",
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            refs=refs,
            task_context=self.context,
        )
        self._allow(challenge.question_id, selected)
        return challenge

    def test_resume_and_restart_keep_partial_consent_without_asking(self) -> None:
        challenge = self.consent(self.REFS, ["paper:p2"])
        self.authorizer = FulltextAuthorizer(self.authorizer._database, self.authorizer._catalog)
        scope = self.authorizer.effective_scope(**self.scope())
        self.assertEqual(scope.allowed, ("paper:p2",))
        self.assertEqual(scope.denied, ("paper:p1",))
        self.assertEqual(scope.unknown, ())
        live = SimpleNamespace(id="s1", active_product_turn_id="client-t2")
        returned, disposition, decision = asyncio.run(
            authorize_sources(
                live,
                self.authorizer,
                **{key: value for key, value in self.scope().items() if key != "session_id"},
            )
        )
        self.assertEqual(returned.question_id, challenge.question_id)
        self.assertIs(disposition, AuthorizationDisposition.AUTHORIZED)
        self.assertIsNone(decision)

    def test_expansion_only_asks_new_refs_and_preserves_previous_grant(self) -> None:
        original = self.consent(self.REFS, ["paper:p2"])
        asked = []

        async def request(
            question: dict, *, turn_id: str, activity: ActivityLease | None = None
        ) -> dict:
            asked.append(question)
            return self._allow(question["id"], ["paper:p4"])

        live = SimpleNamespace(
            id="s1",
            active_product_turn_id="client-t2",
            component_for=AsyncMock(return_value=None),
            interactions=SimpleNamespace(request_product_input=request),
        )
        scope = self.scope()
        scope["refs"] = (*self.REFS, "paper:p4")
        challenge, disposition, _decision = asyncio.run(
            authorize_sources(
                live,
                self.authorizer,
                **{key: value for key, value in scope.items() if key != "session_id"},
            )
        )
        self.assertEqual(challenge.refs, ("paper:p4",))
        self.assertEqual(len(asked), 1)
        self.assertIs(disposition, AuthorizationDisposition.AUTHORIZED)
        self.assertEqual(self.authorizer.effective_scope(**scope).allowed, ("paper:p2", "paper:p4"))
        self.assertTrue(self.authorizer.granted(original))

    def test_task_boundaries_and_same_turn_dedup_do_not_transfer_consent(self) -> None:
        original = self.consent(self.REFS, list(self.REFS))
        for changes in (
            {"owner_id": "other"},
            {"project_id": "other"},
            {"workdir": "/other"},
            {"workspace": "other"},
            {"run_id": "other"},
        ):
            with self.subTest(changes=changes):
                context = replace(self.context, **changes)
                self.assertEqual(self.authorizer.effective_scope(**self.scope(context)).allowed, ())
                challenge = self.authorizer.prepare(
                    session_id="s1",
                    snapshot_id="snap1",
                    turn_id="t1",
                    authorization_type=PRECISE_SEARCH_FULLTEXT,
                    refs=self.REFS,
                    task_context=context,
                )
                self.assertNotEqual(original.question_id, challenge.question_id)
                self.assertNotEqual(original.scope_digest, challenge.scope_digest)
        with self.assertRaises(ValueError):
            self.authorizer.effective_scope(**self.scope(replace(self.context, session_id="other")))

    def test_legacy_consent_does_not_become_task_consent(self) -> None:
        original = self.authorizer.prepare(
            session_id="s1",
            snapshot_id="snap1",
            turn_id="t1",
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            refs=self.REFS,
        )
        self._allow(original.question_id, list(self.REFS))
        self.assertEqual(self.authorizer.effective_scope(**self.scope()).allowed, ())

    def test_task_context_still_requires_identity_and_run_fields(self) -> None:
        for field in ("owner_id", "session_id", "workdir", "workspace", "run_id"):
            with self.subTest(field=field):
                with self.assertRaisesRegex(ValueError, "fulltext_authorization_task_mismatch"):
                    self.authorizer.effective_scope(
                        **self.scope(replace(self.context, **{field: ""}))
                    )

    def test_denied_expansion_does_not_remove_existing_allowed_papers(self) -> None:
        self.consent(self.REFS, ["paper:p2"])

        async def request(
            question: dict, *, turn_id: str, activity: ActivityLease | None = None
        ) -> dict:
            decision = {"answers": {question["id"]: REJECT}}
            self.answers[question["id"]] = decision
            return decision

        live = SimpleNamespace(
            id="s1",
            active_product_turn_id="client-t2",
            component_for=AsyncMock(return_value=None),
            interactions=SimpleNamespace(request_product_input=request),
        )
        scope = self.scope()
        scope["refs"] = (*self.REFS, "paper:p4")
        challenge, disposition, _decision = asyncio.run(
            authorize_sources(
                live,
                self.authorizer,
                **{key: value for key, value in scope.items() if key != "session_id"},
            )
        )
        self.assertEqual(challenge.refs, ("paper:p4",))
        self.assertIs(disposition, AuthorizationDisposition.AUTHORIZED)
        self.assertEqual(self.authorizer.effective_scope(**scope).allowed, ("paper:p2",))

    def test_ten_papers_share_one_consent_and_remain_readable_after_resume(self) -> None:
        refs = tuple(f"paper:p{index}" for index in range(10))
        challenge = self.consent(refs, list(refs))
        for ref in refs:
            self.authorizer.require(
                session_id="s1",
                snapshot_id="snap2",
                turn_id="t2",
                authorization_type=PRECISE_SEARCH_FULLTEXT,
                ref_id=ref,
                task_context=self.context,
            )
        reused = self.authorizer.prepare(
            session_id="s1",
            snapshot_id="snap2",
            turn_id="t2",
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            refs=refs,
            task_context=self.context,
        )
        self.assertEqual(reused.authorization_id, challenge.authorization_id)


class GlobalTaskConsentContract(TaskConsentContract):
    def setUp(self) -> None:
        super().setUp()
        self.context = replace(self.context, project_id="")


if __name__ == "__main__":
    unittest.main()
