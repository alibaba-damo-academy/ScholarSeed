"""Decode official Codex thread history without owning process or session state."""

from __future__ import annotations

from typing import Any, Mapping

from scholarseed_codex.protocol.state import _resolved_history_message_phase
from scholarseed_runtime.contract.history import HistoryEntry, ResumeTurnSnapshot, TurnStatus


def history_entries(thread: Mapping[str, Any]) -> tuple[HistoryEntry, ...]:
    entries: list[HistoryEntry] = []
    for turn in list(thread.get("turns") or []):
        turn_id = str(turn.get("id") or "")
        items = list(turn.get("items") or [])
        agent_indexes = [
            index
            for index, item in enumerate(items)
            if str(item.get("type") or "") == "agentMessage" and str(item.get("text") or "")
        ]
        final_agent_index = agent_indexes[-1] if agent_indexes else None
        for index, item in enumerate(items):
            item_type = str(item.get("type") or "")
            item_id = str(item.get("id") or "")
            if item_type == "userMessage":
                text = "\n".join(
                    str(content.get("text") or "")
                    for content in list(item.get("content") or [])
                    if str(content.get("type") or "") == "text" and str(content.get("text") or "")
                )
                if text:
                    entries.append(HistoryEntry("user", text, turn_id, item_id))
            elif item_type == "agentMessage":
                text = str(item.get("text") or "")
                if text:
                    phase = _resolved_history_message_phase(
                        item.get("phase"),
                        item_index=index,
                        final_agent_index=final_agent_index,
                        turn_status=str(turn.get("status") or ""),
                    )
                    entries.append(
                        HistoryEntry(
                            "assistant",
                            text,
                            turn_id,
                            item_id,
                            phase,
                        )
                    )
    return tuple(entries)


def resume_turn_snapshots(
    thread: Mapping[str, Any],
) -> tuple[ResumeTurnSnapshot, ...]:
    snapshots: list[ResumeTurnSnapshot] = []
    for raw_turn in list(thread.get("turns") or []):
        if not isinstance(raw_turn, Mapping):
            continue
        turn_id = str(raw_turn.get("id") or "")
        if not turn_id:
            continue
        client_id = str(raw_turn.get("clientId") or raw_turn.get("clientUserMessageId") or "")
        if not client_id:
            for raw_item in list(raw_turn.get("items") or []):
                if not isinstance(raw_item, Mapping):
                    continue
                if str(raw_item.get("type") or "") != "userMessage":
                    continue
                client_id = str(
                    raw_item.get("clientId") or raw_item.get("clientUserMessageId") or ""
                )
                if client_id:
                    break
        snapshots.append(
            ResumeTurnSnapshot(
                client_id=client_id,
                turn_id=turn_id,
                terminal_status=terminal_turn_status(str(raw_turn.get("status") or "")),
            )
        )
    return tuple(snapshots)


def terminal_turn_status(status: str) -> TurnStatus | None:
    if status == TurnStatus.COMPLETED.value:
        return TurnStatus.COMPLETED
    if status in {TurnStatus.INTERRUPTED.value, "cancelled"}:
        return TurnStatus.INTERRUPTED
    if status == TurnStatus.FAILED.value:
        return TurnStatus.FAILED
    return None


def replace_turn_snapshot(
    snapshots: tuple[ResumeTurnSnapshot, ...], replacement: ResumeTurnSnapshot
) -> tuple[ResumeTurnSnapshot, ...]:
    """Keep one authoritative recovery snapshot per native turn."""
    rows = [snapshot for snapshot in snapshots if snapshot.turn_id != replacement.turn_id]
    rows.append(replacement)
    return tuple(rows)
