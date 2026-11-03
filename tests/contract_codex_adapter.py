"""Deterministic contract checks for the Codex Runtime Gateway adapter."""

from __future__ import annotations

import ast
import asyncio
import gc
import json
import os
import stat
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from time import time
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

import httpx
from packaging.specifiers import SpecifierSet

import scholarseed_codex.catalog as catalog_module
import scholarseed_codex.command as command_module
import scholarseed_codex.environment as codex_environment
import scholarseed_codex.executable as codex_host
import scholarseed_codex.isolation as codex_isolation
import scholarseed_codex.pool as pool_module
import scholarseed_codex.provider as provider_module
from scholarseed_codex.activity import (
    CODEX_NATIVE_ACTIVITY_TEXT_LIMIT,
    NATIVE_BACKGROUND_TERMINALS_LIST_METHOD,
    NATIVE_BACKGROUND_TERMINALS_TERMINATE_METHOD,
    skill_for_command,
    subagent_item_summary,
    subagent_lifecycle_payload,
    subagent_status_payload,
    tool_item_payload,
    tool_item_result,
)
from scholarseed_codex.attachment import ThreadAttachment
from scholarseed_codex.capacity import (
    CapacityPolicy,
    HostRole,
)
from scholarseed_codex.catalog import (
    CatalogPreflightError,
    bind_native_models,
    model_catalog_argument,
    standard_model,
)
from scholarseed_codex.emitter import CodexEmitter
from scholarseed_codex.events import translate_event
from scholarseed_codex.failure import (
    CONTENT_SAFETY_BLOCKED,
    PROVIDER_AUTH_MESSAGE,
    PROVIDER_RATE_LIMIT_MESSAGE,
    PROVIDER_UNAVAILABLE_MESSAGE,
    authentication_failure,
    provider_codes,
    provider_failure,
)
from scholarseed_codex.input import skill_inputs, start_parameters
from scholarseed_codex.launch import model_connection
from scholarseed_codex.pool import CodexHostPool
from scholarseed_codex.process import (
    THREAD_CONFIGURATION_MISMATCH,
    CodexProcessHost,
    _confirmed_thread_model,
)
from scholarseed_codex.profile import (
    CODEX_ALLOW_DEVELOPMENT_VERSION_ENV,
    CODEX_PLAN_TOOL_ENABLED_CONFIG,
    native_web_search_supported,
    session_thread_config,
)
from scholarseed_codex.protocol.mcp import McpControlCapabilities, McpSnapshot, McpToolCallResult
from scholarseed_codex.protocol.session import (
    CODEX_DEFAULT_TURN_TIMEOUT_SECONDS,
    CodexRuntimeLaunchArgument,
    CodexRuntimeReadiness,
    CodexRuntimeStatus,
    CodexSessionEvent,
    CodexSessionEventKind,
    CodexSessionOpenRequest,
)
from scholarseed_codex.protocol.state import AppServerError, CodexProcessState
from scholarseed_codex.provider import (
    _resolve_launch_secrets,
    provider,
)
from scholarseed_codex.router import AgentRoute, ThreadRouter
from scholarseed_codex.rpc import JsonLineWriter
from scholarseed_codex.session import CodexRuntimeSession, _same_process_configuration
from scholarseed_codex.skill import session_skill_config, session_skill_inventory
from scholarseed_codex.thread import CodexThreadSession
from scholarseed_codex.turn import CodexTurnRuntime
from scholarseed_codex.watch import WorkspaceWatch
from scholarseed_runtime.contract import (
    MODEL_CATALOG_UNAVAILABLE,
    ActorKind,
    CallbackAudience,
    CallbackKind,
    CapabilitySet,
    CapabilityState,
    CommandState,
    DeliveryClass,
    InventoryKind,
    InventoryRequest,
    LaunchSecret,
    LaunchSecretIntent,
    LaunchSecretScope,
    ModelCapabilities,
    ModelCatalogEntry,
    ModelConnectionMode,
    ModelCredential,
    ModelIntent,
    ModelToolProtocol,
    ModelTransport,
    ModelWireProtocol,
    OpenSessionRequest,
    PermissionIntent,
    ResumeSessionRequest,
    RuntimeBinding,
    RuntimeCallbackRequest,
    RuntimeCapabilityName,
    RuntimeConfigurationIntent,
    RuntimeControlKind,
    RuntimeControlRequest,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeInspectionRequest,
    RuntimePermissionMode,
    RuntimeSecret,
    RuntimeServiceTool,
    SkillPolicy,
    TurnRequest,
)
from scholarseed_runtime.contract.command import (
    HostWarmupRequest,
    SkillConfiguration,
    SkillConfigurationRequest,
)
from scholarseed_runtime.contract.content import (
    PUBLIC_REASONING_SUMMARY,
    REASONING_SOURCE,
    REASONING_SUMMARY_INDEX,
)
from scholarseed_runtime.contract.evidence import (
    RuntimeProcessEvent,
    RuntimeProcessEventKind,
    RuntimeRpcEvidence,
)
from scholarseed_runtime.contract.history import HistoryEntry, MessagePhase
from scholarseed_runtime.contract.incident import (
    RUNTIME_TURN_NOT_SUBMITTED,
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.input import (
    TURN_ADMISSION_STALE,
    CollaborationMode,
    InputItem,
    InputKind,
    TurnAdmission,
    TurnInput,
)
from scholarseed_runtime.contract.inventory import (
    ModelInventory,
    SkillAvailability,
    SkillInventory,
    SkillView,
)
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    ResourcePurpose,
    ResourceRequest,
    ResourceState,
)
from tests.contract_codex_capacity import ControlledHost

PASS = 0
FAIL = 0
ROOT = Path(__file__).resolve().parents[1]
ADAPTER_ROOT = ROOT / "packages" / "adapters" / "codex" / "scholarseed_codex"
TEST_POOL_CAPACITY = 2
TEST_WAIT_SECONDS = 5.0
EXPECTED_TURN_TIMEOUT_SECONDS = 12 * 60 * 60


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def test_event_translation() -> None:
    print("== Codex event translation ==")
    source = CodexSessionEvent(
        runtime_id="codex",
        session_id="native-session",
        kind=CodexSessionEventKind.ASSISTANT_DELTA,
        turn_id="native-turn",
        item_id="native-item",
        vendor_seq=7,
        payload={"delta": "hello"},
    )
    translated = translate_event(source, product_session_id="product-session", process_generation=2)
    check("assistant delta becomes a RuntimeEvent", isinstance(translated, RuntimeEvent))
    if isinstance(translated, RuntimeEvent):
        check("assistant delta has stable kind", translated.kind is RuntimeEventKind.CONTENT_DELTA)
        check("delta is explicitly coalescible", translated.delivery is DeliveryClass.COALESCIBLE)
        check(
            "product and native identities remain distinct",
            translated.product_session_id == "product-session"
            and translated.native_session_id == "native-session",
        )


@patch(
    "scholarseed_codex.pool.CodexHostPool.model_catalog_argument",
    new_callable=AsyncMock,
    return_value=CodexRuntimeLaunchArgument(option="-c", value='model_catalog_json="fixture"'),
)
def test_plan_projection(_catalog: AsyncMock) -> None:
    print("== Codex plan configuration and events ==")

    async def native_config() -> dict:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="native-plan-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        await session._apply_model_connection()
        return dict(session._native.request.thread_config)

    check(
        "native sessions enable upstream plan tool",
        asyncio.run(native_config()).get("tools.update_plan.enabled") is True,
    )
    check(
        "native sessions enable structured input in default mode",
        asyncio.run(native_config()).get("features.default_mode_request_user_input") is True,
    )
    for todos in (
        [
            {"content": "read", "status": "completed"},
            {"content": "compare", "status": "in_progress"},
            {"content": "report", "status": "pending"},
        ],
        [],
    ):
        payload = {"todos": todos, "explanation": "updated plan"}
        event = translate_event(
            CodexSessionEvent(
                runtime_id="codex",
                session_id="native-plan-session",
                kind=CodexSessionEventKind.PLAN_UPDATED,
                turn_id="plan-turn",
                vendor_seq=8,
                payload=payload,
            ),
            product_session_id="product-plan-session",
            process_generation=2,
        )
        check(
            "plan snapshots preserve replacement content and owner, including empty plans",
            isinstance(event, RuntimeEvent)
            and event.kind is RuntimeEventKind.PLAN_UPDATED
            and event.native_turn_id == "plan-turn"
            and event.payload == payload,
        )


def test_turn_timeout_projection() -> None:
    print("== Codex turn timeout ==")
    native = CodexSessionOpenRequest(request_id="timeout", runtime_id="codex", cwd=ROOT)
    session = CodexRuntimeSession(
        OpenSessionRequest(
            product_session_id="timeout",
            cwd=ROOT,
            model=ModelIntent(
                transport=ModelTransport(
                    endpoint="https://model.example.test/v1", supports_websockets=True
                )
            ),
        )
    )
    check(
        "adapter default is twelve hours",
        CODEX_DEFAULT_TURN_TIMEOUT_SECONDS == EXPECTED_TURN_TIMEOUT_SECONDS,
    )
    check(
        "native requests inherit the adapter default",
        native.timeout_seconds == EXPECTED_TURN_TIMEOUT_SECONDS,
    )
    check(
        "product sessions project the adapter default without a Serve override",
        session._native.request.timeout_seconds == EXPECTED_TURN_TIMEOUT_SECONDS,
    )


def test_callback_translation() -> None:
    print("== Codex callback translation ==")
    source = CodexSessionEvent(
        runtime_id="codex",
        session_id="native-session",
        kind=CodexSessionEventKind.HIL_REQUESTED,
        turn_id="native-turn",
        vendor_seq=8,
        payload={
            "request_id": "public-request",
            "method": "item/commandExecution/requestApproval",
            "title": "Approval",
            "options": [{"id": "accept", "label": "Allow once"}],
        },
    )
    translated = translate_event(source, product_session_id="product-session", process_generation=2)
    check("server request becomes a callback", isinstance(translated, RuntimeCallbackRequest))
    if isinstance(translated, RuntimeCallbackRequest):
        check("approval callback stays typed", translated.kind is CallbackKind.COMMAND_APPROVAL)
        check("callback keeps public correlator", translated.request_id == "public-request")
        check("approval stays user-facing", translated.audience is CallbackAudience.USER)
    clarification = translate_event(
        replace(source, payload={**source.payload, "method": "item/tool/requestUserInput"}),
        product_session_id="product-session",
        process_generation=2,
    )
    check(
        "clarification becomes a user callback rather than runtime extension",
        isinstance(clarification, RuntimeCallbackRequest)
        and clarification.kind is CallbackKind.USER_INPUT
        and clarification.audience is CallbackAudience.USER,
    )
    dynamic = translate_event(
        replace(source, kind=CodexSessionEventKind.DYNAMIC_TOOL_REQUESTED),
        product_session_id="product-session",
        process_generation=2,
    )
    check(
        "dynamic tools keep their independent service callback",
        isinstance(dynamic, RuntimeCallbackRequest)
        and dynamic.kind is CallbackKind.DYNAMIC_TOOL
        and dynamic.audience is CallbackAudience.SERVICE,
    )


def test_subagent_translation() -> None:
    print("== Codex subagent translation ==")
    source = CodexSessionEvent(
        runtime_id="codex",
        session_id="native-parent",
        kind=CodexSessionEventKind.NATIVE_ACTIVITY_STARTED,
        turn_id="native-turn",
        item_id="collab-item:child-thread",
        vendor_seq=9,
        payload={
            "activity_type": "subagent_activity",
            "category": "collaboration",
            "status": "running",
            "details": {
                "agent_thread_id": "child-thread",
                "agent_path": "reviewer",
            },
        },
    )
    translated = translate_event(source, product_session_id="product-session", process_generation=2)
    check(
        "collaboration activity becomes a typed subagent lifecycle event",
        isinstance(translated, RuntimeEvent)
        and translated.kind is RuntimeEventKind.SUBAGENT_STARTED,
    )
    if isinstance(translated, RuntimeEvent):
        check(
            "subagent identity and parent relation are explicit",
            translated.actor_kind is ActorKind.SUBAGENT
            and translated.actor_id == "child-thread"
            and translated.parent_actor_id == "native-parent"
            and isinstance(translated.payload, dict)
            and translated.payload.get("root_turn_id") == "native-turn",
        )

    dispatch_completed = translate_event(
        CodexSessionEvent(
            runtime_id="codex",
            session_id="native-parent",
            kind=CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED,
            turn_id="native-turn",
            item_id="collab-item:child-thread",
            vendor_seq=10,
            payload={
                "activity_type": "subagent_activity",
                "category": "collaboration",
                "status": "completed",
                "ok": True,
                "details": {
                    "activity": "started",
                    "agent_thread_id": "child-thread",
                    "agent_path": "reviewer",
                },
            },
        ),
        product_session_id="product-session",
        process_generation=2,
    )
    check(
        "a completed spawn call keeps the child running until its terminal observation",
        isinstance(dispatch_completed, RuntimeEvent)
        and dispatch_completed.kind is RuntimeEventKind.SUBAGENT_STARTED
        and isinstance(dispatch_completed.payload, dict)
        and dispatch_completed.payload.get("status") == "running",
    )

    collaboration = translate_event(
        CodexSessionEvent(
            runtime_id="codex",
            session_id="native-parent",
            kind=CodexSessionEventKind.NATIVE_ACTIVITY_STARTED,
            turn_id="native-turn",
            item_id="collab-call:child-thread",
            vendor_seq=10,
            payload={
                "activity_type": "agent_collaboration",
                "category": "collaboration",
                "status": "running",
                "details": {
                    "operation": "wait_agent",
                    "receiver_thread_ids": ["child-thread"],
                },
            },
        ),
        product_session_id="product-session",
        process_generation=2,
    )
    check(
        "a collaboration tool call remains a native activity instead of impersonating agent state",
        isinstance(collaboration, RuntimeEvent)
        and collaboration.kind is RuntimeEventKind.RUNTIME_EXTENSION
        and collaboration.actor_kind is ActorKind.MAIN
        and not collaboration.actor_id,
    )


def test_extension_and_incident_are_lossless() -> None:
    print("== extension and incident preservation ==")
    skills = translate_event(
        CodexSessionEvent(
            runtime_id="codex",
            session_id="native-session",
            kind=CodexSessionEventKind.SKILLS_CHANGED,
            vendor_seq=8,
        ),
        product_session_id="product-session",
        process_generation=2,
    )
    check(
        "skill inventory changes have a runtime-neutral passive event",
        isinstance(skills, RuntimeEvent)
        and skills.kind is RuntimeEventKind.SKILLS_CHANGED
        and not skills.native_turn_id,
    )
    warning = CodexSessionEvent(
        runtime_id="codex",
        session_id="native-session",
        kind=CodexSessionEventKind.RUNTIME_WARNING,
        vendor_seq=8,
        payload={"message": "startup advisory"},
    )
    normalized = translate_event(
        warning, product_session_id="product-session", process_generation=2
    )
    unknown = translate_event(
        replace(
            warning, payload={"reason": "unsupported_notification", "rpc_method": "future/method"}
        ),
        product_session_id="product-session",
        process_generation=2,
    )
    check(
        "recognized native advisory is passive but unsupported notifications remain opaque",
        normalized.kind is RuntimeEventKind.RUNTIME_WARNING
        and unknown.kind is RuntimeEventKind.RUNTIME_EXTENSION,
    )
    extension = translate_event(
        CodexSessionEvent(
            runtime_id="codex",
            session_id="native-session",
            kind=CodexSessionEventKind.WEB_SEARCH_STARTED,
            vendor_seq=9,
            payload={"query": "adapter protocols"},
        ),
        product_session_id="product-session",
        process_generation=2,
    )
    check(
        "unstandardized event is namespaced as an extension",
        isinstance(extension, RuntimeEvent)
        and extension.kind is RuntimeEventKind.RUNTIME_EXTENSION
        and isinstance(extension.payload, dict)
        and extension.payload.get("extension_kind") == "web_search_started",
    )
    incident = RuntimeIncident(
        incident_id="incident-1",
        scope=RuntimeIncidentScope.PROVIDER,
        state=RuntimeIncidentState.RETRYING,
        kind=RuntimeIncidentKind.PROVIDER_RETRY,
        strategy=RuntimeRecoveryStrategy.VENDOR_RETRY,
        retryability=RuntimeRetryability.IN_PROGRESS,
        safe_error="provider_retrying",
        process_generation=2,
        attempt=1,
        max_attempts=5,
    )
    translated = translate_event(
        CodexSessionEvent(
            runtime_id="codex",
            session_id="native-session",
            kind=CodexSessionEventKind.RUNTIME_INCIDENT,
            vendor_seq=10,
            incident=incident,
        ),
        product_session_id="product-session",
        process_generation=2,
    )
    check(
        "normalized incident keeps recovery evidence",
        isinstance(translated, RuntimeEvent)
        and isinstance(translated.payload, dict)
        and isinstance(translated.payload.get("incident"), dict)
        and translated.payload["incident"].get("incident_id") == "incident-1"
        and translated.payload["incident"].get("attempt") == 1,
    )


def test_dependency_direction() -> None:
    print("== adapter dependency direction ==")
    violations: list[str] = []
    for path in ADAPTER_ROOT.rglob("*.py"):
        if any(part in {"build", "__pycache__"} for part in path.parts):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            module = ""
            if isinstance(node, ast.ImportFrom):
                module = node.module or ""
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name == "service" or alias.name.startswith("service."):
                        violations.append(f"{path.relative_to(ROOT)}:{node.lineno}")
            if module == "service" or module.startswith("service."):
                violations.append(f"{path.relative_to(ROOT)}:{node.lineno}")
    check("Codex adapter never imports Serve", not violations, str(violations))


def test_capability_truthfulness() -> None:
    print("== Codex capability truthfulness ==")
    states = {row.name: row.state for row in provider().descriptor.capabilities.entries}
    check("implemented interrupt is supported", states["interrupt"] is CapabilityState.SUPPORTED)
    check("official thread resume is supported", states["resume"] is CapabilityState.SUPPORTED)
    check("unimplemented fork is unsupported", states["fork"] is CapabilityState.UNSUPPORTED)
    check(
        "enabled native plan snapshots are advertised",
        states["plan_snapshot"] is CapabilityState.SUPPORTED,
    )
    check(
        "implemented collaboration modes are advertised",
        states["collaboration_modes"] is CapabilityState.SUPPORTED,
    )
    check(
        "implemented App Server inventories are advertised",
        states["model_inventory"] is CapabilityState.SUPPORTED
        and states["skill_inventory"] is CapabilityState.SUPPORTED
        and states["mcp_inventory"] is CapabilityState.SUPPORTED,
    )


def test_development_version_policy() -> None:
    print("== development version policy ==")

    async def preflight(_executable: str, *args: str, **kwargs) -> tuple[int, str]:
        if args == ("--version",):
            return 0, "codex-cli 0.0.0"
        return 0, "Logged in using ChatGPT"

    async def scenario() -> tuple[object, object]:
        executable = str(ROOT / "reviewed-development-codex")
        with (
            patch.object(codex_host, "discover_codex_executable", return_value=executable),
            patch.object(codex_host, "_preflight_command", side_effect=preflight),
            patch.dict(codex_host.os.environ, {}, clear=False),
        ):
            codex_host.os.environ.pop(CODEX_ALLOW_DEVELOPMENT_VERSION_ENV, None)
            rejected = await codex_host._probe_codex_cli_readiness(executable)
            codex_host.os.environ[CODEX_ALLOW_DEVELOPMENT_VERSION_ENV] = "1"
            allowed = await codex_host._probe_codex_cli_readiness(executable)
        return rejected, allowed

    rejected, allowed = asyncio.run(scenario())
    check(
        "0.0.0 remains incompatible without explicit developer consent",
        rejected.status is CodexRuntimeStatus.INCOMPATIBLE
        and rejected.safe_error == codex_host.CODEX_VERSION_INCOMPATIBLE_ERROR,
    )
    check(
        "the documented development-only switch admits a reviewed 0.0.0 build",
        allowed.status is CodexRuntimeStatus.READY
        and allowed.ready
        and allowed.authenticated is None,
    )


def test_version_compatibility() -> None:
    print("== shared version compatibility policy ==")
    advertised = SpecifierSet(provider().descriptor.runtime_version_range)

    async def scenario() -> None:
        for version, ready, warning in (
            ("0.146.9", False, False),
            ("0.147.0", False, False),
            ("0.149.0", False, False),
            ("0.158.9", False, False),
            ("0.159.0", True, False),
            ("0.160.0", True, True),
            ("unparseable", False, False),
        ):
            calls: list[tuple[str, ...]] = []

            async def preflight(
                _executable: str, *args: str, _calls=calls, _version=version, **kwargs
            ) -> tuple[int, str]:
                _calls.append(args)
                return 0, (
                    f"codex-cli {_version}\r\n"
                    if args == ("--version",)
                    else "Logged in using ChatGPT\r\n"
                )

            with (
                patch.object(codex_host, "discover_codex_executable", return_value="codex"),
                patch.object(codex_host, "_preflight_command", side_effect=preflight),
            ):
                result = await codex_host._probe_codex_cli_readiness("codex")
            check(f"{version}: readiness", result.ready is ready)
            if not ready:
                check(
                    f"{version}: rejection reason",
                    result.status is CodexRuntimeStatus.INCOMPATIBLE
                    and result.safe_error
                    == (
                        codex_host.CODEX_VERSION_UNPARSEABLE_ERROR
                        if version == "unparseable"
                        else codex_host.CODEX_VERSION_INCOMPATIBLE_ERROR
                    ),
                )
            check(
                f"{version}: warning",
                result.warning == (codex_host.CODEX_UNTESTED_VERSION_WARNING if warning else ""),
            )
            check(
                f"{version}: auth admission",
                calls == ([("--version",)]),
            )
            if version != "unparseable":
                check(f"{version}: descriptor matches preflight", (version in advertised) is ready)

        with (
            patch.dict(codex_host.os.environ, {CODEX_ALLOW_DEVELOPMENT_VERSION_ENV: "1"}),
            patch.object(codex_host, "discover_codex_executable", return_value="codex"),
            patch.object(
                codex_host,
                "_preflight_command",
                new_callable=AsyncMock,
                return_value=(0, "codex-cli 0.146.9"),
            ) as preflight,
        ):
            result = await codex_host._probe_codex_cli_readiness("codex")
        check(
            "development switch cannot admit ordinary old versions",
            result.status is CodexRuntimeStatus.INCOMPATIBLE and preflight.await_count == 1,
        )

    asyncio.run(scenario())


def test_remote_authentication_independence() -> None:
    print("== no personal Codex authentication ==")
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        home, personal = root / "runtime", root / "personal"
        personal.mkdir()
        (personal / "auth.json").write_text('{"fixture":"never-import"}')
        (personal / "config.toml").write_text('model_provider="personal"')
        original_open = Path.open

        def guarded_open(path, *args, **kwargs):
            if path.parent == personal or path.name == "auth.json":
                raise AssertionError("credential source accessed")
            return original_open(path, *args, **kwargs)

        with (
            patch.dict(
                os.environ,
                {
                    "SCHOLARSEED_CODEX_HOME": str(home),
                    "SCHOLARSEED_CODEX_SOURCE_HOME": str(personal),
                    "CODEX_HOME": str(personal),
                },
            ),
            patch.object(Path, "open", guarded_open),
        ):
            session = CodexRuntimeSession(
                OpenSessionRequest(
                    product_session_id="remote-session",
                    cwd=root,
                    process_sharing_scope="owner",
                    model=ModelIntent(
                        model_ref="model",
                        capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                        transport=ModelTransport(endpoint="http://127.0.0.1:8770/v1"),
                    ),
                )
            )
            asyncio.run(session._apply_model_connection())
            check("no credential copied", not (home / "auth.json").exists())
            check("no personal configuration copied", not (home / "config.toml").exists())
            check(
                "thread storage retained",
                Path(session._native.request.process_environment["CODEX_HOME"]) == home.resolve(),
            )
            check(
                "owner context retained", session._native.request.process_sharing_scope == "owner"
            )
        legacy = home / "auth.json"
        legacy.write_text('{"fixture":"existing-unused"}')
        state = home / "state.sqlite"
        state.write_bytes(b"existing-thread-state")
        with (
            patch.dict(os.environ, {"SCHOLARSEED_CODEX_HOME": str(home)}),
            patch.object(Path, "open", guarded_open),
        ):
            codex_environment.prepare_codex_runtime_home()
        check(
            "legacy credential preserved but never read",
            legacy.read_text() == '{"fixture":"existing-unused"}',
        )
        check("existing thread state preserved", state.read_bytes() == b"existing-thread-state")


def test_vendor_neutral_model_projection() -> None:
    print("== vendor-neutral model projection ==")

    class Credentials:
        async def resolve(self, credential_ref: str) -> ModelCredential:
            if credential_ref != "credential-ref":
                raise ValueError("unexpected credential reference")
            return ModelCredential(
                api_key="secret-api-key",
                headers={"X-Research-Tenant": "secret-tenant"},
            )

    async def scenario() -> tuple[object, str, str]:
        intent = ModelIntent(
            model_ref="research-model",
            capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
            revision="model:research-model",
            transport=ModelTransport(
                mode=ModelConnectionMode.REMOTE,
                endpoint="https://models.example.test/v1/",
                wire_protocol=ModelWireProtocol.RESPONSES,
                credential_ref="credential-ref",
            ),
            context_window=128000,
            reasoning_effort="low",
            service_tier="fast",
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(codex_environment.os.environ, {"SCHOLARSEED_CODEX_HOME": directory}),
        ):
            session = CodexRuntimeSession(
                OpenSessionRequest(
                    product_session_id="product-session",
                    cwd=ROOT,
                    model=intent,
                    credential_port=Credentials(),
                    required_capabilities=(RuntimeCapabilityName.WEB_SEARCH,),
                )
            )
            await session._apply_model_connection()
            request = session._native.request
            catalog_path = json.loads(request.launch_arguments[-1].value.split("=", 1)[1])
            return (
                request,
                repr(ModelCredential(api_key="secret-api-key")),
                Path(catalog_path).read_text(),
            )

    request, credential_repr, catalog_text = asyncio.run(scenario())
    config = dict(request.thread_config)
    providers = dict(config.get("model_providers") or {})
    projected = dict(providers.get("scholarseed") or {})
    environment = dict(request.process_environment)
    check("model intent maps inside the adapter", projected.get("wire_api") == "responses")
    check(
        "endpoint normalization stays adapter-owned",
        projected.get("base_url") == "https://models.example.test/v1",
    )
    check("context metadata maps inside the adapter", config.get("model_context_window") == 128000)
    check("reasoning effort maps inside the adapter", config.get("model_reasoning_effort") == "low")
    check("custom model summary capability is not forced", "model_reasoning_summary" not in config)
    check("service tier maps inside the adapter", config.get("service_tier") == "fast")
    check(
        "session capability config survives model-provider projection",
        config.get("web_search") == "live",
    )
    check(
        "remote sessions enable upstream plan tool",
        config.get("tools.update_plan.enabled") is True,
    )
    check(
        "secrets are materialized only into the child environment",
        "secret-api-key" in environment.values() and "secret-tenant" in environment.values(),
    )
    check("credential repr never exposes secret values", "secret-api-key" not in credential_repr)
    catalog = json.loads(catalog_text)
    bound = catalog["models"][0]
    check(
        "reviewer is the exact session model",
        bound["auto_review_model_override"] == "research-model",
    )
    check(
        "catalog selects standard tools before dispatch",
        bound["tool_mode"] == "direct"
        and bound["use_responses_lite"] is False
        and bound["apply_patch_tool_type"] is None,
    )
    check("catalog contains no credentials", "secret-api-key" not in catalog_text)


