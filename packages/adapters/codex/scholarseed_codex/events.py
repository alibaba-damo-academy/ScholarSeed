"""Translate Codex adapter observations into the public Runtime Gateway ABI."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Mapping

from scholarseed_codex.protocol.session import CodexSessionEvent, CodexSessionEventKind
from scholarseed_codex.utils import json_value
from scholarseed_runtime.contract import (
    ActorKind,
    CallbackAudience,
    CallbackKind,
    DeliveryClass,
    RuntimeCallbackRequest,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeValue,
)
from scholarseed_runtime.contract.content import (
    CONTENT_FIELDS,
    CONTENT_OBSERVATIONS,
    CONTENT_SCHEMA_VERSION,
    CONTENT_SOURCE,
)

RUNTIME_EVENT_SCHEMA_VERSION = 1

_DIRECT_EVENT_KINDS = {
    CodexSessionEventKind.ASSISTANT_COMPLETED: RuntimeEventKind.CONTENT_COMPLETED,
    CodexSessionEventKind.REASONING_COMPLETED: RuntimeEventKind.CONTENT_COMPLETED,
    CodexSessionEventKind.OPENED: RuntimeEventKind.SESSION_OPENED,
    CodexSessionEventKind.RESUMED: RuntimeEventKind.SESSION_RESUMED,
    CodexSessionEventKind.CLOSED: RuntimeEventKind.SESSION_CLOSED,
    CodexSessionEventKind.TURN_STARTED: RuntimeEventKind.TURN_STARTED,
    CodexSessionEventKind.TOOL_STARTED: RuntimeEventKind.TOOL_STARTED,
    CodexSessionEventKind.TOOL_PROGRESS: RuntimeEventKind.TOOL_PROGRESS,
    CodexSessionEventKind.TOOL_COMPLETED: RuntimeEventKind.TOOL_COMPLETED,
    CodexSessionEventKind.FILE_CHANGED: RuntimeEventKind.ARTIFACT_OBSERVED,
    CodexSessionEventKind.PLAN_UPDATED: RuntimeEventKind.PLAN_UPDATED,
    CodexSessionEventKind.USAGE_UPDATED: RuntimeEventKind.USAGE_UPDATED,
    CodexSessionEventKind.CONTEXT_COMPACTED: RuntimeEventKind.CONTEXT_COMPACTED,
    CodexSessionEventKind.HIL_RESOLVED: RuntimeEventKind.INTERACTION_RESOLVED,
    CodexSessionEventKind.TURN_COMPLETED: RuntimeEventKind.TURN_COMPLETED,
    CodexSessionEventKind.TURN_FAILED: RuntimeEventKind.TURN_FAILED,
    CodexSessionEventKind.TURN_INTERRUPTED: RuntimeEventKind.TURN_INTERRUPTED,
    CodexSessionEventKind.TURN_UNKNOWN: RuntimeEventKind.TURN_UNKNOWN,
    CodexSessionEventKind.RUNTIME_STATUS: RuntimeEventKind.RUNTIME_STATUS,
    CodexSessionEventKind.RUNTIME_INCIDENT: RuntimeEventKind.RUNTIME_INCIDENT,
    CodexSessionEventKind.SKILLS_CHANGED: RuntimeEventKind.SKILLS_CHANGED,
}

_COALESCIBLE_KINDS = frozenset(
    {
        RuntimeEventKind.CONTENT_DELTA,
        RuntimeEventKind.TOOL_PROGRESS,
    }
)

_CALLBACK_KINDS = {
    "item/commandExecution/requestApproval": CallbackKind.COMMAND_APPROVAL,
    "item/fileChange/requestApproval": CallbackKind.FILE_APPROVAL,
    "item/tool/requestUserInput": CallbackKind.USER_INPUT,
    "item/permissions/requestApproval": CallbackKind.PERMISSION,
    "mcpServer/elicitation/request": CallbackKind.ELICITATION,
}

SUBAGENT_LIFECYCLE_ACTIVITY_TYPES = frozenset(("subagent_activity",))
SUBAGENT_DISPATCH_ACTIVITIES = frozenset(("spawned", "started"))
SUBAGENT_INTERRUPTED_STATUSES = frozenset(("cancelled", "declined", "interrupted"))
SUBAGENT_FAILED_STATUSES = frozenset(("error", "failed"))

EXTENSION_KIND_KEY = "extension_kind"
INCIDENT_KEY = "incident"
CALL_ID_KEY = "call_id"
REQUEST_ID_KEY = "request_id"
CORRELATION_ID_KEY = "correlation_id"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _payload(event: CodexSessionEvent) -> dict[str, RuntimeValue]:
    payload = {str(key): json_value(value) for key, value in event.payload.items()}
    incident = event.incident
    if incident is not None:
        payload[INCIDENT_KEY] = {
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
            "native_session_id": incident.vendor_thread_id,
            "native_turn_id": incident.vendor_turn_id,
            "rpc_method": incident.rpc_method,
            "rpc_code": incident.rpc_code,
            "rpc_latency_ms": incident.rpc_latency_ms,
            "process_exit_code": incident.process_exit_code,
            "ambiguous_commit": incident.ambiguous_commit,
        }
    return payload


def _event_kind(event: CodexSessionEvent) -> RuntimeEventKind:
    if event.kind is CodexSessionEventKind.RUNTIME_WARNING and "rpc_method" not in event.payload:
        return RuntimeEventKind.RUNTIME_WARNING
    if event.kind is CodexSessionEventKind.SUBAGENT_ACTIVITY:
        return RuntimeEventKind.SUBAGENT_STATUS_CHANGED
    if event.kind == CodexSessionEventKind.ASSISTANT_DELTA:
        return RuntimeEventKind.CONTENT_DELTA
    if event.kind == CodexSessionEventKind.REASONING_DELTA:
        return RuntimeEventKind.CONTENT_DELTA
    if event.kind in {
        CodexSessionEventKind.NATIVE_ACTIVITY_STARTED,
        CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED,
    }:
        activity_type = str(event.payload.get("activity_type") or "")
        if activity_type in SUBAGENT_LIFECYCLE_ACTIVITY_TYPES:
            if event.kind is CodexSessionEventKind.NATIVE_ACTIVITY_STARTED:
                return RuntimeEventKind.SUBAGENT_STARTED
            status = str(event.payload.get("status") or "").lower()
            if status in SUBAGENT_INTERRUPTED_STATUSES:
                return RuntimeEventKind.SUBAGENT_INTERRUPTED
            if status in SUBAGENT_FAILED_STATUSES or event.payload.get("ok") is False:
                return RuntimeEventKind.SUBAGENT_FAILED
            details = event.payload.get("details")
            detail_values = details if isinstance(details, Mapping) else {}
            activity = str(detail_values.get("activity") or "").lower()
            if activity in SUBAGENT_DISPATCH_ACTIVITIES:
                return RuntimeEventKind.SUBAGENT_STARTED
            return RuntimeEventKind.SUBAGENT_COMPLETED
    return _DIRECT_EVENT_KINDS.get(event.kind, RuntimeEventKind.RUNTIME_EXTENSION)


def translate_event(
    event: CodexSessionEvent,
    *,
    product_session_id: str,
    process_generation: int,
    sequence: int | None = None,
) -> RuntimeEvent | RuntimeCallbackRequest:
    """Normalize one observed App Server event without leaking a native frame."""

    payload = _payload(event)
    observations: list[RuntimeValue] = [
        {
            "version": CONTENT_SCHEMA_VERSION,
            "field": field,
            "source": CONTENT_SOURCE,
            "original_bytes": (
                None
                if payload.get("content_truncated")
                else len(json.dumps(payload[field], ensure_ascii=False).encode())
            ),
            "truncated": bool(payload.get("content_truncated")),
            "missing_reason": "upstream_truncated" if payload.get("content_truncated") else "",
        }
        for field in sorted(CONTENT_FIELDS)
        if field in payload
    ]
    if observations:
        payload[CONTENT_OBSERVATIONS] = observations
    normalized_sequence = event.vendor_seq if sequence is None else sequence
    observed_at = event.created_at or _now()
    if event.kind == CodexSessionEventKind.HIL_REQUESTED:
        method = str(payload.get("method") or "")
        options = payload.get("options")
        decisions = (
            tuple(
                str(option.get("id") or "")
                for option in options
                if isinstance(option, Mapping) and option.get("id")
            )
            if isinstance(options, list)
            else ()
        )
        request_id = str(payload.get("request_id") or "")
        return RuntimeCallbackRequest(
            schema_version=RUNTIME_EVENT_SCHEMA_VERSION,
            runtime_id=event.runtime_id,
            product_session_id=product_session_id,
            native_session_id=event.session_id,
            native_turn_id=event.turn_id,
            native_item_id=event.item_id,
            request_id=request_id,
            audience=CallbackAudience.USER,
            kind=_CALLBACK_KINDS.get(method, CallbackKind.ELICITATION),
            blocking=True,
            prompt=payload,
            allowed_decisions=decisions,
            response_contract={"method": method},
            observed_at=observed_at,
        )

    if event.kind == CodexSessionEventKind.DYNAMIC_TOOL_REQUESTED:
        return RuntimeCallbackRequest(
            schema_version=RUNTIME_EVENT_SCHEMA_VERSION,
            runtime_id=event.runtime_id,
            product_session_id=product_session_id,
            native_session_id=event.session_id,
            native_turn_id=event.turn_id,
            native_item_id=event.item_id,
            request_id=str(payload.get("request_id") or ""),
            audience=CallbackAudience.SERVICE,
            kind=CallbackKind.DYNAMIC_TOOL,
            blocking=True,
            prompt=payload,
            response_contract={"type": "dynamic_tool"},
            observed_at=observed_at,
        )

    kind = _event_kind(event)
    if (
        kind is RuntimeEventKind.SUBAGENT_STARTED
        and event.kind is CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED
    ):
        payload = {**payload, "status": "running"}
    if event.kind in {
        CodexSessionEventKind.ASSISTANT_DELTA,
        CodexSessionEventKind.ASSISTANT_COMPLETED,
    }:
        payload = {**payload, "role": "assistant"}
    elif event.kind in {
        CodexSessionEventKind.REASONING_DELTA,
        CodexSessionEventKind.REASONING_COMPLETED,
    }:
        payload = {**payload, "role": "reasoning"}
    if kind is RuntimeEventKind.RUNTIME_EXTENSION:
        payload = {**payload, EXTENSION_KIND_KEY: event.kind.value}
    delivery = (
        DeliveryClass.COALESCIBLE if kind in _COALESCIBLE_KINDS else DeliveryClass.MUST_PERSIST
    )
    details = payload.get("details")
    detail_values = details if isinstance(details, Mapping) else {}
    receiver_ids = detail_values.get("receiver_thread_ids")
    receiver_id = (
        str(receiver_ids[0] or "") if isinstance(receiver_ids, list) and receiver_ids else ""
    )
    subagent_actor_id = str(detail_values.get("agent_thread_id") or receiver_id)
    actor_kind = ActorKind.SUBAGENT if kind.name.startswith("SUBAGENT_") else ActorKind.MAIN
    actor_id = subagent_actor_id if actor_kind is ActorKind.SUBAGENT else ""
    if actor_kind is ActorKind.SUBAGENT:
        payload = {
            **payload,
            "subagent_id": actor_id or event.item_id,
            "parent_agent_id": event.session_id,
            "root_turn_id": event.turn_id,
            "native_agent_session_id": actor_id,
            "agent_path": str(detail_values.get("agent_path") or ""),
            "display_name": str(detail_values.get("agent_path") or "Subagent"),
        }
    return RuntimeEvent(
        schema_version=RUNTIME_EVENT_SCHEMA_VERSION,
        event_id=f"{event.runtime_id}:{event.session_id}:{normalized_sequence}",
        runtime_id=event.runtime_id,
        product_session_id=product_session_id,
        native_session_id=event.session_id,
        native_turn_id=event.turn_id,
        native_item_id=event.item_id,
        process_generation=process_generation,
        sequence=normalized_sequence,
        kind=kind,
        delivery=delivery,
        observed_at=observed_at,
        call_id=str(payload.get(CALL_ID_KEY) or ""),
        correlation_id=str(payload.get(CORRELATION_ID_KEY) or payload.get(REQUEST_ID_KEY) or ""),
        actor_kind=actor_kind,
        actor_id=actor_id or (event.item_id if actor_kind is ActorKind.SUBAGENT else ""),
        parent_actor_id=event.session_id if actor_kind is ActorKind.SUBAGENT else "",
        payload=payload,
    )


__all__ = ["RUNTIME_EVENT_SCHEMA_VERSION", "translate_event"]
