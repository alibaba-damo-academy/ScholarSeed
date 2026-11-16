"""Authenticated, frozen execution context for tool-free generation."""

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scholarseed_runtime.contract import ModelThinking
from service.platform.activity import ActivityLease
from service.platform.inference import ReasoningPolicy


@dataclass(frozen=True)
class GenerationScope:
    identity: object
    id: str
    bridge_token: str
    bridge_activity: ActivityLease | None
    publication_turn_id: str
    user_id: str
    runtime_workdir: Path
    model_id: str
    reasoning_effort: str
    thinking: ModelThinking | None
    process_environment: Mapping[str, str]
    current: Callable[[], bool]
    attached: Callable[[], bool]
    publish: Callable[..., Awaitable[Any]]
    reasoning_policy: ReasoningPolicy = ReasoningPolicy.DEFAULT
