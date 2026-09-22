"""Deterministic contracts for conservative native quiescence inspection."""

from __future__ import annotations

import asyncio
import copy
import unittest
from collections import defaultdict
from typing import Any

from scholarseed_codex.activity import (
    NATIVE_BACKGROUND_TERMINALS_LIST_METHOD,
    NATIVE_GOAL_GET_METHOD,
    NATIVE_QUEUE_LIST_METHOD,
    NATIVE_THREAD_LOADED_LIST_METHOD,
    NATIVE_THREAD_READ_METHOD,
    NativeActivity,
    NativeActivityBlocker,
)
from scholarseed_codex.protocol.state import AppServerError

ROOT_THREAD = "root"
CHILD_THREAD = "child"
SIBLING_THREAD = "sibling"


def idle_thread(thread_id: str, parent: str | None = None) -> dict[str, Any]:
    return {"id": thread_id, "parentThreadId": parent, "status": {"type": "idle"}}


class ScriptedNativeHost:
    """Controlled RPC responses; these contracts are not product acceptance."""

    def __init__(self) -> None:
        self.process_generation = 1
        self.threads = {ROOT_THREAD: idle_thread(ROOT_THREAD)}
        self.responses: dict[tuple[str, str, str], Any] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.counts: dict[str, int] = defaultdict(int)
        self.mutation: Any = None

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((method, copy.deepcopy(params)))
        self.counts[method] += 1
        if self.mutation is not None:
            self.mutation(method, params, self.counts[method])
        key = (method, params.get("threadId", ""), params.get("cursor", ""))
        if key in self.responses:
            result = self.responses[key]
            if isinstance(result, BaseException):
                raise result
            return copy.deepcopy(result)
        if method == NATIVE_THREAD_LOADED_LIST_METHOD:
            return {"data": list(self.threads), "nextCursor": None}
        if method == NATIVE_THREAD_READ_METHOD:
            return {"thread": copy.deepcopy(self.threads[params["threadId"]])}
        if method == NATIVE_GOAL_GET_METHOD:
            return {"goal": None}
        if method in (
            NATIVE_BACKGROUND_TERMINALS_LIST_METHOD,
            NATIVE_QUEUE_LIST_METHOD,
        ):
            return {"data": [], "nextCursor": None}
        raise AssertionError(f"Unexpected method: {method}")


