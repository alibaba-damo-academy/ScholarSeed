"""Chat product composition for the native Codex runtime."""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import Any, Mapping

from fastapi import FastAPI

from service.capabilities.api.routes import register_capability_routes
from service.capabilities.service.skills import SkillCatalog
from service.chat.api.diagnostics import mount_diagnostic_routes
from service.chat.api.feedback import mount_feedback_routes
from service.chat.api.sessions import mount_session_routes
from service.chat.api.settings import mount_setting_routes
from service.chat.api.skills import mount_skill_routes
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventStore
from service.chat.persistence.projects import ProjectRegistry
from service.chat.runtime.composition import LiveSessionService
from service.chat.runtime.live import LiveSession
from service.chat.runtime.projection import (
    readiness_payload,
    runtime_capabilities_payload,
    runtime_payload,
)
from service.chat.service.artifacts import ArtifactService
from service.chat.service.completions import (
    CompletionBridge,
    mount_completion_bridge,
)
from service.chat.service.diagnostics import DiagnosticService
from service.chat.service.events import EventService
from service.chat.service.feedback import FeedbackService
from service.chat.service.models import ModelService
from service.chat.service.projects import ProjectWorkspacePolicy
from service.chat.service.sessions import SessionService, workspace_allows
from service.chat.service.settings import SettingsService
from service.chat.service.skills import SkillService
from service.chat.service.subscriptions import SubscriptionService
from service.chat.service.turns import TurnService
from service.chat.service.workspaces import SessionWorkspaceService
from service.identity.service.account_token import AccountTokenHolder
from service.identity.service.skill_credentials import skill_credentials_from_env
from service.identity.utils import (
    OWNERSHIP_AXIS_ENV,
    OWNERSHIP_AXIS_MACHINE,
    OWNERSHIP_AXIS_STATE,
    resolve_ownership_axis,
)
from service.paths import SERVICE_BUNDLED_SKILLS_DIR, SERVICE_SKILLS_DIR, storage_instance_id
from service.platform.bridge import INTERNAL_BASE_URL_ENV
from service.platform.lifecycle import ServiceLifecycle
from service.platform.workbench import DocumentFormatPort
from service.resources.service.batch import ResourceReviewBatchService
from service.resources.service.delivery import ResourceDeliveryService
from service.settings.catalog import DEEPRD_GATEWAY_BASE_URL
from service.settings.connections import ModelProfileStore
from service.settings.credentials import ModelCredentialStore

_log = logging.getLogger("scholarseed.newserve")
DEFAULT_PRODUCT = "all"
DEFAULT_STORAGE_PROFILE = "scholarseed"
NEW_STACK_ID = "codex-appserver"


