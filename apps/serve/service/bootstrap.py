"""Single composition root for the ScholarSeed chat product."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Mapping, Optional

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from service.assistant.api.citations import register_citation_bridge
from service.assistant.api.routes import register_assistant_routes
from service.assistant.persistence.citations import CitationStore
from service.assistant.persistence.invocations import AssistantInvocationStore
from service.assistant.persistence.store import AssistantStore
from service.assistant.service.actions import AssistantActionService
from service.assistant.service.annotations import AnswerAnnotationService
from service.assistant.service.authorization import FulltextAuthorizer
from service.assistant.service.citations import CitationService
from service.assistant.service.context import AssistantService
from service.assistant.service.links import LibraryLinkProjection
from service.assistant.service.literature import AssistantLiteratureService
from service.assistant.service.resources import AssistantResourceService
from service.capabilities.api.admission import register_skill_admission
from service.chat.api.artifacts import register_artifact_routes
from service.chat.api.cards import register_card_routes
from service.chat.api.history import register_history_routes
from service.chat.api.plan import register_plan_routes
from service.chat.api.routes import DEFAULT_STORAGE_PROFILE, create_chat_app
from service.chat.api.sessions import ARTIFACT_EDITABLE_HEADER
from service.chat.api.tasks import register_task_routes
from service.chat.constants import SESSION_PROJECT_NOT_REGISTERED_ERROR
from service.chat.persistence.projects import ProjectRegistry as ChatProjectRegistry
from service.chat.service.answers import ProductAnswerSource
from service.chat.service.attachments import AttachmentService
from service.chat.service.cards import CardRegistry
from service.chat.service.completions import MODEL_BRIDGE_ROUTE_PREFIX
from service.chat.service.context import SessionContextProvider
from service.chat.service.history import HistoryService
from service.chat.service.inference import AgentOneShotProvider
from service.chat.service.publication import PublicationService, SessionArtifactStorage
from service.chat.service.settings import SettingsService
from service.chat.service.terminals import TurnTerminalReader
from service.content.api.routes import register_content_routes
from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.context import ContentContextProvider
from service.content.service.port import ContentService, ProjectRegistry
from service.cutover import cutover_pdf_records
from service.identity.api.routes import register_auth
from service.identity.service.auth import AuthService
from service.identity.service.policy import AuthPolicy, install_policy
from service.inference.transport import InferenceProvider
from service.invocation.api.routes import register_invocation_routes
from service.invocation.service.runtime import InvocationService
from service.invocation.service.skills import InvocationSkillResolver
from service.literature.api.analysis import register_analysis_routes
from service.literature.api.evidence import register_card_bridge
from service.literature.api.gate import FulltextGate
from service.literature.api.papermeta import register_papermeta_routes
from service.literature.api.reading import register_reading_routes
from service.literature.api.result import register_result_routes
from service.literature.api.review import register_literature_review_routes
from service.literature.api.routes import register_literature_routes
from service.literature.api.search import register_literature_search_routes
from service.literature.persistence.search import LiteratureSearchService
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.attachment import LiteratureAttachmentContent
from service.literature.service.cards import (
    LITERATURE_REFERENCES_CARD,
    validate_references_card,
)
from service.literature.service.context import LiteratureContextProvider
from service.literature.service.evidence import LiteratureEvidenceService
from service.literature.service.pdf import LiteraturePdf
from service.literature.service.records import AttachmentRecords
from service.literature.service.reference import LiteratureReferenceService
from service.literature.service.result import SEARCH_CARD, validate_search_card
from service.literature.service.review import REVIEW_CARD, validate_review_card
from service.literature.service.status import ResultStatusService
from service.paths import (
    CONTENT_DB,
    DEFAULT_WORKSPACE_ENV,
    PROJECT_DB_RELATIVE,
    RESOURCE_IMPORTS_DB,
    SERVICE_LITERATURE_DATABASE,
)
from service.platform.bridge import (
    BRIDGE_ROUTE_PREFIX,
    ArtifactPublisher,
    DisplayCardPublisher,
    SkillCaller,
)
from service.platform.citations import PDF_INDEX_STATE
from service.platform.content import ArtifactScopeKind, ProjectRef, RootKind
from service.platform.context import AssistantContextProvider, AssistantTurnSnapshot, ContextRefKind
from service.platform.excerpts import ExcerptSourceKind
from service.platform.local import local_listener
from service.platform.search import register_search_routes
from service.platform.web import mount_renderer, register_cross_origin_isolation
from service.resources.api.ai import register_resource_ai_routes
from service.resources.api.bridge import register_resource_bridge
from service.resources.api.jobs import register_resource_import_routes
from service.resources.api.routes import register_resource_routes
from service.resources.api.settings import register_version_setting_routes
from service.resources.api.versions import CONTENT_REVISION_HEADER, register_version_routes
from service.resources.persistence.catalog import (
    ResourceAgentImportCatalog,
    ResourceExcerptCatalog,
    ResourceWebSourceCatalog,
)
from service.resources.persistence.jobs import ImportJobStore
from service.resources.service.activation import ResourceActivation
from service.resources.service.ai import ResourceAIService
from service.resources.service.batch import ResourceReviewBatchService
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.excerpts import ResourceExcerptService
from service.resources.service.fetcher import HtmlFetcher
from service.resources.service.history import ResourceVersionService
from service.resources.service.importer import (
    ResourceImportService as ResourceImportDecisionService,
)
from service.resources.service.importer import (
    WebImporter,
)
from service.resources.service.jobs import ResourceImportService as ResourceImportJobService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.resources.service.writer import ResourceWriter
from service.workbench.api.routes import register_workbench_routes
from service.workbench.api.selection import register_selection_action_routes
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.persistence.records import PdfRecordCatalog
from service.workbench.service.context import SelectionContextProvider
from service.workbench.service.indexing import PdfIndexService
from service.workbench.service.materialize import PdfMaterializer
from service.workbench.service.preview import PdfPreviewService
from service.workbench.service.records import PdfRecordStore
from service.workbench.service.selection import (
    SelectionActionService,
    default_selection_action_registry,
)

_log = logging.getLogger("scholarseed.serve")

PRODUCT_ALL = "all"
PRODUCT_CHAT = "chat"
PRODUCT_CHOICES = (PRODUCT_ALL, PRODUCT_CHAT)
PRODUCT_DOMAIN_COMPOSITION: Mapping[str, frozenset[str]] = {
    PRODUCT_ALL: frozenset(),
    PRODUCT_CHAT: frozenset(),
}
DEFAULT_PRODUCT_DOMAINS: frozenset[str] = frozenset()
DEFAULT_CORS_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")
LOOPBACK_CORS_ORIGIN_PATTERN = r"^http://(?:localhost|127\.0\.0\.1):\d+$"
CORS_EXPOSE_HEADERS = ("ETag", CONTENT_REVISION_HEADER, ARTIFACT_EDITABLE_HEADER)
INDEPENDENTLY_AUTHENTICATED_PREFIXES = (MODEL_BRIDGE_ROUTE_PREFIX, BRIDGE_ROUTE_PREFIX)
PRODUCT_STORAGE_PROFILES: Mapping[str, str] = {
    PRODUCT_ALL: DEFAULT_STORAGE_PROFILE,
    PRODUCT_CHAT: DEFAULT_STORAGE_PROFILE,
}


def _product_enabled(product: str, domain: str) -> bool:
    return domain in PRODUCT_DOMAIN_COMPOSITION.get(product, DEFAULT_PRODUCT_DOMAINS)


def resolve_workspace_root(cwd: Path | None, settings: SettingsService | None = None) -> Path:
    """工作区根的唯一解析处 (proposal 47 §6.4)。

    取值顺序: 产品设置 `workspace_root` > `SCHOLARSEED_DEFAULT_WORKSPACE` >
    调用方注入 (桌面端把 `app.getPath('documents')/书深` 传进来) > 进程 cwd。

    只有组合根做这件事: 之前 `cli/serve.py` 与本文件各算一次, 两处一旦漂移,
    日志里打印的工作区与 content 实际用的根就不是同一个目录。
    """

    configured = (settings or SettingsService()).workspace_root()
    if configured:
        return Path(configured).expanduser().resolve()
    injected = os.environ.get(DEFAULT_WORKSPACE_ENV, "").strip()
    if injected:
        return Path(injected).expanduser().resolve()
    return Path(cwd or Path.cwd()).expanduser().resolve()


def _legacy_project_seeds() -> tuple[tuple[Path, str], ...]:
    """存量项目种子 (chat 域的 `projects.json`, 迁移完成前只读)。

    读它的是组合根而不是 content: content 不得 import 上层域, 而「从哪里种」
    是装配决策。
    """

    seeds: list[tuple[Path, str]] = []
    for entry in ChatProjectRegistry().projects():
        raw = str(entry.get("path") or "").strip()
        if not raw:
            continue
        seeds.append((Path(raw), str(entry.get("name") or "")))
    return tuple(seeds)


def _bind_writable_roots(app: FastAPI, content: ContentService) -> None:
    """把「某个项目当前允许写哪些根」接到会话域。

    会话域不 import content: 它只拿一个 `Path → 可写根集合` 的函数。绑定发生在
    组合根, 因为「哪个域回答这个问题」是装配决策 (proposal 47 §6.9)。
    未绑定时会话域回空集合 —— 等价于只有 cwd 可写, 即改造前的行为。
    """

    sessions = getattr(app.state, "session_service", None)
    if sessions is None:
        return

    def provider(scope: Path) -> tuple[Path, ...]:
        project = content.project_for_path(str(scope))
        if project is None:
            return ()
        return tuple(
            dict.fromkeys(
                (Path(project.root), *(Path(root) for root in content.writable_roots(project.id)))
            )
        )

    sessions.bind_writable_roots(provider)

    def output_directory(scope: Path, session_id: str) -> Path:
        project = content.project_for_path(str(scope))
        if project is None:
            raise ValueError(SESSION_PROJECT_NOT_REGISTERED_ERROR)
        try:
            root = content.root(project.id, RootKind.SESSIONS)
            directory = content.ensure_directory(project.id, root.path, session_id)
            return Path(content.resolve(project.id, directory.path))
        except ContentError as error:
            raise ValueError(error.code) from error

    sessions.bind_output_directory(output_directory)


def _bind_project_recognition(app: FastAPI, content: ContentService) -> None:
    """让会话侧认 content 域登记的项目 (proposal 47 §6.8)。

    不接这一条, 用户在产品里新建的项目开会话会被拒成
    `project_path_not_registered` —— 因为会话侧只认 chat 域那份存量 `projects.json`。
    过渡期两个来源并存, 迁移完成后 chat 侧下线, 判定只剩 content 一处。
    """

    policy = getattr(app.state, "project_workspace_policy", None)
    if policy is None:
        return
    policy.bind_recognizer(lambda path: content.project_for_path(str(path)) is not None)


def create_app(
    cwd: Path | None = None,
    *,
    cases_root: Optional[Path] = None,
    product: str = PRODUCT_ALL,
    renderer_dist: str = "",
    cors_origins: Optional[list[str]] = None,
    auth: Optional[bool] = None,
    auth_mode: str | None = None,
    ownership_axis: str | None = None,
    local_bridge_root: Path | None = None,
) -> FastAPI:
    """Compose chat, capabilities, identity, and the renderer."""

    del cases_root
    settings = SettingsService()
    workspace = resolve_workspace_root(cwd, settings)
    selected_product = (product or PRODUCT_ALL).strip().lower()
    catalog = ContentCatalog(CONTENT_DB)
    registry = ProjectRegistry(str(workspace), catalog)
    # 首启只种存量条目 (chat/projects.json), 不把工作区根自己种成项目 ——
    # 容器根是项目的家, 不是项目本身 (proposal 47 §4)。首启无项目时前端进入
    # 「还没选定项目」态, 由用户新建/选择项目。
    registry.seed_legacy(_legacy_project_seeds())
    content = ContentService(registry, catalog)
    settings.initialize_version_policy(existing_projects=bool(content.projects()))
    cutover_pdf_records(
        SERVICE_LITERATURE_DATABASE,
        (
            Path(content.resolve(project.id, PROJECT_DB_RELATIVE))
            for project in content.projects()
            if project.available
        ),
    )
    writer = ResourceWriter(content)
    resource_retention = ResourceRetentionService(content, settings)
    format_policy = WorkbenchFormatPolicy()
    literature_repository = LiteratureRepository()
    literature_attachments = LiteratureAttachmentContent(literature_repository)
    attachment_records = AttachmentRecords(literature_attachments, literature_repository)
    annotation_store = PdfRecordStore(
        content,
        PdfRecordCatalog(content),
        shared_records=attachment_records,
    )
    resource_versions = ResourceVersionService(
        content, resource_retention, format_policy, annotation_store
    )
    version_supervisor = ResourceVersionSupervisor(
        content,
        resource_versions,
        format_policy,
        settings,
    )
    resource_versions.bind_admission_policy(version_supervisor)
    resource_deliveries = ResourceDeliveryService(content, resource_versions, version_supervisor)
    resource_recovery = ResourceRecoveryService(content, resource_retention, annotation_store)
    resource_review_batches = ResourceReviewBatchService(
        content, resource_versions, resource_recovery
    )
    resource_review_migration = ResourceReviewMigration(content, resource_versions)
    resource_activation = ResourceActivation(
        content,
        resource_recovery,
        resource_versions,
        resource_deliveries,
        resource_retention,
        resource_review_migration,
    )
    version_supervisor.bind_preparation(resource_activation)
    content.bind_resource_changes(version_supervisor)
    # 项目永久删除时文献域回收其全库面关联: 归档只隐藏关联, 删除才真清理。
    literature_repository = LiteratureRepository()

    def drop_project_links(project_id: str) -> None:
        literature_repository.drop_project_links(project_id)

    content.bind_project_forget_sink(drop_project_links)
    resource_imports = ResourceImportJobService(content, ImportJobStore(RESOURCE_IMPORTS_DB))
    app = create_chat_app(
        workspace,
        settings=settings,
        lifecycles=(version_supervisor, resource_imports),
        resource_deliveries=resource_deliveries,
        resource_review_batches=resource_review_batches,
        ownership_axis=ownership_axis,
        formats=format_policy,
    )

    async def publish_import_roots(project_id: str) -> None:
        project = content.project(project_id)
        writable = tuple(Path(root) for root in content.writable_roots(project.id))
        await app.state.session_service.publish_writable_roots(Path(project.root), writable)

    resource_imports.bind_roots_publisher(publish_import_roots)
    resource_imports.bind_version_initializer(version_supervisor.initialize_paths)
    app.state.product = selected_product
    app.state.storage_profile = PRODUCT_STORAGE_PROFILES.get(
        selected_product, DEFAULT_STORAGE_PROFILE
    )
    app.state.workspace = workspace
    resource_deliveries.bind_terminals(
        TurnTerminalReader(app.state.session_catalog, app.state.product_events)
    )
    web_sources = ResourceWebSourceCatalog(content)
    web_fetcher = HtmlFetcher()
    web_importer = WebImporter(writer, content, web_sources)
    resource_importer = ResourceImportDecisionService(
        content,
        resource_versions,
        version_supervisor,
    )
    literature_references = LiteratureReferenceService(content)
    cards = CardRegistry()
    cards.register(LITERATURE_REFERENCES_CARD, validate_references_card)
    cards.register(SEARCH_CARD, validate_search_card, direct=False)
    cards.register(REVIEW_CARD, validate_review_card, direct=False)
    app.state.runtime_service.bind_cards(cards)
    resource_excerpts = ResourceExcerptService(
        content,
        writer,
        ResourceExcerptCatalog(content),
        {ExcerptSourceKind.LITERATURE: literature_references},
    )
    assistant_store = AssistantStore(app.state.session_catalog.database)
    app.state.session_service.bind_project_relocation(assistant_store.clear_for_relocation)
    assistant_invocations = AssistantInvocationStore(app.state.session_catalog.database)

    # Project refs remain relative. Literature attachments may carry the absolute path
    # resolved by their owner; the injected reader revalidates that path at turn time.
    def project_for_session(session_id: str) -> ProjectRef | None:
        record = app.state.session_catalog.get(session_id)
        if record is None or not record.project_path:
            return None
        return content.project_for_path(record.project_path)

    async def one_shot_environment(owner_id: str) -> Mapping[str, str]:
        # The auth middleware has already captured this request's JWT in memory. Reuse
        # the normal Session-open credential projection so a custom Codex runtime gets
        # its required launch argument while the model bridge still resolves JWT per call.
        credential = app.state.account_tokens.current(owner_id)
        return await app.state.skill_credentials.environment(owner_id, credential)

    invocation_service = InvocationService(
        runtime=app.state.runtime_service,
        settings=app.state.settings_service,
        skills=InvocationSkillResolver(
            app.state.runtime_service,
            app.state.settings_service,
            app.state.skill_catalog,
        ),
        environment=one_shot_environment,
    )
    app.state.invocations = invocation_service
    app.state.literature_searches = LiteratureSearchService(invocation_service)

    def resolve_artifact_caller(scope_id: str) -> ArtifactPublisher | None:
        caller = app.state.session_service.bridge_caller(scope_id)
        return caller or invocation_service.bridge_caller(scope_id)

    def resolve_display_card_caller(scope_id: str) -> DisplayCardPublisher | None:
        return app.state.session_service.bridge_caller(scope_id)

    def resolve_skill_caller(scope_id: str) -> SkillCaller | None:
        return app.state.session_service.bridge_caller(
            scope_id
        ) or invocation_service.bridge_caller(scope_id)

    content_context = ContentContextProvider(
        content, absolute_file_reader=literature_attachments.read_absolute
    )
    selection_context = SelectionContextProvider(content, resource_versions.read_revision)
    literature_context = LiteratureContextProvider(content)
    history = HistoryService(
        app.state.session_catalog,
        app.state.product_events,
        project_for_session=project_for_session,
    )
    app.state.history_service = history
    session_context = SessionContextProvider(history)
    answer_source = ProductAnswerSource(app.state.product_events)
    annotation_service = AnswerAnnotationService(assistant_store, answer_source)

    def citation_snapshot(session_id: str, turn_id: str) -> AssistantTurnSnapshot | None:
        context = app.state.product_events.turn_context(session_id, turn_id)
        snapshot_id = context.get("assistant_snapshot_id")
        return assistant_store.snapshot_by_id(session_id, snapshot_id) if snapshot_id else None

    pdf_indexes = PdfIndexService(content, assistant_store.database)
    index_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def with_pdf_indexes(application: FastAPI):
        try:
            async with index_lifespan(application):
                yield
        finally:
            await asyncio.to_thread(pdf_indexes.close)

    app.router.lifespan_context = with_pdf_indexes
    app.state.assistant_citations = CitationService(
        answer_source,
        citation_snapshot,
        assistant_store.snapshot_by_id,
        lambda session_id: project.id if (project := project_for_session(session_id)) else None,
        {
            ContextRefKind.FILE: content_context,
            ContextRefKind.SELECTION: content_context,
            ContextRefKind.LITERATURE: literature_context,
        },
        pdf_indexes,
        CitationStore(assistant_store.database),
        AttachmentService(app.state.session_catalog, app.state.product_events),
        LiteratureEvidenceService(
            pdf_indexes,
            literature_repository,
            records=attachment_records,
        ),
        records=annotation_store,
        preview=PdfPreviewService(),
    )
    app.state.runtime_service.bind_answer_filter(app.state.assistant_citations.filter_answer)
    app.state.fulltext_authorizer = FulltextAuthorizer(
        assistant_store.database, app.state.session_catalog
    )
    app.state.fulltext_gate = FulltextGate(app.state.fulltext_authorizer, app.state.turn_service)
    app.state.runtime_service.bind_activity_observer(app.state.fulltext_gate.observe)
    context_providers: dict[ContextRefKind, AssistantContextProvider] = {
        ContextRefKind.FILE: content_context,
        ContextRefKind.DIR: content_context,
        ContextRefKind.LITERATURE: literature_context,
        ContextRefKind.SESSION: session_context,
        ContextRefKind.NOTE: annotation_service,
        ContextRefKind.SELECTION: selection_context,
    }
    app.state.content = content
    app.state.pdf_records = annotation_store
    # 文献域删除附件时要顺带丢掉由该文件派生的全文索引缓存; 它只认这个端口,
    # 不直接依赖 Workbench 的实现。
    setattr(app.state, PDF_INDEX_STATE, pdf_indexes)
    content.bind_artifact_scope(
        ArtifactScopeKind.SESSION, SessionArtifactStorage(app.state.session_catalog).resolve
    )
    publications = PublicationService(content)
    app.state.runtime_service.bind_publications(publications)
    app.state.artifact_service.bind_content(content)
    app.state.resource_review_migration = resource_review_migration
    app.state.resource_writer = writer
    app.state.resource_versions = resource_versions
    app.state.resource_deliveries = resource_deliveries
    app.state.resource_recovery = resource_recovery
    app.state.resource_review_batches = resource_review_batches
    app.state.resource_version_supervisor = version_supervisor
    app.state.resource_imports = resource_imports
    app.state.resource_retention = resource_retention
    app.state.resource_importer = resource_importer
    app.state.web_importer = web_importer
    app.state.web_icon_fetcher = web_fetcher
    app.state.resource_web_sources = web_sources
    app.state.resource_excerpts = resource_excerpts
    register_cross_origin_isolation(app)
    app.state.assistant_store = assistant_store
    app.state.assistant_annotations = annotation_service
    app.state.assistant = AssistantService(
        assistant_store,
        project_for_session=lambda session_id: (
            project.id if (project := project_for_session(session_id)) is not None else None
        ),
        providers=context_providers,
    )
    history_router = register_history_routes(
        app, app.state.session_service, history, app.state.assistant
    )
    artifact_router = register_artifact_routes(app, resolve_artifact_caller)
    skill_router = register_skill_admission(app, resolve_skill_caller, app.state.runtime_service)
    evidence_router = register_card_bridge(
        app, app.state.session_service, app.state.fulltext_authorizer
    )
    card_router = register_card_routes(app, resolve_display_card_caller, cards)
    result_router = register_result_routes(
        app,
        app.state.session_service,
        app.state.session_catalog,
        ResultStatusService(),
        app.state.product_events,
        app.state.artifact_service,
        app.state.fulltext_authorizer,
    )
    plan_router = register_plan_routes(app, app.state.session_service)
    task_router = register_task_routes(app, app.state.session_service)
    review_router = register_literature_review_routes(
        app, app.state.session_service, app.state.fulltext_authorizer
    )
    citation_router = register_citation_bridge(
        app,
        app.state.session_service,
        app.state.assistant_citations,
        app.state.fulltext_authorizer,
        PdfMaterializer(),
    )
    resource_bridge_router = register_resource_bridge(app, app.state.session_service, content)
    if local_bridge_root is not None:
        bridge_router = APIRouter()
        bridge_router.include_router(history_router)
        bridge_router.include_router(artifact_router)
        bridge_router.include_router(skill_router)
        bridge_router.include_router(card_router)
        bridge_router.include_router(result_router)
        bridge_router.include_router(review_router)
        bridge_router.include_router(plan_router)
        bridge_router.include_router(task_router)
        bridge_router.include_router(evidence_router)
        bridge_router.include_router(citation_router)
        bridge_router.include_router(resource_bridge_router)
        original_lifespan = app.router.lifespan_context

        @asynccontextmanager
        async def lifespan(application: FastAPI):
            async with local_listener(bridge_router, local_bridge_root) as endpoint:
                application.state.runtime_service.bind_local_socket(endpoint)
                try:
                    async with original_lifespan(application):
                        yield
                finally:
                    application.state.runtime_service.bind_local_socket(None)

        app.router.lifespan_context = lifespan
    # 单次调用不建产品 Chat Session，但仍经当前 Agent surface runtime/adapter 执行。
    # Provider 使用调用期空工作区，避免轻量 action 自动载入项目上下文；Assistant
    # 不直连 Codex 或模型网关，project_id 只用于产品归属和审计。
    app.state.assistant_actions = AssistantActionService(
        assistant_invocations,
        model=AgentOneShotProvider(
            app.state.runtime_service,
            app.state.settings_service,
            one_shot_environment,
        ),
    )
    library_projection = LibraryLinkProjection(
        content, app.state.session_catalog, app.state.product_events
    )
    app.state.assistant_literature = AssistantLiteratureService(
        content,
        app.state.artifact_service,
        project_for_session,
        library_projection,
    )
    agent_imports = ResourceAgentImportCatalog(content)
    app.state.resource_agent_imports = agent_imports
    app.state.assistant_resources = AssistantResourceService(
        writer,
        app.state.artifact_service,
        project_for_session,
        content,
        library_projection,
        AttachmentService(app.state.session_catalog, app.state.product_events),
        events=app.state.product_events,
        assistant=assistant_store,
        answers=answer_source,
        imports=agent_imports,
        citations=app.state.assistant_citations,
    )
    app.state.turn_service.bind_context_source(app.state.assistant)
    app.state.runtime_service.bind_project_resolver(
        lambda path: (
            project.id if (project := content.project_for_path(str(path))) is not None else ""
        ),
    )

    app.state.selection_actions = SelectionActionService(
        evidence=selection_context,
        actions=app.state.assistant_actions,
        registry=default_selection_action_registry(),
    )
    # 关联根 → 会话沙箱的注入点。放在 content 构造之后、路由注册之前。
    _bind_writable_roots(app, content)
    _bind_project_recognition(app, content)

    # MVP 0.2 六个纵向功能域 + 跨域全局搜索。
    # 注册在鉴权之前, 因此同样受 /api 鉴权保护。
    register_content_routes(app)
    register_resource_routes(app)
    register_resource_import_routes(app)
    register_version_routes(app)
    register_version_setting_routes(
        app,
        settings=settings,
        retention=resource_retention,
        supervisor=version_supervisor,
    )
    register_literature_routes(app)
    register_papermeta_routes(app)
    literature_pdf = LiteraturePdf(literature_repository)
    register_reading_routes(
        app,
        literature_repository,
        literature_attachments,
        literature_pdf,
        format_policy,
    )
    direct_actions = AssistantActionService(
        assistant_invocations,
        model=InferenceProvider(
            app.state.model_service,
            AgentOneShotProvider(
                app.state.runtime_service,
                app.state.settings_service,
                one_shot_environment,
                ephemeral=True,
            ),
        ),
    )
    register_resource_ai_routes(
        app,
        service=ResourceAIService(
            evidence=selection_context,
            actions=direct_actions,
            tasks=assistant_invocations,
        ),
        models=app.state.model_service,
    )
    register_analysis_routes(
        app,
        actions=direct_actions,
        tasks=assistant_invocations,
        models=app.state.model_service,
        pdf=literature_pdf,
        content=content,
    )
    register_workbench_routes(app)
    register_selection_action_routes(app)
    register_assistant_routes(app)
    register_invocation_routes(app)
    register_literature_search_routes(app)
    register_search_routes(app)

    auth_enabled = AuthService().has_users() if auth is None else bool(auth)
    try:
        register_auth(
            app,
            enabled=auth_enabled,
            mode=auth_mode,
            independently_authenticated_prefixes=INDEPENDENTLY_AUTHENTICATED_PREFIXES,
            # 鉴权 middleware 是每个已鉴权 /api 请求唯一都经过、且此时手里还持有原始凭据的
            # 地方。出站计量头发生在另一个请求上下文（Codex 子进程 → loopback bridge →
            # 网关），那条路上没有任何用户凭据 —— 不在这里抓一把，网关永远无法归属到人。
            account_tokens=getattr(app.state, "account_tokens", None),
            on_logout=app.state.subscriptions.logout,
            on_auth_disabled=app.state.subscriptions.logout_all,
        )
    except Exception as exc:  # noqa: BLE001 - local product can run without identity setup
        _log.exception("auth_init_error", extra={"failure_type": type(exc).__name__})
        auth_enabled = False
        # 装配失败也要有 policy 可读（request_user_id / status 每请求读）：fail-open 到
        # 免鉴权投影，与既有 fail-open 语义一致。
        install_policy(
            app,
            AuthPolicy(
                enabled=False,
                mode=auth_mode,
                public_prefixes=("/api/healthz", "/api/auth/"),
                exempt_prefixes=INDEPENDENTLY_AUTHENTICATED_PREFIXES,
            ),
        )
    app.state.auth_enabled = auth_enabled

    # CORS 必须最后注册 —— Starlette 里后加的 middleware 包在最外层。鉴权 middleware 拒绝
    # 请求时是直接 return 一个 401, 不进内层; 若 CORS 在内层, 这个 401 就不带
    # Access-Control-Allow-Origin —— 跨源前端 (dev 期 Vite 源) 根本读不到状态码,
    # 只能报一个笼统的 "Failed to fetch": 于是前端看不到 401, 也就永远不会把用户送回
    # 登录页 (远程登出/令牌过期表现成界面卡死)。CORS 包在最外层才能让每个响应
    # (包括鉴权拒绝) 都带上 CORS 头。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins if cors_origins is not None else list(DEFAULT_CORS_ORIGINS),
        allow_origin_regex=(LOOPBACK_CORS_ORIGIN_PATTERN if cors_origins is None else None),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=list(CORS_EXPOSE_HEADERS),
    )

    mount_renderer(app, renderer_dist)
    return app


__all__ = [
    "PRODUCT_ALL",
    "PRODUCT_CHAT",
    "PRODUCT_CHOICES",
    "create_app",
    "resolve_workspace_root",
]