def test_remote_retry_budget_projection() -> None:
    print("== remote retry budget projection ==")

    def project(transport: ModelTransport) -> dict[str, object]:
        async def scenario() -> dict[str, object]:
            intent = ModelIntent(
                model_ref="research-model",
                revision="model:research-model",
                capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                transport=transport,
            )
            with (
                tempfile.TemporaryDirectory() as directory,
                patch.dict(codex_environment.os.environ, {"SCHOLARSEED_CODEX_HOME": directory}),
            ):
                session = CodexRuntimeSession(
                    OpenSessionRequest(
                        product_session_id="product-session",
                        cwd=ROOT,
                        model=intent,
                    )
                )
                await session._apply_model_connection()
                config = dict(session._native.request.thread_config)
                providers = dict(config.get("model_providers") or {})
                return dict(providers.get("scholarseed") or {})

        return asyncio.run(scenario())

    remote = dict(
        mode=ModelConnectionMode.REMOTE,
        endpoint="https://models.example.test/v1/",
        wire_protocol=ModelWireProtocol.RESPONSES,
    )
    byok = project(ModelTransport(**remote, stream_max_retries=1, request_max_retries=1))
    gateway = project(ModelTransport(**remote, stream_max_retries=0, request_max_retries=0))
    undeclared = project(ModelTransport(**remote))
    check(
        "BYOK budget reaches the codex provider verbatim",
        byok.get("stream_max_retries") == 1 and byok.get("request_max_retries") == 1,
    )
    check(
        "gateway budget of zero survives projection (not dropped as falsy)",
        gateway.get("stream_max_retries") == 0 and gateway.get("request_max_retries") == 0,
    )
    check(
        "undeclared budget omits the knobs so codex keeps its own default",
        "stream_max_retries" not in undeclared and "request_max_retries" not in undeclared,
    )


def _no_proxy_entries(value: object) -> set[str]:
    return {part.strip() for part in str(value or "").split(",") if part.strip()}


def test_internal_channel_proxy_bypass_projection() -> None:
    print("== internal channel proxy bypass projection ==")

    def project(transport: ModelTransport, inherited: dict[str, str]) -> dict[str, str]:
        async def scenario() -> dict[str, str]:
            intent = ModelIntent(
                model_ref="research-model",
                revision="model:research-model",
                capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                transport=transport,
            )
            with (
                tempfile.TemporaryDirectory() as directory,
                patch.dict(
                    codex_environment.os.environ,
                    {"SCHOLARSEED_CODEX_HOME": directory, **inherited},
                ),
            ):
                session = CodexRuntimeSession(
                    OpenSessionRequest(
                        product_session_id="product-session",
                        cwd=ROOT,
                        model=intent,
                    )
                )
                await session._apply_model_connection()
                return dict(session._native.request.process_environment)

        return asyncio.run(scenario())

    remote = dict(
        mode=ModelConnectionMode.REMOTE,
        endpoint="https://models.example.test/v1/",
        wire_protocol=ModelWireProtocol.RESPONSES,
    )
    declared = ModelTransport(**remote, proxy_bypass_hosts=("127.0.0.1",))
    undeclared = ModelTransport(**remote)

    # Windows 的环境变量名不区分大小写，NO_PROXY 与 no_proxy 是同一个变量，
    # 所以会话级场景只能给两个拼写同一个值；拼写之间的差异语义由下面的纯函数覆盖。
    inherited_list = "corp.internal, 10.0.0.0/8"
    merged = project(declared, {"NO_PROXY": inherited_list, "no_proxy": inherited_list})
    check(
        "internal channel host reaches the uppercase key codex-rs reads",
        "127.0.0.1" in _no_proxy_entries(merged.get("NO_PROXY")),
        str(merged),
    )
    check(
        "lowercase alias carries the same list (hyper-util is first-wins, not merged)",
        merged.get("no_proxy") == merged.get("NO_PROXY") and merged.get("no_proxy") != "",
        str(merged),
    )
    check(
        "user entries survive the merge",
        {"corp.internal", "10.0.0.0/8"} <= _no_proxy_entries(merged.get("NO_PROXY")),
        str(merged),
    )

    bare = project(declared, {"NO_PROXY": "", "no_proxy": ""})
    check(
        "with no inherited list the host is projected alone",
        _no_proxy_entries(bare.get("NO_PROXY")) == {"127.0.0.1"}
        and bare.get("no_proxy") == bare.get("NO_PROXY"),
        str(bare),
    )

    untouched = project(undeclared, {"NO_PROXY": "corp.internal", "no_proxy": ""})
    check(
        "an undeclared transport never touches the user's proxy semantics",
        "NO_PROXY" not in untouched and "no_proxy" not in untouched,
        str(untouched),
    )

    check(
        "an inherited lowercase-only list is not dropped",
        {"192.168.0.0/16", "127.0.0.1"}
        <= _no_proxy_entries(
            codex_environment.proxy_bypass_environment(
                {"no_proxy": "192.168.0.0/16"}, ("127.0.0.1",)
            )["NO_PROXY"]
        ),
    )
    check(
        "merge is idempotent when the host is already listed",
        codex_environment.proxy_bypass_environment(
            {"NO_PROXY": "127.0.0.1,corp.internal"}, ("127.0.0.1",)
        )["NO_PROXY"]
        == "127.0.0.1,corp.internal",
    )
    check(
        "both spellings are unioned so no user entry is lost",
        _no_proxy_entries(
            codex_environment.proxy_bypass_environment(
                {"NO_PROXY": "a.example", "no_proxy": "b.example"}, ("127.0.0.1",)
            )["NO_PROXY"]
        )
        == {"a.example", "b.example", "127.0.0.1"},
    )
    check(
        "no declared host means no projection at all",
        codex_environment.proxy_bypass_environment({"NO_PROXY": "a.example"}, ()) == {},
    )
    with patch.object(codex_environment, "ENVIRONMENT_NAME_CASE_INSENSITIVE", True):
        folded = codex_environment.proxy_bypass_environment(
            {"No_Proxy": "corp.internal"}, ("127.0.0.1",)
        )
    check(
        "case-insensitive platforms overwrite every inherited spelling",
        "No_Proxy" in folded
        and all(
            {"corp.internal", "127.0.0.1"} <= _no_proxy_entries(value) for value in folded.values()
        ),
        str(folded),
    )
    with patch.object(codex_environment, "ENVIRONMENT_NAME_CASE_INSENSITIVE", False):
        canonical = codex_environment.proxy_bypass_environment(
            {"No_Proxy": "corp.internal", "no_proxy": "10.0.0.0/8"}, ("127.0.0.1",)
        )
    check(
        "case-sensitive platforms read only the two canonical spellings",
        "No_Proxy" not in canonical
        and _no_proxy_entries(canonical["NO_PROXY"]) == {"10.0.0.0/8", "127.0.0.1"}
        and canonical["NO_PROXY"] == canonical["no_proxy"],
        str(canonical),
    )

    async def child_environment() -> dict[str, str]:
        inherited = {"HTTPS_PROXY": "http://127.0.0.1:7890", "NO_PROXY": "corp.internal"}
        with patch.dict("os.environ", inherited):
            host = CodexProcessHost(
                executable="codex",
                process_environment=codex_environment.proxy_bypass_environment(
                    inherited, ("127.0.0.1",)
                ),
            )
        spawn = AsyncMock(side_effect=OSError("contract spawn stopped"))
        with (
            patch.dict("os.environ", inherited),
            patch("scholarseed_codex.process.asyncio.create_subprocess_exec", spawn),
        ):
            try:
                await host._start_process()
            except Exception:
                pass
        return dict(spawn.call_args.kwargs["env"])

    child = asyncio.run(child_environment())
    check(
        "the real child env exempts the internal channel",
        "127.0.0.1" in _no_proxy_entries(child.get("NO_PROXY")),
        str(child.get("NO_PROXY")),
    )
    check(
        "the user's own bypass entry still reaches the child",
        "corp.internal" in _no_proxy_entries(child.get("NO_PROXY")),
        str(child.get("NO_PROXY")),
    )
    check(
        "the outbound proxy is preserved so tool traffic keeps working",
        child.get("HTTPS_PROXY") == "http://127.0.0.1:7890",
        str(child.get("HTTPS_PROXY")),
    )

    async def compiled_bridge_requests() -> tuple[CodexSessionOpenRequest, CodexSessionOpenRequest]:
        base = CodexSessionOpenRequest("bridge-process", "codex", ROOT)
        requests = []
        with patch.dict(
            "os.environ", {"HTTPS_PROXY": "http://127.0.0.1:7890", "NO_PROXY": "corp.internal"}
        ):
            for model, protocol in (
                ("qwen", ModelToolProtocol.JSON_SCHEMA),
                ("gpt", ModelToolProtocol.PROVIDER_NATIVE),
            ):
                intent = ModelIntent(
                    model_ref=model,
                    capabilities=ModelCapabilities(tool_protocol=protocol),
                    transport=ModelTransport(
                        mode=ModelConnectionMode.REMOTE,
                        endpoint=f"http://127.0.0.1:24567/{model}/v1",
                        proxy_bypass_hosts=("127.0.0.1",),
                    ),
                )
                requests.append(await model_connection(intent, base, None, timing=base.timing))
        return requests[0], requests[1]

    qwen_request, gpt_request = asyncio.run(compiled_bridge_requests())
    check(
        "schema and native product bridges compile identical process proxy environments",
        qwen_request.process_environment == gpt_request.process_environment
        and "127.0.0.1" in _no_proxy_entries(gpt_request.process_environment["NO_PROXY"]),
    )
    check(
        "product bridge endpoints stay thread scoped while Host provider configuration is shared",
        qwen_request.provider_configuration == gpt_request.provider_configuration
        and qwen_request.launch_arguments == gpt_request.launch_arguments
        and qwen_request.thread_config != gpt_request.thread_config,
    )


def test_native_agent_message_capability() -> None:
    source = {
        "models": [
            {
                "slug": "native",
                "multi_agent_version": "v2",
                "use_responses_lite": True,
                "tool_mode": "code_mode_only",
                "model_messages": {"instructions_template": "native instructions"},
                "custom_future_field": {"preserve": True},
            }
        ]
    }

    async def scenario(home: Path) -> None:
        request = CodexSessionOpenRequest(
            "collaboration-catalog",
            "codex",
            cwd=home,
            process_environment={codex_environment.CODEX_HOME_ENV: str(home)},
        )
        snapshots: list[catalog_module.ModelCatalogSnapshot] = []

        async def select(
            snapshot: catalog_module.ModelCatalogSnapshot,
        ) -> CodexRuntimeLaunchArgument:
            snapshots.append(snapshot)
            return snapshot.argument

        for protocol in (ModelToolProtocol.PROVIDER_NATIVE, ModelToolProtocol.JSON_SCHEMA):
            for declared in (False, True):
                previous: catalog_module.ModelCatalogSnapshot | None = None
                for supported in (None, True, False):
                    capabilities = ModelCapabilities(
                        tool_protocol=protocol, native_agent_messages=supported
                    )
                    entry = ModelCatalogEntry("native", capabilities)
                    intent = ModelIntent(
                        model_ref="native",
                        capabilities=capabilities,
                        catalog_models=(entry,) if declared else (),
                        transport=ModelTransport(mode=ModelConnectionMode.NATIVE),
                    )
                    await model_catalog_argument(
                        intent, request, native=AsyncMock(return_value=source), select=select
                    )
                    snapshot = snapshots[-1]
                    row = json.loads(snapshot.document)["models"][0]
                    if supported is False:
                        assert previous is not None
                        check(
                            "unsupported agent messages select official local collaboration",
                            row["multi_agent_version"] == "v1",
                        )
                        check(
                            "collaboration capability changes immutable catalog identity",
                            previous.path != snapshot.path and not previous.covers(snapshot),
                        )
                        if declared:
                            check(
                                "catalog declaration detects changed collaboration capability",
                                not previous.declares(intent),
                            )
                    else:
                        check(
                            "unknown or supported agent messages preserve upstream selection",
                            row.get("multi_agent_version")
                            == ("v2" if protocol is ModelToolProtocol.PROVIDER_NATIVE else None),
                        )
                    if protocol is ModelToolProtocol.PROVIDER_NATIVE:
                        check(
                            "collaboration projection preserves all other native metadata",
                            {
                                key: value
                                for key, value in row.items()
                                if key not in {"multi_agent_version", "auto_review_model_override"}
                            }
                            == {
                                key: value
                                for key, value in source["models"][0].items()
                                if key != "multi_agent_version"
                            },
                        )
                    previous = snapshot
        check(
            "collaboration projection never mutates the source catalog",
            source["models"][0]["multi_agent_version"] == "v2"
            and "auto_review_model_override" not in source["models"][0],
        )
        intent = ModelIntent(
            model_ref="native",
            transport=ModelTransport(endpoint="https://model.example.test/v1"),
        )
        session = CodexRuntimeSession(
            OpenSessionRequest(product_session_id="collaboration-config", cwd=home, model=intent)
        )
        with patch.object(session._host_pool, "require_skill_policy", AsyncMock()):
            default = await session._configure_model_connection(
                intent, session._native_base_request, None
            )
            restricted = replace(
                intent, capabilities=replace(intent.capabilities, native_agent_messages=False)
            )
            configured = await session._configure_model_connection(
                restricted, session._native_base_request, None
            )
        check(
            "unrestricted sources retain native feature defaults",
            "features.multi_agent_v2" not in default.thread_config,
        )
        check(
            "unsupported native messages override explicit V2 without disabling local collaboration",
            configured.thread_config.get("features.multi_agent_v2") is False
            and "features.multi_agent" not in configured.thread_config,
        )
        receipt = await session.reconfigure(
            RuntimeConfigurationIntent(revision="collaboration:v1", model=restricted, required=True)
        )
        check(
            "collaboration backend changes cannot hot-reconfigure an existing thread",
            receipt.state is CommandState.RESTART_REQUIRED,
        )

    with tempfile.TemporaryDirectory() as directory:
        asyncio.run(scenario(Path(directory)))


def test_approval_catalog_binding() -> None:
    native = {
        "models": [
            {
                "slug": "native",
                "tool_mode": "code_mode",
                "use_responses_lite": True,
                "model_messages": {"instructions_template": "native instructions"},
                "input_modalities": ["text", "image"],
                "custom_future_field": {"preserve": True},
            }
        ]
    }
    bound = bind_native_models(
        native, ("vendor/native-dated", "vendor/native-new"), "vendor/native-dated"
    )
    selected = bound["models"][-2]
    check(
        "native reviewer keeps the exact dated id",
        selected["auto_review_model_override"] == "vendor/native-dated",
    )
    check(
        "native capabilities are preserved losslessly",
        selected["tool_mode"] == "code_mode"
        and selected["use_responses_lite"]
        and selected["custom_future_field"] == {"preserve": True},
    )
    check(
        "native source catalog is not mutated",
        len(native["models"]) == 1 and "auto_review_model_override" not in native["models"][0],
    )
    defaults = bind_native_models(native, (), "")
    check(
        "implicit native defaults retain Codex selection with self-bound reviewers",
        defaults["models"][0]["auto_review_model_override"] == "native",
    )
    multi_model = {"models": [{"slug": "model-a"}, {"slug": "model-b"}]}
    check(
        "exact native models share one process catalog",
        bind_native_models(multi_model, ("model-a", "model-b"), "model-a")
        == bind_native_models(multi_model, ("model-a", "model-b"), "model-b"),
    )
    try:
        bind_native_models(native, ("missing-model",), "missing-model")
    except ValueError:
        check("unknown native model fails instead of guessing capabilities", True)
    else:
        check("unknown native model fails instead of guessing capabilities", False)
    intent = ModelIntent(
        model_ref="native",
        capabilities=ModelCapabilities(
            tool_protocol=ModelToolProtocol.JSON_SCHEMA,
            input_modalities=("text",),
            reasoning_efforts=("low", "high"),
        ),
        transport=ModelTransport(
            endpoint="https://model.example.test/v1", supports_websockets=True
        ),
    )
    entry = ModelCatalogEntry(intent.model_ref, intent.capabilities, intent.context_window)
    standard = standard_model(entry)
    review_entry = ModelCatalogEntry("review-model", intent.capabilities)
    reviewed = standard_model(replace(entry, approval_model_ref=review_entry.model_ref))
    check(
        "review model is independent from selected model",
        reviewed["auto_review_model_override"] == review_entry.model_ref
        and reviewed["slug"] == intent.model_ref,
    )
    check(
        "same-name remote model does not inherit native tools",
        standard["tool_mode"] == "direct"
        and not standard["use_responses_lite"]
        and standard["apply_patch_tool_type"] is None,
    )
    check(
        "selected declarations decide modalities and effort levels",
        standard["input_modalities"] == ["text"]
        and [row["effort"] for row in standard["supported_reasoning_levels"]] == ["low", "high"],
    )

    async def shared_catalog(home: Path) -> tuple[str, str]:
        entries = (
            entry,
            ModelCatalogEntry("other", intent.capabilities),
        )
        request = CodexSessionOpenRequest(
            request_id="catalog-share",
            runtime_id="codex",
            cwd=home,
            process_environment={codex_environment.CODEX_HOME_ENV: str(home)},
            base_instructions="product instructions",
        )
        first = await model_catalog_argument(replace(intent, catalog_models=entries), request)
        second = await model_catalog_argument(
            replace(intent, model_ref="other", reasoning_effort="high", catalog_models=entries),
            replace(request, base_instructions="different thread instructions"),
        )
        return first.value, second.value

    async def review_catalog(home: Path) -> dict[str, Any]:
        request = CodexSessionOpenRequest(
            request_id="catalog-review",
            runtime_id="codex",
            cwd=home,
            process_environment={codex_environment.CODEX_HOME_ENV: str(home)},
            base_instructions="product instructions",
        )
        argument = await model_catalog_argument(
            replace(
                intent,
                catalog_models=(
                    replace(entry, approval_model_ref=review_entry.model_ref),
                    review_entry,
                ),
                approval_model_ref=review_entry.model_ref,
            ),
            request,
        )
        path = Path(json.loads(argument.value.split("=", 1)[1]))
        return json.loads(path.read_text())

    with tempfile.TemporaryDirectory() as directory:
        reviewed_catalog = asyncio.run(review_catalog(Path(directory)))
        check(
            "selected model uses separate reviewer in published catalog",
            next(row for row in reviewed_catalog["models"] if row["slug"] == "native")[
                "auto_review_model_override"
            ]
            == "review-model",
        )
        try:
            asyncio.run(
                model_catalog_argument(
                    replace(intent, catalog_models=(entry,), approval_model_ref="missing"),
                    CodexSessionOpenRequest(
                        request_id="catalog-review-missing",
                        runtime_id="codex",
                        cwd=Path(directory),
                        process_environment={codex_environment.CODEX_HOME_ENV: directory},
                    ),
                )
            )
        except ValueError:
            check("missing reviewer fails before launch", True)
        else:
            check("missing reviewer fails before launch", False)

    with tempfile.TemporaryDirectory() as directory:
        first_argument, second_argument = asyncio.run(shared_catalog(Path(directory)))
        check(
            "connection catalog is stable across selected models, effort and thread instructions",
            first_argument == second_argument,
        )
        catalog_path = Path(json.loads(first_argument.split("=", 1)[1]))
        check(
            "shared launch catalog contains both model definitions",
            {row["slug"] for row in json.loads(catalog_path.read_text())["models"]}
            == {"native", "other"},
        )
        check(
            "shared catalog does not capture thread-owned instructions",
            all(
                row["base_instructions"] == ""
                for row in json.loads(catalog_path.read_text())["models"]
            ),
        )
        host = CodexProcessHost()
        for instructions in ("first thread instructions", "second thread instructions"):
            request = CodexSessionOpenRequest(
                "instructions", "codex", cwd=Path(directory), base_instructions=instructions
            )
            for include_tools in (False, True):
                check(
                    "start and resume parameters retain independent thread instructions",
                    host._thread_params(request, include_dynamic_tools=include_tools)[
                        "baseInstructions"
                    ]
                    == instructions,
                )
    with tempfile.TemporaryDirectory() as directory:
        home = Path(directory)
        payload = json.dumps(standard).encode()
        first = codex_environment.store_model_catalog(home, payload)
        repeated = codex_environment.store_model_catalog(home, payload)
        changed = codex_environment.store_model_catalog(
            home,
            json.dumps(standard_model(replace(entry, model_ref="other"))).encode(),
        )
        check(
            "catalog identity is stable and changes with the bound model",
            first == repeated and first != changed,
        )
        check(
            "catalog publication is complete and leaves no temporary files",
            first.read_bytes() == payload and len(list(first.parent.iterdir())) == 2,
        )

    async def reconfigure() -> None:
        session = CodexRuntimeSession(
            OpenSessionRequest(product_session_id="capability-change", cwd=ROOT, model=intent)
        )
        unchanged = await session.reconfigure(
            RuntimeConfigurationIntent(revision="unchanged", model=intent)
        )
        changed = await session.reconfigure(
            RuntimeConfigurationIntent(
                revision="changed",
                model=replace(
                    intent,
                    capabilities=replace(intent.capabilities, input_modalities=("text", "image")),
                ),
            )
        )
        check("unchanged binding can remain in place", unchanged.state is CommandState.APPLIED)
        check(
            "same-model capability changes require restart",
            changed.state is CommandState.RESTART_REQUIRED,
        )

    asyncio.run(reconfigure())


def test_mixed_catalog_declarations() -> None:
    schema = ModelCapabilities(
        tool_protocol=ModelToolProtocol.JSON_SCHEMA,
        input_modalities=("text",),
        reasoning_efforts=("low",),
    )
    native = ModelCapabilities(tool_protocol=ModelToolProtocol.PROVIDER_NATIVE)
    entries = (
        ModelCatalogEntry("qwen", schema, 100000),
        ModelCatalogEntry("gpt", native, approval_model_ref="reviewer"),
        ModelCatalogEntry("reviewer", native),
    )
    source = {
        "models": [
            {
                "slug": "gpt",
                "tool_mode": "code_mode",
                "use_responses_lite": True,
                "context_window": 256000,
                "input_modalities": ["text", "image"],
                "supported_reasoning_levels": [{"effort": "medium", "description": "native"}],
                "future_field": {"retain": True},
            },
            {"slug": "reviewer", "tool_mode": "code_mode"},
            {"slug": "unrelated", "tool_mode": "code_mode"},
        ]
    }

    async def scenario(home: Path) -> None:
        request = CodexSessionOpenRequest(
            "mixed",
            "codex",
            home,
            process_environment={codex_environment.CODEX_HOME_ENV: str(home)},
        )
        fetch = AsyncMock(return_value=source)
        qwen = ModelIntent(
            model_ref="qwen",
            capabilities=schema,
            catalog_models=entries,
            transport=ModelTransport(mode=ModelConnectionMode.NATIVE),
        )
        gpt = replace(qwen, model_ref="gpt", capabilities=native, approval_model_ref="reviewer")
        first = await model_catalog_argument(qwen, request, native=fetch)
        second = await model_catalog_argument(gpt, request, native=fetch)
        path = Path(json.loads(first.value.split("=", 1)[1]))
        models = {row["slug"]: row for row in json.loads(path.read_bytes())["models"]}
        check(
            "mixed protocols publish the same immutable catalog for either selection",
            first == second,
        )
        check(
            "explicit native declarations exclude undeclared upstream models",
            set(models) == {"qwen", "gpt", "reviewer"},
        )
        check(
            "each model retains its own tool protocol and capability definition",
            models["qwen"]["tool_mode"] == "direct"
            and models["qwen"]["context_window"] == 100000
            and models["gpt"]["tool_mode"] == "code_mode"
            and models["gpt"]["context_window"] == 256000
            and models["gpt"]["future_field"] == {"retain": True}
            and models["gpt"]["supported_reasoning_levels"]
            == source["models"][0]["supported_reasoning_levels"],
        )
        check(
            "reviewer binding is per entry and never copied from the selected model",
            models["qwen"]["auto_review_model_override"] == "qwen"
            and models["gpt"]["auto_review_model_override"] == "reviewer"
            and models["reviewer"]["auto_review_model_override"] == "reviewer",
        )
        check(
            "mixed compilation never mutates upstream native metadata",
            "auto_review_model_override" not in source["models"][0],
        )
        invalid = (
            (
                "conflicting repeated declarations",
                replace(
                    qwen, catalog_models=(*entries, replace(entries[0], context_window=200000))
                ),
                source,
            ),
            (
                "selected reviewer inconsistent with declaration",
                replace(gpt, approval_model_ref="qwen"),
                source,
            ),
            (
                "undeclared reviewer dependency",
                replace(qwen, catalog_models=(replace(entries[0], approval_model_ref="missing"),)),
                source,
            ),
            ("missing unselected native declaration", qwen, {"models": source["models"][:1]}),
            (
                "conflicting repeated native definitions",
                qwen,
                {"models": [*source["models"], {"slug": "gpt", "tool_mode": "direct"}]},
            ),
        )
        for name, intent, definition in invalid:
            try:
                await model_catalog_argument(
                    intent, request, native=AsyncMock(return_value=definition)
                )
            except ValueError:
                check(f"{name} is rejected before process admission", True)
            else:
                check(f"{name} is rejected before process admission", False)

    with tempfile.TemporaryDirectory() as directory:
        asyncio.run(scenario(Path(directory)))


def test_catalog_immutable_publication() -> None:
    with tempfile.TemporaryDirectory() as directory:
        home = Path(directory)
        payload = b'{"models": [{"slug": "immutable"}]}'
        with ThreadPoolExecutor(max_workers=4) as executor:
            paths = tuple(
                executor.map(
                    lambda _: codex_environment.store_model_catalog(home, payload), range(12)
                )
            )
        path = paths[0]
        check(
            "concurrent content-addressed publication keeps one complete immutable file",
            len(set(paths)) == 1
            and path.read_bytes() == payload
            and tuple(path.parent.iterdir()) == (path,),
        )
        tampered = b"preserve corruption for diagnosis"
        path.write_bytes(tampered)
        try:
            codex_environment.store_model_catalog(home, payload)
        except ValueError as error:
            check(
                "existing hash mismatch fails without overwriting evidence",
                str(error) == codex_environment.CODEX_CATALOG_IMMUTABLE_ERROR
                and path.read_bytes() == tampered,
            )
        else:
            check("existing hash mismatch fails without overwriting evidence", False)
        path.unlink()
        target = home / "outside.json"
        target.write_bytes(payload)
        try:
            path.symlink_to(target)
        except OSError as error:
            check(
                "platform symlink denial leaves target intact",
                os.name == "nt" and target.read_bytes() == payload,
                str(error),
            )
        else:
            try:
                codex_environment.store_model_catalog(home, payload)
            except ValueError as error:
                check(
                    "immutable publication refuses symlink destinations",
                    str(error) == codex_environment.CODEX_CATALOG_IMMUTABLE_ERROR
                    and path.is_symlink()
                    and target.read_bytes() == payload,
                )
            else:
                check("immutable publication refuses symlink destinations", False)


