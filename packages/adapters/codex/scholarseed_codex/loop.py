"""Detect a native turn that repeats an unchanged tool result."""

from __future__ import annotations

import json
from hashlib import sha256

from scholarseed_codex.protocol.session import CodexSessionEvent, CodexSessionEventKind

REPEATED_TOOL_LIMIT = 4
TURN_TERMINALS = frozenset(
    {
        CodexSessionEventKind.TURN_COMPLETED,
        CodexSessionEventKind.TURN_FAILED,
        CodexSessionEventKind.TURN_INTERRUPTED,
    }
)


class ToolLoopGuard:
    def __init__(self) -> None:
        self._turn_id = ""
        self._inputs: dict[str, tuple[str, object]] = {}
        self._callbacks: dict[str, str] = {}
        self._correction_items: set[str] = set()
        self._last_result = ""
        self._repetitions = 0
        self._tripped = False

    def respond(self, request_id: str, *, allow_correction: bool) -> tuple[str, str] | None:
        item_id = self._callbacks.pop(request_id, None)
        if item_id is None or not allow_correction:
            return None
        self._correction_items.add(item_id)
        return self._turn_id, item_id

    def discard_correction(self, marker: tuple[str, str] | None) -> None:
        if marker is not None and marker[0] == self._turn_id:
            self._correction_items.discard(marker[1])

    def observe(self, event: CodexSessionEvent) -> bool:
        starts = event.kind is CodexSessionEventKind.TURN_STARTED
        ends = event.kind in TURN_TERMINALS and event.turn_id == self._turn_id
        if starts or ends:
            self._turn_id = event.turn_id if starts else ""
            self._inputs.clear()
            self._callbacks.clear()
            self._correction_items.clear()
            self._last_result = ""
            self._repetitions = 0
            self._tripped = False
            return False
        if not self._turn_id or event.turn_id != self._turn_id or self._tripped:
            return False
        if event.kind is CodexSessionEventKind.DYNAMIC_TOOL_REQUESTED:
            request_id = event.payload.get("request_id")
            if isinstance(request_id, str) and request_id and event.item_id:
                self._callbacks[request_id] = event.item_id
            return False
        if event.kind is CodexSessionEventKind.TOOL_STARTED:
            self._inputs[event.item_id] = (
                str(event.payload.get("name") or ""),
                event.payload.get("input"),
            )
            return False
        if event.kind is not CodexSessionEventKind.TOOL_COMPLETED:
            return False
        started = self._inputs.pop(event.item_id, None)
        allows_correction = event.item_id in self._correction_items
        self._correction_items.discard(event.item_id)
        if started is None or (allows_correction and event.payload.get("ok") is False):
            self._last_result = ""
            self._repetitions = 0
            return False
        signature = sha256(
            json.dumps(
                (
                    started[0],
                    started[1],
                    bool(event.payload.get("ok")),
                    str(event.payload.get("output") or ""),
                ),
                ensure_ascii=False,
                sort_keys=True,
                default=str,
            ).encode("utf-8")
        ).hexdigest()
        self._repetitions = self._repetitions + 1 if signature == self._last_result else 1
        self._last_result = signature
        self._tripped = self._repetitions >= REPEATED_TOOL_LIMIT
        return self._tripped
