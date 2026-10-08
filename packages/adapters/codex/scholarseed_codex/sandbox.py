"""Native Windows sandbox selection and generation-scoped startup readiness."""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from scholarseed_codex.protocol.session import CodexRuntimeLaunchArgument
from scholarseed_codex.protocol.state import AppServerError
from scholarseed_runtime.contract.incident import RuntimeRetryability
from scholarseed_runtime.contract.resource import RESOURCE_LIFECYCLE_LOGGER

WINDOWS_PLATFORM = "win32"
RESTRICTED_SANDBOX_POLICIES = frozenset({"workspace-write", "read-only"})
SANDBOX_MODE = "elevated"
SANDBOX_ARGUMENT = CodexRuntimeLaunchArgument(
    option="-c", value=f'windows.sandbox="{SANDBOX_MODE}"'
)
SANDBOX_READINESS_METHOD = "windowsSandbox/readiness"
SANDBOX_SETUP_METHOD = "windowsSandbox/setupStart"
SANDBOX_COMPLETED_METHOD = "windowsSandbox/setupCompleted"
SANDBOX_READY = "ready"
SANDBOX_UPDATE_REQUIRED = "updateRequired"
SANDBOX_SETUP_TIMEOUT_SECONDS = 120
SANDBOX_SETUP_ERROR = "windows_sandbox_setup_failed"
SANDBOX_DISCONNECTED = "disconnected"
LOGGER = logging.getLogger(f"{RESOURCE_LIFECYCLE_LOGGER}.sandbox")
NativeRequest = Callable[[str, Any], Awaitable[dict[str, Any]]]


def windows_sandbox_arguments(sandbox: str) -> tuple[CodexRuntimeLaunchArgument, ...]:
    if sys.platform == WINDOWS_PLATFORM and sandbox in RESTRICTED_SANDBOX_POLICIES:
        return (SANDBOX_ARGUMENT,)
    return ()


def _failure(message: str) -> AppServerError:
    return AppServerError(
        message,
        safe_error=SANDBOX_SETUP_ERROR,
        retryability=RuntimeRetryability.USER_RETRYABLE,
    )


class WindowsSandboxBootstrap:
    def __init__(
        self,
        arguments: tuple[CodexRuntimeLaunchArgument, ...],
        setup_lock: asyncio.Lock | None = None,
    ) -> None:
        self.enabled = SANDBOX_ARGUMENT in arguments
        self._setup_lock = setup_lock if setup_lock is not None else asyncio.Lock()
        self._generation = 0
        self._completion: asyncio.Future[Mapping[str, Any]] | None = None

    async def ensure_ready(
        self,
        request: NativeRequest,
        cwd: Path,
        generation: int,
        cleanup: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        if not self.enabled:
            return
        async with self._setup_lock:
            try:
                await self._ensure_ready(request, cwd, generation)
            except BaseException:
                if cleanup is not None:
                    await cleanup()
                raise

    async def _ensure_ready(self, request: NativeRequest, cwd: Path, generation: int) -> None:
        self._generation = generation
        try:
            async with asyncio.timeout(SANDBOX_SETUP_TIMEOUT_SECONDS):
                status = (await request(SANDBOX_READINESS_METHOD, None)).get("status")
                LOGGER.info(
                    "Windows native sandbox readiness checked",
                    extra={"generation": generation, "sandbox_status": status},
                )
                if status == SANDBOX_READY:
                    LOGGER.info("Windows native sandbox ready", extra={"generation": generation})
                    return
                if status != SANDBOX_UPDATE_REQUIRED:
                    raise _failure("Windows sandbox configuration is not active; startup refused")
                completion = asyncio.get_running_loop().create_future()
                self._completion = completion
                LOGGER.info(
                    "Windows native sandbox setup requested", extra={"generation": generation}
                )
                accepted = await request(
                    SANDBOX_SETUP_METHOD, {"mode": SANDBOX_MODE, "cwd": str(cwd)}
                )
                if accepted.get("started") is not True:
                    raise _failure("Windows sandbox setup was not accepted; startup refused")
                result = await completion
                if result.get("error") == SANDBOX_DISCONNECTED:
                    raise _failure("Windows sandbox setup disconnected; retry startup")
                if result.get("mode") != SANDBOX_MODE or result.get("success") is not True:
                    raise _failure(
                        "Windows sandbox setup failed or was cancelled; check Windows setup permissions"
                    )
                if (await request(SANDBOX_READINESS_METHOD, None)).get("status") != SANDBOX_READY:
                    raise _failure("Windows sandbox is not ready after setup; startup refused")
                LOGGER.info("Windows native sandbox ready", extra={"generation": generation})
        except TimeoutError as error:
            raise _failure(
                "Windows sandbox setup timed out; finish or retry Windows setup"
            ) from error
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
