"""Session-bound product capabilities exposed through runtime service callbacks."""

from __future__ import annotations

import json
import os
from collections import defaultdict
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError
from pydantic.json_schema import models_json_schema

from scholarseed_runtime.contract import RuntimeServiceTool
from service.platform.bridge import (
    BLOCKING_CHECKPOINTS,
    BLOCKING_OPERATIONS,
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_MAX_RESPONSE_BYTES,
    BRIDGE_REQUESTS,
    BRIDGE_SESSION_HEADER,
    BRIDGE_TIMEOUT_SECONDS,
    BRIDGE_TOKEN_HEADER,
    INTERNAL_BASE_URL_ENV,
    PdfQuery,
)

SERVICE_BRIDGE_TOOL_NAME = "scholarseed_bridge"
DETAILED_SCHEMA_OPERATIONS = frozenset({("task", "activate"), ("plan", "get"), ("plan", "write")})
SCHEMA_CONSTRAINT_KEYS = frozenset(
    {"minLength", "maxLength", "minimum", "maximum", "pattern", "minItems", "maxItems"}
)
MISSING_PARAMETER_ERROR = "missing"
BRIDGE_VALIDATION_ACTION = (
    "Correct the fields identified by validation_errors using request_schema. "
    "Do not retry unchanged arguments or guess fields and enum values."
)
PDF_REQUEST_GUIDANCE = (
    "PDF workflow: call pdf/list with request={} to obtain an authorized ref_id. "
    'Call pdf/read with request={"ref_id":"<ref_id from list>","offset":0} '
    'or pdf/search with request={"ref_id":"<ref_id from list>","query":"search terms"}. '
    "The offset indexes evidence fragments, not PDF page numbers. "
    "Valid PDF query request fields: " + ", ".join(PdfQuery.model_fields) + "."
)
BRIDGE_REQUEST_GUIDANCE = (
    "Use the selected capability/operation request contract in the tool description."
)
BRIDGE_ENDPOINT_GUIDANCE = "Outer endpoint operation, not the mutation inside request. "
BRIDGE_OPERATION_ACTION = (
    "Choose an outer operation from valid_operations for the capability, "
    "then construct request using its request_schemas entry. "
    "The outer operation selects an endpoint; request.operation, when present, "
    "selects a mutation inside that endpoint. Do not retry unchanged arguments."
)
PLAN_REQUEST_GUIDANCE = (
    "Plan workflow: first call plan/get with request={} to obtain turn_id and the current "
    "plan (plan_id/revision) and items. Then call plan/write: outer operation is always write; "
    "request.operation is create, update, revise or release, not action. "
    "When no structured plan exists, choose a new plan_id and use create with expected_revision=0. "
    "For an existing plan, reuse plan_id and set expected_revision to the returned revision. "
    "Send complete flat items, not a patch or nested children: each item has id, content, status "
    "and optional parent_id referencing another item's id. No children field is supported. "
    "Reuse stable item ids. Use a new request_id per mutation; "
    "reuse it only for an identical retry. Use the current turn_id returned by plan/get. "
    "Update changes progress without changing root content or existing parent links; "
    "revise changes structure with a non-empty reason. For normal completion, use update to "
    "mark all finished items completed; do not release a plan merely to finish it. "
    "Release opts out of structured planning, requires a non-empty reason "
    "and must preserve items. On a revision conflict, reread plan/get before a changed retry. "
    'Create example: {"capability":"plan","operation":"write","request":'
    '{"operation":"create","plan_id":"new-plan","expected_revision":0,'
    '"request_id":"create-1","turn_id":"<turn_id from get>",'
    '"items":[{"id":"step-1","content":"Research","status":"in_progress"}]}}. '
    'Update example: {"capability":"plan","operation":"write","request":'
    '{"operation":"update","plan_id":"<plan_id from get>",'
    '"expected_revision":1,"request_id":"update-1","turn_id":"<turn_id from get>",'
    '"items":[{"id":"step-1","content":"Research","status":"completed"}]}}; '
    "replace the example revision with the current revision from get."
)


