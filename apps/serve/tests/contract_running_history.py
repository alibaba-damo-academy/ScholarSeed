"""Accepted native-Codex turn history survives renderer reconnect and cold resume."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from scholarseed_runtime.contract import CommandReceipt, CommandState
from scholarseed_runtime.contract.history import HistoryEntry
from service.chat.runtime.live import LiveSession
from service.chat.service.turns import TurnService

PASS = 0
FAIL = 0
USER_TEXT = "running-input history must survive reconnect"
ASSISTANT_TEXT = "history acknowledged"


class _SteeringAdapter:
    history: tuple[HistoryEntry, ...]
    capabilities = SimpleNamespace(steer=True)

    def __init__(self, entries: tuple[HistoryEntry, ...]) -> None:
        self.entries = entries
        self.inputs: list[Any] = []

    async def history(self):
        return [
            {
                "role": entry.role,
                "text": entry.text,
                "turn_id": entry.turn_id,
                "item_id": entry.item_id,
                "phase": entry.phase,
            }
            for entry in self.entries
        ]

    async def steer(self, request):
        self.inputs.append(request)
        return CommandReceipt(request.command_id, CommandState.ACCEPTED, "active-turn")


class _QueueCatalog:
    def __init__(self) -> None:
        self.rows: dict[str, SimpleNamespace] = {}

    @staticmethod
    def portable_history(_session_id: str) -> tuple:
        return ()

    def add(self, queued_message_id: str, body: dict) -> None:
        self.rows[queued_message_id] = SimpleNamespace(
            queued_message_id=queued_message_id,
            enqueue_seq=len(self.rows) + 1,
            operation_seq=None,
            state=SimpleNamespace(value="queued"),
            body=body,
            safe_error="",
            deadline=None,
            purpose="turn",
            created_at=1.0,
            updated_at=1.0,
        )

    def begin_queued_submission(self, _session_id: str, queued_message_id: str):
        row = self.rows.get(queued_message_id)
        if row is None:
            return None
        row.operation_seq = 1
        row.state = SimpleNamespace(value="submitting")
        return row

    def remove_queued_message(self, _session_id: str, queued_message_id: str) -> bool:
        return self.rows.pop(queued_message_id, None) is not None

    def fail_queued_submission(self, *_args, **_kwargs) -> None:
        return None


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


def live_with_history(entries: tuple[HistoryEntry, ...] = ()) -> LiveSession:
    live = object.__new__(LiveSession)
    live.adapter = _SteeringAdapter(entries)
    live.runtime_session = live.adapter
    live.id = "running-history-contract"
    live._catalog = _QueueCatalog()
    live._local_history = []
    live.interrupting = False
    live.terminating = False
    live.terminated = False
    live.current_task = None
    live.turn_lock = asyncio.Lock()
    live.steer_lock = asyncio.Lock()
    live.ledger = SimpleNamespace(active_turn_id="", has_unknown_outcome=False)
    # 这两个都是 LiveSession 上的方法, 直接赋值会被判 method-assign; 按实例打桩用 setattr。
    # publish 必须一起打掉: record_user_history 会发产品事件, 而这个用 object.__new__
    # 部分构造出来的 stub 没有 _events / id / runtime_id。
    setattr(live, "trace_turn_input", lambda *_args, **_kwargs: None)

    async def _publish(*_args: Any, **_kwargs: Any) -> None:
        return None

    setattr(live, "publish", _publish)
    return live


def test_live_projection() -> None:
    live = live_with_history()
    asyncio.run(live.record_user_history(USER_TEXT, turn_id="client-turn", item_id="user-item"))
    check(
        "accepted user input is reconnect-visible with correlation ids",
        live.history()
        == [
            {
                "kind": "user",
                "role": "user",
                "text": USER_TEXT,
                "turn_id": "client-turn",
                "item_id": "user-item",
                "refs": [],
                "origin": "turn",
            }
        ],
        str(live.history()),
    )
    live.add_assistant_history(ASSISTANT_TEXT, turn_id="vendor-turn", item_id="assistant-item")
    check(
        "terminal assistant text keeps its vendor correlation ids",
        live.history()[-1]
        == {
            "kind": "text",
            "role": "assistant",
            "text": ASSISTANT_TEXT,
            "turn_id": "vendor-turn",
            "item_id": "assistant-item",
        },
        str(live.history()),
    )


def test_cold_resume_projection() -> None:
    entries = (
        HistoryEntry("user", USER_TEXT, "turn-1", "item-user"),
        HistoryEntry("assistant", ASSISTANT_TEXT, "turn-1", "item-assistant"),
    )
    live = live_with_history(entries)
    asyncio.run(live.hydrate_runtime_history())
    projected = live.history()
    check(
        "cold resume projects typed vendor history with correlation ids",
        projected
        == [
            {
                "kind": "user",
                "role": "user",
                "text": USER_TEXT,
                "turn_id": "turn-1",
                "item_id": "item-user",
                "phase": None,
            },
            {
                "kind": "text",
                "role": "assistant",
                "text": ASSISTANT_TEXT,
                "turn_id": "turn-1",
                "item_id": "item-assistant",
                "phase": None,
            },
        ],
        str(projected),
    )


def test_side_input_uses_native_same_turn_steering() -> None:
    live = live_with_history()
    service = TurnService(
        {"session": live},
        SimpleNamespace(error=lambda *_args, **_kwargs: None),
    )

    async def exercise() -> tuple[dict, int]:
        live.ledger.active_turn_id = "active-turn"
        live.catalog.add(
            "queued-side",
            {
                "input": [{"type": "text", "text": "side"}],
                "client_user_message_id": "side-client",
            },
        )
        return await service.post(
            "session",
            {"queued_message_id": "queued-side"},
            side=True,
        )

    result, status = asyncio.run(exercise())
    adapter = live.adapter
    assert adapter is not None
    check(
        "running-session input uses Codex turn/steer and becomes reconnect-visible",
        status == 202
        and result
        == {
            "ok": True,
            "turn_id": "active-turn",
            "queued_message_id": "queued-side",
        }
        and live.history()
        == [
            {
                "kind": "user",
                "role": "user",
                "text": "side",
                "turn_id": "active-turn",
                "item_id": "side-client",
                "refs": [],
                "origin": "steer",
            }
        ]
        and len(adapter.inputs) == 1,
        str(result),
    )


def test_side_input_without_active_turn_fails_closed() -> None:
    live = live_with_history()
    result, status = asyncio.run(
        TurnService(
            {"session": live},
            SimpleNamespace(error=lambda *_args, **_kwargs: None),
        ).post(
            "session",
            {"queued_message_id": "missing"},
            side=True,
        )
    )
    check(
        "steering without an active Codex turn fails without fabricating history",
        status == 409 and result.get("error") == "turn_not_running" and live.history() == [],
        str(result),
    )


def main() -> int:
    test_live_projection()
    test_cold_resume_projection()
    test_side_input_uses_native_same_turn_steering()
    test_side_input_without_active_turn_fails_closed()
    print(f"\ncontract_running_history: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
