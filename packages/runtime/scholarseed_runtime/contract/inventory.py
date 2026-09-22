from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path


@dataclass(frozen=True)
class ReasoningEffort:
    value: str
    description: str = ""


@dataclass(frozen=True)
class ModelTier:
    tier_id: str
    name: str
    description: str = ""


@dataclass(frozen=True)
class ModelView:
    model_id: str
    model: str
    display_name: str
    description: str
    is_default: bool
    hidden: bool
    default_reasoning_effort: str
    input_modalities: tuple[str, ...] = ()
    supported_reasoning_efforts: tuple[ReasoningEffort, ...] = ()
    service_tiers: tuple[ModelTier, ...] = ()
    default_service_tier: str = ""
    supports_personality: bool = False


@dataclass(frozen=True)
class ModelInventory:
    models: tuple[ModelView, ...] = ()
    next_cursor: str = ""


class SkillAvailability(str, Enum):
    AVAILABLE = "available"
    DISABLED = "disabled"
    ERROR = "error"


@dataclass(frozen=True)
class SkillDependency:
    kind: str
    value: str
    description: str = ""
    command: str = ""
    transport: str = ""
    url: str = ""


@dataclass(frozen=True)
class SkillError:
    path: Path
    message: str


@dataclass(frozen=True)
class SkillView:
    name: str
    path: Path
    description: str
    availability: SkillAvailability
    enabled: bool
    scope: str = ""
    short_description: str = ""
    display_name: str = ""
    dependencies: tuple[SkillDependency, ...] = ()


@dataclass(frozen=True)
class SkillInventory:
    cwd: Path
    skills: tuple[SkillView, ...] = ()
    errors: tuple[SkillError, ...] = ()
    revision: str = ""
