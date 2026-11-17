"""Host transport for the installed, policy-bound Windows sandbox helper."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from scholarseed_runtime.contract.sandbox import (
    SANDBOX_CANCELLED_ERROR,
    SANDBOX_POLICY_ERROR,
    SANDBOX_SETUP_ERROR,
    SandboxRecoveryError,
)
from scholarseed_runtime.contract.storage import StorageRoot

RECOVERY_HELPER_ENV = "SCHOLARSEED_SANDBOX_RECOVERY_HELPER"
WINDOWS_PLATFORM = "win32"
NATIVE_OUTPUT_LIMIT = 8192
RECOVERY_OUTCOMES = frozenset({"prepared", "unchanged", "repaired", "unsupported"})
RECOVERY_FAILED = "failed"
RECOVERY_STAGES = frozenset(
    {
        "policy",
        "arguments",
        "version",
        "coordinator",
        "installation",
        "runtime",
        "identity",
        "location",
        "ancestor_profile",
        "ancestor_product",
        "ancestor_codex",
        "target",
        "owner",
        "elevation",
        "worker",
        "worker_privilege",
        "verification",
        "metadata",
    }
)
RECOVERY_REASONS = frozenset(
    {
        "policy_rejected",
        "access_denied",
        "privilege_missing",
        "cancelled",
        "system_error",
        "worker_failed",
    }
)
RECOVERY_ERROR_CODES = {
    "policy_rejected": SANDBOX_POLICY_ERROR,
    "cancelled": SANDBOX_CANCELLED_ERROR,
}
RECOVERY_OBJECTS = frozenset(
    {"profile", "product", "codex", "sandbox_bin", "metadata", "daily_log"}
)
RECOVERY_RULES = frozenset(
    {
        "invalid_descriptor",
        "invalid_acl",
        "unsupported_ace",
        "deny_ace",
        "owner_rights_mask",
        "unknown_principal",
        "native_group_mask",
        "untrusted_owner",
        "maintenance_owner",
        "acl_limit",
        "security_drift",
        "postcondition_drift",
        "reparse_point",
        "object_type",
        "hardlink",
        "daily_log_limit",
        "native_deny",
        "permission_mask",
        "private_policy",
        "unknown",
    }
)
NATIVE_ERROR_LIMIT = 0xFFFFFFFF
NATIVE_ENCODING = "utf-8"
LOGGER = logging.getLogger(__name__)


def _failure(
    stage: str,
    reason: str,
    exit_code: int | None,
    system_error: int = 0,
    details: tuple[str, str, int | None] | None = None,
) -> SandboxRecoveryError:
    suffix = ""
    if details is not None:
        object_kind, rule, count = details
        suffix = f" object={object_kind} rule={rule}"
        if count is not None:
            suffix += f" count={count}"
    LOGGER.warning(
        "windows_sandbox_recovery event=failed stage=%s reason=%s exit_code=%s system_error=%s%s",
        stage,
        reason,
        exit_code,
        system_error,
        suffix,
    )
    return SandboxRecoveryError(RECOVERY_ERROR_CODES.get(reason, SANDBOX_SETUP_ERROR))


async def _read_output(stream: asyncio.StreamReader | None) -> tuple[bytearray, bool]:
    output = bytearray()
    overflow = False
    if stream is not None:
        while chunk := await stream.read(NATIVE_OUTPUT_LIMIT):
            if len(output) + len(chunk) > NATIVE_OUTPUT_LIMIT:
                overflow = True
            if not overflow:
                output.extend(chunk)
    return output, overflow


def _metadata_details(
    output: bytearray, receipt: dict[str, object]
) -> tuple[str, str, int | None] | None:
    if receipt.get("stage") != "metadata":
        return None
    matches = []
    for line in output.splitlines():
        try:
            detail = json.loads(line.decode(NATIVE_ENCODING))
        except (ValueError, UnicodeError, RecursionError):
            continue
        if not isinstance(detail, dict) or not set(detail) <= {
            "event",
            "stage",
            "reason",
            "system_error",
            "object",
            "rule",
            "count",
        }:
            continue
        if (
            any(detail.get(key) != receipt.get(key) for key in ("event", "stage", "reason"))
            or type(detail.get("system_error", 0)) is not int
            or detail.get("system_error", 0) != receipt.get("system_error", 0)
        ):
            continue
        object_kind, rule, count = detail.get("object"), detail.get("rule"), detail.get("count")
        if (
            not isinstance(object_kind, str)
            or object_kind not in RECOVERY_OBJECTS
            or not isinstance(rule, str)
            or rule not in RECOVERY_RULES
        ):
            continue
        if "count" in detail and (
            rule != "daily_log_limit"
            or type(count) is not int
            or not 0 < count <= NATIVE_ERROR_LIMIT
        ):
            continue
        matches.append((object_kind, rule, count))
    return matches[0] if len(matches) == 1 else None


@dataclass(frozen=True)
class SandboxRecovery:
    helper: Path
    homes: frozenset[Path]

    async def prepare(self, home: Path, version: str, executable: Path) -> None:
        if home not in self.homes:
            raise PermissionError("sandbox recovery home is outside the frozen runtime inventory")
        operation = asyncio.create_task(self._run(home, version, executable))
        cancelled = False
        while not operation.done():
            try:
                await asyncio.shield(operation)
            except asyncio.CancelledError:
                cancelled = True
            except Exception:
                break
        if cancelled:
            try:
                operation.result()
            except Exception:
                LOGGER.warning("windows_sandbox_recovery event=failed_after_cancellation")
            raise asyncio.CancelledError
        operation.result()

    async def _run(self, home: Path, version: str, executable: Path) -> None:
        LOGGER.info("windows_sandbox_recovery event=started")
        try:
            process = await asyncio.create_subprocess_exec(
                str(self.helper),
                "--sandbox-home",
                str(home),
                "--sandbox-version",
                version,
                "--sandbox-runtime",
                str(executable),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as error:
            system_error = getattr(error, "winerror", None) or error.errno or 0
            if (
                not isinstance(system_error, int) or isinstance(system_error, bool)
            ) or not 0 <= system_error <= NATIVE_ERROR_LIMIT:
                system_error = 0
            raise _failure("helper_launch", "launch_failed", None, system_error) from None
        assert process.stdout is not None
        try:
            (output, overflow), (diagnostic, diagnostic_overflow) = await asyncio.gather(
                _read_output(process.stdout), _read_output(process.stderr)
            )
        finally:
            code = await process.wait()
        if overflow:
            raise _failure("transport", "output_limit", code)
        try:
            result = json.loads(output.decode(NATIVE_ENCODING))
        except (ValueError, UnicodeError, RecursionError):
            raise _failure("transport", "invalid_response", code) from None
        if isinstance(result, dict) and code != 0 and result.get("event") == RECOVERY_FAILED:
            stage, reason = result.get("stage"), result.get("reason")
            system_error = result.get("system_error", 0)
            if (
                set(result) <= {"event", "stage", "reason", "system_error"}
                and isinstance(stage, str)
                and stage in RECOVERY_STAGES
                and isinstance(reason, str)
                and reason in RECOVERY_REASONS
                and (isinstance(system_error, int) and not isinstance(system_error, bool))
                and 0 <= system_error <= NATIVE_ERROR_LIMIT
            ):
                details = None if diagnostic_overflow else _metadata_details(diagnostic, result)
                raise _failure(stage, reason, code, system_error, details)
            raise _failure("transport", "invalid_response", code)
        if code != 0:
            raise _failure("transport", "unexpected_exit", code)
        if not isinstance(result, dict) or set(result) != {"event"}:
            raise _failure("transport", "invalid_response", code)
        outcome = result["event"]
        if not isinstance(outcome, str) or outcome not in RECOVERY_OUTCOMES:
            raise _failure("transport", "invalid_response", code)
        LOGGER.info("windows_sandbox_recovery event=%s", outcome)


def load_sandbox_recovery(roots: tuple[StorageRoot, ...]) -> SandboxRecovery | None:
    helper = os.environ.get(RECOVERY_HELPER_ENV, "")
    if sys.platform != WINDOWS_PLATFORM or not helper:
        return None
    path = Path(helper)
    # The Adapter selects whether this reviewed version needs recovery. Merely
    # declaring an unused transport must not turn a missing helper into a global
    # runtime discovery failure; CreateProcess reports actual launch failures.
    if not path.is_absolute():
        raise PermissionError("installed sandbox recovery helper is unavailable")
    return SandboxRecovery(path, frozenset(root.path for root in roots))
