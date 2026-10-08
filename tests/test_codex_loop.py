"""Contract checks for unchanged tool-result loop detection."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from scholarseed_codex.loop import REPEATED_TOOL_LIMIT, ToolLoopGuard
from scholarseed_codex.protocol.session import CodexSessionEvent, CodexSessionEventKind
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_runtime.contract import RuntimeEventKind
from scholarseed_runtime.contract.incident import RuntimeIncidentKind


def _event(
    kind: CodexSessionEventKind,
    *,
    turn_id: str = "turn-1",
    item_id: str = "",
    payload: dict | None = None,
) -> CodexSessionEvent:
    return CodexSessionEvent(
        runtime_id="codex",
        session_id="session-1",
        kind=kind,
        turn_id=turn_id,
        item_id=item_id,
        payload=payload or {},
    )


def _tool(
    guard: ToolLoopGuard,
    item_id: str,
    *,
    command: str = "ls -la literature",
    output: str = "total 0",
) -> bool:
    guard.observe(
        _event(
            CodexSessionEventKind.TOOL_STARTED,
            item_id=item_id,
            payload={"name": "exec_command", "input": {"command": command}},
        )
    )
    return guard.observe(
        _event(
            CodexSessionEventKind.TOOL_COMPLETED,
            item_id=item_id,
            payload={"name": "exec_command", "output": output, "ok": True},
        )
    )


def test_unchanged_tool_result_trips_once_at_limit() -> None:
    guard = ToolLoopGuard()
    guard.observe(_event(CodexSessionEventKind.TURN_STARTED))
    for index in range(REPEATED_TOOL_LIMIT - 1):
        assert not _tool(guard, f"item-{index}")
    assert _tool(guard, "last-item")
    assert not _tool(guard, "extra-item")


def test_changed_input_or_output_resets_streak() -> None:
    guard = ToolLoopGuard()
    guard.observe(_event(CodexSessionEventKind.TURN_STARTED))
    for index in range(REPEATED_TOOL_LIMIT - 1):
        assert not _tool(guard, f"poll-{index}", output=str(index))
    assert not _tool(guard, "different-command", command="ls -la papers")
    assert not _tool(guard, "different-output", output="one paper")


def test_new_turn_does_not_inherit_previous_streak() -> None:
    guard = ToolLoopGuard()
    guard.observe(_event(CodexSessionEventKind.TURN_STARTED))
    for index in range(REPEATED_TOOL_LIMIT - 1):
        assert not _tool(guard, f"first-{index}")
    guard.observe(_event(CodexSessionEventKind.TURN_STARTED, turn_id="turn-2"))
    assert not guard.observe(
        _event(
            CodexSessionEventKind.TOOL_COMPLETED,
            item_id="first-0",
            payload={"name": "exec_command", "output": "total 0", "ok": True},
        )
    )


async def test_repeated_native_results_publish_incident_and_interrupt_once() -> None:
    session = object.__new__(CodexRuntimeSession)
    interruption = AsyncMock()
    session._activity_revision = 0
    session._sequence = 0
    session._evidence_sequence = 0
    session._event_namespace = "test-attachment"
    session._seen_subagents = set()
    session._active_command_id = "command-1"
    session._committed_commands = set()
    session._loop_guard = ToolLoopGuard()
    session._events = asyncio.Queue()
    session._tasks = set()
    session._request = SimpleNamespace(product_session_id="product-1")
    session._observe_evidence = AsyncMock()
    session._native = SimpleNamespace(
        session_id="native-1",
        active_turn_id="turn-1",
        host=SimpleNamespace(
            readiness=SimpleNamespace(process_generation=1),
            attachment=Mock(
                return_value=SimpleNamespace(turn=SimpleNamespace(interrupt=interruption))
            ),
        ),
    )
    await session._on_native_event(_event(CodexSessionEventKind.TURN_STARTED))
    for index in range(REPEATED_TOOL_LIMIT + 1):
        item_id = f"tool-{index}"
        await session._on_native_event(
            _event(
                CodexSessionEventKind.TOOL_STARTED,
                item_id=item_id,
                payload={"name": "exec_command", "input": {"command": "ls -la literature"}},
            )
        )
        await session._on_native_event(
            _event(
                CodexSessionEventKind.TOOL_COMPLETED,
                item_id=item_id,
                payload={"name": "exec_command", "output": "total 0", "ok": True},
            )
        )
    await asyncio.gather(*session._tasks)
    observations = [session._events.get_nowait() for _ in range(session._events.qsize())]
    incidents = [event for event in observations if event.kind is RuntimeEventKind.RUNTIME_INCIDENT]
    assert len(incidents) == 1
    assert incidents[0].payload["incident"]["kind"] == RuntimeIncidentKind.REPEATED_TOOL_LOOP.value
    assert incidents[0].native_turn_id == "turn-1"
    interruption.assert_awaited_once()