def service_tool_schema() -> dict[str, Any]:
    models = tuple(
        dict.fromkeys(
            model
            for operation, (model, _route) in BRIDGE_REQUESTS.items()
            if operation in DETAILED_SCHEMA_OPERATIONS
        )
    )
    references, definitions = models_json_schema([(model, "validation") for model in models])
    for definition in definitions.get("$defs", {}).values():
        for field in definition.get("properties", {}).values():
            constraints = {
                key: value for key, value in field.items() if key in SCHEMA_CONSTRAINT_KEYS
            }
            if constraints:
                field["description"] = (
                    str(field.get("description", ""))
                    + " Constraints: "
                    + json.dumps(constraints, separators=(",", ":"))
                ).strip()
    operations_by_capability: dict[str, list[str]] = defaultdict(list)
    for capability, operation in BRIDGE_REQUESTS:
        if (capability, operation) not in DETAILED_SCHEMA_OPERATIONS:
            operations_by_capability[capability].append(operation)
    return {
        **definitions,
        "type": "object",
        "properties": {
            "capability": {
                "type": "string",
                "enum": list(
                    dict.fromkeys(capability for capability, _operation in BRIDGE_REQUESTS)
                ),
            },
            "operation": {
                "type": "string",
                "enum": list(
                    dict.fromkeys(operation for _capability, operation in BRIDGE_REQUESTS)
                ),
                "description": BRIDGE_ENDPOINT_GUIDANCE
                + " ".join(
                    f"{capability}/{operation}: {model.model_fields['operation'].description}"
                    for (capability, operation), (model, _route) in BRIDGE_REQUESTS.items()
                    if "operation" in model.model_fields
                    and model.model_fields["operation"].description
                ),
            },
            "request": {"type": "object", "description": BRIDGE_REQUEST_GUIDANCE},
        },
        "required": ["capability", "operation", "request"],
        "additionalProperties": False,
        "oneOf": [
            {
                "properties": {
                    "capability": {"const": capability},
                    "operation": {"const": operation},
                    "request": references[(model, "validation")],
                },
            }
            for (capability, operation), (model, _route) in BRIDGE_REQUESTS.items()
            if (capability, operation) in DETAILED_SCHEMA_OPERATIONS
        ]
        + [
            {"properties": {"capability": {"const": capability}, "operation": {"enum": operations}}}
            for capability, operations in operations_by_capability.items()
        ],
    }


SERVICE_BRIDGE_TOOL = RuntimeServiceTool(
    name=SERVICE_BRIDGE_TOOL_NAME,
    description=(
        "Call a ScholarSeed product capability for this conversation. "
        "Allowed capability/operation pairs: "
        + ", ".join(f"{capability}/{operation}" for capability, operation in BRIDGE_REQUESTS)
        + ". "
        + PDF_REQUEST_GUIDANCE
        + " "
        + PLAN_REQUEST_GUIDANCE
        + " Web search: search/run accepts query, profile (official, native, browser), "
        "and limit. It registers source candidates before returning; use it instead of "
        "direct shell invocation of web-search scripts in a conversation."
        + " Detailed operation request contracts (required fields and constraints are authoritative): "
        + "; ".join(
            f"{capability}/{operation}: "
            + json.dumps(model.model_json_schema(), separators=(",", ":"))
            for (capability, operation), (model, _route) in BRIDGE_REQUESTS.items()
        )
    ),
    input_schema=service_tool_schema(),
)


