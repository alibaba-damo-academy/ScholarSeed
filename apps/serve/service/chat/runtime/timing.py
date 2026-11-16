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


class InvocationTiming:
    """Monotonic invocation milestones; absent stream evidence remains unknown."""

    def __init__(self, *, clock: Callable[[], float] = perf_counter) -> None:
        self._clock = clock
        self._started = clock()
        self._dispatch: float | None = None
        self._first: float | None = None
        self._last: float | None = None
        self._result: float | None = None
        self._cleanup: float | None = None
        self._closed: float | None = None
        self._stages: dict[str, float] = {}

    def activation(self, sample: ActivationMeasurement) -> None:
        self._stages[sample.stage] = sample.duration_ms / MILLISECONDS_PER_SECOND

    def dispatch(self) -> None:
        self._dispatch = self._clock()

    def assistant_delta(self) -> None:
        observed = self._clock()
        if self._first is None:
            self._first = observed
        self._last = observed

    def complete(self) -> None:
        self._result = self._clock()

    def begin_cleanup(self) -> None:
        self._cleanup = self._clock()

    def close(self) -> None:
        self._closed = self._clock()

    @staticmethod
    def _elapsed(start: float | None, end: float | None) -> float | None:
        return None if start is None or end is None else end - start

    def payload(self) -> dict[str, object]:
        return {
            "stages_seconds": dict(self._stages),
            "activation_seconds": self._stages.get(ActivationStage.TOTAL.value),
            "dispatch_to_first_assistant_delta_seconds": self._elapsed(self._dispatch, self._first),
            "assistant_delta_stream_seconds": self._elapsed(self._first, self._last),
            "last_assistant_delta_to_result_seconds": self._elapsed(self._last, self._result),
            "dispatch_to_result_seconds": self._elapsed(self._dispatch, self._result),
            "cleanup_seconds": self._elapsed(self._cleanup, self._closed),
            "total_seconds": self._elapsed(self._started, self._closed),
        }
