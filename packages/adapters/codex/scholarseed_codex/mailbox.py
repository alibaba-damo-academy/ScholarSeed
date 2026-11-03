"""Lossless normalized observations, independent of projection backpressure."""

from __future__ import annotations

import asyncio
import pickle
import struct
import tempfile
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial
from typing import Any, BinaryIO, Callable, cast

from scholarseed_runtime.contract import RuntimeCallbackRequest, RuntimeEvent

OBSERVATION_MEMORY_BUDGET_BYTES = 8 * 1024 * 1024
OBSERVATION_SPOOL_PREFIX = "codex-observations-"
OBSERVATION_SEGMENT_BYTES = 1024 * 1024
OBSERVATION_LENGTH = struct.Struct("!Q")
Observation = RuntimeEvent | RuntimeCallbackRequest


@dataclass
class SpoolSegment:
    file: BinaryIO
    size: int = 0
    read_position: int = 0


class ObservationMailbox:
    """A single-consumer FIFO with byte-bounded memory and private disk overflow.

    The spool is process-local temporary state, never a persisted/untrusted pickle
    input. Both its reader and writer belong to one serial I/O thread. Events are
    neither merged nor dropped, including callbacks and terminal observations.
    """

    def __init__(self, *, memory_budget_bytes: int = OBSERVATION_MEMORY_BUDGET_BYTES) -> None:
        if memory_budget_bytes < 1:
            raise ValueError("observation memory budget must be positive")
        self._budget = memory_budget_bytes
        self._memory: deque[bytes] = deque()
        self.memory_bytes = 0
        self._disk_count = 0
        self._segments: deque[SpoolSegment] = deque()
        self._writer: SpoolSegment | None = None
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="codex-observations")
        self._available = asyncio.Event()
        self._put_lock = asyncio.Lock()
        self._get_lock = asyncio.Lock()
        self._closed = False
        self._failure: Exception | None = None
        self._close_task: asyncio.Task[None] | None = None

    @property
    def spilled(self) -> bool:
        return self._disk_count > 0

    def qsize(self) -> int:
        return len(self._memory) + self._disk_count

    async def put(self, observation: Observation) -> None:
        # Copy the accepted observation so later caller mutations cannot alter it.
        try:
            payload = pickle.dumps(observation, protocol=pickle.HIGHEST_PROTOCOL)
        except Exception as error:
            self._failure = error
            self._available.set()
            raise
        async with self._put_lock:
            if self._closed:
                raise EOFError("observation mailbox closed")
            if self._failure is not None:
                raise self._failure
            if not self._disk_count and self.memory_bytes + len(payload) <= self._budget:
                self._memory.append(payload)
                self.memory_bytes += len(payload)
                self._available.set()
                return
            operation = asyncio.create_task(self._spill(payload))
            await self._finish(operation)

    async def _spill(self, payload: bytes) -> None:
        try:
            await self._io(self._append, payload)
        except Exception as error:
            # Host dispatch records listener errors and continues reading. Latch
            # the fault here too, so the consumer fails and later terminal events
            # cannot turn a lost observation into a successful product turn.
            self._failure = error
            self._available.set()
            raise
        self._disk_count += 1
        self._available.set()

    async def get(self) -> Observation:
        async with self._get_lock:
            if self._failure is not None:
                raise self._failure
            while not self.qsize():
                if self._failure is not None:
                    raise self._failure
                if self._closed:
                    raise EOFError("observation mailbox closed")
                self._available.clear()
                await self._available.wait()
            if self._memory:
                payload = self._memory.popleft()
                self.memory_bytes -= len(payload)
            else:
                operation = asyncio.create_task(self._take_spilled())
                payload = await self._finish(operation)
            try:
                observation = pickle.loads(payload)
                if not isinstance(observation, (RuntimeEvent, RuntimeCallbackRequest)):
                    raise ValueError("invalid observation spool record")
            except Exception as error:
                self._failure = error
                self._available.set()
                raise
            return observation

    @staticmethod
    async def _finish[T](operation: asyncio.Future[T]) -> T:
        cancelled = False
        while not operation.done():
            try:
                await asyncio.shield(operation)
            except asyncio.CancelledError:
                cancelled = True
        result = operation.result()
        if cancelled:
            raise asyncio.CancelledError
        return result

    async def _take_spilled(self) -> bytes:
        try:
            payload = await self._io(self._read)
        except Exception as error:
            self._failure = error
            self._available.set()
            raise
        self._disk_count -= 1
        return payload

    async def _io(self, function: Callable[..., Any], *arguments: Any) -> Any:
        return await asyncio.get_running_loop().run_in_executor(
            self._executor, partial(function, *arguments)
        )

    def _append(self, payload: bytes) -> None:
        length = OBSERVATION_LENGTH.size + len(payload)
        if self._writer is None or self._writer.size + length > OBSERVATION_SEGMENT_BYTES:
            self._writer = SpoolSegment(
                cast(BinaryIO, tempfile.TemporaryFile(prefix=OBSERVATION_SPOOL_PREFIX))
            )
            self._segments.append(self._writer)
        segment = self._writer
        segment.file.seek(segment.size)
        segment.file.write(OBSERVATION_LENGTH.pack(len(payload)))
        segment.file.write(payload)
        segment.file.flush()
        segment.size = segment.file.tell()

    def _read(self) -> bytes:
        if not self._segments:
            raise OSError("observation spool missing")
        segment = self._segments[0]
        segment.file.seek(segment.read_position)
        header = segment.file.read(OBSERVATION_LENGTH.size)
        if len(header) != OBSERVATION_LENGTH.size:
            raise OSError("incomplete observation spool header")
        length = OBSERVATION_LENGTH.unpack(header)[0]
        payload = segment.file.read(length)
        if len(payload) != length:
            raise OSError("incomplete observation spool record")
        segment.read_position = segment.file.tell()
        if segment.read_position == segment.size:
            self._segments.popleft()
            if self._writer is segment:
                self._writer = None
            segment.file.close()
        return payload

    def _dispose(self) -> None:
        for segment in self._segments:
            segment.file.close()
        self._segments.clear()
        self._writer = None

    async def close(self) -> None:
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close())
        await self._finish(self._close_task)

    async def _close(self) -> None:
        self._closed = True
        self._available.set()
        async with self._put_lock:
            async with self._get_lock:
                await self._io(self._dispose)
                self._memory.clear()
                self.memory_bytes = self._disk_count = 0
                await asyncio.to_thread(self._executor.shutdown, wait=True)
