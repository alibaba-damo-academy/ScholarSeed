"""Native Windows sandbox selection and generation-scoped startup readiness."""

from __future__ import annotations

import asyncio
import ctypes
import hashlib
import json
import logging
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from scholarseed_codex.diagnostic import (
    NATIVE_SETUP_CANCELLED,
    NATIVE_SETUP_CODES,
    WINDOWS_PLATFORM,
)
from scholarseed_codex.protocol.session import CodexRuntimeLaunchArgument
from scholarseed_codex.protocol.state import SANDBOX_EXECUTION_METHOD, AppServerError
from scholarseed_runtime.contract.incident import RuntimeRetryability
from scholarseed_runtime.contract.resource import RESOURCE_LIFECYCLE_LOGGER
from scholarseed_runtime.contract.sandbox import (
    SANDBOX_CANCELLED_ERROR,
    SANDBOX_PREPARING_ERROR,
    SANDBOX_PROBE_ERROR,
    SANDBOX_RESOURCE_ERROR,
    SANDBOX_SETUP_ERROR,
    SANDBOX_STARTUP_ERRORS,
    SANDBOX_UNKNOWN_ERROR,
    SandboxRecovery,
    SandboxRecoveryError,
    SandboxResources,
)

RESTRICTED_SANDBOX_POLICIES = frozenset({"workspace-write", "read-only"})
SANDBOX_MODE = "elevated"
SANDBOX_ARGUMENT = CodexRuntimeLaunchArgument(
    option="-c", value=f'windows.sandbox="{SANDBOX_MODE}"'
)
SANDBOX_READONLY_PROFILE = ":read-only"
SANDBOX_READONLY_ARGUMENT = CodexRuntimeLaunchArgument(
    option="-c", value=f'default_permissions="{SANDBOX_READONLY_PROFILE}"'
)
SANDBOX_PERMISSION_METHOD = "permissionProfile/list"
SANDBOX_READINESS_METHOD = "windowsSandbox/readiness"
SANDBOX_SETUP_METHOD = "windowsSandbox/setupStart"
SANDBOX_COMPLETED_METHOD = "windowsSandbox/setupCompleted"
SANDBOX_READY = "ready"
SANDBOX_UPDATE_REQUIRED = "updateRequired"
SANDBOX_SETUP_TIMEOUT_SECONDS = 120
SANDBOX_EXECUTION_TIMEOUT_MS = 30000
PROBE_RPC_STAGE = "rpc"
PROBE_VALIDATION_STAGE = "validation"
WINDOWS_SYSTEM_PATH_CAPACITY = 32768
SANDBOX_DISCONNECTED = "disconnected"
SANDBOX_RESOURCE_VERSIONS = frozenset(
    {"0.159.0", "codex-cli 0.159.0", "0.163.0", "codex-cli 0.163.0", "0.165.0", "codex-cli 0.165.0"}
)
DIAGNOSTIC_UNKNOWN = "unknown"
SANDBOX_USERS_GROUP = "CodexSandboxUsers"
SANDBOX_RECOVERY_VERSIONS = frozenset(
    {"0.163.0", "codex-cli 0.163.0", "0.165.0", "codex-cli 0.165.0"}
)
LOGGER = logging.getLogger(f"{RESOURCE_LIFECYCLE_LOGGER}.sandbox")
NativeRequest = Callable[[str, Any], Awaitable[dict[str, Any]]]


def _system_directory() -> Path:
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetSystemDirectoryW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint]
    kernel.GetSystemDirectoryW.restype = ctypes.c_uint
    buffer = ctypes.create_unicode_buffer(WINDOWS_SYSTEM_PATH_CAPACITY)
    length = kernel.GetSystemDirectoryW(buffer, len(buffer))
    if not length or length >= len(buffer):
        raise _failure("Windows system command directory could not be resolved")
    return Path(buffer.value)


