"""Bounded, content-free observations of model bridge stream boundaries."""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Mapping

from damoatrace.recording.redaction import Redactor

LOGGER = logging.getLogger(__name__)
DIAGNOSTIC_EVENT = "model_bridge.diagnostic"
SSE_BUFFER_LIMIT = 64 * 1024
METADATA_LIMIT = 128
ERROR_MESSAGE_LIMIT = 500
INPUT_SHAPE_LIMIT = 128
INPUT_FIELD_LIMIT = 32
ERROR_URL_PATTERN = re.compile(r"https?://[^\s\"'<>]+")
METADATA_PATTERN = re.compile(r"[a-zA-Z0-9_.:/+\-]+")
RESPONSE_TERMINALS = frozenset(("response.completed", "response.failed", "response.incomplete"))
RESPONSE_FAILED = "response.failed"
SSE_DATA = b"data:"
SSE_EVENT = b"event:"
SSE_DONE = b"[DONE]"
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
                    output.append(self.pending)
                    self.pending = b""
                    self.passthrough_line = True
                break
            self.pending += remaining[: newline + 1]
            output.append(_normalize_native_response_line(self.pending))
            self.pending = b""
            remaining = remaining[newline + 1 :]
        return tuple(output)

    def finish(self) -> tuple[bytes, ...]:
        if not self.pending:
            return ()
        pending = self.pending
        self.pending = b""
        return (pending,)


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
            return
        if not isinstance(payload, Mapping):
            self.invalid_events += 1
            self.last_event = "non_object"
            return
        self.last_event = metadata_token(payload.get("type")) or self.event or "data"
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
    turn_id: str = ""
    routed_model: str = ""
    wire_protocol: str = ""
    status_code: int | None = None
    content_type: str = ""
    upstream_request_id: str = ""
    attempt: int = 1
    max_attempts: int = 1
    upstream_end: str = StreamEnd.NOT_STARTED.value
    failure_type: str = ""
    transport: TransportObservation = field(default_factory=TransportObservation)
    upstream: StreamObservation = field(default_factory=StreamObservation)
    downstream: StreamObservation = field(default_factory=StreamObservation)
    finished: bool = False
    converted_input_items: dict[str, int] = field(default_factory=dict)
    input_shapes: list[dict[str, Any]] = field(default_factory=list)

    def observe_input(self, payload: Mapping[str, Any]) -> None:
        items = payload.get("input")
        if not isinstance(items, list):
            return
        for item in items[:INPUT_SHAPE_LIMIT]:
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
            "wire_protocol": self.wire_protocol,
            "phase": phase,
            "status_code": self.status_code,
            "content_type": self.content_type,
            "upstream_request_id": self.upstream_request_id,
            "attempt": self.attempt,
            "max_attempts": self.max_attempts,
            "end_reason": reason,
            "upstream_end": self.upstream_end,
            "failure_type": self.failure_type,
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
