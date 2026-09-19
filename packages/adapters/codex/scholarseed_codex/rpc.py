"""Generation-scoped RPC request ownership and response correlation."""

import asyncio
import json
import logging
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, AsyncIterable, AsyncIterator, Callable, Mapping

from scholarseed_codex.protocol.state import AppServerError
from scholarseed_runtime.contract.incident import RuntimeRetryability

LOGGER = logging.getLogger(__name__)
RPC_REJECTION_REASONS = {"already has an active writer": "thread_writer_busy"}


class FramingError(StrEnum):
    MALFORMED_JSON = "malformed_json"
    NON_OBJECT_MESSAGE = "non_object_message"


async def read_messages(
    stream: AsyncIterable[bytes], report_error: Callable[[str], None]
) -> AsyncIterator[dict[str, Any]]:
    """Decode the native JSON-lines transport without interpreting runtime events."""
    async for raw in stream:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            report_error(FramingError.MALFORMED_JSON)
            continue
        if not isinstance(message, dict):
            report_error(FramingError.NON_OBJECT_MESSAGE)
            continue
        yield message


class JsonLineWriter:
    """Serialize writes against one explicitly attached process generation."""

    def __init__(self) -> None:
        self._stream: asyncio.StreamWriter | None = None
        self._generation = 0
        self._lock = asyncio.Lock()

    def attach(self, stream: asyncio.StreamWriter | None, generation: int) -> None:
        self._stream = stream
        self._generation = generation

    def detach(self, generation: int) -> None:
        if generation == self._generation:
            self._stream = None

    async def write(self, message: Mapping[str, Any], *, generation: int) -> None:
        stream = self._stream
        if generation != self._generation or stream is None or stream.is_closing():
            raise AppServerError(
                "Codex App Server is not connected",
                safe_error="runtime_transport_lost",
                generation=generation,
            )
        encoded = (json.dumps(dict(message), ensure_ascii=False) + "\n").encode("utf-8")
        async with self._lock:
            if generation != self._generation or stream is not self._stream:
                raise AppServerError(
                    "Codex App Server generation changed before write",
                    safe_error="codex_generation_changed",
                    generation=generation,
                )
            try:
                stream.write(encoded)
                await stream.drain()
            except (BrokenPipeError, ConnectionError, OSError) as exc:
                raise AppServerError(
                    "Codex App Server transport write failed",
                    safe_error="runtime_transport_lost",
                    generation=generation,
                    retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                ) from exc


@dataclass
class PendingRpc:
    future: asyncio.Future[dict[str, Any]]
    generation: int
    method: str
    started_at: float
    written: bool = False


class PendingRequests:
    def __init__(self) -> None:
        self._next_id = 0
        self._pending: dict[int, PendingRpc] = {}

    def begin(self, generation: int, method: str) -> tuple[int, PendingRpc]:
        loop = asyncio.get_running_loop()
        self._next_id += 1
        pending = PendingRpc(loop.create_future(), generation, method, loop.time())
        self._pending[self._next_id] = pending
        return self._next_id, pending

    def resolve(self, message: Mapping[str, Any], generation: int) -> None:
        request_id = message.get("id")
        pending = self._pending.get(int(str(request_id))) if str(request_id).isdigit() else None
        if pending is None or pending.generation != generation or pending.future.done():
            return
        error = message.get("error")
        if isinstance(error, Mapping):
            raw_code = error.get("code")
            code = str(raw_code) if isinstance(raw_code, int) else "unknown"
            LOGGER.warning(
                "codex_rpc_rejected method=%s code=%s reason=%s",
                pending.method,
                code,
                next(
                    (
                        reason
                        for marker, reason in RPC_REJECTION_REASONS.items()
                        if marker in str(error.get("message") or "")
                    ),
                    "unspecified",
                ),
            )
            pending.future.set_exception(
                AppServerError(
                    f"App Server request failed (code={code})",
                    safe_error="runtime_rpc_rejected",
                    method=pending.method,
                    generation=generation,
                    rpc_code=raw_code if isinstance(raw_code, int) else None,
                )
            )
        else:
            result = message.get("result")
            pending.future.set_result(dict(result) if isinstance(result, Mapping) else {})

    def discard(self, request_id: int) -> None:
        pending = self._pending.pop(request_id, None)
        if pending is not None and not pending.future.done():
            pending.future.cancel()

    def fail(self, error: AppServerError, *, generation: int | None = None) -> None:
        for pending in tuple(self._pending.values()):
            if generation is not None and pending.generation != generation:
                continue
            if not pending.future.done():
                pending.future.set_exception(error)

    def close(self, error: AppServerError) -> None:
        self.fail(error)
        self._pending.clear()
