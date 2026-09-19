"""Per-thread native Codex App Server session lifecycle."""

from __future__ import annotations

import inspect
from collections.abc import Callable
from pathlib import Path
from typing import Any, Mapping

from scholarseed_codex.mcp import CodexMcpControl
from scholarseed_codex.model import CodexModelControl
from scholarseed_codex.permission import sandbox_policy
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
    CODEX_RUNTIME_ID,
    CODEX_SANDBOX_MODES,
    AppServerError,
    normalized_roots,
)
from scholarseed_codex.skill import CodexSkillControl
from scholarseed_runtime.contract.evidence import RuntimeProcessEvent, RuntimeRpcEvidence
from scholarseed_runtime.contract.history import HistoryEntry, ResumeTurnSnapshot
from scholarseed_runtime.contract.input import TurnInput

CODEX_MODEL_PROVIDER_CAPABILITIES_METHOD = "modelProvider/capabilities/read"


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
        self._pooled_host = host is None
        self._opened = False
        self.mcp_control: CodexMcpControl | None = None
        self.skill_control: CodexSkillControl | None = None
        self.model_control: CodexModelControl | None = None
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
            if retry:
                await self._lease.retry_close(expected_generation=expected_generation)
            else:
                await self._lease.close(safe=True, expected_generation=expected_generation)
            self._lease = None
        self._host = None
        self.mcp_control = None
        self.skill_control = None
        self.model_control = None

    async def open(self) -> None:
        if self._opened:
            return
        if self._host is None:
            self._lease = await self._host_pool.acquire(self.request)
            self._host = self._lease.host
        try:
            self.session_id, self.model, self._history = await self.host.open_thread(
                self.request,
                self._on_event,
            )
            self.mcp_control = CodexMcpControl(
                request=self._thread_request,
                session_id=lambda: self.session_id,
            )
            self._mcp_unsubscribe = self.mcp_control.subscribe(self._on_mcp_event)
            self.host.set_mcp_handler(self.session_id, self.mcp_control.handle_notification)
            self.skill_control = CodexSkillControl(
                request=self.host.request,
                cwd=self.request.cwd,
            )
            self.model_control = CodexModelControl(request=self.host.request)
            self._opened = True
        except BaseException:
            if self._lease is not None:
                await self._lease.close()
                self._lease = None
                self._host = None
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
        await self.host.ensure_attached(self.session_id)
        return await self.host.request(method, params)

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
        result = await self.host.attachment(self.session_id).turn.start(turn_input)
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

        会话还没开出 thread 时静默无操作: 真正的初始值由
        `CodexSessionOpenRequest.writable_roots` 带进去, 不在这里补。
        """

        if not self.session_id:
            return
        await self.host.set_writable_roots(self.session_id, roots)

    async def aclose(self) -> None:
        if self._mcp_unsubscribe is not None:
            self._mcp_unsubscribe()
            self._mcp_unsubscribe = None
        host = self._host
        if host is None:
            return
        if self._opened:
            await host.close_thread(self.session_id)
        self._opened = False
        self.session_id = ""
        self.mcp_control = None
        self.skill_control = None
        self.model_control = None
        if self._lease is not None:
            await self._lease.close()
            self._lease = None
            self._host = None


__all__ = ["CodexThreadSession"]
