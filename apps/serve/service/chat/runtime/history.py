"""Product runtime history ownership."""

from __future__ import annotations

from scholarseed_runtime.contract.history import HistoryEntry


def _history_identity(entry: HistoryEntry) -> tuple[str, str]:
    return (entry.role, entry.text)


def _merge_history_entries(
    prefix: tuple[HistoryEntry, ...],
    current: tuple[HistoryEntry, ...],
) -> tuple[HistoryEntry, ...]:
    """Merge a carried transcript prefix with runtime history without duplication."""

    overlap_limit = min(len(prefix), len(current))
    for overlap in range(overlap_limit, 0, -1):
        prefix_tail = tuple(_history_identity(entry) for entry in prefix[-overlap:])
        current_head = tuple(_history_identity(entry) for entry in current[:overlap])
        if prefix_tail == current_head:
            return prefix + current[overlap:]
    return prefix + current