class NativeActivityTests(unittest.IsolatedAsyncioTestCase):
    async def test_idle_tree_requires_every_dimension_and_keeps_requests_read_only(
        self,
    ) -> None:
        host = ScriptedNativeHost()
        host.threads[CHILD_THREAD] = idle_thread(CHILD_THREAD, ROOT_THREAD)
        state = await NativeActivity(host, ROOT_THREAD).inspect()
        self.assertTrue(state.complete)
        self.assertEqual(state.blockers, ())
        self.assertEqual(state.loaded_thread_ids, (CHILD_THREAD, ROOT_THREAD))
        for thread_id in (ROOT_THREAD, CHILD_THREAD):
            checked = {
                method for method, params in host.calls if params.get("threadId") == thread_id
            }
            self.assertEqual(
                checked,
                {
                    NATIVE_THREAD_READ_METHOD,
                    NATIVE_BACKGROUND_TERMINALS_LIST_METHOD,
                    NATIVE_GOAL_GET_METHOD,
                    NATIVE_QUEUE_LIST_METHOD,
                },
            )
        self.assertEqual(host.counts[NATIVE_THREAD_LOADED_LIST_METHOD], 2)

    async def test_native_background_terminal_blocks_after_root_turn_is_idle(
        self,
    ) -> None:
        host = ScriptedNativeHost()
        host.responses[(NATIVE_BACKGROUND_TERMINALS_LIST_METHOD, ROOT_THREAD, "")] = {
            "data": [],
            "nextCursor": "page-two",
        }
        host.responses[(NATIVE_BACKGROUND_TERMINALS_LIST_METHOD, ROOT_THREAD, "page-two")] = {
            "data": [{"itemId": "exec-item", "processId": "42"}],
            "nextCursor": None,
        }
        state = await NativeActivity(host, ROOT_THREAD).inspect()
        self.assertTrue(state.complete)
        self.assertIn(NativeActivityBlocker.BACKGROUND_TERMINAL.value, state.blockers)

    async def test_system_error_thread_is_quiescent_when_every_owned_dimension_is_clear(
        self,
    ) -> None:
        host = ScriptedNativeHost()
        host.threads[ROOT_THREAD]["status"] = {"type": "systemError"}
        host.threads[CHILD_THREAD] = idle_thread(CHILD_THREAD, ROOT_THREAD)
        host.threads[CHILD_THREAD]["status"] = {"type": "systemError"}
        state = await NativeActivity(host, ROOT_THREAD).inspect()
        self.assertTrue(state.complete)
        self.assertEqual(state.blockers, ())

    async def test_system_error_does_not_hide_other_owned_activity(self) -> None:
        cases = (
            (
                NATIVE_BACKGROUND_TERMINALS_LIST_METHOD,
                {"data": [{"itemId": "exec-item", "processId": "42"}], "nextCursor": None},
                NativeActivityBlocker.BACKGROUND_TERMINAL,
            ),
            (
                NATIVE_GOAL_GET_METHOD,
                {"goal": {"threadId": ROOT_THREAD, "status": "active"}},
                NativeActivityBlocker.GOAL,
            ),
            (
                NATIVE_QUEUE_LIST_METHOD,
                {
                    "data": [
                        {
                            "id": "queue-id",
                            "clientUserMessageId": "message-id",
                            "input": [],
                        }
                    ],
                    "nextCursor": None,
                },
                NativeActivityBlocker.QUEUED_SUBMISSION,
            ),
        )
        for method, response, expected in cases:
            with self.subTest(method=method):
                host = ScriptedNativeHost()
                host.threads[ROOT_THREAD]["status"] = {"type": "systemError"}
                host.responses[(method, ROOT_THREAD, "")] = response
                state = await NativeActivity(host, ROOT_THREAD).inspect()
                self.assertTrue(state.complete)
                self.assertIn(expected.value, state.blockers)

    async def test_system_error_that_becomes_active_during_inspection_blocks(self) -> None:
        host = ScriptedNativeHost()
        host.threads[ROOT_THREAD]["status"] = {"type": "systemError"}

        def activate_on_final_read(method: str, _params: dict[str, Any], count: int) -> None:
            if method == NATIVE_THREAD_READ_METHOD and count == 2:
                host.threads[ROOT_THREAD]["status"] = {"type": "active", "activeFlags": []}

        host.mutation = activate_on_final_read
        state = await NativeActivity(host, ROOT_THREAD).inspect()
        self.assertTrue(state.complete)
        self.assertIn(NativeActivityBlocker.TURN.value, state.blockers)

    async def test_descendant_activity_and_nested_descendant_ownership_are_checked(
        self,
    ) -> None:
        host = ScriptedNativeHost()
        host.threads[CHILD_THREAD] = idle_thread(CHILD_THREAD, ROOT_THREAD)
        host.threads["grandchild"] = idle_thread("grandchild", CHILD_THREAD)
        host.threads["grandchild"]["status"] = {
            "type": "active",
            "activeFlags": ["waitingOnApproval"],
        }
        state = await NativeActivity(host, ROOT_THREAD).inspect()
        self.assertTrue(state.complete)
        self.assertIn(NativeActivityBlocker.TURN.value, state.blockers)

    async def test_known_sibling_lease_is_not_mistaken_for_a_child(self) -> None:
        host = ScriptedNativeHost()
        host.threads[SIBLING_THREAD] = idle_thread(SIBLING_THREAD)
        host.threads[SIBLING_THREAD]["status"] = {"type": "active", "activeFlags": []}
        state = await NativeActivity(host, ROOT_THREAD, known_roots=(SIBLING_THREAD,)).inspect()
        self.assertTrue(state.complete)
        self.assertEqual(state.blockers, ())
        self.assertNotIn(
            (
                NATIVE_BACKGROUND_TERMINALS_LIST_METHOD,
                {"threadId": SIBLING_THREAD, "limit": 100},
            ),
            host.calls,
        )

    async def test_final_host_check_includes_previously_unsubscribed_roots(self) -> None:
        host = ScriptedNativeHost()
        host.threads[SIBLING_THREAD] = idle_thread(SIBLING_THREAD)
        host.threads[CHILD_THREAD] = idle_thread(CHILD_THREAD, SIBLING_THREAD)
        host.responses[(NATIVE_GOAL_GET_METHOD, CHILD_THREAD, "")] = {
            "goal": {"threadId": CHILD_THREAD, "status": "active"}
        }
        state = await NativeActivity(host, known_roots=(ROOT_THREAD, SIBLING_THREAD)).inspect()
        self.assertTrue(state.complete)
        self.assertIn(NativeActivityBlocker.GOAL.value, state.blockers)

    async def test_final_host_check_rejects_unowned_native_root(self) -> None:
        host = ScriptedNativeHost()
        state = await NativeActivity(host).inspect()
        self.assertFalse(state.complete)
        self.assertIn(NativeActivityBlocker.UNKNOWN_OWNERSHIP.value, state.blockers)

    async def test_unknown_parent_cycle_and_unowned_root_refuse_suspension(
        self,
    ) -> None:
        for parent in (None, "missing-parent", CHILD_THREAD):
            with self.subTest(parent=parent):
                host = ScriptedNativeHost()
                host.threads[CHILD_THREAD] = idle_thread(CHILD_THREAD, parent)
                state = await NativeActivity(host, ROOT_THREAD).inspect()
                self.assertFalse(state.complete)
                self.assertIn(NativeActivityBlocker.UNKNOWN_OWNERSHIP.value, state.blockers)

    async def test_goal_statuses_are_not_assumed_terminal(self) -> None:
        for status in (
            "active",
            "paused",
            "blocked",
            "usageLimited",
            "budgetLimited",
            "complete",
        ):
            with self.subTest(status=status):
                host = ScriptedNativeHost()
                host.responses[(NATIVE_GOAL_GET_METHOD, ROOT_THREAD, "")] = {
                    "goal": {"threadId": ROOT_THREAD, "status": status}
                }
                state = await NativeActivity(host, ROOT_THREAD).inspect()
                self.assertTrue(state.complete)
                self.assertEqual(
                    NativeActivityBlocker.GOAL.value in state.blockers,
                    status != "complete",
                )

    async def test_queued_native_submission_has_no_invented_completion_status(
        self,
    ) -> None:
        host = ScriptedNativeHost()
        host.responses[(NATIVE_QUEUE_LIST_METHOD, ROOT_THREAD, "")] = {
            "data": [{"id": "queue-id", "clientUserMessageId": "message-id", "input": []}],
            "nextCursor": None,
        }
        state = await NativeActivity(host, ROOT_THREAD).inspect()
        self.assertTrue(state.complete)
        self.assertIn(NativeActivityBlocker.QUEUED_SUBMISSION.value, state.blockers)

    async def test_schema_and_rpc_failures_never_mean_idle(self) -> None:
        cases = (
            (NATIVE_GOAL_GET_METHOD, {}),
            (
                NATIVE_GOAL_GET_METHOD,
                {"goal": {"threadId": ROOT_THREAD, "status": "new-status"}},
            ),
            (NATIVE_GOAL_GET_METHOD, {"goal": {"threadId": ROOT_THREAD, "status": []}}),
            (NATIVE_BACKGROUND_TERMINALS_LIST_METHOD, {"data": None}),
            (NATIVE_QUEUE_LIST_METHOD, {"data": ["unknown"]}),
            (
                NATIVE_GOAL_GET_METHOD,
                AppServerError("private failure", rpc_code=-32601),
            ),
        )
        for method, payload in cases:
            with self.subTest(method=method, payload=payload):
                host = ScriptedNativeHost()
                host.responses[(method, ROOT_THREAD, "")] = payload
                state = await NativeActivity(host, ROOT_THREAD).inspect()
                self.assertFalse(state.complete)
                self.assertTrue(state.blockers)
                self.assertNotIn("private failure", repr(state))

    async def test_cursor_cycle_and_duplicate_loaded_ids_fail_closed(self) -> None:
        host = ScriptedNativeHost()
        for cursor in ("", "loop"):
            host.responses[(NATIVE_QUEUE_LIST_METHOD, ROOT_THREAD, cursor)] = {
                "data": [],
                "nextCursor": "loop",
            }
        state = await NativeActivity(host, ROOT_THREAD).inspect()
        self.assertFalse(state.complete)
        self.assertIn(NativeActivityBlocker.PAGINATION_INCOMPLETE.value, state.blockers)
        host = ScriptedNativeHost()
        host.responses[(NATIVE_THREAD_LOADED_LIST_METHOD, "", "")] = {
            "data": [ROOT_THREAD, ROOT_THREAD],
            "nextCursor": None,
        }
        self.assertFalse((await NativeActivity(host, ROOT_THREAD).inspect()).complete)

    async def test_process_generation_change_invalidates_all_collected_observations(
        self,
    ) -> None:
        host = ScriptedNativeHost()

        def change_generation(method: str, _params: dict[str, Any], _count: int) -> None:
            if method == NATIVE_GOAL_GET_METHOD:
                host.process_generation += 1

        host.mutation = change_generation
        state = await NativeActivity(host, ROOT_THREAD).inspect()
        self.assertFalse(state.complete)
        self.assertIn(NativeActivityBlocker.GENERATION_CHANGED.value, state.blockers)

    async def test_loaded_graph_change_is_detected_before_return(self) -> None:
        host = ScriptedNativeHost()

        def add_child(method: str, _params: dict[str, Any], count: int) -> None:
            if method == NATIVE_THREAD_LOADED_LIST_METHOD and count == 2:
                host.threads[CHILD_THREAD] = idle_thread(CHILD_THREAD, ROOT_THREAD)

        host.mutation = add_child
        state = await NativeActivity(host, ROOT_THREAD).inspect()
        self.assertFalse(state.complete)
        self.assertIn(NativeActivityBlocker.LOADED_THREADS_CHANGED.value, state.blockers)

    async def test_cancelled_inspection_propagates_without_cleanup_mutations(
        self,
    ) -> None:
        host = ScriptedNativeHost()
        host.responses[(NATIVE_GOAL_GET_METHOD, ROOT_THREAD, "")] = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await NativeActivity(host, ROOT_THREAD).inspect()


if __name__ == "__main__":
    unittest.main()
