"""Deterministic contract checks for the Codex Runtime Gateway adapter."""

from __future__ import annotations

import ast
import asyncio
import json
import sys
import tempfile
from dataclasses import replace
from pathlib import Path
from time import time
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

from packaging.specifiers import SpecifierSet

import scholarseed_codex.catalog as catalog_module
import scholarseed_codex.environment as codex_environment
import scholarseed_codex.executable as codex_host
import scholarseed_codex.isolation as codex_isolation
import scholarseed_codex.pool as pool_module
from scholarseed_codex.activity import (
    CODEX_NATIVE_ACTIVITY_TEXT_LIMIT,
    NATIVE_BACKGROUND_TERMINALS_LIST_METHOD,
    NATIVE_BACKGROUND_TERMINALS_TERMINATE_METHOD,
    subagent_item_summary,
    subagent_lifecycle_payload,
    subagent_status_payload,
    tool_item_payload,
    tool_item_result,
)
from scholarseed_codex.capacity import CapacityPolicy, HostRole
from scholarseed_codex.catalog import bind_native_models, model_catalog_argument, standard_model
from scholarseed_codex.emitter import CodexEmitter
from scholarseed_codex.events import translate_event
from scholarseed_codex.failure import (
    CONTENT_SAFETY_BLOCKED,
    PROVIDER_AUTH_MESSAGE,
    PROVIDER_UNAVAILABLE_MESSAGE,
    provider_failure,
)
from scholarseed_codex.input import start_parameters
from scholarseed_codex.pool import CodexHostPool
from scholarseed_codex.process import (
    THREAD_CONFIGURATION_MISMATCH,
    CodexProcessHost,
    _confirmed_thread_model,
)
from scholarseed_codex.profile import CODEX_ALLOW_DEVELOPMENT_VERSION_ENV, CODEX_MAX_TESTED_VERSION
from scholarseed_codex.protocol.control import CodexControlRequest
from scholarseed_codex.protocol.mcp import McpControlCapabilities, McpSnapshot, McpToolCallResult
from scholarseed_codex.protocol.session import (
    CODEX_DEFAULT_TURN_TIMEOUT_SECONDS,
    CodexRuntimeIdentity,
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
from scholarseed_codex.session import CodexRuntimeSession, _same_process_configuration
from scholarseed_codex.skill import session_skill_config, session_skill_inventory
from scholarseed_codex.thread import CodexThreadSession
from scholarseed_codex.turn import CodexTurnRuntime
from scholarseed_runtime.contract import (
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
    TurnRequest,
)
from scholarseed_runtime.contract.command import SkillConfiguration
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
from scholarseed_runtime.contract.history import MessagePhase
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.input import CollaborationMode, InputItem, InputKind, TurnInput
from scholarseed_runtime.contract.inventory import (
    ModelInventory,
    SkillAvailability,
    SkillInventory,
    SkillView,
)
from scholarseed_runtime.contract.resource import ResourcePurpose, ResourceRequest, ResourceState
from tests.contract_codex_capacity import ControlledHost

PASS = 0
FAIL = 0
ROOT = Path(__file__).resolve().parents[1]
ADAPTER_ROOT = ROOT / "packages" / "adapters" / "codex" / "scholarseed_codex"
TEST_POOL_CAPACITY = 2
TEST_WAIT_SECONDS = 5.0
EXPECTED_TURN_TIMEOUT_SECONDS = 3 * 60 * 60


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
    "scholarseed_codex.session.model_catalog_argument",
    new_callable=AsyncMock,
    return_value=CodexRuntimeLaunchArgument(option="-c", value='model_catalog_json="fixture"'),
)
def test_plan_projection(_catalog: AsyncMock) -> None:
    print("== Codex plan configuration and events ==")

    async def native_config() -> dict:
        session = CodexRuntimeSession(
            OpenSessionRequest(product_session_id="native-plan-session", cwd=ROOT)
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
    session = CodexRuntimeSession(OpenSessionRequest(product_session_id="timeout", cwd=ROOT))
    check(
        "adapter default is three hours",
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
        and allowed.authenticated is True,
    )


def test_version_compatibility() -> None:
    print("== shared version compatibility policy ==")
    advertised = SpecifierSet(provider().descriptor.runtime_version_range)

    async def scenario() -> None:
        for version, ready, warning in (
            ("0.146.9", False, False),
            ("0.147.0", True, False),
            ("0.153.4", True, True),
            ("unparseable", False, False),
        ):
            for native in (False, True):
                calls: list[tuple[str, ...]] = []

                async def preflight(_executable: str, *args: str, **kwargs) -> tuple[int, str]:
                    calls.append(args)
                    return 0, (
                        f"codex-cli {version}\r\n"
                        if args == ("--version",)
                        else "Logged in using ChatGPT\r\n"
                    )

                with (
                    patch.object(codex_host, "discover_codex_executable", return_value="codex"),
                    patch.object(codex_host, "_preflight_command", side_effect=preflight),
                ):
                    result = await codex_host._probe_codex_cli_readiness(
                        "codex", authentication_required=native
                    )
                check(f"{version} native={native}: readiness", result.ready is ready)
                if not ready:
                    check(
                        f"{version} native={native}: rejection reason",
                        result.status is CodexRuntimeStatus.INCOMPATIBLE
                        and result.safe_error
                        == (
                            codex_host.CODEX_VERSION_UNPARSEABLE_ERROR
                            if version == "unparseable"
                            else codex_host.CODEX_VERSION_INCOMPATIBLE_ERROR
                        ),
                    )
                check(
                    f"{version} native={native}: warning",
                    result.warning
                    == (codex_host.CODEX_UNTESTED_VERSION_WARNING if warning else ""),
                )
                check(
                    f"{version} native={native}: auth admission",
                    calls
                    == (
                        [("--version",), ("login", "status")]
                        if native and ready
                        else [("--version",)]
                    ),
                )
                if version != "unparseable":
                    check(
                        f"{version}: descriptor matches preflight", (version in advertised) is ready
                    )

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
    print("== remote model authentication independence ==")
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        native_home = root / "runtime"
        native_home.mkdir()
        (native_home / "auth.json").write_text('{"token":"old-native-token"}')
        (native_home / "config.toml").write_text('model_provider="personal"')
        with (
            patch.dict(codex_environment.os.environ, {"SCHOLARSEED_CODEX_HOME": str(native_home)}),
            patch.object(
                codex_environment, "_source_home", side_effect=AssertionError("personal home read")
            ),
            patch(
                "scholarseed_codex.session.source_model_provider",
                side_effect=AssertionError("personal config read"),
            ),
        ):
            session = CodexRuntimeSession(
                OpenSessionRequest(
                    product_session_id="remote-session",
                    cwd=root,
                    model=ModelIntent(
                        model_ref="model",
                        capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                        transport=ModelTransport(
                            mode=ModelConnectionMode.REMOTE,
                            endpoint="http://127.0.0.1:8770/v1",
                        ),
                    ),
                )
            )
            asyncio.run(session._apply_model_connection())
            remote_home = Path(session._native.request.process_environment["CODEX_HOME"])
        check(
            "remote runtime retains existing thread storage without importing personal auth",
            remote_home == native_home.resolve()
            and remote_home.is_dir()
            and (remote_home / "auth.json").read_text() == '{"token":"old-native-token"}',
        )
        check(
            "remote runtime disables native authentication",
            session._native.request.authentication_required is False,
        )

    commands = []
    expected_environment = {"CODEX_HOME": "/isolated/remote"}

    async def preflight(_executable, *args, process_environment=None):
        commands.append(args)
        if args != ("--version",):
            raise AssertionError("remote probe invoked login")
        if process_environment != expected_environment:
            raise AssertionError("remote probe inherited personal runtime environment")
        return 0, "codex-cli " + ".".join(map(str, CODEX_MAX_TESTED_VERSION))

    async def scenario():
        with (
            patch.object(codex_host, "discover_codex_executable", return_value="/runtime/codex"),
            patch.object(codex_host, "_preflight_command", side_effect=preflight),
        ):
            ready = await codex_host._probe_codex_cli_readiness(
                authentication_required=False,
                process_environment=expected_environment,
            )
        with (
            patch.object(codex_host, "discover_codex_executable", return_value="/runtime/codex"),
            patch.object(
                codex_host, "_preflight_command", side_effect=codex_host.CodexPreflightTimeout()
            ),
        ):
            unknown = await codex_host._probe_codex_cli_readiness(authentication_required=False)
        return ready, unknown

    ready, unknown = asyncio.run(scenario())
    check(
        "remote preflight requires only executable compatibility",
        ready.ready and ready.authenticated is None and commands == [("--version",)],
    )
    check(
        "unknown executable version never passes remote preflight",
        not unknown.ready and unknown.safe_error == codex_host.CODEX_PREFLIGHT_TIMEOUT_ERROR,
    )

    async def acquire_scenario():
        created = []

        class Host:
            def __init__(self, **kwargs):
                created.append(kwargs)
                self.readiness = SimpleNamespace(process_generation=1)

            async def start(self):
                pass

            async def aclose(self):
                pass

        readiness = CodexRuntimeReadiness(
            runtime_id="codex",
            status=CodexRuntimeStatus.READY,
            ready=True,
            executable="/runtime/codex",
            version="codex-cli 0.147.0",
        )
        pool = CodexHostPool()
        with (
            patch(
                "scholarseed_codex.pool._probe_codex_cli_readiness", return_value=readiness
            ) as probe,
            patch("scholarseed_codex.pool.CodexProcessHost", Host),
        ):
            for native in (False, True):
                await pool.acquire(
                    CodexSessionOpenRequest(
                        request_id=f"auth-{native}",
                        runtime_id="codex",
                        executable="/runtime/codex",
                        identity=CodexRuntimeIdentity(),
                        cwd=ROOT,
                        process_environment=expected_environment,
                        launch_arguments=(),
                        authentication_required=native,
                        remove_environment=(),
                    )
                )
            await pool.aclose()
        return created, probe.await_args_list

    created, probes = asyncio.run(acquire_scenario())
    check(
        "remote process uses ephemeral auth without moving thread storage",
        len(created) == 2
        and created[0]["process_environment"] == expected_environment
        and [(arg.option, arg.value) for arg in created[0]["launch_arguments"]]
        == [
            (
                codex_environment.CODEX_REMOTE_CONFIG_OPTION,
                codex_environment.CODEX_REMOTE_AUTH_CONFIG,
            )
        ]
        and created[1]["launch_arguments"] == (),
    )
    check(
        "process pool probes authentication only for native callers",
        [call.kwargs["authentication_required"] for call in probes] == [False, True],
    )


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
    )
    entry = ModelCatalogEntry(intent.model_ref, intent.capabilities, intent.context_window)
    standard = standard_model(entry, "product instructions")
    review_entry = ModelCatalogEntry("review-model", intent.capabilities)
    reviewed = standard_model(entry, "product instructions", review_entry.model_ref)
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
            request,
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
                catalog_models=(entry, review_entry),
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
            "same connection catalog is stable across selected models and reasoning levels",
            first_argument == second_argument,
        )
        catalog_path = Path(json.loads(first_argument.split("=", 1)[1]))
        check(
            "shared launch catalog contains both model definitions",
            {row["slug"] for row in json.loads(catalog_path.read_text())["models"]}
            == {"native", "other"},
        )
    with tempfile.TemporaryDirectory() as directory:
        home = Path(directory)
        payload = json.dumps(standard).encode()
        first = codex_environment.store_model_catalog(home, payload)
        repeated = codex_environment.store_model_catalog(home, payload)
        changed = codex_environment.store_model_catalog(
            home,
            json.dumps(
                standard_model(replace(entry, model_ref="other"), "product instructions")
            ).encode(),
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
            patch.object(catalog_module.asyncio, "create_subprocess_exec", side_effect=spawn),
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
    "scholarseed_codex.session.model_catalog_argument",
    new_callable=AsyncMock,
    return_value=CodexRuntimeLaunchArgument(option="-c", value='model_catalog_json="fixture"'),
)
def test_session_scoped_web_search_projection(_catalog: AsyncMock) -> None:
    print("== session-scoped Web Search ==")

    async def scenario() -> tuple[object, object]:
        regular = CodexRuntimeSession(
            OpenSessionRequest(product_session_id="regular-session", cwd=ROOT)
        )
        search = CodexRuntimeSession(
            OpenSessionRequest(
                product_session_id="search-session",
                cwd=ROOT,
                required_capabilities=(RuntimeCapabilityName.WEB_SEARCH,),
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


def test_environment_removal() -> None:
    async def scenario() -> None:
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
                    ("PARENT_SECRET",),
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
            patch.object(pool_module, "_probe_codex_cli_readiness", AsyncMock(return_value=ready)),
            patch.object(CodexProcessHost, "start", AsyncMock()),
            patch.object(CodexProcessHost, "aclose", AsyncMock()),
        ):
            first = await pool.acquire(
                CodexSessionOpenRequest(request_id="a", runtime_id="codex", cwd=ROOT)
            )
            second = await pool.acquire(
                CodexSessionOpenRequest(
                    request_id="b",
                    runtime_id="codex",
                    cwd=ROOT,
                    remove_environment=("PARENT_SECRET",),
                )
            )
            check("pool identity separates removal policies", first.host is not second.host)
            third_request = CodexSessionOpenRequest(
                request_id="c",
                runtime_id="codex",
                cwd=ROOT,
                remove_environment=("ANOTHER_PARENT_SECRET",),
            )
            reused = await pool.consume(
                await pool.reserve(
                    CodexSessionOpenRequest(request_id="a", runtime_id="codex", cwd=ROOT),
                    role=HostRole.EXECUTION,
                    request_id="reuse",
                    deadline=time() + TEST_WAIT_SECONDS,
                )
            )
            check(
                "full pool shares a host through distinct owned leases",
                reused.host is first.host and reused.lease_id != first.lease_id,
            )
            waiting = await pool.reserve(
                third_request,
                role=HostRole.EXECUTION,
                request_id=third_request.request_id,
                deadline=time() + TEST_WAIT_SECONDS,
            )
            check(
                "full pool retains the next identity as a bounded resource wait",
                waiting.state is ResourceState.WAITING,
            )
            await second.close()
            admitted = await asyncio.wait_for(pool.consume(waiting), TEST_WAIT_SECONDS)
            check(
                "released capacity grants the waiting identity without leaking a slot",
                admitted.host is not first.host and admitted.request_id == third_request.request_id,
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
            and "features.skip_host_skill_discovery=true" in resolved,
            str(resolved),
        )
        check(
            "spawned shells retain the original cross-platform home values",
            'shell_environment_policy.set.HOME="/Users/research user"' in resolved
            and 'shell_environment_policy.set.USERPROFILE="C:\\\\Users\\\\research user"'
            in resolved,
            str(resolved),
        )


def test_control_hosts_stay_resident() -> None:
    print("== control hosts stay warm within the separate control budget ==")
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
            request = CodexControlRequest(
                request_id="control-first",
                runtime_id="codex",
                cwd=ROOT,
                executable="/runtime/codex",
                authentication_required=False,
            )
            first = await pool.acquire_control(request)
            await first.close()
            check(
                "control release preserves an idle host within its own budget",
                not first.host.closed and pool.snapshot()[1].used == 1,
            )
            second = await pool.acquire_control(replace(request, request_id="control-next"))
            check(
                "compatible control inspection reuses its warm host with a new lease",
                second.host is first.host and second.lease_id != first.lease_id,
            )
            await second.close()
            execution = await pool.acquire(
                CodexSessionOpenRequest(
                    request_id="execution",
                    runtime_id="codex",
                    cwd=ROOT,
                    executable="/runtime/codex",
                    authentication_required=False,
                )
            )
            check(
                "execution never borrows the resident control host",
                execution.host is not first.host
                and [row.used for row in pool.snapshot()] == [1, 1],
            )
            await execution.close()
            check(
                "execution releases its writer while control remains warm",
                execution.host.closed and not first.host.closed,
            )
            replacement = await pool.acquire_control(
                replace(
                    request,
                    request_id="control-replacement",
                    process_environment={"CODEX_HOME": "/isolated/other"},
                )
            )
            check(
                "control pressure waits for the idle host to exit before replacement",
                first.host.closed
                and first.host.safe_close_calls == 1
                and replacement.host is not first.host
                and pool.snapshot()[1].used == 1,
            )
            await replacement.close()
            await pool.aclose()
            check(
                "pool shutdown closes its remaining warm control host",
                replacement.host.closed and all(row.used == 0 for row in pool.snapshot()),
            )

    asyncio.run(scenario())


@patch(
    "scholarseed_codex.session.model_catalog_argument",
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
    )
    session = CodexRuntimeSession(request)
    check(
        "open projects product-selected skill roots", session._native.request.skill_roots == roots
    )
    check(
        "neutral callers do not acquire product-specific defaults",
        OpenSessionRequest(product_session_id="neutral", cwd=ROOT).skill_roots == (),
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
            patch("scholarseed_codex.session.prepare_codex_runtime_home", return_value=ROOT),
            patch("scholarseed_codex.session.source_model_provider", return_value=("", {})),
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
            )
        )
        with patch("scholarseed_codex.session.source_model_provider", return_value=("", {})):
            configured = await session._configure_model_connection(
                session._request.model, session._native.request, session._request.credential_port
            )
        return dict(configured.thread_config)

    config = asyncio.run(configure())
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
        )
    )
    check(
        "scoped domains create a native profile without local sockets",
        scoped._native.request.permissions_profile == "local-services"
        and scoped._native.request.network_access is False
        and any(
            '"scholarseed.damo.alibaba.com" = "allow"' in argument.value
            for argument in scoped._native.request.launch_arguments
        ),
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
                model=ModelIntent(model_ref="model-a", revision="model:a"),
            )
        )
        compatible = await session.reconfigure(
            RuntimeConfigurationIntent(
                revision="model:b",
                model=ModelIntent(model_ref="model-b", revision="model:b"),
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
            force_reload: bool,
        ) -> SkillInventory:
            del force_reload
            return SkillInventory(cwd=cwd, revision="skills-revision")

    class Mcp:
        async def snapshot(self) -> McpSnapshot:
            return McpSnapshot("codex", "native-session", "mcp-revision")

    async def scenario() -> object:
        session = CodexRuntimeSession(
            OpenSessionRequest(product_session_id="product-session", cwd=ROOT)
        )
        session._request = SimpleNamespace(cwd=ROOT)
        session._native = SimpleNamespace(
            model_control=Models(),
            skill_control=Skills(),
            mcp_control=Mcp(),
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
            OpenSessionRequest(product_session_id="product-session", cwd=ROOT)
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
            OpenSessionRequest(product_session_id="product-session", cwd=ROOT)
        )
        session._request = OpenSessionRequest(product_session_id="product-session", cwd=Path.cwd())
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
                model=ModelIntent(reasoning_effort="high"),
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
        await runtime.notification(
            "item/started",
            {"turnId": "turn-2", "itemId": "message-2", "item": phased_item},
            generation=1,
        )
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
        "nullable-phase text deltas stream before completion",
        [event.payload.get("text") for event in deltas] == ["hel", "lo", "late"],
    )
    check(
        "late phase metadata does not duplicate already streamed text",
        len(deltas) == 3,
    )
    check(
        "terminal order resolves the nullable phase as final answer",
        len(completed) == 2
        and completed[0].payload.get("text") == "hello"
        and completed[0].payload.get("phase") == MessagePhase.FINAL_ANSWER.value,
    )


