"""Chat product composition for the native Codex runtime."""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import Any, Mapping

from fastapi import Depends, FastAPI

from service.capabilities.api.routes import register_capability_routes
from service.capabilities.service.components import ComponentRegistry
from service.capabilities.service.install import recover_plugin_installation
from service.capabilities.service.skills import SkillCatalog, restore_skill_state
from service.chat.api.attention import mount_attention_routes
from service.chat.api.connectors import mount_connector_routes
from service.chat.api.diagnostics import mount_diagnostic_routes
from service.chat.api.feedback import mount_feedback_routes
from service.chat.api.mcp import mount_mcp_routes
from service.chat.api.notifications import mount_notification_routes
from service.chat.api.sessions import mount_session_routes
from service.chat.api.settings import mount_setting_routes
from service.chat.api.skills import mount_skill_routes
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.attention import AttentionStore
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventStore
from service.chat.persistence.notifications import observe_chat
from service.chat.persistence.projects import ProjectRegistry
from service.chat.runtime.composition import LiveSessionService
from service.chat.runtime.live import LiveSession
from service.chat.runtime.projection import (
    readiness_payload,
    runtime_capabilities_payload,
    runtime_payload,
)
from service.chat.runtime.selection import RuntimeDiscovery
from service.chat.service.adapters import product_features
from service.chat.service.artifacts import ArtifactService
from service.chat.service.attention import AttentionService
from service.chat.service.completions import (
    CompletionBridge,
    mount_completion_bridge,
)
from service.chat.service.diagnostics import DiagnosticService
from service.chat.service.events import EventService
from service.chat.service.feedback import FeedbackService
from service.chat.service.models import ModelService
from service.chat.service.projects import ProjectWorkspacePolicy
from service.chat.service.recovery import READ_ONLY_WEB_SEARCH
from service.chat.service.sessions import SessionService, workspace_allows
from service.chat.service.settings import SettingsService
from service.chat.service.skills import SkillService
from service.chat.service.subscriptions import SubscriptionService
from service.chat.service.turns import TurnService
from service.chat.service.workspaces import SessionWorkspaceService
from service.identity.service.account import ACCOUNT_BASE_URL_ENV
from service.identity.service.account_token import AccountTokenHolder
from service.identity.service.skill_credentials import skill_credentials_from_env
from service.identity.utils import (
    OWNERSHIP_AXIS_ENV,
    OWNERSHIP_AXIS_MACHINE,
    OWNERSHIP_AXIS_STATE,
    resolve_ownership_axis,
)
from service.inference.source import ContentSource
from service.paths import (
    SERVICE_BUNDLED_SKILLS_DIR,
    SERVICE_COMPONENTS_DATABASE,
    SERVICE_SKILLS_DIR,
    storage_instance_id,
)
from service.platform.activity import Activities, ActivityDomain, ActivityLease
from service.platform.http_activity import ServeApplication, execution_admission
from service.platform.lifecycle import ServiceLifecycle
from service.platform.notifications import ChangeHub
from service.platform.shutdown import Shutdown, ShutdownStage
from service.platform.startup import startup_phase
from service.platform.toolchain import ToolchainState
from service.platform.vocabulary import INTERNAL_BASE_URL_ENV
from service.platform.workbench import DocumentFormatPort
from service.resources.service.batch import ResourceReviewBatchService
from service.resources.service.delivery import ResourceDeliveryService
from service.settings.catalog import DEEPRD_GATEWAY_BASE_URL, DEEPRD_GATEWAY_RESPONSES_URL
from service.settings.connections import ModelProfileStore
from service.settings.connectors.broker import ConnectorBroker
from service.settings.connectors.hosted import HostedOAuth
from service.settings.connectors.service import ConnectorSecrets, ConnectorService
from service.settings.connectors.store import ConnectorStore
from service.settings.credentials import ModelCredentialStore
from service.settings.mcp import McpConfigurationService, McpConfigurationStore
from service.settings.oauth import CHATGPT_PROVIDER
from service.settings.plans import McpPlanService, McpPlanStore

_log = logging.getLogger(__name__)
DEFAULT_PRODUCT = "all"
DEFAULT_STORAGE_PROFILE = "scholarseed"
BACKEND_HEALTH_ROUTE = "/api/healthz/backend"
NEW_STACK_ID = "codex-appserver"


