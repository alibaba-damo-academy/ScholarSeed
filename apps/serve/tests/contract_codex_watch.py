"""Contract for Codex filesystem notifications projected as product artifacts."""

from __future__ import annotations

import asyncio
import json
import socket
import tempfile
import tomllib
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from scholarseed_codex.activity import (
    auto_approval_payload,
    strict_review_item_id,
    strict_review_payload,
)
from scholarseed_codex.attachment import ThreadAttachment
from scholarseed_codex.emitter import CodexEmitter
from scholarseed_codex.events import translate_event
from scholarseed_codex.failure import (
    PROVIDER_CONTENT_POLICY_MESSAGE,
    PROVIDER_CREDITS_MESSAGE,
    PROVIDER_MODEL_CONFIG_MESSAGE,
    provider_failure,
)
from scholarseed_codex.files import (
    is_artifact_candidate,
    observed_changes,
    workspace_relative_path,
    workspace_snapshot,
)
from scholarseed_codex.input import serialize_input
from scholarseed_codex.interaction import hil_payload, hil_response
from scholarseed_codex.permission import (
    CODEX_PERMISSION_POLICIES,
    local_socket_permissions,
    sandbox_policy,
)
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.session import (
    CodexApprovalReviewer,
    CodexSessionEvent,
    CodexSessionEventKind,
    CodexSessionOpenRequest,
)
from scholarseed_codex.protocol.state import AppServerError
from scholarseed_codex.router import ThreadRouter
from scholarseed_codex.rpc import FramingError, JsonLineWriter, PendingRequests, read_messages
from scholarseed_codex.session import CodexRuntimeSession, _page_limit
from scholarseed_codex.turn import CodexTurnRuntime
from scholarseed_codex.watch import WorkspaceWatch
from scholarseed_runtime.contract import (
    DeliveryClass,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimePermissionMode,
)
from scholarseed_runtime.contract.history import HistoryEntry, MessagePhase, TurnStatus
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.input import InputItem, InputKind, TurnInput


class CodexEmitterContract(unittest.IsolatedAsyncioTestCase):
    async def test_sequence_is_shared_across_thread_targets(self):
        events = []
        emitter = CodexEmitter()
        first = SimpleNamespace(thread_id="first", listener=events.append)
        second = SimpleNamespace(thread_id="second", listener=events.append)
        await emitter.emit(first, CodexSessionEventKind.ASSISTANT_DELTA, turn_id="a")
        await emitter.emit(second, CodexSessionEventKind.ASSISTANT_DELTA, turn_id="b")
        await emitter.emit(first, CodexSessionEventKind.ASSISTANT_COMPLETED, turn_id="a")
        self.assertEqual([event.vendor_seq for event in events], [1, 2, 3])
        self.assertEqual([event.session_id for event in events], ["first", "second", "first"])
        self.assertEqual([event.turn_id for event in events], ["a", "b", "a"])

    async def test_unobserved_events_still_advance_sequence(self):
        emitter = CodexEmitter()
        events = []
        target = SimpleNamespace(thread_id="first", listener=None)
        await emitter.emit(target, CodexSessionEventKind.ASSISTANT_DELTA)
        target.listener = events.append
        await emitter.emit(target, CodexSessionEventKind.ASSISTANT_COMPLETED)
        self.assertEqual(events[0].vendor_seq, 2)

    async def test_failed_observer_is_reported_without_stopping_delivery(self):
        emitter = CodexEmitter()
        observer = AsyncMock(side_effect=[RuntimeError("observer unavailable"), None])
        target = SimpleNamespace(thread_id="first", listener=observer)
        with self.assertLogs("scholarseed_codex.emitter", level="ERROR"):
            await emitter.emit(target, CodexSessionEventKind.ASSISTANT_DELTA)
        await emitter.emit(target, CodexSessionEventKind.ASSISTANT_COMPLETED)
        self.assertEqual(observer.await_count, 2)
        self.assertEqual(observer.call_args.args[0].vendor_seq, 2)


class CodexRouterContract(unittest.TestCase):
    def test_child_approval_owner_and_path_survive_lifecycle_updates(self):
        router = ThreadRouter()
        router.register_agents(
            "parent",
            "parent-turn",
            {"type": "collabAgentToolCall", "receiverThreadIds": ["child", "attached"]},
            {"parent", "attached"},
        )
        self.assertEqual(router.agent("child").owner_thread_id, "parent")
        self.assertEqual(router.agent("child").owner_turn_id, "parent-turn")
        self.assertIsNone(router.agent("attached"))
        router.register_agents(
            "parent",
            "parent-turn",
            {"type": "subAgentActivity", "agentThreadId": "child", "agentPath": "review"},
            {"parent"},
        )
        router.register_agents(
            "parent",
            "parent-turn",
            {"type": "collabAgentToolCall", "receiverThreadIds": ["child"]},
            {"parent"},
        )
        self.assertEqual(router.agent("child").agent_path, "review")
        router.close("unrelated")
        self.assertIsNotNone(router.agent("child"))
        router.close("parent")
        self.assertIsNone(router.agent("child"))

    def test_explicit_thread_precedes_turn_and_item_routes(self):
        router = ThreadRouter()
        router.bind_turn("turn", "first")
        router.bind_item("item", "second")
        self.assertEqual(router.resolve({"threadId": "explicit", "turnId": "turn"}), "explicit")
        self.assertEqual(router.resolve({"turnId": "turn", "itemId": "item"}), "first")
        self.assertEqual(router.resolve({"itemId": "item"}), "second")
        self.assertEqual(router.resolve({"turnId": "unknown"}), "")

    def test_closing_one_owner_preserves_other_session_routes(self):
        router = ThreadRouter()
        router.bind_turn("first-turn", "first")
        router.bind_item("first-item", "first")
        router.bind_turn("second-turn", "second")
        router.bind_item("second-item", "second")
        router.close("first")
        self.assertEqual(router.turn_owner("first-turn"), "")
        self.assertEqual(router.resolve({"itemId": "first-item"}), "")
        self.assertEqual(router.turn_owner("second-turn"), "second")
        self.assertEqual(router.resolve({"itemId": "second-item"}), "second")
        router.forget_turn("second-turn")
        router.forget_item("second-item")
        self.assertEqual(router.resolve({"turnId": "second-turn", "itemId": "second-item"}), "")


