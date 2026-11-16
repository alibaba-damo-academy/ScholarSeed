"""Accepted native-Codex turn history survives renderer reconnect and cold resume."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import Mock, patch

from scholarseed_runtime.contract import CommandReceipt, CommandState, RuntimeEventKind
from scholarseed_runtime.contract.history import HistoryEntry
from service.chat.constants import PRODUCT_INTERACTION_BLOCKING
from service.chat.persistence.catalog import (
    HilStatus,
    QueuedMessageRecord,
    QueuedMessageState,
    SessionCatalogStore,
    SessionHilRecord,
    SubmissionMode,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.live import LiveSession
from service.chat.service.turns import TurnService
from service.platform.activity import Activities

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
        self.rows: dict[str, QueuedMessageRecord] = {}
        self.pending_settlement: SimpleNamespace | None = None
        self.pending_interactions: tuple[SessionHilRecord, ...] = ()

    def get(self, _session_id: str) -> None:
        return None

    def activation(self, _session_id: str) -> None:
        return None

    def uncertainties(self, _session_id: str) -> tuple:
        return ()

    def pending_turn_settlement(self, _session_id: str) -> SimpleNamespace | None:
        return self.pending_settlement

    def pending_hil(self, _session_id: str, *, blocking_only: bool = True) -> tuple:
        return tuple(
            row
            for row in self.pending_interactions
            if not blocking_only or row.payload.get(PRODUCT_INTERACTION_BLOCKING, True)
        )

    def queued_message(self, _session_id: str, queued_message_id: str):
        return self.rows.get(queued_message_id)

    def restore_queued_submission(self, _session_id: str, queued: QueuedMessageRecord):
        restored = replace(self.rows[queued.queued_message_id], state=queued.state)
        self.rows[queued.queued_message_id] = restored
        return restored

    @staticmethod
    def portable_history(_session_id: str) -> tuple:
        return ()

    def add(self, queued_message_id: str, body: dict) -> None:
        self.rows[queued_message_id] = QueuedMessageRecord(
            queued_message_id=queued_message_id,
            session_id="running-history-contract",
            enqueue_seq=len(self.rows) + 1,
            operation_seq=None,
            state=QueuedMessageState.QUEUED,
            body=body,
            safe_error="",
            deadline=None,
            purpose="turn",
            submission_mode=SubmissionMode.QUEUED,
            safe_error_details={},
            native_turn_id="",
            created_at=1.0,
            updated_at=1.0,
        )

    def begin_queued_submission(self, _session_id: str, queued_message_id: str):
        row = self.rows.get(queued_message_id)
        if row is None:
            return None
        submitted = replace(row, operation_seq=1, state=QueuedMessageState.SUBMITTING)
        self.rows[queued_message_id] = submitted
        return submitted

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
    events = Mock(spec=ProductEventStore)
    events.by_key.return_value = None
    events.model_runs.return_value = {}
    events.replay.return_value = ()
    with patch("service.chat.runtime.live.PersistenceWorker"):
        live = LiveSession(
            session_id="running-history-contract",
            runtime_id="codex",
            runtime_workdir=Path(__file__).parent,
            project_path=None,
            output_root=Path(__file__).parent,
            model_id="test",
            catalog=cast(SessionCatalogStore, _QueueCatalog()),
            events=events,
            artifacts=Mock(),
            skills=Mock(),
            logger=Mock(),
            trace=Mock(),
        )
    live.adapter = _SteeringAdapter(entries)
    live.runtime_session = live.adapter
    live.ledger = SimpleNamespace(active_turn_id="", has_unknown_outcome=False)
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
        activities=Activities(),
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
            {"queued_message_id": "queued-side", "expected_turn_id": "active-turn"},
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
            activities=Activities(),
        ).post(
            "session",
            {"queued_message_id": "missing", "expected_turn_id": "active-turn"},
            side=True,
        )
    )
    check(
        "steering without an active Codex turn fails without fabricating history",
        status == 200 and result.get("retained") is True and live.history() == [],
        str(result),
    )


def test_side_input_waits_for_pending_settlement() -> None:
    live = live_with_history()
    live.ledger.active_turn_id = "active-turn"
    live.catalog.pending_settlement = SimpleNamespace(
        client_turn_id="unsettled", event=SimpleNamespace(kind=RuntimeEventKind.TURN_UNKNOWN)
    )
    live.catalog.add("queued-side", {"input": [{"type": "text", "text": "side"}]})
    result, status = asyncio.run(
        TurnService(
            {"session": live},
            SimpleNamespace(error=lambda *_args, **_kwargs: None),
            activities=Activities(),
        ).post(
            "session",
            {"queued_message_id": "queued-side", "expected_turn_id": "active-turn"},
            side=True,
        )
    )
    check(
        "pending settlement rejects steering without consuming the queue or publishing history",
        status == 409
        and result.get("error") == "turn_outcome_unconfirmed"
        and live.catalog.rows["queued-side"].state.value == "queued"
        and live.adapter.inputs == []
        and live.history() == [],
        str(result),
    )


def test_steer_keeps_original_target_across_submission() -> None:
    for transition in ("ended", "stopped", "waiting", "next-turn"):
        live = live_with_history()
        queue = cast(_QueueCatalog, live.catalog)
        live.ledger.active_turn_id = "active-turn"
        live.catalog.add(
            "queued-side",
            {"input": [{"type": "text", "text": "side"}], "client_user_message_id": "side-client"},
        )

        async def persist(function, *args, **kwargs):
            return function(*args, **kwargs)

        async def publish(event, *_args, transition=transition, live=live, queue=queue, **_kwargs):
            if event != "send_now_submitted":
                return
            if transition == "ended":
                live.ledger.active_turn_id = ""
            elif transition == "stopped":
                live.interrupting = True
            elif transition == "waiting":
                queue.pending_interactions = (
                    SessionHilRecord(
                        product_request_id="approval",
                        session_id=live.id,
                        vendor_request_id="vendor-approval",
                        payload={},
                        vendor_turn_id="active-turn",
                        vendor_item_id="",
                        method="",
                        status=HilStatus.PENDING,
                        decision=None,
                        created_at=1.0,
                        resolved_at=None,
                    ),
                )
            else:
                live.ledger.active_turn_id = "next-turn"

        setattr(live, "publish", publish)
        live._persistence = SimpleNamespace(run=persist)
        result, status = asyncio.run(
            TurnService(
                {"session": live},
                SimpleNamespace(error=lambda *_args, **_kwargs: None),
                activities=Activities(),
            ).post(
                "session",
                {"queued_message_id": "queued-side", "expected_turn_id": "active-turn"},
                side=True,
            )
        )
        check(
            f"{transition} during steering retains the original queue without submitting to another turn",
            status == 200
            and result.get("retained") is True
            and live.catalog.rows["queued-side"].state is QueuedMessageState.QUEUED
            and not live.adapter.inputs
            and not live.history(),
            str(result),
        )


def main() -> int:
    test_live_projection()
    test_cold_resume_projection()
    test_side_input_uses_native_same_turn_steering()
    test_side_input_without_active_turn_fails_closed()
    test_side_input_waits_for_pending_settlement()
    test_steer_keeps_original_target_across_submission()
    print(f"\ncontract_running_history: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
