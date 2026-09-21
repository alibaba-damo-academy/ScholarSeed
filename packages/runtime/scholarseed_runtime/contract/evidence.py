from __future__ import annotations

from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from enum import Enum
from typing import Protocol


class RuntimeTimingPort(Protocol):
    """Request-scoped observation; implementations must preserve operation outcomes."""

    def measure(self, stage: str) -> AbstractContextManager[None]: ...


class NoopRuntimeTiming:
    def measure(self, stage: str) -> AbstractContextManager[None]:
        return nullcontext()


NOOP_RUNTIME_TIMING = NoopRuntimeTiming()


class RuntimeProcessEventKind(str, Enum):
    STARTING = "starting"
    STARTED = "started"
    EXITED = "exited"
    RECOVERY_PENDING = "recovery_pending"
    RECOVERED = "recovered"
    UNAVAILABLE = "unavailable"
    STOPPED = "stopped"


@dataclass(frozen=True)
class RuntimeProcessEvent:
    """Bounded process-lifecycle evidence independent of any vendor thread."""

    runtime_id: str
    kind: RuntimeProcessEventKind
    process_generation: int
    process_state: str
    evidence_seq: int
    created_at: str
    pid: int | None = None
    executable: str = ""
    version: str = ""
    incident_id: str = ""
    process_exit_code: int | None = None
    recovery_attempt: int = 0


@dataclass(frozen=True)
class RuntimeRpcEvidence:
    """Redacted successful-RPC latency evidence for one process generation."""

    runtime_id: str
    method: str
    process_generation: int
    latency_ms: int
    evidence_seq: int
    created_at: str
