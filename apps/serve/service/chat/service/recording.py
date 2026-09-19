"""Default-on session recording with explicit overrides in the product event stream."""

from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass
from enum import Enum
from pathlib import Path
from typing import Callable

from damoatrace.recording.budget import ContentBudget
from service.brand import PRODUCT_SLUG
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal
from service.chat.persistence.events import ProductEventStore

POLICY_EVENT = "session.diagnostic_policy"
NEXT_SUBMISSION = "next_submission"


class RecordingMode(str, Enum):
    METADATA = "metadata"
    DETAILED = "detailed"


class PolicyConflict(ValueError):
    """The caller must refresh its view before changing consent."""


@dataclass(frozen=True)
class RecordingPolicy:
    mode: str = RecordingMode.METADATA.value
    revision: int = 0
    consented_at: float = 0
    expires_at: float = 0
    effective_from_submission: str = NEXT_SUBMISSION

    @property
    def active(self) -> bool:
        return self.mode == RecordingMode.DETAILED.value

    def payload(self) -> dict:
        return {**asdict(self), "active": self.active}


class RecordingService:
    def __init__(self, catalog: SessionCatalogStore, events: ProductEventStore) -> None:
        self.catalog = catalog
        self.events = events
        self.guard = threading.RLock()
        self._invalidations: dict[str, Callable[[], None]] = {}
        self._budgets: dict[Path, ContentBudget] = {}

    def budget(self, directory: Path) -> ContentBudget:
        directory = directory.expanduser().resolve()
        with self.guard:
            if directory not in self._budgets:
                self._budgets[directory] = ContentBudget(
                    directory, pattern=f"{PRODUCT_SLUG}-*.jsonl"
                )
            return self._budgets[directory]

    def bind(self, session_id: str, invalidate: Callable[[], None]) -> None:
        self._invalidations[session_id] = invalidate

    def unbind(self, session_id: str) -> None:
        self._invalidations.pop(session_id, None)

    def current(self, session_id: str) -> RecordingPolicy:
        event = self.events.latest_kind(session_id, POLICY_EVENT)
        return (
            RecordingPolicy(**event.payload)
            if event
            else RecordingPolicy(mode=RecordingMode.DETAILED.value)
        )

    def require(self, session_id: str, principal: SessionPrincipal) -> RecordingPolicy:
        self.catalog.require(session_id, principal)
        return self.current(session_id)

    def update(
        self,
        session_id: str,
        principal: SessionPrincipal,
        *,
        mode: RecordingMode,
        expected_revision: int,
    ) -> RecordingPolicy:
        self.catalog.require(session_id, principal)
        record = self.catalog.get(session_id)
        if record is None:
            raise ValueError("session no longer exists")
        if not record.vendor_thread_id:
            raise ValueError("请先在此会话发送一条消息，再开启详细诊断")
        with self.guard, self.events.transaction() as connection:
            previous = self.events.latest_kind(session_id, POLICY_EVENT, connection=connection)
            revision = int(previous.payload["revision"]) if previous else 0
            if revision != expected_revision:
                raise PolicyConflict("诊断设置已变化，请刷新后重试")
            now = time.time()
            policy = RecordingPolicy(
                mode=mode.value,
                revision=revision + 1,
                consented_at=now,
            )
            self.events.append(
                session_id=session_id,
                runtime_id=record.runtime_id,
                vendor_thread_id=record.vendor_thread_id,
                vendor_turn_id=None,
                vendor_item_id=None,
                kind=POLICY_EVENT,
                payload=asdict(policy),
                idempotency_key=f"{POLICY_EVENT}:{policy.revision}",
                connection=connection,
            )
            invalidate = self._invalidations.get(session_id)
            if invalidate:
                invalidate()
        return policy
