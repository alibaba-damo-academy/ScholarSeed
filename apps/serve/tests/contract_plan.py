"""Hierarchical plan identity, transaction and replay contracts."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_codex.profile import session_thread_config
from service.capabilities.service.skills import SkillCatalog
from service.chat.api.contracts import register_contract_routes
from service.chat.api.plan import register_plan_routes
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.evidence import SessionTrace
from service.chat.runtime.live import LiveSession
from service.chat.runtime.tools import execute_service_tool, session_service_tools
from service.chat.service.events import EventService
from service.chat.service.plan import (
    PlanConflict,
    PlanExecutionError,
    PlanToolProjection,
    SessionPlans,
    completion_ids,
    plan_tool_receipt,
    plan_tool_recoveries,
    progress_transitions,
)
from service.chat.service.sessions import SessionService
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    CONTRACT_DESCRIBE_ROUTE,
    CONTRACT_LIST_ROUTE,
    PLAN_MAX_ITEMS,
    PLAN_ROUTE_PREFIX,
    PlanAction,
    PlanEnable,
    PlanStructure,
    PlanWrite,
)
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    INTERNAL_BASE_URL_ENV,
)
from tests.contract_session_catalog import register_session

SESSION = "plan-session"
THREAD = "plan-thread"


def item(identity: str, parent: str | None = None, status: str = "pending") -> dict:
    return {"id": identity, "content": identity, "parent_id": parent, "status": status}


class PlanContract(unittest.TestCase):
    def test_plan_estimate_is_saved_revised_and_cleared(self) -> None:
        estimate = {"lower_seconds": 600, "upper_seconds": 900}
        self.write(self.command(estimate=estimate))
        self.assertEqual(self.plans.current()["plan"]["estimate"], estimate)
        self.write(self.command(operation="update", expected_revision=1, request_id="keep"))
        self.assertEqual(self.plans.current()["plan"]["estimate"], estimate)
        self.write(
            self.command(
                operation="revise", expected_revision=2, request_id="revise", reason="Scope changed"
            )
        )
        self.assertIsNone(self.plans.current()["plan"]["estimate"])

    def test_plan_estimate_rejects_invalid_ranges(self) -> None:
        for estimate in (
            {"lower_seconds": -1, "upper_seconds": 10},
            {"lower_seconds": 20, "upper_seconds": 10},
            {"lower_seconds": True, "upper_seconds": 10},
        ):
            with self.assertRaises(ValueError):
                self.command(estimate=estimate)

    def test_plan_estimate_replays_and_distinguishes_clear_from_omission(self) -> None:
        estimate = {"lower_seconds": 600, "upper_seconds": 900}
        self.write(self.command(estimate=estimate))
        resumed = self.command(
            operation="update",
            expected_revision=1,
            request_id="resume",
            turn_id="turn-2",
            items=[item("root", status="in_progress")],
        )
        self.write(resumed)
        restored = SessionPlans(
            SESSION, ProductEventStore(self.database), SessionCatalogStore(self.database)
        )
        self.assertEqual(restored.current()["plan"]["estimate"], estimate)
        with self.assertRaisesRegex(PlanConflict, "request_id_reused"):
            self.write(resumed.model_copy(update={"estimate": None}))
        self.write(
            self.command(
                operation="update",
                expected_revision=2,
                request_id="clear",
                estimate=None,
                items=[item("root", status="in_progress")],
            )
        )
        self.assertIsNone(restored.current()["plan"]["estimate"])

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
        metadata = self.command().model_dump(exclude={"operation", "items", "estimate"})
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
        metadata = self.command().model_dump(exclude={"operation", "items", "estimate"})
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
        metadata = self.command().model_dump(exclude={"operation", "items", "estimate"})
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

    def test_verified_completion_atomically_handles_started_and_unstarted_leaves(self):
        self.write(self.command(items=[item("started"), item("unstarted")]))
        self.write(self.action("start", ["started"], revision=1, request_id="start"))
        completion = self.action(
            "complete",
            ["started", "unstarted"],
            revision=2,
            request_id="complete",
            reason="Verified both output files and their published artifact receipts.",
        )
        event = self.write(completion)
        self.assertEqual([row["status"] for row in event.payload["items"]], ["completed"] * 2)
        self.assertEqual(event.payload["plan"]["started_ids"], ["started"])
        self.assertEqual(event.payload["plan"]["reconciled_ids"], ["unstarted"])
        self.assertEqual(self.write(completion), event)
        with self.assertRaisesRegex(PlanConflict, "revision_conflict"):
            self.write(completion.model_copy(update={"request_id": "stale"}))
        reopened = SessionPlans(SESSION, self.events, self.catalog)
        self.assertEqual(reopened.current()["plan"]["started_ids"], ["started"])

    def test_plan_recovery_requires_a_newer_same_turn_receipt_covering_all_original_targets(self):
        arguments = {
            "operation": "finish",
            "plan_id": "review",
            "step_ids": ["started", "unstarted"],
        }
        state = {
            "turn_id": "turn-1",
            "plan": {"plan_id": "review", "revision": 2},
            "items": [item("started", status="in_progress"), item("unstarted")],
        }
        failure = plan_tool_receipt(
            arguments,
            {
                "ok": False,
                "error": "plan_step_start_required",
                "step_ids": ["unstarted"],
                "current": state,
            },
            "turn-1",
        )
        record = self.events.append(
            session_id=SESSION,
            runtime_id="codex",
            vendor_thread_id=THREAD,
            vendor_turn_id="turn-1",
            vendor_item_id="failed-call",
            kind="tool_completed",
            payload={"tool_id": "failed-call", "success": False, **failure},
            idempotency_key="failed-call",
        )
        completed = {
            **state,
            "ok": True,
            "plan": {"plan_id": "review", "revision": 3},
            "items": [item("started", status="completed"), item("unstarted", status="completed")],
        }
        receipt = plan_tool_receipt({**arguments, "operation": "complete"}, completed, "turn-1")
        self.assertEqual(plan_tool_recoveries(receipt, [record], "turn-1"), ["failed-call"])
        for changed in (
            {**receipt, "completed_ids": ["unstarted"]},
            {**receipt, "revision": 2},
            {**receipt, "plan_id": "other"},
        ):
            self.assertEqual(plan_tool_recoveries(changed, [record], "turn-1"), [])
        self.assertEqual(plan_tool_recoveries(receipt, [record], "other-turn"), [])
        read_receipt = plan_tool_receipt({"operation": "get"}, completed, "turn-1")
        self.assertEqual(read_receipt, {"operation": "get"})
        self.assertEqual(plan_tool_recoveries(read_receipt, [record], "turn-1"), [])
        self.assertEqual(
            plan_tool_receipt(
                arguments, {"ok": False, "error": "unknown", "current": state}, "turn-1"
            ),
            {},
        )
        self.assertEqual(plan_tool_receipt(arguments, completed, "other-turn"), {})

    def test_corrected_read_recovers_only_read_rejections_in_the_same_turn(self):
        arguments = {"operation": "get", "plan_id": "invalid-extra-field"}
        failure = plan_tool_receipt(
            arguments, {"ok": False, "error": "bridge_invalid_parameters"}, "turn-1"
        )
        self.assertIn("plan_failure", failure)
        record = self.events.append(
            session_id=SESSION,
            runtime_id="codex",
            vendor_thread_id=THREAD,
            vendor_turn_id="turn-1",
            vendor_item_id="invalid-read",
            kind="tool_completed",
            payload={"tool_id": "invalid-read", "success": False, **failure},
            idempotency_key="invalid-read",
        )
        result = {"ok": True, "turn_id": "turn-1", "items": [], "plan": None}
        receipt = plan_tool_receipt({"operation": "get"}, result, "turn-1")
        self.assertEqual(plan_tool_recoveries(receipt, [record], "turn-1"), ["invalid-read"])
        self.assertEqual(plan_tool_recoveries(receipt, [record], "other-turn"), [])
        self.assertEqual(plan_tool_receipt({"operation": "get"}, result, "other-turn"), {})
        self.assertEqual(
            plan_tool_receipt({"operation": "get"}, {"ok": True, "turn_id": "turn-1"}, "turn-1"),
            {},
        )
        self.assertEqual(
            plan_tool_recoveries(
                {"plan_id": "review", "revision": 3, "completed_ids": ["leaf"]},
                [record],
                "turn-1",
            ),
            [],
        )
        for error in ("bridge_access_denied", "plan_turn_inactive", "bridge_execution_failed"):
            self.assertEqual(
                plan_tool_receipt(arguments, {"ok": False, "error": error}, "turn-1"), {}
            )

    def test_structural_recovery_requires_the_complete_requested_tree(self):
        nodes = [{"id": "root", "content": "Original"}, {"id": "check", "content": "Verify"}]
        arguments = {"operation": "update", "plan_id": "review", "items": nodes}
        state = {
            "turn_id": "turn-1",
            "plan": {"plan_id": "review", "revision": 2, "source": "structured"},
            "items": [item("root")],
        }
        failure = plan_tool_receipt(
            arguments,
            {"ok": False, "error": "plan_roots_locked_use_revise", "current": state},
            "turn-1",
        )
        self.assertIn("plan_failure", failure)
        record = self.events.append(
            session_id=SESSION,
            runtime_id="codex",
            vendor_thread_id=THREAD,
            vendor_turn_id="turn-1",
            vendor_item_id="structure-rejected",
            kind="tool_completed",
            payload={"tool_id": "structure-rejected", "success": False, **failure},
            idempotency_key="structure-rejected",
        )
        completed = {
            "ok": True,
            "turn_id": "turn-1",
            "plan": {"plan_id": "review", "revision": 3, "source": "structured"},
            "items": [dict(node, status="pending") for node in nodes],
        }
        receipt = plan_tool_receipt({**arguments, "operation": "revise"}, completed, "turn-1")
        self.assertEqual(plan_tool_recoveries(receipt, [record], "turn-1"), ["structure-rejected"])
        for changes in (
            {"items": completed["items"][:1]},
            {"items": list(reversed(completed["items"]))},
            {"items": [dict(node, content="Changed") for node in completed["items"]]},
            {"plan": {**completed["plan"], "revision": 2}},
            {"plan": {**completed["plan"], "source": "released"}},
            {"turn_id": "other-turn"},
        ):
            changed = plan_tool_receipt(arguments, {**completed, **changes}, "turn-1")
            self.assertEqual(plan_tool_recoveries(changed, [record], "turn-1"), [])

    def test_history_reconstructs_exact_tool_recovery_without_rewriting_events(self):
        nodes = [{"id": "root", "content": "Original"}, {"id": "check", "content": "Verify"}]
        state = {
            "turn_id": "turn-1",
            "plan": {"plan_id": "review", "revision": 2, "source": "structured"},
            "items": [item("root")],
        }
        calls = [
            (
                "bad-read",
                {"operation": "get", "extra": True},
                {"ok": False, "error": "bridge_invalid_parameters"},
            ),
            ("good-read", {"operation": "get"}, {"ok": True, **state}),
            (
                "bad-structure",
                {"operation": "update", "plan_id": "review", "items": nodes},
                {"ok": False, "error": "plan_roots_locked_use_revise", "current": state},
            ),
            (
                "good-structure",
                {"operation": "revise", "plan_id": "review", "items": nodes},
                {
                    "ok": True,
                    **state,
                    "plan": {**state["plan"], "revision": 3},
                    "items": [dict(node, status="pending") for node in nodes],
                },
            ),
        ]
        rows = []
        for identity, arguments, result in calls:
            for kind, payload in (
                ("tool_started", {"input": arguments}),
                (
                    "tool_completed",
                    {
                        "success": result["ok"],
                        "output": json.dumps([{"type": "inputText", "text": json.dumps(result)}]),
                    },
                ),
            ):
                rows.append(
                    self.events.append(
                        session_id=SESSION,
                        runtime_id="codex",
                        vendor_thread_id=THREAD,
                        vendor_turn_id="turn-1",
                        vendor_item_id=identity,
                        kind=kind,
                        payload={"tool_id": identity, "name": "update_plan", **payload},
                        idempotency_key=f"{identity}:{kind}",
                    )
                )
        service = EventService({}, self.events, logging.getLogger(__name__))
        snapshot = service.activity_snapshot(SESSION)
        resolved = {
            event["data"]["tool_id"]: event["data"].get("resolved_tool_ids")
            for event in snapshot
            if event["type"] == "tool_completed"
        }
        self.assertEqual(resolved["good-read"], ["bad-read"])
        self.assertEqual(resolved["good-structure"], ["bad-structure"])

        async def resumed():
            stream = service.open(SESSION, rows[5].product_seq)
            try:
                return [json.loads((await anext(stream)).removeprefix("data: ")) for _ in range(2)]
            finally:
                await stream.aclose()

        with patch("service.chat.service.events.SSE_REPLAY_PAGE_SIZE", 1):
            replayed = asyncio.run(resumed())
        self.assertEqual(
            [event["seq"] for event in replayed], [row.product_seq for row in rows[6:]]
        )
        self.assertEqual(replayed[-1]["data"]["resolved_tool_ids"], ["bad-structure"])
        self.assertEqual(self.events.replay(SESSION), tuple(rows))
        for changes in (
            {"runtime_id": "another-runtime"},
            {"vendor_thread_id": "another-thread"},
            {"vendor_turn_id": "another-turn"},
        ):
            projection = PlanToolProjection()
            projected = [
                projection.project(
                    replace(record, **changes) if record.payload.get("success") is True else record
                )
                for record in rows
            ]
            self.assertFalse(any(record.payload.get("resolved_tool_ids") for record in projected))

        for changes in (
            {"output": "truncated{"},
            {"output": json.dumps({"ok": True, "turn_id": "turn-1"})},
            {"name": "unrelated-tool"},
        ):
            projection = PlanToolProjection()
            projected = [
                projection.project(
                    replace(record, payload={**record.payload, **changes})
                    if record.payload.get("success") is True
                    else record
                )
                for record in rows
            ]
            self.assertFalse(any(record.payload.get("resolved_tool_ids") for record in projected))

    def test_create_and_release_recovery_require_the_actual_matching_operation(self):
        nodes = [{"id": "root", "content": "Original"}]
        for operation, source in (("create", "structured"), ("release", "released")):
            arguments = {"operation": operation, "plan_id": "review", "items": nodes}
            state = {
                "turn_id": "turn-1",
                "plan": {"plan_id": "review", "revision": 2, "source": "structured"},
                "items": [dict(nodes[0], status="pending")],
            }
            failure = plan_tool_receipt(
                arguments,
                {
                    "ok": False,
                    "error": "plan_revision_conflict",
                    "current": state,
                },
                "turn-1",
            )
            record = self.events.append(
                session_id=SESSION,
                runtime_id="codex",
                vendor_thread_id=THREAD,
                vendor_turn_id="turn-1",
                vendor_item_id=operation,
                kind="tool_completed",
                payload={"tool_id": operation, "success": False, **failure},
                idempotency_key=operation,
            )
            success = {
                "ok": True,
                **state,
                "plan": {**state["plan"], "revision": 3, "source": source},
            }
            receipt = plan_tool_receipt(arguments, success, "turn-1")
            self.assertEqual(plan_tool_recoveries(receipt, [record], "turn-1"), [operation])
            other = plan_tool_receipt({**arguments, "operation": "revise"}, success, "turn-1")
            self.assertEqual(plan_tool_recoveries(other, [record], "turn-1"), [])

    def test_start_conflict_recovers_only_after_authoritative_execution_start(self):
        arguments = {"operation": "start", "plan_id": "review", "step_ids": ["runner"]}
        state = {
            "turn_id": "turn-1",
            "plan": {"plan_id": "review", "revision": 5},
            "items": [item("runner")],
        }
        failure = plan_tool_receipt(
            arguments,
            {"ok": False, "error": "plan_revision_conflict", "current": state},
            "turn-1",
        )
        self.assertIn("plan_failure", failure)
        record = self.events.append(
            session_id=SESSION,
            runtime_id="codex",
            vendor_thread_id=THREAD,
            vendor_turn_id="turn-1",
            vendor_item_id="stale-start",
            kind="tool_completed",
            payload={"tool_id": "stale-start", "success": False, **failure},
            idempotency_key="stale-start",
        )
        reconciled = {
            **state,
            "ok": True,
            "plan": {"plan_id": "review", "revision": 6, "started_ids": []},
            "items": [item("runner", status="completed")],
        }
        receipt = plan_tool_receipt({**arguments, "operation": "complete"}, reconciled, "turn-1")
        self.assertEqual(plan_tool_recoveries(receipt, [record], "turn-1"), [])
        started = {
            **reconciled,
            "plan": {"plan_id": "review", "revision": 6, "started_ids": ["runner"]},
            "items": [item("runner", status="in_progress")],
        }
        receipt = plan_tool_receipt(arguments, started, "turn-1")
        self.assertEqual(plan_tool_recoveries(receipt, [record], "turn-1"), ["stale-start"])
        self.assertEqual(plan_tool_recoveries(receipt, [record], "other-turn"), [])

    def test_completion_rejection_receipts_require_known_targets_and_authoritative_state(self):
        arguments = {"operation": "complete", "plan_id": "review", "step_ids": ["deliver"]}
        state = {
            "turn_id": "turn-1",
            "plan": {"plan_id": "review", "revision": 2},
            "items": [item("deliver")],
        }
        for error in (
            "plan_step_start_required",
            "plan_revision_conflict",
            "plan_completed_parent_has_unfinished_child",
            "bridge_invalid_parameters",
        ):
            rejected = {"ok": False, "error": error}
            self.assertIn(
                "plan_failure", plan_tool_receipt(arguments, rejected, "turn-1", current=state)
            )
            self.assertEqual(plan_tool_receipt(arguments, rejected, "turn-1"), {})
        for error in (
            "bridge_access_denied",
            "plan_turn_inactive",
            "bridge_execution_failed",
            "unknown",
        ):
            self.assertEqual(
                plan_tool_receipt(
                    arguments, {"ok": False, "error": error}, "turn-1", current=state
                ),
                {},
            )
        self.assertEqual(
            plan_tool_receipt(
                {**arguments, "step_ids": ["unknown"]},
                {"ok": False, "error": "bridge_invalid_parameters"},
                "turn-1",
                current=state,
            ),
            {},
        )
        self.assertEqual(
            plan_tool_receipt(
                {**arguments, "operation": ["complete"]},
                {"ok": False, "error": "bridge_operation_unknown"},
                "turn-1",
                current=state,
            ),
            {},
        )
        self.assertEqual(
            plan_tool_receipt(
                arguments, {"ok": False, "error": ["unknown"]}, "turn-1", current=state
            ),
            {},
        )

    def test_verified_completion_closes_containers_only_after_all_descendants_complete(self):
        tree = [
            {**item("root"), "kind": "group"},
            {**item("nested", "root"), "kind": "group"},
            item("started", "nested"),
            item("unstarted", "nested"),
            item("outside"),
        ]
        self.write(self.command(items=tree))
        self.write(self.action("start", ["started"], revision=1, request_id="start"))
        before = self.plans.current()
        with self.assertRaisesRegex(ValueError, "completed_parent_has_unfinished_child"):
            self.write(
                self.action(
                    "complete",
                    ["root", "nested", "started"],
                    revision=2,
                    request_id="incomplete-container",
                    reason="Only the first output was verified.",
                )
            )
        self.assertEqual(self.plans.current(), before)
        completed = self.write(
            self.action(
                "complete",
                ["root", "nested", "started", "unstarted"],
                revision=2,
                request_id="whole-container",
                reason="Verified both child output artifacts.",
            )
        )
        self.assertTrue(
            all(row["status"] == "completed" for row in completed.payload["items"][:-1])
        )
        self.assertEqual(completed.payload["items"][-1]["status"], "pending")
        self.assertEqual(completed.payload["plan"]["started_ids"], ["started"])
        self.assertEqual(completed.payload["plan"]["reconciled_ids"], ["unstarted"])
        self.assertTrue({"root", "nested"} <= completion_ids(self.plans.current()))

    def test_verified_completion_can_close_a_parent_after_its_children(self):
        self.write(self.command(items=[{**item("root"), "kind": "group"}, item("child", "root")]))
        self.write(
            self.action(
                "complete",
                ["child"],
                revision=1,
                request_id="child",
                reason="Verified the child result.",
            )
        )
        self.assertIn("root", completion_ids(self.plans.current()))
        completed = self.write(
            self.action(
                "complete",
                ["root"],
                revision=2,
                request_id="parent",
                reason="All child results are complete.",
            )
        )
        self.assertTrue(all(row["status"] == "completed" for row in completed.payload["items"]))
        self.assertEqual(completed.payload["plan"]["started_ids"], [])
        self.assertEqual(completed.payload["plan"]["reconciled_ids"], ["child"])

    def test_verified_completion_requires_evidence_and_preserves_unfinished_children_atomically(
        self,
    ):
        self.write(self.command(items=[item("root"), item("child", "root"), item("later")]))
        for identities, reason in ((["child"], "  "), (["root", "later"], "Verified result")):
            with self.assertRaises(ValueError):
                self.write(
                    self.action(
                        "complete", identities, revision=1, request_id="invalid", reason=reason
                    )
                )
            self.assertEqual(self.plans.current()["plan"]["revision"], 1)
            self.assertEqual(self.plans.current()["items"][-1]["status"], "pending")
        self.write(
            self.command(
                operation="revise",
                expected_revision=1,
                request_id="empty",
                reason="Remove the child before any work begins.",
                items=[{**item("root"), "kind": "group"}],
            )
        )
        with self.assertRaisesRegex(PlanExecutionError, "completion_target_invalid"):
            self.write(
                self.action(
                    "complete",
                    ["root"],
                    revision=2,
                    request_id="empty-complete",
                    reason="No result exists.",
                )
            )

    def test_reconcile_records_completion_without_inventing_a_start(self):
        self.write(self.command(items=[item("root"), item("later")]))
        with self.assertRaisesRegex(PlanExecutionError, "start_required"):
            self.write(self.action("finish", ["root"], revision=1, request_id="finish"))
        completion = self.action(
            "reconcile",
            ["root"],
            revision=1,
            request_id="reconcile",
            reason="Read the delivered report and verified its required sections.",
        )
        event = self.write(completion)
        self.assertEqual(event.payload["items"][0]["status"], "completed")
        self.assertEqual(event.payload["plan"]["started_ids"], [])
        self.assertEqual(event.payload["explanation"], completion.reason)
        self.write(self.action("start", ["later"], revision=2, request_id="next"))
        self.assertEqual(self.write(completion), event)
        self.assertEqual(self.plans.current()["plan"]["started_ids"], ["later"])
        reopened = SessionPlans(SESSION, ProductEventStore(self.database), self.catalog)
        self.assertEqual(reopened.current(), self.plans.current())
        with self.assertRaisesRegex(PlanConflict, "revision_conflict"):
            self.write(
                self.action(
                    "reconcile", ["root"], revision=1, request_id="stale", reason="Verified report"
                )
            )

    def test_reconcile_requires_evidence_and_only_accepts_unstarted_leaves(self):
        tree = [
            {**item("root"), "kind": "group"},
            item("leaf", "root"),
            item("started", status="in_progress"),
            item("blocked", status="blocked"),
        ]
        self.write(self.command(items=tree))
        self.write(self.action("pause", ["started"], revision=1, request_id="pause"))
        before = self.plans.current()
        for identities, reason, error in (
            (["leaf"], "  ", "reconcile_reason_required"),
            (["root"], "Verified result", "reconcile_unstarted_leaf_required"),
            (["started"], "Verified result", "reconcile_unstarted_leaf_required"),
            (["leaf", "started"], "Verified result", "reconcile_unstarted_leaf_required"),
        ):
            with self.subTest(identities=identities, reason=reason):
                with self.assertRaisesRegex(ValueError, error):
                    self.write(
                        self.action(
                            "reconcile", identities, revision=2, request_id=error, reason=reason
                        )
                    )
                self.assertEqual(self.plans.current(), before)
        self.write(
            self.action(
                "reconcile",
                ["leaf", "blocked"],
                revision=2,
                request_id="recover",
                reason="Verified both delivered results",
            )
        )
        self.assertEqual(self.plans.current()["plan"]["started_ids"], ["started"])
        self.assertEqual(self.plans.current()["items"][1]["status"], "completed")

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

    def live(self, *, product_plan=True):
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
        if product_plan:
            asyncio.run(
                live.enable_plan(
                    PlanEnable(purpose="user_requested", reason="Contract product tree"), "turn-1"
                )
            )
        return live

    def test_plan_opt_in_preserves_artifact_delivery(self):
        self.assertFalse(self.plans.enabled())
        tools = session_service_tools(product_plan=self.plans.enabled())
        names = frozenset(tool.name for tool in tools)
        self.assertEqual(names, {"scholarseed_bridge", "publish_artifacts"})
        config = session_thread_config(frozenset(), names, native_plan_enabled=False)
        self.assertFalse(config["tools.update_plan.enabled"])
        self.plans.native(
            [{"content": "Check result", "status": "in_progress"}],
            runtime_id="codex",
            vendor_thread_id=THREAD,
            turn_id="turn-1",
            item_id="",
            key="native-only",
            explanation=None,
        )
        self.assertFalse(self.plans.enabled())
        self.write(self.command())
        self.assertTrue(self.plans.enabled())
        names = frozenset(tool.name for tool in session_service_tools(product_plan=True))
        self.assertIn("update_plan", names)
        self.assertFalse(session_thread_config(frozenset(), names)["tools.update_plan.enabled"])

    def test_plan_enablement_is_durable_idempotent_and_release_opts_out(self):
        live = self.live(product_plan=False)
        enable = PlanEnable(purpose="workflow_required", reason="Literature review stages")
        asyncio.run(live.enable_plan(enable, "turn-1"))
        before = self.events.replay(SESSION)
        asyncio.run(live.enable_plan(enable, "turn-1"))
        self.assertEqual(self.events.replay(SESSION), before)
        self.assertEqual(self.plans.current(), {"items": [], "plan": None})
        self.assertEqual(self.catalog.todos(SESSION), ())
        restored = SessionPlans(SESSION, ProductEventStore(self.database), self.catalog)
        self.assertTrue(restored.enabled())
        self.write(self.command())
        self.write(
            self.command(
                operation="release",
                expected_revision=1,
                request_id="release",
                reason="Task changed",
            )
        )
        self.assertFalse(restored.enabled())
        self.plans.native(
            [{"content": "New task", "status": "pending"}],
            runtime_id="codex",
            vendor_thread_id=THREAD,
            turn_id="turn-1",
            item_id="",
            key="after-release",
            explanation=None,
        )
        self.assertFalse(restored.enabled())
        asyncio.run(live.enable_plan(enable, "turn-1"))
        self.assertTrue(restored.enabled())

    def test_enablement_rechecks_turn_after_waiting_for_projection(self):
        live = self.live(product_plan=False)

        async def race():
            await live._projection_lock.acquire()
            waiting = asyncio.create_task(
                live.enable_plan(
                    PlanEnable(purpose="user_requested", reason="Track stages"), "turn-1"
                )
            )
            await asyncio.sleep(0)
            live.interrupting = True
            live._projection_lock.release()
            with self.assertRaisesRegex(PermissionError, "turn_inactive"):
                await waiting

        asyncio.run(race())
        self.assertFalse(self.plans.enabled())

    def test_plan_execution_and_discovery_require_explicit_enablement(self):
        live = self.live(product_plan=False)
        sessions = SimpleNamespace(bridge_caller=lambda sid: live if sid == SESSION else None)
        app = FastAPI()
        activities = Activities()
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_plan_routes(app, sessions, activities=activities)
        register_contract_routes(app, sessions.bridge_caller, activities=activities)
        headers = {BRIDGE_SESSION_HEADER: SESSION, BRIDGE_TOKEN_HEADER: live.bridge_token}
        with TestClient(app) as client:
            for operation, body in (("get", {}), ("write", self.command().model_dump())):
                denied = client.post(PLAN_ROUTE_PREFIX + operation, json=body, headers=headers)
                self.assertEqual(denied.status_code, 403)
                self.assertEqual(denied.json()["error"], "plan_not_enabled")
            query = {"target_capability": "plan", "target_operation": "structure"}
            self.assertEqual(
                client.post(CONTRACT_DESCRIBE_ROUTE, json=query, headers=headers).json()["error"],
                "plan_not_enabled",
            )
            listing = client.post(
                CONTRACT_LIST_ROUTE, json={"capability": "plan"}, headers=headers
            ).json()
            self.assertEqual([row["operation"] for row in listing["entries"]], ["enable"])
            artifact = client.post(
                CONTRACT_DESCRIBE_ROUTE,
                json={"target_capability": "artifact", "target_operation": "publish"},
                headers=headers,
            ).json()
            self.assertTrue(artifact["ok"])
            for purpose, reason in (("complex_task", "many steps"), ("user_requested", " ")):
                invalid = client.post(
                    PLAN_ROUTE_PREFIX + "enable",
                    json={"purpose": purpose, "reason": reason},
                    headers=headers,
                )
                self.assertEqual(invalid.status_code, 400)
                self.assertFalse(self.plans.enabled())
            response = client.post(
                PLAN_ROUTE_PREFIX + "enable",
                json={"purpose": "user_requested", "reason": "Track this task tree"},
                headers=headers,
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["items"], [])
            self.assertTrue(
                client.post(CONTRACT_DESCRIBE_ROUTE, json=query, headers=headers).json()["ok"]
            )
            created = client.post(
                PLAN_ROUTE_PREFIX + "write", json=self.command().model_dump(), headers=headers
            )
            self.assertEqual(created.status_code, 200, created.text)

    def test_disabled_callback_cannot_bypass_using_dedicated_or_bridge_tool(self):
        for tool, args in (
            ("update_plan", {"operation": "get"}),
            ("scholarseed_bridge", {"capability": "plan", "operation": "get", "request": {}}),
        ):
            result = asyncio.run(
                execute_service_tool(
                    args,
                    session_id=SESSION,
                    token="test",
                    local_socket=None,
                    tool_name=tool,
                    product_plan=False,
                )
            )
            self.assertEqual(result, {"ok": False, "error": "plan_not_enabled"})

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
            self.assertEqual(response.json()["expected_revision"], 0)
            response = client.post(
                PLAN_ROUTE_PREFIX + "write", json=self.command().model_dump(), headers=headers
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["expected_revision"], 1)
            stale = self.command(operation="update", request_id="stale").model_dump()
            self.assertEqual(
                client.post(PLAN_ROUTE_PREFIX + "write", json=stale, headers=headers).status_code,
                409,
            )
            metadata = self.command().model_dump(exclude={"operation", "items", "estimate"})
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
            self.assertIn("reconcile", rejected.json()["current"]["actions"]["root"])
            self.assertEqual(rejected.json()["current"]["plan"]["revision"], 1)
            self.assertIn("observed completion evidence", rejected.json()["next_action"])
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
            self.assertNotIn("reconcile", started.json()["actions"]["root"])
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

    def test_model_plan_binds_callback_turn_without_trusting_model_identity(self) -> None:
        live = self.live()
        sessions = cast(
            SessionService,
            SimpleNamespace(bridge_caller=lambda identity: live if identity == SESSION else None),
        )
        app = FastAPI()
        activities = Activities()
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_plan_routes(app, sessions, activities=activities)

        async def call(arguments, *, callback_turn_id="turn-1", callback_request_id="callback"):
            client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app))
            try:
                with (
                    patch.dict(os.environ, {INTERNAL_BASE_URL_ENV: "http://127.0.0.1"}),
                    patch("service.chat.runtime.tools.httpx.AsyncClient", return_value=client),
                ):
                    return await execute_service_tool(
                        arguments,
                        session_id=SESSION,
                        token=live.bridge_token,
                        local_socket=None,
                        tool_name="update_plan",
                        callback_request_id=callback_request_id,
                        callback_turn_id=callback_turn_id,
                    )
            finally:
                await client.aclose()

        async def scenario():
            metadata = {"plan_id": "fast-search", "request_id": "create", "expected_revision": 0}
            created = await call(
                {
                    **metadata,
                    "operation": "create",
                    "turn_id": "t1",
                    "items": [{"id": "search", "content": "Discover papers"}],
                }
            )
            self.assertTrue(created["ok"], created)
            self.assertEqual(created["turn_id"], "turn-1")
            self.assertEqual(created["expected_revision"], 1)
            record = self.catalog.get(SESSION)
            assert record is not None
            self.assertEqual(record.todo_turn_id, "turn-1")
            started = await call(
                {
                    **metadata,
                    "operation": "start",
                    "expected_revision": 1,
                    "request_id": "start",
                    "step_ids": ["search"],
                }
            )
            self.assertTrue(started["ok"], started)
            self.assertEqual(started["items"][0]["status"], "in_progress")
            self.assertEqual(started["expected_revision"], 2)
            before = live.plans.current()
            mutation = {
                **metadata,
                "operation": "finish",
                "expected_revision": 2,
                "request_id": "finish",
                "turn_id": "turn-1",
                "step_ids": ["search"],
            }
            for callback in ({"callback_turn_id": "old-turn"}, {"callback_request_id": ""}):
                rejected = await call(mutation, **callback)
                self.assertFalse(rejected["ok"], rejected)
                self.assertEqual(live.plans.current(), before)
            conflict = await call({**mutation, "expected_revision": 0})
            self.assertEqual(conflict["error"], "plan_revision_conflict")
            self.assertEqual(conflict["current"]["expected_revision"], 2)
            self.assertEqual(live.plans.current(), before)
            finished = await call({**mutation, "turn_id": "t1"})
            self.assertTrue(finished["ok"], finished)
            self.assertEqual(finished["items"][0]["status"], "completed")
            self.assertEqual(finished["expected_revision"], 3)
            live.interrupting = True
            before = live.plans.current()
            rejected = await call({**mutation, "expected_revision": 3, "request_id": "late"})
            self.assertEqual(rejected["error"], "plan_turn_inactive")
            self.assertIn("plan/get", rejected["next_action"])
            self.assertEqual(live.plans.current(), before)

        asyncio.run(scenario())

    def test_bridge_reconciles_verified_completion_and_preserves_untimed_state(self):
        self.write(self.command(items=[item("root", status="blocked")]))
        live = self.live()
        sessions = SimpleNamespace(bridge_caller=lambda sid: live if sid == SESSION else None)
        app = FastAPI()
        activities = Activities()
        self.activities = activities
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_plan_routes(app, sessions, activities=activities)
        headers = {BRIDGE_SESSION_HEADER: SESSION, BRIDGE_TOKEN_HEADER: live.bridge_token}
        command = self.action(
            "reconcile",
            ["root"],
            revision=1,
            request_id="reconcile",
            reason="Verified the published report meets the requested sections.",
        ).model_dump()
        with TestClient(app) as client:
            response = client.post(PLAN_ROUTE_PREFIX + "action", headers=headers, json=command)
            self.assertEqual(response.status_code, 200, response.text)
            state = response.json()
            self.assertTrue(state["ok"])
            self.assertEqual(state["items"][0]["status"], "completed")
            self.assertEqual(state["plan"]["started_ids"], [])
            self.assertNotIn("reconcile", state["actions"]["root"])
            self.assertEqual(state["explanation"], command["reason"])
            replay = client.post(PLAN_ROUTE_PREFIX + "get", headers=headers, json={}).json()
            self.assertEqual(replay, state)
            self.assertEqual(
                client.post(PLAN_ROUTE_PREFIX + "action", headers=headers, json=command).json(),
                state,
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
