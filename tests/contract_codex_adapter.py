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
from unittest.mock import AsyncMock, Mock, patch

from packaging.specifiers import SpecifierSet

import scholarseed_codex.catalog as catalog_module
import scholarseed_codex.environment as codex_environment
import scholarseed_codex.executable as codex_host
import scholarseed_codex.isolation as codex_isolation
import scholarseed_codex.pool as pool_module
from scholarseed_codex.activity import subagent_lifecycle_payload
from scholarseed_codex.capacity import CapacityPolicy, HostRole
from scholarseed_codex.catalog import bind_native_model, standard_model
from scholarseed_codex.events import translate_event
from scholarseed_codex.failure import PROVIDER_AUTH_MESSAGE, provider_failure
from scholarseed_codex.pool import CodexHostPool
from scholarseed_codex.process import CodexProcessHost
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
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_codex.skill import session_skill_config, session_skill_inventory
from scholarseed_codex.thread import CodexThreadSession
from scholarseed_runtime.contract import (
    ActorKind,
    CallbackKind,
    CapabilityState,
    CommandState,
    DeliveryClass,
    InventoryKind,
    InventoryRequest,
    LaunchSecret,
    LaunchSecretIntent,
    ModelCapabilities,
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
    TurnRequest,
)
from scholarseed_runtime.contract.command import SkillConfiguration
from scholarseed_runtime.contract.evidence import (
    RuntimeProcessEvent,
    RuntimeProcessEventKind,
    RuntimeRpcEvidence,
)
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.input import CollaborationMode
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
    bound = bind_native_model(native, "vendor/native-dated")
    selected = bound["models"][-1]
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
    defaults = bind_native_model(native, "")
    check(
        "implicit native defaults retain Codex selection with self-bound reviewers",
        defaults["models"][0]["auto_review_model_override"] == "native",
    )
    try:
        bind_native_model(native, "missing-model")
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
    standard = standard_model(intent, "product instructions")
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
    with tempfile.TemporaryDirectory() as directory:
        home = Path(directory)
        payload = json.dumps(standard).encode()
        first = codex_environment.store_model_catalog(home, payload)
        repeated = codex_environment.store_model_catalog(home, payload)
        changed = codex_environment.store_model_catalog(
            home,
            json.dumps(
                standard_model(replace(intent, model_ref="other"), "product instructions")
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

    async def scenario() -> tuple[dict[str, str], str, str, list[str]]:
        request = OpenSessionRequest(
            product_session_id="launch-secret-session",
            cwd=ROOT,
            launch_secrets=LaunchSecretIntent(
                bindings=(LaunchSecret("SCHOLARSEED_API_KEY", "opaque-skill-ref"),),
                revision="launch-secrets:test",
                remove_environment=("PARENT_SECRET",),
            ),
            secret_port=Secrets(),
        )
        environment = await _resolve_launch_secrets(request)
        session = CodexRuntimeSession(request, launch_environment=environment)
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
            repr(request),
            repr(session._request),
            failures,
        )

    environment, request_repr, retained_repr, failures = asyncio.run(scenario())
    check(
        "adapter injects resolved product secret into the official Harness environment",
        environment.get("SCHOLARSEED_API_KEY") == "skill-secret-value",
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
            {"MODEL_KEY": "model-fixture"},
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
            await session._configure_model_connection()
        return dict(session._native.request.thread_config)

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
    check(
        "session configuration separates native pool identities",
        pool_module._environment_digest({}, (), (), session_skill_config(configurations))
        != pool_module._environment_digest({}, (), (), {}),
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
        "adapter requests restart when the approval reviewer changes",
        auto_review.state is CommandState.RESTART_REQUIRED,
    )
    check(
        "adapter requests restart when the sandbox policy changes",
        full_access.state is CommandState.RESTART_REQUIRED,
    )
    check(
        "adapter applies changed writable roots to subsequent native turns",
        writable_roots == (ROOT,),
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


def test_unsupported_dynamic_tool_fails_fast() -> None:
    print("== unsupported dynamic tool boundary ==")

    async def scenario() -> tuple[list[tuple[str, object]], RuntimeEvent]:
        responses: list[tuple[str, object]] = []

        async def resolve_tool(request_id: str, response: object) -> bool:
            responses.append((request_id, response))
            return True

        session = CodexRuntimeSession(
            OpenSessionRequest(product_session_id="product-session", cwd=ROOT)
        )
        session._request = SimpleNamespace(product_session_id="product-session")
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
        return responses, await session._events.get()

    responses, event = asyncio.run(scenario())
    check(
        "undeclared dynamic tool receives an immediate negative response",
        len(responses) == 1
        and responses[0][0] == "tool-request"
        and getattr(responses[0][1], "success", True) is False,
    )
    check(
        "unsupported vendor capability remains observable as an extension",
        event.kind is RuntimeEventKind.RUNTIME_EXTENSION
        and isinstance(event.payload, dict)
        and event.payload.get("extension_kind") == "dynamic_tool_requested",
    )


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


def test_durable_thread_unsubscribes() -> None:
    check(
        "provider configuration participates in process isolation",
        pool_module._environment_digest(
            {}, (), (), {"model_providers": {"remote": {"base_url": "https://one.example"}}}
        )
        != pool_module._environment_digest(
            {}, (), (), {"model_providers": {"remote": {"base_url": "https://two.example"}}}
        ),
    )

    async def run() -> None:
        state = SimpleNamespace(
            request=SimpleNamespace(ephemeral=False),
            turn=SimpleNamespace(close=AsyncMock()),
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
    test_capability_resolution_is_synthesised_once_per_pair()
    test_subagent_lifecycle_survives_out_of_order_observation()
    test_unsupported_dynamic_tool_fails_fast()
    test_started_native_turn_owns_terminal_outcome()
    test_evidence_cursor()
    test_upstream_inspection_launch()
    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
