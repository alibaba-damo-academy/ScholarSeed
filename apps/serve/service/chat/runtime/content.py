"""Project incremental Runtime text into product message snapshots."""

from __future__ import annotations


class MessageSnapshots:
    """Accumulate independently addressed messages; reasoning remains incremental."""

    def __init__(self) -> None:
        self._messages: dict[tuple[str, str], str] = {}

    def append(self, turn_id: str, item_id: str, delta: str) -> str:
        key = (turn_id, item_id)
        text = self._messages.get(key, "") + delta
        self._messages[key] = text
        return text

    def finish(self, turn_id: str, item_id: str) -> None:
        self._messages.pop((turn_id, item_id), None)

    def finish_turn(self, turn_id: str) -> None:
        for key in tuple(self._messages):
            if key[0] == turn_id:
                del self._messages[key]