class CodexRpcContract(unittest.IsolatedAsyncioTestCase):
    async def test_reader_recovers_after_invalid_frames_and_preserves_order(self):
        stream = asyncio.StreamReader()
        stream.feed_data(b'\ninvalid\n[]\n{"id": 1}\n')
        stream.feed_data('{"text": "书深"}\n'.encode())
        stream.feed_eof()
        errors = []
        messages = [message async for message in read_messages(stream, errors.append)]
        self.assertEqual(messages, [{"id": 1}, {"text": "书深"}])
        self.assertEqual(errors, [FramingError.MALFORMED_JSON, FramingError.NON_OBJECT_MESSAGE])

    async def test_writer_preserves_json_line_and_rejects_detached_generation(self):
        written = []
        stream = SimpleNamespace(
            is_closing=lambda: False, write=written.append, drain=AsyncMock()
        )
        writer = JsonLineWriter()
        writer.attach(stream, 2)
        writer.detach(1)
        await writer.write({"text": "书深"}, generation=2)
        self.assertEqual(written, ['{"text": "书深"}\n'.encode("utf-8")])
        writer.detach(2)
        with self.assertRaises(AppServerError) as rejected:
            await writer.write({"id": 2}, generation=2)
        self.assertEqual(rejected.exception.safe_error, "runtime_transport_lost")
        self.assertEqual(len(written), 1)

    async def test_writer_reports_unknown_delivery_after_broken_pipe(self):
        stream = SimpleNamespace(
            is_closing=lambda: False,
            write=lambda data: None,
            drain=AsyncMock(side_effect=BrokenPipeError()),
        )
        writer = JsonLineWriter()
        writer.attach(stream, 1)
        with self.assertRaises(AppServerError) as failed:
            await writer.write({"id": 1}, generation=1)
        self.assertEqual(failed.exception.retryability.value, "unknown_outcome")

    async def test_rejected_response_preserves_method_and_ignores_duplicates(self) -> None:
        requests = PendingRequests()
        request_id, pending = requests.begin(4, "turn/start")
        requests.resolve({"id": request_id, "error": {"code": -32602}}, 4)
        error = pending.future.exception()
        self.assertIsInstance(error, AppServerError)
        self.assertEqual(error.method, "turn/start")
        self.assertEqual(error.generation, 4)
        self.assertEqual(error.rpc_code, -32602)
        requests.resolve({"id": request_id, "result": {"late": True}}, 4)
        self.assertIs(pending.future.exception(), error)
        requests.discard(request_id)

    async def test_request_identity_is_monotonic_and_generation_scoped(self) -> None:
        requests = PendingRequests()
        first_id, first = requests.begin(1, "thread/read")
        requests.resolve({"id": first_id, "result": {"wrong": True}}, 2)
        self.assertFalse(first.future.done())
        requests.resolve({"id": str(first_id), "result": {"ok": True}}, 1)
        self.assertEqual(await first.future, {"ok": True})
        requests.discard(first_id)
        second_id, second = requests.begin(2, "turn/start")
        self.assertGreater(second_id, first_id)
        requests.discard(second_id)
        self.assertTrue(second.future.cancelled())

    async def test_exit_fails_only_its_generation_and_close_settles_the_rest(self) -> None:
        requests = PendingRequests()
        _, first = requests.begin(1, "thread/read")
        _, second = requests.begin(2, "thread/read")
        error = AppServerError("connection closed")
        requests.fail(error, generation=1)
        self.assertIs(first.future.exception(), error)
        self.assertFalse(second.future.done())
        requests.close(error)
        self.assertIs(second.future.exception(), error)


