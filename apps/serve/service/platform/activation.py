"""Instance-owned user-work admission from the original native application owner."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable

from service.platform.guardian import Guardian, GuardianBusyError, GuardianError, WorkbenchState


class WorkbenchAdmission:
    def __init__(self, guardian: Guardian | None) -> None:
        self._guardian = guardian
        self._lock = threading.Lock()
        self._state = guardian.workbench() if guardian is not None else None
        self._ready = self._state is None or self._state.phase == "ready"
        self._closed = False
        self._started = False
        self._task: asyncio.Task[None] | None = None

    @property
    def ready(self) -> bool:
        with self._lock:
            return self._ready and not self._closed

    @property
    def recovery_at(self) -> int | None:
        """Native restart's frozen recovery input, never an environment override."""
        with self._lock:
            return self._state.recovery_at or None if self._state is not None else None

    @property
    def recovery_id(self) -> str | None:
        with self._lock:
            return (self._state.attempt or None) if self._state is not None else None

    def _observe(self, observed: WorkbenchState) -> None:
        with self._lock:
            old = self._state
            if old is None or (
                observed.generation,
                observed.release,
                observed.attempt,
                observed.recovery_at,
            ) != (old.generation, old.release, old.attempt, old.recovery_at):
                raise GuardianError("workbench application identity changed")
            if old.phase == "ready" and observed.phase != "ready":
                raise GuardianError("workbench commit regressed")
            if not self._closed:
                self._state = observed
                self._ready = observed.phase == "ready"

    def start(self, changed: Callable[[], None]) -> None:
        if self._started or self._closed:
            raise RuntimeError("workbench observer already started or closed")
        self._started = True
        if self._guardian is not None and not self.ready:
            self._task = asyncio.create_task(self._poll(changed), name="native-workbench-admission")

    async def _poll(self, changed: Callable[[], None]) -> None:
        assert self._guardian is not None
        while not self.ready:
            # Cancellation must join the native request's overlapped IO before
            # the lifespan can release filesystem/process qualifications.
            request = asyncio.create_task(asyncio.to_thread(self._guardian.workbench))
            cancellation: asyncio.CancelledError | None = None
            while True:
                try:
                    observed = await asyncio.shield(request)
                    break
                except asyncio.CancelledError as error:
                    if request.done() and request.cancelled():
                        raise
                    cancellation = error
                except GuardianBusyError:
                    observed = None
                    break
                except GuardianError:
                    # Unknown native authority never opens admission. The native
                    # activation deadline owns termination and source recovery.
                    if cancellation is not None:
                        raise cancellation
                    return
            if cancellation is not None:
                raise cancellation
            if observed is not None:
                try:
                    self._observe(observed)
                except GuardianError:
                    return
                changed()
            if not self.ready:
                await asyncio.sleep(0.25)

    async def aclose(self) -> None:
        with self._lock:
            self._closed = True
        if self._task is None:
            return
        self._task.cancel()
        cancellation: asyncio.CancelledError | None = None
        while True:
            try:
                await asyncio.shield(self._task)
                break
            except asyncio.CancelledError as error:
                if self._task.done():
                    break
                cancellation = error
        if cancellation is not None:
            raise cancellation
