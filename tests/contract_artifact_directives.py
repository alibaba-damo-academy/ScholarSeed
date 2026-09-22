"""Deterministic declaration protocol checks, not product acceptance."""

from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from scholarseed_codex.directive import DIRECTIVE_LINE_MAX_CHARS, parse_declarations
from scholarseed_codex.emitter import CodexEmitter
from scholarseed_codex.protocol.session import (
    CodexSessionEvent,
    CodexSessionEventKind,
    CodexSessionOpenRequest,
)
from scholarseed_codex.router import ThreadRouter
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_codex.turn import CodexTurnRuntime
from scholarseed_codex.watch import WorkspaceWatch
from scholarseed_runtime.contract.artifact import ArtifactDirectiveSpec, ArtifactRole
from scholarseed_runtime.contract.command import OpenSessionRequest
from scholarseed_runtime.contract.event import DeliveryClass, RuntimeEventKind

SPEC = (ArtifactDirectiveSpec("preview"),)


class DeclarationContract(unittest.TestCase):
    def session(self) -> CodexRuntimeSession:
        temporary = tempfile.TemporaryDirectory(prefix="artifact-directive-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        with patch("scholarseed_codex.session.prepare_codex_runtime_home", return_value=root):
            return CodexRuntimeSession(
                OpenSessionRequest("product", root, artifact_directives=SPEC)
            )

    def parse(self, text: str, identity: str = "thread:turn:item"):
        return parse_declarations(text, SPEC, message_identity=identity)

    def test_roles_escaping_and_stable_identity(self):
        text = '完成\r\n::preview{file="结果.csv" title="过程\\"数据"}\r\n'
        result = self.parse(text)
        self.assertEqual(result.text, "完成")
        self.assertEqual(result.declarations[0].title, '过程"数据')
        self.assertEqual(result.declarations[0].role, ArtifactRole.INTERMEDIATE)
        self.assertEqual(result.declarations, self.parse(text).declarations)
        self.assertNotEqual(result.declarations, self.parse(text, "other-item").declarations)
        for role in ArtifactRole:
            value = self.parse(f'::preview{{file="a" role="{role.value}"}}')
            self.assertEqual(value.declarations[0].role, role)

    def test_examples_are_not_commands(self):
        examples = [
            '```ruby\n::preview{file="a"}\n```',
            '~~~~\n::preview{file="a"}\n~~~\n::preview{file="b"}\n~~~~',
            '`::preview{file="a"}`',
            '> ::preview{file="a"}',
            '    ::preview{file="a"}',
            '\t::preview{file="a"}',
            '说明 ::preview{file="a"}',
            '::preview-other{file="a"}',
        ]
        for source in examples:
            with self.subTest(source=source):
                result = self.parse(source)
                self.assertEqual(result.text, source)
                self.assertFalse(result.declarations)
                self.assertFalse(result.failures)

    def test_malformed_input_has_explicit_failure(self):
        malformed = [
            '::preview{file="a" file="b"}',
            '::preview{file="a" bogus="b"}',
            '::preview{file="a" role="published"}',
            '::preview{title="missing file"}',
            '::preview{file=""}',
            '::preview{file="a"title="b"}',
            '::preview{file="a" sha256="invalid"}',
            '::preview{file="a\\nsecret"}',
            '::preview{file="\\ud800"}',
            '::preview{file="a" title="\\udfff"}',
            "::preview{file=",
            '::preview{file="a"} trailing',
            '::preview{file="' + "x" * DIRECTIVE_LINE_MAX_CHARS + '"}',
        ]
        for source in malformed:
            with self.subTest(source=source[:100]):
                result = self.parse(source)
                self.assertFalse(result.declarations)
                self.assertEqual(len(result.failures), 1)

    def test_disabled_specs_leave_text_intact(self):
        source = '::preview{file="a"}'
        result = parse_declarations(source, (), message_identity="item")
        self.assertEqual(result.text, source)
        self.assertFalse(result.declarations)

    def test_recovered_streamed_message_still_completes(self):
        async def scenario(streamed: bool):
            state = SimpleNamespace(
                thread_id="thread",
                listener=None,
                request=CodexSessionOpenRequest(
                    request_id="recovery", runtime_id="codex", cwd=Path.cwd()
                ),
                attached_generation=1,
                model="",
                writable_roots=(),
            )
            emitter = CodexEmitter()
            emitter.emit = AsyncMock()
            runtime = CodexTurnRuntime(
                state,
                request=AsyncMock(),
                ensure_attached=AsyncMock(return_value=1),
                stale_requests=AsyncMock(),
                emitter=emitter,
                router=ThreadRouter(),
                watcher=WorkspaceWatch(AsyncMock(), lambda message: None),
                diagnostic=lambda message: None,
                protocol_error=lambda message: None,
            )
            runtime._turn_completed = AsyncMock()
            runtime.ambiguous_submission_id = "submission"
            runtime.ambiguous_incident_id = "incident"
            runtime.streamed_messages = {"message"} if streamed else set()
            runtime.final_text = "prefix"
            text = 'Report ready\n::preview{file="report.md" role="final"}'
            turn = {
                "id": "turn",
                "status": "completed",
                "items": [
                    {"type": "userMessage", "clientId": "submission"},
                    {
                        "type": "agentMessage",
                        "id": "message",
                        "text": text,
                        "phase": "final_answer",
                    },
                ],
            }
            await runtime._reconcile_ambiguous_from_thread({"turns": [turn]})
            calls = emitter.emit.call_args_list
            kinds = [call.args[1] for call in calls]
            expected = [CodexSessionEventKind.ASSISTANT_COMPLETED]
            if not streamed:
                expected.insert(0, CodexSessionEventKind.ASSISTANT_DELTA)
            self.assertEqual(kinds, expected)
            self.assertEqual(calls[-1].kwargs["payload"]["text"], text)
            self.assertEqual(calls[-1].kwargs["item_id"], "message")
            self.assertEqual(runtime.final_text, text)
            runtime._turn_completed.assert_awaited_once_with(turn)

        for streamed in (False, True):
            with self.subTest(streamed=streamed):
                asyncio.run(scenario(streamed))

    def test_history_cleans_assistant_declarations_without_republishing(self):
        session = self.session()
        declaration = '::preview{file="report.md" role="final"}'
        texts = [declaration, "Ready\n" + declaration, "```\n" + declaration + "\n```"]
        session._native = SimpleNamespace(
            history=[
                SimpleNamespace(
                    role=role, text=text, phase=None, turn_id="turn", item_id=str(index)
                )
                for index, (role, text) in enumerate(zip(["user", "assistant", "assistant"], texts))
            ]
        )
        history = asyncio.run(session.history())
        self.assertEqual([entry["text"] for entry in history], [texts[0], "Ready", texts[2]])
        self.assertTrue(session._events.empty())
        self.assertEqual(session._native.history[1].text, texts[1])

    def test_complete_native_item_is_authoritative(self):
        async def scenario():
            session = self.session()
            session._active_command_id = "command"
            session._committed_commands = {"command"}
            session._native = SimpleNamespace(
                host=SimpleNamespace(readiness=SimpleNamespace(process_generation=1)),
                process_events=(),
                rpc_evidence=(),
            )
            for kind, text in (
                (CodexSessionEventKind.ASSISTANT_DELTA, "provisional"),
                (
                    CodexSessionEventKind.ASSISTANT_COMPLETED,
                    '最终正文\n::preview{file="report.md" role="final"}',
                ),
                (CodexSessionEventKind.TURN_COMPLETED, ""),
            ):
                await session._on_native_event(
                    CodexSessionEvent(
                        "codex",
                        "native",
                        kind,
                        turn_id="turn",
                        item_id="item",
                        vendor_seq=100,
                        payload={"text": text, "phase": "final_answer"},
                    )
                )
            return [session._events.get_nowait() for _ in range(session._events.qsize())]

        events = asyncio.run(scenario())
        self.assertEqual([event.sequence for event in events], [1, 2, 3, 4])
        self.assertEqual(
            [event.kind for event in events],
            [
                RuntimeEventKind.CONTENT_DELTA,
                RuntimeEventKind.CONTENT_COMPLETED,
                RuntimeEventKind.ARTIFACT_DECLARED,
                RuntimeEventKind.TURN_COMPLETED,
            ],
        )
        self.assertEqual(events[1].payload["text"], "最终正文")
        self.assertEqual(events[2].payload["role"], "final")
        self.assertEqual(events[2].causation_id, events[1].event_id)
        self.assertEqual(events[2].delivery, DeliveryClass.MUST_PERSIST)
        self.assertEqual(events[2].correlation_id, "command")


if __name__ == "__main__":
    unittest.main()
