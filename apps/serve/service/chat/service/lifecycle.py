"""Session-local lifecycle serialization and an exclusive maintenance boundary."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from weakref import WeakValueDictionary

from service.platform.activity import MaintenanceActive


class SessionOperations:
    def __init__(self) -> None:
        self._keys: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
        self._admission = asyncio.Lock()
        self._idle = asyncio.Event()
        self._idle.set()
        self._active = 0
        self._closed = False

    def session(self, session_id: str) -> asyncio.Lock:
        lock = self._keys.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            self._keys[session_id] = lock
        return lock

    @asynccontextmanager
    async def operation(self, session_id: str) -> AsyncIterator[None]:
        if self._closed:
            raise MaintenanceActive("update_maintenance")
        # Waiters for one key must not reserve an admission slot.
        async with self.session(session_id):
            async with self._admission:
                if self._closed:
                    raise MaintenanceActive("update_maintenance")
                self._active += 1
                self._idle.clear()
            try:
                yield
            finally:
                self._active -= 1
                if not self._active:
                    self._idle.set()

    @asynccontextmanager
    async def exclusive(self) -> AsyncIterator[None]:
        async with self._admission:
            await self._idle.wait()
            if self._closed:
                raise MaintenanceActive("update_maintenance")
            yield

    async def stop(self) -> None:
        self._closed = True
        async with self._admission:
            await self._idle.wait()