def create_chat_app(
    cwd: Path,
    *,
    settings: SettingsService,
    lifecycles: tuple[ServiceLifecycle, ...] = (),
    resource_deliveries: ResourceDeliveryService | None = None,
    resource_review_batches: ResourceReviewBatchService | None = None,
    ownership_axis: str | None = None,
    formats: DocumentFormatPort,
) -> FastAPI:
    """Create the Service-owned product shell around typed Codex sessions."""

    sessions: dict[str, LiveSession] = {}
    skill_service: SkillService | None = None
    feedback_service: FeedbackService | None = None

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        async with AsyncExitStack() as services:
            access_store.recover_inflight()
            await runtime_service.start()
            maintenance = asyncio.create_task(
                diagnostics.maintain(
                    lambda: {
                        session_id for session_id, session in sessions.items() if session.running
                    }
                )
            )
            try:
                for service in lifecycles:
                    services.push_async_callback(service.aclose)
                    await service.start()
                yield
            finally:
                maintenance.cancel()
                await asyncio.gather(maintenance, return_exceptions=True)
                try:
                    await runtime_service.aclose()
                finally:
                    closures = [session.aclose() for session in tuple(sessions.values())]
                    if skill_service is not None:
                        closures.append(skill_service.aclose())
                    await asyncio.gather(*closures, return_exceptions=True)
                    sessions.clear()
                    await subscriptions.close()
                    if feedback_service is not None:
                        feedback_service.close()

    service_instance_id = uuid.uuid4().hex
    app = FastAPI(title="scholarseed-serve", lifespan=lifespan)
    workspace = cwd.expanduser().resolve()

    axis = resolve_ownership_axis(ownership_axis, os.environ.get(OWNERSHIP_AXIS_ENV, ""))
    setattr(app.state, OWNERSHIP_AXIS_STATE, axis)
    # 归属轴有两个必须同时设的开关: 请求侧的身份投影读 app.state 上的轴, 存储侧的谓词退化
    # 读各 store 的 shared_ownership。只设一半就会得到"归属身份是机器级常量、谓词仍按账号
    # 过滤"的空集, 所以这里算一次, 会话目录与个人连接层共用同一个值。
    shared_ownership = axis == OWNERSHIP_AXIS_MACHINE
    access_store = SessionCatalogStore(shared_ownership=shared_ownership)
    event_store = ProductEventStore(access_store.database)
    artifact_store = SessionArtifactStore(access_store.database)
    artifact_service = ArtifactService(access_store, artifact_store, event_store, formats)
    project_registry = ProjectRegistry()
    settings_service = settings

    def session_turn_id(session_id: str) -> str:
        live = sessions.get(session_id)
        return live.active_product_turn_id if live is not None else ""

    def observe_model(session_id: str, client_turn_id: str, actual_model: str) -> None:
        live = sessions.get(session_id)
        if live is not None:
            live.observe_model(client_turn_id, actual_model)

    def observe_completion(session_id: str, fields: Mapping[str, Any]) -> None:
        live = sessions.get(session_id)
        if live is not None:
            live.trace_completion(fields)

    def source_text(session_id: str, client_turn_id: str) -> str | None:
        live = sessions.get(session_id)
        return live.source_text(client_turn_id) if live is not None else None

    completion_bridge = CompletionBridge(
        os.environ.get(INTERNAL_BASE_URL_ENV, ""),
        on_model=observe_model,
        on_diagnostic=observe_completion,
        turn_ids=session_turn_id,
        source_text=source_text,
        source_endpoints=(DEEPRD_GATEWAY_BASE_URL,),
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
    )
    app.state.model_service = model_service
    skill_catalog = SkillCatalog(
        bundled_root=SERVICE_BUNDLED_SKILLS_DIR,
        user_root=SERVICE_SKILLS_DIR,
    )
    runtime_service = LiveSessionService(
        catalog=access_store,
        events=event_store,
        artifacts=artifact_store,
        skills=skill_catalog,
        models=model_service,
        logger=_log,
        resource_changes=resource_deliveries,
    )
    runtime_service.bind_sessions(sessions)
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
    skill_credentials = skill_credentials_from_env()
    skill_catalog.bind_authentication(skill_credentials.authenticated)
    session_service = SessionService(
        workspace,
        sessions,
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
        prepare=session_service.prepare_turn,
        deliveries=resource_deliveries,
        review_batches=resource_review_batches,
        catalog=access_store,
        events=event_store,
    )
    session_service.bind_turn_confirmation(turn_service.confirm_queued_unknown)
    session_service.bind_queue_cancellation(turn_service.cancel_pending_locked)
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
    mount_setting_routes(
        app,
        models=model_service,
        subscriptions=subscriptions,
        settings=settings_service,
        runtime=runtime_service,
    )
    mount_skill_routes(app, skills=skill_service, credentials=skill_credentials)
    mount_feedback_routes(
        app, feedback=feedback_service, catalog=access_store, credentials=skill_credentials
    )
    diagnostics = DiagnosticService(runtime_service.recording)
    mount_diagnostic_routes(app, diagnostics)
    register_capability_routes(
        app,
        workspace=workspace,
    )
    mount_completion_bridge(app, completion_bridge)

    @app.get("/api/healthz")
    async def healthz() -> dict[str, Any]:
        # 桌面启动必然轮询这里等后端就绪; 借这次轮询在后台把技能盘点的冷启预热掉。
        runtime_service.schedule_skill_prewarm(cwd=workspace)
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
            "ok": True,
            "product": str(getattr(app.state, "product", DEFAULT_PRODUCT)),
            "storage_profile": str(getattr(app.state, "storage_profile", DEFAULT_STORAGE_PROFILE)),
            "storage_instance_id": storage_instance_id(),
            "service_instance_id": service_instance_id,
            "stack": NEW_STACK_ID,
            "cwd": str(workspace),
            "runtime_id": runtime_id,
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