def test_catalog_http_preflight_boundaries() -> None:
    async def scenario(home: Path) -> None:
        endpoint = "https://catalog.example.test/v1"
        intent = ModelIntent(
            model_ref="native",
            transport=ModelTransport(mode=ModelConnectionMode.REMOTE, endpoint=endpoint),
        )
        request = CodexSessionOpenRequest(
            "catalog-http",
            "codex",
            home,
            process_environment={codex_environment.CODEX_HOME_ENV: str(home)},
        )
        source = {"models": [{"slug": intent.model_ref, "tool_mode": "code_mode"}]}
        for error in (httpx.ConnectError("connection failed"), httpx.ReadTimeout("timed out")):
            client = AsyncMock()
            client.__aenter__.return_value = client
            client.get.side_effect = error
            with patch.object(catalog_module.httpx, "AsyncClient", return_value=client):
                try:
                    await model_catalog_argument(intent, request)
                except CatalogPreflightError as observed:
                    check(
                        f"remote {type(error).__name__} is rejected only after HTTP cleanup",
                        str(observed) == MODEL_CATALOG_UNAVAILABLE
                        and observed.__cause__ is error
                        and client.__aexit__.await_count == 1,
                    )
                else:
                    check(f"remote {type(error).__name__} is classified", False)
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.get.return_value = httpx.Response(
            500, request=httpx.Request("GET", endpoint + catalog_module.MODELS_SUFFIX)
        )
        with patch.object(catalog_module.httpx, "AsyncClient", return_value=client):
            try:
                await model_catalog_argument(intent, request)
            except CatalogPreflightError as observed:
                check(
                    "remote HTTP 500 retains its cause without exposing response details",
                    str(observed) == MODEL_CATALOG_UNAVAILABLE
                    and isinstance(observed.__cause__, httpx.HTTPStatusError)
                    and client.__aexit__.await_count == 1,
                )
            else:
                check("remote HTTP 500 is classified", False)
            client.get.return_value = httpx.Response(
                200,
                json=source,
                request=httpx.Request("GET", endpoint + catalog_module.MODELS_SUFFIX),
            )
            recovered = await model_catalog_argument(intent, request)
            check("remote catalog can be explicitly retried after rejection", bool(recovered.value))

        native_error = httpx.ConnectError("native control failure")
        try:
            await model_catalog_argument(
                replace(intent, transport=ModelTransport(mode=ModelConnectionMode.NATIVE)),
                request,
                native=AsyncMock(side_effect=native_error),
            )
        except httpx.HTTPError as observed:
            check(
                "native/control catalog errors are not safe HTTP preflight failures",
                observed is native_error,
            )
        else:
            check("native/control catalog errors retain their failure", False)

        for stage, error in (
            ("request", asyncio.CancelledError()),
            ("cleanup", httpx.ReadError("HTTP cleanup failed")),
        ):
            client = AsyncMock()
            client.__aenter__.return_value = client
            client.get.side_effect = error if stage == "request" else httpx.ConnectError("failed")
            if stage == "cleanup":
                client.__aexit__.side_effect = error
            with patch.object(catalog_module.httpx, "AsyncClient", return_value=client):
                try:
                    await model_catalog_argument(intent, request)
                except (asyncio.CancelledError, httpx.HTTPError) as observed:
                    check(
                        f"HTTP {stage} uncertainty is not converted to safe rejection",
                        observed is error,
                    )
                else:
                    check(f"HTTP {stage} uncertainty remains visible", False)

    with tempfile.TemporaryDirectory() as directory:
        asyncio.run(scenario(Path(directory)))


def test_host_catalog_preflight_receipts() -> None:
    async def scenario(home: Path) -> None:
        runtime = provider()
        pool = runtime._pool
        schema = ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA)
        first_entry = ModelCatalogEntry("first", schema)
        initial = ModelIntent(
            model_ref=first_entry.model_ref,
            capabilities=schema,
            catalog_models=(first_entry,),
            transport=ModelTransport(
                mode=ModelConnectionMode.REMOTE, endpoint="https://catalog.example.test/v1"
            ),
        )
        target = replace(
            initial,
            model_ref="target",
            capabilities=ModelCapabilities(),
            catalog_models=(first_entry, ModelCatalogEntry("target")),
        )
        first_request = HostWarmupRequest("catalog-first", home, "owner", model=initial)
        target_request = replace(first_request, request_id="catalog-target", model=target)
        readiness = SimpleNamespace(
            ready=True,
            safe_error="",
            executable="/runtime/codex",
            version="test",
        )

        async def connection(intent, request, credentials, *, timing):
            projected = await model_connection(intent, request, credentials, timing=timing)
            return replace(projected, provider_configuration={})

        client = AsyncMock()
        client.__aenter__.return_value = client
        preparation_lease = Mock()
        runtime._resource_lease = lambda: preparation_lease
        with (
            patch.object(pool, "prepare_home", return_value=home),
            patch.object(pool, "probe_readiness", AsyncMock(return_value=readiness)),
            patch.object(
                pool_module, "discover_codex_executable", return_value=readiness.executable
            ),
            patch.object(pool_module, "CodexProcessHost", ControlledHost),
            patch.object(
                provider_module, "configured_codex_executable", return_value=readiness.executable
            ),
            patch.object(
                provider_module,
                "managed_codex_launch",
                return_value=({codex_environment.CODEX_HOME_ENV: str(home)}, ()),
            ),
            patch.object(provider_module, "model_connection", side_effect=connection),
            patch.object(catalog_module.httpx, "AsyncClient", return_value=client),
        ):
            try:
                first = await runtime.prewarm(first_request)
                old = next(iter(pool._hosts.values())).host
                pinned = pool._execution_catalog
                for method in (runtime.prewarm, runtime.reconfigure):
                    for failure in ("status", "connection", "timeout"):
                        client.get.side_effect = {
                            "connection": httpx.ConnectError("connection failed"),
                            "timeout": httpx.ReadTimeout("timed out"),
                        }.get(failure)
                        client.get.return_value = httpx.Response(
                            500, request=httpx.Request("GET", target.transport.endpoint + "/models")
                        )
                        preparation_lease.reset_mock()
                        with (
                            patch.object(pool, "reserve", wraps=pool.reserve) as reserve,
                            patch.object(pool, "release_idle", wraps=pool.release_idle) as release,
                            patch.object(
                                pool,
                                "reset_execution_configuration",
                                wraps=pool.reset_execution_configuration,
                            ) as reset,
                        ):
                            rejected = await method(target_request)
                            check(
                                f"{method.__name__} {failure} returns known rejection without Host control",
                                rejected.state is CommandState.REJECTED
                                and rejected.safe_error == MODEL_CATALOG_UNAVAILABLE
                                and reserve.await_count
                                == release.await_count
                                == reset.await_count
                                == 0
                                and preparation_lease.close.call_count == 1
                                and not old.closed
                                and pool._execution_catalog is pinned,
                            )

                preparation_lease.close.side_effect = OSError("preparation cleanup failed")
                client.get.side_effect = httpx.ConnectError("connection failed")
                try:
                    await runtime.prewarm(target_request)
                except OSError:
                    check(
                        "preparation cleanup failure cannot return a safe rejection", not old.closed
                    )
                else:
                    check("preparation cleanup failure remains unknown", False)
                preparation_lease.close.side_effect = None
                client.get.side_effect = None
                client.get.return_value = httpx.Response(
                    200,
                    json={"models": [{"slug": "target", "tool_mode": "code_mode"}]},
                    request=httpx.Request("GET", target.transport.endpoint + "/models"),
                )
                recovered = await runtime.reconfigure(target_request)
                check(
                    "known catalog rejection permits a later explicit successful reconfiguration",
                    recovered.state is CommandState.APPLIED
                    and first.correlation_id != recovered.correlation_id
                    and old.closed
                    and pool._execution_catalog is not pinned,
                )
                mutation_error = httpx.ConnectError("failure after reset")
                with patch.object(pool, "probe_readiness", AsyncMock(side_effect=mutation_error)):
                    try:
                        await runtime.reconfigure(target_request)
                    except httpx.HTTPError as observed:
                        check(
                            "HTTP-like failures after reset are not preflight rejections",
                            observed is mutation_error,
                        )
                    else:
                        check("failure after reset remains unknown", False)
                fenced = await runtime.prewarm(target_request)
                check(
                    "failure after reset retains the Host configuration fence",
                    fenced.state is CommandState.RESTART_REQUIRED
                    and fenced.safe_error == RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
                )
            finally:
                await pool.aclose()

    with tempfile.TemporaryDirectory() as directory:
        asyncio.run(scenario(Path(directory)))


def test_catalog_version_pins_granted_execution() -> None:
    async def scenario(home: Path) -> None:
        pool = CodexHostPool()
        schema = ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA)
        entry = ModelCatalogEntry("qwen", schema)
        initial = ModelIntent(
            model_ref="qwen",
            capabilities=schema,
            catalog_models=(entry,),
            transport=ModelTransport(mode=ModelConnectionMode.NATIVE),
        )
        request = CodexSessionOpenRequest(
            "catalog-pin",
            "codex",
            home,
            executable="/runtime/codex",
            process_sharing_scope="catalog-actor",
            process_environment={codex_environment.CODEX_HOME_ENV: str(home)},
        )
        readiness = SimpleNamespace(
            ready=True,
            status=CodexRuntimeStatus.READY,
            safe_error="",
            executable=request.executable,
            version="test",
        )
        with (
            patch.object(pool, "probe_readiness", AsyncMock(return_value=readiness)),
            patch.object(pool_module, "discover_codex_executable", return_value=request.executable),
            patch.object(pool_module, "CodexProcessHost", ControlledHost),
        ):
            first = await pool.model_catalog_argument(initial, request)
            second = await pool.model_catalog_argument(initial, request)
            check(
                "equal concurrent catalog arguments keep independent candidate ownership",
                first == second and first is not second and len(pool._catalog_candidates) == 2,
            )
            del first
            gc.collect()
            check(
                "cancelled first compilation cannot discard a later equal candidate",
                len(pool._catalog_candidates) == 1,
            )
            expired = await pool.reserve(
                replace(request, launch_arguments=(second,)),
                role=HostRole.EXECUTION,
                request_id="catalog-expired",
                deadline=time() - 1,
            )
            check(
                "rejected reservation never freezes a candidate version",
                expired.state is ResourceState.REJECTED and pool._execution_catalog is None,
            )
            lease = await pool.acquire(replace(request, launch_arguments=(second,)))
            check(
                "actual grant freezes the surviving concurrent candidate",
                pool._execution_catalog is not None and pool._execution_catalog.argument == second,
            )
            expanded = replace(initial, catalog_models=(entry, ModelCatalogEntry("gpt")))
            fetch = AsyncMock(side_effect=ValueError("unrelated native source unavailable"))
            with patch.object(pool, "_native_catalog", fetch):
                current = await pool.model_catalog_argument(expanded, request)
                check(
                    "unchanged selected declaration reuses the old version without unrelated native IO",
                    current == second and fetch.await_count == 0,
                )
            native_source = AsyncMock(
                return_value={
                    "models": [{"slug": "gpt", "tool_mode": "code_mode", "future_field": True}]
                }
            )
            with patch.object(pool, "_native_catalog", native_source):
                upgraded = await pool.model_catalog_argument(
                    replace(expanded, model_ref="gpt", capabilities=ModelCapabilities()), request
                )
            check(
                "only a newly required model requests a new immutable version",
                upgraded != second and native_source.await_count == 1,
            )
            rejected = await pool.reserve(
                replace(request, request_id="catalog-upgrade-busy", launch_arguments=(upgraded,)),
                role=HostRole.EXECUTION,
                request_id="catalog-upgrade-busy",
                deadline=time() + TEST_WAIT_SECONDS,
            )
            check(
                "new version conflicts without replacing the granted pin or busy host",
                rejected.safe_error == RESOURCE_HOST_CONFIGURATION_CONFLICT
                and pool._execution_catalog is not None
                and pool._execution_catalog.argument == second
                and not lease.host.closed,
            )
            environment = {**request.process_environment, "CHANGED_PROCESS_ENV": "different"}
            conflict = await pool.reserve(
                replace(
                    request,
                    request_id="catalog-environment",
                    process_environment=environment,
                    launch_arguments=(current,),
                ),
                role=HostRole.EXECUTION,
                request_id="catalog-environment",
                deadline=time() + TEST_WAIT_SECONDS,
            )
            check(
                "version reuse preserves the complete process environment fingerprint",
                conflict.safe_error == RESOURCE_HOST_CONFIGURATION_CONFLICT,
            )
            for name, isolated in (
                ("other principal", replace(request, process_sharing_scope="other-actor")),
            ):
                try:
                    await pool.model_catalog_argument(initial, isolated)
                except AppServerError as error:
                    check(
                        f"catalog reuse cannot cross {name}",
                        error.safe_error == RESOURCE_HOST_CONFIGURATION_CONFLICT,
                    )
                else:
                    check(f"catalog reuse cannot cross {name}", False)
            await lease.close()
            await pool.release_idle()
            with patch.object(pool, "_native_catalog", fetch):
                retained = await pool.model_catalog_argument(expanded, request)
            check(
                "pin survives zero resident hosts while execution configuration stays locked",
                pool.execution_configured and retained == second and fetch.await_count == 0,
            )
            await pool.reset_execution_configuration(request.process_sharing_scope)
            check("controlled reset clears the granted pin", pool._execution_catalog is None)
            upgraded_lease = await pool.acquire(
                replace(request, request_id="catalog-upgraded", launch_arguments=(upgraded,))
            )
            check(
                "compiled upgrade candidate survives reset and freezes only on its new grant",
                pool._execution_catalog is not None
                and pool._execution_catalog.argument == upgraded,
            )
            await pool.aclose()
            check(
                "shutdown releases pinned and ungranted candidate metadata",
                pool._execution_catalog is None
                and not pool._catalog_candidates
                and upgraded_lease.host.closed,
            )

    with tempfile.TemporaryDirectory() as directory:
        asyncio.run(scenario(Path(directory)))


def test_command_exit_output() -> None:
    code, output, error = asyncio.run(
        command_module.run_command(
            sys.executable,
            "-c",
            "import sys; sys.stdout.write('output'); sys.stderr.write('error'); sys.exit(7)",
            timeout=TEST_WAIT_SECONDS,
        )
    )
    check(
        "command preserves actual exit code and both output streams",
        (code, output, error) == (7, b"output", b"error"),
    )


def test_private_command_transport() -> None:
    async def scenario():
        payload = b"private bytes" * 10000
        code, stdout, stderr = await command_module.run_command(
            sys.executable,
            "-c",
            "import sys; data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data); sys.stderr.write('done')",
            timeout=TEST_WAIT_SECONDS,
            payload=payload,
            output_limit=len(payload),
        )
        check(
            "private command sends EOF and drains both bounded pipes",
            (code, stdout, stderr) == (0, payload, b"done"),
        )
        original = asyncio.create_subprocess_exec
        children = []

        async def spawn(*arguments, **options):
            child = await original(*arguments, **options)
            children.append(child)
            return child

        with patch.object(command_module.asyncio, "create_subprocess_exec", side_effect=spawn):
            for stream in ("stdout", "stderr"):
                try:
                    await command_module.run_command(
                        sys.executable,
                        "-c",
                        f"import sys,time; sys.{stream}.buffer.write(b'x'*1048576); sys.{stream}.flush(); time.sleep(60)",
                        timeout=TEST_WAIT_SECONDS,
                        payload=b"",
                        output_limit=1024,
                    )
                except command_module.CommandOutputLimitError:
                    check(
                        f"{stream} overflow returns only after child exit",
                        children[-1].returncode is not None,
                    )
                else:
                    check(f"{stream} overflow rejected", False)

    asyncio.run(scenario())


def test_command_repeated_cancellation() -> None:
    async def scenario(boundary: str) -> None:
        create_process = asyncio.create_subprocess_exec
        reached = asyncio.Event()
        release = asyncio.Event()
        processes = []

        async def spawn(*arguments, **options):
            process = await create_process(
                sys.executable, "-c", "import time; time.sleep(60)", **options
            )
            processes.append(process)
            if boundary == "creation":
                reached.set()
                await release.wait()
            else:
                communicate, kill = process.communicate, process.kill

                async def held_communication():
                    await release.wait()
                    return await communicate()

                def observed_kill():
                    kill()
                    reached.set()

                process.communicate = held_communication
                process.kill = observed_kill
            return process

        try:
            with patch.object(command_module.asyncio, "create_subprocess_exec", side_effect=spawn):
                task = asyncio.create_task(
                    command_module.run_command(
                        sys.executable,
                        timeout=0.01 if boundary == "cleanup" else TEST_WAIT_SECONDS,
                    )
                )
                await asyncio.wait_for(reached.wait(), TEST_WAIT_SECONDS)
                task.cancel()
                await asyncio.sleep(0)
                task.cancel()
                await asyncio.sleep(0)
                check(f"{boundary}: repeated cancellation retains ownership", not task.done())
                release.set()
                try:
                    await asyncio.wait_for(task, TEST_WAIT_SECONDS)
                except (asyncio.CancelledError, asyncio.TimeoutError) as error:
                    expected = (
                        asyncio.CancelledError if boundary == "creation" else asyncio.TimeoutError
                    )
                    check(f"{boundary}: original failure is preserved", isinstance(error, expected))
                else:
                    check(f"{boundary}: failure remains explicit", False)
                check(
                    f"{boundary}: process is reaped before failure returns",
                    bool(processes) and processes[0].returncode is not None,
                )
        finally:
            release.set()
            for process in processes:
                if process.returncode is None:
                    process.kill()
                await process.communicate()
                await process.wait()

    asyncio.run(scenario("creation"))
    asyncio.run(scenario("cleanup"))


def test_preflight_process_cleanup() -> None:
    async def scenario(cancelled: bool) -> None:
        create_process = asyncio.create_subprocess_exec
        processes = []
        probe_homes = []
        started = asyncio.Event()

        async def spawn(*arguments, **options):
            home = Path(options["cwd"])
            probe_homes.append(home)
            check("version probe owns a live temporary home", home.is_dir())
            check(
                "version probe does not receive persistent provider configuration",
                "SCHOLARSEED_CODEX_HOME" not in options["env"],
            )
            process = await create_process(
                sys.executable,
                "-c",
                "import sys,time; sys.stdout.buffer.write(b'x' * 1024); sys.stdout.flush(); time.sleep(60)",
                **options,
            )
            processes.append(process)
            started.set()
            return process

        try:
            with (
                patch.object(codex_host.asyncio, "create_subprocess_exec", side_effect=spawn),
                patch.object(codex_host, "CODEX_PREFLIGHT_TIMEOUT_SECONDS", 0.1),
            ):
                task = asyncio.create_task(
                    codex_host._preflight_command(sys.executable, "--version")
                )
                await started.wait()
                if cancelled:
                    task.cancel()
                try:
                    await asyncio.wait_for(task, TEST_WAIT_SECONDS)
                except (codex_host.CodexPreflightTimeout, asyncio.CancelledError):
                    pass
                check(
                    f"preflight {'cancellation' if cancelled else 'timeout'} reaps before returning",
                    bool(processes) and processes[0].returncode is not None,
                )
                check(
                    "version probe removes its temporary home after process exit",
                    bool(probe_homes) and all(not home.exists() for home in probe_homes),
                )
        finally:
            for process in processes:
                if process.returncode is None:
                    process.kill()
                await process.communicate()
                await process.wait()

    asyncio.run(scenario(False))
    asyncio.run(scenario(True))


def test_preflight_output_budget() -> None:
    async def scenario() -> None:
        create_process = asyncio.create_subprocess_exec
        processes = []
        homes = []

        async def spawn(*arguments, **options):
            if options.get("cwd") is not None:
                homes.append(Path(options["cwd"]))
            script = (
                "import sys,time; sys.stdout.buffer.write(b'x' * 1048576); "
                "sys.stdout.flush(); time.sleep(60)"
            )
            process = await create_process(sys.executable, "-c", script, **options)
            processes.append(process)
            return process

        with patch.object(command_module.asyncio, "create_subprocess_exec", side_effect=spawn):
            readiness = await asyncio.wait_for(
                codex_host._probe_codex_cli_readiness(
                    sys.executable,
                ),
                TEST_WAIT_SECONDS,
            )
        check("oversized preflight output is not readiness", not readiness.ready)
        check(
            "oversized authentication output is not a logged-out conclusion",
            readiness.authenticated is None,
        )
        check(
            "preflight overflow has a bounded public error",
            readiness.safe_error == codex_host.CODEX_VERSION_ERROR,
        )
        check(
            "overflow drains every probe before returning",
            all(p.returncode is not None for p in processes),
        )
        check(
            "overflow removes isolated homes after draining",
            bool(homes) and all(not p.exists() for p in homes),
        )

    asyncio.run(scenario())


def test_catalog_process_cleanup() -> None:
    async def scenario(cancelled: bool) -> None:
        create_process = asyncio.create_subprocess_exec
        processes = []
        started = asyncio.Event()

        async def spawn(*arguments, **options):
            process = await create_process(
                sys.executable,
                "-c",
                "import sys,time; sys.stdout.buffer.write(b'x' * 1048576); sys.stdout.flush(); time.sleep(60)",
                **options,
            )
            processes.append(process)
            started.set()
            return process

        request = CodexSessionOpenRequest(
            request_id="catalog-cleanup", runtime_id="codex", cwd=ROOT
        )
        with (
            patch.object(catalog_module, "discover_codex_executable", return_value=sys.executable),
            patch.object(command_module.asyncio, "create_subprocess_exec", side_effect=spawn),
            patch.object(catalog_module, "CATALOG_TIMEOUT_SECONDS", 0.1),
        ):
            task = asyncio.create_task(catalog_module.native_catalog(request))
            await started.wait()
            if cancelled:
                task.cancel()
            try:
                await asyncio.wait_for(task, TEST_WAIT_SECONDS)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
        check(
            f"catalog {'cancellation' if cancelled else 'timeout'} drains and reaps the subprocess",
            bool(processes) and processes[0].returncode is not None,
        )

    asyncio.run(scenario(False))
    asyncio.run(scenario(True))


@patch(
    "scholarseed_codex.pool.CodexHostPool.model_catalog_argument",
    new_callable=AsyncMock,
    return_value=CodexRuntimeLaunchArgument(option="-c", value='model_catalog_json="fixture"'),
)
def test_session_scoped_web_search_projection(_catalog: AsyncMock) -> None:
    print("== session-scoped Web Search ==")

    async def scenario() -> tuple[object, object]:
        regular = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="regular-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        search = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="search-session",
                cwd=ROOT,
                required_capabilities=(RuntimeCapabilityName.WEB_SEARCH,),
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        await regular._apply_model_connection()
        await search._apply_model_connection()
        return regular, search

    regular, search = asyncio.run(scenario())
    regular_config = dict(regular._native.request.thread_config)
    search_config = dict(search._native.request.thread_config)
    descriptor = provider().descriptor.capabilities
    descriptor_states = {row.name: row.state for row in descriptor.entries}
    regular_states = {row.name: row.state for row in regular.capabilities.entries}
    search_states = {row.name: row.state for row in search.capabilities.entries}
    check(
        "provider descriptor declares activatable Web Search",
        descriptor_states.get(RuntimeCapabilityName.WEB_SEARCH.value) is CapabilityState.SUPPORTED,
    )
    check(
        "regular sessions do not enable live Web Search",
        "web_search" not in regular_config
        and regular_states.get(RuntimeCapabilityName.WEB_SEARCH.value)
        is CapabilityState.UNSUPPORTED,
    )
    check(
        "dedicated search sessions enable only their thread",
        search_config.get("web_search") == "live"
        and search_states.get(RuntimeCapabilityName.WEB_SEARCH.value) is CapabilityState.SUPPORTED,
        str(search_config),
    )

    async def rejected_preflight() -> str:
        async def capabilities() -> dict[str, bool]:
            return {"webSearch": False}

        search._native.model_provider_capabilities = capabilities
        try:
            await search._verify_required_capabilities()
        except codex_host.AppServerError as error:
            return error.safe_error
        return ""

    check(
        "provider capability preflight fails before thread creation",
        asyncio.run(rejected_preflight()) == "runtime_web_search_capability_unavailable",
    )


@patch(
    "scholarseed_codex.pool.CodexHostPool.model_catalog_argument",
    new_callable=AsyncMock,
    return_value=CodexRuntimeLaunchArgument(option="-c", value='model_catalog_json="fixture"'),
)
def test_chat_models_explicitly_disable_native_search(_catalog: AsyncMock) -> None:
    async def scenario() -> None:
        intent = ModelIntent(
            model_ref="local-model",
            transport=ModelTransport(
                mode=ModelConnectionMode.REMOTE,
                endpoint="http://127.0.0.1:1234/v1",
                wire_protocol=ModelWireProtocol.CHAT_COMPLETIONS,
            ),
            capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
        )
        session = CodexRuntimeSession(
            OpenSessionRequest(product_session_id="chat-session", cwd=ROOT, model=intent)
        )
        await session._apply_model_connection()
        assert session._native.request.thread_config.get("web_search") == "disabled"
        bridged = replace(
            intent,
            transport=replace(intent.transport, wire_protocol=ModelWireProtocol.RESPONSES),
            capabilities=replace(intent.capabilities, native_web_search=False),
        )
        bridged_session = CodexRuntimeSession(
            OpenSessionRequest(product_session_id="bridge-session", cwd=ROOT, model=bridged)
        )
        await bridged_session._apply_model_connection()
        assert bridged_session._native.request.thread_config.get("web_search") == "disabled"
        requested = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="chat-search",
                cwd=ROOT,
                model=intent,
                required_capabilities=(RuntimeCapabilityName.WEB_SEARCH,),
            )
        )
        await requested._apply_model_connection()
        assert requested._native.request.thread_config.get("web_search") == "disabled"
        assert (
            next(
                entry.state
                for entry in requested.capabilities.entries
                if entry.name == RuntimeCapabilityName.WEB_SEARCH.value
            )
            is CapabilityState.UNSUPPORTED
        )
        requested._native.model_provider_capabilities = AsyncMock(return_value={"webSearch": True})
        try:
            await requested._verify_required_capabilities()
        except codex_host.AppServerError as error:
            assert error.safe_error == "runtime_web_search_capability_unavailable"
        else:
            raise AssertionError("Chat Completions cannot activate Responses native search")

    asyncio.run(scenario())


