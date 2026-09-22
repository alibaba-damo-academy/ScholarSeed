"""Redacted product projection into the independent Evidence Contract."""

from __future__ import annotations

import logging
import sqlite3
import subprocess
import threading
from contextlib import nullcontext
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from time import perf_counter
from typing import Any, Mapping

from damoatrace.paths import TRACE_DIR
from damoatrace.recording.content import CONTENT_VERSION
from damoatrace.recording.storage import purge_content
from damoatrace.recording.writer import EvidenceWriter
from scholarseed_runtime.contract.event import RuntimeEvent, RuntimeEventKind
from scholarseed_runtime.contract.evidence import (
    RuntimeProcessEvent,
    RuntimeProcessEventKind,
    RuntimeRpcEvidence,
)
from scholarseed_runtime.contract.incident import RuntimeIncidentKind, RuntimeIncidentState
from scholarseed_runtime.contract.input import TurnInput
from scholarseed_runtime.contract.resource import ResourceReceipt
from service.brand import PRODUCT_SLUG
from service.chat.constants import (
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_RUNTIME_INCIDENT,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
)
from service.chat.persistence.events import ProductEventRecord
from service.chat.runtime.capture import SessionCapture
from service.chat.runtime.incidents import event_incident
from service.chat.runtime.timing import (
    MILLISECONDS_PER_SECOND,
    ActivationMeasurement,
    ActivationTiming,
)
from service.chat.runtime.utils import integer, optional_integer, text
from service.chat.service.recording import RecordingService
from service.chat.service.streams import DIAGNOSTIC_EVENT

#: 产品自有 trace 事件与文件名的命名空间 (品牌单一来源在 service.brand)。
PRODUCT_TRACE_NAMESPACE = PRODUCT_SLUG

# Trace 事件命名分两类, 均不写死具体 runtime:
#
# 1. runtime 特定事件 —— 进程/线程/turn/vendor 事件的语义随 runtime 而异, 名字由
#    当前 session binding 的 runtime id 驱动 (codex 下是 ``codex.turn.started``,
#    dsh 下自然是 ``dsh.turn.started``)。新增 runtime 无需改本文件。
# 2. 产品自有事件 —— ``scholarseed.*`` / ``session.*`` / ``runtime.*`` 由产品层定义,
#    跨 runtime 语义一致, 保持中性字面量。
#
# 文件名与 task 前缀同理按 runtime 分档, 便于 DamoATrace 侧按 runtime 归集证据。
TRACE_RUNTIME_BOUND = "session.runtime.bound"
TRACE_RUNTIME_RELOCATED = "session.runtime.relocated"
TRACE_TURN_INPUT = f"{PRODUCT_TRACE_NAMESPACE}.turn.input"
TRACE_RUNTIME_INCIDENT_PREFIX = "runtime.incident"
TRACE_RUNTIME_PROCESS_PREFIX = "runtime.process"
TRACE_RUNTIME_RPC_SUCCESS = "runtime.rpc.success"
TRACE_PRODUCT_EVENT_PREFIX = f"{PRODUCT_TRACE_NAMESPACE}.product"
TRACE_INVOCATION_STARTED = f"{PRODUCT_TRACE_NAMESPACE}.invocation.started"
TRACE_INVOCATION_COMPLETED = f"{PRODUCT_TRACE_NAMESPACE}.invocation.completed"
TRACE_INVOCATION_FAILED = f"{PRODUCT_TRACE_NAMESPACE}.invocation.failed"
TRACE_TURN_EXECUTION_FAILED = f"{PRODUCT_TRACE_NAMESPACE}.turn.execution_failed"
TRACE_RESOURCE_LIFECYCLE = "runtime.resource.lifecycle"
TRACE_RESOURCE_CHECKPOINT = "runtime.resource.checkpoint"
TRACE_CHECKPOINT_FAILED = "runtime_trace_checkpoint_failed"
TRACE_CONTENT_INCOMPLETE = f"{PRODUCT_TRACE_NAMESPACE}.content.incomplete"
TRACE_MODEL_REQUEST_PREPARATION = "runtime.turn.model_request_preparation"
MODEL_REQUEST_PREPARATION_STAGE = "turn.started_to_model_bridge_ingress"
RUNTIME_EVIDENCE_LIMIT = 200
TRACE_STATUS_OK = "ok"
TRACE_STATUS_ERROR = "error"
TRACE_STATUS_CANCELLED = "cancelled"
TRACE_RUNTIME_FAILURE_MESSAGE = "agent_runtime_failed"
LOGGER = logging.getLogger(__name__)
TRACE_DEGRADED_EVENT = "trace.recording.degraded"
TRACE_RECOVERED_EVENT = "trace.recording.recovered"
TRACE_FAILURES = (OSError, ValueError, TypeError, sqlite3.Error, subprocess.SubprocessError)
TRACE_TOOL_FAILURE = "tool_execution_failed"
TRACE_TOOL_FAILED_STATUSES = frozenset({"failed", "error", "declined", "cancelled"})
TRACE_PRODUCT_OUTCOMES = {
    PRODUCT_EVENT_TURN_COMPLETED: TRACE_STATUS_OK,
    PRODUCT_EVENT_TURN_FAILED: TRACE_STATUS_ERROR,
    PRODUCT_EVENT_TURN_INTERRUPTED: TRACE_STATUS_CANCELLED,
    PRODUCT_EVENT_TURN_UNKNOWN: "unknown",
}


