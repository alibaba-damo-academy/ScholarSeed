"""Deterministic contracts for conservative native quiescence inspection."""

from __future__ import annotations

import asyncio
import copy
import unittest
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

from scholarseed_codex.activity import (
    NATIVE_BACKGROUND_TERMINALS_LIST_METHOD,
    NATIVE_EPHEMERAL_FIELD,
    NATIVE_GOAL_GET_METHOD,
    NATIVE_QUEUE_LIST_METHOD,
    NATIVE_THREAD_LIST_METHOD,
    NATIVE_THREAD_LOADED_LIST_METHOD,
    NATIVE_THREAD_READ_METHOD,
    NativeActivity,
    NativeActivityBlocker,
    NativeActivityState,
)
from scholarseed_codex.admission import NativeQuiescence
from scholarseed_codex.attachment import ThreadAttachment
from scholarseed_codex.control import CodexRuntimeControl
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.session import CodexSessionOpenRequest
from scholarseed_codex.protocol.state import (
    CODEX_COLLAB_TOOL_CALL_ITEM_TYPE,
    AppServerError,
    CodexProcessState,
    CodexThreadAttachmentState,
)
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_codex.turn import CodexTurnRuntime
from scholarseed_runtime.contract.command import InterruptRequest
from scholarseed_runtime.contract.sandbox import SANDBOX_CANCELLED_ERROR
from scholarseed_runtime.contract.session import (
    RUNTIME_SUSPEND_STALE,
    RuntimeActivitySnapshot,
    RuntimeExecutionTreeBlocker,
)

ROOT_THREAD = "root"
CHILD_THREAD = "child"
SIBLING_THREAD = "sibling"


def idle_thread(thread_id: str, parent: str | None = None) -> dict[str, Any]:
    return {"id": thread_id, "parentThreadId": parent, "status": {"type": "idle"}}


