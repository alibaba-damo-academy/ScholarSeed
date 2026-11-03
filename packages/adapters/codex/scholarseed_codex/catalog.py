"""Compile immutable execution catalogs from per-model protocol declarations."""

from __future__ import annotations

import copy
import json
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from scholarseed_codex.command import run_command
from scholarseed_codex.environment import (
    CODEX_HOME_ENV,
    CODEX_REMOTE_AUTH_CONFIG,
    CODEX_REMOTE_CONFIG_OPTION,
    TEXT_ENCODING,
    store_model_catalog,
)
from scholarseed_codex.executable import discover_codex_executable
from scholarseed_codex.protocol.session import CodexRuntimeLaunchArgument, CodexSessionOpenRequest
from scholarseed_runtime.contract import (
    MODEL_CATALOG_UNAVAILABLE,
    ModelCatalogEntry,
    ModelConnectionMode,
    ModelIntent,
    ModelToolProtocol,
)

CATALOG_CONFIG_KEY = "model_catalog_json"
CATALOG_TIMEOUT_SECONDS = 30
MODEL_NOT_FOUND_ERROR = "runtime_model_catalog_model_missing"
CATALOG_CONFLICT_ERROR = "runtime_model_catalog_conflicting_definition"
SHELL_TYPE = "unified_exec"
MODEL_VISIBILITY = "list"
MODEL_PRIORITY = 0
MODEL_TEMPLATE_INSTRUCTIONS = ""
TRUNCATION_MODE = "bytes"
TRUNCATION_LIMIT = 10000
DIRECT_TOOL_MODE = "direct"
TEXT_MODALITY = "text"
SUPPORTED_MODALITIES = frozenset({TEXT_MODALITY, "image", "audio"})
PRODUCT_FILE_MODALITIES = frozenset({"pdf", "video"})
MODALITIES_ERROR = "runtime_model_catalog_modalities_unsupported"
NATIVE_MODEL_NAMESPACE_SEPARATOR = "/"
MODELS_SUFFIX = "/models"
CODEX_CATALOG_PROVIDER_ID = "openai"
MULTI_AGENT_VERSION_KEY = "multi_agent_version"
LOCAL_MULTI_AGENT_VERSION = "v1"


class CatalogPreflightError(RuntimeError):
    """A remote catalog HTTP request failed before execution-host admission."""


@dataclass(frozen=True)
class ModelCatalogSnapshot:
    path: Path
    document: bytes
    required_models: tuple[str, ...]
    entries: tuple[ModelCatalogEntry, ...] = ()

    @property
    def argument(self) -> CodexRuntimeLaunchArgument:
        return CodexRuntimeLaunchArgument(
            option=CODEX_REMOTE_CONFIG_OPTION,
            value=f"{CATALOG_CONFIG_KEY}={json.dumps(str(self.path))}",
        )

    def covers(self, candidate: ModelCatalogSnapshot) -> bool:
        if not candidate.required_models:
            return self.document == candidate.document
        current = {row["slug"]: row for row in json.loads(self.document)["models"]}
        requested = {row["slug"]: row for row in json.loads(candidate.document)["models"]}
        return all(
            model in current and current[model] == requested[model]
            for model in candidate.required_models
        )

    def declares(self, intent: ModelIntent) -> bool:
        entries, required = declared_models(intent)
        current = {entry.model_ref: entry for entry in self.entries}
        return bool(entries) and all(current.get(model) == entries[model] for model in required)


def declared_models(intent: ModelIntent) -> tuple[dict[str, ModelCatalogEntry], set[str]]:
    entries: dict[str, ModelCatalogEntry] = {}
    for entry in intent.catalog_models:
        if not entry.model_ref:
            raise ValueError(MODEL_NOT_FOUND_ERROR)
        previous = entries.setdefault(entry.model_ref, entry)
        if previous != entry:
            raise ValueError(f"{CATALOG_CONFLICT_ERROR}: {entry.model_ref}")
    required: set[str] = set()
    if entries:
        if not intent.model_ref or intent.model_ref not in entries:
            raise ValueError(f"{MODEL_NOT_FOUND_ERROR}: {intent.model_ref}")
        for entry in entries.values():
            if entry.approval_model_ref and entry.approval_model_ref not in entries:
                raise ValueError(f"{MODEL_NOT_FOUND_ERROR}: {entry.approval_model_ref}")
        if intent.approval_model_ref != entries[intent.model_ref].approval_model_ref:
            raise ValueError(f"{CATALOG_CONFLICT_ERROR}: {intent.model_ref}")
        model = intent.model_ref
        while model not in required:
            required.add(model)
            model = entries[model].approval_model_ref or model
    return entries, required


