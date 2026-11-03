"""Serial synchronous persistence without blocking the product event loop."""

from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any, Callable

from service.chat.persistence.utils import WriteBusy

WRITE_RETRY_INTERVAL_SECONDS = 0.1
WRITE_WAIT_LOG_INTERVAL_SECONDS = 30.0

_log = logging.getLogger(__name__)


class PersistenceWorker:
    """Own synchronous I/O; await commit before publication or resource release."""

    def __init__(self, *, session_id: str = "") -> None:
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="chat-persistence")
        self._closed = False
        self._stopping = False
        self._generation = 0
        self._close_task: asyncio.Task[None] | None = None
        self._operations: set[asyncio.Task[Any]] = set()
        self._admission = asyncio.Lock()
        self._session_id = session_id

    async def run[T](self, function: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        if self._closed:
            raise RuntimeError("session persistence closed")
        operation = asyncio.create_task(
            self._run(partial(function, *args, **kwargs), self._generation)
        )
        self._operations.add(operation)
        operation.add_done_callback(self._operations.discard)
        return await self._finish(operation)

    async def _run[T](self, function: Callable[[], T], generation: int) -> T:
        async with self._admission:
            if self._closed or generation != self._generation:
                raise asyncio.CancelledError
            return await self._write(function)

    async def _write[T](self, function: Callable[[], T]) -> T:
        started = time.monotonic()
        next_log = started
        waiting: WriteBusy | None = None
        while True:
            if self._stopping and waiting is not None:
                raise asyncio.CancelledError
            try:
                result = await asyncio.get_running_loop().run_in_executor(self._executor, function)
            except WriteBusy as error:
                waiting = error
                now = time.monotonic()
                if now >= next_log:
                    _log.warning(
                        "persistence_write_waiting session_id=%s database=%s sqlite_code=%s elapsed_ms=%.0f",
                        self._session_id,
                        error.database,
                        error.code,
                        (now - started) * 1000,
                    )
                    next_log = now + WRITE_WAIT_LOG_INTERVAL_SECONDS
                await asyncio.sleep(WRITE_RETRY_INTERVAL_SECONDS)
            else:
                if waiting is not None:
                    _log.info(
                        "persistence_write_resumed session_id=%s database=%s elapsed_ms=%.0f",
                        self._session_id,
                        waiting.database,
                        (time.monotonic() - started) * 1000,
                    )
                return result

    @staticmethod
    async def _finish[T](operation: asyncio.Future[T]) -> T:
        cancelled = False
        while not operation.done():
            try:
                await asyncio.shield(operation)
            except asyncio.CancelledError:
                # Repeated cancellation must not cancel the accepted transaction.
                cancelled = True
        result = operation.result()
        if cancelled:
            raise asyncio.CancelledError
        return result

    def stop_waiting(self) -> None:
        self._stopping = True
        self._generation += 1

    async def close(self) -> None:
        if self._close_task is None:
            self._closed = True
            self.stop_waiting()
            self._close_task = asyncio.create_task(self._close())
        await self._finish(self._close_task)

    async def _close(self) -> None:
        if self._operations:
            await asyncio.gather(*tuple(self._operations), return_exceptions=True)
        await asyncio.to_thread(self._executor.shutdown, wait=True)
