"""Request-scoped activation timing without business state or sensitive payloads."""

from __future__ import annotations

import asyncio
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from time import perf_counter
from typing import Callable, Iterator

MILLISECONDS_PER_SECOND = 1000


class ActivationStage(str, Enum):
    TOTAL = "activation.total"
    READINESS = "activation.readiness"
    LOCK_WAIT = "activation.lock_wait"
    LIFECYCLE_LOCK_WAIT = "activation.lifecycle_lock_wait"
    SKILLS = "activation.skills"
    PLAN = "activation.plan"
    ADMISSION = "activation.admission"
    ATTACH = "activation.attach"


class TimingStatus(str, Enum):
    OK = "ok"
    ERROR = "error"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class ActivationMeasurement:
    stage: str
    activation_id: str
    request_id: str
    span_id: str
    parent_span_id: str | None
    started_at: datetime
    duration_ms: float
    status: TimingStatus
    failure_type: str


class ActivationTiming:
    def __init__(self, request_id: str, record: Callable[[ActivationMeasurement], None]) -> None:
        self._request_id = request_id
        self._activation_id = uuid.uuid4().hex
        self._record = record
        self._parent: ContextVar[str | None] = ContextVar("activation_parent", default=None)
        self._root_span_id: str | None = None

    @contextmanager
    def measure(self, stage: str) -> Iterator[None]:
        span_id = uuid.uuid4().hex
        parent_span_id = self._parent.get() or self._root_span_id
        if self._root_span_id is None:
            self._root_span_id = span_id
        token = self._parent.set(span_id)
        started_at = datetime.now(timezone.utc)
        started = perf_counter()
        status = TimingStatus.OK
        failure_type = ""
        try:
            yield
        except BaseException as error:
            status = (
                TimingStatus.CANCELLED
                if isinstance(error, asyncio.CancelledError)
                else TimingStatus.ERROR
            )
            failure_type = type(error).__name__
            raise
        finally:
            duration_ms = (perf_counter() - started) * MILLISECONDS_PER_SECOND
            self._parent.reset(token)
            self._record(
                ActivationMeasurement(
                    stage,
                    self._activation_id,
                    self._request_id,
                    span_id,
                    parent_span_id,
                    started_at,
                    duration_ms,
                    status,
                    failure_type,
                )
            )
