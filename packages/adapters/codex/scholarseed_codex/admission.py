"""Event-loop-owned admission fence for configuration changes on a native host."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from scholarseed_codex.protocol.state import AppServerError

ADMISSION_INITIAL_REVISION = 0
ADMISSION_REVISION_INVALID = "runtime_admission_revision_invalid"
ADMISSION_BUSY = "runtime_admission_busy"
ADMISSION_CLOSED = "agent_runtime_closed"


@dataclass(frozen=True)
class NativeQuiescence:
    configuration_revision: int
    process_generation: int
    activity_revision: int
    admission_epoch: int


class NativeAdmission:
    """Counts Python operations, never certifies that native work has settled."""

    def __init__(self) -> None:
        self._ready = asyncio.Event()
        self._ready.set()
        self._drained = asyncio.Event()
        self._drained.set()
        self._active = 0
        self._desired_revision = ADMISSION_INITIAL_REVISION
        self._epoch = 0
        self._closed = False
        self._failure = ""

    @property
    def failed(self) -> bool:
        return bool(self._failure)

    def require_healthy(self) -> None:
        if self._failure:
            raise AppServerError(self._failure, safe_error=self._failure)

    def fail(self, safe_error: str) -> None:
        self._failure = safe_error
        self._epoch += 1
        self._ready.set()

    @property
    def active(self) -> int:
        return self._active

    @property
    def accepting(self) -> bool:
        return not self._closed and not self._failure and self._ready.is_set()

    @property
    def desired_revision(self) -> int:
        return self._desired_revision

    @property
    def epoch(self) -> int:
        return self._epoch

    def frozen(self, revision: int) -> bool:
        return (
            not self._closed
            and not self._ready.is_set()
            and self._desired_revision == revision
            and not self._active
        )

    def freeze(self, revision: int) -> bool:
        if type(revision) is not int or revision < ADMISSION_INITIAL_REVISION:
            raise ValueError(ADMISSION_REVISION_INVALID)
        if self._closed or self._failure or revision < self._desired_revision:
            return False
        self._desired_revision = revision
        self._epoch += 1
        self._ready.clear()
        return True

    async def wait_drained(self, revision: int) -> bool:
        await self._drained.wait()
        return not self._closed and not self._failure and revision == self._desired_revision

    def applied(self, revision: int) -> bool:
        if self._closed or self._failure or revision != self._desired_revision:
            return False
        if self._active:
            raise RuntimeError(ADMISSION_BUSY)
        self._epoch += 1
        self._ready.set()
        return True

    def close(self) -> None:
        self._closed = True
        self._epoch += 1
        self._ready.set()
        self._drained.set()

    @asynccontextmanager
    async def enter(self) -> AsyncIterator[None]:
        while True:
            await self._ready.wait()
            if self._failure:
                raise AppServerError(self._failure, safe_error=self._failure)
            if self._closed:
                raise AppServerError(ADMISSION_CLOSED, safe_error=ADMISSION_CLOSED)
            if self._ready.is_set():
                self._active += 1
                self._drained.clear()
                break
        try:
            yield
        finally:
            self._active -= 1
            if not self._active:
                self._drained.set()