class ScriptedNativeHost:
    """Controlled RPC responses; these contracts are not product acceptance."""

    def __init__(self) -> None:
        self.process_generation = 1
        self.activity_revision = 0
        self.unscoped_activity_revision = 0
        self.thread_revisions: dict[str, int] = defaultdict(int)
        self.known_roots = (ROOT_THREAD,)
        self.threads = {ROOT_THREAD: idle_thread(ROOT_THREAD)}
        self.responses: dict[tuple[str, str, str], Any] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.request_generations: list[int | None] = []
        self.counts: dict[str, int] = defaultdict(int)
        self.mutation: Any = None

    def suspend_blockers(self, _thread_id: str) -> tuple[str, ...]:
        return ()

    def thread_activity_revision(self, thread_id: str) -> int:
        return self.unscoped_activity_revision + self.thread_revisions[thread_id]

    def retain_loaded_roots(self, _loaded: tuple[str, ...]) -> None:
        return None

    async def request(
        self, method: str, params: dict[str, Any], *, generation: int | None = None
    ) -> dict[str, Any]:
        self.calls.append((method, copy.deepcopy(params)))
        self.request_generations.append(generation)
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
        if method == NATIVE_THREAD_LIST_METHOD:
            return {
                "data": (
                    [
                        copy.deepcopy(thread)
                        for thread in self.threads.values()
                        if thread["id"] != ROOT_THREAD
                    ]
                    if not params["archived"]
                    else []
                ),
                "nextCursor": None,
            }
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
    @staticmethod
    def empty_replacement_host() -> CodexProcessHost:
        host = CodexProcessHost()
        host._generation = 2
        host.state = CodexProcessState.READY
        host._proc = SimpleNamespace(returncode=None)
        host._exited_generations.append(1)
        attachment = ThreadAttachment(
            request=CodexSessionOpenRequest(
                request_id="empty-replacement", runtime_id="codex", cwd=Path.cwd()
            ),
            listener=None,
            thread_id=ROOT_THREAD,
            attached_generation=2,
            absent_generation=2,
            fresh_generation=1,
            attachment_state=CodexThreadAttachmentState.BROKEN,
        )
        attachment.turn = CodexTurnRuntime(
            attachment,
            admission=host.admission,
            request=host._request_connected,
            ensure_attached=host.ensure_attached,
            stale_requests=host._stale_requests,
            emitter=host._emitter,
            router=host._router,
            watcher=host._watcher,
            diagnostic=host._diagnostics.append,
            protocol_error=host._protocol_errors.append,
        )
        host._threads[ROOT_THREAD] = attachment
        host.admission.freeze(1)
        return host

    async def test_sealing_empty_replacement_invalidates_existing_configuration_ticket(
        self,
    ) -> None:
        host = self.empty_replacement_host()
        ticket = NativeQuiescence(
            1, host.process_generation, host.activity_revision, host.admission.epoch
        )
        thread_revision = host.thread_activity_revision(ROOT_THREAD)
        self.assertTrue(host.configuration_quiescence_current(ticket))

        self.assertEqual(host.seal_empty_replacement(ROOT_THREAD), (1, 2))

        self.assertFalse(host.configuration_quiescence_current(ticket))
        self.assertEqual(host.activity_revision, ticket.activity_revision + 1)
        self.assertEqual(host.thread_activity_revision(ROOT_THREAD), thread_revision + 1)
        self.assertEqual(
            host.attachment(ROOT_THREAD).attachment_state,
            CodexThreadAttachmentState.CLOSED,
        )
        self.assertTrue(host.attachment(ROOT_THREAD).turn.replacement_sealed)
        self.assertIsNone(host.seal_empty_replacement(ROOT_THREAD))
        self.assertEqual(host.activity_revision, ticket.activity_revision + 1)

    async def test_sealing_empty_replacement_invalidates_inflight_configuration_inspection(
        self,
    ) -> None:
        host = self.empty_replacement_host()
        entered, release = asyncio.Event(), asyncio.Event()

        async def inspect() -> NativeActivityState:
            entered.set()
            await release.wait()
            return NativeActivityState(True, (), (), (), host.process_generation)

        with patch.object(NativeActivity, "inspect", new=AsyncMock(side_effect=inspect)):
            pending = asyncio.create_task(host.configuration_quiescence(1))
            await entered.wait()
            result = host.seal_empty_replacement(ROOT_THREAD)
            release.set()
            ticket = await pending

        self.assertEqual(result, (1, 2))
        self.assertIsNone(ticket)

    async def test_disconnected_activity_never_starts_a_new_process(self) -> None:
        host = CodexProcessHost()
        host._generation = 1
        host.state = CodexProcessState.UNAVAILABLE

        async def failed_start() -> None:
            host._generation += 1
            raise AppServerError("setup cancelled", safe_error=SANDBOX_CANCELLED_ERROR)

        host._start_process = AsyncMock(side_effect=failed_start)
        session = self.runtime_session(host)
        for _ in range(2):
            snapshot = await session.activity()
            self.assertFalse(snapshot.execution_tree_complete)
            self.assertFalse(snapshot.execution_tree_idle)
            self.assertIn(NativeActivityBlocker.UNAVAILABLE.value, snapshot.blockers)
        with self.assertRaises(AppServerError):
            await NativeActivity(host, ROOT_THREAD).interrupt()
        self.assertEqual(host.process_generation, 1)
        host._start_process.assert_not_awaited()
        with self.assertRaises(AppServerError) as caught:
            await host.start()
        self.assertEqual(caught.exception.safe_error, SANDBOX_CANCELLED_ERROR)
        self.assertEqual(host.process_generation, 2)
        host._start_process.assert_awaited_once()

    async def test_activity_reads_target_the_observed_process_generation(self) -> None:
        host = ScriptedNativeHost()
        state = await NativeActivity(host, ROOT_THREAD).inspect()
        self.assertTrue(state.complete)
        self.assertTrue(host.request_generations)
        self.assertEqual(set(host.request_generations), {host.process_generation})

    async def test_activity_control_requires_the_exact_lease_generation(self) -> None:
        host = CodexProcessHost()
        host._generation = 1
        host.state = CodexProcessState.READY
        scripted = ScriptedNativeHost()
        host._request_connected = AsyncMock(side_effect=scripted.request)
        host.start = AsyncMock(side_effect=AssertionError("observation cannot start a host"))
        control = CodexRuntimeControl(
            cwd=Path.cwd(),
            lease=SimpleNamespace(host=host, host_id="control-host"),
            host_pool=Mock(),
        )
        await control.open()
        for generation in (0, 2, True):
            with self.subTest(generation=generation):
                with self.assertRaises(AppServerError) as caught:
                    await control.request(
                        NATIVE_THREAD_LOADED_LIST_METHOD, {}, generation=generation
                    )
                self.assertEqual(caught.exception.safe_error, RUNTIME_SUSPEND_STALE)
        host._request_connected.assert_not_awaited()
        await control.request(NATIVE_THREAD_LOADED_LIST_METHOD, {}, generation=1)
        await control.request(NATIVE_THREAD_LOADED_LIST_METHOD, {})
        state = await NativeActivity(control, ROOT_THREAD).inspect()
        self.assertTrue(state.complete)
        self.assertEqual(set(scripted.request_generations), {1})
        host.start.assert_not_awaited()

    async def test_absent_root_does_not_require_unrelated_root_to_be_idle(self) -> None:
        host = ScriptedNativeHost()
        host.known_roots = (ROOT_THREAD, SIBLING_THREAD)
        host.threads = {SIBLING_THREAD: idle_thread(SIBLING_THREAD)}
        host.threads[SIBLING_THREAD]["status"] = {"type": "active", "activeFlags": []}
        state = await NativeActivity(
            host, ROOT_THREAD, known_roots=host.known_roots
        ).inspect_absence()
        self.assertTrue(state.complete)
        self.assertEqual(state.blockers, ())
        self.assertEqual(state.loaded_thread_ids, (SIBLING_THREAD,))
        self.assertFalse(any(params.get("threadId") == ROOT_THREAD for _, params in host.calls))

    async def test_absent_root_still_checks_loaded_descendants(self) -> None:
        host = ScriptedNativeHost()
        host.threads = {CHILD_THREAD: idle_thread(CHILD_THREAD, ROOT_THREAD)}
        host.threads[CHILD_THREAD]["status"] = {"type": "active", "activeFlags": []}
        state = await NativeActivity(host, ROOT_THREAD).inspect_absence()
        self.assertTrue(state.complete)
        self.assertIn(NativeActivityBlocker.TURN.value, state.blockers)
        host.threads[CHILD_THREAD]["status"] = {"type": "idle"}
        state = await NativeActivity(host, ROOT_THREAD).inspect_absence()
        self.assertTrue(state.complete)
        self.assertFalse(state.blockers)

    async def test_absence_inspection_rejects_present_root_and_unknown_ownership(self) -> None:
        host = ScriptedNativeHost()
        state = await NativeActivity(host, ROOT_THREAD).inspect_absence()
        self.assertFalse(state.complete)
        self.assertIn(NativeActivityBlocker.THREAD_PRESENT.value, state.blockers)
        host.threads = {SIBLING_THREAD: idle_thread(SIBLING_THREAD)}
        state = await NativeActivity(host, ROOT_THREAD).inspect_absence()
        self.assertFalse(state.complete)
        self.assertIn(NativeActivityBlocker.UNKNOWN_OWNERSHIP.value, state.blockers)
        state = await NativeActivity(host).inspect_absence()
        self.assertFalse(state.complete)
        self.assertIn(NativeActivityBlocker.UNKNOWN_OWNERSHIP.value, state.blockers)

    async def test_detach_waits_for_whole_tree_interruption(self) -> None:
        entered, finish = asyncio.Event(), asyncio.Event()

        async def interrupt_tree(**_kwargs):
            entered.set()
            await finish.wait()

        session = CodexRuntimeSession.__new__(CodexRuntimeSession)
        session._owns_pool = False
        session._admission_lock = asyncio.Lock()
        session._interrupt_lock = asyncio.Lock()
        session._suspend_receipt = None
        session._active_operations = 0
        session._activity_revision = 0
        session._events = SimpleNamespace(close=AsyncMock())
        host = ScriptedNativeHost()
        host.attachment = lambda _key: SimpleNamespace(turn=SimpleNamespace(interrupt=AsyncMock()))
        session._native = SimpleNamespace(host=host, session_id=ROOT_THREAD, aclose=AsyncMock())
        with patch.object(NativeActivity, "interrupt", side_effect=interrupt_tree):
            stopping = asyncio.create_task(session.interrupt(InterruptRequest("stop")))
            await entered.wait()
            closing = asyncio.create_task(session.detach())
            await asyncio.sleep(0)
            session._native.aclose.assert_not_awaited()
            finish.set()
            await asyncio.gather(stopping, closing)
        session._native.aclose.assert_awaited_once()
        self.assertEqual(session._active_operations, 0)

    async def test_interrupt_covers_idle_parent_descendants_and_new_grandchild(self) -> None:
        host = ScriptedNativeHost()
        host.known_roots = (ROOT_THREAD, SIBLING_THREAD)
        host.threads[SIBLING_THREAD] = idle_thread(SIBLING_THREAD)
        host.threads[CHILD_THREAD] = idle_thread(CHILD_THREAD, ROOT_THREAD)
        host.threads[CHILD_THREAD]["status"] = {"type": "active", "activeFlags": []}
        interrupted = []
        request = host.request

        async def native(method, params, *, generation=None):
            thread = host.threads.get(params.get("threadId"))
            if method == "thread/turns/list":
                return {
                    "data": [{"id": params["threadId"] + "-turn", "status": "inProgress"}],
                    "nextCursor": None,
                }
            if method == "turn/interrupt":
                self.assertEqual(generation, host.process_generation)
                interrupted.append(params["threadId"])
                thread["status"] = {"type": "idle"}
                if params["threadId"] == CHILD_THREAD:
                    host.threads["grandchild"] = idle_thread("grandchild", CHILD_THREAD)
                    host.threads["grandchild"]["status"] = {"type": "active", "activeFlags": []}
                return {}
            return await request(method, params, generation=generation)

        host.request = native
        await NativeActivity(host, ROOT_THREAD, known_roots=host.known_roots).interrupt()
        self.assertEqual(interrupted, [CHILD_THREAD, "grandchild"])

    async def test_interrupt_unknown_ownership_has_no_mutations(self) -> None:
        host = ScriptedNativeHost()
        host.threads["unknown"] = idle_thread("unknown")
        with self.assertRaises(ValueError):
            await NativeActivity(host, ROOT_THREAD).interrupt()
        self.assertFalse(any(method == "turn/interrupt" for method, _ in host.calls))

    async def test_interrupt_reclaims_owned_terminals_after_root_ended(self) -> None:
        host = ScriptedNativeHost()
        host.threads[CHILD_THREAD] = idle_thread(CHILD_THREAD, ROOT_THREAD)
        terminals = [{"itemId": "child-command", "processId": "child-process"}]
        terminated = []
        request = host.request

        async def native(method, params, *, generation=None):
            if method == "thread/backgroundTerminals/list" and params["threadId"] == CHILD_THREAD:
                return {"data": list(terminals), "nextCursor": None}
            if method == "thread/backgroundTerminals/terminate":
                self.assertEqual(generation, host.process_generation)
                terminated.append(params)
                terminals.clear()
                return {"terminated": True}
            return await request(method, params, generation=generation)

        host.request = native
        await NativeActivity(host, ROOT_THREAD).interrupt(cleanup_background_processes=True)
        self.assertEqual(terminated, [{"threadId": CHILD_THREAD, "processId": "child-process"}])

    async def test_interrupt_transport_failure_can_be_retried(self) -> None:
        host = ScriptedNativeHost()
        host.responses[(NATIVE_THREAD_LOADED_LIST_METHOD, "", "")] = AppServerError("offline")
        with self.assertRaises(AppServerError):
            await NativeActivity(host, ROOT_THREAD).interrupt()
        host.responses.clear()
        await NativeActivity(host, ROOT_THREAD).interrupt()

    async def test_interrupt_generation_change_rejects_without_writes(self) -> None:
        host = ScriptedNativeHost()

        def restart(method, _params, _count):
            if method == NATIVE_THREAD_READ_METHOD:
                host.process_generation += 1

        host.mutation = restart
        with self.assertRaisesRegex(ValueError, "generation_changed"):
            await NativeActivity(host, ROOT_THREAD).interrupt()
        self.assertFalse(any(method == "turn/interrupt" for method, _ in host.calls))

    async def test_interrupt_preserves_goals_and_queued_input_as_drain_blockers(self) -> None:
        host = ScriptedNativeHost()
        host.responses[(NATIVE_GOAL_GET_METHOD, ROOT_THREAD, "")] = {
            "goal": {"threadId": ROOT_THREAD, "status": "paused"}
        }
        host.responses[(NATIVE_QUEUE_LIST_METHOD, ROOT_THREAD, "")] = {
            "data": [{"id": "queued", "clientUserMessageId": "message", "input": []}],
            "nextCursor": None,
        }
        activity = NativeActivity(host, ROOT_THREAD)
        await activity.interrupt(cleanup_background_processes=True)
        state = await activity.inspect()
        self.assertIn(NativeActivityBlocker.GOAL.value, state.blockers)
        self.assertIn(NativeActivityBlocker.QUEUED_SUBMISSION.value, state.blockers)

    async def test_native_ephemeral_threads_have_no_goals_or_queue(self) -> None:
        host = ScriptedNativeHost()
        host.threads[ROOT_THREAD][NATIVE_EPHEMERAL_FIELD] = True
        result = await NativeActivity(host, ROOT_THREAD).inspect()
        self.assertTrue(result.complete)
        self.assertFalse(result.blockers)
        methods = [method for method, _params in host.calls]
        self.assertNotIn(NATIVE_GOAL_GET_METHOD, methods)
        self.assertNotIn(NATIVE_QUEUE_LIST_METHOD, methods)
        self.assertIn(NATIVE_BACKGROUND_TERMINALS_LIST_METHOD, methods)
        host.threads[ROOT_THREAD]["status"] = {"type": "active", "activeFlags": []}
        result = await NativeActivity(host, ROOT_THREAD).inspect()
        self.assertIn(NativeActivityBlocker.TURN.value, result.blockers)

    async def test_unknown_ephemeral_flag_does_not_skip_activity_checks(self) -> None:
        for value in (None, False, "true", 1):
            with self.subTest(value=value):
                host = ScriptedNativeHost()
                host.threads[ROOT_THREAD][NATIVE_EPHEMERAL_FIELD] = value
                await NativeActivity(host, ROOT_THREAD).inspect()
                methods = [method for method, _params in host.calls]
                self.assertIn(NATIVE_GOAL_GET_METHOD, methods)
                self.assertIn(NATIVE_QUEUE_LIST_METHOD, methods)

    @staticmethod
    def runtime_session(host: ScriptedNativeHost) -> CodexRuntimeSession:
        session = object.__new__(CodexRuntimeSession)
        session._native = SimpleNamespace(host=host, session_id=ROOT_THREAD)
        session._event_namespace = "fixture"
        session._active_command_id = ""
        session._tasks = set()
        session._active_operations = 0
        session._activity_revision = 0
        session._watermark = 0
        session._events = asyncio.Queue()
        return session

    async def test_missing_execution_tree_evidence_is_not_idle(self) -> None:
        snapshot = RuntimeActivitySnapshot("fixture", 1, 1, True)
        self.assertTrue(snapshot.idle)
        self.assertFalse(snapshot.execution_tree_complete)
        self.assertFalse(snapshot.execution_tree_idle)

    async def test_descendants_include_nested_unloaded_threads(self) -> None:
        host = ScriptedNativeHost()
        host.threads[CHILD_THREAD] = idle_thread(CHILD_THREAD, ROOT_THREAD)
        host.threads[SIBLING_THREAD] = idle_thread(SIBLING_THREAD, CHILD_THREAD)
        result = await NativeActivity(host, ROOT_THREAD).descendants()
        self.assertEqual(
            [(node.thread_id, node.parent_thread_id) for node in result],
            [(CHILD_THREAD, ROOT_THREAD), (SIBLING_THREAD, CHILD_THREAD)],
        )
        requests = [params for method, params in host.calls if method == NATIVE_THREAD_LIST_METHOD]
        self.assertEqual([params["archived"] for params in requests], [False, True])
        self.assertTrue(all(params["ancestorThreadId"] == ROOT_THREAD for params in requests))
        self.assertTrue(all("subAgent" in params["sourceKinds"] for params in requests))

    async def test_descendants_reject_unknown_parent(self) -> None:
        host = ScriptedNativeHost()
        host.threads[CHILD_THREAD] = idle_thread(CHILD_THREAD, "another-root")
        with self.assertRaises(ValueError):
            await NativeActivity(host, ROOT_THREAD).descendants()

    async def test_execution_tree_is_independent_of_goal_and_queue(self) -> None:
        host = ScriptedNativeHost()
        host.responses[(NATIVE_GOAL_GET_METHOD, ROOT_THREAD, "")] = {
            "goal": {"threadId": ROOT_THREAD, "status": "active"}
        }
        host.responses[(NATIVE_QUEUE_LIST_METHOD, ROOT_THREAD, "")] = {
            "data": [{"id": "queue-id", "clientUserMessageId": "message-id", "input": []}],
            "nextCursor": None,
        }
        snapshot = await self.runtime_session(host).activity()
        self.assertFalse(snapshot.idle)
        self.assertTrue(snapshot.execution_tree_complete)
        self.assertTrue(snapshot.execution_tree_idle)
        self.assertEqual(snapshot.execution_tree_blockers, ())

    async def test_active_descendant_blocks_execution_tree_after_root_turn_ends(self) -> None:
        host = ScriptedNativeHost()
        host.threads[CHILD_THREAD] = idle_thread(CHILD_THREAD, ROOT_THREAD)
        host.threads[CHILD_THREAD]["status"] = {"type": "active", "activeFlags": []}
        snapshot = await self.runtime_session(host).activity()
        self.assertTrue(snapshot.execution_tree_complete)
        self.assertFalse(snapshot.execution_tree_idle)
        self.assertEqual(
            snapshot.execution_tree_blockers,
            (RuntimeExecutionTreeBlocker.TURN.value,),
        )

    async def test_background_terminal_blocks_execution_tree(self) -> None:
        host = ScriptedNativeHost()
        host.responses[(NATIVE_BACKGROUND_TERMINALS_LIST_METHOD, ROOT_THREAD, "")] = {
            "data": [{"itemId": "exec-item", "processId": "42"}],
            "nextCursor": None,
        }
        snapshot = await self.runtime_session(host).activity()
        self.assertTrue(snapshot.execution_tree_complete)
        self.assertFalse(snapshot.execution_tree_idle)
        self.assertEqual(
            snapshot.execution_tree_blockers,
            (RuntimeExecutionTreeBlocker.BACKGROUND_TASK.value,),
        )

    async def test_execution_tree_inspection_and_revision_changes_fail_closed(self) -> None:
        host = ScriptedNativeHost()
        host.responses[(NATIVE_GOAL_GET_METHOD, ROOT_THREAD, "")] = AppServerError("private")
        snapshot = await self.runtime_session(host).activity()
        self.assertFalse(snapshot.execution_tree_complete)
        self.assertFalse(snapshot.execution_tree_idle)

        host = ScriptedNativeHost()
        session = self.runtime_session(host)
        session._active_command_id = "unsettled"
        snapshot = await session.activity()
        self.assertFalse(snapshot.idle)
        self.assertTrue(snapshot.execution_tree_complete)
        self.assertTrue(snapshot.execution_tree_idle)

        host = ScriptedNativeHost()
        host.threads[ROOT_THREAD]["status"] = {"type": "active", "activeFlags": []}
        session = self.runtime_session(host)
        session._active_command_id = "unsettled"
        snapshot = await session.activity()
        self.assertFalse(snapshot.execution_tree_idle)

        host = ScriptedNativeHost()

        def change_revision(method: str, _params: dict[str, Any], count: int) -> None:
            if method == NATIVE_THREAD_READ_METHOD and count == 2:
                host.activity_revision += 1
                host.unscoped_activity_revision += 1

        host.mutation = change_revision
        snapshot = await self.runtime_session(host).activity()
        self.assertFalse(snapshot.execution_tree_complete)
        self.assertFalse(snapshot.execution_tree_idle)

    async def test_other_root_output_does_not_invalidate_idle_tree(self) -> None:
        host = ScriptedNativeHost()
        host.known_roots = (ROOT_THREAD, SIBLING_THREAD)
        host.threads[SIBLING_THREAD] = idle_thread(SIBLING_THREAD)
        host.threads[SIBLING_THREAD]["status"] = {"type": "active", "activeFlags": []}

        def stream_sibling(_method: str, _params: dict[str, Any], _count: int) -> None:
            host.activity_revision += 1
            host.thread_revisions[SIBLING_THREAD] += 1

        host.mutation = stream_sibling
        snapshot = await self.runtime_session(host).activity()
        self.assertTrue(snapshot.idle, snapshot.blockers)
        self.assertTrue(snapshot.execution_tree_idle)

    async def test_own_tree_revision_change_still_invalidates_idle_inspection(self) -> None:
        host = ScriptedNativeHost()

        def change_root(method: str, _params: dict[str, Any], count: int) -> None:
            if method == NATIVE_THREAD_READ_METHOD and count == 2:
                host.activity_revision += 1
                host.thread_revisions[ROOT_THREAD] += 1

        host.mutation = change_root
        snapshot = await self.runtime_session(host).activity()
        self.assertFalse(snapshot.idle)
        self.assertFalse(snapshot.execution_tree_complete)

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

    async def test_other_root_callback_keeps_session_revision_independent(self) -> None:
        host = CodexProcessHost(executable="contract-only")
        host._threads[ROOT_THREAD] = Mock()
        host._threads[SIBLING_THREAD] = Mock()
        host._respond_error = AsyncMock()
        await host._handle_server_request(
            "unsupported-request", "contract/unsupported", {"threadId": SIBLING_THREAD}
        )
        self.assertEqual(host.activity_revision, 1)
        self.assertEqual(host.thread_activity_revision(ROOT_THREAD), 0)
        self.assertEqual(host.thread_activity_revision(SIBLING_THREAD), 1)
        host._threads.pop(SIBLING_THREAD)
        host.retain_loaded_roots((ROOT_THREAD,))
        self.assertNotIn(SIBLING_THREAD, host._thread_activity_revisions)

    async def test_native_notifications_scope_revisions_to_owner_tree(self) -> None:
        host = CodexProcessHost(executable="contract-only")
        host._threads[ROOT_THREAD] = Mock()
        host._threads[SIBLING_THREAD] = Mock()
        host._router.register_agents(
            ROOT_THREAD,
            "owner-turn",
            {"type": CODEX_COLLAB_TOOL_CALL_ITEM_TYPE, "receiverThreadIds": [CHILD_THREAD]},
            host._threads,
        )
        await host._handle_notification("thread/started", {"threadId": SIBLING_THREAD})
        self.assertEqual(host.activity_revision, 1)
        self.assertEqual(host.thread_activity_revision(ROOT_THREAD), 0)
        self.assertEqual(host.thread_activity_revision(SIBLING_THREAD), 1)
        await host._handle_notification("thread/started", {"threadId": CHILD_THREAD})
        self.assertEqual(host.thread_activity_revision(ROOT_THREAD), 1)
        self.assertEqual(host.thread_activity_revision(SIBLING_THREAD), 1)
        await host._handle_notification("thread/started", {})
        self.assertEqual(host.activity_revision, 3)
        self.assertEqual(host.thread_activity_revision(ROOT_THREAD), 2)
        self.assertEqual(host.thread_activity_revision(SIBLING_THREAD), 2)


if __name__ == "__main__":
    unittest.main()
