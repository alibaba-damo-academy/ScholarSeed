"""Local plugin inspection reuses the existing content-addressed Skill package."""

from __future__ import annotations

import json
from typing import Any

from pydantic import ValidationError

from service.capabilities.service.dependencies import declaration
from service.capabilities.service.descriptor import (
    ComponentValidationError,
    PluginDescriptor,
    inspect_plugin,
    plugin_contract,
    validate_component_value,
)
from service.capabilities.service.package import digest, read_package
from service.platform.bridge import (
    BRIDGE_REQUESTS,
    CONTRACT_CAPABILITY,
    CONTRACT_DESCRIBE_OPERATION,
    PLAN_REQUESTS,
    ComponentInvocation,
    ComponentPreflight,
    PluginInstallation,
)
from service.platform.vocabulary import BRIDGE_MAX_REQUEST_BYTES

OFFLINE_VALIDATION_STAGE = "offline"
AUTHORING_CONTRACT_VERSION = "1.0.0"
COMPONENT_SDK_CONTRACT = {
    "global": "window.plugin",
    "state": {
        "data": "JSON object: immutable business input, with saved draft fields projected by host",
        "draft": "JSON object: saved user choices, not a status string",
        "revision": "integer: current persisted draft revision; copy content is pinned to it",
        "status": "pending enables submission; submitting/resolved/cancelled/stale/unknown do not",
        "language": "locale string",
        "slot": "registered slot string",
        "theme": "light or dark",
    },
    "onState": "callback receives latest state and returns an unsubscribe function; updates are not resets",
    "save": "Promise of {state: JSON object, revision: integer}; does not advance AI or authorize business",
    "setCopyContent": "Promise: register {text: non-empty string, markdown?: string} for the current draft revision; persisted with the card, no clipboard access or AI continuation; refresh after save",
    "submit": "void; action and values are validated by host; completion comes via onState, not return value",
    "request": "Promise of host result; requires declared capability and a handler in the current context",
}


def validate_request(descriptor: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    try:
        plugin = PluginDescriptor.model_validate(descriptor)
        invocation = ComponentInvocation.model_validate(request)
        component = next((item for item in plugin.components if item.slot == invocation.slot), None)
        if component is None:
            raise ValueError("component_slot_undeclared")
        if component.public:
            raise ValueError("component_public_requires_domain_tool")
        validate_component_value(component.input_schema, invocation.data)
    except ComponentValidationError as error:
        issues.append({"code": str(error), "severity": "error", "detail": error.detail})
    except ValidationError as error:
        issues.extend(
            {"code": item["type"], "severity": "error", "detail": {"path": list(item["loc"])}}
            for item in error.errors(include_input=False, include_context=False, include_url=False)
        )
    except ValueError as error:
        issues.append({"code": str(error), "severity": "error"})
    return {
        "valid": not issues,
        "validation_stage": OFFLINE_VALIDATION_STAGE,
        "authorized": False,
        "runtime_verified": False,
        "issues": issues,
    }


def describe_contract() -> dict[str, Any]:
    contract = {
        **plugin_contract(),
        "component_invocation_schema": ComponentInvocation.model_json_schema(),
        "component_preflight_schema": ComponentPreflight.model_json_schema(),
        "component_sdk": COMPONENT_SDK_CONTRACT,
        "planning": {
            "operations": {
                operation: request.model_json_schema()
                for operation, request in PLAN_REQUESTS.items()
            },
            "grants_permissions": False,
        },
        "native_contract_discovery": {
            "capability": CONTRACT_CAPABILITY,
            "operation": CONTRACT_DESCRIBE_OPERATION,
            "request_schema": BRIDGE_REQUESTS[
                (CONTRACT_CAPABILITY, CONTRACT_DESCRIBE_OPERATION)
            ].request_type.model_json_schema(),
            "example": {"target_capability": "literature", "target_operation": "read"},
            "grants_permissions": False,
        },
        "installation": {
            "schema": PluginInstallation.model_json_schema(),
            "blocking": False,
            "result": "published is not installed; independent card actions never gate creation",
            "revision": "immutable workspace-relative ZIP path and SHA256 per request_id",
        },
        "bridge_request_max_bytes": BRIDGE_MAX_REQUEST_BYTES,
    }
    canonical = json.dumps(contract, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return {
        **contract,
        "identity": {
            "version": AUTHORING_CONTRACT_VERSION,
            "sha256": digest(canonical.encode("utf-8")),
        },
    }


def inspect_package(payload: bytes, *, host_version: str) -> dict[str, Any]:
    package = read_package(payload)
    dependencies = declaration(package.manifest["dependencies"])
    result = inspect_plugin(
        {name: item.data for name, item in package.files.items()},
        skill_name=package.name,
        skill_version=package.version,
        host_version=host_version,
    )
    return {
        **result,
        "validation_stage": OFFLINE_VALIDATION_STAGE,
        "host_version": host_version,
        "sha256": digest(payload),
        "fingerprint": package.fingerprint,
        "integrity_verified": True,
        "dependencies": dependencies,
        "dependencies_verified": False,
        "files": package.manifest["files"],
    }