def standard_model(entry: ModelCatalogEntry) -> dict[str, Any]:
    capabilities = entry.capabilities
    modalities = capabilities.input_modalities
    if modalities is not None and not set(modalities).issubset(
        SUPPORTED_MODALITIES | PRODUCT_FILE_MODALITIES
    ):
        raise ValueError(MODALITIES_ERROR)
    model: dict[str, Any] = {
        "slug": entry.model_ref,
        "display_name": entry.model_ref,
        "base_instructions": MODEL_TEMPLATE_INSTRUCTIONS,
        "supported_reasoning_levels": [
            {"effort": effort, "description": effort} for effort in capabilities.reasoning_efforts
        ],
        "default_reasoning_level": None,
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
        "auto_review_model_override": entry.approval_model_ref or entry.model_ref,
    }
    if entry.context_window is not None:
        model["context_window"] = entry.context_window
        model["max_context_window"] = entry.context_window
    return model


def bind_native_models(
    catalog: dict[str, Any],
    model_refs: tuple[str, ...],
    selected_model: str,
    approval_model_ref: str = "",
) -> dict[str, Any]:
    if not isinstance(catalog, dict):
        raise ValueError(MODEL_CATALOG_UNAVAILABLE)
    models = catalog.get("models")
    if not isinstance(models, list) or not models:
        raise ValueError(MODEL_CATALOG_UNAVAILABLE)
    if any(
        not isinstance(row, dict) or not isinstance(row.get("slug"), str) or not row["slug"]
        for row in models
    ):
        raise ValueError(MODEL_CATALOG_UNAVAILABLE)
    definitions: dict[str, dict[str, Any]] = {}
    for row in models:
        previous = definitions.setdefault(row["slug"], row)
        if previous != row:
            raise ValueError(f"{CATALOG_CONFLICT_ERROR}: {row['slug']}")
    models = list(definitions.values())
    result = copy.deepcopy(catalog)
    result["models"] = copy.deepcopy(models)
    for row in result["models"]:
        row["auto_review_model_override"] = approval_model_ref or row["slug"]
    known = {row["slug"] for row in result["models"]}
    for model_ref in sorted(set(model_refs)):
        if not model_ref:
            continue
        if model_ref in known:
            continue
        candidates = [model_ref]
        if model_ref.count(NATIVE_MODEL_NAMESPACE_SEPARATOR) == 1:
            candidates.append(model_ref.split(NATIVE_MODEL_NAMESPACE_SEPARATOR, 1)[1])
        selected = None
        for candidate in candidates:
            matches = [row for row in models if candidate.startswith(row["slug"])]
            if matches:
                selected = max(matches, key=lambda row: len(row["slug"]))
                break
        if selected is None:
            if model_ref == selected_model:
                raise ValueError(f"{MODEL_NOT_FOUND_ERROR}: {model_ref}")
            continue
        bound = copy.deepcopy(selected)
        bound["slug"] = model_ref
        bound["auto_review_model_override"] = approval_model_ref or model_ref
        result["models"].append(bound)
    if selected_model and selected_model not in {row["slug"] for row in result["models"]}:
        raise ValueError(f"{MODEL_NOT_FOUND_ERROR}: {selected_model}")
    return result


async def native_catalog(request: CodexSessionOpenRequest) -> dict[str, Any]:
    executable = discover_codex_executable(request.executable)
    if not executable:
        raise ValueError(MODEL_CATALOG_UNAVAILABLE)
    environment = {
        key: value for key, value in os.environ.items() if key not in request.remove_environment
    }
    environment.update(request.process_environment)
    arguments = (
        "debug",
        "models",
        CODEX_REMOTE_CONFIG_OPTION,
        f"model_provider={json.dumps(request.model_provider or CODEX_CATALOG_PROVIDER_ID)}",
        CODEX_REMOTE_CONFIG_OPTION,
        CODEX_REMOTE_AUTH_CONFIG,
    )
    code, stdout, _ = await run_command(
        executable,
        *arguments,
        cwd=request.cwd,
        environment=environment,
        timeout=CATALOG_TIMEOUT_SECONDS,
    )
    if code:
        raise ValueError(f"{MODEL_CATALOG_UNAVAILABLE}: exit {code}")
    try:
        catalog = json.loads(stdout)
    except (ValueError, UnicodeDecodeError):
        raise ValueError(MODEL_CATALOG_UNAVAILABLE) from None
    if not isinstance(catalog, dict):
        raise ValueError(MODEL_CATALOG_UNAVAILABLE)
    return catalog


