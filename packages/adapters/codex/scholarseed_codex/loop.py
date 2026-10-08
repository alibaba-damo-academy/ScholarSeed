"""Detect a native turn that repeats an unchanged tool result."""

from __future__ import annotations

import json
from hashlib import sha256

from scholarseed_codex.protocol.session import CodexSessionEvent, CodexSessionEventKind

REPEATED_TOOL_LIMIT = 4


class ToolLoopGuard:
    def __init__(self) -> None:
        self._turn_id = ""
        self._inputs: dict[str, tuple[str, object]] = {}
        self._last_result = ""
        self._repetitions = 0
        self._tripped = False

    def observe(self, event: CodexSessionEvent) -> bool:
        if event.kind is CodexSessionEventKind.TURN_STARTED:
            self._turn_id = event.turn_id
            self._inputs.clear()
            self._last_result = ""
            self._repetitions = 0
            self._tripped = False
            return False
        if event.turn_id != self._turn_id or self._tripped:
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
        if started is None:
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
