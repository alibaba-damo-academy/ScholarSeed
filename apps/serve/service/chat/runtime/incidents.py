"""Validate incident observations at the product runtime boundary."""

from dataclasses import fields
from enum import Enum
from typing import Mapping

from scholarseed_runtime.contract.event import RuntimeEvent
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from service.chat.runtime.utils import boolean, integer, optional_integer, text


def incident_data(incident: RuntimeIncident) -> dict:
    values = {}
    for field in fields(incident):
        value = getattr(incident, field.name)
        values[field.name] = value.value if isinstance(value, Enum) else value
    values["native_session_id"] = values.pop("vendor_thread_id")
    values["native_turn_id"] = values.pop("vendor_turn_id")
    return values


def event_incident(event: RuntimeEvent) -> RuntimeIncident | None:
    payload = event.payload if isinstance(event.payload, Mapping) else {}
    raw = payload.get("incident")
    if not isinstance(raw, Mapping):
        return None
    try:
        return RuntimeIncident(
            incident_id=text(raw["incident_id"]),
            scope=RuntimeIncidentScope(raw["scope"]),
            state=RuntimeIncidentState(raw["state"]),
            kind=RuntimeIncidentKind(raw["kind"]),
            strategy=RuntimeRecoveryStrategy(raw["strategy"]),
            retryability=RuntimeRetryability(raw["retryability"]),
            safe_error=text(raw["safe_error"]),
            process_generation=integer(raw.get("process_generation", 0)),
            attempt=integer(raw.get("attempt", 0)),
            max_attempts=integer(raw.get("max_attempts", 0)),
            vendor_thread_id=text(raw.get("native_session_id", "")),
            vendor_turn_id=text(raw.get("native_turn_id", "")),
            rpc_method=text(raw.get("rpc_method", "")),
            rpc_code=optional_integer(raw.get("rpc_code")),
            rpc_latency_ms=integer(raw.get("rpc_latency_ms", 0)),
            process_exit_code=optional_integer(raw.get("process_exit_code")),
            ambiguous_commit=boolean(raw.get("ambiguous_commit", False)),
            provider_error_code=text(raw.get("provider_error_code", "")),
            provider_http_status=optional_integer(raw.get("provider_http_status")),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("invalid runtime incident observation") from error