@patch(
    "scholarseed_codex.pool.CodexHostPool.model_catalog_argument",
    new_callable=AsyncMock,
    return_value=CodexRuntimeLaunchArgument(option="-c", value='model_catalog_json="fixture"'),
)
def test_optional_native_search_negotiation(_catalog: AsyncMock) -> None:
    async def scenario() -> None:
        responses = ModelIntent(
            transport=ModelTransport(
                endpoint="https://model.example.test/v1", supports_websockets=True
            )
        )
        cases = (
            (responses, True, True),
            (responses, False, False),
            (
                replace(responses, capabilities=ModelCapabilities(native_web_search=False)),
                True,
                False,
            ),
            (
                replace(
                    responses,
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1",
                        wire_protocol=ModelWireProtocol.CHAT_COMPLETIONS,
                    ),
                ),
                True,
                False,
            ),
        )
        for index, (intent, upstream_support, enabled) in enumerate(cases):
            session = CodexRuntimeSession(
                OpenSessionRequest(
                    product_session_id=f"optional-{index}",
                    cwd=ROOT,
                    model=intent,
                    optional_capabilities=(RuntimeCapabilityName.WEB_SEARCH,),
                )
            )
            session._native.model_provider_capabilities = AsyncMock(
                return_value={"webSearch": upstream_support}
            )
            await session._apply_model_connection()
            await session._verify_required_capabilities()
            assert session._native.request.thread_config.get("web_search") == (
                "live" if enabled else "disabled"
            )
            state = next(
                entry.state
                for entry in session.capabilities.entries
                if entry.name == RuntimeCapabilityName.WEB_SEARCH.value
            )
            assert state is (CapabilityState.SUPPORTED if enabled else CapabilityState.UNSUPPORTED)
            if not native_web_search_supported(intent):
                session._native.model_provider_capabilities.assert_not_awaited()
            binding = RuntimeBinding(
                product_session_id=f"optional-{index}",
                runtime_id="codex",
                adapter_version="fixture",
                runtime_version="fixture",
                protocol_version="2",
                protocol_schema_hash="fixture",
                opaque_session_ref="thread",
                capabilities=session.capabilities,
                optional_capabilities=(RuntimeCapabilityName.WEB_SEARCH,),
            )
            resumed = provider()._open_request(
                ResumeSessionRequest(
                    binding=binding,
                    cwd=ROOT,
                    model=ModelIntent(
                        transport=ModelTransport(
                            endpoint="https://model.example.test/v1", supports_websockets=True
                        )
                    ),
                )
            )
            assert resumed.required_capabilities == ()
            assert resumed.optional_capabilities == (RuntimeCapabilityName.WEB_SEARCH,)

        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="cancel-optional",
                cwd=ROOT,
                optional_capabilities=(RuntimeCapabilityName.WEB_SEARCH,),
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        for failure in (asyncio.CancelledError(), AppServerError("provider unavailable")):
            session._native.model_provider_capabilities = AsyncMock(side_effect=failure)
            try:
                await session._verify_required_capabilities()
            except BaseException as error:
                assert error is failure
            else:
                raise AssertionError("optional capabilities must not hide operational failures")

        for required, optional in (
            ((), (RuntimeCapabilityName.WEB_SEARCH, RuntimeCapabilityName.WEB_SEARCH)),
            ((RuntimeCapabilityName.WEB_SEARCH,), (RuntimeCapabilityName.WEB_SEARCH,)),
        ):
            try:
                CodexRuntimeSession(
                    OpenSessionRequest(
                        product_session_id="invalid",
                        cwd=ROOT,
                        required_capabilities=required,
                        optional_capabilities=optional,
                        model=ModelIntent(
                            transport=ModelTransport(
                                endpoint="https://model.example.test/v1", supports_websockets=True
                            )
                        ),
                    )
                )
            except ValueError:
                pass
            else:
                raise AssertionError("invalid capability intent must be rejected")

    asyncio.run(scenario())
    check(
        "optional search negotiates actual model/provider and survives resume without escalation",
        True,
    )


def test_opaque_launch_secret_projection() -> None:
    print("== opaque launch-secret projection ==")

    class Secrets:
        async def resolve(self, secret_ref: str) -> RuntimeSecret:
            if secret_ref != "opaque-skill-ref":
                raise ValueError("unexpected secret reference")
            return RuntimeSecret("skill-secret-value")

    async def scenario() -> tuple[dict[str, str], dict[str, str], str, str, list[str]]:
        request = OpenSessionRequest(
            product_session_id="launch-secret-session",
            cwd=ROOT,
            launch_secrets=LaunchSecretIntent(
                bindings=(
                    LaunchSecret("SCHOLARSEED_API_KEY", "opaque-skill-ref"),
                    LaunchSecret(
                        "SCHOLARSEED_BRIDGE_TOKEN",
                        "opaque-skill-ref",
                        LaunchSecretScope.TOOL,
                    ),
                ),
                revision="launch-secrets:test",
                remove_environment=("PARENT_SECRET",),
            ),
            secret_port=Secrets(),
            model=ModelIntent(
                transport=ModelTransport(
                    endpoint="https://model.example.test/v1", supports_websockets=True
                )
            ),
        )
        environment, tool_environment = await _resolve_launch_secrets(request)
        session = CodexRuntimeSession(
            request, launch_environment=environment, tool_environment=tool_environment
        )
        check(
            "generic environment removals reach native request",
            session._native.request.remove_environment == ("PARENT_SECRET",),
        )
        failures: list[str] = []
        for bindings in (
            (LaunchSecret("INVALID-NAME", "opaque-skill-ref"),),
            (
                LaunchSecret("SCHOLARSEED_API_KEY", "opaque-skill-ref"),
                LaunchSecret("SCHOLARSEED_API_KEY", "opaque-skill-ref"),
            ),
        ):
            try:
                await _resolve_launch_secrets(
                    OpenSessionRequest(
                        product_session_id="invalid-launch-secret",
                        cwd=ROOT,
                        launch_secrets=LaunchSecretIntent(bindings=bindings),
                        secret_port=Secrets(),
                        model=ModelIntent(
                            transport=ModelTransport(
                                endpoint="https://model.example.test/v1", supports_websockets=True
                            )
                        ),
                    )
                )
            except ValueError as error:
                failures.append(str(error))
        return (
            dict(session._native.request.process_environment),
            dict(session._tool_environment),
            repr(request),
            repr(session._request),
            failures,
        )

    environment, tool_environment, request_repr, retained_repr, failures = asyncio.run(scenario())
    check(
        "adapter injects process-scoped product secret into the official Codex environment",
        environment.get("SCHOLARSEED_API_KEY") == "skill-secret-value",
    )
    check(
        "thread tool secret never enters the shared App Server environment",
        "SCHOLARSEED_BRIDGE_TOKEN" not in environment
        and tool_environment.get("SCHOLARSEED_BRIDGE_TOKEN") == "skill-secret-value",
    )
    check(
        "Gateway request and retained session state never expose secret material",
        "skill-secret-value" not in request_repr and "skill-secret-value" not in retained_repr,
    )
    check(
        "adapter discards the secret resolver after admission", "secret_port=None" in retained_repr
    )
    check(
        "invalid and duplicate child environment names fail closed",
        failures
        == [
            "runtime secret environment name is invalid",
            "runtime secret environment name is duplicated",
        ],
        str(failures),
    )


def test_runtime_home_resolution_precedes_storage_mutation() -> None:
    with tempfile.TemporaryDirectory(prefix="codex-home-resolution-") as temporary:
        root = Path(temporary)
        selected = root / "selected" / "资料"
        default = root / "default"
        inherited = root / "personal-source"
        with (
            patch.object(codex_environment, "CODEX_RUNTIME_HOME", default),
            patch.dict(
                "os.environ",
                {"SCHOLARSEED_CODEX_HOME": str(selected), "CODEX_HOME": str(inherited)},
            ),
        ):
            check(
                "runtime home resolves configured target before creation",
                codex_environment.runtime_home() == selected.resolve() and not selected.exists(),
            )
            check(
                "explicit empty environment selects owner default",
                codex_environment.runtime_home({}) == default.resolve() and not default.exists(),
            )
            check(
                "personal CODEX_HOME does not override isolated storage",
                codex_environment.runtime_home({"CODEX_HOME": str(inherited)}) == default.resolve(),
            )
            check(
                "explicit runtime environment is independent of process selection",
                codex_environment.runtime_home({"SCHOLARSEED_CODEX_HOME": str(default)})
                == default.resolve(),
            )
            prepared = codex_environment.prepare_codex_runtime_home()
            check(
                "preparation uses the same public owner resolver",
                prepared == selected.resolve() and prepared.is_dir(),
            )
            check(
                "resolution does not prepare default or personal source",
                not default.exists() and not inherited.exists(),
            )


def test_sqlite_storage_declaration_and_launch() -> None:
    with tempfile.TemporaryDirectory(prefix="codex-sqlite-storage-") as temporary:
        root = Path(temporary)
        home = root / "runtime"
        database = root / "independent database"
        inherited = {
            "SCHOLARSEED_CODEX_HOME": str(home),
            "CODEX_SQLITE_HOME": str(database),
        }
        check(
            "independent SQLite storage is declared without mutation",
            codex_environment.runtime_storage_roots(inherited)
            == (home.resolve(), database.resolve())
            and not home.exists()
            and not database.exists(),
        )
        check(
            "SQLite sharing the runtime home has one declaration",
            codex_environment.runtime_storage_roots({**inherited, "CODEX_SQLITE_HOME": str(home)})
            == (home.resolve(),),
        )
        environment, _ = codex_isolation.managed_codex_launch(
            home, {}, (), inherited_environment=inherited
        )
        check(
            "launch freezes declared SQLite selection without creating it",
            environment["CODEX_SQLITE_HOME"] == str(database.resolve()) and not database.exists(),
        )
        environment, _ = codex_isolation.managed_codex_launch(
            home, {}, (), inherited_environment={}
        )
        check(
            "launch freezes an absent SQLite environment override",
            environment["CODEX_SQLITE_HOME"] == "",
        )
        rejected_home = root / "rejected"
        for requested in (str(root / "other"), "", "relative"):
            try:
                codex_isolation.managed_codex_launch(
                    rejected_home,
                    {"CODEX_SQLITE_HOME": requested},
                    (),
                    inherited_environment=inherited,
                )
            except ValueError:
                check(
                    "undeclared session storage rejected before preparation",
                    not rejected_home.exists(),
                )
            else:
                check("undeclared session storage rejected before preparation", False)
        with patch.dict(
            "os.environ",
            {
                "SCHOLARSEED_CODEX_HOME": str(rejected_home),
                "CODEX_SQLITE_HOME": "relative",
            },
        ):
            try:
                codex_environment.prepare_codex_runtime_home()
            except ValueError:
                check(
                    "ambiguous SQLite root rejected before credential preparation",
                    not rejected_home.exists(),
                )
            else:
                check("ambiguous SQLite root rejected before credential preparation", False)
        with patch.object(codex_environment, "ENVIRONMENT_NAME_CASE_INSENSITIVE", True):
            check(
                "Windows SQLite environment names are case insensitive",
                codex_environment.runtime_sqlite_home({"Codex_Sqlite_Home": str(database)})
                == database.resolve(),
            )
            try:
                codex_environment.runtime_sqlite_home(
                    {
                        "CODEX_SQLITE_HOME": str(database),
                        "codex_sqlite_home": str(home),
                    }
                )
            except ValueError:
                check("conflicting Windows SQLite environment names rejected", True)
            else:
                check("conflicting Windows SQLite environment names rejected", False)


def test_home_config_storage_discovery() -> None:
    with tempfile.TemporaryDirectory(prefix="codex-config-storage-") as temporary:
        root = Path(temporary)
        home = root / "runtime"
        home.mkdir()
        config = home / codex_environment.CODEX_CONFIG_FILENAME
        database = root / "database"
        environment = {
            "SCHOLARSEED_CODEX_HOME": str(home),
            "CODEX_SQLITE_HOME": str(database),
        }
        content = 'sqlite_home="../configured database"\nlog_dir="logs/资料"\n'
        config.write_text(content, encoding="utf-8")

        class Inspection:
            qualified = False
            reads = 0

            def selected(self, path):
                return self.qualified and path == str(home.resolve())

            def read(self, path, name, maximum):
                assert self.selected(path)
                assert name == codex_environment.CODEX_CONFIG_FILENAME
                self.reads += 1
                data = config.read_bytes()
                assert len(data) <= maximum
                return data

        inspection = Inspection()
        check(
            "initial declaration never opens config without qualification",
            codex_environment.runtime_storage_roots(environment)
            == (home.resolve(), database.resolve())
            and codex_environment.runtime_storage_roots(environment, inspection=inspection)
            == (home.resolve(), database.resolve())
            and inspection.reads == 0,
        )
        inspection.qualified = True
        expected = (
            home.resolve(),
            database.resolve(),
            (root / "configured database").resolve(),
            (home / "logs" / "资料").resolve(),
        )
        with patch.dict("os.environ", environment):
            declarations = provider().storage_roots(inspection)
        check(
            "provider declares environment and Home config roots conservatively",
            tuple(row.path for row in declarations) == expected
            and all(row.create for row in declarations)
            and all(not path.exists() for path in expected[1:])
            and config.read_text(encoding="utf-8") == content,
        )
        config.write_text('sqlite_home="~/database"\nlog_dir="~"\n', encoding="utf-8")
        check(
            "config tilde belongs to the managed child Home",
            codex_environment.runtime_storage_roots(environment, inspection=inspection)
            == (
                home.resolve(),
                database.resolve(),
                (home / codex_isolation.CODEX_DISCOVERY_HOME_DIRNAME / "database").resolve(),
                (home / codex_isolation.CODEX_DISCOVERY_HOME_DIRNAME).resolve(),
            ),
        )
        config.write_text('sqlite_home="."\nlog_dir="."\n', encoding="utf-8")
        check(
            "config roots deduplicate without changing storage selection",
            codex_environment.runtime_storage_roots(environment, inspection=inspection)
            == (home.resolve(), database.resolve()),
        )
        for invalid in ("sqlite_home=3\n", 'log_dir=["x"]\n', 'sqlite_home="unfinished'):
            config.write_text(invalid, encoding="utf-8")
            with (
                patch.dict("os.environ", environment),
                patch.object(Path, "mkdir") as prepare,
            ):
                try:
                    provider().storage_roots(inspection)
                except ValueError:
                    check(
                        "invalid storage config cannot prepare storage",
                        not prepare.called,
                    )
                else:
                    check("invalid storage config cannot prepare storage", False)
            check(
                "invalid config is preserved for diagnosis",
                config.read_text(encoding="utf-8") == invalid,
            )


def test_runtime_preparation_preserves_existing_directories() -> None:
    with tempfile.TemporaryDirectory(prefix="codex-existing-home-") as temporary:
        root = Path(temporary)
        runtime = root / "runtime"
        discovery = runtime / codex_isolation.CODEX_DISCOVERY_HOME_DIRNAME
        directories = (
            runtime,
            discovery,
            discovery / codex_isolation.XDG_CONFIG_DIRNAME,
            discovery / codex_isolation.CLAUDE_CONFIG_DIRNAME,
        )
        for directory in directories:
            directory.mkdir()
            (directory / "existing.txt").write_bytes(b"preserve user data")
        try:
            for directory in directories:
                directory.chmod(stat.S_IREAD if os.name == "nt" else 0o750)
            before = {directory: directory.stat() for directory in directories}
            if os.name == "nt":
                assert all(
                    value.st_file_attributes & stat.FILE_ATTRIBUTE_READONLY
                    for value in before.values()
                )
            with patch.dict(os.environ, {"SCHOLARSEED_CODEX_HOME": str(runtime)}):
                codex_environment.prepare_codex_runtime_home()
                codex_isolation.managed_codex_launch(
                    runtime,
                    {},
                    (),
                    inherited_environment={
                        "HOME": str(root / "personal"),
                        "USERPROFILE": str(root / "personal"),
                        "XDG_CONFIG_HOME": str(root / "personal-config"),
                        "CLAUDE_CONFIG_DIR": str(root / "personal-claude"),
                    },
                )
            for directory in directories:
                original, actual = before[directory], directory.stat()
                mode_unchanged = (
                    original.st_file_attributes == actual.st_file_attributes
                    if os.name == "nt"
                    else stat.S_IMODE(original.st_mode) == stat.S_IMODE(actual.st_mode)
                )
                check(f"existing {directory.name} permissions are unchanged", mode_unchanged)
                check(
                    f"existing {directory.name} identity and contents are unchanged",
                    (original.st_dev, original.st_ino) == (actual.st_dev, actual.st_ino)
                    and (directory / "existing.txt").read_bytes() == b"preserve user data",
                )
        finally:
            for directory in directories:
                directory.chmod(stat.S_IREAD | stat.S_IWRITE if os.name == "nt" else 0o700)


def test_environment_removal() -> None:
    async def scenario() -> None:
        with patch.dict("os.environ", {"PARENT_SECRET": "parent-fixture", "UNCHANGED": "keep"}):
            host = CodexProcessHost(
                executable="codex",
                process_environment={"MODEL_KEY": "model-fixture"},
                remove_environment=("PARENT_SECRET",),
            )
        spawn = AsyncMock(side_effect=OSError("contract spawn stopped"))
        with (
            patch.dict("os.environ", {"PARENT_SECRET": "parent-fixture", "UNCHANGED": "keep"}),
            patch("scholarseed_codex.process.asyncio.create_subprocess_exec", spawn),
        ):
            try:
                await host._start_process()
            except Exception:
                pass
        environment = spawn.call_args.kwargs["env"]
        check(
            "child environment removes inherited secret and preserves model settings",
            "PARENT_SECRET" not in environment
            and environment["MODEL_KEY"] == "model-fixture"
            and environment["UNCHANGED"] == "keep",
        )
        with patch.dict("os.environ", {"PARENT_SECRET": "parent-fixture"}):
            check(
                "removed parent cannot re-enter through launch arguments",
                codex_host._resolve_launch_arguments(
                    (CodexRuntimeLaunchArgument(option="--key", environment="PARENT_SECRET"),),
                    {},
                )
                == (),
            )
        pool = CodexHostPool(CapacityPolicy(execution_hosts=TEST_POOL_CAPACITY))
        ready = SimpleNamespace(
            ready=True,
            status=CodexRuntimeStatus.READY,
            safe_error="",
            executable="codex",
            version="test",
        )
        with (
            patch.dict(os.environ, {"PARENT_SECRET": "parent-fixture"}),
            patch.object(pool_module, "_probe_codex_cli_readiness", AsyncMock(return_value=ready)),
            patch.object(pool_module, "CodexProcessHost", ControlledHost),
        ):
            first = await pool.acquire(
                CodexSessionOpenRequest(request_id="a", runtime_id="codex", cwd=ROOT)
            )
            rejected = await pool.reserve(
                CodexSessionOpenRequest(
                    request_id="b",
                    runtime_id="codex",
                    cwd=ROOT,
                    remove_environment=("PARENT_SECRET",),
                ),
                role=HostRole.EXECUTION,
                request_id="b",
                deadline=time() + TEST_WAIT_SECONDS,
            )
            check(
                "different effective secret environments reject without another execution host",
                rejected.state is ResourceState.REJECTED
                and rejected.safe_error == RESOURCE_HOST_CONFIGURATION_CONFLICT
                and pool.snapshot()[0].used == 1
                and first.host.arguments["remove_environment"] == (),
            )
            await pool.aclose()

    asyncio.run(scenario())


def test_managed_codex_isolation() -> None:
    print("== managed Codex isolation ==")
    with tempfile.TemporaryDirectory() as temporary:
        runtime_home = Path(temporary) / "codex runtime"
        inherited = {
            "HOME": "/Users/research user",
            "USERPROFILE": r"C:\Users\research user",
            "XDG_CONFIG_HOME": "/Users/research user/.config",
        }
        environment, arguments = codex_isolation.managed_codex_launch(
            runtime_home,
            {
                "MODEL_KEY": "model-fixture",
                codex_isolation.CODEX_REMOTE_CONTROL_DISABLED_ENV: "0",
            },
            (
                CodexRuntimeLaunchArgument(option="--strict-config"),
                CodexRuntimeLaunchArgument(option="-c", value="project_doc_max_bytes=999"),
                CodexRuntimeLaunchArgument(option="-c", value="features.plugins=true"),
            ),
            inherited_environment=inherited,
        )
        discovery_home = runtime_home.resolve() / codex_isolation.CODEX_DISCOVERY_HOME_DIRNAME
        resolved = codex_host._resolve_launch_arguments(arguments, environment)
        check(
            "managed process uses only the product Codex and discovery homes",
            environment["CODEX_HOME"] == str(runtime_home.resolve())
            and environment["HOME"] == str(discovery_home)
            and environment["USERPROFILE"] == str(discovery_home)
            and environment["XDG_CONFIG_HOME"]
            == str(discovery_home / codex_isolation.XDG_CONFIG_DIRNAME)
            and environment["MODEL_KEY"] == "model-fixture"
            and discovery_home.is_dir(),
            str(environment),
        )
        check(
            "managed App Server disables unused ChatGPT Remote Control",
            environment[codex_isolation.CODEX_REMOTE_CONTROL_DISABLED_ENV]
            == codex_isolation.CODEX_REMOTE_CONTROL_DISABLED_VALUE,
        )
        check(
            "managed flags override ambient project instructions and extensions",
            resolved.count("--strict-config") == 1
            and resolved[-2:]
            == (
                "-c",
                'shell_environment_policy.set.XDG_CONFIG_HOME="/Users/research user/.config"',
            )
            and "project_root_markers=[]" in resolved
            and "project_doc_max_bytes=0" in resolved
            and "mcp_servers={}" in resolved
            and "plugins={}" in resolved
            and "marketplaces={}" in resolved
            and "hooks={}" in resolved
            and "features.skip_host_skill_discovery=true" not in resolved,
            str(resolved),
        )
        check(
            "managed plugin gate overrides caller enablement",
            resolved.index("features.plugins=false") > resolved.index("features.plugins=true"),
            str(resolved),
        )
        check(
            "spawned shells retain the original cross-platform home values",
            'shell_environment_policy.set.HOME="/Users/research user"' in resolved
            and 'shell_environment_policy.set.USERPROFILE="C:\\\\Users\\\\research user"'
            in resolved,
            str(resolved),
        )
        check(
            "managed launch preserves the native default shell exclusion policy",
            not any(
                "shell_environment_policy.ignore_default_excludes" in value for value in resolved
            ),
            str(resolved),
        )


def test_control_borrows_execution_host() -> None:
    readiness = CodexRuntimeReadiness(
        runtime_id="codex",
        status=CodexRuntimeStatus.READY,
        ready=True,
        executable="/runtime/codex",
        version="codex-cli 0.147.0",
    )

    async def scenario() -> None:
        pool = CodexHostPool(CapacityPolicy(execution_hosts=1, control_hosts=1))
        with (
            patch("scholarseed_codex.pool._probe_codex_cli_readiness", return_value=readiness),
            patch("scholarseed_codex.pool.CodexProcessHost", ControlledHost),
        ):
            request = CodexSessionOpenRequest(
                request_id="execution-first",
                runtime_id="codex",
                cwd=ROOT,
                executable="/runtime/codex",
                process_sharing_scope="fixture-actor",
            )
            execution = await pool.acquire(request)
            control = await pool.acquire(replace(request, request_id="inventory"))
            check(
                "execution and inventory borrow the same physical host",
                control.host is execution.host and [row.used for row in pool.snapshot()] == [1, 0],
            )
            await control.close()
            check("inventory close does not close execution", not execution.host.closed)
            try:
                await pool.acquire(
                    replace(
                        request,
                        request_id="incompatible",
                        process_environment={"CODEX_HOME": "/other"},
                    )
                )
            except AppServerError as error:
                check(
                    "incompatible control rejects explicitly",
                    error.safe_error == RESOURCE_HOST_CONFIGURATION_CONFLICT,
                )
            else:
                check("incompatible control cannot allocate a fallback host", False)
            await execution.close()
            check("zero owners retain the shared host", not execution.host.closed)
            await pool.aclose()
            check("application shutdown owns physical exit", execution.host.closed)

    asyncio.run(scenario())


@patch(
    "scholarseed_codex.pool.CodexHostPool.model_catalog_argument",
    new_callable=AsyncMock,
    return_value=CodexRuntimeLaunchArgument(option="-c", value='model_catalog_json="fixture"'),
)
def test_session_skill_root_projection(_catalog: AsyncMock) -> None:
    print("== skill roots survive session admission and resume ==")
    roots = (ROOT / "bundled-skills", ROOT / "user-skills")
    configurations = (SkillConfiguration(roots[0] / "private" / "SKILL.md", False),)
    request = OpenSessionRequest(
        product_session_id="skill-roots",
        cwd=ROOT,
        skill_roots=roots,
        skill_configurations=configurations,
        model=ModelIntent(
            transport=ModelTransport(
                endpoint="https://model.example.test/v1", supports_websockets=True
            )
        ),
    )
    session = CodexRuntimeSession(request)
    check(
        "open projects product-selected skill roots", session._native.request.skill_roots == roots
    )
    check(
        "neutral callers do not acquire product-specific defaults",
        OpenSessionRequest(
            product_session_id="neutral",
            cwd=ROOT,
            model=ModelIntent(
                transport=ModelTransport(
                    endpoint="https://model.example.test/v1", supports_websockets=True
                )
            ),
        ).skill_roots
        == (),
    )
    descriptor = provider().descriptor
    binding = RuntimeBinding(
        product_session_id=request.product_session_id,
        runtime_id=descriptor.runtime_id,
        adapter_version=descriptor.adapter_version,
        runtime_version="fixture",
        protocol_version=descriptor.protocol_version,
        protocol_schema_hash=descriptor.protocol_schema_hash,
        opaque_session_ref="native-skill-roots",
        capabilities=descriptor.capabilities,
    )

    class Host(ControlledHost):
        def __init__(self, **arguments):
            super().__init__(**arguments)
            self.readiness.version = binding.runtime_version
            self.request = AsyncMock(return_value={"webSearch": True})
            self.close_thread = AsyncMock()

    async def admitted(instance: CodexThreadSession) -> None:
        instance.session_id = instance.request.resume_session_id
        instance._opened = True

    async def resume() -> CodexRuntimeSession:
        runtime = provider()

        async def connection(*args, **kwargs):
            projected = await model_connection(*args, **kwargs)
            return replace(projected, provider_configuration={})

        readiness = CodexRuntimeReadiness(
            runtime_id="codex",
            status=CodexRuntimeStatus.READY,
            ready=True,
            executable="/contract/codex",
            version=binding.runtime_version,
        )
        with (
            patch.object(
                pool_module, "_probe_codex_cli_readiness", AsyncMock(return_value=readiness)
            ),
            patch.object(pool_module, "CodexProcessHost", Host),
            patch("scholarseed_codex.session.model_connection", side_effect=connection),
            patch("scholarseed_codex.pool.prepare_codex_runtime_home", return_value=ROOT),
            patch.object(CodexThreadSession, "open", admitted),
            patch(
                "asyncio.create_subprocess_exec",
                side_effect=AssertionError("contract cannot launch a process"),
            ),
        ):
            request = ResumeSessionRequest(
                binding=binding,
                cwd=ROOT,
                skill_roots=roots,
                skill_configurations=configurations,
                process_sharing_scope="resume-owner",
                execution_environment={"TEXMFVAR": str(ROOT / "resume-cache")},
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
            receipt = await runtime.reserve(
                ResourceRequest(
                    "skill-roots-resume",
                    ResourcePurpose.SESSION,
                    time() + TEST_WAIT_SECONDS,
                    request,
                )
            )
            check("resume has an explicit resource grant", receipt.state is ResourceState.GRANTED)
            resumed = None
            try:
                resumed = await runtime.resume(
                    replace(request, reservation_id=receipt.reservation_id)
                )
                check(
                    "resume owns the granted lease",
                    resumed._native.lease is not None
                    and resumed._native.lease.lease_id == receipt.reservation_id,
                )
                return resumed
            finally:
                if resumed is not None:
                    await resumed.detach()
                await runtime.shutdown()

    resumed = asyncio.run(resume())
    check(
        "resume preserves the same native authentication sharing context",
        resumed._request.process_sharing_scope == "resume-owner"
        and resumed._request.execution_environment == {"TEXMFVAR": str(ROOT / "resume-cache")}
        and resumed._native.request.thread_config.get("shell_environment_policy.set.TEXMFVAR")
        == str(ROOT / "resume-cache")
        and resumed._native.request.process_sharing_scope == "resume-owner",
    )
    check(
        "resume applies per-session skill rules without a global write",
        resumed._native.request.thread_config.get("skills")
        == session_skill_config(configurations)["skills"],
    )
    check(
        "resume retains roots and the native thread identity",
        resumed._native.request.skill_roots == roots
        and resumed._native.request.resume_session_id == binding.opaque_session_ref
        and resumed.binding.opaque_session_ref == binding.opaque_session_ref
        and resumed.binding.runtime_id == binding.runtime_id
        and resumed._required_capabilities == frozenset((RuntimeCapabilityName.WEB_SEARCH,)),
    )


def test_session_shell_environment_configuration() -> None:
    async def configure(
        tool_environment: dict[str, str], execution_environment: dict[str, str] | None = None
    ) -> dict:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="shell-environment",
                cwd=ROOT,
                execution_environment=execution_environment or {},
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            ),
            tool_environment=tool_environment,
        )
        configured = await session._configure_model_connection(
            session._request.model, session._native.request, session._request.credential_port
        )
        return dict(configured.thread_config)

    check(
        "empty tool environment leaves the native shell policy unset",
        "shell_environment_policy" not in asyncio.run(configure({})),
    )
    tool_environment = {"CUSTOM_SKILL_API_KEY": "fixture", "CUSTOM_SKILL_CONFIG": "fixture-path"}
    check(
        "explicit tool environment retains core inheritance and arbitrary bindings",
        asyncio.run(configure(tool_environment)).items()
        >= {
            "shell_environment_policy.inherit": "core",
            **{
                f"shell_environment_policy.set.{name}": value
                for name, value in tool_environment.items()
            },
        }.items(),
    )
    execution_environment = {"TEXMFVAR": str(ROOT / "session-a-cache")}
    config = asyncio.run(configure({}, execution_environment))
    check(
        "ordinary execution environment preserves native inheritance and managed HOME restoration",
        config.get("shell_environment_policy.set.TEXMFVAR") == execution_environment["TEXMFVAR"]
        and "shell_environment_policy" not in config
        and "shell_environment_policy.inherit" not in config
        and "shell_environment_policy.ignore_default_excludes" not in config,
    )
    combined = asyncio.run(configure(tool_environment, execution_environment))
    check(
        "ordinary variables do not widen explicit TOOL credential inheritance",
        combined.get("shell_environment_policy.inherit") == "core"
        and combined.get("shell_environment_policy.set.TEXMFVAR")
        == execution_environment["TEXMFVAR"],
    )
    for invalid in (
        {"CUSTOM_SKILL_API_KEY": "overwritten-secret"},
        {"HOME": "/other-home"},
        {"invalid.name": "value"},
        {"SCHOLARSEED_MCP_SECRET_0": "forbidden"},
    ):
        try:
            asyncio.run(configure(tool_environment, invalid))
        except ValueError:
            check("conflicting or invalid execution environment is rejected", True)
        else:
            check("conflicting or invalid execution environment is rejected", False)


