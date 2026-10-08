"""Serial synchronous persistence without blocking the product event loop."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any, Callable


class PersistenceWorker:
    """Own synchronous I/O; await commit before publication or resource release."""

    def __init__(self) -> None:
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="chat-persistence")
        self._closed = False
        self._close_task: asyncio.Task[None] | None = None

    async def run[T](self, function: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        if self._closed:
            raise RuntimeError("session persistence closed")
        operation = asyncio.get_running_loop().run_in_executor(
            self._executor, partial(function, *args, **kwargs)
        )
        return await self._finish(operation)

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

    async def close(self) -> None:
        if self._close_task is None:
            self._closed = True
            self._close_task = asyncio.create_task(
                asyncio.to_thread(self._executor.shutdown, wait=True)
            )
        await self._finish(self._close_task)