async def model_catalog_argument(
    intent: ModelIntent,
    request: CodexSessionOpenRequest,
    *,
    native: Callable[[CodexSessionOpenRequest], Awaitable[dict[str, Any]]] | None = None,
    select: Callable[[ModelCatalogSnapshot], Awaitable[CodexRuntimeLaunchArgument]] | None = None,
) -> CodexRuntimeLaunchArgument:
    entries, required = declared_models(intent)
    native_required = (
        any(
            entry.capabilities.tool_protocol is ModelToolProtocol.PROVIDER_NATIVE
            for entry in entries.values()
        )
        if entries
        else intent.capabilities.tool_protocol is ModelToolProtocol.PROVIDER_NATIVE
    )
    source: dict[str, Any] | None = None
    if native_required:
        if intent.transport.mode is ModelConnectionMode.REMOTE:
            failure: httpx.HTTPError | None = None
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
                try:
                    response = await client.get(
                        intent.transport.endpoint.rstrip("/") + MODELS_SUFFIX, headers=headers
                    )
                    response.raise_for_status()
                except httpx.HTTPError as error:
                    failure = error
                else:
                    source = response.json()
            if failure is not None:
                raise CatalogPreflightError(MODEL_CATALOG_UNAVAILABLE) from failure
        else:
            source = await (native or native_catalog)(request)
    if entries:
        models: list[dict[str, Any]] = []
        native_models: dict[str, dict[str, Any]] = {}
        if source is not None:
            bound = bind_native_models(
                source,
                tuple(
                    entry.model_ref
                    for entry in entries.values()
                    if entry.capabilities.tool_protocol is ModelToolProtocol.PROVIDER_NATIVE
                ),
                "",
            )
            native_models = {row["slug"]: row for row in bound["models"]}
        for entry in sorted(entries.values(), key=lambda item: item.model_ref):
            if entry.capabilities.tool_protocol is ModelToolProtocol.JSON_SCHEMA:
                models.append(standard_model(entry))
                continue
            if entry.model_ref not in native_models:
                raise ValueError(f"{MODEL_NOT_FOUND_ERROR}: {entry.model_ref}")
            row = copy.deepcopy(native_models[entry.model_ref])
            row["auto_review_model_override"] = entry.approval_model_ref or entry.model_ref
            models.append(row)
        catalog = {"models": models}
    elif source is not None:
        catalog = bind_native_models(
            source,
            (intent.model_ref,),
            intent.model_ref,
            intent.approval_model_ref,
        )
        if intent.model_ref:
            required.add(intent.model_ref)
        if intent.approval_model_ref:
            required.add(intent.approval_model_ref)
    else:
        if not intent.model_ref:
            raise ValueError(MODEL_NOT_FOUND_ERROR)
        if intent.approval_model_ref and intent.approval_model_ref != intent.model_ref:
            raise ValueError(f"{MODEL_NOT_FOUND_ERROR}: {intent.approval_model_ref}")
        catalog = {
            "models": [
                standard_model(
                    ModelCatalogEntry(
                        intent.model_ref,
                        intent.capabilities,
                        intent.context_window,
                        intent.approval_model_ref,
                    )
                )
            ]
        }
        required.add(intent.model_ref)
    for row in catalog["models"]:
        capabilities = entries[row["slug"]].capabilities if entries else intent.capabilities
        if capabilities.native_agent_messages is False:
            row[MULTI_AGENT_VERSION_KEY] = LOCAL_MULTI_AGENT_VERSION
    available = {row["slug"] for row in catalog["models"]}
    missing = required - available
    if missing:
        raise ValueError(f"{MODEL_NOT_FOUND_ERROR}: {sorted(missing)[0]}")
    payload = json.dumps(catalog, ensure_ascii=False, sort_keys=True).encode(TEXT_ENCODING)
    path = store_model_catalog(Path(request.process_environment[CODEX_HOME_ENV]), payload)
    snapshot = ModelCatalogSnapshot(path, payload, tuple(sorted(required)), tuple(entries.values()))
    return await select(snapshot) if select is not None else snapshot.argument
