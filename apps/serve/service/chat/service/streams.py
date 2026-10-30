"""Bounded, content-free observations of model bridge stream boundaries."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from contextlib import suppress
from dataclasses import dataclass, field
from enum import Enum
from hashlib import sha256
from typing import Any, AsyncGenerator, AsyncIterator, Callable, Mapping

from damoatrace.recording.redaction import Redactor

LOGGER = logging.getLogger(__name__)
DIAGNOSTIC_EVENT = "model_bridge.diagnostic"
SSE_BUFFER_LIMIT = 64 * 1024
TEXT_DELTA_BATCH_CHARS = 48
TEXT_DELTA_BATCH_SECONDS = 0.12
TEXT_DELTA_EVENT = "response.output_text.delta"
REASONING_TEXT_DELTA_EVENT = "response.reasoning_text.delta"
REASONING_SUMMARY_TEXT_DELTA_EVENT = "response.reasoning_summary_text.delta"
TEXT_DELTA_FIELDS = frozenset(
    ("type", "sequence_number", "item_id", "output_index", "content_index", "delta", "logprobs")
)
REASONING_TEXT_DELTA_FIELDS = frozenset(
    ("type", "sequence_number", "item_id", "output_index", "content_index", "delta")
)
REASONING_SUMMARY_TEXT_DELTA_FIELDS = frozenset(
    ("type", "sequence_number", "item_id", "output_index", "summary_index", "delta")
)
DELTA_FIELDS = {
    TEXT_DELTA_EVENT: TEXT_DELTA_FIELDS,
    REASONING_TEXT_DELTA_EVENT: REASONING_TEXT_DELTA_FIELDS,
    REASONING_SUMMARY_TEXT_DELTA_EVENT: REASONING_SUMMARY_TEXT_DELTA_FIELDS,
}
DELTA_TARGETS = {
    TEXT_DELTA_EVENT: ("item_id", "output_index", "content_index"),
    REASONING_TEXT_DELTA_EVENT: ("item_id", "output_index", "content_index"),
    REASONING_SUMMARY_TEXT_DELTA_EVENT: ("item_id", "output_index", "summary_index"),
}
METADATA_LIMIT = 128
ERROR_MESSAGE_LIMIT = 500
INPUT_SHAPE_LIMIT = 128
INPUT_FIELD_LIMIT = 32
INPUT_TEXT_FINGERPRINT_LIMIT = 16
ERROR_URL_PATTERN = re.compile(r"https?://[^\s\"'<>]+")
METADATA_PATTERN = re.compile(r"[a-zA-Z0-9_.:/+\-]+")
RESPONSE_TERMINALS = frozenset(("response.completed", "response.failed", "response.incomplete"))
RESPONSE_FAILED = "response.failed"
SSE_DATA = b"data:"
SSE_EVENT = b"event:"
SSE_DONE = b"[DONE]"
SSE_EVENT_DELIMITERS = frozenset((b"\n", b"\r\n"))
RETRY_SAFE_RESPONSE_EVENTS = frozenset(
    ("response.created", "response.in_progress", "error", RESPONSE_FAILED)
)
CONTENT_SAFETY_BLOCKED = "CONTENT_SAFETY_BLOCKED"
CONTENT_SAFETY_MESSAGE = "The request did not pass content safety review."
CODEX_INVALID_PROMPT = "invalid_prompt"
PROVIDER_ERROR_PREFIX = re.compile(r"^<(\d{3})>\s+([A-Za-z][A-Za-z0-9_.-]*)(?::|$)", re.IGNORECASE)
PROVIDER_FAILURE_CODES = {
    ("server_error", 400, "internalerror.algo.datainspectionfailed"): CONTENT_SAFETY_BLOCKED,
}


class StreamEnd(str, Enum):
    EOF = "eof"
    HTTP_ERROR = "http_error"
    TRANSPORT_ERROR = "transport_error"
    CANCELLED = "cancelled"
    REVOKED = "revoked"
    CONSUMER_CLOSED = "consumer_closed"
    BRIDGE_ERROR = "bridge_error"
    NOT_STARTED = "not_started"
    PROVIDER_ERROR = "provider_error"


@dataclass
class NativeResponseNormalizer:
    pending: bytes = b""
    event_pending: bytes = b""
    passthrough_line: bool = False

    def feed(self, chunk: bytes) -> tuple[bytes, ...]:
        output: list[bytes] = []
        remaining = chunk
        while remaining:
            newline = remaining.find(b"\n")
            if self.passthrough_line:
                if newline < 0:
                    output.append(remaining)
                    break
                output.append(remaining[: newline + 1])
                remaining = remaining[newline + 1 :]
                self.passthrough_line = False
                continue
            if newline < 0:
                self.pending += remaining
                if len(self.pending) > SSE_BUFFER_LIMIT:
                    if self.event_pending:
                        output.append(self.event_pending)
                        self.event_pending = b""
                    output.append(self.pending)
                    self.pending = b""
                    self.passthrough_line = True
                break
            self.pending += remaining[: newline + 1]
            line = _normalize_native_response_line(self.pending)
            self.event_pending += line
            if line in SSE_EVENT_DELIMITERS or len(self.event_pending) >= SSE_BUFFER_LIMIT:
                output.append(self.event_pending)
                self.event_pending = b""
            self.pending = b""
            remaining = remaining[newline + 1 :]
        return tuple(output)

    def finish(self) -> tuple[bytes, ...]:
        if not self.pending and not self.event_pending:
            return ()
        pending = self.event_pending + self.pending
        self.pending = b""
        self.event_pending = b""
        return (pending,)


@dataclass
class TextDeltaBatcher:
    pending: dict[str, Any] | None = None
    pending_header: bytes = b""
    pending_since: float = 0.0
    sequence_offset: int = 0
    merged_events: int = 0
    merged_events_by_kind: dict[str, int] = field(default_factory=dict)
    batchable_events: int = 0
    batchable_events_by_kind: dict[str, int] = field(default_factory=dict)
    unsafe_events: int = 0
    unsafe_events_by_kind: dict[str, int] = field(default_factory=dict)
    unframed_events: int = 0
    unframed_reasons: dict[str, int] = field(default_factory=dict)
    timeout_flushes: int = 0
    timeout_flushes_by_kind: dict[str, int] = field(default_factory=dict)

    def feed(self, event: bytes) -> tuple[bytes, ...]:
        parsed = self._parse(event)
        if parsed is None:
            self.unframed_events += 1
            reason = self._unframed_reason(event)
            self.unframed_reasons[reason] = self.unframed_reasons.get(reason, 0) + 1
            return self.flush() + (event,)
        header, payload = parsed
        kind = payload.get("type")
        if not self._batchable(payload):
            if isinstance(kind, str) and kind in DELTA_FIELDS:
                self.unsafe_events += 1
                self.unsafe_events_by_kind[kind] = self.unsafe_events_by_kind.get(kind, 0) + 1
            return self.flush() + (self._serialize(header, payload, event),)
        assert isinstance(kind, str)
        self.batchable_events += 1
        self.batchable_events_by_kind[kind] = self.batchable_events_by_kind.get(kind, 0) + 1
        if self.pending is not None and (
            not self._same_target(self.pending, payload, self.pending_header, header)
            or len(self.pending_header) + len(header) >= SSE_BUFFER_LIMIT
        ):
            flushed = self.flush()
        else:
            flushed = ()
        if self.pending is None:
            self.pending = dict(payload)
            sequence = self.pending.get("sequence_number")
            if isinstance(sequence, int) and not isinstance(sequence, bool):
                self.pending["sequence_number"] = sequence - self.sequence_offset
            self.pending_header = header
            self.pending_since = time.monotonic()
        else:
            self.pending["delta"] += payload["delta"]
            self.pending_header += b"".join(
                line for line in header.splitlines(keepends=True) if not line.startswith(SSE_EVENT)
            )
            if isinstance(payload.get("sequence_number"), int):
                self.sequence_offset += 1
            self.merged_events += 1
            self.merged_events_by_kind[kind] = self.merged_events_by_kind.get(kind, 0) + 1
        if len(self.pending["delta"]) >= TEXT_DELTA_BATCH_CHARS:
            return flushed + self.flush()
        return flushed

    def flush(self) -> tuple[bytes, ...]:
        if self.pending is None:
            return ()
        payload = self.pending
        header = self.pending_header
        self.pending = None
        self.pending_header = b""
        self.pending_since = 0.0
        return (self._serialize(header, payload, adjust_sequence=False),)

    def _serialize(
        self,
        header: bytes,
        payload: dict[str, Any],
        original: bytes = b"",
        *,
        adjust_sequence: bool = True,
    ) -> bytes:
        sequence = payload.get("sequence_number")
        if (
            not adjust_sequence
            or not isinstance(sequence, int)
            or isinstance(sequence, bool)
            or not self.sequence_offset
        ):
            if original:
                return original
        else:
            payload = {**payload, "sequence_number": sequence - self.sequence_offset}
        return header + b"data: " + json.dumps(payload, ensure_ascii=False).encode() + b"\n\n"

    @staticmethod
    def _parse(event: bytes) -> tuple[bytes, dict[str, Any]] | None:
        event = event.replace(b"\r\n", b"\n")
        if not event.endswith(b"\n\n"):
            return None
        lines = event[:-2].split(b"\n")
        data = [line for line in lines if line.startswith(SSE_DATA)]
        if len(data) != 1:
            return None
        try:
            payload = json.loads(data[0][len(SSE_DATA) :].strip())
        except (UnicodeDecodeError, ValueError, RecursionError):
            return None
        if not isinstance(payload, dict):
            return None
        header = b"".join(line + b"\n" for line in lines if line and not line.startswith(SSE_DATA))
        return header, payload

    @staticmethod
    def _unframed_reason(event: bytes) -> str:
        normalized = event.replace(b"\r\n", b"\n")
        if not normalized.endswith(b"\n\n"):
            return "incomplete"
        lines = normalized[:-2].split(b"\n")
        if sum(line.startswith(SSE_DATA) for line in lines) != 1:
            return "data_lines"
        return "invalid_data"

    @staticmethod
    def _batchable(payload: dict[str, Any]) -> bool:
        kind = payload.get("type")
        if not isinstance(kind, str):
            return False
        fields = DELTA_FIELDS.get(kind)
        targets = DELTA_TARGETS.get(kind)
        return (
            fields is not None
            and targets is not None
            and isinstance(payload.get("delta"), str)
            and bool(payload.get("delta"))
            and payload.keys() <= fields
            and (kind != TEXT_DELTA_EVENT or payload.get("logprobs", []) == [])
            and isinstance(payload.get("item_id"), str)
            and type(payload.get("output_index")) is int
            and all(type(payload.get(target)) is int for target in targets[2:])
            and ("sequence_number" not in payload or type(payload["sequence_number"]) is int)
        )

    @staticmethod
    def _same_target(
        first: dict[str, Any], second: dict[str, Any], first_header: bytes, second_header: bytes
    ) -> bool:
        kind = first["type"]
        return (
            kind == second["type"]
            and TextDeltaBatcher._event_name(first_header)
            == TextDeltaBatcher._event_name(second_header)
            and (
                isinstance(first.get("sequence_number"), int)
                == isinstance(second.get("sequence_number"), int)
            )
            and all(first[target] == second[target] for target in DELTA_TARGETS[kind])
        )

    @staticmethod
    def _event_name(header: bytes) -> bytes:
        names = [
            line[len(SSE_EVENT) :].strip()
            for line in header.splitlines()
            if line.startswith(SSE_EVENT)
        ]
        return names[-1] if names else b""


async def coalesce_text_delta_stream(
    source: AsyncGenerator[bytes, None], batcher: TextDeltaBatcher
) -> AsyncIterator[bytes]:
    iterator = aiter(source)
    next_event = asyncio.ensure_future(anext(iterator))
    try:
        while True:
            timeout = (
                max(0.0, TEXT_DELTA_BATCH_SECONDS - (time.monotonic() - batcher.pending_since))
                if batcher.pending is not None
                else None
            )
            ready, _pending = await asyncio.wait((next_event,), timeout=timeout)
            if not ready:
                batcher.timeout_flushes += 1
                assert batcher.pending is not None
                kind = batcher.pending["type"]
                batcher.timeout_flushes_by_kind[kind] = (
                    batcher.timeout_flushes_by_kind.get(kind, 0) + 1
                )
                ready_events = batcher.flush()
                for event in ready_events:
                    yield event
                continue
            try:
                event = next_event.result()
            except StopAsyncIteration:
                for remaining in batcher.flush():
                    yield remaining
                return
            except Exception:
                for remaining in batcher.flush():
                    yield remaining
                raise
            next_event = asyncio.ensure_future(anext(iterator))
            for output in batcher.feed(event):
                yield output
    finally:
        try:
            if not next_event.done():
                next_event.cancel()
                with suppress(asyncio.CancelledError):
                    await next_event
        finally:
            await source.aclose()


def _normalize_native_response_line(line: bytes) -> bytes:
    if not line.startswith(SSE_DATA):
        return line
    ending = b"\r\n" if line.endswith(b"\r\n") else b"\n" if line.endswith(b"\n") else b""
    payload_bytes = line[len(SSE_DATA) : len(line) - len(ending) if ending else None].lstrip()
    try:
        payload = json.loads(payload_bytes)
    except (UnicodeDecodeError, ValueError, RecursionError):
        return line
    if not isinstance(payload, Mapping) or payload.get("type") != "response.failed":
        return line
    response = payload.get("response")
    if not isinstance(response, Mapping):
        return line
    error = response.get("error")
    if not isinstance(error, Mapping):
        return line
    code = str(error.get("code") or "").casefold()
    message = str(error.get("message") or "")
    match = PROVIDER_ERROR_PREFIX.match(message)
    if match is None:
        return line
    stable_code = PROVIDER_FAILURE_CODES.get((code, int(match.group(1)), match.group(2).casefold()))
    if stable_code is None:
        return line
    normalized_error = dict(error)
    normalized_error.update(
        {
            "code": CODEX_INVALID_PROMPT,
            "type": CONTENT_SAFETY_BLOCKED,
            "message": CONTENT_SAFETY_MESSAGE,
        }
    )
    normalized_response = dict(response)
    normalized_response["error"] = normalized_error
    normalized_payload = dict(payload)
    normalized_payload["response"] = normalized_response
    return SSE_DATA + b" " + json.dumps(normalized_payload, ensure_ascii=False).encode() + ending


def metadata_token(value: object) -> str:
    text = str(value or "")
    return text if len(text) <= METADATA_LIMIT and METADATA_PATTERN.fullmatch(text) else ""


@dataclass
class StreamObservation:
    redactor: Redactor = field(default_factory=Redactor, repr=False)
    pending: bytes = b""
    data: list[bytes] = field(default_factory=list)
    size: int = 0
    skipping: bool = False
    dropped_line: bool = False
    event: str = ""
    last_event: str = ""
    terminal: str = ""
    events: int = 0
    invalid_events: int = 0
    oversized_events: int = 0
    done: bool = False
    finish_reason: str = ""
    error_code: str = ""
    error_type: str = ""
    error_param: str = ""
    error_message: str = ""
    error_seen: bool = False
    semantic_seen: bool = False

    def feed(self, chunk: bytes) -> None:
        for index, part in enumerate(chunk.split(b"\n")):
            if index:
                if not self.dropped_line:
                    self.line(self.pending.rstrip(b"\r"))
                self.pending = b""
                self.dropped_line = False
            if len(self.pending) + len(part) + self.size > SSE_BUFFER_LIMIT:
                if not self.skipping:
                    self.oversized_events += 1
                self.skipping = True
                self.pending = b""
                self.data.clear()
                self.dropped_line = True
            elif self.skipping and part.rstrip(b"\r"):
                self.dropped_line = True
            else:
                self.pending += part

    def line(self, line: bytes) -> None:
        if not line:
            if not self.skipping:
                self.dispatch()
            elif self.event:
                self.events += 1
                self.last_event = self.event
                self.semantic_seen = True
                if self.event in RESPONSE_TERMINALS:
                    self.terminal = self.event
            self.data.clear()
            self.size = 0
            self.event = ""
            self.skipping = False
        elif not self.skipping:
            self.size += len(line)
            if line.startswith(SSE_EVENT):
                self.event = metadata_token(line[len(SSE_EVENT) :].strip().decode(errors="replace"))
            elif line.startswith(SSE_DATA):
                self.data.append(line[len(SSE_DATA) :].lstrip(b" "))

    def dispatch(self) -> None:
        if not self.data:
            return
        self.events += 1
        data = b"\n".join(self.data)
        if data == SSE_DONE:
            self.done = True
            self.last_event = "done"
            return
        try:
            payload = json.loads(data)
        except (ValueError, UnicodeDecodeError, RecursionError):
            self.invalid_events += 1
            self.last_event = self.event or "invalid_json"
            self.semantic_seen = True
            return
        if not isinstance(payload, Mapping):
            self.invalid_events += 1
            self.last_event = "non_object"
            self.semantic_seen = True
            return
        self.last_event = metadata_token(payload.get("type")) or self.event or "data"
        if self.last_event not in RETRY_SAFE_RESPONSE_EVENTS:
            self.semantic_seen = True
        if self.last_event == "error":
            self.error_seen = True
        if self.last_event in RESPONSE_TERMINALS:
            self.terminal = self.last_event
        response = payload.get("response")
        source = response if isinstance(response, Mapping) else payload
        error = source.get("error")
        if not isinstance(error, Mapping) and self.last_event == "error":
            error = source
        if isinstance(error, Mapping):
            self.error_code = metadata_token(error.get("code"))
            self.error_type = metadata_token(error.get("type"))
            self.error_param = metadata_token(error.get("param"))
            message = error.get("message")
            if isinstance(message, str):
                self.error_message = ERROR_URL_PATTERN.sub("[URL]", self.redactor.text(message))[
                    :ERROR_MESSAGE_LIMIT
                ]
        choices = payload.get("choices")
        if isinstance(choices, list):
            for choice in choices:
                if isinstance(choice, Mapping) and choice.get("finish_reason"):
                    self.finish_reason = metadata_token(choice["finish_reason"])

    def snapshot(self) -> dict[str, Any]:
        return {
            "last_event": self.last_event,
            "terminal_event": self.terminal,
            "event_count": self.events,
            "done_seen": self.done,
            "finish_reason": self.finish_reason,
            "error_code": self.error_code,
            "error_type": self.error_type,
            "error_param": self.error_param,
            "error_message": self.error_message,
            "error_seen": self.error_seen,
            "invalid_events": self.invalid_events,
            "oversized_events": self.oversized_events,
            "pending_bytes": len(self.pending) + self.size,
        }


@dataclass
class TransportObservation:
    """Content-free transport failure details safe for trace and diagnostic export."""

    stage: str = ""
    category: str = ""
    cause_chain: str = ""
    root_type: str = ""
    errno: int | None = None
    errno_name: str = ""
    errno_text: str = ""
    endpoint: str = ""

    def snapshot(self) -> dict[str, Any]:
        if not self.stage:
            return {}
        return {
            "transport_stage": self.stage,
            "transport_category": self.category,
            "transport_cause_chain": self.cause_chain,
            "transport_root_type": self.root_type,
            "transport_errno": self.errno,
            "transport_errno_name": self.errno_name,
            "transport_errno_text": self.errno_text,
            "transport_endpoint": self.endpoint,
        }


@dataclass
class CompletionDiagnostic:
    session_id: str
    requested_model: str
    notify: Callable[[str, Mapping[str, Any]], None] | None = None
    request_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    started_at: float = field(default_factory=time.perf_counter)
    text_delta_batcher: TextDeltaBatcher = field(default_factory=TextDeltaBatcher, repr=False)
    turn_id: str = ""
    routed_model: str = ""
    wire_protocol: str = ""
    status_code: int | None = None
    http_error_code: str = ""
    content_type: str = ""
    upstream_request_id: str = ""
    attempt: int = 1
    max_attempts: int = 1
    client_pool_hit: bool = False
    connect_retries: int = 0
    request_retries: int = 0
    tls_retries: int = 0
    http_retries: int = 0
    stream_retries: int = 0
    tcp_connects: int = 0
    tls_handshakes: int = 0
    upstream_end: str = StreamEnd.NOT_STARTED.value
    failure_type: str = ""
    transport: TransportObservation = field(default_factory=TransportObservation)
    upstream: StreamObservation = field(default_factory=StreamObservation)
    downstream: StreamObservation = field(default_factory=StreamObservation)
    finished: bool = False
    first_upstream_chunk_ms: float | None = None
    last_upstream_chunk_ms: float | None = None
    first_upstream_event_ms: float | None = None
    last_upstream_event_ms: float | None = None
    first_downstream_event_ms: float | None = None
    last_downstream_event_ms: float | None = None
    upstream_chunk_count: int = 0
    observed_upstream_events: int = 0
    observed_downstream_events: int = 0
    downstream_send_count: int = 0
    downstream_send_ms: float = 0.0
    downstream_send_max_ms: float = 0.0
    converted_input_items: dict[str, int] = field(default_factory=dict)
    input_shapes: list[dict[str, Any]] = field(default_factory=list)
    user_input_fingerprints: list[dict[str, Any]] = field(default_factory=list)
    tool_schema_fingerprints: list[dict[str, Any]] = field(default_factory=list)

    def observe_upstream_chunk(self) -> None:
        elapsed_ms = (time.perf_counter() - self.started_at) * 1000
        if self.first_upstream_chunk_ms is None:
            self.first_upstream_chunk_ms = elapsed_ms
        self.last_upstream_chunk_ms = elapsed_ms
        self.upstream_chunk_count += 1
        if self.upstream.events > self.observed_upstream_events:
            if self.first_upstream_event_ms is None:
                self.first_upstream_event_ms = elapsed_ms
            self.last_upstream_event_ms = elapsed_ms
            self.observed_upstream_events = self.upstream.events

    def observe_downstream_send(self, elapsed_ms: float) -> None:
        self.downstream_send_count += 1
        self.downstream_send_ms += elapsed_ms
        self.downstream_send_max_ms = max(self.downstream_send_max_ms, elapsed_ms)
        if self.downstream.events > self.observed_downstream_events:
            event_ms = (time.perf_counter() - self.started_at) * 1000
            if self.first_downstream_event_ms is None:
                self.first_downstream_event_ms = event_ms
            self.last_downstream_event_ms = event_ms
            self.observed_downstream_events = self.downstream.events

    def observe_tools(self, payload: Mapping[str, Any]) -> None:
        tools = payload.get("tools")
        pending = list(tools[:INPUT_SHAPE_LIMIT]) if isinstance(tools, list) else []
        self.tool_schema_fingerprints = []
        for index in range(INPUT_SHAPE_LIMIT):
            if index >= len(pending):
                break
            tool = pending[index]
            if not isinstance(tool, Mapping):
                continue
            children = tool.get("tools")
            if isinstance(children, list):
                pending.extend(children[: max(0, INPUT_SHAPE_LIMIT - len(pending))])
            declaration = tool.get("function", tool)
            if not isinstance(declaration, Mapping):
                continue
            schema = declaration.get("parameters")
            if not isinstance(schema, Mapping):
                continue
            encoded = json.dumps(schema, sort_keys=True, separators=(",", ":")).encode()
            definitions = schema.get("$defs")
            self.tool_schema_fingerprints.append(
                {
                    "name": metadata_token(declaration.get("name")),
                    "sha256": sha256(encoded).hexdigest(),
                    "bytes": len(encoded),
                    "keys": [metadata_token(key) for key in list(schema)[:INPUT_FIELD_LIMIT]],
                    "definitions": (
                        [metadata_token(key) for key in list(definitions)[:INPUT_FIELD_LIMIT]]
                        if isinstance(definitions, Mapping)
                        else []
                    ),
                }
            )

    def observe_input(self, payload: Mapping[str, Any]) -> None:
        items = payload.get("input")
        if not isinstance(items, list):
            return
        for item in items[-INPUT_SHAPE_LIMIT:]:
            if isinstance(item, Mapping):
                item_id = item.get("id")
                self.input_shapes.append(
                    {
                        "type": metadata_token(item.get("type")),
                        "role": metadata_token(item.get("role")),
                        "id_prefix": (
                            metadata_token(item_id.partition("_")[0])
                            if isinstance(item_id, str) and "_" in item_id
                            else ""
                        ),
                        "keys": [metadata_token(key) for key in list(item)[:INPUT_FIELD_LIMIT]],
                    }
                )
                if item.get("type") == "message" and item.get("role") == "user":
                    content = item.get("content")
                    blocks = content if isinstance(content, list) else [content]
                    for block in blocks:
                        value = block.get("text") if isinstance(block, Mapping) else block
                        if isinstance(value, str):
                            self.user_input_fingerprints.append(
                                {"sha256": sha256(value.encode()).hexdigest(), "chars": len(value)}
                            )
                    self.user_input_fingerprints = self.user_input_fingerprints[
                        -INPUT_TEXT_FINGERPRINT_LIMIT:
                    ]

    def protect(self, headers: Mapping[str, str]) -> None:
        secrets = tuple(
            value.removeprefix("Bearer ") for value in headers.values() if len(value) >= 4
        )
        self.upstream.redactor = Redactor(secrets=secrets)
        self.downstream.redactor = self.upstream.redactor

    def emit(self, phase: str, reason: str = "") -> None:
        fields = {
            "request_id": self.request_id,
            "client_user_message_id": self.turn_id,
            "requested_model": metadata_token(self.requested_model),
            "routed_model": metadata_token(self.routed_model),
            "converted_input_items": dict(self.converted_input_items),
            "input_shapes": list(self.input_shapes),
            "user_input_fingerprints": list(self.user_input_fingerprints),
            "tool_schema_fingerprints": list(self.tool_schema_fingerprints),
            "wire_protocol": self.wire_protocol,
            "phase": phase,
            "status_code": self.status_code,
            "http_error_code": self.http_error_code,
            "content_type": self.content_type,
            "upstream_request_id": self.upstream_request_id,
            "attempt": self.attempt,
            "max_attempts": self.max_attempts,
            "client_pool_hit": self.client_pool_hit,
            "connect_retries": self.connect_retries,
            "request_retries": self.request_retries,
            "tls_retries": self.tls_retries,
            "http_retries": self.http_retries,
            "stream_retries": self.stream_retries,
            "tcp_connects": self.tcp_connects,
            "tls_handshakes": self.tls_handshakes,
            "end_reason": reason,
            "upstream_end": self.upstream_end,
            "failure_type": self.failure_type,
            "first_upstream_chunk_ms": (
                round(self.first_upstream_chunk_ms, 1)
                if self.first_upstream_chunk_ms is not None
                else None
            ),
            "last_upstream_chunk_ms": (
                round(self.last_upstream_chunk_ms, 1)
                if self.last_upstream_chunk_ms is not None
                else None
            ),
            "upstream_chunk_count": self.upstream_chunk_count,
            "first_upstream_event_ms": (
                round(self.first_upstream_event_ms, 1)
                if self.first_upstream_event_ms is not None
                else None
            ),
            "last_upstream_event_ms": (
                round(self.last_upstream_event_ms, 1)
                if self.last_upstream_event_ms is not None
                else None
            ),
            "first_downstream_event_ms": (
                round(self.first_downstream_event_ms, 1)
                if self.first_downstream_event_ms is not None
                else None
            ),
            "last_downstream_event_ms": (
                round(self.last_downstream_event_ms, 1)
                if self.last_downstream_event_ms is not None
                else None
            ),
            "downstream_send_count": self.downstream_send_count,
            "coalesced_text_delta_events": self.text_delta_batcher.merged_events_by_kind.get(
                TEXT_DELTA_EVENT, 0
            ),
            "text_delta_batchable_events": self.text_delta_batcher.batchable_events_by_kind.get(
                TEXT_DELTA_EVENT, 0
            ),
            "text_delta_unsafe_events": self.text_delta_batcher.unsafe_events_by_kind.get(
                TEXT_DELTA_EVENT, 0
            ),
            "coalesced_reasoning_text_delta_events": self.text_delta_batcher.merged_events_by_kind.get(
                REASONING_TEXT_DELTA_EVENT, 0
            ),
            "coalesced_reasoning_summary_text_delta_events": self.text_delta_batcher.merged_events_by_kind.get(
                REASONING_SUMMARY_TEXT_DELTA_EVENT, 0
            ),
            "reasoning_delta_batchable_events": sum(
                self.text_delta_batcher.batchable_events_by_kind.get(kind, 0)
                for kind in (REASONING_TEXT_DELTA_EVENT, REASONING_SUMMARY_TEXT_DELTA_EVENT)
            ),
            "reasoning_delta_unsafe_events": sum(
                self.text_delta_batcher.unsafe_events_by_kind.get(kind, 0)
                for kind in (REASONING_TEXT_DELTA_EVENT, REASONING_SUMMARY_TEXT_DELTA_EVENT)
            ),
            "sse_unframed_events": self.text_delta_batcher.unframed_events,
            "sse_unframed_reasons": dict(self.text_delta_batcher.unframed_reasons),
            "text_delta_timeout_flushes": self.text_delta_batcher.timeout_flushes_by_kind.get(
                TEXT_DELTA_EVENT, 0
            ),
            "reasoning_delta_timeout_flushes": sum(
                self.text_delta_batcher.timeout_flushes_by_kind.get(kind, 0)
                for kind in (REASONING_TEXT_DELTA_EVENT, REASONING_SUMMARY_TEXT_DELTA_EVENT)
            ),
            "downstream_send_ms": round(self.downstream_send_ms, 1),
            "downstream_send_max_ms": round(self.downstream_send_max_ms, 1),
            **self.transport.snapshot(),
            "elapsed_ms": round((time.perf_counter() - self.started_at) * 1000, 1),
            "upstream": self.upstream.snapshot(),
            "downstream": self.downstream.snapshot(),
        }
        LOGGER.info("%s session_id=%s %s", DIAGNOSTIC_EVENT, self.session_id, json.dumps(fields))
        if self.notify is not None:
            self.notify(self.session_id, fields)

    def finish(self, reason: str) -> None:
        if not self.finished:
            self.finished = True
            self.emit("finished", reason)
