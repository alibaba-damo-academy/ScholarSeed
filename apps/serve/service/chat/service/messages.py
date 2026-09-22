"""Registered, product-owned semantic references for durable user messages."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol


@dataclass(frozen=True)
class UserMessageReference:
    """One immutable model context block plus its display-safe surface projection."""

    source: str
    model_context: str
    surface_ref: Mapping[str, Any]


class UserMessageReferenceSource(Protocol):
    """Resolve mutable product composer state at message-admission time."""

    def user_message_references(self, *, session_id: str) -> tuple[UserMessageReference, ...]: ...


class UserMessageReferenceService:
    """Route a live session to its product-owned, server-authoritative reference source."""

    def __init__(self) -> None:
        self._sources: dict[str, UserMessageReferenceSource] = {}

    def register(self, *, work: str, source: UserMessageReferenceSource) -> None:
        if work in self._sources and self._sources[work] is not source:
            raise RuntimeError(f"user message reference source already registered for work {work}")
        self._sources[work] = source

    def snapshot(self, session: Any) -> tuple[UserMessageReference, ...]:
        source = self._sources.get(str(session.work))
        if source is None:
            return ()
        return source.user_message_references(session_id=str(session.id))


__all__ = [
    "UserMessageReference",
    "UserMessageReferenceService",
    "UserMessageReferenceSource",
]
