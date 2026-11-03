"""Hierarchical plan identity, transaction and replay contracts."""

from __future__ import annotations

import asyncio
import logging
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.capabilities.service.skills import SkillCatalog
from service.chat.api.plan import register_plan_routes
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.evidence import SessionTrace
from service.chat.runtime.live import LiveSession
from service.chat.service.plan import (
    PlanConflict,
    PlanExecutionError,
    SessionPlans,
    progress_transitions,
)
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    PLAN_MAX_ITEMS,
    PLAN_ROUTE_PREFIX,
    PlanAction,
    PlanStructure,
    PlanWrite,
)
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)
from tests.contract_session_catalog import register_session

SESSION = "plan-session"
THREAD = "plan-thread"


def item(identity: str, parent: str | None = None, status: str = "pending") -> dict:
    return {"id": identity, "content": identity, "parent_id": parent, "status": status}


class PlanContract(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.database = Path(temporary.name).resolve() / "sessions.sqlite3"
        self.catalog = SessionCatalogStore(self.database)
        register_session(self.catalog, SESSION, THREAD)
        self.events = ProductEventStore(self.database)
        self.plans = SessionPlans(SESSION, self.events, self.catalog)

    def command(self, **changes) -> PlanWrite:
        data = {
            "operation": "create",
            "plan_id": "review",
            "expected_revision": 0,
            "request_id": "request-1",
            "turn_id": "turn-1",
            "items": [item("root")],
        }
        return PlanWrite.model_validate({**data, **changes})

    def write(self, command: PlanWrite, require_turn=lambda: None):
        return self.plans.write(
            command, runtime_id="codex", vendor_thread_id=THREAD, require_turn=require_turn
        )

    def test_refinement_keeps_roots_and_restores_exact_tree(self) -> None:
        roots = [item(f"stage-{i}") for i in range(8)]
        self.write(self.command(items=roots))
        tree = roots + [item(f"child-{i}", "stage-0") for i in range(17)]
        event = self.write(
            self.command(operation="update", expected_revision=1, request_id="refine", items=tree)
        )
        reopened = SessionPlans(
            SESSION, ProductEventStore(self.database), SessionCatalogStore(self.database)
        )
        self.assertEqual(reopened.current()["items"], tree)
        self.assertEqual(len([i for i in reopened.current()["items"] if i["parent_id"] is None]), 8)
        self.assertEqual(self.catalog.todos(SESSION), tuple(tree))
        self.assertEqual(self.catalog.get(SESSION).todo_product_seq, event.product_seq)
        with self.assertRaisesRegex(PlanConflict, "roots_locked"):
            self.write(
                self.command(
                    operation="update",
                    expected_revision=2,
                    request_id="bad",
                    items=tree + [item("new-root")],
                )
            )
        with self.assertRaisesRegex(ValueError, "reason_required"):
            self.write(self.command(operation="revise", expected_revision=2, request_id="revise"))
        self.write(
            self.command(
                operation="revise",
                expected_revision=2,
                request_id="revise",
                reason="User changed task scope",
                items=[item("new-root")],
            )
        )

    def test_structure_cannot_write_execution_status_and_actions_preserve_timing(self):
        metadata = self.command().model_dump(exclude={"operation", "items"})
        nodes = [
            {"id": "root", "content": "root", "kind": "group"},
            {"id": "leaf", "content": "leaf", "parent_id": "root"},
        ]
        self.write(
            PlanStructure.model_validate({**metadata, "operation": "create", "items": nodes})
        )
        with self.assertRaises(ValueError):
            PlanStructure.model_validate(
                {**metadata, "operation": "update", "items": [{**nodes[1], "status": "completed"}]}
            )
        with self.assertRaisesRegex(PlanExecutionError, "start_required"):
            self.write(
                PlanAction.model_validate(
                    {
                        **metadata,
                        "expected_revision": 1,
                        "request_id": "finish-pending",
                        "action": "finish",
                        "step_ids": ["leaf"],
                    }
                )
            )
        self.write(
            PlanAction.model_validate(
                {
                    **metadata,
                    "expected_revision": 1,
                    "request_id": "start",
                    "action": "start",
                    "step_ids": ["root", "leaf"],
                }
            )
        )
        refined = self.write(
            PlanStructure.model_validate(
                {
                    **metadata,
                    "expected_revision": 2,
                    "request_id": "refine",
                    "operation": "update",
                    "items": [nodes[0], {**nodes[1], "content": "renamed"}],
                }
            )
        )
        self.assertEqual(refined.payload["items"][1]["status"], "in_progress")
        self.assertEqual(refined.payload["plan"]["started_ids"], ["leaf"])
        finished = self.write(
            PlanAction.model_validate(
                {
                    **metadata,
                    "expected_revision": 3,
                    "request_id": "finish",
                    "action": "finish",
                    "step_ids": ["root", "leaf"],
                }
            )
        )
        self.assertTrue(all(row["status"] == "completed" for row in finished.payload["items"]))

    def test_structure_refinement_does_not_start_new_pending_work(self):
        metadata = self.command().model_dump(exclude={"operation", "items"})
        self.write(
            PlanStructure.model_validate(
                {
                    **metadata,
                    "operation": "create",
                    "items": [{"id": "root", "content": "root", "kind": "group"}],
                }
            )
        )
        result = self.write(
            PlanStructure.model_validate(
                {
                    **metadata,
                    "expected_revision": 1,
                    "request_id": "refine",
                    "operation": "update",
                    "items": [
                        {"id": "root", "content": "root", "kind": "group"},
                        {"id": "child", "content": "child", "parent_id": "root"},
                    ],
                }
            )
        )
        self.assertEqual(result.payload["items"][1]["status"], "pending")
        self.assertEqual(result.payload["plan"]["started_ids"], [])

    def test_execution_actions_pause_resume_and_replay_share_the_existing_transaction(self):
        metadata = self.command().model_dump(exclude={"operation", "items"})
        self.write(
            PlanStructure.model_validate(
                {**metadata, "operation": "create", "items": [{"id": "root", "content": "root"}]}
            )
        )
        start = PlanAction.model_validate(
            {
                **metadata,
                "expected_revision": 1,
                "request_id": "start",
                "action": "start",
                "step_ids": ["root"],
            }
        )
        started = self.write(start)
        self.write(
            PlanAction.model_validate(
                {
                    **metadata,
                    "expected_revision": 2,
                    "request_id": "pause",
                    "action": "pause",
                    "step_ids": ["root"],
                }
            )
        )
        with self.assertRaisesRegex(PlanExecutionError, "start_required"):
            self.write(
                PlanAction.model_validate(
                    {
                        **metadata,
                        "expected_revision": 3,
                        "request_id": "finish-waiting",
                        "action": "finish",
                        "step_ids": ["root"],
                    }
                )
            )
        self.write(
            PlanAction.model_validate(
                {
                    **metadata,
                    "expected_revision": 3,
                    "request_id": "resume",
                    "action": "start",
                    "step_ids": ["root"],
                }
            )
        )
        self.write(
            PlanAction.model_validate(
                {
                    **metadata,
                    "expected_revision": 4,
                    "request_id": "finish",
                    "action": "finish",
                    "step_ids": ["root"],
                }
            )
        )
        self.assertEqual(self.write(start).product_seq, started.product_seq)
        self.assertEqual(self.plans.current()["plan"]["revision"], 5)
        self.assertEqual(self.plans.current()["items"][0]["status"], "completed")

    def test_invalid_trees_and_oversized_request_are_rejected(self) -> None:
        for tree, error in [
            ([item("x"), item("x")], "duplicate"),
            ([item("x", "missing")], "parent_missing"),
            ([item("x", "y"), item("y", "x")], "cycle"),
            ([item("x", status="completed"), item("y", "x")], "unfinished_child"),
        ]:
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                self.write(self.command(items=tree))
        with self.assertRaises(ValueError):
            self.command(items=[item(str(i)) for i in range(PLAN_MAX_ITEMS + 1)])
        self.assertEqual(self.plans.current()["items"], [])

    def test_partial_and_blocked_are_durable_stage_facts(self) -> None:
        stages = [
            item("retrieval", status="partial"),
            item("processing", status="blocked"),
            item("outline"),
            item("generation"),
            item("verification"),
        ]
        self.write(self.command(items=[{**row, "status": "in_progress"} for row in stages]))
        self.write(
            self.command(
                operation="update", expected_revision=1, request_id="partial", items=stages
            )
        )
        self.assertEqual(
            [row["status"] for row in self.plans.current()["items"]],
            ["partial", "blocked", "pending", "pending", "pending"],
        )

    def test_concurrent_revision_and_idempotent_retry(self) -> None:
        self.write(self.command())
        first = self.command(operation="update", expected_revision=1, request_id="first")
        second = self.command(operation="update", expected_revision=1, request_id="second")

        def attempt(command):
            try:
                return self.write(command)
            except PlanConflict:
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, [first, second]))
        self.assertEqual(sum(result is not None for result in results), 1)
        winner = first if results[0] else second
        original = next(result for result in results if result)
        self.assertEqual(self.write(winner), original)
        with self.assertRaisesRegex(PlanConflict, "request_id_reused"):
            self.write(winner.model_copy(update={"reason": "different"}))

    def action(self, action, step_ids, *, revision, request_id, **fields):
        return PlanAction.model_validate(
            {
                "plan_id": "review",
                "expected_revision": revision,
                "request_id": request_id,
                "turn_id": "turn-1",
                "action": action,
                "step_ids": step_ids,
                **fields,
            }
        )

    def test_action_preserves_tree_and_retries_original_mutation_after_later_writes(self):
        tree = [
            {**item("root", status="in_progress"), "kind": "group"},
            item("one", "root"),
            item("two", "root"),
            {**item("later"), "kind": "group"},
        ]
        self.write(self.command(items=tree))
        start = self.action("start", ["one"], revision=1, request_id="start")
        started = self.write(start)
        self.assertEqual(
            started.payload["items"],
            [{**row, "status": "in_progress"} if row["id"] == "one" else row for row in tree],
        )
        self.write(self.action("pause", ["one"], revision=2, request_id="wait"))
        before = self.plans.current()
        with self.assertRaisesRegex(PlanExecutionError, "start_required"):
            self.write(self.action("finish", ["one"], revision=3, request_id="skip-resume"))
        self.assertEqual(self.plans.current(), before)
        self.write(self.action("start", ["one"], revision=3, request_id="resume"))
        self.write(self.action("finish", ["one"], revision=4, request_id="finish-one"))
        self.write(self.action("start", ["two"], revision=5, request_id="start-two"))
        self.assertEqual(self.write(start), started)
        self.assertEqual(self.plans.current()["plan"]["revision"], 6)
        self.assertEqual(self.plans.current()["plan"]["started_ids"], ["one", "two"])
        with self.assertRaisesRegex(PlanConflict, "request_id_reused"):
            self.write(start.model_copy(update={"reason": "changed"}))

    def test_action_rejections_are_atomic_and_do_not_rewrite_identity(self):
        with self.assertRaisesRegex(PlanConflict, "identity_conflict"):
            self.write(self.action("start", ["missing"], revision=0, request_id="no-plan"))
        self.write(self.command(items=[item("root", status="in_progress"), item("later")]))
        before = self.plans.current()
        for action, step_ids, error in (
            ("start", ["missing"], "step_unknown"),
            ("finish", ["root", "later"], "start_required"),
            ("finish", ["root", "root"], "duplicate_id"),
        ):
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                self.write(self.action(action, step_ids, revision=1, request_id=error))
            self.assertEqual(self.plans.current(), before)
            self.assertEqual(list(self.catalog.todos(SESSION)), before["items"])
        with self.assertRaisesRegex(PlanConflict, "revision_conflict"):
            self.write(self.action("finish", ["root"], revision=0, request_id="stale"))
        with self.assertRaises(ValueError):
            self.action(
                "finish",
                ["root"],
                revision=1,
                request_id="rename",
                content="rename",
            )

    def test_leaf_completion_requires_a_start_and_rejection_is_atomic(self) -> None:
        tree = [item("root", status="in_progress"), item("child", "root")]
        self.write(self.command(items=tree))
        completed = [dict(row, status="completed") for row in tree]
        before = self.plans.current()
        with self.assertRaisesRegex(PlanExecutionError, "plan_step_start_required"):
            self.write(
                self.command(
                    operation="update", expected_revision=1, request_id="bad", items=completed
                )
            )
        self.assertEqual(self.plans.current(), before)
        self.assertEqual(list(self.catalog.todos(SESSION)), tree)
        started = [dict(row, status="in_progress") for row in tree]
        self.write(
            self.command(operation="update", expected_revision=1, request_id="start", items=started)
        )
        event = self.write(
            self.command(
                operation="update", expected_revision=2, request_id="done", items=completed
            )
        )
        self.assertEqual(event.payload["plan"]["started_ids"], ["child"])
        self.assertEqual(self.plans.current()["plan"]["timing_policy"], "leaf-execution-v1")

    def test_new_completed_leaf_cannot_be_created_or_refined_after_start(self) -> None:
        with self.assertRaisesRegex(PlanExecutionError, "plan_step_start_required"):
            self.write(self.command(items=[item("root", status="completed")]))
        self.write(self.command(items=[item("root", status="in_progress")]))
        for tree in ([item("other")], [item("root", status="in_progress"), item("child", "root")]):
            with (
                self.subTest(tree=tree),
                self.assertRaisesRegex(PlanExecutionError, "identity_locked"),
            ):
                self.write(
                    self.command(
                        operation="revise",
                        expected_revision=1,
                        request_id="refine",
                        reason="refine",
                        items=tree,
                    )
                )

    def test_parallel_leaf_identity_survives_rename_pause_and_store_reopen(self) -> None:
        tree = [
            item("root", status="in_progress"),
            item("one", "root", "in_progress"),
            item("two", "root", "in_progress"),
        ]
        self.write(self.command(items=tree))
        paused = [dict(row, status="blocked") if row["id"] == "one" else row for row in tree]
        self.write(
            self.command(operation="update", expected_revision=1, request_id="pause", items=paused)
        )
        self.plans = SessionPlans(
            SESSION, ProductEventStore(self.database), SessionCatalogStore(self.database)
        )
        renamed = [dict(row, content="renamed") if row["id"] == "one" else row for row in tree]
        self.write(
            self.command(
                operation="update", expected_revision=2, request_id="resume", items=renamed
            )
        )
        completed = [dict(row, status="completed") for row in renamed]
        self.write(
            self.command(
                operation="update", expected_revision=3, request_id="done", items=completed
            )
        )
        self.assertEqual(self.plans.current()["plan"]["started_ids"], ["one", "two"])

    def test_explicit_container_refines_after_start_without_its_own_clock(self) -> None:
        group = {**item("root", status="in_progress"), "kind": "group"}
        self.write(self.command(items=[group]))
        self.assertEqual(self.plans.current()["plan"]["started_ids"], [])
        tree = [group, item("child", "root", "in_progress")]
        self.write(
            self.command(operation="update", expected_revision=1, request_id="child", items=tree)
        )
        self.write(
            self.command(
                operation="update",
                expected_revision=2,
                request_id="done",
                items=[dict(row, status="completed") for row in tree],
            )
        )
        self.assertEqual(self.plans.current()["plan"]["started_ids"], ["child"])
        with self.assertRaisesRegex(PlanExecutionError, "identity_locked"):
            self.write(
                self.command(
                    operation="revise",
                    expected_revision=3,
                    request_id="erase",
                    reason="remove children",
                    items=[item("root", status="completed")],
                )
            )

    def test_empty_group_cannot_complete_or_turn_into_a_leaf(self) -> None:
        group = {**item("root", status="in_progress"), "kind": "group"}
        self.write(self.command(items=[group]))
        with self.assertRaisesRegex(ValueError, "group_requires_children"):
            self.write(
                self.command(
                    operation="update",
                    expected_revision=1,
                    request_id="empty",
                    items=[dict(group, status="completed")],
                )
            )
        with self.assertRaisesRegex(PlanExecutionError, "identity_locked"):
            self.write(
                self.command(
                    operation="update",
                    expected_revision=1,
                    request_id="convert",
                    items=[item("root", status="completed")],
                )
            )

    def test_atomic_rollback_and_inactive_turn(self) -> None:
        self.write(self.command())
        before = self.plans.current()
        update = self.command(operation="update", expected_revision=1, request_id="update")
        with patch.object(self.catalog, "save_todos", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                self.write(update)
        self.assertEqual(self.plans.current(), before)
        self.assertEqual(list(self.catalog.todos(SESSION)), before["items"])

        def stopped():
            raise PermissionError("plan_turn_inactive")

        with self.assertRaises(PermissionError):
            self.write(update, stopped)
        self.assertEqual(self.plans.current(), before)
        resumed = update.model_copy(update={"turn_id": "turn-2"})
        self.write(resumed)
        self.assertEqual(self.catalog.get(SESSION).todo_turn_id, "turn-2")

    def test_native_events_cannot_overwrite_declared_tree(self) -> None:
        native_items = [{"content": "native", "status": "pending"}]
        self.assertEqual(progress_transitions(native_items, {"items": native_items}), {})
        kwargs = dict(
            runtime_id="codex",
            vendor_thread_id=THREAD,
            turn_id="turn-1",
            item_id="",
            explanation=None,
        )
        native = self.plans.native(
            [{"content": "native", "status": "pending"}], key="native-1", **kwargs
        )
        self.assertIsNotNone(native)
        self.write(self.command())
        before = self.plans.current()
        ignored = self.plans.native(
            [{"content": "expanded", "status": "pending"}], key="native-2", **kwargs
        )
        self.assertIsNone(ignored)
        self.assertEqual(self.plans.current(), before)
        self.assertEqual(list(self.catalog.todos(SESSION)), before["items"])

    def test_release_preserves_history_and_permits_new_native_task(self) -> None:
        self.write(self.command())
        released = self.write(
            self.command(
                operation="release",
                expected_revision=1,
                request_id="release",
                turn_id="turn-2",
                reason="New simple task",
            )
        )
        self.assertEqual(released.vendor_turn_id, "turn-1")
        self.assertEqual(self.catalog.get(SESSION).todo_turn_id, "turn-1")
        native = self.plans.native(
            [{"content": "new task", "status": "in_progress"}],
            runtime_id="codex",
            vendor_thread_id=THREAD,
            turn_id="turn-2",
            item_id="",
            key="new-native",
            explanation=None,
        )
        self.assertIsNotNone(native)
        self.assertEqual(self.catalog.todos(SESSION)[0]["content"], "new task")

    def live(self):
        trace = SessionTrace(
            SESSION,
            self.database.parent,
            runtime_id="codex",
            trace_dir=self.database.parent / "trace",
        )
        self.addCleanup(trace.close)
        live = LiveSession(
            session_id=SESSION,
            runtime_id="codex",
            runtime_workdir=self.database.parent,
            project_path=None,
            output_root=self.database.parent / "outputs",
            model_id="contract",
            catalog=self.catalog,
            events=self.events,
            artifacts=SessionArtifactStore(self.database),
            skills=SkillCatalog(
                bundled_root=self.database.parent / "bundled",
                user_root=self.database.parent / "user",
            ),
            logger=logging.getLogger("plan-contract"),
            trace=trace,
        )
        live.vendor_thread_id = THREAD
        asyncio.run(live.ledger.activate_turn("turn-1"))
        return live

    def test_live_lock_wait_rechecks_stop_lifecycle(self) -> None:
        live = self.live()

        async def race():
            await live._projection_lock.acquire()
            waiting = asyncio.create_task(live.write_plan(self.command()))
            await asyncio.sleep(0)
            live.interrupting = True
            live._projection_lock.release()
            with self.assertRaisesRegex(PermissionError, "turn_inactive"):
                await waiting

        asyncio.run(race())
        self.assertEqual(self.plans.current()["items"], [])
        self.assertEqual(self.catalog.todos(SESSION), ())

    def test_bridge_authentication_revision_and_turn_binding(self) -> None:
        live = self.live()
        sessions = SimpleNamespace(bridge_caller=lambda sid: live if sid == SESSION else None)
        app = FastAPI()
        activities = Activities()
        self.activities = activities
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_plan_routes(app, sessions, activities=activities)
        headers = {BRIDGE_SESSION_HEADER: SESSION, BRIDGE_TOKEN_HEADER: live.bridge_token}
        with TestClient(app) as client:
            self.assertEqual(client.post(PLAN_ROUTE_PREFIX + "get", json={}).status_code, 403)
            response = client.post(PLAN_ROUTE_PREFIX + "get", json={}, headers=headers)
            self.assertEqual(response.json()["turn_id"], "turn-1")
            response = client.post(
                PLAN_ROUTE_PREFIX + "write", json=self.command().model_dump(), headers=headers
            )
            self.assertEqual(response.status_code, 200, response.text)
            stale = self.command(operation="update", request_id="stale").model_dump()
            self.assertEqual(
                client.post(PLAN_ROUTE_PREFIX + "write", json=stale, headers=headers).status_code,
                409,
            )
            metadata = self.command().model_dump(exclude={"operation", "items"})
            rejected = client.post(
                PLAN_ROUTE_PREFIX + "action",
                headers=headers,
                json={
                    **metadata,
                    "expected_revision": 1,
                    "request_id": "finish-pending",
                    "action": "finish",
                    "step_ids": ["root"],
                },
            )
            self.assertEqual(rejected.status_code, 400)
            self.assertNotIn("finish", rejected.json()["current"]["actions"]["root"])
            started = client.post(
                PLAN_ROUTE_PREFIX + "action",
                headers=headers,
                json={
                    **metadata,
                    "expected_revision": 1,
                    "request_id": "start-action",
                    "action": "start",
                    "step_ids": ["root"],
                },
            )
            self.assertEqual(started.status_code, 200, started.text)
            self.assertIn("finish", started.json()["actions"]["root"])
            refined = client.post(
                PLAN_ROUTE_PREFIX + "structure",
                headers=headers,
                json={
                    **metadata,
                    "expected_revision": 2,
                    "request_id": "structure-action",
                    "operation": "update",
                    "items": [{"id": "root", "content": "root"}],
                },
            )
            self.assertEqual(refined.status_code, 200, refined.text)
            self.assertEqual(refined.json()["items"][0]["status"], "in_progress")
            finished = client.post(
                PLAN_ROUTE_PREFIX + "action",
                headers=headers,
                json={
                    **metadata,
                    "expected_revision": 3,
                    "request_id": "finish-action",
                    "action": "finish",
                    "step_ids": ["root"],
                },
            )
            self.assertEqual(finished.status_code, 200, finished.text)
            self.assertEqual(finished.json()["items"][0]["status"], "completed")
            wrong_turn = self.command(
                operation="update", expected_revision=1, request_id="late", turn_id="old"
            ).model_dump()
            self.assertEqual(
                client.post(
                    PLAN_ROUTE_PREFIX + "write", json=wrong_turn, headers=headers
                ).status_code,
                403,
            )
            live.terminating = True
            current = self.command(
                operation="update", expected_revision=1, request_id="stopping"
            ).model_dump()
            self.assertEqual(
                client.post(PLAN_ROUTE_PREFIX + "write", json=current, headers=headers).status_code,
                403,
            )

    def test_rejected_writes_return_current_state_for_corrected_snapshot(self) -> None:
        live = self.live()
        sessions = SimpleNamespace(bridge_caller=lambda sid: live if sid == SESSION else None)
        app = FastAPI()
        activities = Activities()
        self.activities = activities
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_plan_routes(app, sessions, activities=activities)
        headers = {BRIDGE_SESSION_HEADER: SESSION, BRIDGE_TOKEN_HEADER: live.bridge_token}
        tree = [item("root", status="in_progress"), item("later")]
        with TestClient(app) as client:
            created = client.post(
                PLAN_ROUTE_PREFIX + "write",
                json=self.command(items=tree).model_dump(),
                headers=headers,
            ).json()
            for rejected, code, error in (
                ([tree[0]], 409, "plan_roots_locked_use_revise"),
                (tree + [item("child", "root")], 400, "plan_started_step_identity_locked"),
                ([tree[0], item("later", status="completed")], 400, "plan_step_start_required"),
            ):
                with self.subTest(error=error):
                    response = client.post(
                        PLAN_ROUTE_PREFIX + "write",
                        json=self.command(
                            operation="update",
                            expected_revision=1,
                            request_id=error,
                            items=rejected,
                        ).model_dump(),
                        headers=headers,
                    )
                    self.assertEqual(response.status_code, code)
                    payload = response.json()
                    self.assertEqual(payload["error"], error)
                    self.assertEqual(payload["current"]["items"], created["items"])
                    self.assertEqual(payload["current"]["plan"], created["plan"])
                    self.assertEqual(payload["current"]["turn_id"], "turn-1")
                    self.assertNotIn("completed", payload["current"]["transitions"]["later"])
                    self.assertIn("completed", payload["current"]["transitions"]["root"])
                    self.assertIn("plan/get", payload["next_action"])
                    self.assertEqual(live.plans.current()["plan"]["revision"], 1)
            corrected = client.post(
                PLAN_ROUTE_PREFIX + "write",
                json=self.command(
                    operation="update",
                    expected_revision=1,
                    request_id="corrected",
                    items=[item("root", status="completed"), item("later", status="in_progress")],
                ).model_dump(),
                headers=headers,
            )
            self.assertEqual(corrected.status_code, 200, corrected.text)
            self.assertEqual(corrected.json()["plan"]["revision"], 2)
            done = client.post(
                PLAN_ROUTE_PREFIX + "action",
                json=self.action("finish", ["later"], revision=2, request_id="done").model_dump(),
                headers=headers,
            )
            self.assertEqual(done.status_code, 200, done.text)
            self.assertEqual(done.json()["plan"]["revision"], 3)
            self.assertTrue(all(row["status"] == "completed" for row in done.json()["items"]))


if __name__ == "__main__":
    unittest.main()