async def execute_service_tool(
    arguments: object,
    *,
    session_id: str,
    token: str,
    local_socket: Path | None,
) -> dict[str, Any]:
    if not isinstance(arguments, Mapping):
        return {"ok": False, "error": "bridge_invalid_parameters"}
    capability = arguments.get("capability")
    operation = arguments.get("operation")
    if not isinstance(capability, str) or not isinstance(operation, str):
        return {"ok": False, "error": "bridge_invalid_parameters"}
    entry = BRIDGE_REQUESTS.get((capability, operation))
    if entry is None:
        request_schemas = {
            name: model.model_json_schema()
            for (owner, name), (model, _route) in BRIDGE_REQUESTS.items()
            if owner == capability
        }
        return {
            "ok": False,
            "error": "bridge_operation_unknown",
            "valid_capabilities": list(dict.fromkeys(owner for owner, _name in BRIDGE_REQUESTS)),
            "valid_operations": list(request_schemas),
            "request_schemas": request_schemas,
            "next_action": BRIDGE_OPERATION_ACTION,
        }
    request_type, route = entry
    try:
        payload = request_type.model_validate(arguments.get("request")).model_dump()
        if len(json.dumps(payload, ensure_ascii=False).encode()) > BRIDGE_MAX_REQUEST_BYTES:
            return {"ok": False, "error": "bridge_request_too_large"}
    except ValidationError as error:
        errors = error.errors(include_url=False, include_context=False, include_input=False)
        return {
            "ok": False,
            "error": "bridge_invalid_parameters",
            "valid_parameters": list(request_type.model_fields),
            "invalid_parameters": list(
                dict.fromkeys(
                    str(item["loc"][0]) if item["loc"] else "request"
                    for item in errors
                    if item["type"] != MISSING_PARAMETER_ERROR
                )
            ),
            "required_parameters": list(
                dict.fromkeys(
                    str(item["loc"][0]) if item["loc"] else "request"
                    for item in errors
                    if item["type"] == MISSING_PARAMETER_ERROR
                )
            ),
            "validation_errors": [
                {"path": ["request", *item["loc"]], "type": item["type"], "message": item["msg"]}
                for item in errors
            ],
            "request_schema": request_type.model_json_schema(),
            "next_action": BRIDGE_VALIDATION_ACTION,
        }
    except (TypeError, ValueError):
        return {"ok": False, "error": "bridge_invalid_parameters"}
    base_url = os.environ.get(INTERNAL_BASE_URL_ENV, "").rstrip("/")
    if local_socket:
        base_url = "http://localhost"
    address = urlsplit(base_url)
    if not token or not session_id or address.scheme not in {"http", "https"}:
        return {"ok": False, "error": "bridge_context_unavailable"}
    if (
        address.username
        or address.password
        or address.query
        or address.fragment
        or (not local_socket and address.hostname not in {"localhost", "127.0.0.1", "::1"})
    ):
        return {"ok": False, "error": "bridge_secure_transport_required"}
    transport = httpx.AsyncHTTPTransport(uds=str(local_socket)) if local_socket else None
    timeout = (
        httpx.Timeout(BRIDGE_TIMEOUT_SECONDS, read=None)
        if (capability, operation) in BLOCKING_OPERATIONS
        or payload.get("checkpoint") in BLOCKING_CHECKPOINTS.get((capability, operation), ())
        else httpx.Timeout(BRIDGE_TIMEOUT_SECONDS)
    )
    try:
        async with httpx.AsyncClient(
            timeout=timeout, trust_env=False, transport=transport
        ) as client:
            async with client.stream(
                "POST",
                f"{base_url}{route}",
                headers={BRIDGE_SESSION_HEADER: session_id, BRIDGE_TOKEN_HEADER: token},
                json=payload,
            ) as response:
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > BRIDGE_MAX_RESPONSE_BYTES:
                        return {"ok": False, "error": "bridge_response_too_large"}
                result = json.loads(body)
                if not isinstance(result, dict):
                    return {"ok": False, "error": "bridge_response_invalid"}
                return result
    except (httpx.HTTPError, ValueError, json.JSONDecodeError):
        return {"ok": False, "error": "bridge_transport_failed"}