def create_chat_app(
    cwd: Path,
    *,
    settings: SettingsService,
    lifecycles: tuple[ServiceLifecycle, ...] = (),
    recovery_at: float | None = None,
    prepare: Callable[[], Awaitable[None]] | None = None,
    resource_deliveries: ResourceDeliveryService | None = None,
    resource_review_batches: ResourceReviewBatchService | None = None,
    ownership_axis: str | None = None,
    formats: DocumentFormatPort,
    activities: Activities | None = None,
    notifications: ChangeHub | None = None,
    runtime_discovery: RuntimeDiscovery | None = None,
) -> FastAPI:
    """Create the Service-owned product shell around typed Codex sessions."""

    activity_registry = activities if activities is not None else Activities()
    sessions: dict[str, LiveSession] = {}
    skill_service: SkillService | None = None
    feedback_service: FeedbackService | None = None

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        failures: list[BaseException] = []

        async def close(operation: Callable[[], Awaitable[None]]) -> None:
            try:
                with _app.state.shutdown.stage(operation.__qualname__):
                    await operation()
            except BaseException as error:
                # A failed/cancelled close is not a drain receipt. Keep cleaning
                # other owners, but never turn this lifespan into success.
                failures.append(error)

        async def close_sessions() -> None:
            current = tuple(sessions.items())
            results = await asyncio.gather(
                *(session.aclose() for _, session in current), return_exceptions=True
            )
            for (session_id, session), result in zip(current, results, strict=True):
                if isinstance(result, BaseException):
                    failures.append(result)
                elif sessions.get(session_id) is session:
                    sessions.pop(session_id)

        async with AsyncExitStack() as services:
            maintenance: asyncio.Task[None] | None = None
            deferred_mcp: asyncio.Task[None] | None = None
            try:
                if prepare is not None:
                    with startup_phase("lifecycle.content_recovery"):
                        await prepare()
                with startup_phase("lifecycle.access_recovery"):
                    access_store.recover_inflight(now=recovery_at)
                with startup_phase("lifecycle.runtime"):
                    await connector_broker.start()
                    if (
                        activity_registry.workbench_ready
                        and runtime_service.toolchain.state is ToolchainState.READY
                    ):
                        await mcp_service.start()
                    else:

                        async def start_mcp_after_admission() -> None:
                            await runtime_service.toolchain.wait()
                            await activity_registry.wait_open()
                            await mcp_service.start()

                        deferred_mcp = asyncio.create_task(
                            start_mcp_after_admission(), name="mcp-reconcile-admission"
                        )

                        def report_mcp_failure(task: asyncio.Task[None]) -> None:
                            if not task.cancelled() and (error := task.exception()) is not None:
                                _log.error("Deferred MCP startup failed", exc_info=error)

                        deferred_mcp.add_done_callback(report_mcp_failure)
                    await runtime_service.start()
                maintenance = asyncio.create_task(
                    diagnostics.maintain(
                        lambda: {
                            session_id
                            for session_id, session in sessions.items()
                            if session.running
                        }
                    )
                )
                for service in lifecycles:
                    services.push_async_callback(close, service.aclose)
                    with startup_phase(f"lifecycle.{type(service).__name__}"):
                        await service.start()
                yield
            except BaseException as error:
                failures.append(error)
            finally:
                if deferred_mcp is not None:

                    async def close_deferred_mcp() -> None:
                        deferred_mcp.cancel()
                        result = (await asyncio.gather(deferred_mcp, return_exceptions=True))[0]
                        if isinstance(result, BaseException) and not isinstance(
                            result, asyncio.CancelledError
                        ):
                            raise result

                    await close(close_deferred_mcp)
                if maintenance is not None:

                    async def close_diagnostics() -> None:
                        maintenance.cancel()
                        result = (await asyncio.gather(maintenance, return_exceptions=True))[0]
                        if isinstance(result, BaseException) and not isinstance(
                            result, asyncio.CancelledError
                        ):
                            raise result

                    await close(close_diagnostics)
                await close(turn_service.aclose)
                await close(runtime_service.aclose)
                await close(connector_broker.aclose)
                await close(close_sessions)
                if skill_service is not None:
                    await close(skill_service.aclose)
                await close(model_service.close)
                await close(subscriptions.close)
                if feedback_service is not None:
                    try:
                        with _app.state.shutdown.stage(ShutdownStage.FEEDBACK):
                            feedback_service.close()
                    except BaseException as error:
                        failures.append(error)
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise BaseExceptionGroup("Serve lifespan failed", failures)

    activities = activity_registry
    service_instance_id = activities.instance_id
    app = ServeApplication(activities=activities, title="scholarseed-serve", lifespan=lifespan)
    app.state.shutdown = Shutdown()
    app.state.product_features = product_features()
    workspace = cwd.expanduser().resolve()

    axis = resolve_ownership_axis(ownership_axis, os.environ.get(OWNERSHIP_AXIS_ENV, ""))
    setattr(app.state, OWNERSHIP_AXIS_STATE, axis)
    # 归属轴有两个必须同时设的开关: 请求侧的身份投影读 app.state 上的轴, 存储侧的谓词退化
    # 读各 store 的 shared_ownership。只设一半就会得到"归属身份是机器级常量、谓词仍按账号
    # 过滤"的空集, 所以这里算一次, 会话目录与个人连接层共用同一个值。
    shared_ownership = axis == OWNERSHIP_AXIS_MACHINE
    access_store = SessionCatalogStore(shared_ownership=shared_ownership)
    event_store = ProductEventStore(access_store.database)
    changes = notifications if notifications is not None else ChangeHub(service_instance_id)
    access_store.observe = lambda connection: observe_chat(
        connection, changes, shared=shared_ownership
    )
    event_store.observe = access_store.observe
    app.state.notifications = changes
    artifact_store = SessionArtifactStore(access_store.database)
    artifact_store.observe = access_store.observe
    artifact_service = ArtifactService(access_store, artifact_store, event_store, formats)
    project_registry = ProjectRegistry()
    settings_service = settings

    def session_turn_id(session_id: str) -> str:
        live = sessions.get(session_id)
        return live.active_product_turn_id if live is not None else ""

    def session_turn_activity(session_id: str) -> ActivityLease | None:
        live = sessions.get(session_id)
        return live.turn_activity if live is not None and live.active_product_turn_id else None

    def observe_model(session_id: str, client_turn_id: str, actual_model: str) -> None:
        live = sessions.get(session_id)
        if live is not None:
            live.observe_model(client_turn_id, actual_model)

    def observe_completion(session_id: str, fields: Mapping[str, Any]) -> None:
        live = sessions.get(session_id)
        if live is not None:
            live.trace_completion(fields)

    async def observe_sources(
        session_id: str, client_turn_id: str, fields: Mapping[str, Any]
    ) -> None:
        live = sessions.get(session_id)
        if live is not None:
            await live.observe_sources(client_turn_id, fields)

    def content_source(session_id: str, client_turn_id: str) -> ContentSource | None:
        live = sessions.get(session_id)
        return live.content_source(client_turn_id) if live is not None else None

    completion_bridge = CompletionBridge(
        os.environ.get(INTERNAL_BASE_URL_ENV, ""),
        on_model=observe_model,
        on_diagnostic=observe_completion,
        on_sources=observe_sources,
        turn_ids=session_turn_id,
        content_source=content_source,
        source_endpoints=(DEEPRD_GATEWAY_BASE_URL,),
        retryable_tool_endpoints={
            DEEPRD_GATEWAY_RESPONSES_URL: frozenset({READ_ONLY_WEB_SEARCH}),
            CHATGPT_PROVIDER.responses_endpoint: frozenset({READ_ONLY_WEB_SEARCH}),
        },
        shared_ownership=shared_ownership,
    )
    # 当前登录用户的 access token 持有者（纯内存）。由鉴权 middleware 写入、bridge 出站时
    # 读取 —— 让网关能把用量归属到人。挂上 app.state 供 bootstrap 将它传给 register_auth。
    account_tokens = AccountTokenHolder()
    app.state.account_tokens = account_tokens
    profiles = ModelProfileStore(shared_ownership=shared_ownership)
    subscriptions = SubscriptionService(
        profiles,
        ModelCredentialStore(shared_ownership=shared_ownership),
        completion_bridge,
        shared_ownership=shared_ownership,
        activities=activities,
        turn_activities=session_turn_activity,
    )
    app.state.subscriptions = subscriptions

    model_service = ModelService(
        settings_service,
        completion_bridge,
        account_tokens,
        profiles,
        subscriptions,
        turn_ids=session_turn_id,
        ownership_axis=axis,
        activities=activities,
    )
    app.state.model_service = model_service
    recover_plugin_installation(SERVICE_SKILLS_DIR, restore_state=restore_skill_state)
    skill_catalog = SkillCatalog(
        bundled_root=SERVICE_BUNDLED_SKILLS_DIR,
        user_root=SERVICE_SKILLS_DIR,
        components=ComponentRegistry(SERVICE_COMPONENTS_DATABASE),
    )
    runtime_service = LiveSessionService(
        activities=activities,
        catalog=access_store,
        events=event_store,
        artifacts=artifact_store,
        skills=skill_catalog,
        models=model_service,
        logger=_log,
        resource_changes=resource_deliveries,
        discovery=runtime_discovery,
    )
    runtime_service.bind_sessions(sessions)
    connector_store = ConnectorStore()
    hosted_oauth = HostedOAuth(os.environ.get(ACCOUNT_BASE_URL_ENV, ""), account_tokens.current)
    connector_secrets = ConnectorSecrets(connector_store, activities, hosted_oauth)
    mcp_store = McpConfigurationStore()
    connector_broker = ConnectorBroker(mcp_store, connector_secrets, activities)
    mcp_service = McpConfigurationService(
        mcp_store,
        runtime_service.mcp_configuration_port,
        activities=activities,
        secret_port=connector_broker,
        validate_servers=connector_secrets.validate_servers,
        project_server=connector_broker.project,
        reconcile_servers=connector_broker.reconcile,
        shared_credentials=(connector_broker.credential,),
    )
    app.state.mcp_service = mcp_service
    plan_store = McpPlanStore()
    plan_service = McpPlanService(plan_store, mcp_service, activities=activities)
    app.state.mcp_plan_service = plan_service
    runtime_id = runtime_service.runtime_id
    skill_service = SkillService(
        runtime_id=runtime_id,
        cwd=workspace,
        runtime=runtime_service,
        settings=settings_service,
        catalog=skill_catalog,
    )
    session_workspaces = SessionWorkspaceService(workspace_allows)
    project_policy = ProjectWorkspacePolicy(workspace)
    session_workspaces.register(
        policy=project_policy,
        project_resolver=project_policy.project_for,
    )
    skill_credentials = skill_credentials_from_env(activities=activities)
    skill_catalog.bind_authentication(skill_credentials.authenticated)

    async def host_environment(user_id: str) -> dict[str, str]:
        credential = account_tokens.current(user_id)
        environment = await skill_credentials.ensure(user_id, credential)
        if account_tokens.current(user_id) != credential:
            raise RuntimeError("runtime host authentication changed during preparation")
        return environment

    runtime_service.bind_host_warmup(cwd=workspace, environment=host_environment)
    session_service = SessionService(
        workspace,
        sessions,
        activities=activities,
        access=access_store,
        events=event_store,
        runtime=runtime_service,
        workspaces=session_workspaces,
        artifacts=artifact_store,
        settings=settings_service,
        credentials=skill_credentials,
        logger=_log,
    )
    turn_service = TurnService(
        sessions,
        _log,
        activities=activities,
        prepare=session_service.prepare_turn,
        deliveries=resource_deliveries,
        catalog=access_store,
        events=event_store,
    )
    if turn_service.recovery is not None:
        turn_service.recovery.bind_confirmation(session_service.authorize_crash_retry)
        completion_bridge.bind_output_guard(
            turn_service.recovery.before_output,
            before_request=turn_service.recovery.before_request,
        )
        turn_service.recovery.bind_quiescence(completion_bridge.quiesce_turn)
    session_service.bind_turn_confirmation(turn_service.confirm_queued_unknown)
    session_service.bind_queue_cancellation(turn_service.cancel_pending_locked)
    session_service.bind_settlement_resume(turn_service.resume_pending_settlement)
    event_service = EventService(sessions, event_store, _log)
    feedback_service = FeedbackService()

    app.state.session_catalog = access_store
    app.state.product_events = event_store
    app.state.session_artifacts = artifact_store
    app.state.artifact_service = artifact_service
    app.state.session_workspaces = session_workspaces
    app.state.project_registry = project_registry
    app.state.default_workspace = str(workspace)
    app.state.runtime_service = runtime_service
    # content 域授权/撤销后要把新的可写根推给活跃会话 (proposal 47 §6.9)。
    app.state.session_service = session_service
    # content 域的项目也要能开会话 (proposal 47 §6.8): 判定函数由 bootstrap 注入。
    app.state.project_workspace_policy = project_policy
    app.state.completion_bridge = completion_bridge
    app.state.settings_service = settings_service
    # Assistant one-shot actions use the same account-issued runtime credential
    # projection as normal Session opens. The composition root consumes this service;
    # no credential value is exposed through HTTP or persisted on app.state itself.
    app.state.skill_credentials = skill_credentials
    app.state.skill_service = skill_service
    app.state.skill_catalog = skill_catalog
    app.state.turn_service = turn_service
    app.state.harness_id = runtime_id
    app.state.service_instance_id = service_instance_id

    mount_session_routes(
        app,
        sessions=session_service,
        turns=turn_service,
        events=event_service,
        artifacts=artifact_service,
        credentials=skill_credentials,
    )
    mount_notification_routes(app, session_service)
    mount_attention_routes(
        app,
        AttentionService(AttentionStore(access_store), access_store, event_store, session_service),
    )
    mount_setting_routes(
        app,
        models=model_service,
        subscriptions=subscriptions,
        settings=settings_service,
        runtime=runtime_service,
    )
    mount_mcp_routes(app, mcp_service)
    connector_service = ConnectorService(
        connector_store,
        mcp_service,
        activities,
        snapshot=session_service.mcp_snapshot,
        tools=session_service.mcp_tools,
        hosted=hosted_oauth,
    )
    connector_broker.observer = connector_service.observe
    connector_service.broker = connector_broker
    app.state.connector_broker = connector_broker
    mount_connector_routes(app, connector_service)
    mount_skill_routes(
        app, skills=skill_service, credentials=skill_credentials, activities=activities
    )
    mount_feedback_routes(
        app,
        activities=activities,
        feedback=feedback_service,
        catalog=access_store,
        credentials=skill_credentials,
        runtime=runtime_service,
    )
    diagnostics = DiagnosticService(runtime_service.recording, activities=activities)
    mount_diagnostic_routes(app, diagnostics)
    register_capability_routes(
        app,
        activities=activities,
        workspace=workspace,
    )
    mount_completion_bridge(app, completion_bridge)

    @app.get("/api/serve/runtime/reconfiguration")
    def shared_reconfiguration() -> dict[str, Any]:
        state = runtime_service.reconfiguration.state
        return {
            "state": state.value if state is not None else None,
            "service_instance_id": service_instance_id,
        }

    def backend_health() -> dict[str, Any]:
        return {
            "ok": True,
            "features": {"browser": app.state.product_features.browser_enabled},
            "product": str(getattr(app.state, "product", DEFAULT_PRODUCT)),
            "storage_profile": str(getattr(app.state, "storage_profile", DEFAULT_STORAGE_PROFILE)),
            "storage_instance_id": storage_instance_id(),
            "service_instance_id": service_instance_id,
            "workbench_ready": activities.workbench_ready,
            "stack": NEW_STACK_ID,
            "cwd": str(workspace),
            "runtime_id": runtime_id,
        }

    @app.get(
        BACKEND_HEALTH_ROUTE,
        dependencies=[Depends(execution_admission(activities, ActivityDomain.STARTUP))],
    )
    async def backend_healthz() -> dict[str, Any]:
        return backend_health()

    @app.get(
        "/api/healthz",
        dependencies=[Depends(execution_admission(activities, ActivityDomain.STARTUP))],
    )
    async def healthz() -> dict[str, Any]:
        executable = settings_service.runtime_executable()
        readiness = await runtime_service.readiness(executable=executable)
        process_evidence: dict[int, dict[str, Any]] = {}
        rpc_evidence: dict[int, dict[str, Any]] = {}
        for live in sessions.values():
            evidence = live.runtime_evidence_snapshot()
            process_evidence.update((int(row["evidence_seq"]), row) for row in evidence["process"])
            rpc_evidence.update((int(row["evidence_seq"]), row) for row in evidence["rpc"])
        last_evidence_seq = max((*process_evidence, *rpc_evidence), default=0)
        return {
            **backend_health(),
            "runtime": runtime_payload(version=readiness.version),
            "readiness": readiness_payload(
                readiness,
                configured_executable=executable,
            ),
            "runtime_evidence": {
                "last_evidence_seq": last_evidence_seq,
                "process": [process_evidence[key] for key in sorted(process_evidence)],
                "rpc": [rpc_evidence[key] for key in sorted(rpc_evidence)],
            },
            "capabilities": runtime_capabilities_payload(runtime_service.gateway_capabilities),
        }

    return app


__all__ = ["DEFAULT_STORAGE_PROFILE", "create_chat_app"]