def decode_evidence(
    event: RuntimeEvent,
) -> tuple[tuple[RuntimeProcessEvent, ...], tuple[RuntimeRpcEvidence, ...]]:
    """Admit only public evidence fields; arbitrary native payload is never recorded."""
    payload = event.payload if isinstance(event.payload, Mapping) else {}

    def records(key: str) -> list[Mapping[str, Any]]:
        raw_rows = payload.get(key, [])
        if not isinstance(raw_rows, list):
            raise ValueError("runtime evidence collection must be an array")
        rows: list[Mapping[str, Any]] = []
        for raw in raw_rows:
            if not isinstance(raw, Mapping):
                raise ValueError("runtime evidence record must be an object")
            if raw.get("runtime_id") != event.runtime_id:
                raise ValueError("runtime evidence provider mismatch")
            rows.append(raw)
        return rows

    process = tuple(
        RuntimeProcessEvent(
            runtime_id=text(raw["runtime_id"]),
            kind=RuntimeProcessEventKind(raw["kind"]),
            process_generation=integer(raw["process_generation"]),
            process_state=text(raw["process_state"]),
            evidence_seq=integer(raw["evidence_seq"]),
            created_at=text(raw["created_at"]),
            pid=optional_integer(raw.get("pid")),
            executable=text(raw.get("executable", "")),
            version=text(raw.get("version", "")),
            incident_id=text(raw.get("incident_id", "")),
            process_exit_code=optional_integer(raw.get("process_exit_code")),
            recovery_attempt=integer(raw.get("recovery_attempt", 0)),
        )
        for raw in records("process")
    )
    rpc = tuple(
        RuntimeRpcEvidence(
            runtime_id=text(raw["runtime_id"]),
            method=text(raw["method"]),
            process_generation=integer(raw["process_generation"]),
            latency_ms=integer(raw["latency_ms"]),
            evidence_seq=integer(raw["evidence_seq"]),
            created_at=text(raw["created_at"]),
        )
        for raw in records("rpc")
    )
    return process, rpc


def session_trace_paths(session_id: str, trace_dir: Path = TRACE_DIR) -> tuple[Path, ...]:
    """Find traces for one safe product session without assuming a runtime vendor."""

    if not session_id or Path(session_id).name != session_id:
        return ()
    suffix = f"-{session_id}.jsonl"
    try:
        candidates = tuple(trace_dir.glob(f"{PRODUCT_TRACE_NAMESPACE}-*{suffix}"))
    except OSError:
        return ()
    return tuple(path for path in candidates if path.is_file() and path.name.endswith(suffix))


class TraceKind(str, Enum):
    """Evidence Contract kind values owned by the product-side projection."""

    TASK_START = "task.start"
    TURN_START = "turn.start"
    TURN_END = "turn.end"
    RUN_OUTCOME = "run.outcome"
    LLM_STREAM = "llm.stream"
    TOOL_EXEC = "tool.exec"
    HIL_REQUEST = "hil.request"
    HIL_RESPONSE = "hil.response"
    MODE_TRANSITION = "mode.transition"
    CHANNEL_RECEIVE = "channel.receive"
    CHANNEL_SEND = "channel.send"
    ACTIVATION = "runtime.activation"


_TERMINAL_SUFFIXES = {
    RuntimeEventKind.TURN_COMPLETED: "turn.completed",
    RuntimeEventKind.TURN_FAILED: "turn.failed",
    RuntimeEventKind.TURN_INTERRUPTED: "turn.interrupted",
    RuntimeEventKind.TURN_UNKNOWN: "turn.ambiguous",
}
_TERMINAL_STATUSES = {
    RuntimeEventKind.TURN_COMPLETED: TRACE_STATUS_OK,
    RuntimeEventKind.TURN_FAILED: TRACE_STATUS_ERROR,
    RuntimeEventKind.TURN_INTERRUPTED: TRACE_STATUS_CANCELLED,
    RuntimeEventKind.TURN_UNKNOWN: TRACE_STATUS_ERROR,
}
_NON_ERROR_INCIDENT_KINDS = frozenset({RuntimeIncidentKind.UNSUPPORTED_NOTIFICATION})
_NON_ERROR_INCIDENT_VALUES = frozenset(kind.value for kind in _NON_ERROR_INCIDENT_KINDS)
_TOOL_KINDS = frozenset(
    {
        RuntimeEventKind.TOOL_STARTED,
        RuntimeEventKind.TOOL_PROGRESS,
        RuntimeEventKind.TOOL_COMPLETED,
        RuntimeEventKind.ARTIFACT_OBSERVED,
    }
)
_HIL_KINDS = frozenset(
    {
        RuntimeEventKind.INTERACTION_RESOLVED,
    }
)
_TOOL_EXTENSIONS = frozenset(
    {
        "web_search_started",
        "web_search_completed",
        "paper_search_started",
        "paper_search_completed",
        "skill_started",
        "skill_completed",
    }
)
_TOOL_COMPLETION_EXTENSIONS = frozenset(
    {"web_search_completed", "paper_search_completed", "skill_completed"}
)
_EXTENSION_KIND_KEY = "extension_kind"
_RPC_METHOD_KEY = "rpc_method"
_COMPLETION_PHASE_STARTED = "started"
_SAFE_EXTENSION_ATTRIBUTE_KEYS = (_EXTENSION_KIND_KEY, _RPC_METHOD_KEY)


