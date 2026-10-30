"""Allowlisted native failure metadata; never retain free-form vendor text."""

import asyncio
import hashlib
import json
import os
import re
from dataclasses import dataclass
from typing import AsyncIterator

from scholarseed_codex.protocol.state import CODEX_STDERR_DIAGNOSTIC_CHANNEL, _redacted_diagnostic

DIAGNOSTIC_SCAN_LIMIT = 16384
STDERR_LINE_LIMIT = 64 * 1024
STDERR_CHUNK_BYTES = 16 * 1024
UNSPECIFIED_REASON = "unspecified"
SANDBOX_MARKER = "windows sandbox"
MCP_LAUNCH_EVENT = "scholarseed_mcp_launch_failed"
MCP_DIAGNOSTIC_MARKER = '{"correlation_id":'
MCP_DIAGNOSTIC_FIELDS = frozenset(
    {"event", "schema_version", "stage", "error_type", "errno", "winerror", "correlation_id"}
)
MCP_DIAGNOSTIC_ID = re.compile(r"^[0-9a-f]{32}$")
SYSTEM_CODE_LIMIT = 0xFFFFFFFF
NATIVE_LOG_ENV = "RUST_LOG"
NATIVE_LOG_DEFAULT = "error"
MCP_STDERR_LOG_FILTER = "codex_rmcp_client::stdio_server_launcher=info"
WRITER_MARKER = "already has an active writer"
RPC_REJECTED_ERROR = "runtime_rpc_rejected"
THREAD_HISTORY_MISSING_ERROR = "codex_thread_history_missing"
THREAD_NOT_FOUND_ERROR = "codex_thread_not_found"
RPC_INVALID_REQUEST_CODE = -32600
RPC_THREAD_ERRORS = (
    ("thread/resume", "no rollout found for thread id ", THREAD_HISTORY_MISSING_ERROR),
    ("thread/read", "thread not found: ", THREAD_NOT_FOUND_ERROR),
    ("mcpServerStatus/list", "thread not found: ", THREAD_NOT_FOUND_ERROR),
)
PIPE_TIMEOUT = re.compile(r"timed out after ([0-9]{1,8})ms connecting runner pipe-(in|out)\b")
OS_ERROR = re.compile(r"\bos error ([0-9]{1,10})\b", re.IGNORECASE)
SANDBOX_REASONS = (
    ("createprocesswithlogonw", "windows_sandbox_process_launch"),
    ("access is denied", "windows_sandbox_access_denied"),
    ("logon failure", "windows_sandbox_logon_failed"),
)


@dataclass(frozen=True)
class NativeDiagnostic:
    reason: str
    summary: str


def enable_mcp_diagnostics(environment: dict[str, str]) -> None:
    """Native stdio stderr is INFO; only enable that reviewed module's forwarding."""
    previous = environment.get(NATIVE_LOG_ENV, "")
    if os.name == "nt":
        for name in tuple(environment):
            if name != NATIVE_LOG_ENV and name.casefold() == NATIVE_LOG_ENV.casefold():
                value = environment.pop(name)
                previous = previous or value
    environment[NATIVE_LOG_ENV] = f"{previous or NATIVE_LOG_DEFAULT},{MCP_STDERR_LOG_FILTER}"


def rpc_failure(method: str, thread_id: str, code: object, message: object) -> str:
    if type(code) is int and code == RPC_INVALID_REQUEST_CODE and thread_id:
        for expected_method, prefix, safe_error in RPC_THREAD_ERRORS:
            if method == expected_method and message == prefix + thread_id:
                return safe_error
    return RPC_REJECTED_ERROR


