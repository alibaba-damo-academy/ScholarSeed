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
from service.chat.service.plan import PlanConflict, SessionPlans
from service.platform.bridge import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    PLAN_MAX_ITEMS,
    PLAN_ROUTE_PREFIX,
    PlanWrite,
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
        self.database = Path(temporary.name) / "sessions.sqlite3"
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
        self.write(self.command(items=stages))
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
        live.ledger.activate_turn("turn-1")
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
        register_plan_routes(app, sessions)
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


if __name__ == "__main__":
    unittest.main()
