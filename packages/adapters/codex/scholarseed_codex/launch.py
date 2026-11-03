"""Shared model launch projection for application hosts and native threads."""

from __future__ import annotations

import json
import os
import re
from dataclasses import replace
from typing import Any

from scholarseed_codex.environment import (
    CODEX_REMOTE_CONFIG_OPTION,
    proxy_bypass_environment,
)
from scholarseed_codex.protocol.mcp import JsonValue
from scholarseed_codex.protocol.session import CodexRuntimeLaunchArgument, CodexSessionOpenRequest
from scholarseed_codex.protocol.state import AppServerError, CodexActivationStage
from scholarseed_runtime.contract.command import RUNTIME_SKILL_POLICY_UNSUPPORTED
from scholarseed_runtime.contract.evidence import RuntimeTimingPort
from scholarseed_runtime.contract.model import (
    ModelConnectionMode,
    ModelCredential,
    ModelCredentialPort,
    ModelIntent,
)

CODEX_REMOTE_PROVIDER_ID = "scholarseed"
CODEX_REMOTE_PROVIDER_NAME = "ScholarSeed"
CODEX_REMOTE_HOST_PROVIDER: dict[str, JsonValue] = {
    "name": CODEX_REMOTE_PROVIDER_NAME,
    "wire_api": "responses",
    "requires_openai_auth": False,
}
CODEX_MODEL_API_KEY_ENV = "SCHOLARSEED_MODEL_API_KEY"
CODEX_MODEL_HEADER_ENV_PREFIX = "SCHOLARSEED_MODEL_HEADER"
HEADER_ENV_PATTERN = re.compile(r"[^A-Z0-9]+")
CODEX_MODEL_CONNECTION_REQUIRED = "runtime_model_connection_required"
CODEX_SKILLS_POLICY_UNSUPPORTED = RUNTIME_SKILL_POLICY_UNSUPPORTED


def validate_model_connection(intent: ModelIntent) -> None:
    """Reject implicit or native authentication before touching managed state."""
    if (
        intent.transport.mode is not ModelConnectionMode.REMOTE
        or not isinstance(intent.transport.endpoint, str)
        or not intent.transport.endpoint.strip()
    ):
        raise AppServerError(
            CODEX_MODEL_CONNECTION_REQUIRED, safe_error=CODEX_MODEL_CONNECTION_REQUIRED
        )


def validate_thread_model(request: CodexSessionOpenRequest) -> None:
    if request.model_provider != CODEX_REMOTE_PROVIDER_ID:
        return
    providers = request.thread_config.get("model_providers")
    provider = providers.get(request.model_provider) if isinstance(providers, dict) else None
    endpoint = provider.get("base_url") if isinstance(provider, dict) else None
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise AppServerError(
            CODEX_MODEL_CONNECTION_REQUIRED, safe_error=CODEX_MODEL_CONNECTION_REQUIRED
        )


async def model_connection(
    intent: ModelIntent,
    request: CodexSessionOpenRequest,
    credential_port: ModelCredentialPort | None,
    *,
    timing: RuntimeTimingPort,
) -> CodexSessionOpenRequest:
    validate_model_connection(intent)
    config = dict(request.thread_config)
    transport = intent.transport
    provider: dict[str, Any] = {
        "name": CODEX_REMOTE_PROVIDER_NAME,
        "base_url": transport.endpoint.rstrip("/"),
        "wire_api": transport.wire_protocol.value,
        "requires_openai_auth": False,
        "supports_websockets": transport.supports_websockets,
    }
    if transport.stream_max_retries is not None:
        provider["stream_max_retries"] = transport.stream_max_retries
    if transport.request_max_retries is not None:
        provider["request_max_retries"] = transport.request_max_retries
    environment = dict(request.process_environment)
    environment.update(
        proxy_bypass_environment({**os.environ, **environment}, transport.proxy_bypass_hosts)
    )
    material = ModelCredential()
    if transport.credential_ref:
        if credential_port is None:
            raise ValueError("model credential port is required")
        with timing.measure(CodexActivationStage.MODEL_CREDENTIALS):
            material = await credential_port.resolve(transport.credential_ref)
    if material.api_key:
        provider["env_key"] = CODEX_MODEL_API_KEY_ENV
        environment[CODEX_MODEL_API_KEY_ENV] = material.api_key
    headers: dict[str, str] = {}
    for index, (raw_name, raw_value) in enumerate(material.headers.items()):
        name, value = str(raw_name).strip(), str(raw_value).strip()
        if not name or not value:
            continue
        slug = HEADER_ENV_PATTERN.sub("_", name.upper()).strip("_") or str(index)
        environment_name = f"{CODEX_MODEL_HEADER_ENV_PREFIX}_{slug}_{index}"
        headers[name] = environment_name
        environment[environment_name] = value
    if headers:
        provider["env_http_headers"] = headers
    config["model_providers"] = {CODEX_REMOTE_PROVIDER_ID: provider}
    if intent.context_window is not None:
        config["model_context_window"] = intent.context_window
    request = replace(
        request,
        model_provider=CODEX_REMOTE_PROVIDER_ID,
        thread_config=config,
        process_environment=environment,
    )
    providers = {CODEX_REMOTE_PROVIDER_ID: CODEX_REMOTE_HOST_PROVIDER}
    return replace(
        request,
        model=intent.model_ref,
        provider_configuration=providers,
        launch_arguments=(
            *request.launch_arguments,
            CodexRuntimeLaunchArgument(
                option=CODEX_REMOTE_CONFIG_OPTION,
                value=f"model_provider={json.dumps(request.model_provider)}",
            ),
        ),
    )