class CodexFilesContract(unittest.TestCase):
    def test_artifact_filter_excludes_private_and_transient_files(self) -> None:
        for path in (
            ".scholarseed/state.json",
            "src/__pycache__/x.pyc",
            "node_modules/a.js",
            "x.tmp",
        ):
            with self.subTest(path=path):
                self.assertFalse(is_artifact_candidate(path))
        for path in ("quick_sort.py", "notes/report.md", "data/results.csv"):
            with self.subTest(path=path):
                self.assertTrue(is_artifact_candidate(path))

    def test_artifact_filter_excludes_working_state_directories(self) -> None:
        for path in (
            "_logs/llm/9f3c/attempt-1.partial.txt",
            "_logs/run_log.txt",
            "05_generation/_internal/figures_worklist.json",
            "05_generation/_status/progress.json",
            "_scratch/draft.md",
        ):
            with self.subTest(path=path):
                self.assertFalse(is_artifact_candidate(path))

    def test_artifact_filter_keeps_underscore_filenames_and_skill_deliverables(self) -> None:
        # The working-state convention is directory-scoped: a leading underscore on a
        # file name is the user's own naming, not agent scratch space.
        for path in (
            "_notes.md",
            "06_output/survey.md",
            "05_generation/section_drafts/intro.md",
            # Stage logs outside a working-state directory stay observable; the
            # presentation layer collapses them by artifact role instead of guessing
            # from file names here.
            "05_generation/run_log.txt",
        ):
            with self.subTest(path=path):
                self.assertTrue(is_artifact_candidate(path))

    def test_snapshot_skips_working_state_subtrees_and_keeps_deliverables(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codex-files-") as directory:
            workspace = Path(directory)
            output = workspace / "06_output"
            output.mkdir(parents=True)
            (output / "survey.md").write_text("# survey\n", encoding="utf-8")
            calls = workspace / "_logs" / "llm" / "9f3c"
            calls.mkdir(parents=True)
            for index in range(3):
                (calls / f"attempt-{index}.partial.txt").write_text("partial\n", encoding="utf-8")
            internal = workspace / "05_generation" / "_internal"
            internal.mkdir(parents=True)
            (internal / "figures_worklist.json").write_text("{}\n", encoding="utf-8")
            (workspace / "_notes.md").write_text("note\n", encoding="utf-8")

            snapshot = workspace_snapshot(workspace, lambda error: None)

            self.assertEqual(
                {Path(relative) for relative in snapshot},
                {Path("06_output/survey.md"), Path("_notes.md")},
            )

    def test_paths_stay_contained_and_explicit_changes_are_not_repeated(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codex-files-") as directory:
            workspace = Path(directory)
            (workspace / "result.py").write_text("print(1)\n", encoding="utf-8")
            self.assertEqual(workspace_relative_path(workspace, "result.py"), "result.py")
            self.assertEqual(workspace_relative_path(workspace, "../outside.py"), "")
            self.assertEqual(workspace_relative_path(workspace, ""), "")
            self.assertEqual(
                observed_changes(
                    workspace,
                    {"result.py": "add", "missing.py": "update"},
                    set(),
                ),
                [{"path": "result.py", "kind": "add", "diff": ""}],
            )
            self.assertEqual(
                observed_changes(workspace, {"result.py": "update"}, {"result.py"}), []
            )


class CodexInteractionContract(unittest.TestCase):
    def test_mcp_page_limit_rejects_non_positive_and_non_integer_values(self) -> None:
        self.assertEqual(_page_limit(None), 100)
        self.assertEqual(_page_limit(25), 25)
        for value in (True, False, 0, -1, 1.5, "25", [], {}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                _page_limit(value)

    def test_permission_scope_and_cancel_preserve_requested_permissions(self) -> None:
        method = "item/permissions/requestApproval"
        params = {"permissions": {"network": {"enabled": True}}}
        self.assertEqual(
            hil_response(method, params, False, "acceptForSession", {}),
            {"permissions": params["permissions"], "scope": "session"},
        )
        self.assertEqual(
            hil_response(method, params, True, "acceptForSession", {}),
            {"permissions": {}, "scope": "turn"},
        )

    def test_multiple_answers_keep_question_identity(self) -> None:
        method = "item/tool/requestUserInput"
        params = {"questions": [{"id": "language"}, {"id": "format"}]}
        response = {"answers": {"language": ["Python"], "format": {"answers": ["file"]}}}
        self.assertEqual(
            hil_response(method, params, False, "submit", response),
            {"answers": {"language": {"answers": ["Python"]}, "format": {"answers": ["file"]}}},
        )
        self.assertEqual(hil_response(method, params, True, "submit", response), {"answers": {}})

    def test_approval_prompt_keeps_native_decision_inventory_and_file_evidence(self) -> None:
        changes = [{"path": "result.py", "kind": "add"}]
        payload = hil_payload(
            "request-1",
            "item/fileChange/requestApproval",
            {"availableDecisions": ["accept", "decline"]},
            {"changes": changes},
        )
        self.assertEqual([option["id"] for option in payload["options"]], ["accept", "decline"])
        self.assertEqual(payload["path"], "result.py")
        self.assertEqual(payload["changes"], changes)


class CodexProxyContract(unittest.TestCase):
    def test_proxy_transport_preserves_platform_and_domain_boundaries(self) -> None:
        domain = "scholarseed.damo.alibaba.com"
        for platform in ("win32", "darwin", "linux"):
            for sandbox, parent in (
                ("workspace-write", ":workspace"),
                ("read-only", ":read-only"),
            ):
                for network_access in (False, True):
                    with (
                        self.subTest(
                            platform=platform, sandbox=sandbox, network_access=network_access
                        ),
                        patch("scholarseed_codex.permission.sys.platform", platform),
                    ):
                        profile, arguments = local_socket_permissions(
                            sandbox,
                            (),
                            network_domains=(domain,),
                            network_access=network_access,
                        )
                        self.assertEqual(arguments[0].option, "--strict-config")
                        config = tomllib.loads(
                            "\n".join(argument.value for argument in arguments[1:])
                        )
                        proxy = config["features"]["network_proxy"]
                        if platform == "win32":
                            self.assertIs(proxy.get("enable_socks5_udp"), False)
                        else:
                            self.assertNotIn("enable_socks5_udp", proxy)
                        self.assertNotIn("enable_socks5", proxy)
                        self.assertIs(proxy["enabled"], True)
                        self.assertEqual(proxy["domains"], {})
                        self.assertIs(proxy["allow_local_binding"], False)
                        self.assertIs(proxy["dangerously_allow_all_unix_sockets"], False)
                        permission = config["permissions"][profile]
                        self.assertEqual(permission["extends"], parent)
                        self.assertEqual(
                            permission["network"],
                            {
                                "enabled": True,
                                "mode": "full",
                                "domains": {"*" if network_access else domain: "allow"},
                                "unix_sockets": {},
                            },
                        )

    def test_unused_and_full_access_profiles_add_no_proxy_overrides(self) -> None:
        for platform in ("win32", "darwin", "linux"):
            with (
                self.subTest(platform=platform),
                patch("scholarseed_codex.permission.sys.platform", platform),
            ):
                self.assertEqual(local_socket_permissions("workspace-write", ()), ("", ()))
                self.assertEqual(local_socket_permissions("read-only", ()), ("", ()))
                self.assertEqual(
                    local_socket_permissions(
                        "danger-full-access",
                        (),
                        network_domains=("scholarseed.damo.alibaba.com",),
                    ),
                    ("", ()),
                )


class CodexWatchContract(unittest.IsolatedAsyncioTestCase):
    async def test_collaboration_completion_closes_started_receivers_without_stopping_agents(self):
        for receivers in (None, [], ["child-b", "child-c", "child-c"]):
            with self.subTest(receivers=receivers):
                self.events.clear()
                started = {
                    "id": "wait-one",
                    "type": "collabAgentToolCall",
                    "tool": "wait",
                    "receiverThreadIds": ["child-a", "child-b"],
                    "status": "inProgress",
                }
                await self.state.notification(
                    "item/started",
                    {"turnId": "turn", "item": started},
                    generation=1,
                )
                completed = {"id": "wait-one", "type": "collabAgentToolCall", "status": "timedOut"}
                completed["agentsStates"] = {
                    "child-a": {
                        "status": "running",
                        "message": "private transport diagnostic",
                    }
                }
                if receivers is not None:
                    completed["receiverThreadIds"] = receivers
                await self.state.notification(
                    "item/completed",
                    {"turnId": "turn", "item": completed},
                    generation=1,
                )
                closures = [
                    event
                    for event in self.events
                    if event.kind == CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED
                ]
                expected = {"child-a", "child-b", *(receivers or [])}
                self.assertEqual(
                    {event.item_id for event in closures},
                    {f"wait-one:{receiver}" for receiver in expected},
                )
                self.assertEqual(len(closures), len(expected))
                self.assertTrue(all(event.payload["status"] == "timedOut" for event in closures))
                self.assertTrue(all(event.payload["ok"] is False for event in closures))
                self.assertTrue(
                    all(event.payload["details"]["operation"] == "wait" for event in closures)
                )
                self.state._request.assert_not_awaited()
                self.assertNotIn("private transport diagnostic", str(closures))
                self.assertEqual(closures[0].payload["details"]["agent_status"], "running")
                await self.state.notification(
                    "item/started",
                    {"turnId": "turn", "item": {**started, "id": "wait-two"}},
                    generation=1,
                )
                self.assertEqual(
                    self.events[-1].kind, CodexSessionEventKind.NATIVE_ACTIVITY_STARTED
                )

    async def test_failed_terminal_projection_can_retry_authoritative_completion(self) -> None:
        self.state.active_turn_id = "retry-terminal"
        terminal = {"id": "retry-terminal", "status": "completed"}
        self.state._watcher.finish_turn = AsyncMock(side_effect=[OSError("scan failed"), None])
        with self.assertRaises(OSError):
            await self.state.notification("turn/completed", {"turn": terminal}, generation=1)
        self.assertFalse(self.state.turn_done.done())
        self.assertNotIn("retry-terminal", self.state._settled_turns)
        await self.state.notification("turn/completed", {"turn": terminal}, generation=1)
        self.assertTrue(self.state.turn_done.done())
        self.assertIn("retry-terminal", self.state._settled_turns)
        count = len(self.events)
        await self.state.notification(
            "turn/started", {"turn": {"id": "retry-terminal"}}, generation=1
        )
        self.assertEqual(len(self.events), count)
        self.assertEqual(self.state.active_turn_id, "")

    async def test_terminal_before_rpc_ack_does_not_revive_turn(self) -> None:
        self.state.turn_done = None

        async def request(method, params, *, generation, before_write, submission):
            before_write()
            submission.attempt()
            await self.state.notification(
                "turn/started", {"turn": {"id": "completed-before-ack"}}, generation=generation
            )
            await self.state.notification(
                "item/completed",
                {
                    "turnId": "completed-before-ack",
                    "item": {
                        "id": "answer",
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": "done",
                    },
                },
                generation=generation,
            )
            await self.state.notification(
                "turn/completed",
                {"turn": {"id": "completed-before-ack", "status": "completed"}},
                generation=generation,
            )
            return {"turn": {"id": "completed-before-ack"}}

        self.state._request = AsyncMock(side_effect=request)
        result = await self.state.start(TurnInput((InputItem(InputKind.TEXT, text="run"),)))
        self.assertEqual(result.status, TurnStatus.COMPLETED)
        self.assertEqual(result.final_text, "done")
        self.assertEqual(self.state.active_turn_id, "")
        count = len(self.events)
        await self.state.notification(
            "turn/completed", {"turn": {"id": result.turn_id, "status": "completed"}}, generation=1
        )
        self.assertEqual(len(self.events), count)
        self.assertEqual(self.host._router.turn_owner(result.turn_id), "")

    async def test_close_during_snapshot_prevents_submission_and_late_baseline(self) -> None:
        self.state.turn_done = None
        entered, release = asyncio.Event(), asyncio.Event()

        async def scan(*args):
            entered.set()
            await release.wait()
            return {}

        with patch("scholarseed_codex.watch.asyncio.to_thread", side_effect=scan):
            task = asyncio.create_task(
                self.state.start(TurnInput((InputItem(InputKind.TEXT, text="run"),)))
            )
            await entered.wait()
            await self.state.close(1, False)
            release.set()
            with self.assertRaises(AppServerError):
                await task
        self.state._request.assert_not_awaited()
        self.assertNotIn(self.state.thread_id, self.host._watcher._baselines)

    async def test_failed_terminal_keeps_files_written_before_failure(self) -> None:
        await self.host._watcher.begin_turn(self.state)
        (self.workspace / "partial.md").write_text("# partial\n", encoding="utf-8")
        self.state.active_turn_id = "failed-turn"
        await self.state.notification(
            "turn/completed", {"turn": {"id": "failed-turn", "status": "failed"}}, generation=1
        )
        self.assertNotIn(self.state.thread_id, self.host._watcher._baselines)
        file_event = next(
            event for event in self.events if event.kind is CodexSessionEventKind.FILE_CHANGED
        )
        self.assertEqual(
            file_event.payload,
            {
                "changes": [{"path": "partial.md", "kind": "add", "diff": ""}],
                "status": "completed",
            },
        )
        self.assertEqual(self.events[-1].kind, CodexSessionEventKind.TURN_FAILED)
        self.assertTrue(self.state.turn_done.done())

    async def test_content_policy_http_failure_survives_terminal_without_private_body(self) -> None:
        self.state.active_turn_id = "policy-turn"
        raw_error = (
            'unexpected status 400 Bad Request: {"error":{"code":"CONTENT_SAFETY_BLOCKED",'
            '"type":"content_policy_violation","message":"private text",'
            '"trace_id":"private-id"}}, url: https://private.example/v1/responses'
        )
        await self.state.notification(
            "error",
            {"turnId": "policy-turn", "willRetry": False, "error": {"message": raw_error}},
            generation=1,
        )
        await self.state.notification(
            "turn/completed",
            {"turn": {"id": "policy-turn", "status": "failed"}},
            generation=1,
        )
        self.assertEqual(self.events[-1].payload["error_code"], "CONTENT_SAFETY_BLOCKED")
        self.assertEqual(self.events[-3].incident.provider_error_code, "content_safety_blocked")
        self.assertEqual(self.events[-3].incident.provider_http_status, 400)
        self.assertEqual(
            self.events[-1].payload["retryability"], RuntimeRetryability.TERMINAL.value
        )
        self.assertNotIn("private", repr([event.payload for event in self.events[-3:]]))
        body = '{"error":{"code":"CONTENT_SAFETY_BLOCKED","message":"private"}}'
        for envelope in (
            body,
            {"message": body},
            {"message": "Bad request", "additionalDetails": body},
        ):
            self.assertEqual(provider_failure(envelope).code, "CONTENT_SAFETY_BLOCKED")
        for raw in (
            "CONTENT_SAFETY_BLOCKED in arbitrary prose",
            'unexpected status 503 Service Unavailable: {"error":{"code":"CONTENT_SAFETY_UNAVAILABLE"}}',
            "unexpected status 400 Bad Request: malformed",
        ):
            self.assertNotEqual(provider_failure(raw).code, "CONTENT_SAFETY_BLOCKED")

    async def test_content_policy_response_failure_signature_survives_terminal(self) -> None:
        self.state.active_turn_id = "policy-turn"
        error = {
            "code": "server_error",
            "message": (
                "<400> InternalError.Algo.DataInspectionFailed: "
                "Output data may contain inappropriate content."
            ),
        }
        await self.state.notification(
            "error",
            {
                "turnId": "policy-turn",
                "willRetry": True,
                "error": {"message": PROVIDER_CONTENT_POLICY_MESSAGE},
            },
            generation=1,
        )
        await self.state.notification(
            "turn/plan/updated",
            {"turnId": "policy-turn", "plan": []},
            generation=1,
        )
        self.assertEqual(self.state.provider_failure.code, "CONTENT_SAFETY_BLOCKED")
        await self.state.notification(
            "turn/completed",
            {"turn": {"id": "policy-turn", "status": "failed"}},
            generation=1,
        )
        self.assertEqual(self.events[-1].payload["error_code"], "CONTENT_SAFETY_BLOCKED")
        self.assertEqual(
            self.events[-1].payload["retryability"], RuntimeRetryability.TERMINAL.value
        )
        failure = provider_failure(error)
        self.assertEqual(failure.code, "CONTENT_SAFETY_BLOCKED")
        self.assertEqual(failure.http_status, 400)
        normalized_failure = provider_failure(
            {
                "code": "invalid_prompt",
                "message": PROVIDER_CONTENT_POLICY_MESSAGE,
            }
        )
        self.assertEqual(normalized_failure.code, "CONTENT_SAFETY_BLOCKED")
        self.assertEqual(normalized_failure.retryability, RuntimeRetryability.TERMINAL)
        self.assertEqual(
            provider_failure(
                {
                    "code": "server_error",
                    "message": "The model provider is unavailable.",
                }
            ).code,
            "server_error",
        )
        self.assertEqual(
            provider_failure(
                {
                    "code": "server_error",
                    "message": "Arbitrary prose InternalError.Algo.DataInspectionFailed",
                }
            ).code,
            "server_error",
        )

    async def test_provider_sse_failure_is_redacted_and_survives_sparse_terminal(self) -> None:
        self.state.active_turn_id = "quota-turn"
        raw_error = (
            "id:1\n"
            "event:error\n"
            ":HTTP_STATUS/429\n"
            'data:{"request_id":"private-request-id",'
            '"code":"Throttling.AllocationQuota",'
            '"message":"Allocated quota exceeded. https://private.example/help"}'
        )
        await self.state.notification(
            "error",
            {
                "turnId": "quota-turn",
                "willRetry": False,
                "error": {"message": raw_error},
            },
            generation=1,
        )
        await self.state.notification(
            "turn/completed",
            {"turn": {"id": "quota-turn", "status": "failed"}},
            generation=1,
        )

        detected, failed, terminal = self.events[-3:]
        self.assertEqual(
            detected.incident.safe_error, "The model provider allocation quota is exhausted."
        )
        self.assertEqual(failed.incident.safe_error, detected.incident.safe_error)
        self.assertEqual(failed.incident.retryability, RuntimeRetryability.TERMINAL)
        self.assertEqual(detected.incident.provider_http_status, 429)
        self.assertEqual(detected.incident.provider_error_code, "throttling.allocationquota")
        self.assertEqual(terminal.kind, CodexSessionEventKind.TURN_FAILED)
        self.assertEqual(terminal.payload["error_code"], "Throttling.AllocationQuota")
        self.assertEqual(terminal.payload["safe_error"], detected.incident.safe_error)
        self.assertEqual(terminal.payload["retryability"], RuntimeRetryability.TERMINAL.value)
        serialized = repr([event.payload for event in self.events[-3:]])
        self.assertNotIn("private-request-id", serialized)
        self.assertNotIn("private.example", serialized)
        self.assertNotIn("HTTP_STATUS", serialized)

    async def test_credit_balance_exhausted_is_terminal_with_product_safe_message(self) -> None:
        self.state.active_turn_id = "credits-turn"
        raw_error = (
            'unexpected status 429 Too Many Requests: {"error":{"code":"credit_balance_exhausted"}}'
        )
        await self.state.notification(
            "error",
            {"turnId": "credits-turn", "willRetry": False, "error": {"message": raw_error}},
            generation=1,
        )
        await self.state.notification(
            "turn/completed",
            {"turn": {"id": "credits-turn", "status": "failed"}},
            generation=1,
        )
        detected, failed, terminal = self.events[-3:]
        self.assertEqual(detected.incident.safe_error, PROVIDER_CREDITS_MESSAGE)
        self.assertEqual(failed.incident.retryability, RuntimeRetryability.TERMINAL)
        self.assertEqual(terminal.payload["error_code"], "credit_balance_exhausted")
        self.assertEqual(terminal.payload["safe_error"], PROVIDER_CREDITS_MESSAGE)
        self.assertEqual(terminal.payload["retryability"], RuntimeRetryability.TERMINAL.value)

    async def test_unstructured_429_uses_http_status_as_rate_limit_fallback(self) -> None:
        failure = provider_failure(
            {
                "message": (
                    'unexpected status 429 Too Many Requests: {"detail":"temporarily limited"}'
                )
            }
        )
        self.assertEqual(failure.code, "rate_limit_exceeded")
        self.assertEqual(failure.diagnostic_code, "rate_limit_exceeded")
        self.assertEqual(failure.http_status, 429)
        self.assertEqual(failure.retryability, RuntimeRetryability.USER_RETRYABLE)
        self.assertEqual(failure.message, "The model provider rate limit was reached.")

    async def test_invalid_parameter_is_terminal_with_model_config_message(self) -> None:
        """参数/模型类拒绝是确定性终态（防御性登记：码经恢复或上游修复到达 adapter 即生效）。"""

        self.state.active_turn_id = "model-config-turn"
        await self.state.notification(
            "error",
            {
                "turnId": "model-config-turn",
                "willRetry": False,
                "error": {
                    "code": "InvalidParameter",
                    "message": "Unsupported model: 'minimax-m2.1'",
                },
            },
            generation=1,
        )
        await self.state.notification(
            "turn/completed",
            {"turn": {"id": "model-config-turn", "status": "failed"}},
            generation=1,
        )
        terminal = self.events[-1]
        self.assertEqual(terminal.payload["error_code"], "InvalidParameter")
        self.assertEqual(terminal.payload["safe_error"], PROVIDER_MODEL_CONFIG_MESSAGE)
        self.assertEqual(terminal.payload["retryability"], RuntimeRetryability.TERMINAL.value)

    async def test_recovered_provider_retry_does_not_contaminate_later_failure(self) -> None:
        self.state.active_turn_id = "retry-turn"
        await self.state.notification(
            "error",
            {
                "turnId": "retry-turn",
                "willRetry": True,
                "error": {"code": "rate_limit_exceeded", "message": "retry later"},
            },
            generation=1,
        )
        await self.state.notification(
            "turn/plan/updated",
            {"turnId": "retry-turn", "plan": []},
            generation=1,
        )
        self.assertIsNone(self.state.provider_failure)
        await self.state.notification(
            "turn/completed",
            {"turn": {"id": "retry-turn", "status": "failed"}},
            generation=1,
        )
        terminal = self.events[-1]
        self.assertEqual(terminal.kind, CodexSessionEventKind.TURN_FAILED)
        self.assertEqual(terminal.payload["error_code"], "codex_provider_failed")
        self.assertNotEqual(terminal.payload["safe_error"], "retry later")
        self.assertNotIn("retry later", repr(self.events))

    async def test_official_quota_message_maps_to_terminal_provider_semantics(self) -> None:
        self.state.active_turn_id = "official-quota-turn"
        await self.state.notification(
            "error",
            {
                "turnId": "official-quota-turn",
                "willRetry": False,
                "error": {"message": "Quota exceeded. Check your plan and billing details."},
            },
            generation=1,
        )
        await self.state.notification(
            "turn/completed",
            {"turn": {"id": "official-quota-turn", "status": "failed"}},
            generation=1,
        )
        terminal = self.events[-1]
        self.assertEqual(terminal.payload["error_code"], "insufficient_quota")
        self.assertEqual(terminal.payload["retryability"], RuntimeRetryability.TERMINAL.value)

    async def test_lost_connection_fences_until_authoritative_resume(self) -> None:
        self.state.active_turn_id = "lost-turn"
        self.state.active_turn_client_id = "client"
        incident = RuntimeIncident(
            "lost",
            RuntimeIncidentScope.PROCESS,
            RuntimeIncidentState.DETECTED,
            RuntimeIncidentKind.PROCESS_EXIT,
            RuntimeRecoveryStrategy.AUTO_RESTART,
            RuntimeRetryability.IN_PROGRESS,
            "process_exit",
            process_generation=1,
        )
        await self.host._watcher.begin_turn(self.state)
        await self.state.connection_lost(incident, 1)
        self.assertEqual(self.state.interrupted_turn_id, "lost-turn")
        self.assertTrue(self.state.turn_done.done())
        self.assertNotIn(self.state.thread_id, self.host._watcher._baselines)
        with self.assertRaises(AppServerError):
            await self.state.start(TurnInput((InputItem(InputKind.TEXT, text="next"),)))
        count = len(self.events)
        await self.state.notification(
            "item/agentMessage/delta",
            {"turnId": "lost-turn", "itemId": "old", "delta": "late"},
            generation=2,
        )
        self.assertEqual(len(self.events), count)
        await self.state.reconcile(
            {"turns": [{"id": "lost-turn", "status": "interrupted", "items": []}]}, 2
        )
        self.assertEqual(self.state.interrupted_turn_id, "")
        self.assertEqual(self.state.resume_turns[-1].terminal_status, TurnStatus.INTERRUPTED)
        self.assertEqual(self.events[-1].payload["status"], "interrupted_turn_reconciled")

    async def test_ambiguous_resume_uses_normal_content_and_terminal(self) -> None:
        self.state.ambiguous_submission_id = "client"
        self.state.ambiguous_incident_id = "unknown"
        self.state.ambiguous_generation = 1
        turn = {
            "id": "recovered-turn",
            "status": "completed",
            "items": [
                {"type": "userMessage", "clientId": "client", "content": []},
                {
                    "type": "agentMessage",
                    "id": "answer",
                    "phase": "final_answer",
                    "text": "recovered",
                },
            ],
        }
        await self.state.reconcile({"turns": [turn]}, 2)
        kinds = [event.kind for event in self.events]
        self.assertEqual(
            kinds,
            [
                CodexSessionEventKind.ASSISTANT_DELTA,
                CodexSessionEventKind.ASSISTANT_COMPLETED,
                CodexSessionEventKind.TURN_COMPLETED,
            ],
        )
        self.assertEqual(self.state.ambiguous_incident_id, "")
        self.assertEqual(self.state.final_text, "recovered")
        self.assertEqual(self.state.active_turn_id, "")
        self.assertTrue(self.state.turn_done.done())

    async def test_turn_snapshot_discovers_nested_changes_without_native_notifications(
        self,
    ) -> None:
        nested = self.workspace / "outputs" / "nested"
        nested.mkdir(parents=True)
        unchanged = nested / "unchanged.py"
        unchanged.write_text("print(1)")
        changed = nested / "changed.py"
        changed.write_text("print(2)")
        await self.host._watcher.begin_turn(self.state)
        changed.write_text("print(333)")
        (nested / "new.py").write_text("print(4)")
        private = self.workspace / ".private"
        private.mkdir()
        (private / "secret.py").write_text("private")
        (nested / "linked.py").symlink_to(unchanged)
        await self.host._watcher.finish_turn(self.state)
        expected = {
            str(Path("outputs") / "nested" / "changed.py"): "update",
            str(Path("outputs") / "nested" / "new.py"): "add",
        }
        self.assertEqual(self.state.watched_paths, expected)

    async def test_invalid_input_preserves_previous_turn_state(self) -> None:
        self.state.final_text = "previous answer"
        self.state.item_output["previous-item"] = "previous output"
        self.state.turn_done = None
        self.state._ensure_attached = AsyncMock(return_value=1)
        self.state._request = AsyncMock()
        with self.assertRaises(AppServerError) as rejected:
            await self.state.start(TurnInput(()))
        self.assertEqual(rejected.exception.safe_error, "runtime_turn_not_submitted")
        self.assertIsInstance(rejected.exception.__cause__, ValueError)
        self.assertEqual(self.state.final_text, "previous answer")
        self.assertEqual(self.state.item_output, {"previous-item": "previous output"})
        self.assertIsNone(self.state.turn_done)
        self.state._request.assert_not_awaited()

    async def test_runtime_history_preserves_message_phase(self) -> None:
        session = CodexRuntimeSession.__new__(CodexRuntimeSession)
        session._request = SimpleNamespace(artifact_directives=())
        session._native = SimpleNamespace(
            history=(
                HistoryEntry("user", "question"),
                HistoryEntry("assistant", "working", "turn", "comment", MessagePhase.COMMENTARY),
                HistoryEntry("assistant", "done", "turn", "final", MessagePhase.FINAL_ANSWER),
            )
        )
        rows = await session.history()
        self.assertEqual([row["phase"] for row in rows], [None, "commentary", "final_answer"])

    async def test_message_delta_streams_before_official_phase_without_replaying_text(self) -> None:
        await self.state.notification(
            "item/agentMessage/delta",
            {"turnId": "turn", "itemId": "message", "delta": "正在检查。"},
            generation=1,
        )
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0].kind, CodexSessionEventKind.ASSISTANT_DELTA)
        self.assertEqual(self.events[0].payload, {"text": "正在检查。"})

        await self.state.notification(
            "item/started",
            {
                "turnId": "turn",
                "item": {
                    "id": "message",
                    "type": "agentMessage",
                    "phase": "commentary",
                },
            },
            generation=1,
        )

        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0].kind, CodexSessionEventKind.ASSISTANT_DELTA)
        self.assertEqual(self.events[0].payload, {"text": "正在检查。"})
        await self.state.notification(
            "item/agentMessage/delta",
            {"turnId": "turn", "itemId": "message", "delta": "继续检查。"},
            generation=1,
        )
        await self.state.notification(
            "item/completed",
            {
                "turnId": "turn",
                "item": {
                    "id": "message",
                    "type": "agentMessage",
                    "phase": "commentary",
                    "text": "正在检查。继续检查。",
                },
            },
            generation=1,
        )
        self.assertEqual(
            [event.kind for event in self.events],
            [
                CodexSessionEventKind.ASSISTANT_DELTA,
                CodexSessionEventKind.ASSISTANT_DELTA,
                CodexSessionEventKind.ASSISTANT_COMPLETED,
            ],
        )
        self.assertEqual(self.events[1].payload, {"text": "继续检查。", "phase": "commentary"})
        self.assertEqual(
            self.events[2].payload,
            {"text": "正在检查。继续检查。", "phase": "commentary"},
        )
        self.assertTrue(all(event.item_id == "message" for event in self.events))
        self.assertTrue(all(event.turn_id == "turn" for event in self.events))

    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="codex-watch-")
        self.workspace = Path(self.temporary.name)
        self.events: list[CodexSessionEvent] = []
        request = CodexSessionOpenRequest(
            request_id="watch-contract",
            runtime_id="codex",
            cwd=self.workspace,
        )
        self.host = CodexProcessHost(executable="codex")
        self.attachment = ThreadAttachment(
            request=request,
            listener=self.events.append,
            thread_id="thread-watch",
            attached_generation=1,
        )
        self.host._watcher = WorkspaceWatch(
            AsyncMock(return_value={}), self.host._diagnostics.append
        )
        self.state = self.make_turn(self.attachment)
        self.state.turn_done = asyncio.get_running_loop().create_future()
        self.attachment.turn = self.state
        self.host._threads[self.state.thread_id] = self.attachment
        await self.host._watcher.open(self.state, 1)

    def make_turn(self, attachment):
        return CodexTurnRuntime(
            attachment,
            request=AsyncMock(return_value={}),
            ensure_attached=AsyncMock(return_value=1),
            stale_requests=self.host._stale_requests,
            emitter=self.host._emitter,
            router=self.host._router,
            watcher=self.host._watcher,
            diagnostic=self.host._diagnostics.append,
            protocol_error=self.host._protocol_errors.append,
        )

    async def asyncTearDown(self) -> None:
        self.temporary.cleanup()

    async def test_changed_paths_add_regular_files_once_without_parsing_commands(self) -> None:
        generated = self.workspace / "generated.md"
        generated.write_text("# generated\n", encoding="utf-8")
        duplicate = self.workspace / "explicit.md"
        duplicate.write_text("# explicit\n", encoding="utf-8")
        python_file = self.workspace / "quick_sort.py"
        python_file.write_text("def quick_sort(values): return values\n", encoding="utf-8")
        private = self.workspace / ".scholarseed" / "state.json"
        private.parent.mkdir()
        private.write_text("{}\n", encoding="utf-8")
        self.state.explicit_file_paths.add("explicit.md")

        self.host._watcher.changed(
            {
                "watchId": self.state.fs_watch_id,
                "changedPaths": [
                    str(generated),
                    str(python_file),
                    str(duplicate),
                    str(private),
                    "/tmp/outside.md",
                ],
            }
        )
        await self.state._flush_watched_files("turn-1")

        self.assertEqual(len(self.events), 1)
        event = self.events[0]
        self.assertEqual(event.kind, CodexSessionEventKind.FILE_CHANGED)
        self.assertEqual(event.turn_id, "turn-1")
        self.assertEqual(
            event.payload,
            {
                "changes": [
                    {"path": "generated.md", "kind": "update", "diff": ""},
                    {"path": "quick_sort.py", "kind": "update", "diff": ""},
                ],
                "status": "completed",
            },
        )

    async def test_thread_watch_uses_official_app_server_request(self) -> None:
        request = AsyncMock(return_value={"path": str(self.workspace)})
        self.host._watcher = WorkspaceWatch(request, self.host._diagnostics.append)

        await self.host._watcher.open(self.state, 3)

        args = request.await_args
        self.assertEqual(args.args[0], "fs/watch")
        self.assertEqual(args.kwargs["generation"], 3)
        self.assertEqual(args.args[1]["path"], str(self.workspace.resolve()))
        self.assertEqual(args.args[1]["watchId"], self.state.fs_watch_id)

    async def test_watch_close_preserves_other_session_and_rejects_old_events(self) -> None:
        request = AsyncMock(return_value={})
        watcher = WorkspaceWatch(request, self.host._diagnostics.append)
        other = self.make_turn(
            ThreadAttachment(
                request=self.state.request, listener=self.events.append, thread_id="other-thread"
            )
        )
        other.turn_done = asyncio.get_running_loop().create_future()
        self.attachment.attached_generation = 4
        await watcher.open(self.state, 4)
        await watcher.open(other, 4)
        previous_id = self.state.fs_watch_id
        await watcher.close(self.state, 4, True)
        self.assertEqual(request.await_args.args, ("fs/unwatch", {"watchId": previous_id}))
        watcher.changed({"watchId": previous_id, "changedPaths": ["old.py"]})
        watcher.changed({"watchId": other.fs_watch_id, "changedPaths": ["other.py"]})
        self.assertFalse(self.state.watched_paths)
        self.assertEqual(list(other.watched_paths), ["other.py"])
        self.assertEqual(self.state.fs_watch_id, "")

    async def test_watch_reset_drops_routes_and_idle_turns_ignore_changes(self) -> None:
        watcher = self.host._watcher
        self.state.turn_done.set_result({})
        watcher.changed({"watchId": self.state.fs_watch_id, "changedPaths": ["idle.py"]})
        self.assertFalse(self.state.watched_paths)
        self.state.turn_done = asyncio.get_running_loop().create_future()
        watcher.reset()
        watcher.changed({"watchId": self.state.fs_watch_id, "changedPaths": ["stale.py"]})
        self.assertFalse(self.state.watched_paths)

    async def test_close_detached_watch_does_not_send_to_new_process(self) -> None:
        request = AsyncMock(return_value={})
        watcher = WorkspaceWatch(request, self.host._diagnostics.append)
        self.attachment.attached_generation = 1
        await watcher.open(self.state, 1)
        request.reset_mock()
        await watcher.close(self.state, 2, True)
        request.assert_not_awaited()
        self.assertEqual(self.state.fs_watch_id, "")

    async def test_native_python_file_change_translates_to_persisted_artifact_event(self) -> None:
        generated = self.workspace / "quick_sort.py"
        generated.write_text("def quick_sort(values): return values\n", encoding="utf-8")

        await self.state._item_completed(
            "turn-python",
            {
                "type": "fileChange",
                "id": "file-python",
                "status": "completed",
                "changes": [{"path": "quick_sort.py", "kind": "add", "diff": "+def quick_sort"}],
            },
        )

        file_event = next(
            event for event in self.events if event.kind is CodexSessionEventKind.FILE_CHANGED
        )
        translated = translate_event(
            file_event,
            product_session_id="product-python",
            process_generation=1,
        )
        self.assertIsInstance(translated, RuntimeEvent)
        assert isinstance(translated, RuntimeEvent)
        self.assertEqual(translated.kind, RuntimeEventKind.ARTIFACT_OBSERVED)
        self.assertEqual(translated.delivery, DeliveryClass.MUST_PERSIST)
        self.assertEqual(translated.payload["changes"][0]["path"], "quick_sort.py")

    async def test_local_file_input_exposes_its_exact_path_as_model_context(self) -> None:
        selected = self.workspace.parent / "用户选择.md"

        serialized = serialize_input(
            TurnInput(
                (
                    InputItem(InputKind.TEXT, text="概括附件"),
                    InputItem(
                        InputKind.FILE,
                        path=selected,
                        name=selected.name,
                    ),
                )
            ),
            self.workspace,
        )

        self.assertEqual(serialized[0], {"type": "text", "text": "概括附件"})
        self.assertEqual(serialized[1]["type"], "text")
        self.assertIn(
            json.dumps(str(selected.resolve()), ensure_ascii=False), serialized[1]["text"]
        )
        self.assertNotIn("mention", [item["type"] for item in serialized])

    async def test_thread_params_send_native_auto_reviewer(self) -> None:
        request = CodexSessionOpenRequest(
            request_id="auto-review-contract",
            runtime_id="codex",
            cwd=self.workspace,
            sandbox="workspace-write",
            approval_policy="on-request",
            approval_reviewer=CodexApprovalReviewer.AUTO_REVIEW,
        )

        params = self.host._thread_params(request, include_dynamic_tools=False)

        self.assertEqual(params["approvalPolicy"], "on-request")
        self.assertEqual(params["approvalsReviewer"], "auto_review")

    async def test_workspace_network_access_is_projected_to_native_sandbox(self) -> None:
        offline = replace(self.state.request, network_access=False)
        online = replace(self.state.request, network_access=True)

        self.assertFalse(sandbox_policy(offline)["networkAccess"])
        self.assertTrue(sandbox_policy(online)["networkAccess"])

    async def test_product_modes_map_to_three_native_permission_policies(self) -> None:
        ask = CODEX_PERMISSION_POLICIES[RuntimePermissionMode.ASK]
        safe_auto = CODEX_PERMISSION_POLICIES[RuntimePermissionMode.SAFE_AUTO]
        bypass = CODEX_PERMISSION_POLICIES[RuntimePermissionMode.BYPASS]

        self.assertEqual(
            (ask.sandbox, ask.approval_policy, ask.approval_reviewer),
            ("workspace-write", "on-request", CodexApprovalReviewer.USER),
        )
        self.assertEqual(
            (safe_auto.sandbox, safe_auto.approval_policy, safe_auto.approval_reviewer),
            ("workspace-write", "on-request", CodexApprovalReviewer.AUTO_REVIEW),
        )
        self.assertEqual(
            (bypass.sandbox, bypass.approval_policy, bypass.approval_reviewer),
            ("danger-full-access", "never", None),
        )

    async def test_local_grants_use_exact_native_socket_permissions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="grant-") as directory:
            endpoint = Path(directory) / "api.sock"
            if not hasattr(socket, "AF_UNIX"):
                # Windows has no native Unix socket in this Python build. A
                # same-named ordinary file must never qualify as a socket grant.
                endpoint.write_text("not a socket")
                with self.assertRaisesRegex(ValueError, "existing absolute Unix sockets"):
                    local_socket_permissions("workspace-write", (endpoint,))
                self.assertEqual(local_socket_permissions("workspace-write", ()), ("", ()))
                return
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as bound:
                bound.bind(str(endpoint))
                for sandbox, parent in (
                    ("workspace-write", ":workspace"),
                    ("read-only", ":read-only"),
                ):
                    profile, arguments = local_socket_permissions(sandbox, (endpoint,))
                    self.assertEqual(arguments[0].option, "--strict-config")
                    config = tomllib.loads("\n".join(arg.value for arg in arguments[1:]))
                    permission = config["permissions"][profile]
                    self.assertEqual(permission["extends"], parent)
                    self.assertEqual(
                        permission["network"]["unix_sockets"], {str(endpoint.resolve()): "allow"}
                    )
                    self.assertEqual(config["features"]["network_proxy"]["domains"], {})
                    self.assertFalse(
                        config["features"]["network_proxy"]["dangerously_allow_all_unix_sockets"]
                    )
                self.assertEqual(
                    local_socket_permissions("danger-full-access", (endpoint,)), ("", ())
                )
                self.assertEqual(local_socket_permissions("workspace-write", ()), ("", ()))
                domain = "scholarseed.damo.alibaba.com"
                profile, arguments = local_socket_permissions(
                    "workspace-write", (endpoint,), network_domains=(domain,)
                )
                config = tomllib.loads("\n".join(argument.value for argument in arguments[1:]))
                network = config["permissions"][profile]["network"]
                self.assertEqual(network["domains"], {domain: "allow"})
                self.assertEqual(network["unix_sockets"], {str(endpoint.resolve()): "allow"})
                profile, arguments = local_socket_permissions(
                    "workspace-write", (endpoint,), network_access=True
                )
                config = tomllib.loads("\n".join(arg.value for arg in arguments[1:]))
                network = config["permissions"][profile]["network"]
                self.assertEqual(network["mode"], "full")
                self.assertEqual(network["domains"], {"*": "allow"})
                self.assertEqual(network["unix_sockets"], {str(endpoint.resolve()): "allow"})
                with self.assertRaises(ValueError):
                    local_socket_permissions("workspace-write", (Path(directory),))
                with self.assertRaises(ValueError):
                    local_socket_permissions(
                        "workspace-write", (), network_domains=("*.damo.alibaba.com",)
                    )

    async def test_network_domain_grants_work_without_unix_sockets(self) -> None:
        domain = "scholarseed.damo.alibaba.com"
        profile, arguments = local_socket_permissions(
            "workspace-write", (), network_domains=(domain,)
        )
        config = tomllib.loads("\n".join(argument.value for argument in arguments[1:]))
        network = config["permissions"][profile]["network"]
        self.assertEqual(network["domains"], {domain: "allow"})
        self.assertEqual(network["unix_sockets"], {})
        self.assertEqual(network["mode"], "full")
        self.assertTrue(config["features"]["network_proxy"]["enabled"])

    async def test_local_profile_is_exclusive_on_thread_and_turn(self) -> None:
        request = replace(
            self.state.request,
            permissions_profile="local-services",
            writable_roots=(self.workspace / "extra",),
        )
        params = self.host._thread_params(request, include_dynamic_tools=False)
        self.assertNotIn("sandbox", params)
        self.assertEqual(params["permissions"], "local-services")
        self.assertEqual(
            params["runtimeWorkspaceRoots"],
            [str(self.workspace.resolve()), str((self.workspace / "extra").resolve())],
        )
        self.attachment.request = request
        self.attachment.writable_roots = [str((self.workspace / "later").resolve())]
        self.state.turn_done = None
        self.state._ensure_attached = AsyncMock(return_value=1)

        async def dispatch(method, payload, *, generation, before_write, submission):
            before_write()
            submission.attempt()
            self.assertEqual(method, "turn/start")
            self.assertNotIn("sandboxPolicy", payload)
            self.assertEqual(payload["permissions"], "local-services")
            self.assertEqual(
                payload["runtimeWorkspaceRoots"],
                [str(self.workspace.resolve()), str((self.workspace / "later").resolve())],
            )
            self.state.turn_done.set_result({"id": "local-turn", "status": "completed"})
            return {"turn": {"id": "local-turn"}}

        self.state._request = AsyncMock(side_effect=dispatch)
        await self.state.start(
            TurnInput((InputItem(InputKind.TEXT, text="check"),)),
        )

    async def test_auto_review_notifications_are_projected_as_native_activity(self) -> None:
        await self.host._handle_notification(
            "item/autoApprovalReview/started",
            {
                "threadId": self.state.thread_id,
                "turnId": "turn-review",
                "reviewId": "review-1",
                "action": {"type": "command", "command": "make test", "cwd": str(self.workspace)},
                "review": {"status": "inProgress"},
                "startedAtMs": 1,
            },
        )
        await self.host._handle_notification(
            "item/autoApprovalReview/completed",
            {
                "threadId": self.state.thread_id,
                "turnId": "turn-review",
                "reviewId": "review-1",
                "targetItemId": "item-command-1",
                "action": {"type": "command", "command": "make test", "cwd": str(self.workspace)},
                "review": {
                    "status": "approved",
                    "riskLevel": "low",
                    "userAuthorization": "medium",
                    "rationale": "repository test command",
                },
                "decisionSource": "agent",
                "startedAtMs": 1,
                "completedAtMs": 2,
            },
        )

        self.assertEqual(
            [event.kind for event in self.events],
            [
                CodexSessionEventKind.NATIVE_ACTIVITY_STARTED,
                CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED,
            ],
        )
        self.assertEqual(self.events[0].item_id, "review-1")
        self.assertEqual(self.events[1].payload["activity_type"], "approval_review")
        self.assertEqual(self.events[1].payload["status"], "approved")
        details = self.events[1].payload["details"]
        self.assertEqual(details["risk_level"], "low")
        # 上游 review/action 的语义字段一个都不能丢：这些是判断机器审批是否合理的唯一依据。
        self.assertEqual(
            details,
            {
                "action": {"type": "command", "command": "make test", "cwd": str(self.workspace)},
                "action_type": "command",
                "target_item_id": "item-command-1",
                "decision_source": "agent",
                "risk_level": "low",
                "user_authorization": "medium",
                "rationale": "repository test command",
                "review_duration_ms": 1,
            },
        )
        self.assertTrue(self.events[1].payload["ok"])

    async def test_strict_review_notification_is_projected_as_native_activity(self) -> None:
        await self.host._handle_notification(
            "autoApprovalReview/strictReviewRequired",
            {"threadId": self.state.thread_id, "turnId": "turn-review", "startedAtMs": 7},
        )

        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0].kind, CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED)
        self.assertEqual(self.events[0].item_id, "strict-review-7")
        self.assertEqual(self.events[0].payload["activity_type"], "approval_strict_review")
        self.assertEqual(self.events[0].payload["status"], "strict_review_required")
        self.assertEqual(self.events[0].payload["details"], {"started_at_ms": 7})

    def test_strict_review_item_ids_do_not_collide_within_a_turn(self) -> None:
        # 上游这个通知不带 reviewId，Serve 按 item id 去重：同一轮两次升级必须落到不同条目。
        first = strict_review_item_id({"startedAtMs": 11}, "turn-review")
        second = strict_review_item_id({"startedAtMs": 12}, "turn-review")

        self.assertNotEqual(first, second)
        self.assertEqual(strict_review_item_id({}, "turn-review"), "strict-review-turn-review")
        self.assertEqual(strict_review_payload({})["details"], {})

    async def test_guardian_warning_is_not_discarded(self) -> None:
        await self.host._handle_notification(
            "guardianWarning",
            {"threadId": self.state.thread_id, "message": "automatic review unavailable"},
        )

        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0].kind, CodexSessionEventKind.RUNTIME_WARNING)
        self.assertEqual(self.events[0].payload["message"], "automatic review unavailable")

    async def test_failed_auto_review_is_not_reported_as_successful(self) -> None:
        payload = auto_approval_payload(
            {"review": {"status": "denied", "riskLevel": "high"}},
            completed=True,
        )

        self.assertFalse(payload["ok"])


if __name__ == "__main__":
    unittest.main()
