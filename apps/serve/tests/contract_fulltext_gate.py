"""Product full-text gate contract: candidate files pause, ask and resume (not acceptance)."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from service.assistant.service.authorization import (
    AUTHORIZATION_REQUIRED,
    LITERATURE_REVIEW_FULLTEXT,
    PRECISE_SEARCH_FULLTEXT,
    RESEARCH_IDEA_FULLTEXT,
    FulltextAuthorizer,
)
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.runtime.interaction import SessionInteractions
from service.literature.api.gate import CONTINUATION_PLAN, CONTINUATION_REJECTED, FulltextGate
from service.literature.service.checkpoint import (
    active_policies,
    discover_triggers,
    read_checkpoint,
)
from service.literature.service.result import AGENTIC_SEARCH_ORIGIN, SEARCH_CARD
from service.literature.service.review import CORPUS, METADATA, QUERY, RETRIEVAL
from service.platform.context import ProductTaskType

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
        self, session_id: str, body: dict[str, Any], *, side: bool
    ) -> tuple[dict[str, Any], int]:
        self.posts.append({"session_id": session_id, "body": body, "side": side})
        return {"ok": True}, 202


class FulltextGateContract(unittest.TestCase):
    def setUp(self) -> None:
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
            runtime_id="codex",
            runtime_workdir=self.root,
            catalog=self.catalog,
            last_submission_id="client-turn-1",
            ledger=SimpleNamespace(active_turn_id="native-turn-1", wait_terminal=wait_terminal),
            active_assistant_snapshot_id="snapshot-1",
            active_task_type=task_type,
            active_assistant_revision=None,
            active_turn_started_at=time.time() - PAST_SECONDS / 2,
            running=running,
            interrupting=False,
            terminating=False,
            terminated=False,
            current_task=None,
            publish=publish,
            publish_artifact=publish_artifact,
            display_card=display_card,
            events=events,
            cards=cards,
            interrupts=interrupts,
        )

        async def interrupt() -> None:
            interrupts.append(True)
            live.running = False

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

    # Discovery and validation.

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
        self.assertTrue(precise.content.refs[-1].startswith("artifact:"))
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
        live = self.live("")
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns)
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

        async def wait_terminal(_turn_id: str) -> str:
            terminal_waiting.set()
            await release_terminal.wait()
            # This is the old turn's terminal cleanup. A newly-created authorization
            # would be expired here and reproduce Aone 87043686.
            self.catalog.expire_pending_hil(SESSION_ID)
            return "interrupted"

        live.ledger.wait_terminal = wait_terminal
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns, poll_seconds=0)

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

    def test_rejected_stopping_task_does_not_resume_and_is_gated_again_next_turn(self) -> None:
        self.review_selection()
        self.start_fulltext()
        live = self.live("literature_review")
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns)
        asked = self.run_gate(gate, live, REJECT)
        self.assertEqual(asked[0]["header"], "综述检索授权")
        self.assertEqual(turns.posts, [])
        self.run_gate(gate, live, None)
        self.assertEqual(len(self.catalog.turn_hil(SESSION_ID, "native-turn-1")), 1)
        live.last_submission_id = "client-turn-2"
        live.ledger.active_turn_id = "native-turn-2"
        live.running = True
        live.active_turn_started_at = time.time()
        asked = self.run_gate(gate, live, REJECT)
        self.assertEqual(asked[0]["header"], "综述检索授权")
        self.assertEqual(len(live.interrupts), 2)

    def test_checkpoint_owned_candidates_wait_without_interrupting(self) -> None:
        self.precise_selection()
        self.agentic_metadata()
        precise = self.live("precise_search")
        idea = self.live("research_idea")
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns, poll_seconds=0)
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
        self.run_gate(FulltextGate(self.authorizer, turns), live, None)
        self.assertEqual(live.interrupts, [])
        self.assertEqual(self.catalog.pending_hil(SESSION_ID), ())

    def test_review_waiting_on_its_checkpoint_is_not_interrupted(self) -> None:
        selection = self.review_selection()
        live = self.live("literature_review")
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns, poll_seconds=0)
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
        gate = FulltextGate(self.authorizer, turns, poll_seconds=POLL_SECONDS)

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

        async def interrupt() -> None:
            live.interrupts.append(True)
            live.running = False
            live.active_assistant_revision = None

        live.interrupt = interrupt
        turns = RecordingTurns()
        self.run_gate(FulltextGate(self.authorizer, turns, poll_seconds=0), live, AUTHORIZE)
        (post,) = turns.posts
        self.assertEqual(post["body"]["assistant_context_revision"], 1)

    def test_scope_already_asked_in_this_turn_is_not_asked_again(self) -> None:
        self.review_selection()
        self.start_fulltext()
        live = self.live("literature_review")
        (found,) = discover_triggers(self.root, "literature_review")
        refs = read_checkpoint(self.root, *found).content.refs
        # A blocking bridge checkpoint has already challenged this exact set.
        self.authorizer.prepare(
            session_id=SESSION_ID,
            snapshot_id="snapshot-1",
            turn_id="bridge-turn",
            authorization_type=LITERATURE_REVIEW_FULLTEXT,
            refs=refs,
        )
        turns = RecordingTurns()
        self.run_gate(FulltextGate(self.authorizer, turns, poll_seconds=0), live, None)
        self.assertEqual(live.interrupts, [])
        self.assertEqual(self.catalog.pending_hil(SESSION_ID), ())

    def test_cancelled_question_neither_grants_nor_resumes(self) -> None:
        self.precise_selection()
        self.start_download()
        live = self.live("precise_search")
        turns = RecordingTurns()
        gate = FulltextGate(self.authorizer, turns)

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


if __name__ == "__main__":
    unittest.main()