def test_session_skill_configuration() -> None:
    print("== transient per-session skill configuration ==")
    restricted_path = ROOT / "skills" / "restricted" / "SKILL.md"
    available_path = ROOT / "skills" / "available" / "SKILL.md"
    configurations = (
        SkillConfiguration(restricted_path, False),
        SkillConfiguration(available_path, True),
    )

    async def configure() -> dict:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="skill-config",
                cwd=ROOT,
                skill_configurations=configurations,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        configured = await session._configure_model_connection(
            session._request.model, session._native.request, session._request.credential_port
        )
        return dict(configured.thread_config)

    config = asyncio.run(configure())
    check(
        "sessions without tool bindings preserve the native shell policy",
        "shell_environment_policy" not in config,
    )
    check(
        "open translates neutral skill rules into native session configuration",
        config["skills"]
        == {
            "config": [
                {"path": str(restricted_path), "enabled": False},
                {"path": str(available_path), "enabled": True},
            ]
        },
    )
    check("unspecified skill rules preserve native defaults", session_skill_config(()) == {})
    inventory = SkillInventory(
        cwd=ROOT,
        revision="native-skills",
        skills=(
            SkillView("restricted", restricted_path, "", SkillAvailability.AVAILABLE, True),
            SkillView("available", available_path, "", SkillAvailability.DISABLED, False),
        ),
    )
    effective = session_skill_inventory(inventory, configurations)
    check(
        "session inventory reflects transient rules in both directions",
        not effective.skills[0].enabled
        and effective.skills[0].availability is SkillAvailability.DISABLED
        and effective.skills[1].enabled
        and effective.skills[1].availability is SkillAvailability.AVAILABLE,
    )
    check(
        "session projection does not mutate control inventory",
        inventory.skills[0].enabled and not inventory.skills[1].enabled,
    )
    if os.name == "nt":
        plain = Path(str(restricted_path).removeprefix("\\\\?\\"))
        extended = Path("\\\\?\\" + str(plain))
    else:
        plain = restricted_path
        extended = restricted_path.parent / "." / restricted_path.name
    for configured, reported in ((plain, extended), (extended, plain)):
        native = replace(
            inventory,
            skills=(replace(inventory.skills[0], path=reported),),
        )
        projected = session_skill_inventory(native, (SkillConfiguration(configured, False),))
        check("equivalent skill paths apply session disables", not projected.skills[0].enabled)
        disabled = replace(native, skills=(replace(native.skills[0], enabled=False),))
        check(
            "equivalent skill paths apply session enables",
            session_skill_inventory(disabled, (SkillConfiguration(configured, True),))
            .skills[0]
            .enabled,
        )

        async def verify_configuration() -> None:
            @asynccontextmanager
            async def mutation():
                yield

            @asynccontextmanager
            async def control(**_context):
                yield SimpleNamespace(
                    mutation=mutation,
                    skill_control=SimpleNamespace(
                        configure=AsyncMock(), list_skills=AsyncMock(return_value=native)
                    ),
                )

            runtime = provider()
            runtime._control = control
            receipt = await runtime.configure_skills(
                SkillConfigurationRequest(ROOT, (SkillConfiguration(configured, True),))
            )
            check(
                "configuration readback accepts equivalent paths",
                receipt.state is CommandState.APPLIED,
            )

        asyncio.run(verify_configuration())
        errored = replace(
            native, skills=(replace(native.skills[0], availability=SkillAvailability.ERROR),)
        )
        check(
            "session rules preserve native skill errors",
            session_skill_inventory(errored, (SkillConfiguration(configured, True),))
            .skills[0]
            .availability
            is SkillAvailability.ERROR,
        )
        selected = skill_inputs(
            TurnInput((InputItem(InputKind.SKILL, name="restricted", path=configured),))
        )
        check(
            "equivalent skill reads retain skill activity identity",
            skill_for_command(
                selected, {"commandActions": [{"type": "read", "path": str(reported)}]}
            )
            is not None,
        )
        check(
            "another manifest never inherits skill activity identity",
            skill_for_command(
                selected,
                {"commandActions": [{"type": "read", "path": str(reported.parent / "other.md")}]},
            )
            is None,
        )
    check(
        "transient availability participates in the inventory revision",
        effective.revision != inventory.revision
        and effective.revision == session_skill_inventory(inventory, configurations).revision
        and effective.revision
        != session_skill_inventory(
            inventory, (SkillConfiguration(restricted_path, True),)
        ).revision,
    )


def test_permission_intent_projection() -> None:
    print("== permission intent projection ==")
    expected = {
        RuntimePermissionMode.ASK: ("workspace-write", "on-request", "user"),
        RuntimePermissionMode.SAFE_AUTO: ("workspace-write", "on-request", "auto_review"),
        RuntimePermissionMode.BYPASS: ("danger-full-access", "never", ""),
        RuntimePermissionMode.READ_ONLY: ("read-only", "never", ""),
    }
    observed: dict[RuntimePermissionMode, tuple[str, str, str, bool]] = {}
    for mode in RuntimePermissionMode:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id=f"permission-{mode.value}",
                cwd=ROOT,
                permission=PermissionIntent(mode=mode, revision=f"permission:{mode.value}"),
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        reviewer = session._native.request.approval_reviewer
        observed[mode] = (
            session._native.request.sandbox,
            session._native.request.approval_policy,
            reviewer.value if reviewer is not None else "",
            session._native.request.network_access,
        )
    expected = {mode: (*values, False) for mode, values in expected.items()}
    check(
        "all product permission modes map only inside the adapter",
        observed == expected,
        str(observed),
    )

    networked = CodexRuntimeSession(
        OpenSessionRequest(
            product_session_id="permission-network",
            cwd=ROOT,
            permission=PermissionIntent(
                mode=RuntimePermissionMode.SAFE_AUTO,
                revision="permission:network",
                network_access=True,
            ),
            model=ModelIntent(
                transport=ModelTransport(
                    endpoint="https://model.example.test/v1", supports_websockets=True
                )
            ),
        )
    )
    check(
        "network permission remains typed until native projection",
        networked._native.request.network_access is True,
    )
    scoped = CodexRuntimeSession(
        OpenSessionRequest(
            product_session_id="permission-domains",
            cwd=ROOT,
            permission=PermissionIntent(
                mode=RuntimePermissionMode.SAFE_AUTO,
                revision="permission:domains",
                network_domains=("scholarseed.damo.alibaba.com",),
            ),
            model=ModelIntent(
                transport=ModelTransport(
                    endpoint="https://model.example.test/v1", supports_websockets=True
                )
            ),
        )
    )
    check(
        "scoped domains create a native profile without local sockets",
        scoped._native.request.permissions_profile == "local-services"
        and scoped._native.request.network_access is False
        and scoped._permission_config["permissions.local-services"]["network"]["domains"]
        == {"scholarseed.damo.alibaba.com": "allow"},
    )


def test_permission_reconfiguration() -> None:
    print("== permission reconfiguration ==")

    async def scenario() -> tuple[object, object, object, tuple[Path, ...]]:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="permission-reconfigure",
                cwd=ROOT,
                permission=PermissionIntent(
                    mode=RuntimePermissionMode.ASK,
                    revision="permission:ask",
                ),
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        compatible_roots = await session.reconfigure(
            RuntimeConfigurationIntent(
                revision="permission:ask:roots",
                permission=PermissionIntent(
                    mode=RuntimePermissionMode.ASK,
                    revision="permission:ask:roots",
                    writable_roots=(ROOT,),
                ),
                required=True,
            )
        )
        read_denial_change = await session.reconfigure(
            RuntimeConfigurationIntent(
                revision="permission:ask:denials",
                permission=PermissionIntent(
                    mode=RuntimePermissionMode.ASK,
                    deny_read_roots=(ROOT / "private",),
                ),
                required=True,
            )
        )
        check(
            "adapter requests restart when hard read denials change",
            read_denial_change.state is CommandState.RESTART_REQUIRED,
        )
        check(
            "rejected reconfiguration preserves active denials",
            session._permission.deny_read_roots == (),
        )
        auto_review = await session.reconfigure(
            RuntimeConfigurationIntent(
                revision="permission:safe_auto",
                permission=PermissionIntent(
                    mode=RuntimePermissionMode.SAFE_AUTO,
                    revision="permission:safe_auto",
                ),
                required=True,
            )
        )
        full_access = await session.reconfigure(
            RuntimeConfigurationIntent(
                revision="permission:bypassPermissions",
                permission=PermissionIntent(
                    mode=RuntimePermissionMode.BYPASS,
                    revision="permission:bypassPermissions",
                ),
                required=True,
            )
        )
        return compatible_roots, auto_review, full_access, session._native.request.writable_roots

    compatible_roots, auto_review, full_access, writable_roots = asyncio.run(scenario())
    check(
        "adapter applies changed writable roots within one native policy",
        compatible_roots.state is CommandState.APPLIED,
    )
    check(
        "adapter prepares reviewer changes without allocating a process",
        auto_review.state is CommandState.APPLIED,
    )
    check(
        "adapter prepares sandbox changes without allocating a process",
        full_access.state is CommandState.APPLIED,
    )
    check(
        "adapter applies changed writable roots to subsequent native turns",
        writable_roots == (),
    )


def test_model_reconfiguration() -> None:
    print("== model reconfiguration ==")

    async def scenario() -> tuple[object, object, object, tuple[str, CollaborationMode]]:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="model-reconfigure",
                cwd=ROOT,
                model=ModelIntent(
                    model_ref="model-a",
                    revision="model:a",
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                ),
            )
        )
        compatible = await session.reconfigure(
            RuntimeConfigurationIntent(
                revision="model:b",
                model=ModelIntent(
                    model_ref="model-b",
                    revision="model:b",
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                ),
                required=True,
            )
        )
        incompatible = await session.reconfigure(
            RuntimeConfigurationIntent(
                revision="model:remote",
                model=ModelIntent(
                    model_ref="remote-model",
                    revision="model:remote",
                    transport=ModelTransport(
                        mode=ModelConnectionMode.REMOTE,
                        endpoint="https://models.example.test/v1",
                    ),
                ),
                required=True,
            )
        )
        thread_preference_change = await session.reconfigure(
            RuntimeConfigurationIntent(
                revision="model:reasoning-high",
                model=ModelIntent(
                    model_ref="model-b",
                    revision="model:reasoning-high",
                    reasoning_effort="high",
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                ),
                required=True,
            )
        )
        observed: list[tuple[str, CollaborationMode]] = []

        async def run(turn: object) -> None:
            observed.append(
                (
                    str(getattr(turn, "model", "")),
                    getattr(turn, "collaboration_mode"),
                )
            )

        session._native = SimpleNamespace(run=run)
        session._tasks = set()
        session._active_command_id = ""
        await session.submit(
            TurnRequest(
                command_id="command-model",
                items=("hello",),
                collaboration_mode=CollaborationMode.PLAN.value,
            )
        )
        await asyncio.sleep(0)
        return compatible, incompatible, thread_preference_change, observed[0]

    compatible, incompatible, thread_preference_change, submitted = asyncio.run(scenario())
    check(
        "model changes require a fresh capability-bound process",
        compatible.state is CommandState.RESTART_REQUIRED,
    )
    check(
        "connection change is not misrepresented as a model-only update",
        incompatible.state is CommandState.RESTART_REQUIRED,
    )
    check(
        "thread preference change requires a fresh native thread",
        thread_preference_change.state is CommandState.RESTART_REQUIRED,
    )
    check("unapplied model never leaks to the next native turn", submitted[0] == "model-a")
    check(
        "requested collaboration mode is forwarded on the next native turn",
        submitted[1] is CollaborationMode.PLAN,
    )


def test_inventory_projection() -> None:
    print("== inventory projection ==")

    class Models:
        async def list_models(self) -> ModelInventory:
            return ModelInventory(next_cursor="models-next")

    class Skills:
        async def list_skills(
            self,
            *,
            cwd: Path,
            force_reload: bool = False,
        ) -> SkillInventory:
            del force_reload
            return SkillInventory(cwd=cwd, revision="skills-revision")

    class Mcp:
        async def snapshot(self) -> McpSnapshot:
            return McpSnapshot("codex", "native-session", "mcp-revision")

    @asynccontextmanager
    async def inventory_control():
        async def mcp_inventory(*, thread_id):
            check("inventory keeps thread identity", thread_id == "native-session")
            return await Mcp().snapshot()

        yield SimpleNamespace(
            model_control=Models(),
            skill_control=Skills(),
            mcp_inventory=mcp_inventory,
            identity="fixture-host:1",
        )

    async def scenario() -> object:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        session._request = SimpleNamespace(cwd=ROOT)
        session._native = SimpleNamespace(
            inventory_control=inventory_control,
            session_id="native-session",
        )
        return await session.inventory(
            InventoryRequest((InventoryKind.MODELS, InventoryKind.SKILLS, InventoryKind.MCP))
        )

    inventory = asyncio.run(scenario())
    values = dict(inventory.values) if isinstance(inventory.values, dict) else {}
    check(
        "all requested inventories are returned through the Gateway",
        set(values) == {"models", "skills", "mcp"},
    )
    skills = values.get("skills")
    check(
        "inventory projection is JSON-safe and revisioned",
        isinstance(skills, dict)
        and skills.get("cwd") == str(ROOT)
        and inventory.revision == "skills-revision:mcp-revision",
    )


def test_mcp_control_projection() -> None:
    print("== MCP control projection ==")

    class Mcp:
        capabilities = McpControlCapabilities(server_list=True, direct_tool_call=True)

        def __init__(self) -> None:
            self.arguments: dict[str, object] = {}

        async def snapshot(self) -> McpSnapshot:
            return McpSnapshot("codex", "native-session", "mcp-revision")

        async def call_tool(self, request: object) -> McpToolCallResult:
            self.arguments = dict(getattr(request, "arguments"))
            return McpToolCallResult(
                server=str(getattr(request, "server")),
                tool=str(getattr(request, "tool")),
                ok=True,
            )

    async def scenario() -> tuple[object, object, dict[str, object]]:
        control = Mcp()
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        session._native = SimpleNamespace(mcp_control=control)
        snapshot = await session.control(
            RuntimeControlRequest("snapshot-1", RuntimeControlKind.MCP_SNAPSHOT, {})
        )
        called = await session.control(
            RuntimeControlRequest(
                "call-1",
                RuntimeControlKind.MCP_CALL_TOOL,
                {"server": "papers", "tool": "search", "arguments": {"query": "graph"}},
            )
        )
        return snapshot, called, control.arguments

    snapshot, called, arguments = asyncio.run(scenario())
    check(
        "MCP snapshot and capability evidence cross only the Gateway ABI",
        snapshot.state is CommandState.APPLIED
        and isinstance(snapshot.values, dict)
        and snapshot.values.get("revision") == "mcp-revision"
        and isinstance(snapshot.values.get("capabilities"), dict),
    )
    check(
        "typed MCP intent is translated inside the adapter",
        called.state is CommandState.APPLIED and arguments == {"query": "graph"},
    )


def test_content_completion_and_sequence() -> None:
    print("== normalized content lifecycle ==")

    async def scenario() -> tuple[RuntimeEvent, RuntimeEvent, RuntimeEvent]:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        session._request = OpenSessionRequest(
            product_session_id="product-session",
            cwd=Path.cwd(),
            model=ModelIntent(
                transport=ModelTransport(
                    endpoint="https://model.example.test/v1", supports_websockets=True
                )
            ),
        )
        session._events = asyncio.Queue()
        session._sequence = 0
        session._event_namespace = "attachment-a"
        session._evidence_sequence = 0
        session._active_command_id = "command-1"
        session._committed_commands = {"command-1"}
        session._native = SimpleNamespace(
            host=SimpleNamespace(readiness=SimpleNamespace(process_generation=3)),
            process_events=(),
            rpc_evidence=(),
        )
        await session._on_native_event(
            CodexSessionEvent(
                runtime_id="codex",
                session_id="native-session",
                kind=CodexSessionEventKind.ASSISTANT_DELTA,
                turn_id="native-turn",
                vendor_seq=20,
                payload={"text": "hello"},
            )
        )
        await session._on_native_event(
            CodexSessionEvent(
                runtime_id="codex",
                session_id="native-session",
                kind=CodexSessionEventKind.ASSISTANT_COMPLETED,
                turn_id="native-turn",
                item_id="message-1",
                vendor_seq=21,
                payload={"text": "hello"},
            )
        )
        await session._on_native_event(
            CodexSessionEvent(
                runtime_id="codex",
                session_id="native-session",
                kind=CodexSessionEventKind.TURN_COMPLETED,
                turn_id="native-turn",
                vendor_seq=21,
                payload={"status": "completed"},
            )
        )
        return (
            await session._events.get(),
            await session._events.get(),
            await session._events.get(),
        )

    delta, completed, terminal = asyncio.run(scenario())
    check(
        "terminal is preceded by one completed content fact",
        completed.kind is RuntimeEventKind.CONTENT_COMPLETED
        and completed.payload.get("role") == "assistant"
        and completed.payload.get("text") == "hello"
        and completed.payload.get("content_observations")
        == [
            {
                "version": 1,
                "field": "text",
                "source": "runtime_observation",
                "original_bytes": 7,
                "truncated": False,
                "missing_reason": "",
            }
        ]
        and terminal.kind is RuntimeEventKind.TURN_COMPLETED,
    )
    check(
        "adapter sequence is strictly increasing across derived events",
        (delta.sequence, completed.sequence, terminal.sequence) == (1, 2, 3),
    )
    check(
        "derived and terminal events retain command correlation",
        {delta.correlation_id, completed.correlation_id, terminal.correlation_id} == {"command-1"},
    )
    check(
        "event identity includes the attachment namespace used across native resume",
        all(":attachment-a:" in event.event_id for event in (delta, completed, terminal)),
    )


def test_public_reasoning_streaming() -> None:
    async def scenario(streamed: bool = True) -> list[CodexSessionEvent]:
        events: list[CodexSessionEvent] = []

        async def observe(event: CodexSessionEvent) -> None:
            events.append(event)

        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="summary-session",
                cwd=ROOT,
                model=ModelIntent(
                    reasoning_effort="high",
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                ),
            )
        )
        request = await session._configure_model_connection(
            session._request.model, session._native.request, session._request.credential_port
        )
        params = start_parameters(
            "thread", TurnInput((InputItem(InputKind.TEXT, text="hello"),)), request, (), "model"
        )
        check(
            "native summary is independent of effort",
            params.get("summary") == "auto"
            and request.thread_config.get("model_reasoning_effort") == "high",
        )
        bridged_session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="bridged-summary-session",
                cwd=ROOT,
                model=ModelIntent(
                    reasoning_effort="low",
                    transport=ModelTransport(
                        mode=ModelConnectionMode.REMOTE,
                        endpoint="http://127.0.0.1:12345/v1",
                    ),
                    capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.PROVIDER_NATIVE),
                ),
            )
        )
        bridged_request = await bridged_session._configure_model_connection(
            bridged_session._request.model,
            bridged_session._native.request,
            bridged_session._request.credential_port,
        )
        bridged_params = start_parameters(
            "bridge-thread",
            TurnInput((InputItem(InputKind.TEXT, text="hello"),)),
            bridged_request,
            (),
            "model",
        )
        check(
            "remote native protocol requests summary without changing effort",
            bridged_params.get("summary") == "auto"
            and bridged_request.thread_config.get("model_reasoning_effort") == "low",
        )
        thread = SimpleNamespace(
            thread_id="thread",
            request=request,
            listener=observe,
            model="model",
            writable_roots=(),
            attached_generation=1,
        )
        runtime = CodexTurnRuntime(
            thread,
            request=AsyncMock(),
            ensure_attached=AsyncMock(return_value=1),
            stale_requests=AsyncMock(),
            emitter=CodexEmitter(),
            router=SimpleNamespace(bind_turn=Mock(), bind_item=Mock()),
            watcher=SimpleNamespace(),
            diagnostic=Mock(),
            protocol_error=Mock(),
        )
        identity = {"turnId": "turn", "itemId": "reasoning"}
        for part_index in ((0, 1) if streamed else ()):
            await runtime.notification(
                "item/reasoning/summaryPartAdded",
                {**identity, "summaryIndex": part_index},
                generation=1,
            )
            await runtime.notification(
                "item/reasoning/summaryTextDelta",
                {**identity, "summaryIndex": part_index, "delta": f"part-{part_index}"},
                generation=1,
            )
        await runtime.notification(
            "item/reasoning/textDelta",
            {**identity, "delta": "private raw reasoning"},
            generation=1,
        )
        await runtime.notification(
            "item/completed",
            {
                **identity,
                "item": {
                    "id": "reasoning",
                    "type": "reasoning",
                    "summary": ["part-0", "part-1"],
                    "content": ["private raw reasoning"],
                },
            },
            generation=1,
        )
        runtime._settled_turns.add("turn")
        await runtime.notification(
            "item/reasoning/summaryTextDelta",
            {**identity, "delta": "late"},
            generation=1,
        )
        return events

    events = asyncio.run(scenario())
    completed_only = asyncio.run(scenario(streamed=False))
    check(
        "completed reasoning without deltas emits public summary parts",
        [event.payload.get("text") for event in completed_only[:-1]] == ["part-0", "part-1"]
        and [event.payload.get(REASONING_SUMMARY_INDEX) for event in completed_only[:-1]] == [0, 1]
        and all("private raw reasoning" not in str(event.payload) for event in completed_only),
    )
    check(
        "only public summary deltas and completion are emitted",
        len(events) == 5
        and all(event.payload.get(REASONING_SOURCE) == PUBLIC_REASONING_SUMMARY for event in events)
        and all("private raw reasoning" not in str(event.payload) for event in events),
    )
    check(
        "summary parts retain identity",
        [event.payload.get(REASONING_SUMMARY_INDEX) for event in events[:-1]] == [0, 0, 1, 1],
    )
    completed = translate_event(
        events[-1], product_session_id="summary-session", process_generation=1
    )
    check(
        "summary completion carries no duplicate text",
        completed.kind is RuntimeEventKind.CONTENT_COMPLETED
        and completed.payload.get("role") == "reasoning"
        and "text" not in completed.payload,
    )


def test_nullable_phase_message_streaming() -> None:
    print("== nullable message phase streaming ==")

    async def scenario() -> list[CodexSessionEvent]:
        events: list[CodexSessionEvent] = []

        async def observe(event: CodexSessionEvent) -> None:
            events.append(event)

        thread = SimpleNamespace(
            thread_id="native-thread",
            request=CodexSessionOpenRequest(
                request_id="request-1",
                runtime_id="codex",
                cwd=ROOT,
            ),
            listener=observe,
            model="model",
            writable_roots=(),
            attached_generation=1,
        )
        runtime = CodexTurnRuntime(
            thread,
            request=AsyncMock(),
            ensure_attached=AsyncMock(return_value=1),
            stale_requests=AsyncMock(),
            emitter=CodexEmitter(),
            router=SimpleNamespace(bind_turn=Mock(), bind_item=Mock()),
            watcher=SimpleNamespace(),
            diagnostic=Mock(),
            protocol_error=Mock(),
        )
        item = {"id": "message-1", "type": "agentMessage", "phase": None, "text": "hello"}
        await runtime.notification(
            "item/started",
            {"turnId": "turn-1", "itemId": "message-1", "item": item},
            generation=1,
        )
        for delta in ("hel", "lo"):
            await runtime.notification(
                "item/agentMessage/delta",
                {"turnId": "turn-1", "itemId": "message-1", "delta": delta},
                generation=1,
            )
            streamed = [
                event.payload.get("text")
                for event in events
                if event.kind is CodexSessionEventKind.ASSISTANT_DELTA
            ]
            check(
                "nullable-phase delta is emitted before item completion",
                streamed == (["hel"] if delta == "hel" else ["hel", "lo"]),
            )
            check(
                "unknown phase is not fabricated for streaming",
                all("phase" not in event.payload for event in events),
            )
        await runtime.notification(
            "item/completed",
            {"turnId": "turn-1", "itemId": "message-1", "item": item},
            generation=1,
        )
        await runtime._flush_unknown_message("turn-1", MessagePhase.FINAL_ANSWER)
        phased_item = {
            "id": "message-2",
            "type": "agentMessage",
            "phase": MessagePhase.FINAL_ANSWER.value,
            "text": "late",
        }
        await runtime.notification(
            "item/agentMessage/delta",
            {"turnId": "turn-2", "itemId": "message-2", "delta": "late"},
            generation=1,
        )
        check(
            "out-of-order delta streams before item started",
            events[-1].kind is CodexSessionEventKind.ASSISTANT_DELTA
            and events[-1].payload.get("text") == "late"
            and "phase" not in events[-1].payload,
        )
        event_count = len(events)
        await runtime.notification(
            "item/started",
            {"turnId": "turn-2", "itemId": "message-2", "item": phased_item},
            generation=1,
        )
        check("late phase does not replay streamed text", len(events) == event_count)
        await runtime.notification(
            "item/completed",
            {"turnId": "turn-2", "itemId": "message-2", "item": phased_item},
            generation=1,
        )
        return events

    events = asyncio.run(scenario())
    deltas = [event for event in events if event.kind is CodexSessionEventKind.ASSISTANT_DELTA]
    completed = [
        event for event in events if event.kind is CodexSessionEventKind.ASSISTANT_COMPLETED
    ]
    check(
        "nullable-phase text remains incremental",
        [event.payload.get("text") for event in deltas] == ["hel", "lo", "late"],
    )
    check(
        "late phase metadata emits each message once",
        len(deltas) == 3,
    )
    check(
        "terminal order resolves the nullable phase as final answer",
        len(completed) == 2
        and completed[0].payload.get("text") == "hello"
        and all(
            event.payload.get("phase") == MessagePhase.FINAL_ANSWER.value for event in completed
        ),
    )


