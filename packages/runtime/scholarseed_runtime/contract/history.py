from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class TurnStatus(str, Enum):
    COMPLETED = "completed"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


class MessagePhase(str, Enum):
    """Vendor-neutral phase for user-visible assistant messages."""

    COMMENTARY = "commentary"
    FINAL_ANSWER = "final_answer"


@dataclass(frozen=True)
class HistoryEntry:
    role: str
    text: str
    turn_id: str = ""
    item_id: str = ""
    phase: MessagePhase | None = None


@dataclass(frozen=True)
class ResumeTurnSnapshot:
    """Authoritative vendor turn identity projected by thread/resume."""

    client_id: str
    turn_id: str
    terminal_status: TurnStatus | None = None
