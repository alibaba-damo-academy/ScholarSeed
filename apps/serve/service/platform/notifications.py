"""Instance-owned, bounded invalidation delivery without idle database reads."""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass, field
from enum import Enum

HEARTBEAT_SECONDS = 15.0
MAX_PENDING_CHANGES = 256
GLOBAL_OWNER = ""
NOTIFICATION_PATH = "/api/serve/notifications/events"


class ChangeTopic(str, Enum):
    ATTENTION = "attention"
    SESSIONS = "sessions"
    PROJECTS = "projects"
    RECORDS = "records"
    LITERATURE = "literature"
    RESOURCES = "resources"


@dataclass(frozen=True)
class Change:
    topic: ChangeTopic
    owner: str = GLOBAL_OWNER
    subject: str = ""


@dataclass(eq=False)
class Subscription:
    owner: str
    loop: asyncio.AbstractEventLoop
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    pending: set[Change] = field(default_factory=set)
    reset: bool = False
    active: bool = True

    def accept(self, changes: tuple[Change, ...]) -> None:
        if not self.active:
            return
        for change in changes:
            if change.owner in (GLOBAL_OWNER, self.owner):
                self.pending.add(change)
        if len(self.pending) > MAX_PENDING_CHANGES:
            self.pending.clear()
            self.reset = True
        if self.pending or self.reset:
            self.wake.set()


class ChangeHub:
    def __init__(self, instance_id: str) -> None:
        self.instance_id = instance_id
        self._lock = threading.Lock()
        self._subscribers: set[Subscription] = set()

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def publish(self, changes: Iterable[Change]) -> None:
        batch = tuple(set(changes))
        if not batch:
            return
        with self._lock:
            for subscriber in self._subscribers:
                try:
                    subscriber.loop.call_soon_threadsafe(subscriber.accept, batch)
                except RuntimeError:
                    if not subscriber.loop.is_closed():
                        raise

    def _frame(self, event: str, changes: Iterable[Change] = ()) -> str:
        payload = {
            "instance_id": self.instance_id,
            "changes": [
                {"topic": change.topic.value, "subject": change.subject}
                for change in sorted(changes, key=lambda change: (change.topic, change.subject))
            ],
        }
        return f"event: {event}\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"

    async def events(self, owner: str) -> AsyncIterator[str]:
        subscriber = Subscription(owner, asyncio.get_running_loop())
        with self._lock:
            self._subscribers.add(subscriber)
        try:
            yield self._frame("ready")
            while True:
                try:
                    await asyncio.wait_for(subscriber.wake.wait(), HEARTBEAT_SECONDS)
                except TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                changes = tuple(subscriber.pending)
                reset = subscriber.reset
                subscriber.pending.clear()
                subscriber.reset = False
                subscriber.wake.clear()
                yield self._frame("ready" if reset else "changed", changes)
        finally:
            with self._lock:
                subscriber.active = False
                self._subscribers.discard(subscriber)
