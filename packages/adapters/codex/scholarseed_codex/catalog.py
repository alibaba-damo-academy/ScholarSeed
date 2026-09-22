"""Bind one exact model and its approval reviewer before Codex starts."""

from __future__ import annotations

import asyncio
import copy
import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import httpx

from scholarseed_codex.environment import (
    CODEX_HOME_ENV,
    CODEX_REMOTE_CONFIG_OPTION,
    TEXT_ENCODING,
    store_model_catalog,
)
from scholarseed_codex.executable import discover_codex_executable
from scholarseed_codex.protocol.session import CodexRuntimeLaunchArgument, CodexSessionOpenRequest
from scholarseed_runtime.contract import ModelConnectionMode, ModelIntent, ModelToolProtocol

CATALOG_CONFIG_KEY = "model_catalog_json"
CATALOG_TIMEOUT_SECONDS = 30
CATALOG_ERROR = "runtime_model_catalog_unavailable"
MODEL_NOT_FOUND_ERROR = "runtime_model_catalog_model_missing"
SHELL_TYPE = "unified_exec"
MODEL_VISIBILITY = "list"
MODEL_PRIORITY = 0
TRUNCATION_MODE = "bytes"
TRUNCATION_LIMIT = 10000
DIRECT_TOOL_MODE = "direct"
TEXT_MODALITY = "text"
SUPPORTED_MODALITIES = frozenset({TEXT_MODALITY, "image", "audio"})
PRODUCT_FILE_MODALITIES = frozenset({"pdf", "video"})
MODALITIES_ERROR = "runtime_model_catalog_modalities_unsupported"
NATIVE_MODEL_NAMESPACE_SEPARATOR = "/"
MODELS_SUFFIX = "/models"


def standard_model(intent: ModelIntent, base_instructions: str) -> dict[str, Any]:
    capabilities = intent.capabilities
    modalities = capabilities.input_modalities
    if modalities is not None and not set(modalities).issubset(
        SUPPORTED_MODALITIES | PRODUCT_FILE_MODALITIES
    ):
        raise ValueError(MODALITIES_ERROR)
    model: dict[str, Any] = {
        "slug": intent.model_ref,
        "display_name": intent.model_ref,
        "base_instructions": base_instructions,
        "supported_reasoning_levels": [
            {"effort": effort, "description": effort} for effort in capabilities.reasoning_efforts
        ],
        "default_reasoning_level": intent.reasoning_effort or None,
        "shell_type": SHELL_TYPE,
        "visibility": MODEL_VISIBILITY,
        "supported_in_api": True,
        "priority": MODEL_PRIORITY,
        "support_verbosity": False,
        "supports_reasoning_summary_parameter": False,
        "truncation_policy": {"mode": TRUNCATION_MODE, "limit": TRUNCATION_LIMIT},
        "experimental_supported_tools": [],
        "input_modalities": [
            value
            for value in (modalities if modalities is not None else (TEXT_MODALITY,))
            if value in SUPPORTED_MODALITIES
        ],
        "use_responses_lite": False,
        "tool_mode": DIRECT_TOOL_MODE,
        "apply_patch_tool_type": None,
        "auto_review_model_override": intent.model_ref,
    }
    if intent.context_window is not None:
        model["context_window"] = intent.context_window
        model["max_context_window"] = intent.context_window
    return model


