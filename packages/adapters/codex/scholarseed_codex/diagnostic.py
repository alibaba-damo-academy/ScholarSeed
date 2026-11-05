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
DIAGNOSTIC_LOOKAHEAD_CHARS = 2
STDERR_LINE_LIMIT = 64 * 1024
STDERR_CHUNK_BYTES = 16 * 1024
UNSPECIFIED_REASON = "unspecified"
SANDBOX_MARKER = "windows sandbox"
RPC_DIAGNOSTIC_CHANNEL = "rpc"
WINDOWS_PLATFORM = "win32"
SANDBOX_RPC_PREFIX = "exec failed: windows sandbox: "
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
OS_ERROR = re.compile(r"\bos error ([0-9]{1,10})(?!\w|\.[0-9])", re.IGNORECASE)
RUNNER_LOGON_ERROR = re.compile(r"CreateProcessWithLogonW failed: ([0-9]{1,10})")
RUNNER_STAGE_PREFIX = "runner failed during "
RUNNER_STAGES = {
    "ReadSpawnRequest": "runner_read_spawn_request",
    "SpawnChild": "runner_spawn_child",
    "WriteSpawnReady": "runner_write_spawn_ready",
}
RUNNER_READY_ERRORS = frozenset(
    {"wait for runner spawn_ready", "runner pipe closed before spawn_ready"}
)
RUNNER_CHILD_ERROR = re.compile(
    r"CreateProcessAsUserW failed: (?P<code>[0-9]{1,10}) \([^\r\n]*"
    r" \| env_u16_len=[0-9]+ \| si_flags=[0-9]+ \| creation_flags=[0-9]+"
    r" \(Windows error (?P=code)\)"
)
WIN32_CODE_TYPE = "win32"
SETUP_LAUNCH_ERROR = re.compile(r"ShellExecuteExW failed to launch setup helper: ([0-9]{1,10})")
SETUP_COMPLETION_ERROR = "orchestrator_helper_incomplete"
SETUP_LAUNCH_FAILED = "orchestrator_helper_launch_failed"
NATIVE_SETUP_CANCELLED = "orchestrator_helper_launch_canceled"
WINDOWS_ERROR_CANCELLED = 1223
# Reviewed native codes only; never print an arbitrary prefix from the native error.
NATIVE_SETUP_CODES = frozenset(
    {
        "orchestrator_sandbox_dir_create_failed",
        "orchestrator_elevation_check_failed",
        "orchestrator_elevation_required",
        "orchestrator_payload_serialize_failed",
        SETUP_LAUNCH_FAILED,
        NATIVE_SETUP_CANCELLED,
        "orchestrator_helper_exit_nonzero",
        "orchestrator_helper_report_read_failed",
        SETUP_COMPLETION_ERROR,
        "helper_request_args_failed",
        "helper_sandbox_dir_create_failed",
        "helper_log_failed",
        "helper_user_provision_failed",
        "helper_users_group_create_failed",
        "helper_user_create_or_update_failed",
        "helper_dpapi_protect_failed",
        "helper_users_file_write_failed",
        "helper_setup_marker_write_failed",
        "helper_sid_resolve_failed",
        "helper_capability_sid_failed",
        "helper_firewall_com_init_failed",
        "helper_firewall_policy_access_failed",
        "helper_firewall_policy_ineffective",
        "helper_firewall_rule_create_or_add_failed",
        "helper_firewall_rule_verify_failed",
        "helper_read_acl_helper_spawn_failed",
        "helper_sandbox_lock_failed",
        "helper_unknown_error",
    }
)
SANDBOX_REASONS = (
    ("createprocesswithlogonw", "windows_sandbox_process_launch"),
    ("access is denied", "windows_sandbox_access_denied"),
    ("logon failure", "windows_sandbox_logon_failed"),
)


@dataclass(frozen=True)
class NativeDiagnostic:
    reason: str
    summary: str
    os_error: int | None = None
    native_stage: str | None = None
    code_type: str | None = None
    code: int | None = None


def _sandbox_rpc_metadata(message: str) -> tuple[str | None, str | None, int | None]:
    if len(message) > DIAGNOSTIC_SCAN_LIMIT or not message.startswith(SANDBOX_RPC_PREFIX):
        return None, None, None
    detail = message[len(SANDBOX_RPC_PREFIX) :]
    name, separator, description = detail.partition(": ")
    stage = None
    codeMatch = None
    if separator and name == "CreateProcessWithLogonW failed":
        stage = "runner_logon"
        codeMatch = RUNNER_LOGON_ERROR.fullmatch(detail)
    elif separator and name.startswith(RUNNER_STAGE_PREFIX):
        stage = RUNNER_STAGES.get(name.removeprefix(RUNNER_STAGE_PREFIX))
        if stage == RUNNER_STAGES["SpawnChild"]:
            codeMatch = RUNNER_CHILD_ERROR.fullmatch(description)
    elif PIPE_TIMEOUT.fullmatch(detail):
        stage = "runner_pipe_connect"
    elif detail in RUNNER_READY_ERRORS:
        stage = "runner_spawn_ready"
    elif separator and name in NATIVE_SETUP_CODES:
        stage = "setup_completion_check" if name == SETUP_COMPLETION_ERROR else "setup"
        if name in (SETUP_LAUNCH_FAILED, NATIVE_SETUP_CANCELLED):
            codeMatch = SETUP_LAUNCH_ERROR.fullmatch(description)
            if codeMatch and (int(codeMatch[1]) == WINDOWS_ERROR_CANCELLED) != (
                name == NATIVE_SETUP_CANCELLED
            ):
                codeMatch = None
    code = int(codeMatch[1]) if codeMatch is not None else None
    if code is None or code > SYSTEM_CODE_LIMIT:
        return stage, None, None
    return stage, WIN32_CODE_TYPE, code


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


def native_diagnostic(
    channel: str, message: str, *, windows_command_failure: bool = False
) -> NativeDiagnostic:
    """Classify reported errors, not their root cause; unknown text stays hashed."""
    sample = message[:DIAGNOSTIC_SCAN_LIMIT].casefold()
    reason = UNSPECIFIED_REASON
    fields: list[str] = []
    systemCode = None
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
        error = OS_ERROR.search(message[: DIAGNOSTIC_SCAN_LIMIT + DIAGNOSTIC_LOOKAHEAD_CHARS])
        if (
            error is not None
            and error.end() <= DIAGNOSTIC_SCAN_LIMIT
            and int(error[1]) <= SYSTEM_CODE_LIMIT
        ):
            systemCode = int(error[1])
            fields.append(f"os_error={systemCode}")
    elif WRITER_MARKER in sample:
        reason = "thread_writer_busy"
    summary = " ".join((f"reason={reason}", *fields, _redacted_diagnostic(channel, message)))
    stage, codeType, code = (
        _sandbox_rpc_metadata(message)
        if channel == RPC_DIAGNOSTIC_CHANNEL and windows_command_failure
        else (None, None, None)
    )
    return NativeDiagnostic(reason, summary, systemCode, stage, codeType, code)


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