def test_capability_resolution_is_synthesised_once_per_pair() -> None:
    print("== declared vs effective context window ==")

    async def scenario() -> list[RuntimeEvent]:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        session._events = asyncio.Queue()
        session._sequence = 0
        session._event_namespace = "capability"
        session._evidence_sequence = 0
        session._model = ModelIntent(
            model_ref="qwen3.8-max",
            transport=ModelTransport(endpoint="https://gateway.test/v1"),
            context_window=1_000_000,
        )
        native = SimpleNamespace(
            host=SimpleNamespace(readiness=SimpleNamespace(process_generation=3)),
            process_events=(),
            rpc_evidence=(),
            context_window=272_000,
        )
        session._native = native

        async def usage(vendor_seq: int) -> None:
            await session._on_native_event(
                CodexSessionEvent(
                    runtime_id="codex",
                    session_id="native-session",
                    kind=CodexSessionEventKind.USAGE_UPDATED,
                    turn_id="native-turn",
                    vendor_seq=vendor_seq,
                    payload={"input_tokens": 1, "context_window": native.context_window},
                )
            )

        await usage(1)
        await usage(2)
        native.context_window = 1_000_000
        await usage(3)
        events: list[RuntimeEvent] = []
        while not session._events.empty():
            events.append(session._events.get_nowait())
        return events

    events = asyncio.run(scenario())
    resolutions = [
        event for event in events if event.kind is RuntimeEventKind.MODEL_CAPABILITY_RESOLUTION
    ]
    usage_events = [event for event in events if event.kind is RuntimeEventKind.USAGE_UPDATED]
    check(
        "three usage events yield two resolutions, not three",
        len(usage_events) == 3 and len(resolutions) == 2,
        str([(event.kind.value, event.payload) for event in events]),
    )
    clamped = resolutions[0].payload if resolutions else {}
    check(
        "the declared window being cut down is reported as clamped",
        clamped.get("wire_model") == "qwen3.8-max"
        and clamped.get("declared_context_window") == 1_000_000
        and clamped.get("effective_context_window") == 272_000
        and clamped.get("clamped") is True,
        str(clamped),
    )
    honoured = resolutions[1].payload if len(resolutions) > 1 else {}
    check(
        "an honoured declaration flips the verdict",
        honoured.get("clamped") is False and honoured.get("effective_context_window") == 1_000_000,
        str(honoured),
    )
    check(
        "each resolution is causally tied to the usage event that revealed it",
        {event.causation_id for event in resolutions}
        == {usage_events[0].event_id, usage_events[2].event_id},
        str([event.causation_id for event in resolutions]),
    )


def test_subagent_lifecycle_survives_out_of_order_observation() -> None:
    print("== out-of-order subagent lifecycle ==")

    async def scenario() -> tuple[RuntimeEvent, RuntimeEvent, RuntimeEvent, bool]:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        session._request = OpenSessionRequest(
            product_session_id="product-session",
            cwd=Path.cwd(),
            model=ModelIntent(
                transport=ModelTransport(
                    endpoint="https://model.example.test/v1", supports_websockets=True
                )
            ),
        )
        session._events = asyncio.Queue()
        session._sequence = 0
        session._event_namespace = "attachment-a"
        session._evidence_sequence = 0
        session._active_command_id = "command-1"
        session._native = SimpleNamespace(
            host=SimpleNamespace(readiness=SimpleNamespace(process_generation=3)),
            process_events=(),
            rpc_evidence=(),
        )
        details = {"agent_thread_id": "subagent-1", "agent_path": "reviewer"}
        await session._on_native_event(
            CodexSessionEvent(
                runtime_id="codex",
                session_id="native-session",
                kind=CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED,
                turn_id="native-turn",
                item_id="subagent-1",
                payload={
                    "activity_type": "subagent_activity",
                    "status": "completed",
                    "ok": True,
                    "details": details,
                },
            )
        )
        await session._on_native_event(
            CodexSessionEvent(
                runtime_id="codex",
                session_id="native-session",
                kind=CodexSessionEventKind.NATIVE_ACTIVITY_STARTED,
                turn_id="native-turn",
                item_id="subagent-run-2",
                payload={
                    "activity_type": "subagent_activity",
                    "status": "running",
                    "details": details,
                },
            )
        )
        spawned = await session._events.get()
        completed = await session._events.get()
        restarted = await session._events.get()
        return spawned, completed, restarted, session._events.empty()

    spawned, completed, restarted, no_duplicate_spawn = asyncio.run(scenario())
    check(
        "a terminal-first native sequence is normalized to spawned then completed",
        spawned.kind is RuntimeEventKind.SUBAGENT_SPAWNED
        and completed.kind is RuntimeEventKind.SUBAGENT_COMPLETED
        and (spawned.sequence, completed.sequence) == (2, 3),
    )
    check(
        "a later activity for the same agent does not synthesize a duplicate spawn",
        restarted.kind is RuntimeEventKind.SUBAGENT_STARTED and no_duplicate_spawn,
    )


def test_child_thread_terminal_truth_and_authentication_classification() -> None:
    print("== child terminal truth and authentication classification ==")
    router = ThreadRouter()
    router.register_agents(
        "parent-thread",
        "parent-turn",
        {
            "id": "spawn-call",
            "type": "collabAgentToolCall",
            "receiverThreadIds": ["child-thread"],
        },
        (),
    )
    route = router.agent("child-thread")
    check(
        "child route retains its owning product turn and call",
        route is not None
        and route.owner_thread_id == "parent-thread"
        and route.owner_turn_id == "parent-turn"
        and route.owner_item_id == "spawn-call",
    )
    check(
        "duplicate native child status is idempotent",
        router.update_agent_status("child-thread", "failed")
        and not router.update_agent_status("child-thread", "failed"),
    )
    terminal = translate_event(
        CodexSessionEvent(
            runtime_id="codex",
            session_id="parent-thread",
            kind=CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED,
            turn_id="parent-turn",
            item_id="child-thread",
            payload=subagent_lifecycle_payload(
                agent_thread_id="child-thread",
                agent_path="",
                status="failed",
                completed=True,
            ),
        ),
        product_session_id="product-session",
        process_generation=1,
    )
    check(
        "native child failure projects as subagent failure",
        terminal.kind is RuntimeEventKind.SUBAGENT_FAILED,
    )
    authentication = provider_failure({"error": {"code": "model_bridge_credential_required"}})
    check(
        "missing bridge credentials are terminal authentication failures",
        authentication.message == PROVIDER_AUTH_MESSAGE
        and authentication.retryability is RuntimeRetryability.TERMINAL,
    )

    async def child_notification() -> list[CodexSessionEvent]:
        events: list[CodexSessionEvent] = []
        host = CodexProcessHost(executable="codex")
        state = SimpleNamespace(thread_id="parent-thread", listener=events.append)
        child_route = AgentRoute(
            owner_thread_id="parent-thread",
            owner_turn_id="parent-turn",
            owner_item_id="spawn-call",
        )
        params = {
            "threadId": "child-thread",
            "turn": {"id": "child-turn", "status": "failed"},
        }
        await host._handle_agent_notification(
            state, child_route, "child-thread", "turn/completed", params
        )
        await host._handle_agent_notification(
            state, child_route, "child-thread", "turn/completed", params
        )
        return events

    child_events = asyncio.run(child_notification())
    check(
        "child terminal notification emits one typed terminal event on the owner turn",
        len(child_events) == 1
        and child_events[0].turn_id == "parent-turn"
        and child_events[0].item_id == "child-thread"
        and child_events[0].payload.get("status") == "failed",
    )

    async def child_progress() -> list[CodexSessionEvent]:
        events: list[CodexSessionEvent] = []
        host = CodexProcessHost(executable="codex")
        state = SimpleNamespace(thread_id="parent-thread", listener=events.append)
        route = AgentRoute(owner_thread_id="parent-thread", owner_turn_id="parent-turn")
        await host._handle_agent_notification(
            state,
            route,
            "child-thread",
            "item/started",
            {"threadId": "child-thread", "item": {"type": "webSearch"}},
        )
        await host._handle_agent_notification(
            state,
            route,
            "child-thread",
            "item/reasoning/textDelta",
            {"threadId": "child-thread", "delta": "private reasoning"},
        )
        await host._handle_agent_notification(
            state,
            route,
            "child-thread",
            "item/completed",
            {"threadId": "child-thread", "item": {"type": "webSearch"}},
        )
        return events

    progress_events = asyncio.run(child_progress())
    check(
        "child item activity produces redacted typed status on its owning turn",
        len(progress_events) == 2
        and all(event.turn_id == "parent-turn" for event in progress_events)
        and all(event.item_id == "child-thread" for event in progress_events)
        and all("private reasoning" not in str(event.payload) for event in progress_events)
        and all(
            translate_event(
                event,
                product_session_id="product-session",
                process_generation=1,
            ).kind
            is RuntimeEventKind.SUBAGENT_STATUS_CHANGED
            for event in progress_events
        ),
    )

    async def child_public_summary(streamed: bool = True) -> list[CodexSessionEvent]:
        events: list[CodexSessionEvent] = []
        host = CodexProcessHost(executable="codex")
        state = SimpleNamespace(thread_id="parent-thread", listener=events.append)
        route = AgentRoute(owner_thread_id="parent-thread", owner_turn_id="parent-turn")
        if streamed:
            await host._handle_agent_notification(
                state,
                route,
                "child-thread",
                "item/reasoning/summaryTextDelta",
                {"threadId": "child-thread", "itemId": "reason-1", "delta": "Checking evidence"},
            )
        await host._handle_agent_notification(
            state,
            route,
            "child-thread",
            "item/reasoning/textDelta",
            {"threadId": "child-thread", "itemId": "reason-1", "delta": "private raw reasoning"},
        )
        await host._handle_agent_notification(
            state,
            route,
            "child-thread",
            "item/completed",
            {
                "threadId": "child-thread",
                "item": {
                    "id": "reason-1",
                    "type": "reasoning",
                    "summary": ["Checking evidence"],
                    "content": ["private raw reasoning"],
                },
            },
        )
        return events

    summary_events = asyncio.run(child_public_summary())
    completed_summary_events = asyncio.run(child_public_summary(streamed=False))
    check(
        "child completion retains public summary without streaming",
        completed_summary_events[-1].payload.get("details", {}).get("public_summary")
        == "Checking evidence"
        and all(
            "private raw reasoning" not in str(event.payload) for event in completed_summary_events
        ),
    )

    async def child_command() -> list[CodexSessionEvent]:
        events: list[CodexSessionEvent] = []
        host = CodexProcessHost(executable="codex")
        state = SimpleNamespace(thread_id="parent-thread", listener=events.append)
        route = AgentRoute(owner_thread_id="parent-thread", owner_turn_id="parent-turn")
        item = {"id": "command-1", "type": "commandExecution", "command": "pwd"}
        for method, extra in (
            ("item/started", {}),
            (
                "item/completed",
                {"aggregatedOutput": "/workspace", "exitCode": 0, "status": "completed"},
            ),
        ):
            await host._handle_agent_notification(
                state, route, "child-thread", method, {"item": {**item, **extra}}
            )
        return events

    command_events = asyncio.run(child_command())
    for native_item in (
        {"type": "commandExecution", "command": "false", "exitCode": 1, "status": "completed"},
        {
            "type": "mcpToolCall",
            "server": "search",
            "tool": "query",
            "arguments": {"q": "test"},
            "error": {"message": "failed"},
            "status": "completed",
        },
        {
            "type": "dynamicToolCall",
            "tool": "echo",
            "arguments": {"text": "hello"},
            "contentItems": [{"text": "hello"}],
            "status": "completed",
        },
        {
            "type": "fileChange",
            "changes": [{"path": "a.txt", "kind": "add"}],
            "status": "completed",
        },
    ):
        child_payload = subagent_status_payload(
            agent_thread_id="child",
            agent_path="child",
            activity="tool",
            phase="completed",
            item=native_item,
        )
        check(
            f"child {native_item['type']} shares parent tool projection",
            child_payload["details"]["tool"]
            == {**tool_item_payload(native_item), **tool_item_result(native_item)},
        )
    check(
        "child nonzero command exit is a failure even with completed native status",
        tool_item_result({"type": "commandExecution", "status": "completed", "exitCode": 1})["ok"]
        is False,
    )
    child_tools = [event.payload.get("details", {}).get("tool", {}) for event in command_events]
    check(
        "child command uses the same structured tool input and output as the parent",
        child_tools[0] == {"name": "bash", "input": {"command": "pwd", "cwd": None, "actions": []}}
        and child_tools[1]
        == {
            **child_tools[0],
            "output": "/workspace",
            "ok": True,
            "status": "completed",
            "exit_code": 0,
        },
    )
    bounded_command = subagent_item_summary(
        {
            "type": "commandExecution",
            "command": "pwd",
            "aggregatedOutput": "x" * (CODEX_NATIVE_ACTIVITY_TEXT_LIMIT + 1),
            "exitCode": 1,
        }
    )
    check(
        "child output is bounded while retaining failure exit code",
        bounded_command == f"pwd\n\n{'x' * CODEX_NATIVE_ACTIVITY_TEXT_LIMIT}\n\nexit_code=1",
    )
    check(
        "missing public summary never falls back to private reasoning",
        subagent_item_summary({"type": "reasoning", "content": ["private raw reasoning"]}) == "",
    )
    command_summaries = [
        event.payload.get("details", {}).get("public_summary", "") for event in command_events
    ]
    check(
        "child command boundaries retain command and completed output",
        len(command_summaries) == 2
        and "pwd" in command_summaries[0]
        and "pwd" in command_summaries[1]
        and "/workspace" in command_summaries[1]
        and "exit_code=0" in command_summaries[1],
    )
    check(
        "child progress retains a public summary snapshot without raw reasoning",
        len(summary_events) == 2
        and all("private raw reasoning" not in str(event.payload) for event in summary_events)
        and all(
            event.payload.get("details", {}).get("public_summary") == "Checking evidence"
            for event in summary_events
        )
        and all(
            event.payload.get("details", {}).get("activity_item_id") == "reason-1"
            for event in summary_events
        ),
    )
    progress_router = ThreadRouter()
    check(
        "stream progress is bounded while item boundaries remain immediate",
        progress_router.observe_agent_activity("child", now=0, interval=15, boundary=False)
        and not progress_router.observe_agent_activity("child", now=1, interval=15, boundary=False)
        and progress_router.observe_agent_activity("child", now=1, interval=15, boundary=True)
        and progress_router.observe_agent_activity("child", now=16, interval=15, boundary=False),
    )
    progress_router.update_agent_status("child", "failed")
    check(
        "terminal child cannot publish a later running update",
        not progress_router.observe_agent_activity("child", now=30, interval=15, boundary=True),
    )


def test_unsupported_dynamic_tool_fails_fast() -> None:
    print("== unsupported dynamic tool boundary ==")

    async def scenario() -> tuple[list[tuple[str, object]], int]:
        responses: list[tuple[str, object]] = []

        async def resolve_tool(request_id: str, response: object) -> bool:
            responses.append((request_id, response))
            return True

        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        session._request = SimpleNamespace(product_session_id="product-session", service_tools=())
        session._events = asyncio.Queue()
        session._sequence = 0
        session._event_namespace = "attachment-a"
        session._evidence_sequence = 0
        session._assistant_content = {}
        session._active_command_id = "command-1"
        session._native = SimpleNamespace(
            host=SimpleNamespace(readiness=SimpleNamespace(process_generation=3)),
            resolve_tool=resolve_tool,
            process_events=(),
            rpc_evidence=(),
        )
        await session._on_native_event(
            CodexSessionEvent(
                runtime_id="codex",
                session_id="native-session",
                kind=CodexSessionEventKind.DYNAMIC_TOOL_REQUESTED,
                turn_id="native-turn",
                vendor_seq=22,
                payload={"request_id": "tool-request", "tool": "exec"},
            )
        )
        return responses, session._events.qsize()

    responses, queued = asyncio.run(scenario())
    check(
        "undeclared dynamic tool receives an immediate negative response",
        len(responses) == 1
        and responses[0][0] == "tool-request"
        and getattr(responses[0][1], "success", True) is False,
    )
    check("undeclared dynamic tool never reaches Serve", queued == 0)


def test_resumed_dynamic_tool_declaration_is_preserved() -> None:
    bridge_tool = RuntimeServiceTool(
        name="scholarseed_bridge",
        description="Product bridge",
        input_schema={"type": "object"},
    )
    binding = RuntimeBinding(
        product_session_id="product-session",
        runtime_id="codex",
        adapter_version="fixture",
        runtime_version="fixture",
        protocol_version="fixture",
        protocol_schema_hash="fixture",
        opaque_session_ref="native-session",
        capabilities=CapabilitySet(),
    )
    request = ResumeSessionRequest(
        binding=binding,
        cwd=ROOT,
        service_tools=(bridge_tool,),
        model=ModelIntent(
            transport=ModelTransport(
                endpoint="https://model.example.test/v1", supports_websockets=True
            )
        ),
    )
    restored = provider()._open_request(request)
    assert restored.service_tools == (bridge_tool,)