@dataclass(frozen=True)
class TurnPreparationStart:
    vendor_turn_id: str
    started_at: datetime
    started: float


class SessionTrace:
    """Append metadata and, only with session consent, bounded public observations."""

    def __init__(
        self,
        session_id: str,
        workdir: Path,
        *,
        runtime_id: str,
        trace_dir: Path = TRACE_DIR,
        recording: RecordingService | None = None,
        secrets: tuple[str, ...] = (),
    ) -> None:
        if not session_id or Path(session_id).name != session_id:
            raise ValueError("trace session id must be one safe path component")
        if not runtime_id.strip():
            raise ValueError("trace runtime id must not be empty")
        self.session_id = session_id
        self.runtime_id = runtime_id.strip().lower()
        self.workdir = workdir.expanduser().resolve()
        self.task_run_id = f"{PRODUCT_TRACE_NAMESPACE}-{self.runtime_id}:{session_id}"
        self.path = trace_dir / f"{PRODUCT_TRACE_NAMESPACE}-{self.runtime_id}-{session_id}.jsonl"
        self._writer: EvidenceWriter | None = None
        self._degraded = False
        self._failure_count = 0
        self._lock = threading.Lock()
        self._timing_lock = threading.Lock()
        self._turn_preparations: dict[str, TurnPreparationStart] = {}
        self._capture = (
            SessionCapture(session_id, self.path, recording, secrets=secrets) if recording else None
        )
        self._recording = recording

    def add_secrets(self, secrets: tuple[str, ...]) -> None:
        if self._capture is not None:
            self._capture.redactor.secrets = tuple(
                dict.fromkeys((*self._capture.redactor.secrets, *secrets))
            )

    def resource(
        self, action: str, receipt: ResourceReceipt | None = None, **attributes: Any
    ) -> None:
        self._emit(
            kind=TraceKind.MODE_TRANSITION,
            name=TRACE_RESOURCE_LIFECYCLE,
            attributes={
                "runtime_id": self.runtime_id,
                "action": action,
                **(asdict(receipt) if receipt is not None else {}),
                **attributes,
            },
        )

    def activation(self, request_id: str) -> ActivationTiming:
        return ActivationTiming(request_id, self._activation_measurement)

    def _activation_measurement(self, sample: ActivationMeasurement) -> None:
        self._emit(
            kind=TraceKind.ACTIVATION,
            name=sample.stage,
            attributes={
                "runtime_id": self.runtime_id,
                "stage": sample.stage,
                "activation_id": sample.activation_id,
                "request_id": sample.request_id,
                "status": sample.status.value,
                "failure_type": sample.failure_type,
                "evidence_completeness": "complete",
                "evidence_gaps": [],
            },
            status=sample.status.value,
            span_id=sample.span_id,
            parent_span_id=sample.parent_span_id,
            started_at=sample.started_at,
            duration_ms=sample.duration_ms,
        )

    def completion(self, fields: Mapping[str, Any]) -> None:
        if fields.get("phase") == _COMPLETION_PHASE_STARTED:
            client_turn_id = str(fields.get("client_user_message_id") or "").strip()
            with self._timing_lock:
                preparation = self._turn_preparations.pop(client_turn_id, None)
            if preparation is not None:
                self._emit(
                    kind=TraceKind.MODE_TRANSITION,
                    name=TRACE_MODEL_REQUEST_PREPARATION,
                    attributes={
                        "runtime_id": self.runtime_id,
                        "stage": MODEL_REQUEST_PREPARATION_STAGE,
                        "client_user_message_id": client_turn_id,
                        "vendor_turn_id": preparation.vendor_turn_id,
                        "model_request_id": str(fields.get("request_id") or ""),
                        "evidence_completeness": "complete",
                        "evidence_gaps": [],
                    },
                    started_at=preparation.started_at,
                    duration_ms=(perf_counter() - preparation.started) * MILLISECONDS_PER_SECOND,
                )
        self._emit(
            kind=TraceKind.LLM_STREAM,
            name=DIAGNOSTIC_EVENT,
            attributes=dict(fields),
        )

    def checkpoint(self, generation: int, watermark: int) -> None:
        if self._failure_count:
            raise RuntimeError(TRACE_CHECKPOINT_FAILED)
        self._emit(
            kind=TraceKind.MODE_TRANSITION,
            name=TRACE_RESOURCE_CHECKPOINT,
            attributes={"attachment_generation": generation, "watermark": watermark},
        )
        if self._failure_count or self._writer is None:
            raise RuntimeError(TRACE_CHECKPOINT_FAILED)
        try:
            self._writer.checkpoint()
        except TRACE_FAILURES as failure:
            self._capture_failure(failure)
            raise RuntimeError(TRACE_CHECKPOINT_FAILED) from failure

    def _runtime_name(self, suffix: str) -> str:
        return f"{self.runtime_id}.{suffix}"

    def relocate(self, workdir: Path) -> None:
        """Use the rebound runtime root for all subsequent trace evidence."""

        with self._lock:
            self.workdir = workdir.expanduser().resolve()

    def runtime_relocated(
        self,
        *,
        previous_workdir: Path,
        target_workdir: Path,
        status: str,
        stage: str,
        failure_type: str = "",
        failure_detail: str = "",
    ) -> None:
        """Record the observable state transition without serializing exception text."""

        self._emit(
            kind=TraceKind.MODE_TRANSITION,
            name=TRACE_RUNTIME_RELOCATED,
            attributes={
                "runtime_id": self.runtime_id,
                "previous_workdir": str(previous_workdir),
                "target_workdir": str(target_workdir),
                "status": status,
                "stage": stage,
                "failure_type": failure_type,
                "failure_detail": failure_detail,
            },
        )

    def _emit(
        self,
        *,
        kind: TraceKind,
        name: str,
        attributes: dict[str, Any],
        status: str = TRACE_STATUS_OK,
        error: dict[str, str] | None = None,
        inputs: dict[str, Any] | None = None,
        outputs: dict[str, Any] | None = None,
        span_id: str | None = None,
        parent_span_id: str | None = None,
        started_at: datetime | None = None,
        duration_ms: float = 0,
    ) -> None:
        with self._recording.guard if self._recording else nullcontext(), self._lock:
            try:
                if self._capture and not self._capture.allowed():
                    inputs, outputs = None, None
                if self._writer is None:
                    self._writer = EvidenceWriter(
                        self.path,
                        budget=(
                            self._recording.budget(self.path.parent) if self._recording else None
                        ),
                    )
                turn_id = attributes.get("vendor_turn_id")
                self._writer.emit(
                    session_id=self.session_id,
                    kind=kind.value,
                    name=name,
                    task_run_id=f"{self.task_run_id}:{turn_id}" if turn_id else self.task_run_id,
                    component_id=f"surface:{self.runtime_id}-appserver",
                    attributes={
                        "session_id": self.session_id,
                        "evidence_completeness": "partial",
                        "evidence_gaps": ["model_context", "span_hierarchy", "execution_duration"],
                        **attributes,
                    },
                    status=status,
                    error=error,
                    inputs=inputs,
                    outputs=outputs,
                    span_id=span_id,
                    parent_span_id=parent_span_id,
                    started_at=started_at,
                    duration_ms=duration_ms,
                )
            except TRACE_FAILURES as failure:
                self._failure_count += 1
                if not self._degraded:
                    LOGGER.error(
                        "Trace recording degraded: session=%s failure=%s",
                        self.session_id,
                        type(failure).__name__,
                        extra={"event": TRACE_DEGRADED_EVENT, "session_id": self.session_id},
                    )
                self._degraded = True
                if self._writer is not None:
                    try:
                        self._writer.close()
                    except OSError:
                        pass  # The original write failure is already recorded above.
                    self._writer = None
                return
            if self._degraded:
                LOGGER.warning(
                    "Trace recording recovered; earlier events may be missing: session=%s",
                    self.session_id,
                    extra={"event": TRACE_RECOVERED_EVENT, "session_id": self.session_id},
                )
                self._degraded = False

    def invocation_started(
        self,
        *,
        purpose: str,
        requested_model_key: str,
        permission_mode: str,
        network_access: bool,
        instruction_chars: int,
        input_chars: int,
        skill_identity: Mapping[str, str] | None,
    ) -> None:
        """Start one non-Session model action without recording its input."""

        skill = {
            key: str(skill_identity[key])
            for key in ("id", "name", "version", "fingerprint", "profile")
            if skill_identity and skill_identity.get(key)
        }
        self._emit(
            kind=TraceKind.TURN_START,
            name=TRACE_INVOCATION_STARTED,
            attributes={
                "runtime_id": self.runtime_id,
                "invocation_id": self.session_id,
                "purpose": purpose,
                "requested_model_key": requested_model_key,
                "permission_mode": permission_mode,
                "network_access": network_access,
                "instruction_chars": instruction_chars,
                "input_chars": input_chars,
                "skill": skill or None,
            },
        )

    def invocation_completed(
        self,
        *,
        purpose: str,
        model_key: str,
        vendor_thread_id: str,
        vendor_turn_id: str,
        status: str,
        input_tokens: int,
        output_tokens: int,
    ) -> None:
        """Record one bounded model result so DamoATrace can query usage by invocation."""

        succeeded = status == "completed"
        self._emit(
            kind=TraceKind.LLM_STREAM,
            name=TRACE_INVOCATION_COMPLETED if succeeded else TRACE_INVOCATION_FAILED,
            attributes={
                "runtime_id": self.runtime_id,
                "invocation_id": self.session_id,
                "purpose": purpose,
                "model": model_key,
                "vendor_thread_id": vendor_thread_id,
                "vendor_turn_id": vendor_turn_id,
                "invocation_status": status,
                "usage": {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                },
            },
            status="ok" if succeeded else "error",
            error=(
                None
                if succeeded
                else {"class": "SurfaceTurnFailure", "message": "agent_turn_failed"}
            ),
        )

    def invocation_failed(
        self,
        *,
        purpose: str,
        requested_model_key: str,
        failure_type: str,
    ) -> None:
        """Record a safe pre-result failure without serializing exception detail."""

        self._emit(
            kind=TraceKind.TURN_END,
            name=TRACE_INVOCATION_FAILED,
            attributes={
                "runtime_id": self.runtime_id,
                "invocation_id": self.session_id,
                "purpose": purpose,
                "requested_model_key": requested_model_key,
                "failure_type": failure_type,
            },
            status="error",
            error={"class": failure_type, "message": "agent_runtime_failed"},
        )

    @staticmethod
    def _vendor_attributes(event: RuntimeEvent) -> dict[str, Any]:
        return {
            "runtime_id": event.runtime_id,
            "vendor_thread_id": event.native_session_id,
            "vendor_turn_id": event.native_turn_id,
            "vendor_item_id": event.native_item_id,
            "vendor_seq": event.sequence,
            "vendor_event_kind": event.kind.value,
            "event_id": event.event_id,
            "process_generation": event.process_generation,
            "call_id": event.call_id,
            "correlation_id": event.correlation_id,
            "causation_id": event.causation_id,
            "actor_kind": event.actor_kind.value,
            "actor_id": event.actor_id,
            "parent_actor_id": event.parent_actor_id,
            "source_created_at": event.observed_at,
        }

    def runtime_process_event(self, event: RuntimeProcessEvent) -> None:
        """Record one generic supervisor lifecycle row without vendor-private access."""

        self._emit(
            kind=TraceKind.MODE_TRANSITION,
            name=f"{TRACE_RUNTIME_PROCESS_PREFIX}.{event.kind.value}",
            attributes={
                "session_id": self.session_id,
                "runtime_id": event.runtime_id,
                "evidence_seq": event.evidence_seq,
                "source_created_at": event.created_at,
                "process_generation": event.process_generation,
                "process_state": event.process_state,
                "pid": event.pid,
                "executable": Path(event.executable or self.runtime_id).name,
                "version": event.version,
                "incident_id": event.incident_id,
                "process_exit_code": event.process_exit_code,
                "recovery_attempt": event.recovery_attempt,
            },
        )

    def runtime_rpc_evidence(self, evidence: RuntimeRpcEvidence) -> None:
        """Record successful RPC latency from the typed bounded evidence ledger."""

        self._emit(
            kind=TraceKind.CHANNEL_RECEIVE,
            name=TRACE_RUNTIME_RPC_SUCCESS,
            attributes={
                "session_id": self.session_id,
                "runtime_id": evidence.runtime_id,
                "evidence_seq": evidence.evidence_seq,
                "source_created_at": evidence.created_at,
                "rpc_method": evidence.method,
                "process_generation": evidence.process_generation,
                "rpc_latency_ms": evidence.latency_ms,
            },
        )

    def runtime_event(self, event: RuntimeEvent) -> None:
        payload = event.payload if isinstance(event.payload, Mapping) else {}
        attributes = self._vendor_attributes(event)
        if event.kind is RuntimeEventKind.RUNTIME_EXTENSION:
            attributes.update(
                {
                    key: value
                    for key in _SAFE_EXTENSION_ATTRIBUTE_KEYS
                    if isinstance((value := payload.get(key)), str)
                }
            )
        inputs, outputs = None, None
        try:
            if self._capture:
                with self._capture.policies.guard:
                    inputs, outputs = self._capture.event(event)
        except TRACE_FAILURES as failure:
            self._capture_failure(failure)
        if self._capture:
            attributes["client_user_message_id"] = self._capture.submission
        incident = event_incident(event)
        if incident is not None:
            failed = (
                incident.state is RuntimeIncidentState.FAILED
                and incident.kind not in _NON_ERROR_INCIDENT_KINDS
            )
            self._emit(
                kind=TraceKind.MODE_TRANSITION,
                name=f"{TRACE_RUNTIME_INCIDENT_PREFIX}.{incident.state.value}",
                attributes={
                    **attributes,
                    "incident_id": incident.incident_id,
                    "incident_scope": incident.scope.value,
                    "incident_kind": incident.kind.value,
                    "incident_state": incident.state.value,
                    "recovery_strategy": incident.strategy.value,
                    "retryability": incident.retryability.value,
                    "safe_error": incident.safe_error,
                    "process_generation": incident.process_generation,
                    "attempt": incident.attempt,
                    "max_attempts": incident.max_attempts,
                    "rpc_method": incident.rpc_method,
                    "rpc_code": incident.rpc_code,
                    "rpc_latency_ms": incident.rpc_latency_ms,
                    "process_exit_code": incident.process_exit_code,
                    "ambiguous_commit": incident.ambiguous_commit,
                    "provider_error_code": incident.provider_error_code,
                    "provider_http_status": incident.provider_http_status,
                    **(
                        {
                            name: payload.get(name)
                            for name in (
                                "existing_outcome",
                                "incoming_outcome",
                                "existing_generation",
                                "incoming_generation",
                            )
                        }
                        if incident.kind == RuntimeIncidentKind.TERMINAL_CONFLICT
                        else {}
                    ),
                },
                status=TRACE_STATUS_ERROR if failed else TRACE_STATUS_OK,
                error=(
                    {"code": incident.kind.value, "message": incident.safe_error}
                    if failed
                    else None
                ),
            )
            if event.kind == RuntimeEventKind.RUNTIME_INCIDENT:
                return
        if event.kind in {RuntimeEventKind.SESSION_OPENED, RuntimeEventKind.SESSION_RESUMED}:
            process_reused = bool(payload.get("process_reused"))
            process_name = self._runtime_name(
                "process.attached" if process_reused else "process.started"
            )
            process_attributes = {
                **attributes,
                "pid": payload.get("pid"),
                "version": str(payload.get("version") or ""),
                "process_state": str(payload.get("process_state") or ""),
                "executable": Path(str(payload.get("executable") or self.runtime_id)).name,
                "workdir": str(self.workdir),
            }
            self._emit(
                kind=TraceKind.TASK_START,
                name=process_name,
                attributes=process_attributes,
            )
            self._emit(
                kind=TraceKind.CHANNEL_RECEIVE,
                name=(
                    self._runtime_name("thread.resumed")
                    if event.kind == RuntimeEventKind.SESSION_RESUMED
                    else self._runtime_name("thread.started")
                ),
                attributes=process_attributes,
            )
            self._emit(
                kind=TraceKind.MODE_TRANSITION,
                name=TRACE_RUNTIME_BOUND,
                attributes=process_attributes,
            )
            return
        if event.kind == RuntimeEventKind.TURN_STARTED:
            client_turn_id = str(
                attributes.get("client_user_message_id") or event.correlation_id or ""
            ).strip()
            if client_turn_id:
                with self._timing_lock:
                    self._turn_preparations[client_turn_id] = TurnPreparationStart(
                        vendor_turn_id=event.native_turn_id,
                        started_at=datetime.now(timezone.utc),
                        started=perf_counter(),
                    )
            self._emit(
                kind=TraceKind.TURN_START,
                name=self._runtime_name("turn.started"),
                attributes=attributes,
            )
            return
        terminal_suffix = _TERMINAL_SUFFIXES.get(event.kind)
        if terminal_suffix is not None:
            client_turn_id = str(
                attributes.get("client_user_message_id") or event.correlation_id or ""
            ).strip()
            if client_turn_id:
                with self._timing_lock:
                    self._turn_preparations.pop(client_turn_id, None)
            trace_status = _TERMINAL_STATUSES[event.kind]
            failure_code = str(payload.get("error_code") or event.kind.value)
            failure_message = str(payload.get("safe_error") or TRACE_RUNTIME_FAILURE_MESSAGE)
            self._emit(
                kind=TraceKind.TURN_END,
                name=self._runtime_name(terminal_suffix),
                inputs=inputs,
                outputs=outputs,
                attributes={
                    **attributes,
                    "status": str(payload.get("status") or event.kind.value),
                },
                status=trace_status,
                error=(
                    {"code": failure_code, "message": failure_message}
                    if trace_status == TRACE_STATUS_ERROR
                    else None
                ),
            )
            return
        extension = (
            payload.get(_EXTENSION_KIND_KEY)
            if event.kind is RuntimeEventKind.RUNTIME_EXTENSION
            else None
        )
        event_name = event.kind.value
        if isinstance(extension, str) and extension in _TOOL_EXTENSIONS:
            trace_kind = TraceKind.TOOL_EXEC
            event_name = extension
        elif event.kind in _TOOL_KINDS:
            trace_kind = TraceKind.TOOL_EXEC
        elif event.kind in _HIL_KINDS:
            trace_kind = TraceKind.HIL_RESPONSE
        elif event.kind in {
            RuntimeEventKind.CONTENT_DELTA,
            RuntimeEventKind.USAGE_UPDATED,
        }:
            trace_kind = TraceKind.LLM_STREAM
        else:
            trace_kind = TraceKind.CHANNEL_RECEIVE
        failed = False
        if trace_kind is TraceKind.TOOL_EXEC:
            attributes.update(
                {
                    "tool_name": str(payload.get("name") or payload.get("skill") or event_name),
                    "tool_status": str(payload.get("status") or ""),
                    "exit_code": optional_integer(payload.get("exit_code")),
                }
            )
            completed = (
                event.kind is RuntimeEventKind.TOOL_COMPLETED
                or extension in _TOOL_COMPLETION_EXTENSIONS
            )
            failed = payload.get("status") in TRACE_TOOL_FAILED_STATUSES or (
                completed and payload.get("ok") is False
            )
        if trace_kind is TraceKind.HIL_RESPONSE:
            attributes.update(
                {
                    "interaction_id": payload.get("request_id"),
                    "decision": payload.get("option_id"),
                    "cancelled": payload.get("cancelled"),
                }
            )
        self._emit(
            kind=trace_kind,
            name=self._runtime_name(f"event.{event_name}"),
            inputs=inputs,
            outputs=outputs,
            attributes=attributes,
            status=TRACE_STATUS_ERROR if failed else TRACE_STATUS_OK,
            error=(
                {"error_class": TRACE_TOOL_FAILURE, "message": TRACE_TOOL_FAILURE}
                if failed
                else None
            ),
        )

    def turn_input(
        self,
        turn_input: TurnInput,
        *,
        vendor_thread_id: str,
        skill_versions: Mapping[str, str],
        user_text: str = "",
        product_context: str = "",
        steer: bool = False,
        assistant_snapshot_id: str = "",
        assistant_context_revision: int | None = None,
    ) -> None:
        """Record typed input identities without prompts, paths, hashes, or file contents."""

        inputs = None
        try:
            if not steer:
                purge_content(self.path)
            if self._capture:
                with self._capture.policies.guard:
                    inputs = self._capture.input(
                        turn_input,
                        user_text=user_text,
                        context=product_context,
                        context_identity={
                            "snapshot_id": assistant_snapshot_id,
                            "revision": assistant_context_revision,
                            "skills": dict(skill_versions),
                        },
                        steer=steer,
                    )
        except TRACE_FAILURES as failure:
            self._capture_failure(failure)
        self._emit(
            kind=TraceKind.CHANNEL_SEND,
            name=TRACE_TURN_INPUT,
            inputs=inputs,
            attributes={
                "runtime_id": self.runtime_id,
                "vendor_thread_id": vendor_thread_id,
                "client_user_message_id": turn_input.client_user_message_id,
                "collaboration_mode": turn_input.collaboration_mode.value,
                "assistant_snapshot_id": assistant_snapshot_id,
                "assistant_context_revision": assistant_context_revision,
                "input_kinds": [item.kind.value for item in turn_input.items],
                "skills": [
                    {"name": name, "version": version}
                    for name, version in sorted(skill_versions.items())
                ],
            },
        )

    def _capture_failure(self, failure: Exception) -> None:
        self._failure_count += 1
        if self._capture:
            self._capture.invalidate()
        LOGGER.error(
            "Trace content degraded: session=%s failure=%s",
            self.session_id,
            type(failure).__name__,
            extra={"event": TRACE_DEGRADED_EVENT, "session_id": self.session_id},
        )

    def turn_execution_failed(
        self, *, failure_type: str, retryability: str, failure_code: str = ""
    ) -> None:
        """Record a redacted product execution-boundary failure for root-cause diagnosis."""

        self._finish_content()
        self._emit(
            kind=TraceKind.TURN_END,
            name=TRACE_TURN_EXECUTION_FAILED,
            attributes={
                "runtime_id": self.runtime_id,
                "failure_type": failure_type,
                "retryability": retryability,
                "failure_code": failure_code,
            },
            status="error",
            error={"class": failure_type, "message": "agent_runtime_failed"},
        )

    def product_event(self, record: ProductEventRecord) -> None:
        inputs = None
        try:
            if self._capture:
                with self._capture.policies.guard:
                    inputs = self._capture.product(record)
        except TRACE_FAILURES as failure:
            self._capture_failure(failure)
        diagnostics: dict[str, Any] = {}
        status = TRACE_STATUS_OK
        error: dict[str, str] | None = None
        trace_kind = TraceKind.CHANNEL_SEND
        if record.kind in TRACE_PRODUCT_OUTCOMES:
            trace_kind = TraceKind.RUN_OUTCOME
            status = TRACE_PRODUCT_OUTCOMES[record.kind]
            diagnostics["outcome"] = record.kind
            diagnostics["status"] = status
        elif record.kind in {PRODUCT_EVENT_HIL_REQUESTED, PRODUCT_EVENT_HIL_RESOLVED}:
            trace_kind = (
                TraceKind.HIL_REQUEST
                if record.kind == PRODUCT_EVENT_HIL_REQUESTED
                else TraceKind.HIL_RESPONSE
            )
            diagnostics = {
                "interaction_id": record.payload.get("request_id"),
                "interaction_kind": record.payload.get("kind"),
                "interaction_state": record.payload.get("state"),
            }
        if record.kind == PRODUCT_EVENT_RUNTIME_INCIDENT:
            diagnostics = {
                name: record.payload.get(name)
                for name in (
                    "incident_id",
                    "scope",
                    "state",
                    "kind",
                    "strategy",
                    "retryability",
                    "safe_error",
                    "process_generation",
                    "attempt",
                    "max_attempts",
                    "rpc_method",
                    "rpc_code",
                    "ambiguous_commit",
                )
                if record.payload.get(name) is not None
            }
            if (
                record.payload.get("state") == RuntimeIncidentState.FAILED.value
                and record.payload.get("kind") not in _NON_ERROR_INCIDENT_VALUES
            ):
                status = TRACE_STATUS_ERROR
                error = {
                    "code": str(record.payload.get("kind") or PRODUCT_EVENT_RUNTIME_INCIDENT),
                    "message": str(
                        record.payload.get("safe_error") or TRACE_RUNTIME_FAILURE_MESSAGE
                    ),
                }
        elif record.kind == PRODUCT_EVENT_TURN_FAILED:
            diagnostics.update(
                {
                    name: record.payload.get(name)
                    for name in ("code", "retryable", "outcome_unknown")
                    if record.payload.get(name) is not None
                }
            )
            status = TRACE_STATUS_ERROR
            error = {
                "code": str(record.payload.get("code") or PRODUCT_EVENT_TURN_FAILED),
                "message": TRACE_RUNTIME_FAILURE_MESSAGE,
            }
        self._emit(
            kind=trace_kind,
            name=f"{TRACE_PRODUCT_EVENT_PREFIX}.{record.kind}",
            inputs=inputs,
            attributes={
                "runtime_id": record.runtime_id,
                "vendor_thread_id": record.vendor_thread_id,
                "vendor_turn_id": record.vendor_turn_id or "",
                "vendor_item_id": record.vendor_item_id or "",
                "product_seq": record.product_seq,
                "product_event_kind": record.kind,
                **diagnostics,
            },
            status=status,
            error=error,
        )

    def mcp_control_started(
        self,
        *,
        request_id: str,
        vendor_thread_id: str,
        operation: str,
        server: str,
        target: str = "",
        explicitly_approved: bool = False,
    ) -> None:
        """Record one product control request without arguments, resource data, or credentials."""

        self._emit(
            kind=TraceKind.TOOL_EXEC,
            name=self._runtime_name("mcp.control.started"),
            attributes={
                "runtime_id": self.runtime_id,
                "vendor_thread_id": vendor_thread_id,
                "mcp_request_id": request_id,
                "mcp_operation": operation,
                "mcp_server": server,
                "mcp_target": target,
                "explicitly_approved": explicitly_approved,
            },
        )

    def mcp_control_completed(
        self,
        *,
        request_id: str,
        vendor_thread_id: str,
        operation: str,
        server: str,
        target: str = "",
        success: bool,
        failure_type: str = "",
    ) -> None:
        """Close the control correlation without serializing result or exception content."""

        self._emit(
            kind=TraceKind.TOOL_EXEC,
            name=self._runtime_name("mcp.control.completed"),
            attributes={
                "runtime_id": self.runtime_id,
                "vendor_thread_id": vendor_thread_id,
                "mcp_request_id": request_id,
                "mcp_operation": operation,
                "mcp_server": server,
                "mcp_target": target,
                "success": success,
                "failure_type": failure_type,
            },
        )

    def _finish_content(self) -> None:
        try:
            if self._capture:
                with self._capture.policies.guard:
                    blocks = self._capture.finish()
                    if blocks:
                        self._emit(
                            kind=TraceKind.CHANNEL_SEND,
                            name=TRACE_CONTENT_INCOMPLETE,
                            attributes={
                                "runtime_id": self.runtime_id,
                                "client_user_message_id": self._capture.submission,
                            },
                            outputs={"version": CONTENT_VERSION, "blocks": blocks},
                        )
        except TRACE_FAILURES as failure:
            self._capture_failure(failure)

    def close(self) -> None:
        self._finish_content()
        with self._timing_lock:
            self._turn_preparations.clear()
        if self._capture:
            self._capture.close()
        try:
            purge_content(self.path)
        except TRACE_FAILURES as failure:
            self._capture_failure(failure)
        with self._lock:
            if self._writer is not None:
                try:
                    self._writer.close()
                except OSError as failure:
                    LOGGER.error(
                        "Trace close failed: session=%s failure=%s",
                        self.session_id,
                        type(failure).__name__,
                        extra={"event": TRACE_DEGRADED_EVENT, "session_id": self.session_id},
                    )
                self._writer = None


__all__ = ["SessionTrace"]
