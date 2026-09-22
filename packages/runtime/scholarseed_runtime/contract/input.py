from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path


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
class TurnInput:
    items: tuple[InputItem, ...]
    client_user_message_id: str = ""
    collaboration_mode: CollaborationMode = CollaborationMode.DEFAULT
    model: str = ""
