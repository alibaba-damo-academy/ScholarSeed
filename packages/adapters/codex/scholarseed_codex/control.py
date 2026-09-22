"""Codex pre-thread controls for model and skill inventories."""

from __future__ import annotations

from pathlib import Path

from scholarseed_codex.model import CodexModelControl
from scholarseed_codex.pool import CodexHostPool, HostLease
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.control import CodexControlRequest
from scholarseed_codex.protocol.session import CodexRuntimeReadiness
from scholarseed_codex.protocol.state import CODEX_RUNTIME_ID, AppServerError
from scholarseed_codex.skill import CodexSkillControl
from scholarseed_runtime.contract.evidence import RuntimeProcessEvent, RuntimeRpcEvidence


class CodexRuntimeControl:
    """Expose Codex inventories without creating a vendor thread."""

    runtime_id = CODEX_RUNTIME_ID

    def __init__(
        self,
        request: CodexControlRequest,
        *,
        host: CodexProcessHost | None = None,
        host_pool: CodexHostPool | None = None,
        lease: HostLease | None = None,
    ) -> None:
        self.request = request
        self._lease = lease
        self._host = lease.host if lease is not None else host
        self._host_pool = host_pool or CodexHostPool()
        self._owns_pool = host_pool is None and host is None and lease is None
        self._pooled_host = host is None
        self._opened = False
        self._skill_control: CodexSkillControl | None = None
        self._model_control: CodexModelControl | None = None

    @property
    def cwd(self) -> Path:
        return self.request.cwd.expanduser().resolve()

    @property
    def host(self) -> CodexProcessHost:
        if self._host is None:
            raise AppServerError("Codex runtime control has not been opened")
        return self._host

    @property
    def readiness(self) -> CodexRuntimeReadiness:
        return self.host.readiness

    @property
    def process_events(self) -> tuple[RuntimeProcessEvent, ...]:
        return self.host.process_events

    @property
    def rpc_evidence(self) -> tuple[RuntimeRpcEvidence, ...]:
        return self.host.rpc_evidence

    @property
    def skill_control(self) -> CodexSkillControl:
        if self._skill_control is None:
            raise AppServerError("Codex skill control is not ready")
        return self._skill_control

    @property
    def model_control(self) -> CodexModelControl:
        if self._model_control is None:
            raise AppServerError("Codex model control is not ready")
        return self._model_control

    async def open(self) -> None:
        if self._opened:
            return
        if self._host is None:
            self._lease = await self._host_pool.acquire_control(self.request)
            self._host = self._lease.host
        else:
            await self._host.start()
        try:
            await self.host.ensure_skill_roots(self.request.skill_roots)
            self._skill_control = CodexSkillControl(request=self.host.request, cwd=self.cwd)
            self._model_control = CodexModelControl(request=self.host.request)
            self._opened = True
        except BaseException:
            if self._lease is not None:
                await self._lease.close(safe=self._owns_pool)
                self._lease = None
                self._host = None
            if self._owns_pool:
                await self._host_pool.aclose()
            raise

    async def aclose(self) -> None:
        self._opened = False
        self._skill_control = None
        self._model_control = None
        if self._lease is not None:
            await self._lease.close(safe=self._owns_pool)
            self._lease = None
            self._host = None
        if self._owns_pool:
            await self._host_pool.aclose()