def native_diagnostic(channel: str, message: str) -> NativeDiagnostic:
    """Classify reported errors, not their root cause; unknown text stays hashed."""
    sample = message[:DIAGNOSTIC_SCAN_LIMIT].casefold()
    reason = UNSPECIFIED_REASON
    fields: list[str] = []
    # Codex prefixes MCP child stderr. Accept only our complete bounded schema.
    forwarded = message
    if message.startswith("{"):
        try:
            envelope = json.loads(message[:DIAGNOSTIC_SCAN_LIMIT])
        except (ValueError, RecursionError):
            envelope = None
        native_fields = envelope.get("fields") if isinstance(envelope, dict) else None
        if isinstance(native_fields, dict) and isinstance(native_fields.get("message"), str):
            forwarded = native_fields["message"]
    position = forwarded.find(MCP_DIAGNOSTIC_MARKER, 0, DIAGNOSTIC_SCAN_LIMIT)
    if position >= 0:
        try:
            event = json.loads(forwarded[position:DIAGNOSTIC_SCAN_LIMIT].strip())
        except (ValueError, RecursionError):
            event = None
        if (
            isinstance(event, dict)
            and set(event) == MCP_DIAGNOSTIC_FIELDS
            and event.get("event") == MCP_LAUNCH_EVENT
            and type(event.get("schema_version")) is int
            and event["schema_version"] == 1
            and event.get("stage") in ("bindings", "containment", "exec")
            and event.get("error_type") in ("os_error", "invalid_bindings")
            and isinstance(event.get("correlation_id"), str)
            and MCP_DIAGNOSTIC_ID.fullmatch(event["correlation_id"])
            and all(
                value is None or type(value) is int and 0 <= value <= SYSTEM_CODE_LIMIT
                for value in (event.get("errno"), event.get("winerror"))
            )
        ):
            reason = "mcp_launch_failed"
            fields.extend(
                f"{key}={event[key]}"
                for key in ("stage", "error_type", "errno", "winerror", "correlation_id")
            )
            return NativeDiagnostic(
                reason,
                " ".join((f"reason={reason}", *fields, _redacted_diagnostic(channel, message))),
            )
    if SANDBOX_MARKER in sample:
        reason = "windows_sandbox_failed"
        timeout = PIPE_TIMEOUT.search(sample)
        if timeout is not None:
            reason = "windows_sandbox_runner_pipe_timeout"
            fields.extend((f"timeout_ms={int(timeout[1])}", f"pipe={timeout[2]}"))
        else:
            reason = next((value for marker, value in SANDBOX_REASONS if marker in sample), reason)
        error = OS_ERROR.search(sample)
        if error is not None:
            fields.append(f"os_error={int(error[1])}")
    elif WRITER_MARKER in sample:
        reason = "thread_writer_busy"
    summary = " ".join((f"reason={reason}", *fields, _redacted_diagnostic(channel, message)))
    return NativeDiagnostic(reason, summary)


async def stream_diagnostics(reader: asyncio.StreamReader) -> AsyncIterator[NativeDiagnostic]:
    """Drain arbitrary native stderr without unbounded lines or readuntil failures."""
    prefix = bytearray()
    digest = hashlib.sha256()
    length = 0
    while chunk := await reader.read(STDERR_CHUNK_BYTES):
        pieces = chunk.split(b"\n")
        for index, part in enumerate(pieces):
            digest.update(part)
            length += len(part)
            if len(prefix) < STDERR_LINE_LIMIT:
                prefix.extend(part[: STDERR_LINE_LIMIT - len(prefix)])
            if index != len(pieces) - 1:
                if length > STDERR_LINE_LIMIT:
                    yield NativeDiagnostic(
                        "native_stderr_truncated",
                        f"reason=native_stderr_truncated length_bytes={length} sha256={digest.hexdigest()}",
                    )
                elif line := prefix.decode("utf-8", errors="replace").rstrip():
                    yield native_diagnostic(CODEX_STDERR_DIAGNOSTIC_CHANNEL, line)
                prefix.clear()
                digest = hashlib.sha256()
                length = 0
    if length > STDERR_LINE_LIMIT:
        yield NativeDiagnostic(
            "native_stderr_truncated",
            f"reason=native_stderr_truncated length_bytes={length} sha256={digest.hexdigest()}",
        )
    elif line := prefix.decode("utf-8", errors="replace").rstrip():
        yield native_diagnostic(CODEX_STDERR_DIAGNOSTIC_CHANNEL, line)