def test_resumed_skill_policy_cannot_be_relaxed() -> None:
    binding = RuntimeBinding(
        product_session_id="denied-session",
        runtime_id="codex",
        adapter_version="fixture",
        runtime_version="fixture",
        protocol_version="fixture",
        protocol_schema_hash="fixture",
        opaque_session_ref="denied-thread",
        capabilities=CapabilitySet(),
        skill_policy=SkillPolicy.DENY,
    )
    request = ResumeSessionRequest(
        binding=binding,
        cwd=ROOT,
        model=ModelIntent(
            transport=ModelTransport(
                endpoint="https://model.example.test/v1", supports_websockets=True
            )
        ),
    )
    restored = provider()._open_request(request)
    assert restored.skill_policy is SkillPolicy.DENY
    for invalid in (
        replace(request, skill_policy="unknown"),
        replace(request, binding=replace(binding, skill_policy="unknown")),
    ):
        try:
            provider()._open_request(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid skill policy must fail closed")


def test_thread_model_configuration_is_confirmed() -> None:
    print("== native thread model confirmation ==")
    request = CodexSessionOpenRequest(
        request_id="model-confirmation",
        runtime_id="codex",
        cwd=ROOT,
        model="selected-model",
        model_provider="scholarseed",
    )
    response = {"model": "selected-model", "modelProvider": "scholarseed"}
    check(
        "matching model and provider are accepted",
        _confirmed_thread_model(response, request) == "selected-model",
    )
    for mismatched in (
        {"model": "previous-model", "modelProvider": "scholarseed"},
        {"model": "selected-model", "modelProvider": "previous-provider"},
        {"model": "selected-model"},
        {"modelProvider": "scholarseed"},
    ):
        try:
            _confirmed_thread_model(mismatched, request)
        except AppServerError as error:
            check(
                "unconfirmed model configuration is rejected",
                error.safe_error == THREAD_CONFIGURATION_MISMATCH,
            )
        else:
            check("unconfirmed model configuration is rejected", False)

    shared = CodexSessionOpenRequest(
        request_id="same-process",
        runtime_id="codex",
        cwd=ROOT,
        model="model-a",
        model_provider="scholarseed",
        process_environment={"CODEX_HOME": "/isolated"},
        launch_arguments=(CodexRuntimeLaunchArgument(option="-c", value="catalog"),),
        execution_scope="product-session",
    )
    check(
        "thread-scoped model and provider URL can change within one host",
        _same_process_configuration(
            shared,
            replace(
                shared,
                model="model-b",
                thread_config={"model_providers": {"scholarseed": {"base_url": "new"}}},
            ),
        ),
    )
    check(
        "different process catalog cannot reuse the writer host",
        not _same_process_configuration(
            shared,
            replace(
                shared,
                launch_arguments=(CodexRuntimeLaunchArgument(option="-c", value="other"),),
            ),
        ),
    )
    check(
        "sharing authorization cannot change within an existing attachment",
        not _same_process_configuration(
            shared, replace(shared, process_sharing_scope="different-user")
        ),
    )
    check(
        "permission changes cannot be silently reverted by model switching",
        not _same_process_configuration(
            shared,
            replace(shared, sandbox="workspace-write"),
        ),
    )


def test_same_process_reopen_restores_previous_configuration_on_failure() -> None:
    print("== same-process thread reopen ==")

    async def scenario() -> tuple[bool, bool, bool]:
        host = SimpleNamespace(process_generation=3, suspend_thread=AsyncMock())
        lease = SimpleNamespace(host=host)
        original = CodexSessionOpenRequest(
            request_id="same-process-reopen",
            runtime_id="codex",
            cwd=ROOT,
            model="model-a",
        )
        thread = CodexThreadSession(original, lease=lease)
        thread._opened = True
        thread.session_id = "durable-thread"
        thread._attach = AsyncMock(side_effect=[AppServerError("resume rejected"), None])
        candidate = replace(original, resume_session_id="durable-thread", model="model-b")
        try:
            await thread.reopen(candidate)
        except AppServerError:
            pass
        else:
            return False, False, False
        return (
            host.suspend_thread.await_args.args == ("durable-thread", 3),
            thread._attach.await_count == 2,
            thread.request.resume_session_id == "durable-thread"
            and thread.request.model == original.model
            and thread.lease is lease,
        )

    suspended, restored, original_retained = asyncio.run(scenario())
    check("old native attachment is unsubscribed once", suspended)
    check("rejected candidate triggers old configuration restoration", restored)
    check("restored thread retains its original host lease", original_retained)


def test_started_native_turn_owns_terminal_outcome() -> None:
    print("== committed turn terminal ownership ==")

    async def scenario() -> tuple[int, str]:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        session._events = asyncio.Queue()
        session._tasks = set()
        session._active_command_id = "command-1"
        session._committed_commands = {"command-1"}
        session._native = SimpleNamespace(active_turn_id="")

        async def failed_submission_task() -> None:
            raise RuntimeError("turn/start response failed after turn/started")

        task = asyncio.create_task(failed_submission_task())
        await asyncio.sleep(0)
        await session._finish_turn_task(task, "command-1")
        return session._events.qsize(), session._active_command_id

    queued, active_command = asyncio.run(scenario())
    check(
        "turn/started prevents a synthetic failed terminal",
        queued == 0 and active_command == "command-1",
    )


def test_unknown_native_turn_owns_terminal_outcome() -> None:
    print("== unknown turn terminal ownership ==")

    async def scenario() -> tuple[list[RuntimeEventKind], str]:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        session._events = asyncio.Queue()
        session._active_command_id = "command-1"
        session._binding = RuntimeBinding(
            product_session_id="product-session",
            runtime_id="codex",
            adapter_version="fixture",
            runtime_version="fixture",
            protocol_version="fixture",
            protocol_schema_hash="fixture",
            opaque_session_ref="native-session",
            capabilities=CapabilitySet(),
        )
        session._native = SimpleNamespace(
            host=SimpleNamespace(readiness=SimpleNamespace(process_generation=2))
        )

        async def failed_submission_task() -> None:
            raise RuntimeError("turn/start outcome is unknown")

        with patch.object(session, "_observe_evidence", new=AsyncMock()):
            await session._on_native_event(
                CodexSessionEvent(
                    runtime_id="codex",
                    session_id="native-session",
                    kind=CodexSessionEventKind.TURN_UNKNOWN,
                    turn_id="command-1",
                    payload={"safe_error": "codex_turn_outcome_unknown"},
                )
            )
            task = asyncio.create_task(failed_submission_task())
            await asyncio.sleep(0)
            await session._finish_turn_task(task, "command-1")
        kinds = [event.kind for event in list(session._events._queue)]
        return kinds, session._active_command_id

    kinds, active_command = asyncio.run(scenario())
    check(
        "turn/unknown prevents a synthetic failed terminal",
        kinds == [RuntimeEventKind.TURN_UNKNOWN] and active_command == "command-1",
    )


def test_submission_task_failure_emits_typed_incident() -> None:
    async def scenario(unknown: bool) -> tuple[list[RuntimeEvent], str]:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        session._events = asyncio.Queue()
        session._active_command_id = "command-1"
        session._binding = RuntimeBinding(
            product_session_id="product-session",
            runtime_id="codex",
            adapter_version="fixture",
            runtime_version="fixture",
            protocol_version="fixture",
            protocol_schema_hash="fixture",
            opaque_session_ref="native-session",
            capabilities=CapabilitySet(),
        )
        session._native = SimpleNamespace(
            host=SimpleNamespace(readiness=SimpleNamespace(process_generation=2))
        )

        async def fail() -> None:
            raise AppServerError(
                "private vendor text",
                generation=1,
                retryability=(
                    RuntimeRetryability.UNKNOWN_OUTCOME
                    if unknown
                    else RuntimeRetryability.USER_RETRYABLE
                ),
            )

        task = asyncio.create_task(fail())
        await asyncio.sleep(0)
        await session._finish_turn_task(task, "command-1")
        return list(session._events._queue), session._active_command_id

    for unknown in (False, True):
        records, active = asyncio.run(scenario(unknown))
        incident = records[0].payload.get("incident", {})
        check(
            "submission failures use a complete neutral incident",
            incident.get("scope") == RuntimeIncidentScope.TURN.value
            and incident.get("state") == RuntimeIncidentState.FAILED.value
            and incident.get("kind") in {kind.value for kind in RuntimeIncidentKind}
            and incident.get("native_session_id") == "native-session"
            and incident.get("process_generation") == 1
            and all(event.process_generation == 1 for event in records)
            and "private vendor text" not in json.dumps(records[0].payload),
        )
        check(
            "unknown submission remains fenced rather than failed or replayed",
            records[1].kind
            is (RuntimeEventKind.TURN_UNKNOWN if unknown else RuntimeEventKind.TURN_FAILED)
            and active == ("command-1" if unknown else ""),
        )


def test_process_exit_unknown_releases_command_activity() -> None:
    print("== process exit releases command activity ==")

    async def scenario(
        event_session_id: str,
        client_command_id: str,
        *,
        precommitted: bool = True,
        switch_during_publish: bool = False,
    ) -> tuple[list[RuntimeEventKind], str, set[str]]:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        session._events = asyncio.Queue()
        session._active_command_id = "command-1"
        session._committed_commands = {"command-1"} if precommitted else set()
        session._binding = RuntimeBinding(
            product_session_id="product-session",
            runtime_id="codex",
            adapter_version="fixture",
            runtime_version="fixture",
            protocol_version="fixture",
            protocol_schema_hash="fixture",
            opaque_session_ref="native-session",
            capabilities=CapabilitySet(),
        )
        session._native = SimpleNamespace(
            session_id="native-session",
            host=SimpleNamespace(readiness=SimpleNamespace(process_generation=2)),
        )

        async def exited_turn_task() -> None:
            raise RuntimeError("Codex App Server process exited")

        original_publish = session._publish_observation

        async def publish(observation):
            await original_publish(observation)
            if switch_during_publish and observation.kind is RuntimeEventKind.TURN_UNKNOWN:
                session._active_command_id = "command-2"
                session._committed_commands = {"command-2"}

        with (
            patch.object(session, "_observe_evidence", new=AsyncMock()),
            patch.object(session, "_publish_observation", new=publish),
        ):
            native_event = CodexSessionEvent(
                runtime_id="codex",
                session_id=event_session_id,
                kind=CodexSessionEventKind.TURN_UNKNOWN,
                turn_id="native-turn",
                payload={
                    "error": "process_exit",
                    "client_user_message_id": client_command_id,
                },
                incident=RuntimeIncident(
                    incident_id="process-exit",
                    scope=RuntimeIncidentScope.PROCESS,
                    state=RuntimeIncidentState.FAILED,
                    kind=RuntimeIncidentKind.PROCESS_EXIT,
                    strategy=RuntimeRecoveryStrategy.AUTO_RESTART,
                    retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                    safe_error="agent_runtime_exit",
                ),
            )
            await session._on_native_event(native_event)
            if not precommitted:
                await session._on_native_event(native_event)
                check(
                    "uncorrelated exit cannot mark another command committed",
                    not session._committed_commands,
                )
            task = asyncio.create_task(exited_turn_task())
            await asyncio.sleep(0)
            await session._finish_turn_task(task, "command-1")
        return (
            [event.kind for event in list(session._events._queue)],
            session._active_command_id,
            session._committed_commands,
        )

    kinds, active_command, committed_commands = asyncio.run(scenario("native-session", "command-1"))
    check(
        "process exit preserves unknown outcome but releases stale admission",
        kinds == [RuntimeEventKind.TURN_UNKNOWN]
        and active_command == ""
        and not committed_commands,
    )
    kinds, active_command, committed_commands = asyncio.run(
        scenario("native-session", "command-1", switch_during_publish=True)
    )
    check(
        "delayed unknown publication cannot release a replacement command",
        active_command == "command-2" and committed_commands == {"command-2"},
    )
    for event_session_id, client_command_id in (
        ("other-session", "command-1"),
        ("native-session", "old-command"),
        ("native-session", ""),
    ):
        kinds, active_command, committed_commands = asyncio.run(
            scenario(event_session_id, client_command_id)
        )
        check(
            "uncorrelated process exit cannot release the current command",
            active_command == "command-1" and committed_commands == {"command-1"},
        )
        kinds, active_command, committed_commands = asyncio.run(
            scenario(event_session_id, client_command_id, precommitted=False)
        )
        check(
            "uncorrelated exit cannot suppress a new pre-commit failure",
            active_command == ""
            and not committed_commands
            and RuntimeEventKind.TURN_FAILED in kinds,
        )


def test_preack_process_exit_releases_command_activity() -> None:
    print("== pre-ACK process exit releases only command activity ==")

    async def scenario(exit_before_failure: bool) -> None:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        session._binding = RuntimeBinding(
            product_session_id="product-session",
            runtime_id="codex",
            adapter_version="fixture",
            runtime_version="fixture",
            protocol_version="fixture",
            protocol_schema_hash="fixture",
            opaque_session_ref="native-session",
            capabilities=CapabilitySet(),
        )
        request_started = asyncio.Event()
        response: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

        async def request(method, params, *, generation, submission=None, before_write=None):
            if before_write is not None:
                before_write()
            if submission is not None:
                submission.attempt()
            request_started.set()
            return await response

        router = Mock(spec=ThreadRouter)
        watcher = WorkspaceWatch(AsyncMock(return_value={}), Mock())
        native_turn = CodexTurnRuntime(
            ThreadAttachment(
                thread_id="native-session",
                request=CodexSessionOpenRequest(request_id="fixture", runtime_id="codex", cwd=ROOT),
                listener=session._on_native_event,
                model="model",
                writable_roots=(),
                attached_generation=1,
            ),
            request=request,
            ensure_attached=AsyncMock(return_value=1),
            stale_requests=AsyncMock(),
            emitter=CodexEmitter(),
            router=router,
            watcher=watcher,
            diagnostic=Mock(),
            protocol_error=Mock(),
        )
        session._native._host = CodexProcessHost(executable="codex")
        incident = RuntimeIncident(
            incident_id="process-exit",
            scope=RuntimeIncidentScope.PROCESS,
            state=RuntimeIncidentState.DETECTED,
            kind=RuntimeIncidentKind.PROCESS_EXIT,
            strategy=RuntimeRecoveryStrategy.AUTO_RESTART,
            retryability=RuntimeRetryability.IN_PROGRESS,
            safe_error="agent_runtime_exit",
            process_generation=1,
        )
        with (
            patch.object(session, "_observe_evidence", new=AsyncMock()),
            patch.object(session._native, "run", new=native_turn.start),
            patch.object(watcher, "begin_turn", new=AsyncMock()),
        ):
            await session.submit(TurnRequest(command_id="command-1", items=("hello",)))
            await asyncio.wait_for(request_started.wait(), timeout=1)
            task = next(iter(session._tasks))
            if exit_before_failure:
                await native_turn.connection_lost(incident, 1)
            response.set_exception(
                AppServerError(
                    "connection closed before turn/start ACK",
                    safe_error="agent_runtime_exit",
                    generation=1,
                    retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                )
            )
            await asyncio.gather(task, return_exceptions=True)
            await session._finish_turn_task(task, "command-1")
            if not exit_before_failure:
                check(
                    "transport uncertainty alone keeps command activity",
                    session._active_command_id == "command-1"
                    and "command-1" in session._committed_commands,
                )
                await native_turn.connection_lost(incident, 1)
            check(
                f"pre-ACK exit releases command activity (exit first={exit_before_failure})",
                session._active_command_id == "" and not session._committed_commands,
            )
            check(
                "submission identity is not a native turn identity",
                native_turn.interrupted_turn_id == ""
                and not router.bind_turn.called
                and native_turn.active_turn_id == "",
            )
            observations: list[RuntimeEvent] = []
            while session._events.qsize():
                observation = await session._events.get()
                assert isinstance(observation, RuntimeEvent)
                observations.append(observation)
            kinds = [event.kind for event in observations]
            check(
                "unknown observations retain explicit request correlation",
                all(
                    event.correlation_id == "command-1"
                    for event in observations
                    if event.kind is RuntimeEventKind.TURN_UNKNOWN
                ),
            )
            check(
                "process exit does not invent a terminal outcome",
                kinds.count(RuntimeEventKind.TURN_UNKNOWN) == 2
                and not set(kinds)
                & {
                    RuntimeEventKind.TURN_COMPLETED,
                    RuntimeEventKind.TURN_FAILED,
                    RuntimeEventKind.TURN_INTERRUPTED,
                },
            )
            try:
                await native_turn.start(TurnInput((InputItem(InputKind.TEXT, text="new"),)))
            except AppServerError as error:
                check(
                    "process exit keeps the unresolved native submission fenced",
                    error.safe_error == "codex_turn_outcome_unknown"
                    and native_turn.ambiguous_submission_id == "command-1",
                )
            else:
                check("unresolved native submission must reject a new turn", False)

    for exit_before_failure in (True, False):
        asyncio.run(scenario(exit_before_failure))


def test_evidence_cursor() -> None:
    """Evidence is incremental across native notifications and process restarts."""

    async def scenario() -> list[RuntimeEvent]:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product-session",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        session._request = SimpleNamespace(product_session_id="product-session")
        session._events = asyncio.Queue()
        session._sequence = 0
        session._event_namespace = "evidence-attachment"
        session._evidence_sequence = 0
        process = RuntimeProcessEvent(
            runtime_id="codex",
            kind=RuntimeProcessEventKind.STARTED,
            process_generation=3,
            process_state="ready",
            evidence_seq=1,
            created_at="2026-09-07T00:00:00Z",
        )
        rpc = RuntimeRpcEvidence(
            runtime_id="codex",
            method="turn/start",
            process_generation=3,
            latency_ms=37,
            evidence_seq=2,
            created_at="2026-09-07T00:00:01Z",
        )
        session._native = SimpleNamespace(
            host=SimpleNamespace(readiness=SimpleNamespace(process_generation=3)),
            process_events=(process,),
            rpc_evidence=(rpc,),
        )
        event = CodexSessionEvent(
            runtime_id="codex",
            session_id="native-session",
            kind=CodexSessionEventKind.TURN_STARTED,
            turn_id="native-turn",
        )
        await session._observe_evidence(event)
        await session._observe_evidence(event)
        session._native.rpc_evidence += (
            RuntimeRpcEvidence(
                runtime_id="codex",
                method="thread/resume",
                process_generation=4,
                latency_ms=41,
                evidence_seq=3,
                created_at="2026-09-07T00:00:02Z",
            ),
        )
        session._native.host.readiness.process_generation = 4
        await session._observe_evidence(event)
        return [session._events.get_nowait() for _ in range(session._events.qsize())]

    events = asyncio.run(scenario())
    check("repeated native notifications do not duplicate evidence", len(events) == 2)
    check(
        "evidence uses the neutral evidence-only channel",
        all(
            event.kind is RuntimeEventKind.RUNTIME_EVIDENCE
            and event.delivery is DeliveryClass.EVIDENCE_ONLY
            for event in events
        ),
    )
    check(
        "evidence preserves typed process and RPC fields",
        events[0].payload["process"][0]["kind"] == "started"
        and events[0].payload["rpc"][0]["latency_ms"] == 37,
    )
    check(
        "new generation forwards only unseen evidence",
        events[1].process_generation == 4
        and events[1].payload["process"] == []
        and len(events[1].payload["rpc"]) == 1
        and events[1].payload["rpc"][0]["evidence_seq"] == 3,
    )
    check(
        "evidence sequence and identity remain unique",
        [event.sequence for event in events] == [1, 2]
        and len({event.event_id for event in events}) == 2,
    )


def test_upstream_inspection_launch() -> None:
    captured = []
    host = HostWarmupRequest(
        "inspection",
        ROOT,
        process_sharing_scope="fixture-actor",
        model=ModelIntent(
            transport=ModelTransport(
                endpoint="https://model.example.test/v1", supports_websockets=True
            )
        ),
    )
    lease = SimpleNamespace(
        host=ControlledHost(),
        host_id="fixture-host",
        close=AsyncMock(),
    )

    async def reserve(request, **_kwargs):
        captured.append(request)
        return SimpleNamespace()

    async def scenario():
        runtime = provider()
        runtime._pool.reserve = AsyncMock(side_effect=reserve)
        runtime._pool.consume = AsyncMock(return_value=lease)
        with (
            patch("scholarseed_codex.pool.prepare_codex_runtime_home", return_value=ROOT),
            patch(
                "scholarseed_codex.provider.configured_codex_executable",
                return_value="/official/codex",
            ),
            patch(
                "scholarseed_codex.pool.CodexHostPool.model_catalog_argument",
                return_value=CodexRuntimeLaunchArgument(
                    option="-c", value='model_catalog_json="fixture"'
                ),
            ),
        ):
            await runtime.inspect(
                RuntimeInspectionRequest(
                    cwd=ROOT,
                    inventory=InventoryRequest(()),
                    host=host,
                )
            )
        runtime._pool.reserve.assert_awaited_once()
        check(
            "inspection is admitted as execution",
            runtime._pool.reserve.await_args.kwargs["role"] is HostRole.EXECUTION,
        )

    asyncio.run(scenario())
    request = captured[0]
    resolved = codex_host._resolve_launch_arguments(
        request.launch_arguments, request.process_environment
    )
    check(
        "inspection uses managed discovery and explicit principal",
        request.process_environment["CODEX_HOME"] == str(ROOT)
        and request.launch_cwd == ROOT / codex_isolation.CODEX_DISCOVERY_HOME_DIRNAME
        and request.process_sharing_scope == host.process_sharing_scope,
    )
    check(
        "inspection preserves managed isolation",
        request.executable == "/official/codex"
        and "--strict-config" in resolved
        and "project_root_markers=[]" in resolved
        and "project_doc_max_bytes=0" in resolved,
    )
    check("inspection releases its borrow", lease.close.await_count == 1)


def test_skill_refresh_uses_exclusive_control() -> None:
    events = []
    roots = (ROOT / "bundled-skills", ROOT / "user-skills")
    host = HostWarmupRequest(
        "skills",
        ROOT,
        process_sharing_scope="fixture-actor",
        skill_roots=roots,
        model=ModelIntent(
            transport=ModelTransport(
                endpoint="https://model.example.test/v1", supports_websockets=True
            )
        ),
    )

    class Skills:
        async def list_skills(self, *, cwd, force_reload=False):
            events.append(("list", force_reload))
            return SkillInventory(cwd=cwd, revision="refreshed" if force_reload else "cached")

    @asynccontextmanager
    async def mutation():
        events.append(("mutation", "enter"))
        try:
            yield
        finally:
            events.append(("mutation", "exit"))

    @asynccontextmanager
    async def control(**context):
        check("control keeps full principal startup context", context["host"] is host)
        yield SimpleNamespace(skill_control=Skills(), mutation=mutation, identity="fixture-host:1")

    async def scenario():
        runtime = provider()
        runtime._control = control
        for refresh in (False, True):
            await runtime.inspect(
                RuntimeInspectionRequest(
                    cwd=ROOT,
                    inventory=InventoryRequest((InventoryKind.SKILLS,), refresh=refresh),
                    roots=roots,
                    host=host,
                )
            )

    asyncio.run(scenario())
    check(
        "only forced refresh mutates, without expanding roots",
        events == [("list", False), ("mutation", "enter"), ("list", True), ("mutation", "exit")],
    )


def test_durable_thread_unsubscribes() -> None:
    check(
        "provider configuration participates in process isolation",
        pool_module._environment_digest({"MODEL_PROVIDER": "one"}, ())
        != pool_module._environment_digest({"MODEL_PROVIDER": "two"}, ()),
    )

    async def run() -> None:
        state = SimpleNamespace(
            request=SimpleNamespace(ephemeral=False),
            turn=SimpleNamespace(close=AsyncMock(), replacement_sealed=False),
            permission_confirmation=None,
        )
        host = CodexProcessHost(executable="unused-contract-executable")
        host._threads["durable"] = state
        host._watcher = SimpleNamespace(close=AsyncMock())
        host._generation = 1
        host.state = CodexProcessState.READY
        host._router = SimpleNamespace(close=Mock())
        host.request = AsyncMock(return_value={"status": "unsubscribed"})
        await host.close_thread("durable")
        check(
            "durable close releases the event subscription",
            host.request.call_args.args == ("thread/unsubscribe", {"threadId": "durable"}),
        )
        check("durable close removes local attachment", not host._threads)

    asyncio.run(run())


def test_subscription_capability_rejection_is_terminal() -> None:
    code = "subscription_sharing_unsupported_capability"
    privateMessage = "private upstream detail https://secret.example/token?access=credential"
    expectedMessage = (
        "The ChatGPT subscription connection does not support this request capability. "
        "Use a compatible model source or start a task without that capability; "
        "retrying unchanged will fail."
    )
    for error in (
        {"code": code, "message": privateMessage},
        {"error": {"code": code, "message": privateMessage}},
        {"code": code.upper(), "message": privateMessage},
        {
            "message": "unexpected status 400 Bad Request: "
            + json.dumps({"error": {"code": code, "message": privateMessage}})
        },
    ):
        originalError = json.loads(json.dumps(error))
        failure = provider_failure(error)
        check(
            "subscription capability rejection is terminal and safely identified",
            failure.code.casefold() == code
            and failure.diagnostic_code == code
            and failure.retryability is RuntimeRetryability.TERMINAL
            and failure.message == expectedMessage
            and not authentication_failure(failure),
        )
        check("provider classification preserves the original error", error == originalError)
    check("subscription capability has a dedicated provider family", code in provider_codes())
    for unknownCode in ("vendor_unknown", code + "_unknown"):
        failure = provider_failure({"code": unknownCode, "message": privateMessage})
        check(
            "unregistered provider capability errors stay generic and redacted",
            failure.diagnostic_code == "codex_provider_failed"
            and failure.message == "The model provider rejected the request."
            and failure.retryability is RuntimeRetryability.USER_RETRYABLE
            and not authentication_failure(failure)
            and unknownCode not in provider_codes(),
        )


def test_provider_http_authentication() -> None:
    for code in ("", "invalid_request_error", "bad_request", "vendor_unknown"):
        failure = provider_failure(
            {
                "message": "unexpected status 401 Unauthorized: "
                + json.dumps({"error": {"code": code, "message": "private credential detail"}})
            }
        )
        check(
            f"HTTP 401 overrides generic provider code {code!r}",
            failure.code == "authentication_error"
            and failure.http_status == 401
            and failure.message == PROVIDER_AUTH_MESSAGE
            and failure.retryability is RuntimeRetryability.TERMINAL,
        )
    failure = provider_failure({"message": "unexpected status 401 Unauthorized: no body"})
    check("HTTP 401 without JSON is authentication", failure.code == "authentication_error")
    for status in (400, 403):
        failure = provider_failure(
            {
                "message": f"unexpected status {status}: "
                + json.dumps({"error": {"code": "invalid_request_error"}})
            }
        )
        check(
            f"HTTP {status} is not inferred as invalid credentials",
            failure.code == "invalid_request_error",
        )


def test_codex_retry_exhaustion_preserves_provider_status() -> None:
    for status, code, message in (
        (429, "rate_limit_exceeded", PROVIDER_RATE_LIMIT_MESSAGE),
        (500, "server_error", PROVIDER_UNAVAILABLE_MESSAGE),
        (502, "server_error", PROVIDER_UNAVAILABLE_MESSAGE),
        (503, "server_error", PROVIDER_UNAVAILABLE_MESSAGE),
        (504, "server_error", PROVIDER_UNAVAILABLE_MESSAGE),
    ):
        for info_key, variant, status_key in (
            ("codexErrorInfo", "responseTooManyFailedAttempts", "httpStatusCode"),
            ("codex_error_info", "response_too_many_failed_attempts", "http_status_code"),
        ):
            error = {"message": "request failed", info_key: {variant: {status_key: status}}}
            for wrapped in (error, {"error": error}):
                failure = provider_failure(wrapped)
                check(
                    f"native {info_key} status {status} survives error envelopes",
                    failure.code == code
                    and failure.http_status == status
                    and failure.message == message
                    and failure.retryability is RuntimeRetryability.USER_RETRYABLE,
                )
        failure = provider_failure({"message": f"exceeded retry limit, last status: {status}"})
        check(
            f"retry exhaustion text preserves status {status}",
            failure.code == code and failure.http_status == status and failure.message == message,
        )
    for invalid in (None, True, "429", 429.0, 200, 600, {"status": 429}):
        failure = provider_failure(
            {
                "message": "request failed",
                "codexErrorInfo": {"responseTooManyFailedAttempts": {"httpStatusCode": invalid}},
            }
        )
        check("invalid native HTTP status is ignored", failure.http_status is None)
    for code in ("insufficient_quota", "invalid_api_key", "content_policy_violation"):
        failure = provider_failure(
            {
                "code": code,
                "message": "exceeded retry limit, last status: 503",
                "codexErrorInfo": {"responseTooManyFailedAttempts": {"httpStatusCode": 429}},
            }
        )
        check(
            f"explicit {code} wins over status; structured status wins over text",
            failure.code == code
            and failure.http_status == 429
            and failure.retryability is RuntimeRetryability.TERMINAL,
        )
    failure = provider_failure({"message": "user mentioned last status: 429"})
    check("arbitrary prose does not establish HTTP status", failure.http_status is None)

    async def notification() -> None:
        emitter = SimpleNamespace(incident=AsyncMock())
        runtime = CodexTurnRuntime(
            SimpleNamespace(thread_id="thread", attached_generation=1),
            request=AsyncMock(),
            ensure_attached=AsyncMock(return_value=1),
            stale_requests=AsyncMock(),
            emitter=emitter,
            router=ThreadRouter(),
            watcher=SimpleNamespace(),
            diagnostic=Mock(),
            protocol_error=Mock(),
        )
        await runtime.notification(
            "error",
            {
                "turnId": "turn",
                "willRetry": False,
                "error": {
                    "message": "exceeded retry limit, last status: 429 Too Many Requests",
                    "codexErrorInfo": {"responseTooManyFailedAttempts": {"httpStatusCode": 429}},
                },
            },
            generation=1,
        )
        incident = emitter.incident.await_args.args[1]
        check(
            "native exhausted error emits a rate-limit incident without bridge backfill",
            incident.provider_error_code == "rate_limit_exceeded"
            and incident.provider_http_status == 429
            and incident.safe_error == PROVIDER_RATE_LIMIT_MESSAGE
            and incident.retryability is RuntimeRetryability.USER_RETRYABLE,
        )

    asyncio.run(notification())


def test_codex_flattened_stream_disconnect_recovers_transient_semantics() -> None:
    """Codex 压平流内 5xx 后 adapter 仍要恢复「暂时不可用」，而不是「rejected the request」。

    bug 87190842：Codex 把上游 response.failed(server_error, ``<500> …``) 压平成
    ``stream disconnected before completion: <500> …`` 散文；前缀锚定的 ``<NNN>`` 提取被包装
    挡住后 code 塌成 codex_provider_failed，用户把瞬时 500 读成确定性拒绝。
    """
    flattened = provider_failure(
        {
            "message": "stream disconnected before completion: <500> InternalError.Algo: "
            "An error occurred in model serving, error message is: [Unexpected error: UNKNOWN]",
            "codex_error_info": "other",
        }
    )
    check(
        "flattened in-stream 5xx recovers server_error semantics",
        flattened.code == "server_error"
        and flattened.diagnostic_code == "server_error"
        and flattened.http_status == 500
        and flattened.message == PROVIDER_UNAVAILABLE_MESSAGE
        and flattened.retryability is RuntimeRetryability.USER_RETRYABLE,
    )
    bare = provider_failure({"message": "<503> InternalError.Algo: x"})
    check(
        "bare 5xx prefix without structured code still classifies as transient",
        bare.code == "server_error" and bare.http_status == 503,
    )
    bridge_reset = provider_failure(
        {
            "message": 'unexpected status 502 Bad Gateway: {"error":{"code":'
            '"service_unavailable","message":"The model provider is temporarily unavailable."}}'
        }
    )
    check(
        "structured bridge transport failure remains user-retryable and unavailable",
        bridge_reset.code == "service_unavailable"
        and bridge_reset.message == PROVIDER_UNAVAILABLE_MESSAGE
        and bridge_reset.retryability is RuntimeRetryability.USER_RETRYABLE,
    )
    overloaded = provider_failure({"error": {"code": "server_is_overloaded"}})
    check(
        "structured overload remains temporarily unavailable",
        overloaded.code == "server_is_overloaded"
        and overloaded.message == PROVIDER_UNAVAILABLE_MESSAGE
        and overloaded.retryability is RuntimeRetryability.USER_RETRYABLE,
    )
    safety = provider_failure(
        {"code": "server_error", "message": "<400> InternalError.Algo.DataInspectionFailed: x"}
    )
    check(
        "content safety signature stays terminal despite 4xx prefix",
        safety.code == CONTENT_SAFETY_BLOCKED
        and safety.retryability is RuntimeRetryability.TERMINAL,
    )


def test_gate_interrupt_reclaims_only_active_command_terminal() -> None:
    print("== gate interrupt terminal cleanup ==")

    async def scenario() -> list[tuple[str, dict[str, Any]]]:
        calls: list[tuple[str, dict[str, Any]]] = []
        inventory_reads = 0
        completion: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

        async def request(
            method: str, params: dict[str, Any], *, generation: int
        ) -> dict[str, Any]:
            nonlocal inventory_reads
            if generation != 1:
                raise AssertionError("unexpected Codex process generation")
            calls.append((method, params))
            if method == "turn/interrupt":
                if not completion.done():
                    completion.set_result({"status": "interrupted"})
                return {}
            if method == NATIVE_BACKGROUND_TERMINALS_LIST_METHOD:
                inventory_reads += 1
                rows = [{"itemId": "unrelated-item", "processId": "unrelated-process"}]
                if inventory_reads == 1:
                    rows.append({"itemId": "active-item", "processId": "active-process"})
                return {"data": rows, "nextCursor": None}
            if method == NATIVE_BACKGROUND_TERMINALS_TERMINATE_METHOD:
                return {"terminated": True}
            raise AssertionError(f"unexpected Codex method: {method}")

        thread = SimpleNamespace(thread_id="native-thread", attached_generation=1)
        runtime = CodexTurnRuntime(
            thread,
            request=request,
            ensure_attached=AsyncMock(return_value=1),
            stale_requests=AsyncMock(),
            emitter=CodexEmitter(),
            router=SimpleNamespace(),
            watcher=SimpleNamespace(),
            diagnostic=Mock(),
            protocol_error=Mock(),
        )
        runtime.active_turn_id = "active-turn"
        runtime.active_command_items["active-turn"] = {"active-item"}
        runtime.turn_done = completion
        await runtime.interrupt(cleanup_background_processes=True)
        await runtime.interrupt()
        return calls

    calls = asyncio.run(scenario())
    terminated = [
        params for method, params in calls if method == NATIVE_BACKGROUND_TERMINALS_TERMINATE_METHOD
    ]
    check(
        "gate terminates only the interrupted command",
        terminated == [{"threadId": "native-thread", "processId": "active-process"}],
    )
    check(
        "ordinary interrupt does not inspect background terminals",
        [method for method, _ in calls].count(NATIVE_BACKGROUND_TERMINALS_LIST_METHOD) == 3,
    )


def test_version_probe_never_acquires_persistent_authentication() -> None:
    async def run() -> None:
        admission = Mock(side_effect=AssertionError("persistent resource accessed"))
        pool = CodexHostPool(resource_lease=admission)
        result = object()
        with patch.object(pool, "_probe_readiness", AsyncMock(return_value=result)):
            observed = await pool.probe_readiness()
            check("isolated version probe remains available before commit", observed is result)
            check("version probe has no credential lease", not admission.called)
            check("completed probe releases command ownership", not pool._commands)
        with patch.object(pool, "_probe_readiness", AsyncMock(side_effect=RuntimeError("failed"))):
            try:
                await pool.probe_readiness()
            except RuntimeError:
                pass
            check("failed probe releases command ownership", not pool._commands)
        await pool.aclose()

    asyncio.run(run())


def test_version_probe_deduplicates_and_tracks_resolved_executable() -> None:
    async def run() -> None:
        pool = CodexHostPool()
        readiness = CodexRuntimeReadiness(
            runtime_id="codex",
            status=CodexRuntimeStatus.READY,
            ready=True,
            executable="/first/codex",
            version="codex-cli 0.159.0",
        )
        with (
            patch.object(
                pool_module, "discover_codex_executable", return_value="/first/codex"
            ) as discover,
            patch.object(
                pool_module, "_probe_codex_cli_readiness", new=AsyncMock(return_value=readiness)
            ) as probe,
        ):
            results = await asyncio.gather(
                pool.probe_readiness(), pool.probe_readiness(), pool.probe_readiness()
            )
            check("concurrent version probes share one execution", probe.await_count == 1)
            check(
                "shared execution preserves readiness",
                all(result is readiness for result in results),
            )
            discover.return_value = "/second/codex"
            await pool.probe_readiness()
            check(
                "changed executable resolution cannot reuse old readiness", probe.await_count == 2
            )
            check(
                "probe executes the resolved cache identity",
                probe.call_args.args[0] == "/second/codex",
            )

    asyncio.run(run())


def test_product_plan_replaces_native_only_when_declared() -> None:
    check(
        "ordinary adapter retains native planning",
        session_thread_config(frozenset())[CODEX_PLAN_TOOL_ENABLED_CONFIG] is True,
    )
    check(
        "unrelated service tools retain native planning",
        session_thread_config(frozenset(), frozenset({"scholarseed_bridge"}))[
            CODEX_PLAN_TOOL_ENABLED_CONFIG
        ]
        is True,
    )
    check(
        "declared replacement disables duplicate native tool",
        session_thread_config(frozenset(), frozenset({"update_plan"}))[
            CODEX_PLAN_TOOL_ENABLED_CONFIG
        ]
        is False,
    )


def test_submission_classification_uses_the_actual_write_boundary() -> None:
    async def scenario(mode: str) -> None:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        host = CodexProcessHost(executable="codex", rpc_timeout=0.01)
        host._generation = 1
        host._proc = SimpleNamespace(returncode=None)
        session._native._host = host
        session._binding = RuntimeBinding(
            product_session_id="product",
            runtime_id="codex",
            adapter_version="fixture",
            runtime_version="fixture",
            protocol_version="fixture",
            protocol_schema_hash="fixture",
            opaque_session_ref="native-session",
            capabilities=CapabilitySet(),
        )
        session._active_command_id = "command-1"
        stream = Mock(is_closing=Mock(return_value=False))
        stream.drain = AsyncMock()
        host._rpc_writer.attach(stream, 1)
        request_started = asyncio.Event()
        incident = RuntimeIncident(
            incident_id="process-exit",
            scope=RuntimeIncidentScope.PROCESS,
            state=RuntimeIncidentState.DETECTED,
            kind=RuntimeIncidentKind.PROCESS_EXIT,
            strategy=RuntimeRecoveryStrategy.AUTO_RESTART,
            retryability=RuntimeRetryability.IN_PROGRESS,
            safe_error="agent_runtime_exit",
            process_generation=1,
        )

        async def request(method, params, **kwargs):
            request_started.set()
            return await host._request_connected(method, params, **kwargs)

        turn = CodexTurnRuntime(
            ThreadAttachment(
                thread_id="native-session",
                request=CodexSessionOpenRequest(request_id="fixture", runtime_id="codex", cwd=ROOT),
                listener=session._on_native_event,
                model="model",
                writable_roots=(),
                attached_generation=1,
            ),
            request=request,
            ensure_attached=AsyncMock(return_value=1),
            stale_requests=AsyncMock(),
            emitter=CodexEmitter(),
            router=Mock(spec=ThreadRouter),
            watcher=WorkspaceWatch(AsyncMock(return_value={}), Mock()),
            diagnostic=Mock(),
            protocol_error=Mock(),
        )

        def write(payload):
            message = json.loads(payload)
            if mode == "write_failure":
                raise BrokenPipeError("write failed")
            if mode in {"method_rejected", "invalid_params", "internal_error"}:
                host._rpc_requests.resolve(
                    {
                        "id": message["id"],
                        "error": {
                            "code": {
                                "method_rejected": -32601,
                                "invalid_params": -32602,
                                "internal_error": -32603,
                            }[mode]
                        },
                    },
                    1,
                )
            elif mode == "malformed_ack":
                host._rpc_requests.resolve({"id": message["id"], "result": {}}, 1)

        async def disconnected(**kwargs):
            host._rpc_writer.detach(1)
            await turn.connection_lost(incident, 1)

        stream.write.side_effect = write
        if mode == "drain_failure":
            stream.drain.side_effect = BrokenPipeError("drain failed")
        if mode == "lock_disconnect":
            await host._rpc_writer._lock.acquire()
        with (
            patch.object(session, "_observe_evidence", new=AsyncMock()),
            patch.object(host, "_discard_process", new=AsyncMock()),
            patch.object(host, "_handle_process_exit", new=disconnected),
            patch.object(turn._watcher, "begin_turn", new=AsyncMock()),
        ):
            if mode == "preflight_failure":
                turn._ensure_attached.side_effect = AppServerError(
                    "attachment unavailable", retryability=RuntimeRetryability.UNKNOWN_OUTCOME
                )
            task = asyncio.create_task(
                turn.start(
                    TurnInput(
                        (InputItem(InputKind.TEXT, text="hello"),),
                        client_user_message_id="command-1",
                    )
                )
            )
            if mode == "lock_disconnect":
                await asyncio.wait_for(request_started.wait(), 1)
                await disconnected()
                host._rpc_writer._lock.release()
            result = (await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 1))[0]
            assert isinstance(result, AppServerError), result
            await session._finish_turn_task(task, "command-1")
        not_submitted = mode in {"preflight_failure", "lock_disconnect", "method_rejected"}
        observations = []
        while session._events.qsize():
            observations.append(await session._events.get())
        terminals = [
            event
            for event in observations
            if event.kind in {RuntimeEventKind.TURN_FAILED, RuntimeEventKind.TURN_UNKNOWN}
        ]
        if not_submitted:
            check(f"{mode}: explicit negative proof", result.submission_not_applied)
            check(
                f"{mode}: no unknown terminal",
                len(terminals) == 1 and terminals[0].kind is RuntimeEventKind.TURN_FAILED,
            )
            check(
                f"{mode}: public not-submitted classification",
                terminals[0].payload["error_code"] == RUNTIME_TURN_NOT_SUBMITTED,
            )
            check(
                f"{mode}: no ambiguity created",
                not turn.ambiguous_submission_id and not session._active_command_id,
            )
        else:
            check(
                f"{mode}: attempted write remains unknown",
                not result.submission_not_applied
                and result.retryability is RuntimeRetryability.UNKNOWN_OUTCOME,
            )
            check(
                f"{mode}: unknown is never a false failure",
                bool(terminals)
                and all(event.kind is RuntimeEventKind.TURN_UNKNOWN for event in terminals),
            )
            check(f"{mode}: ambiguity retained", turn.ambiguous_submission_id == "command-1")
        check(f"{mode}: no automatic resend", stream.write.call_count <= 1)
        check(
            f"{mode}: no native turn invented",
            not turn.active_turn_id and not turn.interrupted_turn_id,
        )

    for mode in (
        "preflight_failure",
        "lock_disconnect",
        "write_failure",
        "drain_failure",
        "timeout",
        "method_rejected",
        "invalid_params",
        "internal_error",
        "malformed_ack",
    ):
        asyncio.run(scenario(mode))


