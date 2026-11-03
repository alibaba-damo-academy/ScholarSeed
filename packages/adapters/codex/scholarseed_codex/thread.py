"""Per-thread native Codex App Server session lifecycle."""

from __future__ import annotations

import asyncio
import inspect
import random
import sys
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any, Mapping

from scholarseed_codex.control import CodexRuntimeControl
from scholarseed_codex.mcp import MCP_STATUS_LIST_METHOD, CodexMcpControl
from scholarseed_codex.permission import (
    PERMISSION_SCOPE_SESSION,
    WINDOWS_PLATFORM,
    PermissionUpdate,
    sandbox_policy,
)
from scholarseed_codex.pool import CodexHostPool, HostLease
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.mcp import JsonValue, McpEvent
from scholarseed_codex.protocol.session import (
    CodexSessionEvent,
    CodexSessionEventKind,
    CodexSessionEventObserver,
    CodexSessionOpenRequest,
    CodexToolResponse,
    CodexTurnResult,
)
from scholarseed_codex.protocol.state import (
    CODEX_APP_SERVER_LISTEN,
    CODEX_DEFAULT_SANDBOX_MODE,
    CODEX_RECOVERY_BACKOFF_MULTIPLIER,
    CODEX_RUNTIME_ID,
    CODEX_SANDBOX_MODES,
    CODEX_SUBMISSION_RETRY_EXPIRED,
    CODEX_SUBMISSION_RETRY_STALE,
    CODEX_TRANSIENT_SUBMISSION_ERRORS,
    AppServerError,
    logger,
    normalized_roots,
)
from scholarseed_runtime.contract.evidence import RuntimeProcessEvent, RuntimeRpcEvidence
from scholarseed_runtime.contract.history import HistoryEntry, ResumeTurnSnapshot
from scholarseed_runtime.contract.incident import (
    RuntimeIncidentKind,
    RuntimeIncidentState,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.input import SubmissionRetry, TurnInput
from scholarseed_runtime.contract.resource import RESOURCE_HOST_CONTEXT_REQUIRED

CODEX_MODEL_PROVIDER_CAPABILITIES_METHOD = "modelProvider/capabilities/read"
CODEX_THREAD_RESTORE_FAILED = "codex_thread_restore_failed"


def _json_int(value: JsonValue | None) -> int:
    if not isinstance(value, (str, int, float)):
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


class CodexThreadSession:
    """One Codex thread handle backed by a shared process host."""

    backend = CODEX_RUNTIME_ID
    provider = CODEX_RUNTIME_ID
    endpoint = CODEX_APP_SERVER_LISTEN
    tools_count = 0

    def __init__(
        self,
        request: CodexSessionOpenRequest,
        *,
        on_event: CodexSessionEventObserver | None = None,
        host: CodexProcessHost | None = None,
        host_pool: CodexHostPool | None = None,
        lease: HostLease | None = None,
    ) -> None:
        sandbox = request.sandbox or CODEX_DEFAULT_SANDBOX_MODE
        if sandbox not in CODEX_SANDBOX_MODES:
            raise ValueError(
                f"unsupported Codex sandbox {sandbox!r}; expected {CODEX_SANDBOX_MODES}"
            )
        self.request = request
        self.on_event = on_event
        self.sandbox = sandbox
        self.approval_policy = request.approval_policy
        self.model = request.model
        self.context_window = 0
        self.session_id = ""
        self.active_turn_id = ""
        self.todos: list[dict[str, JsonValue]] = []
        self.usage: dict[str, int] = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
        }
        self._history: tuple[HistoryEntry, ...] = ()
        self._lease = lease
        self._host = lease.host if lease is not None else host
        self._host_pool = host_pool or CodexHostPool()
        self._owns_pool = host_pool is None and lease is None and host is None
        self._pooled_host = host is None
        self._opened = False
        self.submission_deadline = 0.0
        self.submission_attempts = 0
        self.mcp_control: CodexMcpControl | None = None
        self._mcp_unsubscribe: Callable[[], None] | None = None

    @property
    def modes(self) -> tuple[str, ...]:
        return (self.sandbox,)

    @property
    def history(self) -> tuple[HistoryEntry, ...]:
        if self._opened and self.session_id:
            return self.host.history(self.session_id)
        return self._history

    @property
    def resume_turns(self) -> tuple[ResumeTurnSnapshot, ...]:
        if self._opened and self.session_id:
            return self.host.resume_turns(self.session_id)
        return ()

    @property
    def process_events(self) -> tuple[RuntimeProcessEvent, ...]:
        return self.host.process_events if self._host is not None else ()

    @property
    def rpc_evidence(self) -> tuple[RuntimeRpcEvidence, ...]:
        return self.host.rpc_evidence if self._host is not None else ()

    @property
    def host(self) -> CodexProcessHost:
        if self._host is None:
            raise AppServerError("Codex thread has not been opened")
        return self._host

    def adopt_lease(self, lease: HostLease) -> None:
        if self._host is not None or self._opened:
            raise AppServerError("runtime_resource_reservation_invalid")
        self._lease = lease
        self._host = lease.host

    @property
    def lease(self) -> HostLease | None:
        return self._lease

    async def suspend(self, expected_generation: int, *, retry: bool = False) -> None:
        host = self.host
        if self._opened:
            await host.suspend_thread(self.session_id, expected_generation)
            self._opened = False
        if self._mcp_unsubscribe is not None:
            self._mcp_unsubscribe()
            self._mcp_unsubscribe = None
        if self._lease is not None:
            retain = bool(self.request.process_sharing_scope) and sys.platform != WINDOWS_PLATFORM
            if retry:
                await self._lease.retry_close(
                    expected_generation=expected_generation, retain=retain
                )
            else:
                await self._lease.close(
                    safe=True, expected_generation=expected_generation, retain=retain
                )
            self._lease = None
        self._host = None
        self.mcp_control = None

    async def open(self) -> None:
        if self._opened:
            return
        if self._host is None:
            self._lease = await self._host_pool.acquire(self.request)
            self._host = self._lease.host
        try:
            await self._attach()
        except BaseException:
            if self._lease is not None:
                await self._lease.close()
                self._lease = None
                self._host = None
            if self._owns_pool:
                await self._host_pool.aclose()
            raise

    async def _attach(self) -> None:
        self.session_id, self.model, self._history = await self.host.open_thread(
            self.request,
            self._on_event,
        )
        self.mcp_control = CodexMcpControl(
            request=self._thread_request,
            session_id=lambda: self.session_id,
            admission=self.host.admission,
            reload_configuration=(
                self._host_pool.reload_mcp if self._host_pool.mcp_configuration_enabled else None
            ),
        )
        self._mcp_unsubscribe = self.mcp_control.subscribe(self._on_mcp_event)
        self.host.set_mcp_handler(
            self.session_id, self.mcp_control.handle_notification, self.mcp_control.invalidate
        )
        self._opened = True

    async def reopen(self, request: CodexSessionOpenRequest) -> None:
        if not self._opened or self._lease is None or request.resume_session_id != self.session_id:
            raise AppServerError("Codex thread cannot be reopened in place")
        await self.host.suspend_thread(self.session_id, self.host.process_generation)
        if self._mcp_unsubscribe is not None:
            self._mcp_unsubscribe()
            self._mcp_unsubscribe = None
        self._opened = False
        self.mcp_control = None
        previous_request = replace(self.request, resume_session_id=self.session_id)
        self.request = request
        try:
            await self._attach()
        except BaseException:
            self.request = previous_request
            try:
                await self._attach()
            except BaseException as restore_error:
                raise AppServerError(
                    "Codex thread could not restore its previous configuration",
                    safe_error=CODEX_THREAD_RESTORE_FAILED,
                ) from restore_error
            raise

    async def model_provider_capabilities(self) -> Mapping[str, JsonValue]:
        """Read App Server provider capability bounds before creating a thread."""

        if self._host is None:
            self._lease = await self._host_pool.acquire(self.request)
            self._host = self._lease.host
        return await self.host.request(CODEX_MODEL_PROVIDER_CAPABILITIES_METHOD, {})

    async def fork(
        self,
        request: CodexSessionOpenRequest,
        *,
        portable_history: tuple[HistoryEntry, ...] | None = None,
    ) -> str:
        """Fork this idle thread, replaying portable history when providers differ."""

        if not self._opened or not self.session_id:
            raise AppServerError("Codex thread has not been opened")
        return await self.host.fork_thread(
            self.session_id,
            request,
            portable_history=portable_history,
        )

    async def _thread_request(self, method: str, params: Any) -> dict[str, Any]:
        if method == MCP_STATUS_LIST_METHOD:
            async with self.inventory_control() as control:
                async with control.reading():
                    await self.host.ensure_attached(self.session_id)
                    return await control.request(method, params)
        generation = await self.host.ensure_attached(self.session_id)
        return await self.host.request(method, params, generation=generation)

    @asynccontextmanager
    async def inventory_control(self) -> AsyncIterator[CodexRuntimeControl]:
        if self._lease is None or not self._opened:
            raise AppServerError(
                RESOURCE_HOST_CONTEXT_REQUIRED, safe_error=RESOURCE_HOST_CONTEXT_REQUIRED
            )
        control = CodexRuntimeControl(
            cwd=self.request.cwd, lease=self._lease, host_pool=self._host_pool
        )
        await control.open()
        try:
            yield control
        finally:
            await control.aclose()

    async def _on_event(self, event: CodexSessionEvent) -> None:
        payload = dict(event.payload)
        if event.kind == CodexSessionEventKind.TURN_STARTED:
            self.active_turn_id = event.turn_id
        elif event.kind in {
            CodexSessionEventKind.TURN_COMPLETED,
            CodexSessionEventKind.TURN_FAILED,
            CodexSessionEventKind.TURN_INTERRUPTED,
        }:
            self.active_turn_id = ""
        elif (
            event.kind == CodexSessionEventKind.TURN_UNKNOWN
            and event.session_id == self.session_id
            and event.turn_id == self.active_turn_id
            and event.incident is not None
            and event.incident.kind is RuntimeIncidentKind.PROCESS_EXIT
            and event.incident.state is RuntimeIncidentState.DETECTED
        ):
            self.active_turn_id = ""
        elif event.kind == CodexSessionEventKind.PLAN_UPDATED:
            raw_todos = payload.get("todos")
            self.todos = (
                [dict(row) for row in raw_todos if isinstance(row, Mapping)]
                if isinstance(raw_todos, list)
                else []
            )
        elif event.kind == CodexSessionEventKind.USAGE_UPDATED:
            self.context_window = _json_int(payload.get("context_window"))
            self.usage = {
                "input_tokens": _json_int(payload.get("input_tokens")),
                "output_tokens": _json_int(payload.get("output_tokens")),
                "cache_read_tokens": _json_int(payload.get("cache_read_tokens")),
                "cache_creation_tokens": _json_int(payload.get("cache_creation_tokens")),
            }
        if self.on_event is None:
            return
        result = self.on_event(event)
        if inspect.isawaitable(result):
            await result

    async def _on_mcp_event(self, event: McpEvent) -> None:
        await self.host.emit_mcp_event(
            self.session_id,
            {
                "kind": event.kind.value,
                "session_id": event.session_id,
                "runtime_id": event.runtime_id,
                "server": event.server,
                "seq": event.seq,
                "inventory_revision": event.inventory_revision,
                "payload": dict(event.payload),
            },
        )

    async def run(self, turn_input: TurnInput) -> CodexTurnResult:
        await self.open()
        host = self.host
        thread_id = self.session_id
        state = host.attachment(thread_id)
        turn = state.turn
        revision = turn.submission_revision
        request = self.request
        native_request = state.request
        model = state.model
        roots = state.writable_roots
        logical_input = replace(
            turn_input, client_user_message_id=turn_input.client_user_message_id or uuid.uuid4().hex
        )
        deadline = min(
            turn_input.submission_deadline or float("inf"),
            asyncio.get_running_loop().time() + host.recovery_total_timeout,
        )
        self.submission_deadline = deadline
        attempt = turn_input.submission_attempts
        retry_guard: Callable[[], None] | None = None

        def authorize_intent() -> None:
            turn.check_submission_revision(revision)
            if (
                self.host is not host
                or self.session_id != thread_id
                or self.request is not request
                or host.attachment(thread_id) is not state
                or state.request is not native_request
                or state.turn is not turn
                or state.model != model
                or state.writable_roots != roots
            ):
                raise AppServerError(
                    CODEX_SUBMISSION_RETRY_STALE,
                    safe_error=CODEX_SUBMISSION_RETRY_STALE,
                    submission_not_applied=True,
                )
            if asyncio.get_running_loop().time() >= deadline:
                raise AppServerError(
                    CODEX_SUBMISSION_RETRY_EXPIRED,
                    safe_error=CODEX_SUBMISSION_RETRY_EXPIRED,
                    submission_not_applied=True,
                )

        while True:
            if attempt >= host.max_recovery_attempts:
                raise AppServerError(
                    CODEX_SUBMISSION_RETRY_EXPIRED,
                    safe_error=CODEX_SUBMISSION_RETRY_EXPIRED,
                    submission_not_applied=True,
                )
            attempt += 1
            self.submission_attempts = attempt
            turn.check_submission_revision(revision)
            try:
                result = await turn.start(
                    logical_input, before_write=retry_guard, deadline=deadline
                )
                break
            except AppServerError as error:
                remaining = deadline - asyncio.get_running_loop().time()
                if (
                    not error.submission_not_applied
                    or error.safe_error not in CODEX_TRANSIENT_SUBMISSION_ERRORS
                    or error.retryability is not RuntimeRetryability.USER_RETRYABLE
                    or error.rpc_code is not None
                    or attempt >= host.max_recovery_attempts
                    or remaining <= 0
                ):
                    raise
                authorize_intent()
                logger.info(
                    "codex_submission_retry thread_id=%s client_submission_id=%s attempt=%s max_attempts=%s safe_error=%s generation=%s",
                    thread_id,
                    logical_input.client_user_message_id,
                    attempt + 1,
                    host.max_recovery_attempts,
                    error.safe_error,
                    error.generation,
                )
                delay = min(
                    host.recovery_initial_delay
                    * CODEX_RECOVERY_BACKOFF_MULTIPLIER ** (attempt - 1),
                    host.recovery_max_delay,
                )
                jitter = delay * host.recovery_jitter_ratio
                delay = min(max(0.0, delay + random.uniform(-jitter, jitter)), remaining)
                await turn.wait_submission_retry(revision, delay)

                async def prepare_retry(
                    failed_generation: int = error.generation, current_attempt: int = attempt
                ) -> Callable[[], None]:
                    guard = await host.prepare_submission_retry(
                        thread_id, logical_input.client_user_message_id
                    )

                    def product_current() -> bool:
                        return True

                    if logical_input.retry_observer is not None:
                        product_current = await logical_input.retry_observer(
                            SubmissionRetry(
                                failed_generation,
                                host.process_generation,
                                deadline,
                                current_attempt,
                            )
                        )

                    def authorize() -> None:
                        guard()
                        if not product_current():
                            raise AppServerError(
                                CODEX_SUBMISSION_RETRY_STALE,
                                safe_error=CODEX_SUBMISSION_RETRY_STALE,
                            )

                    return authorize

                try:
                    async with asyncio.timeout_at(deadline):
                        authorize_intent()
                        native_guard = await turn.prepare_submission_retry(
                            prepare_retry(),
                            revision,
                            deadline,
                        )
                        authorize_intent()
                except TimeoutError:
                    raise error
                except Exception as gate_error:
                    unknown = bool(
                        turn.active_turn_id
                        or turn.ambiguous_submission_id
                        or turn.interrupted_turn_id
                    )
                    raise AppServerError(
                        "Codex submission retry was not admitted",
                        safe_error=(
                            gate_error.safe_error
                            if isinstance(gate_error, AppServerError)
                            else CODEX_SUBMISSION_RETRY_STALE
                        ),
                        generation=host.process_generation,
                        retryability=(
                            RuntimeRetryability.UNKNOWN_OUTCOME
                            if unknown
                            else RuntimeRetryability.USER_RETRYABLE
                        ),
                        submission_not_applied=not unknown,
                    ) from gate_error

                def authorize_retry(guard: Callable[[], None] = native_guard) -> None:
                    authorize_intent()
                    guard()

                retry_guard = authorize_retry
        self.active_turn_id = ""
        self.usage = {
            "input_tokens": result.usage.input_tokens,
            "output_tokens": result.usage.output_tokens,
            "cache_read_tokens": result.usage.cache_read_tokens,
            "cache_creation_tokens": result.usage.cache_creation_tokens,
        }
        return result

    async def steer(self, turn_input: TurnInput) -> str:
        await self.open()
        return await self.host.attachment(self.session_id).turn.steer(turn_input)

    async def update_permissions(self, request: CodexSessionOpenRequest) -> PermissionUpdate:
        applied = PermissionUpdate(PERMISSION_SCOPE_SESSION)
        if self._opened:
            applied = await self.host.update_permissions(self.session_id, request)
        self.request = request
        self.sandbox = request.sandbox
        self.approval_policy = request.approval_policy
        return applied

    async def resolve_hil(
        self,
        request_id: str,
        response: Mapping[str, JsonValue],
    ) -> bool:
        if not self._opened:
            return False
        return await self.host.resolve_hil(self.session_id, request_id, response)

    async def resolve_tool(self, request_id: str, response: CodexToolResponse) -> bool:
        if not self._opened:
            return False
        return await self.host.resolve_tool(self.session_id, request_id, response)

    def sandbox_policy(self) -> Mapping[str, JsonValue]:
        return sandbox_policy(self.request, self.writable_roots())

    def writable_roots(self) -> tuple[str, ...]:
        """该会话下一个 turn 会下发的额外可写根。"""

        if not self.session_id:
            return normalized_roots(self.request.writable_roots)
        return self.host.thread_writable_roots(self.session_id)

    async def set_writable_roots(self, roots: tuple[Path, ...]) -> None:
        """替换额外可写根 (`SurfaceWritableRootsPort`)。下一个 turn 生效。

        未打开时更新初始请求，已打开时同时更新 attachment 的下一轮请求。
        """

        if self.session_id:
            await self.host.set_writable_roots(self.session_id, roots)
        self.request = replace(self.request, writable_roots=roots)

    async def aclose(self) -> None:
        if self._mcp_unsubscribe is not None:
            self._mcp_unsubscribe()
            self._mcp_unsubscribe = None
        host = self._host
        if host is None:
            if self._owns_pool:
                await self._host_pool.aclose()
            return
        if self._opened:
            await host.close_thread(self.session_id)
        self._opened = False
        self.session_id = ""
        self.mcp_control = None
        if self._lease is not None:
            await self._lease.close()
            self._lease = None
            self._host = None
        if self._owns_pool:
            await self._host_pool.aclose()


__all__ = ["CodexThreadSession"]
