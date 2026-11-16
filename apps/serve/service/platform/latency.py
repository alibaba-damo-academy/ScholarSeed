"""Bounded, content-free observation of the existing HTTP execution path."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import threading
import time
from enum import StrEnum
from pathlib import Path
from types import TracebackType
from typing import Any
from uuid import uuid4

from anyio import CapacityLimiter
from anyio.to_thread import current_default_thread_limiter
from starlette.types import Scope

LOGGER_NAME = "service.platform.latency"
REQUEST_LATENCY_KEY = "http_latency"
LOOP_SAMPLE_SECONDS = 0.25
LOOP_LAG_WARNING_SECONDS = 0.5
SLOW_HEADERS_WARNING_SECONDS = 0.5
MILLISECONDS_PER_SECOND = 1000
UNMATCHED_ROUTE = "unmatched"
DIAGNOSTIC_HEADER = b"x-scholarseed-diagnostic-id"
DIAGNOSTIC_ID_LENGTH = 32
DIAGNOSTIC_ID_ALPHABET = b"0123456789abcdef"
ORIGIN_HEADER = b"origin"
CORS_ORIGIN_HEADER = b"access-control-allow-origin"
TIMING_ORIGIN_HEADER = b"timing-allow-origin"
LOOP_THREAD_NAME = "http-loop-monitor"
LOOP_STACK_LIMIT = 12
LOOP_JOIN_POLL_SECONDS = 0.01

logger = logging.getLogger(LOGGER_NAME)


class LoopMonitor:
    def __init__(
        self, *, interval: float = LOOP_SAMPLE_SECONDS, threshold: float = LOOP_LAG_WARNING_SECONDS
    ) -> None:
        self.interval = interval
        self.threshold = threshold
        self.thread: threading.Thread | None = None
        self.timer: asyncio.TimerHandle | None = None
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.heartbeat = 0.0
        self.heartbeatAt = 0.0
        self.loopThread = 0
        self.episode: str | None = None
        self.lastEpisode: str | None = None
        self.lastStallAt: float | None = None
        self.lastLagMs = 0.0

    async def __aenter__(self) -> LoopMonitor:
        if logger.isEnabledFor(logging.DEBUG):
            self.stopped.clear()
            self.loopThread = threading.get_ident()
            self.heartbeat = time.perf_counter()
            self.heartbeatAt = time.time()
            self.thread = threading.Thread(target=self._watch, name=LOOP_THREAD_NAME, daemon=True)
            self.thread.start()
            self._arm()
        return self

    async def __aexit__(self, *errors: Any) -> None:
        self.stopped.set()
        if self.timer is not None:
            self.timer.cancel()
        while self.thread is not None and self.thread.is_alive():
            await asyncio.sleep(LOOP_JOIN_POLL_SECONDS)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "loop_stall_id": self.lastEpisode,
                "loop_stall_started_at": self.lastStallAt,
                "process_loop_lag_ms": round(self.lastLagMs, 3),
                "loop_heartbeat_at": self.heartbeatAt or None,
            }

    def _arm(self) -> None:
        self.timer = asyncio.get_running_loop().call_later(self.interval, self._beat)

    def _beat(self) -> None:
        now = time.perf_counter()
        recovered = None
        with self.lock:
            lag = max(0.0, now - self.heartbeat - self.interval)
            if lag >= self.threshold:
                self.lastEpisode = self.episode or uuid4().hex
                self.lastStallAt = self.heartbeatAt
                self.lastLagMs = lag * MILLISECONDS_PER_SECOND
                recovered = {
                    "event": "loop_recovered",
                    **self._state(),
                    "recovered_at": time.time(),
                }
            self.episode = None
            self.heartbeat = now
            self.heartbeatAt = time.time()
        if recovered is not None:
            logger.warning(json.dumps(recovered, separators=(",", ":")))
        if not self.stopped.is_set():
            self._arm()

    def _state(self) -> dict[str, Any]:
        return {
            "loop_stall_id": self.lastEpisode,
            "loop_stall_started_at": self.lastStallAt,
            "process_loop_lag_ms": round(self.lastLagMs, 3),
        }

    def _watch(self) -> None:
        while not self.stopped.wait(self.interval):
            with self.lock:
                lag = time.perf_counter() - self.heartbeat - self.interval
                if lag < self.threshold or self.episode is not None:
                    continue
                self.episode = uuid4().hex
                self.lastEpisode = self.episode
                self.lastStallAt = self.heartbeatAt
                self.lastLagMs = lag * MILLISECONDS_PER_SECOND
                payload = {
                    "event": "loop_stall",
                    **self._state(),
                    "detected_at": time.time(),
                }
            stack: list[dict[str, str | int]] = []
            frame = sys._current_frames().get(self.loopThread)
            try:
                while frame is not None and len(stack) < LOOP_STACK_LIMIT:
                    stack.append(
                        {
                            "file": Path(frame.f_code.co_filename).name,
                            "function": frame.f_code.co_name,
                            "line": frame.f_lineno,
                        }
                    )
                    frame = frame.f_back
            finally:
                del frame
            payload["stack"] = stack
            logger.warning(json.dumps(payload, separators=(",", ":")))


class LatencyEvent(StrEnum):
    RECEIVED = "received"
    HEADERS = "headers"
    FINISHED = "finished"
    LOOP_LAG = "loop_lag"


class RequestLatency:
    def __init__(
        self,
        scope: Scope,
        *,
        interval: float = LOOP_SAMPLE_SECONDS,
        loopThreshold: float = LOOP_LAG_WARNING_SECONDS,
        headersThreshold: float = SLOW_HEADERS_WARNING_SECONDS,
        monitor: LoopMonitor | None = None,
    ) -> None:
        self.scope = scope
        self.interval = interval
        self.loopThreshold = loopThreshold
        self.headersThreshold = headersThreshold
        self.monitor = monitor
        self.enabled = logger.isEnabledFor(logging.DEBUG) or logger.isEnabledFor(logging.WARNING)
        self.requestId = uuid4().hex if self.enabled else None
        candidates = [
            value for name, value in scope.get("headers", []) if name == DIAGNOSTIC_HEADER
        ]
        candidate = candidates[0] if len(candidates) == 1 else b""
        self.clientRequestId = (
            candidate.decode("ascii")
            if len(candidate) == DIAGNOSTIC_ID_LENGTH
            and all(value in DIAGNOSTIC_ID_ALPHABET for value in candidate)
            else None
        )
        self.startedAt = time.time()
        self.started = time.perf_counter()
        self.deadline = self.started + interval
        self.active = False
        self.timer: asyncio.TimerHandle | None = None
        self.status: int | None = None
        self.headersMs: float | None = None
        self.identityWaitMs: float | None = None
        self.identityRunMs: float | None = None
        self.identityQueuedAt: float | None = None
        self.identityStartedAt: float | None = None
        self.identityFinishedMs: float | None = None
        self.identityResumedMs: float | None = None
        self.threadWaitersPeak = 0
        self.threadBorrowedPeak = 0
        self.loopLagMs = 0.0
        self.reportedLagMs = 0.0
        self.limiter: CapacityLimiter | None = None

    def __enter__(self) -> RequestLatency:
        self.active = True
        self.scope.setdefault("state", {})[REQUEST_LATENCY_KEY] = self
        if self.enabled:
            self.limiter = current_default_thread_limiter()
            self._samplePool()
            self._emit(LatencyEvent.RECEIVED)
            self._arm()
        return self

    def __exit__(
        self,
        errorType: type[BaseException] | None,
        error: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._sample()
        self.active = False
        if self.timer is not None:
            self.timer.cancel()
        self._emit(LatencyEvent.FINISHED, errorType.__name__ if errorType else "")

    def identityQueued(self) -> None:
        if self.enabled:
            self.identityQueuedAt = time.perf_counter()

    def identityStarted(self) -> None:
        if not self.enabled:
            return
        self.identityStartedAt = time.perf_counter()
        if self.identityQueuedAt is not None:
            self.identityWaitMs = (
                self.identityStartedAt - self.identityQueuedAt
            ) * MILLISECONDS_PER_SECOND

    def identityFinished(self) -> None:
        if not self.enabled:
            return
        self.identityFinishedMs = (time.perf_counter() - self.started) * MILLISECONDS_PER_SECOND
        if self.identityStartedAt is not None:
            self.identityRunMs = (
                time.perf_counter() - self.identityStartedAt
            ) * MILLISECONDS_PER_SECOND

    def identityResumed(self) -> None:
        if self.enabled:
            self.identityResumedMs = (time.perf_counter() - self.started) * MILLISECONDS_PER_SECOND

    def timingHeaders(self, headers: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
        origins = [value for name, value in self.scope.get("headers", []) if name == ORIGIN_HEADER]
        if (
            self.clientRequestId is not None
            and len(origins) == 1
            and origins[0] != b"*"
            and (CORS_ORIGIN_HEADER, origins[0]) in headers
            and not any(name == TIMING_ORIGIN_HEADER for name, _value in headers)
        ):
            return [*headers, (TIMING_ORIGIN_HEADER, origins[0])]
        return headers

    def headers(self, status: int) -> None:
        if not self.enabled:
            return
        self.status = status
        self.headersMs = (time.perf_counter() - self.started) * MILLISECONDS_PER_SECOND
        self._sample()
        self._emit(LatencyEvent.HEADERS)

    def _arm(self) -> None:
        self.deadline = time.perf_counter() + self.interval
        self.timer = asyncio.get_running_loop().call_later(self.interval, self._tick)

    def _tick(self) -> None:
        if self.active:
            self._sample()
            self._arm()

    def _sample(self) -> None:
        if not self.enabled:
            return
        self._samplePool()
        delay = max(0.0, time.perf_counter() - self.deadline) * MILLISECONDS_PER_SECOND
        self.loopLagMs = max(self.loopLagMs, delay)
        if delay >= self.loopThreshold * MILLISECONDS_PER_SECOND and delay > self.reportedLagMs:
            self.reportedLagMs = delay
            self._emit(LatencyEvent.LOOP_LAG)

    def _samplePool(self) -> None:
        if self.limiter is None:
            return
        statistics = self.limiter.statistics()
        self.threadWaitersPeak = max(self.threadWaitersPeak, statistics.tasks_waiting)
        self.threadBorrowedPeak = max(self.threadBorrowedPeak, statistics.borrowed_tokens)

    def _emit(self, event: LatencyEvent, errorType: str = "") -> None:
        slowHeaders = (
            event is LatencyEvent.HEADERS
            and self.headersMs is not None
            and self.headersMs >= self.headersThreshold * MILLISECONDS_PER_SECOND
        )
        level = (
            logging.WARNING
            if event is LatencyEvent.LOOP_LAG or slowHeaders or errorType
            else logging.INFO if self.clientRequestId is not None else logging.DEBUG
        )
        if not self.enabled or not logger.isEnabledFor(level) or self.limiter is None:
            return
        route = (
            None
            if event is LatencyEvent.RECEIVED
            else getattr(
                self.scope.get("route"),
                "path",
                UNMATCHED_ROUTE if self.status is not None else None,
            )
        )
        statistics = self.limiter.statistics()
        payload = {
            "event": event.value,
            "request_id": self.requestId,
            "client_request_id": self.clientRequestId,
            "method": self.scope.get("method", ""),
            "route": route,
            "started_at": self.startedAt,
            "elapsed_ms": round((time.perf_counter() - self.started) * MILLISECONDS_PER_SECOND, 3),
            "headers_ms": self.headersMs,
            "identity_wait_ms": self.identityWaitMs,
            "identity_run_ms": self.identityRunMs,
            "identity_queued_ms": (
                (self.identityQueuedAt - self.started) * MILLISECONDS_PER_SECOND
                if self.identityQueuedAt is not None
                else None
            ),
            "identity_started_ms": (
                (self.identityStartedAt - self.started) * MILLISECONDS_PER_SECOND
                if self.identityStartedAt is not None
                else None
            ),
            "identity_finished_ms": self.identityFinishedMs,
            "identity_resumed_ms": self.identityResumedMs,
            "loop_lag_ms": round(self.loopLagMs, 3),
            "loop_sample_ms": self.interval * MILLISECONDS_PER_SECOND,
            "loop_warning_ms": self.loopThreshold * MILLISECONDS_PER_SECOND,
            "headers_warning_ms": self.headersThreshold * MILLISECONDS_PER_SECOND,
            "thread_tokens": statistics.total_tokens,
            "thread_borrowed": statistics.borrowed_tokens,
            "thread_waiters": statistics.tasks_waiting,
            "thread_waiters_peak": self.threadWaitersPeak,
            "thread_borrowed_peak": self.threadBorrowedPeak,
            "status": self.status,
            "error_type": errorType,
            **(self.monitor.snapshot() if self.monitor is not None else {}),
        }
        logger.log(level, json.dumps(payload, separators=(",", ":")))


def requestLatency(scope: Scope) -> RequestLatency | None:
    observation: Any = scope.get("state", {}).get(REQUEST_LATENCY_KEY)
    return observation if isinstance(observation, RequestLatency) else None