def windows_sandbox_arguments(sandbox: str) -> tuple[CodexRuntimeLaunchArgument, ...]:
    if sys.platform == WINDOWS_PLATFORM and sandbox in RESTRICTED_SANDBOX_POLICIES:
        return (SANDBOX_ARGUMENT,)
    return ()


def _failure(
    message: str,
    safe_error: str = SANDBOX_SETUP_ERROR,
    *,
    retryability: RuntimeRetryability = RuntimeRetryability.USER_RETRYABLE,
    cause: AppServerError | None = None,
    method: str = "",
) -> AppServerError:
    if safe_error in {SANDBOX_SETUP_ERROR, SANDBOX_RESOURCE_ERROR, SANDBOX_PROBE_ERROR}:
        if retryability is RuntimeRetryability.IN_PROGRESS:
            safe_error = SANDBOX_PREPARING_ERROR
        elif retryability is RuntimeRetryability.UNKNOWN_OUTCOME:
            safe_error = SANDBOX_UNKNOWN_ERROR
    return AppServerError(
        message,
        safe_error=safe_error,
        retryability=retryability,
        method=(cause.method or method) if cause is not None else method,
        generation=cause.generation if cause is not None else 0,
        rpc_code=cause.rpc_code if cause is not None else None,
        rpc_latency_ms=cause.rpc_latency_ms if cause is not None else 0,
        rpc_request_id=cause.rpc_request_id if cause is not None else None,
        rpc_pid=cause.rpc_pid if cause is not None else None,
        native_reason=cause.native_reason if cause is not None else "",
        native_stage=cause.native_stage if cause is not None else None,
        native_code_type=cause.native_code_type if cause is not None else None,
        native_code=cause.native_code if cause is not None else None,
    )


