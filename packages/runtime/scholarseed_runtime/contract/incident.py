from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class RuntimeIncidentScope(str, Enum):
    PROVIDER = "provider"
    TURN = "turn"
    THREAD = "thread"
    PROCESS = "process"
    PROTOCOL = "protocol"
    CAPABILITY = "capability"


class RuntimeIncidentState(str, Enum):
    DETECTED = "detected"
    RETRYING = "retrying"
    RECOVERED = "recovered"
    FAILED = "failed"


class RuntimeIncidentKind(str, Enum):
    PROVIDER_RETRY = "provider_retry"
    RPC_REJECTED = "rpc_rejected"
    RPC_TIMEOUT = "rpc_timeout"
    TRANSPORT_LOST = "transport_lost"
    PROCESS_EXIT = "process_exit"
    RESUME_FAILED = "resume_failed"
    PROTOCOL_INCOMPATIBLE = "protocol_incompatible"
    UNSUPPORTED_NOTIFICATION = "unsupported_notification"
    AUTHENTICATION_REQUIRED = "authentication_required"
    TERMINAL_CONFLICT = "terminal_conflict"


class RuntimeRecoveryStrategy(str, Enum):
    VENDOR_RETRY = "vendor_retry"
    AUTO_RESTART = "auto_restart"
    AUTO_RESUME = "auto_resume"
    MANUAL_RETRY = "manual_retry"
    NONE = "none"


class RuntimeRetryability(str, Enum):
    IN_PROGRESS = "in_progress"
    USER_RETRYABLE = "user_retryable"
    TERMINAL = "terminal"
    UNKNOWN_OUTCOME = "unknown_outcome"


@dataclass(frozen=True)
class RuntimeIncident:
    """Redacted, stable failure semantics shared by runtime and product layers."""

    incident_id: str
    scope: RuntimeIncidentScope
    state: RuntimeIncidentState
    kind: RuntimeIncidentKind
    strategy: RuntimeRecoveryStrategy
    retryability: RuntimeRetryability
    safe_error: str
    process_generation: int = 0
    attempt: int = 0
    max_attempts: int = 0
    vendor_thread_id: str = ""
    vendor_turn_id: str = ""
    rpc_method: str = ""
    rpc_code: int | None = None
    rpc_latency_ms: int = 0
    process_exit_code: int | None = None
    ambiguous_commit: bool = False
    provider_error_code: str = ""
    provider_http_status: int | None = None