def bind_native_model(catalog: dict[str, Any], model_ref: str) -> dict[str, Any]:
    if not isinstance(catalog, dict):
        raise ValueError(CATALOG_ERROR)
    models = catalog.get("models")
    if not isinstance(models, list) or not models:
        raise ValueError(CATALOG_ERROR)
    if any(
        not isinstance(row, dict) or not isinstance(row.get("slug"), str) or not row["slug"]
        for row in models
    ):
        raise ValueError(CATALOG_ERROR)
    if not model_ref:
        result = copy.deepcopy(catalog)
        for row in result["models"]:
            row["auto_review_model_override"] = row["slug"]
        return result
    candidates = [model_ref]
    if model_ref.count(NATIVE_MODEL_NAMESPACE_SEPARATOR) == 1:
        candidates.append(model_ref.split(NATIVE_MODEL_NAMESPACE_SEPARATOR, 1)[1])
    selected = None
    for candidate in candidates:
        matches = [
            row
            for row in models
            if isinstance(row, dict)
            and isinstance(row.get("slug"), str)
            and row["slug"]
            and candidate.startswith(row["slug"])
        ]
        if matches:
            selected = max(matches, key=lambda row: len(row["slug"]))
            break
    if selected is None:
        raise ValueError(f"{MODEL_NOT_FOUND_ERROR}: {model_ref}")
    result = copy.deepcopy(catalog)
    bound = copy.deepcopy(selected)
    bound["slug"] = model_ref
    bound["auto_review_model_override"] = model_ref
    result["models"] = [row for row in result["models"] if row.get("slug") != model_ref] + [bound]
    return result


async def native_catalog(request: CodexSessionOpenRequest) -> dict[str, Any]:
    executable = discover_codex_executable(request.executable)
    if not executable:
        raise ValueError(CATALOG_ERROR)
    environment = {
        key: value for key, value in os.environ.items() if key not in request.remove_environment
    }
    environment.update(request.process_environment)
    arguments = ("debug", "models")
    process = await asyncio.create_subprocess_exec(
        executable,
        *arguments,
        cwd=request.cwd,
        env=environment,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    communication = asyncio.create_task(process.communicate())
    try:
        stdout, stderr = await asyncio.wait_for(
            asyncio.shield(communication), CATALOG_TIMEOUT_SECONDS
        )
    except BaseException:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await asyncio.shield(communication)
        raise
    if process.returncode:
        raise ValueError(f"{CATALOG_ERROR}: exit {process.returncode}")
    try:
        catalog = json.loads(stdout)
    except (ValueError, UnicodeDecodeError):
        raise ValueError(CATALOG_ERROR) from None
    if not isinstance(catalog, dict):
        raise ValueError(CATALOG_ERROR)
    return catalog


async def model_catalog_argument(
    intent: ModelIntent, request: CodexSessionOpenRequest
) -> CodexRuntimeLaunchArgument:
    if intent.capabilities.tool_protocol is ModelToolProtocol.JSON_SCHEMA:
        if not intent.model_ref:
            raise ValueError(MODEL_NOT_FOUND_ERROR)
        catalog = {"models": [standard_model(intent, request.base_instructions)]}
    else:
        if intent.transport.mode is ModelConnectionMode.REMOTE:
            async with httpx.AsyncClient(
                timeout=CATALOG_TIMEOUT_SECONDS, trust_env=False
            ) as client:
                providers_value = request.thread_config.get("model_providers")
                providers = providers_value if isinstance(providers_value, Mapping) else {}
                provider_value = providers.get(request.model_provider)
                provider = provider_value if isinstance(provider_value, Mapping) else {}
                header_value = provider.get("env_http_headers")
                environment_headers = header_value if isinstance(header_value, Mapping) else {}
                headers = {
                    name: request.process_environment[environment_name]
                    for name, environment_name in environment_headers.items()
                    if isinstance(name, str)
                    and isinstance(environment_name, str)
                    and environment_name in request.process_environment
                }
                environment_key = provider.get("env_key")
                api_key = (
                    request.process_environment.get(environment_key, "")
                    if isinstance(environment_key, str)
                    else ""
                )
                if api_key:
                    headers["Authorization"] = f"Bearer {api_key}"
                response = await client.get(
                    intent.transport.endpoint.rstrip("/") + MODELS_SUFFIX, headers=headers
                )
                response.raise_for_status()
                source = response.json()
        else:
            source = await native_catalog(request)
        catalog = bind_native_model(source, intent.model_ref)
    payload = json.dumps(catalog, ensure_ascii=False, sort_keys=True).encode(TEXT_ENCODING)
    path = store_model_catalog(Path(request.process_environment[CODEX_HOME_ENV]), payload)
    return CodexRuntimeLaunchArgument(
        option=CODEX_REMOTE_CONFIG_OPTION,
        value=f"{CATALOG_CONFIG_KEY}={json.dumps(str(path))}",
    )
