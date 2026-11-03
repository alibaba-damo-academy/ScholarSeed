"""On-demand model-facing contracts generated from the execution registry."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from service.platform.bridge import (
    BRIDGE_REQUESTS,
    CONTRACT_CAPABILITY,
    CONTRACT_DESCRIBE_OPERATION,
    CONTRACT_GUIDANCE_KEY,
    CONTRACT_PREREQUISITES_KEY,
)
from service.platform.queries import (
    DOMAIN_CHECKED,
    NOT_DECLARED,
    PROJECT_REQUIRED,
    PROJECT_SCOPE,
    REGISTERED,
    UNAVAILABLE,
    ContractList,
)
from service.platform.vocabulary import BRIDGE_MAX_RESPONSE_BYTES


def contract_query(capability: str, operation: str) -> dict[str, Any]:
    return {
        "capability": CONTRACT_CAPABILITY,
        "operation": CONTRACT_DESCRIBE_OPERATION,
        "request": {"target_capability": capability, "target_operation": operation},
    }


def operation_choices(capability: str) -> dict[str, Any]:
    operations = [name for owner, name in BRIDGE_REQUESTS if owner == capability]
    return {
        "ok": False,
        "error": "bridge_operation_unknown",
        "valid_capabilities": list(dict.fromkeys(owner for owner, _name in BRIDGE_REQUESTS)),
        "capability": capability,
        "valid_operations": operations,
        "describe_choices": [contract_query(capability, operation) for operation in operations],
        "next_action": (
            "The capability above is the requested target, including inside contract/describe. "
            "Use one of describe_choices unchanged to obtain a registered operation's contract. "
            "Choose a registered capability/operation pair, then use contract/describe "
            "for its request contract. Outer operation selects the endpoint; "
            "request.operation, when present, selects a mutation inside it."
        ),
    }


def describe_contract(
    capability: str, operation: str, *, project_id: str | None = None
) -> dict[str, Any]:
    entry = BRIDGE_REQUESTS.get((capability, operation))
    if entry is None:
        return operation_choices(capability)
    request_type = entry.request_type
    schema = request_type.model_json_schema()
    guidance = schema.pop(CONTRACT_GUIDANCE_KEY, "")
    if entry.guidance:
        guidance = entry.guidance
    prerequisites = schema.pop(CONTRACT_PREREQUISITES_KEY, [])
    if isinstance(guidance, dict):
        guidance = guidance.get(operation, "")
    if isinstance(prerequisites, dict):
        prerequisites = prerequisites.get(operation, [])
    contract = {
        "capability": capability,
        "operation": operation,
        "request_schema": schema,
        "guidance": guidance,
        "prerequisites": prerequisites,
        "summary": entry.summary,
        "scope": entry.scope,
        "effect": entry.effect,
        "approval": entry.approval,
        "response_schema": entry.response_type.model_json_schema() if entry.response_type else None,
        "response_schema_status": REGISTERED if entry.response_type else NOT_DECLARED,
    }
    encoded = json.dumps(
        contract, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()
    result = {"ok": True, **contract, "contract_version": hashlib.sha256(encoded).hexdigest()}
    result["availability"] = operation_availability(entry.scope, project_id)
    if len(json.dumps(result, ensure_ascii=False).encode()) > BRIDGE_MAX_RESPONSE_BYTES:
        return {"ok": False, "error": "bridge_contract_too_large"}
    return result


def operation_availability(scope: str, project_id: str | None) -> dict[str, str]:
    if scope == PROJECT_SCOPE and project_id == "":
        return {"status": UNAVAILABLE, "reason": PROJECT_REQUIRED}
    return {
        "status": DOMAIN_CHECKED,
        "reason": "Execution rechecks scope, targets and authorization.",
    }


def list_contracts(query: ContractList, *, project_id: str | None = None) -> dict[str, Any]:
    entries = sorted(
        (key, entry)
        for key, entry in BRIDGE_REQUESTS.items()
        if not query.capability or key[0] == query.capability
    )
    selected = entries[query.offset : query.offset + query.limit]
    return {
        "ok": True,
        "entries": [
            {
                "capability": capability,
                "operation": operation,
                "summary": entry.summary,
                "scope": entry.scope,
                "effect": entry.effect,
                "approval": entry.approval,
                "availability": operation_availability(entry.scope, project_id),
            }
            for (capability, operation), entry in selected
        ],
        "next_offset": (
            query.offset + query.limit if query.offset + query.limit < len(entries) else None
        ),
    }
