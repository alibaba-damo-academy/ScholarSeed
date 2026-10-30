from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Awaitable, Callable

TURN_ADMISSION_STALE = "runtime_turn_admission_stale"


@dataclass(frozen=True)
class TurnAdmission:
    """Host authority rechecked synchronously at the fenced transport commit boundary."""

    generation: str
    revision: int
    watermark: int
    current: Callable[[], bool]


class InputKind(str, Enum):
    TEXT = "text"
    LOCAL_IMAGE = "local_image"
    FILE = "file"
    DIRECTORY = "directory"
    SKILL = "skill"


class CollaborationMode(str, Enum):
    """Native runtime collaboration preset selected for one turn."""

    DEFAULT = "default"
    PLAN = "plan"


@dataclass(frozen=True)
class InputItem:
    kind: InputKind
    text: str = ""
    path: Path | None = None
    name: str = ""


@dataclass(frozen=True)
class SubmissionRetry:
    failed_generation: int
    process_generation: int
    deadline: float
    attempts: int


@dataclass(frozen=True)
class TurnInput:
    items: tuple[InputItem, ...]
    client_user_message_id: str = ""
    collaboration_mode: CollaborationMode = CollaborationMode.DEFAULT
    model: str = ""
    admission: TurnAdmission | None = None
    submission_deadline: float | None = None
    submission_attempts: int = 0
    retry_observer: Callable[[SubmissionRetry], Awaitable[Callable[[], bool]]] | None = None