def test_proven_prewrite_retry_keeps_the_original_submission() -> None:
    async def scenario(unknown: bool) -> None:
        request = CodexSessionOpenRequest(request_id="fixture", runtime_id="codex", cwd=ROOT)
        host = CodexProcessHost(
            executable="unused", recovery_initial_delay=0, recovery_jitter_ratio=0
        )
        native = CodexThreadSession(request, host=host)
        native._opened = True
        native.session_id = "same-thread"
        result = SimpleNamespace(
            usage=SimpleNamespace(
                input_tokens=0, output_tokens=0, cache_read_tokens=0, cache_creation_tokens=0
            )
        )
        failure = AppServerError(
            "transport",
            safe_error="runtime_transport_lost",
            submission_not_applied=not unknown,
            retryability=(
                RuntimeRetryability.UNKNOWN_OUTCOME
                if unknown
                else RuntimeRetryability.USER_RETRYABLE
            ),
        )
        guard = Mock()
        prepare = AsyncMock(return_value=guard)
        turn = SimpleNamespace(
            submission_revision=0,
            check_submission_revision=Mock(),
            wait_submission_retry=AsyncMock(),
            start=AsyncMock(side_effect=[failure, result]),
            prepare_submission_retry=AsyncMock(
                side_effect=lambda pending, _revision, _deadline: pending
            ),
        )
        state = SimpleNamespace(turn=turn, request=request, model="model", writable_roots=())
        host._threads[native.session_id] = state

        async def prepare_gate(pending, _revision, _deadline):
            return await pending

        turn.prepare_submission_retry.side_effect = prepare_gate
        with patch.object(host, "prepare_submission_retry", new=prepare):
            if unknown:
                try:
                    await native.run(TurnInput((InputItem(InputKind.TEXT, text="once"),)))
                except AppServerError as error:
                    assert error is failure
                else:
                    raise AssertionError("unknown outcome was retried")
                assert turn.start.await_count == 1 and not prepare.called
            else:
                assert (
                    await native.run(TurnInput((InputItem(InputKind.TEXT, text="once"),))) is result
                )
                assert turn.start.await_count == 2 and prepare.await_count == 1
                initial, retried = turn.start.await_args_list
                assert initial.args[0] is retried.args[0]
                assert initial.args[0].client_user_message_id
                assert initial.kwargs["deadline"] == retried.kwargs["deadline"]
                assert retried.kwargs["before_write"] is not None

    asyncio.run(scenario(False))
    asyncio.run(scenario(True))
    check(
        "only proven transient prewrite failure retries the exact frozen submission within the original budget",
        True,
    )


def test_submission_recovery_budget_and_empty_proof() -> None:
    async def scenario() -> None:
        host = CodexProcessHost(
            executable="unused", recovery_initial_delay=0, recovery_jitter_ratio=0
        )
        host._generation = 2
        host._exited_generations.append(1)
        state = ThreadAttachment(
            thread_id="empty",
            request=CodexSessionOpenRequest(request_id="fixture", runtime_id="codex", cwd=ROOT),
            listener=None,
            attached_generation=2,
            absent_generation=2,
            fresh_generation=1,
        )
        watcher = SimpleNamespace(begin_turn=AsyncMock(), abandon_turn=Mock())
        writes = []
        release = asyncio.Event()

        async def request(method, params, *, generation, before_write=None, submission=None):
            if before_write:
                before_write()
            submission.attempt()
            writes.append(params)
            await release.wait()
            turn.turn_done.set_result({"id": "native-turn", "status": "completed"})
            return {"turn": {"id": "native-turn"}}

        turn = CodexTurnRuntime(
            state,
            request=request,
            ensure_attached=AsyncMock(return_value=2),
            stale_requests=AsyncMock(),
            emitter=CodexEmitter(),
            router=ThreadRouter(),
            watcher=watcher,
            diagnostic=Mock(),
            protocol_error=Mock(),
        )
        state.turn = turn
        host._threads[state.thread_id] = state
        turn_input = TurnInput((InputItem(InputKind.TEXT, text="same input"),))
        try:
            await turn.start(turn_input, deadline=asyncio.get_running_loop().time() - 1)
        except AppServerError as error:
            assert error.submission_not_applied
        else:
            raise AssertionError("expired submission was written")
        assert not writes and not turn.submission_attempted and turn.turn_done is None

        entered = asyncio.Event()

        async def wait_watcher(_turn):
            entered.set()
            await asyncio.Event().wait()

        watcher.begin_turn = wait_watcher
        pending = asyncio.create_task(
            turn.start(turn_input, deadline=asyncio.get_running_loop().time() + 1)
        )
        await entered.wait()
        await turn.interrupt()
        error = (await asyncio.gather(pending, return_exceptions=True))[0]
        assert isinstance(error, AppServerError) and error.submission_not_applied
        assert not writes and turn.turn_done is None

        watcher.begin_turn = AsyncMock()
        pending = asyncio.create_task(
            turn.start(turn_input, deadline=asyncio.get_running_loop().time() + 0.02)
        )
        while not writes:
            if pending.done():
                pending.result()
            await asyncio.sleep(0)
        await asyncio.sleep(0.04)
        assert not pending.done()
        release.set()
        await pending
        assert turn.submission_attempted and host.seal_empty_replacement("empty") is None
        turn.submission_attempted = False
        turn.active_turn_id = ""
        turn.active_turn_client_id = ""
        turn.execution_observed = True
        assert host.seal_empty_replacement("empty") is None
        turn.execution_observed = False
        state.fresh_generation = 0
        assert host.seal_empty_replacement("empty") is None
        state.fresh_generation = 1
        assert host.seal_empty_replacement("empty") == (1, 2)
        assert turn.replacement_sealed and host.seal_empty_replacement("empty") is None
        try:
            await turn.start(TurnInput(()))
        except AppServerError as error:
            assert error.submission_not_applied
        else:
            raise AssertionError("sealed thread admitted another write")

    asyncio.run(scenario())
    check(
        "prewrite cancellation/deadline never times out written execution; empty proof is lifetime scoped and sealed",
        True,
    )


def test_empty_attachment_proof_uses_the_native_open_contract() -> None:
    async def scenario(resumed: bool, seeded: bool) -> None:
        host = CodexProcessHost(executable="unused")
        host._generation = 1
        request = CodexSessionOpenRequest(
            request_id="fixture",
            runtime_id="codex",
            cwd=ROOT,
            resume_session_id="native-thread" if resumed else "",
            model="model",
            model_provider="provider",
        )
        with (
            patch.object(host, "start", new=AsyncMock()),
            patch.object(host, "ensure_skill_roots", new=AsyncMock()),
            patch.object(host, "_prepare_thread_resources", new=AsyncMock()),
            patch.object(
                host,
                "_request_thread_attachment",
                new=AsyncMock(
                    return_value={
                        "thread": {"id": "native-thread", "turns": []},
                        "model": "model",
                        "modelProvider": "provider",
                    }
                ),
            ),
            patch.object(host._watcher, "open", new=AsyncMock()),
            patch.object(host, "_check_attachment_process"),
        ):
            thread_id, _, _ = await host._open_thread(request, None)
        state = host.attachment(thread_id)
        assert state.fresh_generation == (0 if resumed else 1)
        if seeded:
            with patch.object(host, "request", new=AsyncMock(side_effect=RuntimeError("lost"))):
                try:
                    await host.seed_history(thread_id, (HistoryEntry("user", "prior input"),))
                except RuntimeError:
                    pass
                else:
                    raise AssertionError("history write failure was swallowed")
            assert state.fresh_generation == 0

    for resumed, seeded in ((False, False), (True, False), (False, True)):
        asyncio.run(scenario(resumed, seeded))
    check(
        "native open marks only new empty threads fresh and attempted history seeding revokes proof",
        True,
    )


def test_completed_resumed_turn_restores_authoritative_assistant_message() -> None:
    async def scenario():
        events = []

        async def listen(event):
            events.append(event)

        state = ThreadAttachment(
            thread_id="native-session",
            request=CodexSessionOpenRequest(request_id="fixture", runtime_id="codex", cwd=ROOT),
            listener=listen,
            attached_generation=2,
        )
        turn = CodexTurnRuntime(
            state,
            request=AsyncMock(),
            ensure_attached=AsyncMock(return_value=2),
            stale_requests=AsyncMock(),
            emitter=CodexEmitter(),
            router=ThreadRouter(),
            watcher=SimpleNamespace(abandon_turn=Mock()),
            diagnostic=Mock(),
            protocol_error=Mock(),
        )
        turn.interrupted_turn_id = "native-turn"
        turn.interrupted_turn_client_id = "original-client"
        await turn._reconcile_interrupted_from_thread(
            {
                "turns": [
                    {
                        "id": "native-turn",
                        "status": "completed",
                        "items": [
                            {
                                "id": "answer",
                                "type": "agentMessage",
                                "text": "recovered final answer",
                                "phase": "final_answer",
                            }
                        ],
                    }
                ]
            },
            2,
        )
        return events

    events = asyncio.run(scenario())
    check(
        "completed resumed turn restores authoritative answer before reconciliation",
        any(event.payload.get("text") == "recovered final answer" for event in events)
        and events[-1].payload.get("terminal_status") == "completed",
    )


def test_native_fork_at_turn() -> None:
    async def scenario() -> None:
        host = CodexProcessHost(executable="codex")
        host._generation = 1
        host._proc = SimpleNamespace(returncode=None, pid=123)
        host.state = CodexProcessState.READY
        request = CodexSessionOpenRequest(
            request_id="child-product",
            runtime_id="codex",
            cwd=Path(tempfile.gettempdir()),
            fork_session_id="source-thread",
            fork_turn_id="turn-two",
            model="fork-model",
        )
        with (
            patch.object(host, "start", new_callable=AsyncMock),
            patch.object(host, "ensure_skill_roots", new_callable=AsyncMock),
            patch.object(host._watcher, "open", new_callable=AsyncMock),
            patch.object(host._emitter, "emit", new_callable=AsyncMock),
            patch.object(host, "_request_connected", new_callable=AsyncMock) as rpc,
        ):
            rpc.return_value = {
                "thread": {"id": "child-thread", "turns": []},
                "model": "fork-model",
                "modelProvider": "fork-provider",
            }
            thread_id, _, _ = await host._open_thread(request, None)
            check("fork creates independent native identity", thread_id == "child-thread")
            check(
                "fork never claims an empty new-thread replacement proof",
                host._threads[thread_id].fresh_generation == 0,
            )
            check(
                "fork uses native inclusive turn anchor",
                rpc.call_args.args[0] == "thread/fork"
                and rpc.call_args.args[1]["lastTurnId"] == "turn-two",
            )
            check(
                "fork never resumes or truncates source",
                rpc.await_count == 1 and rpc.call_args.args[1]["threadId"] == "source-thread",
            )
            check("fork does not register source as target", "source-thread" not in host._threads)
            try:
                await host._open_thread(replace(request, resume_session_id="source-thread"), None)
            except AppServerError:
                check("mixed resume and fork rejected", True)
            else:
                check("mixed resume and fork rejected", False)
            rpc.return_value = {"thread": {"id": "source-thread", "turns": []}}
            try:
                await host._open_thread(request, None)
            except AppServerError:
                check("fork cannot alias source identity", True)
            else:
                check("fork cannot alias source identity", False)

    asyncio.run(scenario())


def main() -> int:
    test_completed_resumed_turn_restores_authoritative_assistant_message()
    test_empty_attachment_proof_uses_the_native_open_contract()
    test_submission_classification_uses_the_actual_write_boundary()
    test_submission_recovery_budget_and_empty_proof()
    test_proven_prewrite_retry_keeps_the_original_submission()
    test_submission_task_failure_emits_typed_incident()
    test_exited_turn_is_not_reported_as_running_by_the_thread_handle()
    test_turn_admission_is_checked_under_the_transport_write_lock()
    test_native_fork_at_turn()
    test_version_probe_deduplicates_and_tracks_resolved_executable()
    test_product_plan_replaces_native_only_when_declared()
    test_version_probe_never_acquires_persistent_authentication()
    test_command_exit_output()
    test_private_command_transport()
    test_command_repeated_cancellation()
    test_preflight_process_cleanup()
    test_preflight_output_budget()
    test_catalog_process_cleanup()
    test_native_agent_message_capability()
    test_approval_catalog_binding()
    test_mixed_catalog_declarations()
    test_catalog_immutable_publication()
    test_catalog_http_preflight_boundaries()
    test_host_catalog_preflight_receipts()
    test_catalog_version_pins_granted_execution()
    test_child_thread_terminal_truth_and_authentication_classification()
    test_durable_thread_unsubscribes()
    test_event_translation()
    test_plan_projection()
    test_turn_timeout_projection()
    test_callback_translation()
    test_subagent_translation()
    test_extension_and_incident_are_lossless()
    test_dependency_direction()
    test_capability_truthfulness()
    test_development_version_policy()
    test_version_compatibility()
    test_remote_authentication_independence()
    test_vendor_neutral_model_projection()
    test_remote_retry_budget_projection()
    test_internal_channel_proxy_bypass_projection()
    test_session_scoped_web_search_projection()
    test_chat_models_explicitly_disable_native_search()
    test_optional_native_search_negotiation()
    test_opaque_launch_secret_projection()
    test_runtime_home_resolution_precedes_storage_mutation()
    test_sqlite_storage_declaration_and_launch()
    test_home_config_storage_discovery()
    test_runtime_preparation_preserves_existing_directories()
    test_environment_removal()
    test_managed_codex_isolation()
    test_control_borrows_execution_host()
    test_session_skill_root_projection()
    test_session_skill_configuration()
    test_session_shell_environment_configuration()
    test_permission_intent_projection()
    test_permission_reconfiguration()
    test_model_reconfiguration()
    test_inventory_projection()
    test_mcp_control_projection()
    test_content_completion_and_sequence()
    test_nullable_phase_message_streaming()
    test_public_reasoning_streaming()
    test_gate_interrupt_reclaims_only_active_command_terminal()
    test_capability_resolution_is_synthesised_once_per_pair()
    test_subagent_lifecycle_survives_out_of_order_observation()
    test_unsupported_dynamic_tool_fails_fast()
    test_resumed_dynamic_tool_declaration_is_preserved()
    test_resumed_skill_policy_cannot_be_relaxed()
    test_thread_model_configuration_is_confirmed()
    test_same_process_reopen_restores_previous_configuration_on_failure()
    test_started_native_turn_owns_terminal_outcome()
    test_unknown_native_turn_owns_terminal_outcome()
    test_process_exit_unknown_releases_command_activity()
    test_preack_process_exit_releases_command_activity()
    test_evidence_cursor()
    test_upstream_inspection_launch()
    test_skill_refresh_uses_exclusive_control()
    test_codex_flattened_stream_disconnect_recovers_transient_semantics()
    test_codex_retry_exhaustion_preserves_provider_status()
    test_subscription_capability_rejection_is_terminal()
    test_provider_http_authentication()
    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


def test_exited_turn_is_not_reported_as_running_by_the_thread_handle() -> None:
    async def scenario():
        thread = CodexThreadSession(
            CodexSessionOpenRequest(request_id="fixture", runtime_id="codex", cwd=ROOT)
        )
        thread.session_id = "native-session"
        thread.active_turn_id = "native-turn"
        incident = RuntimeIncident(
            incident_id="exit",
            scope=RuntimeIncidentScope.PROCESS,
            state=RuntimeIncidentState.DETECTED,
            kind=RuntimeIncidentKind.PROCESS_EXIT,
            strategy=RuntimeRecoveryStrategy.AUTO_RESTART,
            retryability=RuntimeRetryability.IN_PROGRESS,
            safe_error="agent_runtime_exit",
            process_generation=1,
        )
        event = CodexSessionEvent(
            runtime_id="codex",
            kind=CodexSessionEventKind.TURN_UNKNOWN,
            session_id="native-session",
            turn_id="native-turn",
            incident=incident,
        )
        await thread._on_event(event)
        assert thread.active_turn_id == ""
        thread.active_turn_id = "new-turn"
        await thread._on_event(event)
        assert thread.active_turn_id == "new-turn"
        await thread._on_event(replace(event, turn_id="new-turn", incident=None))
        assert thread.active_turn_id == "new-turn"

    asyncio.run(scenario())
    check("process exit clears only the exact thread's execution activity", True)


def test_turn_admission_is_checked_under_the_transport_write_lock() -> None:
    async def scenario(change: str) -> None:
        session = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="product",
                cwd=ROOT,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    )
                ),
            )
        )
        host = CodexProcessHost(executable="codex")
        session._native._host = host
        session._binding = RuntimeBinding(
            product_session_id="product",
            runtime_id="codex",
            adapter_version="fixture",
            runtime_version="fixture",
            protocol_version="fixture",
            protocol_schema_hash="fixture",
            opaque_session_ref="native-session",
            capabilities=CapabilitySet(),
        )
        writer = JsonLineWriter()
        stream = Mock()
        stream.is_closing.return_value = False
        stream.drain = AsyncMock()
        writer.attach(stream, host.process_generation)
        waiting = asyncio.Event()
        settled = asyncio.Event()
        allowed = True

        def authorized():
            if isinstance(allowed, Exception):
                raise allowed
            return allowed

        finish = session._finish_turn_task

        async def finish_task(task, command_id, call_id=""):
            try:
                await finish(task, command_id)
            finally:
                settled.set()

        async def request(method, params, *, generation, before_write=None, submission=None):
            waiting.set()
            await writer.write(
                {"method": method, "params": params},
                generation=generation,
                before_write=before_write,
                on_write_attempt=submission.attempt if submission is not None else None,
            )
            turn.turn_done.set_result({"id": "vendor-turn", "status": "completed"})
            return {"turn": {"id": "vendor-turn"}}

        turn = CodexTurnRuntime(
            ThreadAttachment(
                thread_id="native-session",
                request=CodexSessionOpenRequest(request_id="fixture", runtime_id="codex", cwd=ROOT),
                listener=session._on_native_event,
                model="model",
                writable_roots=(),
                attached_generation=host.process_generation,
            ),
            request=request,
            ensure_attached=AsyncMock(return_value=host.process_generation),
            stale_requests=AsyncMock(),
            emitter=CodexEmitter(),
            router=Mock(spec=ThreadRouter),
            watcher=WorkspaceWatch(AsyncMock(return_value={}), Mock()),
            diagnostic=Mock(),
            protocol_error=Mock(),
        )
        fence = TurnAdmission(
            f"{session._event_namespace}:{host.process_generation}",
            session._current_activity_revision(),
            session._watermark,
            authorized,
        )
        await writer._lock.acquire()
        with (
            patch.object(session._native, "run", new=turn.start),
            patch.object(turn._watcher, "begin_turn", new=AsyncMock()),
            patch.object(session, "_finish_turn_task", new=finish_task),
        ):
            await session.submit(TurnRequest("automatic", ("continue",), admission=fence))
            task = next(iter(session._tasks))
            signal = asyncio.create_task(waiting.wait())
            await asyncio.wait((task, signal), timeout=1, return_when=asyncio.FIRST_COMPLETED)
            if task.done():
                task.result()
            assert waiting.is_set()
            await signal
            if change == "generation":
                host._generation += 1
            elif change == "revision":
                session._activity_revision += 1
            elif change == "watermark":
                session._watermark += 1
            elif change == "product":
                allowed = False
            elif change == "authority_error":
                allowed = OSError("authority journal unavailable")
            elif change == "configuration":
                host.admission.freeze(1)
                host.admission.applied(1)
            writer._lock.release()
            results = await asyncio.gather(task, return_exceptions=True)
            if change:
                assert isinstance(results[0], AppServerError), results
                assert results[0].safe_error == TURN_ADMISSION_STALE
                assert results[0].submission_not_applied
                stream.write.assert_not_called()
            else:
                stream.write.assert_called_once()
            await asyncio.wait_for(settled.wait(), timeout=1)
            if change:
                assert turn.turn_done is None
                assert turn.active_turn_client_id == ""
                assert session._active_command_id == ""
                turn._ensure_attached.return_value = host.process_generation
                turn._thread.attached_generation = host.process_generation
                writer.attach(stream, host.process_generation)
                settled.clear()
                await session.submit(TurnRequest("explicit-next-turn", ("continue",)))
                await asyncio.gather(*tuple(session._tasks))
                await asyncio.wait_for(settled.wait(), timeout=1)
                stream.write.assert_called_once()
        await session._events.close()

    for change in (
        "",
        "generation",
        "revision",
        "watermark",
        "product",
        "configuration",
        "authority_error",
    ):
        asyncio.run(scenario(change))
    check("turn admission is fenced at the actual native write", True)


if __name__ == "__main__":
    raise SystemExit(main())