class WindowsSandboxBootstrap:
    def __init__(
        self,
        arguments: tuple[CodexRuntimeLaunchArgument, ...],
        setup_lock: asyncio.Lock | None = None,
        resources: SandboxResources | None = None,
        version: str = "",
        *,
        recovery: SandboxRecovery | None = None,
        home: Path | None = None,
        executable: Path | None = None,
    ) -> None:
        self.enabled = SANDBOX_ARGUMENT in arguments
        self._setup_lock = setup_lock if setup_lock is not None else asyncio.Lock()
        self._generation = 0
        self._resources = resources
        self._version = version
        self._recovery = recovery
        self._home = home
        self._executable = executable
        self._completion: asyncio.Future[Mapping[str, Any]] | None = None
        self._unknown_generation: int | None = None
        self._initialization_failure: tuple[int, AppServerError] | None = None
        self._initialization_deadline: float | None = None

    def initialization_cwd(self, fallback: Path) -> Path:
        return (
            _system_directory() if self.enabled and sys.platform == WINDOWS_PLATFORM else fallback
        )

    async def verify_initialization_permissions(self, request: NativeRequest, cwd: Path) -> None:
        if not self.enabled:
            return
        profiles = await request(SANDBOX_PERMISSION_METHOD, {"cwd": str(cwd)})
        if not any(
            isinstance(profile, dict)
            and profile.get("id") == SANDBOX_READONLY_PROFILE
            and profile.get("allowed") is True
            for profile in profiles.get("data", [])
        ):
            raise _failure("Windows sandbox initialization requires an allowed read-only profile")

    async def ensure_execution_ready(self, request: NativeRequest) -> None:
        """Materialize the shared runner without any Thread's writable policy."""
        if not self.enabled or sys.platform != WINDOWS_PLATFORM:
            return
        directory = _system_directory()
        native_policy = {"type": "readOnly", "networkAccess": False}
        await self._check_execution(request, directory, str(directory), native_policy)

    def initial_execution_timeout(self, generation: int, response_margin: float) -> float:
        deadline = self._initialization_deadline
        self._initialization_deadline = None
        remaining_setup = (
            max(0.0, deadline - asyncio.get_running_loop().time())
            if deadline is not None and generation == self._generation
            else 0.0
        )
        if self.enabled:
            LOGGER.info(
                "windows_sandbox_execution_budget generation=%s setup_remaining_ms=%s execution_ms=%s response_margin_ms=%s",
                generation,
                round(remaining_setup * 1000),
                SANDBOX_EXECUTION_TIMEOUT_MS,
                round(response_margin * 1000),
            )
        return remaining_setup + SANDBOX_EXECUTION_TIMEOUT_MS / 1000 + response_margin

    async def _check_execution(
        self,
        request: NativeRequest,
        directory: Path,
        execution_cwd: str,
        native_policy: dict[str, Any],
    ) -> None:
        LOGGER.info("windows_sandbox_execution_check event=started")
        try:
            result = await request(
                SANDBOX_EXECUTION_METHOD,
                {
                    "command": [str(directory / "cmd.exe"), "/d", "/c", "exit", "0"],
                    "cwd": execution_cwd,
                    "timeoutMs": SANDBOX_EXECUTION_TIMEOUT_MS,
                    "sandboxPolicy": native_policy,
                },
            )
        except Exception as error:
            retryability = (
                RuntimeRetryability.UNKNOWN_OUTCOME
                if isinstance(error, TimeoutError)
                else (
                    error.retryability
                    if isinstance(error, AppServerError)
                    else RuntimeRetryability.USER_RETRYABLE
                )
            )
            raise _failure(
                "Windows sandbox execution check failed; startup refused",
                (
                    error.safe_error
                    if isinstance(error, AppServerError)
                    and error.safe_error in SANDBOX_STARTUP_ERRORS
                    else SANDBOX_SETUP_ERROR
                ),
                retryability=retryability,
                cause=error if isinstance(error, AppServerError) else None,
                method=SANDBOX_EXECUTION_METHOD,
            ) from error
        if (
            not isinstance(result.get("exitCode"), int)
            or isinstance(result["exitCode"], bool)
            or result["exitCode"] != 0
        ):
            raise _failure(
                "Windows sandbox execution check failed; startup refused",
                method=SANDBOX_EXECUTION_METHOD,
            )
        LOGGER.info("windows_sandbox_execution_check event=ready")

    async def ensure_thread_execution_ready(
        self, request: NativeRequest, cwd: Path, policy: dict[str, Any]
    ) -> None:
        if not self.enabled or sys.platform != WINDOWS_PLATFORM:
            return
        directory = _system_directory()
        native_policy = {"type": "readOnly", "networkAccess": False}
        execution_cwd = str(directory)
        if policy.get("type") == "workspaceWrite":
            native_policy = {**policy, "networkAccess": False}
            execution_cwd = str(cwd)
        await self._check_execution(request, directory, execution_cwd, native_policy)
        if self._resources is not None:
            writable = policy.get("type") == "workspaceWrite"
            async with self._resources.verification(cwd, writable=writable) as probes:
                deadline = asyncio.get_running_loop().time() + (
                    len(probes) * SANDBOX_EXECUTION_TIMEOUT_MS / 1000
                )
                for entry, probe in enumerate(probes):
                    LOGGER.info(
                        "windows_sandbox_tool_check event=started kind=%s entry=%s",
                        probe.kind,
                        entry,
                    )
                    result = {}
                    stage = PROBE_RPC_STAGE
                    try:
                        async with asyncio.timeout_at(deadline):
                            # Windows command/exec rejects outputBytesCap. Keep the
                            # native output bound and host-owned probe validation.
                            result = await request(
                                SANDBOX_EXECUTION_METHOD,
                                {
                                    "command": list(probe.command),
                                    "cwd": execution_cwd,
                                    "timeoutMs": SANDBOX_EXECUTION_TIMEOUT_MS,
                                    "sandboxPolicy": native_policy,
                                    "env": dict(probe.environment),
                                },
                            )
                            stage = PROBE_VALIDATION_STAGE
                            await self._resources.validate_probe(probe, result)
                    except Exception as error:
                        nativeFailure = (
                            error
                            if stage == PROBE_RPC_STAGE and isinstance(error, AppServerError)
                            else None
                        )
                        LOGGER.warning(
                            "windows_sandbox_tool_check event=failed kind=%s entry=%s "
                            "stage=%s error_type=%s exit_code=%s rpc_request_id=%s rpc_code=%s "
                            "pid=%s generation=%s rpc_latency_ms=%s native_reason=%s "
                            "native_stage=%s native_code_type=%s native_code=%s",
                            probe.kind,
                            entry,
                            stage,
                            type(error).__name__,
                            (
                                result.get("exitCode")
                                if isinstance(result.get("exitCode"), int)
                                and not isinstance(result.get("exitCode"), bool)
                                else None
                            ),
                            nativeFailure.rpc_request_id if nativeFailure is not None else None,
                            nativeFailure.rpc_code if nativeFailure is not None else None,
                            nativeFailure.rpc_pid if nativeFailure is not None else None,
                            nativeFailure.generation if nativeFailure is not None else None,
                            nativeFailure.rpc_latency_ms if nativeFailure is not None else None,
                            nativeFailure.native_reason if nativeFailure is not None else "",
                            nativeFailure.native_stage if nativeFailure is not None else None,
                            nativeFailure.native_code_type if nativeFailure is not None else None,
                            nativeFailure.native_code if nativeFailure is not None else None,
                        )
                        retryability = (
                            error.retryability
                            if isinstance(error, AppServerError)
                            and error.retryability is RuntimeRetryability.UNKNOWN_OUTCOME
                            else (
                                RuntimeRetryability.UNKNOWN_OUTCOME
                                if isinstance(error, TimeoutError)
                                else RuntimeRetryability.USER_RETRYABLE
                            )
                        )
                        raise _failure(
                            "Windows bundled tool verification failed",
                            SANDBOX_PROBE_ERROR,
                            retryability=retryability,
                            cause=nativeFailure,
                            method=SANDBOX_EXECUTION_METHOD,
                        ) from error
                    LOGGER.info(
                        "windows_sandbox_tool_check event=ready kind=%s entry=%s", probe.kind, entry
                    )

    async def ensure_ready(
        self,
        request: NativeRequest,
        cwd: Path,
        generation: int,
        cleanup: Callable[[], Awaitable[None]] | None = None,
        *,
        pid: int | None = None,
        home: Path | None = None,
        prepare_resources: bool = True,
    ) -> None:
        if not self.enabled:
            return
        async with self._setup_lock:
            previous_failure = self._initialization_failure
            if previous_failure is not None and previous_failure[0] == generation:
                failure = previous_failure[1]
                raise _failure(
                    "Windows sandbox initialization failed; explicit retry is required",
                    failure.safe_error,
                    retryability=failure.retryability,
                    cause=failure,
                ) from failure
            if self._unknown_generation == generation:
                raise _failure(
                    "Windows setup outcome is unknown; restart and recheck readiness",
                    retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                )
            if home is not None:
                self._home = home
            try:
                if self._resources is not None and self._version not in SANDBOX_RESOURCE_VERSIONS:
                    raise AppServerError(
                        "Windows tool grants require a reviewed runtime version",
                        safe_error=SANDBOX_RESOURCE_ERROR,
                        retryability=RuntimeRetryability.USER_RETRYABLE,
                    )
                await self._prepare_private_storage()
                self._initialization_deadline = (
                    asyncio.get_running_loop().time() + SANDBOX_SETUP_TIMEOUT_SECONDS
                )
                try:
                    async with asyncio.timeout_at(self._initialization_deadline):
                        await self._ensure_ready(request, cwd, generation, pid)
                except TimeoutError as error:
                    raise _failure(
                        "Windows sandbox initialization timed out",
                        retryability=(
                            RuntimeRetryability.UNKNOWN_OUTCOME
                            if self._unknown_generation == generation
                            else RuntimeRetryability.USER_RETRYABLE
                        ),
                    ) from error
                await self._prepare_private_storage()
                if prepare_resources:
                    await self.prepare_resources(cwd)
            except BaseException as error:
                self._initialization_deadline = None
                initialization_failure: AppServerError | None = None
                if isinstance(error, Exception):
                    initialization_failure = (
                        error
                        if isinstance(error, AppServerError)
                        and error.safe_error in SANDBOX_STARTUP_ERRORS
                        else _failure(
                            "Windows sandbox initialization failed",
                            retryability=(
                                error.retryability
                                if isinstance(error, AppServerError)
                                else RuntimeRetryability.USER_RETRYABLE
                            ),
                            cause=error if isinstance(error, AppServerError) else None,
                        )
                    )
                    self._initialization_failure = (generation, initialization_failure)
                if cleanup is not None:
                    try:
                        await cleanup()
                    except Exception as cleanup_error:
                        LOGGER.exception("windows_sandbox_cleanup_failed")
                        raise (
                            initialization_failure if initialization_failure is not None else error
                        ) from cleanup_error
                if initialization_failure is not None and initialization_failure is not error:
                    raise initialization_failure from error
                raise

    async def prepare_resources(self, cwd: Path) -> None:
        if not self.enabled or self._resources is None:
            return
        if self._version not in SANDBOX_RESOURCE_VERSIONS:
            raise _failure(
                "Windows tool grants require a reviewed runtime version", SANDBOX_RESOURCE_ERROR
            )
        try:
            await self._resources.prepare(SANDBOX_USERS_GROUP, cwd=cwd)
        except Exception as error:
            LOGGER.exception("Windows sandbox tool resource preparation failed")
            raise _failure(
                "Windows sandbox cannot access built-in tools; check resource permissions",
                SANDBOX_RESOURCE_ERROR,
            ) from error

    async def _prepare_private_storage(self) -> None:
        if self._recovery is None:
            return
        if self._version not in SANDBOX_RECOVERY_VERSIONS:
            LOGGER.info("windows_sandbox_recovery event=unreviewed_version_skipped")
            return
        if self._home is None or self._executable is None:
            raise _failure("Windows sandbox recovery requires a runtime identity")
        try:
            await self._recovery.prepare(
                self._home, self._version.removeprefix("codex-cli "), self._executable
            )
        except SandboxRecoveryError as error:
            raise _failure(
                "Windows sandbox private storage preparation failed", error.safe_error
            ) from error
        except Exception as error:
            raise _failure("Windows sandbox private storage preparation failed") from error

    async def _ensure_ready(
        self, request: NativeRequest, cwd: Path, generation: int, pid: int | None
    ) -> None:
        self._generation = generation
        attempt_id = uuid.uuid4().hex
        started_at = time.monotonic()
        stage = "readiness"

        def diagnostic(event: str, **fields: Any) -> None:
            LOGGER.info(
                "windows_sandbox_initialization %s",
                json.dumps(
                    {
                        "event": event,
                        "stage": stage,
                        "setup_attempt_id": attempt_id,
                        "generation": generation,
                        "pid": pid if isinstance(pid, int) and not isinstance(pid, bool) else None,
                        "elapsed_ms": round((time.monotonic() - started_at) * 1000),
                        **fields,
                    },
                    sort_keys=True,
                ),
            )

        def readiness(value: Any) -> str:
            return (
                value if value in (SANDBOX_READY, SANDBOX_UPDATE_REQUIRED) else DIAGNOSTIC_UNKNOWN
            )

        diagnostic("started")
        terminal = False
        try:
            status = (await request(SANDBOX_READINESS_METHOD, None)).get("status")
            diagnostic("readiness", status=readiness(status))
            if status == SANDBOX_READY:
                diagnostic("ready")
                return
            if status != SANDBOX_UPDATE_REQUIRED:
                raise _failure("Windows sandbox configuration is not active; startup refused")
            completion = asyncio.get_running_loop().create_future()
            self._completion = completion
            stage = "setup_start"
            accepted = await request(SANDBOX_SETUP_METHOD, {"mode": SANDBOX_MODE, "cwd": str(cwd)})
            diagnostic(
                "setup_accepted",
                started=(
                    accepted.get("started")
                    if isinstance(accepted.get("started"), bool)
                    else DIAGNOSTIC_UNKNOWN
                ),
            )
            if accepted.get("started") is False:
                terminal = True
            if accepted.get("started") is not True:
                raise _failure("Windows sandbox setup was not accepted; startup refused")
            stage = "completion"
            result = await completion
            terminal = result.get("mode") == SANDBOX_MODE and isinstance(
                result.get("success"), bool
            )
            error = result.get("error")
            error_text = error if isinstance(error, str) else ""
            native_code = error_text.partition(":")[0]
            diagnostic(
                "completion",
                mode=SANDBOX_MODE if result.get("mode") == SANDBOX_MODE else DIAGNOSTIC_UNKNOWN,
                success=(
                    result.get("success")
                    if isinstance(result.get("success"), bool)
                    else DIAGNOSTIC_UNKNOWN
                ),
                native_code=(
                    native_code if native_code in NATIVE_SETUP_CODES else DIAGNOSTIC_UNKNOWN
                ),
                error_present=error is not None,
                error_is_string=isinstance(error, str),
                error_length=len(error_text) if isinstance(error, str) else None,
                error_sha256=(
                    hashlib.sha256(error_text.encode("utf-8", errors="replace")).hexdigest()
                    if isinstance(error, str)
                    else None
                ),
            )
            if error == SANDBOX_DISCONNECTED:
                diagnostic("disconnected")
                terminal = False
                raise _failure(
                    "Windows sandbox setup disconnected; restart and recheck readiness",
                    retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                )
            if result.get("mode") != SANDBOX_MODE or result.get("success") is not True:
                raise _failure(
                    "Windows sandbox setup failed",
                    (
                        SANDBOX_CANCELLED_ERROR
                        if native_code == NATIVE_SETUP_CANCELLED
                        else SANDBOX_SETUP_ERROR
                    ),
                )
            stage = "readback"
            status = (await request(SANDBOX_READINESS_METHOD, None)).get("status")
            diagnostic("readiness", status=readiness(status))
            if status != SANDBOX_READY:
                raise _failure("Windows sandbox is not ready after setup; startup refused")
            diagnostic("ready")
        except TimeoutError as error:
            diagnostic("timeout")
            uncertain = stage != "readiness" and not terminal
            if uncertain:
                self._unknown_generation = generation
            raise _failure(
                "Windows sandbox request timed out",
                retryability=(
                    RuntimeRetryability.UNKNOWN_OUTCOME
                    if uncertain
                    else RuntimeRetryability.USER_RETRYABLE
                ),
            ) from error
        except asyncio.CancelledError:
            diagnostic("cancelled")
            if stage != "readiness" and not terminal:
                self._unknown_generation = generation
            raise
        except Exception as error:
            # A transport failure is not evidence that the native helper stopped.
            diagnostic("failed")
            if stage != "readiness" and not terminal:
                self._unknown_generation = generation
                if (
                    isinstance(error, AppServerError)
                    and error.retryability is RuntimeRetryability.UNKNOWN_OUTCOME
                ):
                    raise
                raise _failure(
                    "Windows setup outcome is unknown; restart and recheck readiness",
                    retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                    cause=error if isinstance(error, AppServerError) else None,
                ) from error
            raise
        finally:
            pending_completion = self._completion
            self._completion = None
            if pending_completion is not None and not pending_completion.done():
                pending_completion.cancel()

    def completed(self, params: Mapping[str, Any], generation: int) -> None:
        completion = self._completion
        if generation == self._generation and completion is not None and not completion.done():
            completion.set_result(dict(params))

    def disconnected(self, generation: int) -> None:
        self.completed({"error": SANDBOX_DISCONNECTED}, generation)
