"""Generation-scoped RPC request ownership and response correlation."""

import asyncio
import json
import logging
import sys
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, AsyncIterable, AsyncIterator, Callable, Mapping

from scholarseed_codex.diagnostic import (
    RPC_DIAGNOSTIC_CHANNEL,
    RPC_REJECTED_ERROR,
    WINDOWS_PLATFORM,
    native_diagnostic,
    rpc_failure,
)
from scholarseed_codex.protocol.state import (
    RPC_METHOD_NOT_FOUND,
    SANDBOX_EXECUTION_METHOD,
    AppServerError,
)
from scholarseed_runtime.contract.incident import RuntimeRetryability

LOGGER = logging.getLogger(__name__)
MAX_PENDING_RPC_REQUESTS = 1024
RPC_INTERNAL_ERROR = -32603


class FramingError(StrEnum):
    MALFORMED_JSON = "malformed_json"
    NON_OBJECT_MESSAGE = "non_object_message"


class RpcSubmissionState(StrEnum):
    NOT_SUBMITTED = "not_submitted"
    UNKNOWN = "unknown"
    ACCEPTED = "accepted"


@dataclass
class RpcSubmission:
    state: RpcSubmissionState = RpcSubmissionState.NOT_SUBMITTED
    on_attempt: Callable[[], None] | None = None

    def attempt(self) -> None:
        if self.on_attempt is not None:
            self.on_attempt()
        if self.state is RpcSubmissionState.NOT_SUBMITTED:
            self.state = RpcSubmissionState.UNKNOWN


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

    async def write(
        self,
        message: Mapping[str, Any],
        *,
        generation: int,
        on_written: Callable[[], None] | None = None,
        before_write: Callable[[], None] | None = None,
        on_write_attempt: Callable[[], None] | None = None,
    ) -> None:
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
                if before_write is not None:
                    before_write()
                if on_write_attempt is not None:
                    on_write_attempt()
                stream.write(encoded)
                if on_written is not None:
                    on_written()
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
    abandoned: bool = False
    settled: bool = False
    thread_id: str = ""
    submission: RpcSubmission = field(default_factory=RpcSubmission)

    def mark_written(self) -> None:
        self.written = True


class PendingRequests:
    def __init__(self, *, capacity: int = MAX_PENDING_RPC_REQUESTS) -> None:
        if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity <= 0:
            raise ValueError("RPC capacity must be a positive integer")
        self._capacity = capacity
        self._next_id = 0
        self._pending: dict[int, PendingRpc] = {}

    def begin(
        self,
        generation: int,
        method: str,
        *,
        thread_id: str = "",
        submission: RpcSubmission | None = None,
    ) -> tuple[int, PendingRpc]:
        if len(self._pending) >= self._capacity:
            raise AppServerError(
                "Native request capacity exhausted",
                safe_error="runtime_rpc_capacity_exhausted",
                method=method,
                generation=generation,
            )
        loop = asyncio.get_running_loop()
        self._next_id += 1
        pending = PendingRpc(
            loop.create_future(),
            generation,
            method,
            loop.time(),
            thread_id=thread_id,
            submission=submission if submission is not None else RpcSubmission(),
        )
        self._pending[self._next_id] = pending
        return self._next_id, pending

    def resolve(
        self, message: Mapping[str, Any], generation: int, *, pid: int | None = None
    ) -> None:
        request_id = message.get("id")
        pending = self._pending.get(int(str(request_id))) if str(request_id).isdigit() else None
        if pending is None or pending.generation != generation:
            return
        pending.settled = True
        if pending.abandoned:
            self._pending.pop(int(str(request_id)))
            return
        if pending.future.done():
            return
        error = message.get("error")
        if isinstance(error, Mapping):
            raw_code = error.get("code")
            if (
                type(raw_code) is int
                and raw_code == RPC_METHOD_NOT_FOUND
                and pending.submission.state is not RpcSubmissionState.ACCEPTED
            ):
                pending.submission.state = RpcSubmissionState.NOT_SUBMITTED
            code = str(raw_code) if type(raw_code) is int else "unknown"
            raw_message = error.get("message")
            safe_error = rpc_failure(pending.method, pending.thread_id, raw_code, raw_message)
            diagnostic = native_diagnostic(
                RPC_DIAGNOSTIC_CHANNEL,
                raw_message if isinstance(raw_message, str) else "",
                windows_command_failure=(
                    sys.platform == WINDOWS_PLATFORM
                    and pending.method == SANDBOX_EXECUTION_METHOD
                    and type(raw_code) is int
                    and raw_code == RPC_INTERNAL_ERROR
                ),
            )
            latency_ms = max(
                0, int((asyncio.get_running_loop().time() - pending.started_at) * 1000)
            )
            LOGGER.warning(
                "codex_rpc_rejected method=%s code=%s request_id=%s generation=%s pid=%s "
                "latency_ms=%s %s",
                pending.method,
                code,
                request_id,
                generation,
                pid,
                latency_ms,
                diagnostic.summary,
            )
            pending.future.set_exception(
                AppServerError(
                    f"App Server request failed (code={code}; {diagnostic.summary})",
                    safe_error=safe_error,
                    method=pending.method,
                    generation=generation,
                    rpc_code=raw_code if type(raw_code) is int else None,
                    rpc_latency_ms=latency_ms,
                    rpc_request_id=int(str(request_id)),
                    rpc_pid=pid,
                    native_reason=diagnostic.reason,
                    native_stage=diagnostic.native_stage,
                    native_code_type=diagnostic.code_type,
                    native_code=diagnostic.code,
                    retryability=(
                        RuntimeRetryability.USER_RETRYABLE
                        if safe_error == RPC_REJECTED_ERROR
                        else RuntimeRetryability.TERMINAL
                    ),
                )
            )
        else:
            pending.submission.state = RpcSubmissionState.ACCEPTED
            result = message.get("result")
            pending.future.set_result(dict(result) if isinstance(result, Mapping) else {})

    def discard(self, request_id: int) -> None:
        pending = self._pending.get(request_id)
        if pending is None:
            return
        if pending.abandoned:
            return
        if (
            pending.written or pending.submission.state is not RpcSubmissionState.NOT_SUBMITTED
        ) and not pending.settled:
            pending.abandoned = True
            if pending.future.done() and not pending.future.cancelled():
                pending.future.exception()
            else:
                pending.future.cancel()
            return
        self._pending.pop(request_id)
        if not pending.future.done():
            pending.future.cancel()
        elif not pending.future.cancelled():
            pending.future.exception()

    def unsettled(self, generation: int) -> bool:
        return any(
            pending.generation == generation
            and (
                pending.written or pending.submission.state is not RpcSubmissionState.NOT_SUBMITTED
            )
            and not pending.settled
            for pending in self._pending.values()
        )

    def fail(self, error: AppServerError, *, generation: int | None = None) -> None:
        for pending in tuple(self._pending.values()):
            if generation is not None and pending.generation != generation:
                continue
            if not pending.future.done():
                pending.future.set_exception(error)

    def retire(self, generation: int) -> None:
        for request_id, pending in tuple(self._pending.items()):
            if pending.generation != generation:
                continue
            pending.settled = True
            if pending.abandoned:
                self._pending.pop(request_id)

    def close(self, error: AppServerError) -> None:
        self.fail(error)
        self._pending.clear()