def test_capability_resolution_is_synthesised_once_per_pair() -> None:
    print("== declared vs effective context window ==")

    async def scenario() -> list[RuntimeEvent]:
        session = CodexRuntimeSession(
            OpenSessionRequest(product_session_id="product-session", cwd=ROOT)
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
            OpenSessionRequest(product_session_id="product-session", cwd=ROOT)
        )
        session._request = OpenSessionRequest(product_session_id="product-session", cwd=Path.cwd())
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
            OpenSessionRequest(product_session_id="product-session", cwd=ROOT)
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
    )
    restored = provider()._open_request(request)
    assert restored.service_tools == (bridge_tool,)


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
            OpenSessionRequest(product_session_id="product-session", cwd=ROOT)
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
            OpenSessionRequest(product_session_id="product-session", cwd=ROOT)
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


def test_evidence_cursor() -> None:
    """Evidence is incremental across native notifications and process restarts."""

    async def scenario() -> list[RuntimeEvent]:
        session = CodexRuntimeSession(
            OpenSessionRequest(product_session_id="product-session", cwd=ROOT)
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

    class Control:
        def __init__(self, request, *, host_pool):
            captured.append(request)
            self.host_pool = host_pool

        async def open(self):
            return None

        async def aclose(self):
            return None

    async def scenario():
        with (
            patch("scholarseed_codex.provider.CodexRuntimeControl", Control),
            patch("scholarseed_codex.provider.prepare_codex_runtime_home", return_value=ROOT),
            patch(
                "scholarseed_codex.provider.configured_codex_executable",
                return_value="/official/codex",
            ),
        ):
            await provider().inspect(
                RuntimeInspectionRequest(
                    cwd=ROOT,
                    inventory=InventoryRequest(()),
                )
            )

    asyncio.run(scenario())
    request = captured[0]
    resolved = codex_host._resolve_launch_arguments(
        request.launch_arguments,
        request.process_environment,
    )
    check(
        "upstream inspection uses the managed discovery boundary",
        request.process_environment["CODEX_HOME"] == str(ROOT)
        and request.process_environment["HOME"]
        == str(ROOT / codex_isolation.CODEX_DISCOVERY_HOME_DIRNAME),
    )
    check(
        "upstream inspection disables ambient project configuration",
        request.executable == "/official/codex"
        and "--strict-config" in resolved
        and "project_root_markers=[]" in resolved
        and "project_doc_max_bytes=0" in resolved
        and "mcp_servers={}" in resolved,
    )


def test_skill_inventory_refresh_reasserts_roots() -> None:
    print("== refreshed skill inventory reasserts product roots ==")
    roots = (ROOT / "bundled-skills", ROOT / "user-skills")
    controls = []

    class Skills:
        def __init__(self, events: list[str]) -> None:
            self.events = events

        async def list_skills(
            self,
            *,
            cwd: Path,
            force_reload: bool,
        ) -> SkillInventory:
            self.events.append("list")
            return SkillInventory(
                cwd=cwd,
                revision="refreshed" if force_reload else "cached",
            )

    class Control:
        def __init__(self, _request, *, host_pool):
            self.host_pool = host_pool
            self.events: list[str] = []
            self.host = SimpleNamespace(
                reassert_skill_roots=AsyncMock(
                    side_effect=lambda _roots: self.events.append("roots")
                )
            )
            self.skill_control = Skills(self.events)
            controls.append(self)

        async def open(self):
            return None

        async def aclose(self):
            return None

    async def scenario() -> None:
        with (
            patch("scholarseed_codex.provider.CodexRuntimeControl", Control),
            patch("scholarseed_codex.provider.prepare_codex_runtime_home", return_value=ROOT),
            patch(
                "scholarseed_codex.provider.configured_codex_executable",
                return_value="/official/codex",
            ),
        ):
            runtime = provider()
            await runtime.inspect(
                RuntimeInspectionRequest(
                    cwd=ROOT,
                    inventory=InventoryRequest((InventoryKind.SKILLS,), refresh=False),
                    roots=roots,
                )
            )
            await runtime.inspect(
                RuntimeInspectionRequest(
                    cwd=ROOT,
                    inventory=InventoryRequest((InventoryKind.SKILLS,), refresh=True),
                    roots=roots,
                )
            )

    asyncio.run(scenario())
    check(
        "cached inventory preserves the existing root registration",
        controls[0].host.reassert_skill_roots.await_count == 0,
    )
    check(
        "forced inventory refresh reasserts the complete product root set",
        controls[1].host.reassert_skill_roots.await_args.args == (roots,),
    )
    check(
        "forced inventory refresh reasserts roots before listing skills",
        controls[1].events == ["roots", "list"],
    )


def test_durable_thread_unsubscribes() -> None:
    check(
        "provider configuration participates in process isolation",
        pool_module._environment_digest({"MODEL_PROVIDER": "one"}, (), ())
        != pool_module._environment_digest({"MODEL_PROVIDER": "two"}, (), ()),
    )

    async def run() -> None:
        state = SimpleNamespace(
            request=SimpleNamespace(ephemeral=False),
            turn=SimpleNamespace(close=AsyncMock()),
            permission_confirmation=None,
        )
        host = SimpleNamespace(
            _threads={"durable": state},
            _watcher=SimpleNamespace(close=AsyncMock()),
            _generation=1,
            _registration_epoch=0,
            state=CodexProcessState.READY,
            _router=SimpleNamespace(close=Mock()),
            request=AsyncMock(),
            _recovery_task=None,
        )
        await CodexProcessHost.close_thread(host, "durable")
        check(
            "durable close releases the event subscription",
            host.request.call_args.args == ("thread/unsubscribe", {"threadId": "durable"}),
        )
        check("durable close removes local attachment", not host._threads)

    asyncio.run(run())


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


def main() -> int:
    test_catalog_process_cleanup()
    test_approval_catalog_binding()
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
    test_opaque_launch_secret_projection()
    test_environment_removal()
    test_managed_codex_isolation()
    test_control_hosts_stay_resident()
    test_session_skill_root_projection()
    test_session_skill_configuration()
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
    test_thread_model_configuration_is_confirmed()
    test_same_process_reopen_restores_previous_configuration_on_failure()
    test_started_native_turn_owns_terminal_outcome()
    test_unknown_native_turn_owns_terminal_outcome()
    test_evidence_cursor()
    test_upstream_inspection_launch()
    test_skill_inventory_refresh_reasserts_roots()
    test_codex_flattened_stream_disconnect_recovers_transient_semantics()
    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
