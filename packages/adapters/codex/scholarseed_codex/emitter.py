"""Single event sequence and observer delivery for one Codex connection owner."""

import inspect
import logging
from typing import Mapping, Protocol

from scholarseed_codex.protocol.mcp import JsonValue
from scholarseed_codex.protocol.session import (
    CodexSessionEvent,
    CodexSessionEventKind,
    CodexSessionEventObserver,
)
from scholarseed_codex.protocol.state import CODEX_RUNTIME_ID
from scholarseed_runtime.contract.incident import RuntimeIncident

logger = logging.getLogger(__name__)


class EventTarget(Protocol):
    @property
    def thread_id(self) -> str: ...

    @property
    def listener(self) -> CodexSessionEventObserver | None: ...


class CodexEmitter:
    def __init__(self) -> None:
        self._vendor_seq = 0

    async def emit(
        self,
        state: EventTarget,
        kind: CodexSessionEventKind,
        *,
        turn_id: str = "",
        item_id: str = "",
        payload: Mapping[str, JsonValue] | None = None,
        incident: RuntimeIncident | None = None,
    ) -> None:
        self._vendor_seq += 1
        event = CodexSessionEvent(
            runtime_id=CODEX_RUNTIME_ID,
            session_id=state.thread_id,
            kind=kind,
            turn_id=turn_id,
            item_id=item_id,
            vendor_seq=self._vendor_seq,
            payload=dict(payload or {}),
            incident=incident,
        )
        if state.listener is None:
            return
        try:
            result = state.listener(event)
            if inspect.isawaitable(result):
                await result
        except Exception:
            logger.exception("surface session event observer failed")

    async def incident(
        self,
        state: EventTarget,
        incident: RuntimeIncident,
        *,
        turn_id: str = "",
        item_id: str = "",
    ) -> None:
        await self.emit(
            state,
            CodexSessionEventKind.RUNTIME_INCIDENT,
            turn_id=turn_id,
            item_id=item_id,
            payload={
                "incident_id": incident.incident_id,
                "scope": incident.scope.value,
                "state": incident.state.value,
                "kind": incident.kind.value,
                "strategy": incident.strategy.value,
                "retryability": incident.retryability.value,
                "safe_error": incident.safe_error,
                "process_generation": incident.process_generation,
                "attempt": incident.attempt,
                "max_attempts": incident.max_attempts,
                "rpc_latency_ms": incident.rpc_latency_ms,
                "process_exit_code": incident.process_exit_code,
                "ambiguous_commit": incident.ambiguous_commit,
                "provider_error_code": incident.provider_error_code,
                "provider_http_status": incident.provider_http_status,
            },
            incident=incident,
        )
