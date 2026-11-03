"""Authorized pre-thread controls borrowing the execution host."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from scholarseed_codex.command import _finish
from scholarseed_codex.mcp import CodexMcpControl
from scholarseed_codex.model import CodexModelControl
from scholarseed_codex.pool import CodexHostPool, HostLease
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.mcp import McpSnapshot
from scholarseed_codex.protocol.state import AppServerError
from scholarseed_codex.skill import CodexSkillControl
from scholarseed_runtime.contract.resource import RESOURCE_HOST_BUSY
from scholarseed_runtime.contract.session import RUNTIME_SUSPEND_STALE


class CodexRuntimeControl:
    """Never create a host or infer an inventory caller's authority."""

    def __init__(self, *, cwd: Path, lease: HostLease, host_pool: CodexHostPool) -> None:
        self.cwd = cwd.expanduser().resolve()
        self._lease = lease
        self._host_pool = host_pool
        self._generation = lease.host.readiness.process_generation
        self._opened = False
        self._mutation_epoch: int | None = None
        self._readers = 0
        self.skill_control = CodexSkillControl(request=self.request, cwd=self.cwd)
        self.model_control = CodexModelControl(request=self.request)

    @property
    def host(self) -> CodexProcessHost:
        return self._lease.host

    @property
    def identity(self) -> str:
        self._check()
        return f"{self._lease.host_id}:{self._generation}"

    @property
    def process_generation(self) -> int:
        self._check()
        return self._generation

    def _check(self) -> None:
        if (
            not self._opened
            or not self.host.readiness.ready
            or self.host.readiness.process_generation != self._generation
        ):
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        if self._mutation_epoch is not None and (
            self.host.admission.epoch != self._mutation_epoch
            or not self.host.admission.frozen(self.host.admission.desired_revision)
        ):
            raise AppServerError(RESOURCE_HOST_BUSY, safe_error=RESOURCE_HOST_BUSY)

    @asynccontextmanager
    async def reading(self) -> AsyncIterator[None]:
        async with self.host.admission.enter():
            self._check()
            self._readers += 1
            try:
                yield
            finally:
                self._readers -= 1

    @asynccontextmanager
    async def mutation(self) -> AsyncIterator[None]:
        async with self._host_pool.control_mutation(self._lease):
            self._check()
            self._mutation_epoch = self.host.admission.epoch
            try:
                yield
            finally:
                self._mutation_epoch = None

    async def _connected(self, method: str, params: Any) -> dict[str, Any]:
        self._check()

        async def send() -> dict[str, Any]:
            self._check()
            return await self.host.request(method, params, generation=self._generation)

        pending = asyncio.create_task(send())
        try:
            result = await asyncio.shield(pending)
        except asyncio.CancelledError:
            await _finish(pending)
            raise
        self._check()
        return result

    async def request(
        self, method: str, params: Any, *, generation: int | None = None
    ) -> dict[str, Any]:
        if generation is not None and (
            isinstance(generation, bool)
            or not isinstance(generation, int)
            or generation != self._generation
        ):
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        if self._mutation_epoch is not None or self._readers:
            return await self._connected(method, params)
        async with self.reading():
            return await self._connected(method, params)

    async def mcp_inventory(self, *, thread_id: str = "") -> McpSnapshot:
        async with self.reading():
            control = CodexMcpControl(request=self.request, session_id=lambda: thread_id)
            return await control.snapshot()

    async def open(self) -> None:
        self._opened = True
        self._check()

    async def aclose(self) -> None:
        self._opened = False
