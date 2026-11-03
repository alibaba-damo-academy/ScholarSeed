"""Single composition root for the ScholarSeed chat product."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import math
import os
import sqlite3
import sys
import time
from collections.abc import Awaitable, Callable, Iterable
from contextlib import AbstractContextManager, ExitStack, asynccontextmanager, contextmanager
from dataclasses import asdict, dataclass, field, replace
from enum import StrEnum
from pathlib import Path, PureWindowsPath
from typing import Mapping, Optional

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from damoatrace.paths import PATHS as TRACE_PATHS
from scholarseed_runtime.contract import RuntimePermissionMode
from scholarseed_runtime.contract.storage import StorageRoot, StorageSource
from service.assistant.api.bridge import (
    register_literature_import_bridge,
    register_resource_import_bridge,
)
from service.assistant.api.citations import register_citation_bridge
from service.assistant.api.routes import register_assistant_routes
from service.assistant.persistence.citations import CitationSchema, CitationStore
from service.assistant.persistence.invocations import AssistantInvocationStore, InvocationSchema
from service.assistant.persistence.store import AssistantSchema, AssistantStore
from service.assistant.service.actions import AssistantActionService
from service.assistant.service.annotations import AnswerAnnotationService
from service.assistant.service.authorization import AuthorizationSchema, FulltextAuthorizer
from service.assistant.service.citations import CitationService
from service.assistant.service.context import AssistantService, protect_answer
from service.assistant.service.links import LibraryLinkProjection
from service.assistant.service.literature import AssistantLiteratureService
from service.assistant.service.nextsteps import NEXT_STEPS_CARD, validate_next_steps_card
from service.assistant.service.resources import AssistantResourceService
from service.capabilities.api.admission import register_skill_admission
from service.capabilities.api.management import register_skill_management
from service.chat.api.artifacts import register_artifact_routes
from service.chat.api.browser import register_browser_routes
from service.chat.api.browserhistory import register_browser_history_routes
from service.chat.api.browsersearch import register_browser_search_routes
from service.chat.api.cards import register_card_routes
from service.chat.api.contracts import register_contract_routes
from service.chat.api.history import register_history_routes
from service.chat.api.mcp import register_mcp_bridge
from service.chat.api.plan import register_plan_routes
from service.chat.api.queries import register_project_queries
from service.chat.api.routes import DEFAULT_STORAGE_PROFILE, create_chat_app
from service.chat.api.search import register_conversation_search_routes
from service.chat.api.sessions import ARTIFACT_EDITABLE_HEADER
from service.chat.api.tasks import register_task_routes
from service.chat.constants import SESSION_PROJECT_NOT_REGISTERED_ERROR
from service.chat.persistence import journal
from service.chat.persistence.artifacts import ArtifactSchema, SessionArtifactStore
from service.chat.persistence.catalog import SessionCatalogStore, SessionSchema
from service.chat.persistence.events import EventSchema, ProductEventStore
from service.chat.persistence.projects import PROJECTS_KEY
from service.chat.persistence.projects import ProjectRegistry as ChatProjectRegistry
from service.chat.persistence.trace import (
    HistoryInspection,
    TraceFormats,
    TraceProjection,
    TraceSource,
    inspect_trace_startup,
    recover_trace_storage,
    require_trace_storage,
)
from service.chat.runtime.selection import RuntimeDiscovery
from service.chat.service.adapters import ProductFeatures, product_features
from service.chat.service.answers import ProductAnswerSource
from service.chat.service.attachments import AttachmentService
from service.chat.service.browserhost import BrowserHostClient
from service.chat.service.cards import CardRegistry
from service.chat.service.completions import MODEL_BRIDGE_ROUTE_PREFIX
from service.chat.service.context import SessionContextProvider
from service.chat.service.coverage import CitationCoverage
from service.chat.service.deletion import SessionDeletion
from service.chat.service.history import HistoryService
from service.chat.service.maintenance import (
    SessionMaintenanceService,
    await_storage_maintenance,
    maintain_session_storage,
)
from service.chat.service.publication import PublicationService, SessionArtifactStorage
from service.chat.service.search import SearchService
from service.chat.service.settings import SettingsService
from service.chat.service.terminals import TurnTerminalReader
from service.chat.service.titles import SessionTitles
from service.content.api.routes import register_content_routes
from service.content.domain.model import (
    PROJECT_STATE_DIRNAME,
    ROOT_SOURCE_CHANGED_ERROR,
    ContentError,
)
from service.content.domain.naming import DEFAULT_PROJECT_NAME
from service.content.persistence.catalog import (
    AUTHORIZATION_SUPERSEDED,
    PROJECT_CREATION_PRESERVED,
    CatalogRoots,
    ContentCatalog,
    ExternalRootRow,
    ProjectCreation,
)
from service.content.service.context import ContentContextProvider
from service.content.service.operations import (
    AdoptProject,
    AuthorizeRoot,
    ContentCommand,
    ContentOperations,
    CreateProject,
    EnsureDefaultProject,
    ForgetProject,
    LinkImport,
    ReconcileAuthorization,
    ReconcileProjectCreation,
    ReconcileProjectRemoval,
    RecoveryAdmission,
    RevokeRoot,
    requires_postcommit_recovery,
)
from service.content.service.port import ContentService, ProjectRegistry
from service.content.service.provenance import (
    CREATION_RECEIPT_LIMIT,
    PROJECT_CREATION_DIRECTORIES,
    CreationObservation,
    initialize_project_creation,
    observe_project_creations,
    prepare_project_creation,
    verify_project_creation,
    verify_project_creation_record,
)
from service.content.service.roots import ExternalRootService
from service.content.service.space import (
    prepare_project_storage,
    project_database,
    project_version_storage,
)
from service.cutover import (
    LiteratureStartupSchema,
    ProjectPdfSchema,
    cutover_pdf_records,
    cutover_project_pdf_records,
    initialize_pdf_schema,
    inspect_literature_startup,
    inspect_pdf_connection,
    inspect_pdf_rows,
    inspect_project_pdf,
)
from service.identity.api.routes import register_auth
from service.identity.persistence.handoff import HandoffClaimStore, HandoffSchema
from service.identity.persistence.store import decode_auth_data
from service.identity.service.policy import (
    AUTH_MODE_AUTO,
    AuthPolicy,
    enabled_for_mode,
    install_policy,
)
from service.inference.transport import InferenceProvider
from service.invocation.api.routes import register_invocation_routes
from service.invocation.service.runtime import InvocationService
from service.invocation.service.skills import InvocationSkillResolver
from service.literature.api.acquire import register_acquire_routes
from service.literature.api.analysis import register_analysis_routes
from service.literature.api.catalogue import register_global_routes
from service.literature.api.curation import register_curation_bridge
from service.literature.api.delivery import register_delivery_routes
from service.literature.api.downloads import register_download_routes
from service.literature.api.evidence import register_card_bridge
from service.literature.api.gate import FulltextGate
from service.literature.api.papermeta import register_papermeta_routes
from service.literature.api.reading import register_reading_routes
from service.literature.api.receipt import register_receipt_routes
from service.literature.api.result import register_result_routes
from service.literature.api.review import register_literature_review_routes
from service.literature.api.search import register_literature_search_routes
from service.literature.api.taxonomy import register_taxonomy_bridge
from service.literature.domain.delivery import (
    DELIVERY_CARD,
    delivery_card_slot,
    validate_delivery_card,
)
from service.literature.persistence.downloads import prune_download_results
from service.literature.persistence.search import LiteratureSearchService
from service.literature.persistence.store import LiteratureRepository
from service.literature.persistence.store import classify_schema as inspect_literature_connection
from service.literature.persistence.store import connect as connect_literature
from service.literature.persistence.store import initialize_schema as initialize_literature_schema
from service.literature.service.attachment import LiteratureAttachmentContent
from service.literature.service.cards import (
    LITERATURE_REFERENCES_CARD,
    validate_references_card,
)
from service.literature.service.context import LiteratureContextProvider
from service.literature.service.delivery import DeliveryService
from service.literature.service.downloads import (
    DOWNLOADS_CARD,
    download_card_slot,
    validate_download_card,
)
from service.literature.service.evidence import LiteratureEvidenceService
from service.literature.service.fulltexts import ManagedFulltexts
from service.literature.service.pdf import LiteraturePdf
from service.literature.service.queries import LiteratureQueries
from service.literature.service.records import AttachmentRecords
from service.literature.service.reference import LiteratureReferenceService
from service.literature.service.result import SEARCH_CARD, search_card_slot, validate_search_card
from service.literature.service.review import REVIEW_CARD, validate_review_card
from service.literature.service.status import ResultStatusService
from service.literature.service.taxonomy import LiteratureTaxonomyService
from service.paths import (
    AUTH_FILE,
    CONFIG_PATH,
    CONTENT_DB,
    DEFAULT_WORKSPACE_ENV,
    DESKTOP_HANDOFF_DB,
    MODEL_CREDENTIALS_DB,
    PROJECT_CREATION_RECEIPT_FILENAME,
    PROJECT_DB_RELATIVE,
    RESOURCE_IMPORTS_DB,
    SCHOLARSEED_HOME,
    SERVE_SETTINGS_FILE,
    SERVICE_BRIDGE_DIR,
    SERVICE_DIR,
    SERVICE_LITERATURE_DATABASE,
    SERVICE_PROJECTS_FILE,
    SESSION_CATALOG_DB,
    SESSION_RUNTIME_DIR,
    coordination_root,
)
from service.persistence.documents import DocumentSource
from service.persistence.preview import (
    MAX_LAYOUT_BYTES,
    MAX_LAYOUT_DATABASES,
    DatabasePreview,
    LayoutCheck,
    SchemaOwner,
    decode_previews,
    observe_recovered_database,
    preview_database,
    projected_database,
    require_candidate_layout,
)
from service.persistence.project import transaction
from service.persistence.rows import rows_digest
from service.platform.activation import WorkbenchAdmission
from service.platform.activity import Activities, ActivityDomain, MaintenanceIncomplete
from service.platform.bridge import (
    ArtifactPublisher,
    DisplayCardPublisher,
    SkillCaller,
)
from service.platform.citations import PDF_INDEX_STATE
from service.platform.content import ArtifactScopeKind, AssetKind, ProjectRef, RootKind
from service.platform.context import (
    AssistantContextProvider,
    AssistantTurnSnapshot,
    ContextRefKind,
    SearchScope,
)
from service.platform.domains import (
    DataInspection,
    DomainChangedError,
    DomainOwner,
    DomainReleaseError,
    Domains,
    created_directory,
    ensure_directories,
    inspect_directories,
)
from service.platform.excerpts import ExcerptSourceKind
from service.platform.guardian import from_environment as native_guardian
from service.platform.local import local_listener
from service.platform.reclamation import reclaim_coordination
from service.platform.search import register_search_routes
from service.platform.shutdown import ShutdownStage
from service.platform.startup import (
    acquire_startup_domains,
    prepare_private_root,
    prepare_startup_domains,
    startup_phase,
)
from service.platform.storage import (
    DIRECTORY_EXISTS_ERROR,
    WINDOWS_PATH_PREFIX,
    DarwinDirectoryNative,
    DirectoryRole,
    InstallationBinding,
    LeaseError,
    LinuxDirectoryNative,
    WindowsDirectoryNative,
    canonical_root,
    grant_current_user_directory_access,
    open_directory,
    prepare_private_directory,
    restrict_private_directory,
)
from service.platform.vocabulary import BRIDGE_ROUTE_PREFIX
from service.platform.web import mount_renderer, register_cross_origin_isolation
from service.resources.api.ai import register_resource_ai_routes
from service.resources.api.bridge import register_resource_bridge
from service.resources.api.jobs import register_resource_import_routes
from service.resources.api.routes import register_resource_routes
from service.resources.api.search import register_resource_search_routes
from service.resources.api.settings import register_version_setting_routes
from service.resources.api.versions import CONTENT_REVISION_HEADER, register_version_routes
from service.resources.domain.jobs import ImportJob, ImportSourceStatus
from service.resources.persistence.catalog import (
    ResourceAgentImportCatalog,
    ResourceCatalogSchema,
    ResourceExcerptCatalog,
    ResourceWebSourceCatalog,
    initialize_catalog_schema,
    initialize_resource_catalog,
    inspect_catalog_connection,
    inspect_catalog_rows,
    inspect_resource_catalog,
)
from service.resources.persistence.inspection import MAX_OBJECTS as MAX_CAS_OBJECTS
from service.resources.persistence.inspection import MAX_SECONDS as MAX_CAS_SECONDS
from service.resources.persistence.inspection import MAX_TOTAL_BYTES as MAX_CAS_BYTES
from service.resources.persistence.inspection import (
    CasPublication,
    CasPublicationPreview,
    CasPublicationSet,
    CasStorageInspection,
    inspect_cas_storage,
)
from service.resources.persistence.jobs import ImportJobStore, ImportSchema
from service.resources.persistence.version import VersionSchema, VersionStore
from service.resources.service.activation import ResourceActivation
from service.resources.service.ai import ResourceAIService
from service.resources.service.batch import ResourceReviewBatchService
from service.resources.service.delivery import ResourceDeliveryService
from service.resources.service.excerpts import ResourceExcerptService
from service.resources.service.fallback import ResourceSearchFallback
from service.resources.service.fetcher import HtmlFetcher
from service.resources.service.history import ResourceVersionService
from service.resources.service.importer import (
    ResourceImportService as ResourceImportDecisionService,
)
from service.resources.service.importer import (
    WebImporter,
)
from service.resources.service.inspection import ResourceProjection
from service.resources.service.jobs import ResourceImportService as ResourceImportJobService
from service.resources.service.migration import ResourceReviewMigration
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.queries import ResourceQueries
from service.resources.service.recovery import ResourceRecoveryService
from service.resources.service.retention import ResourceRetentionService
from service.resources.service.search import OfficialSearchClient, ResourceSearchService
from service.resources.service.writer import ResourceWriter
from service.settings.config import (
    CONFIG_SEED_ENV,
    ConfigSeed,
    config_seed_source,
    decode_config_object,
    decode_config_seed,
    publish_config_seed,
)
from service.settings.connections import ModelProfileStore, profile_store_path
from service.settings.credentials import CredentialSchema, ModelCredentialStore
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
_startup_log = logging.getLogger(__name__)

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
PACKAGED_SERVICE_PARTS = ("current", "resources", "backend", "pylibs", "service", "bootstrap.py")
PACKAGED_SEED_PARTS = ("current", "resources", "defaults", "config.json")
PACKAGED_PYTHON_PARTS = ("runtime", "python")
PACKAGED_PYTHON_ENTRY = ("python", "python.exe")


def _packaged_windows_path(value: str) -> PureWindowsPath | None:
    value = value.removeprefix(WINDOWS_PATH_PREFIX).replace("/", "\\")
    if (
        len(value) < 3
        or not value[0].isascii()
        or not value[0].isalpha()
        or value[1:3] != ":\\"
        or "\0" in value
    ):
        return None
    if any(
        not part or part in {".", ".."} or ":" in part or part.endswith((".", " "))
        for part in value[3:].split("\\")
    ):
        return None
    return PureWindowsPath(value)


def _packaged_config_installation() -> InstallationBinding | None:
    if sys.platform != "win32":
        return None
    module = _packaged_windows_path(__file__)
    executable = _packaged_windows_path(sys.executable)
    source = _packaged_windows_path(os.environ.get(CONFIG_SEED_ENV, "").strip())
    if module is None or executable is None or source is None:
        return None
    if len(module.parts) <= len(PACKAGED_SERVICE_PARTS) or PureWindowsPath(
        *module.parts[-len(PACKAGED_SERVICE_PARTS) :]
    ) != PureWindowsPath(*PACKAGED_SERVICE_PARTS):
        return None
    root = module.parents[len(PACKAGED_SERVICE_PARTS) - 1]
    if root == root.parent or source != root.joinpath(*PACKAGED_SEED_PARTS):
        return None
    try:
        relative = executable.relative_to(root)
    except ValueError:
        return None
    if (
        len(relative.parts) != len(PACKAGED_PYTHON_PARTS) + 1 + len(PACKAGED_PYTHON_ENTRY)
        or PureWindowsPath(*relative.parts[: len(PACKAGED_PYTHON_PARTS)])
        != PureWindowsPath(*PACKAGED_PYTHON_PARTS)
        or PureWindowsPath(*relative.parts[-len(PACKAGED_PYTHON_ENTRY) :])
        != PureWindowsPath(*PACKAGED_PYTHON_ENTRY)
    ):
        return None
    return InstallationBinding(str(root), PACKAGED_SEED_PARTS[:-1])


def _windows_directory_native(guardian: object | None) -> WindowsDirectoryNative:
    installation = _packaged_config_installation()
    if installation is None:
        return WindowsDirectoryNative()
    if guardian is not None:
        raise LeaseError("ERR_LEASE_UNSUPPORTED")
    return WindowsDirectoryNative(installation=installation)


def _product_enabled(product: str, domain: str) -> bool:
    return domain in PRODUCT_DOMAIN_COMPOSITION.get(product, DEFAULT_PRODUCT_DOMAINS)


def resolve_workspace_root(
    cwd: Path | None,
    settings: SettingsService | None = None,
    *,
    configured_root: str | None = None,
) -> Path:
    """工作区根的唯一解析处；约束见 docs/features/resources.md 的项目根授权边界。

    取值顺序: 产品设置 `workspace_root` > `SCHOLARSEED_DEFAULT_WORKSPACE` >
    调用方注入 (桌面端把 `app.getPath('documents')/书深` 传进来) > 进程 cwd。

    只有组合根做这件事: 之前 `cli/serve.py` 与本文件各算一次, 两处一旦漂移,
    日志里打印的工作区与 content 实际用的根就不是同一个目录。
    """

    if settings is not None and configured_root is not None:
        raise ValueError("workspace resolution requires one settings source")
    configured = (
        (settings or SettingsService()).workspace_root()
        if configured_root is None
        else configured_root
    )
    if configured:
        return Path(configured).expanduser().resolve()
    injected = os.environ.get(DEFAULT_WORKSPACE_ENV, "").strip()
    if injected:
        return Path(injected).expanduser().resolve()
    return Path(cwd or Path.cwd()).expanduser().resolve()


DIRECTORY_DRAIN_TIMEOUT_SECONDS = 60.0
DIRECTORY_DRAIN_POLL_SECONDS = 0.05
SCHEDULED_DRAIN_TIMEOUT_SECONDS = 0.25
# Electron may still be synchronously appending the provider exit log.
DIRECTORY_LEASE_WAIT_SECONDS = 2.0
DIRECTORY_PREPARATION_ATTEMPTS = 8


class ProjectFailure(StrEnum):
    DIRECTORY_UNAVAILABLE = "project_directory_unavailable"
    PERMISSION_DENIED = "project_permission_denied"
    STORAGE_INVALID = "project_storage_invalid"
    INSPECTION_FAILED = "project_inspection_failed"
    MOUNT_UNAVAILABLE = "project_mount_unavailable"


@dataclass(frozen=True)
class ProjectStartupSource:
    root: Path
    database: Path | None
    pdf: ProjectPdfSchema | None
    versions: VersionSchema | None = None
    resources: ResourceCatalogSchema | None = None


@dataclass(frozen=True)
class ProjectStorageSources:
    """Unregistered or registered project storage, without catalog mutation."""

    roots: tuple[str, ...]
    projects: tuple[ProjectStartupSource, ...]
    failures: tuple[tuple[Path, str], ...] = ()


@dataclass(frozen=True)
class UnavailableProject:
    """A retained registration, never permission to access its missing locator."""

    project_id: str
    root: Path
    anchor: str
    remaining: tuple[str, ...]
    anchor_identity: str | None
    anchor_rejected: bool = False
    reason: str = ProjectFailure.DIRECTORY_UNAVAILABLE


def inspect_project_locations(
    domains: DataInspection, projects: tuple[tuple[str, Path], ...]
) -> tuple[tuple[Path, ...], tuple[UnavailableProject, ...], tuple[str, ...]]:
    present: set[Path] = set()
    unavailable = []
    roots: set[str] = set()
    for project_id, root in projects:
        if domains.selected(str(root)):
            present.add(root)
            roots.add(str(root))
            continue
        hint = domains.locator_hint(str(root), role=DirectoryRole.PROJECT)
        if hint.anchor_rejected:
            unavailable.append(
                UnavailableProject(
                    project_id,
                    root,
                    hint.anchor,
                    hint.remaining,
                    None,
                    True,
                    getattr(hint, "failure_code", "") or ProjectFailure.DIRECTORY_UNAVAILABLE,
                )
            )
            continue
        roots.add(hint.anchor)
        if not hint.remaining:
            present.add(root)
            continue
        identity = None
        if domains.selected(hint.anchor):
            if domains.entry_kind(hint.anchor, hint.remaining[0]) is not None:
                raise DomainChangedError("missing project locator changed during discovery")
            identity = domains.directory_identity(hint.anchor)
        unavailable.append(
            UnavailableProject(project_id, root, hint.anchor, hint.remaining, identity)
        )
    return tuple(sorted(present)), tuple(unavailable), tuple(sorted(roots))


def project_inspection_failure(error: Exception) -> str | None:
    """Classify a project-local failure without hiding uncertain native release."""
    if isinstance(error, (DomainReleaseError, DomainChangedError, BaseExceptionGroup)):
        return None
    if isinstance(error, LeaseError) and error.code in {
        "ERR_LEASE_RELEASE",
        "ERR_LEASE_CLOSED",
        "ERR_LEASE_REENTRANT",
    }:
        return None
    if isinstance(error, PermissionError) or getattr(error, "code", None) == "ERR_LEASE_PERMISSION":
        return ProjectFailure.PERMISSION_DENIED
    if isinstance(error, FileNotFoundError):
        return ProjectFailure.DIRECTORY_UNAVAILABLE
    if isinstance(error, sqlite3.DatabaseError):
        return ProjectFailure.STORAGE_INVALID
    return ProjectFailure.INSPECTION_FAILED


def inspect_project_sources(
    domains: DataInspection, project_roots: tuple[Path, ...], *, isolate: bool = False
) -> ProjectStorageSources:
    """Inspect each project's storage independently under retained qualifications.

    An ordinary startup retains failed registrations instead of approving their
    storage. Update projection uses the strict default and cannot omit failures.
    Native qualification/cleanup uncertainty always propagates.
    """
    with domains.batch_inspection() as reader:
        return _inspect_project_sources(reader, project_roots, isolate=isolate)


def _inspect_project_sources(
    domains: DataInspection, project_roots: tuple[Path, ...], *, isolate: bool
) -> ProjectStorageSources:
    if any(not root.is_absolute() or ".." in root.parts for root in project_roots):
        raise ValueError("project inspection requires absolute directory roots")
    roots: set[str] = set()
    projects: list[ProjectStartupSource] = []
    failures: list[tuple[Path, str]] = []
    for root in sorted(project_roots):
        project_roots_found = {str(root)}
        source = ProjectStartupSource(root, None, None)
        failure = None
        if domains.selected(str(root)):
            try:
                with domains.project_inspection((str(root),)) as reader:
                    with inspect_directories(reader, (str(root),)):
                        with project_database(root) as database:
                            if database is None:
                                source = ProjectStartupSource(
                                    root, None, ProjectPdfSchema(False, False, ())
                                )
                            else:
                                project_roots_found.add(str(database.parent))
                                source = ProjectStartupSource(root, database, None)
                if source.database is not None:
                    database = source.database
                    hint = domains.locator_hint(str(database.parent), role=DirectoryRole.PROJECT)
                    if hint.anchor_rejected:
                        raise PermissionError("project storage directory is unavailable")
                    if domains.selected(str(database.parent)):
                        selected = tuple(dict.fromkeys((str(root), str(database.parent))))
                        with domains.project_inspection(selected) as reader:
                            with inspect_directories(reader, selected):
                                with project_database(root) as checked:
                                    if checked != database:
                                        raise DomainChangedError(
                                            "project database parent changed during discovery"
                                        )
                                    source = ProjectStartupSource(
                                        root,
                                        database,
                                        inspect_project_pdf(database),
                                        VersionStore.inspect_schema(database),
                                        inspect_resource_catalog(database),
                                    )
            except Exception as error:
                failure = project_inspection_failure(error) if isolate else None
                if failure is None:
                    raise
                _log.warning(
                    "project_inspection_failed path=%s reason=%s error_type=%s",
                    root,
                    failure,
                    type(error).__name__,
                )
        if failure is not None:
            failures.append((root, failure))
        else:
            roots.update(project_roots_found)
            projects.append(source)
    return ProjectStorageSources(tuple(sorted(roots)), tuple(projects), tuple(failures))


class StartupSeed:
    """One composition owner's frozen optional seed source, never a global choice."""

    def __init__(self) -> None:
        self._selected = False
        self._source: Path | None = None
        self.project_failures: dict[Path, str] = {}

    def read(
        self, domains: DataInspection, *, target_present: bool
    ) -> tuple[Path | None, bytes | None, ConfigSeed | None]:
        if not self._selected:
            self._source = config_seed_source(target_present=target_present)
            self._selected = True
        source = self._source
        if source is None or not domains.selected(str(source.parent)):
            return source, None, None
        data = domains.read(str(source.parent), source.name, 1024 * 1024)
        if data is None:
            raise RuntimeError(f"default config does not exist: {source}")
        seed = None if target_present else decode_config_seed(data, source=source)
        return source, data, seed


@dataclass(frozen=True)
class StartupSources:
    """Product source snapshot to retain with the acquired directory set."""

    roots: tuple[str, ...]
    workspace: Path
    legacy_seeds: tuple[tuple[Path, str], ...]
    catalog: CatalogRoots
    sessions: SessionSchema
    events: EventSchema
    artifacts: ArtifactSchema
    citations: CitationSchema
    invocations: InvocationSchema
    assistant: AssistantSchema
    fulltext_authorizations: AuthorizationSchema
    imports: ImportSchema
    handoff: HandoffSchema
    credentials: CredentialSchema
    literature: LiteratureStartupSchema
    project_storage: tuple[ProjectStartupSource, ...]
    trace: tuple[TraceSource, ...] | None
    settings_data: bytes | None
    projects_data: bytes | None
    pending_legacy_seeds: tuple[tuple[Path, str], ...] | None
    config_data: bytes | None
    config_seed: ConfigSeed | None
    profiles_data: bytes | None
    auth_data: bytes | None
    config_seed_source: Path | None
    config_seed_data: bytes | None = field(repr=False)
    trace_projection: TraceProjection | None
    trace_formats: TraceFormats | None
    trace_history: HistoryInspection | None
    creation_observations: tuple[CreationObservation, ...] | None = None
    provider_storage: tuple[StorageRoot, ...] = ()
    provider_sources: tuple[StorageSource, ...] = ()
    unavailable_projects: tuple[UnavailableProject, ...] = ()
    session_journal: journal.JournalSchema | None = None
    project_directories: tuple[str, ...] = ()
    isolated_projects: bool = False
    projects_deferred: bool = False

    @property
    def root_roles(self) -> dict[str, DirectoryRole]:
        return {
            root: (
                DirectoryRole.PROJECT if root in self.project_directories else DirectoryRole.PRIVATE
            )
            for root in self.roots
        }

    def project_roles(self, roots: Iterable[str]) -> dict[str, DirectoryRole]:
        """New project roots cannot downgrade a capability already owned by core storage."""
        existing = self.root_roles
        return {root: existing.get(root, DirectoryRole.PROJECT) for root in roots}

    def extended_project_directories(self, roots: Iterable[str]) -> tuple[str, ...]:
        return tuple(
            sorted(
                set(self.project_directories)
                | {
                    root
                    for root, role in self.project_roles(roots).items()
                    if role is DirectoryRole.PROJECT
                }
            )
        )

    @property
    def project_root_owners(self) -> dict[str, tuple[Path, ...]]:
        """Attribute retained project capabilities without weakening shared core roots."""
        owners: dict[str, set[Path]] = {root: set() for root in self.project_directories}

        def add(path: str, project: Path) -> None:
            if path in owners:
                owners[path].add(project)

        add(str(self.workspace), self.workspace)
        for project in self.project_storage:
            add(str(project.root), project.root)
            if project.database is not None:
                add(str(project.database.parent), project.root)
        for project in self.unavailable_projects:
            add(project.anchor, project.root)
        projects = dict(self.catalog.projects)
        for _, project_id, path, kind in self.catalog.external:
            if project_id in projects:
                add(str(path.parent if kind is AssetKind.FILE else path), projects[project_id])
        return {path: tuple(sorted(projects)) for path, projects in owners.items()}


def require_qualified_project_locations(snapshot: StartupSources) -> None:
    if any(
        project.anchor_identity is None and not project.anchor_rejected
        for project in snapshot.unavailable_projects
    ):
        raise RuntimeError("unavailable project locators have not been qualified")


def require_available_project_recovery(snapshot: StartupSources) -> None:
    """Cold startup/inspection cannot recover operations through absent projects.

    Runtime sampling remains a complete fact snapshot; its owned operations use
    their own target qualifications and the frozen registry's business gates.
    """
    if (
        not snapshot.isolated_projects
        and snapshot.unavailable_projects
        and (
            snapshot.catalog.has_pending_operations
            or snapshot.catalog.has_receipts
            or snapshot.catalog.has_authorization_reconciliations
            or snapshot.catalog.has_project_removals
            or snapshot.catalog.has_project_creations
        )
    ):
        raise RuntimeError("unavailable projects cannot admit pending project recovery")


def startup_creation_roots(
    runtime_discovery: RuntimeDiscovery,
    local_bridge_root: Path | None = None,
    *,
    provider_storage: tuple[StorageRoot, ...] | None = None,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Directory-creation policy shared by normal startup and native preparation.

    Existing-only providers remain mandatory even when another owned root has
    the same spelling. Registered projects and external assets are never added
    to the creation set just because they were found during source discovery.
    """
    provider_storage = (
        runtime_discovery.storage_roots if provider_storage is None else provider_storage
    )
    owned = {
        SCHOLARSEED_HOME.absolute(),
        SERVICE_DIR.absolute(),
        (local_bridge_root or SERVICE_BRIDGE_DIR).absolute(),
        TRACE_PATHS.home,
        *(root.path for root in provider_storage if root.create),
    }
    if TRACE_PATHS.ledger_root is not None:
        owned.add(TRACE_PATHS.ledger_root)
    existing = {root.path for root in provider_storage if not root.create}
    return tuple(sorted(str(path) for path in owned)), tuple(sorted(str(path) for path in existing))


def inspect_startup_sources(
    domains: DataInspection,
    cwd: Path | None,
    runtime_discovery: RuntimeDiscovery,
    local_bridge_root: Path | None = None,
    *,
    seed: StartupSeed,
    isolate_projects: bool = False,
    defer_projects: bool = False,
) -> StartupSources:
    """Read root sources under held metadata-directory qualifications.

    This snapshot is not compatibility approval. The actual startup owner must
    retain the final snapshot and its occupied domains through composition and
    validate every data owner before admission; no root is silently omitted.
    """
    with domains.batch_inspection() as reader:
        return _inspect_startup_sources(
            reader,
            cwd,
            runtime_discovery,
            local_bridge_root,
            seed=seed,
            isolate_projects=isolate_projects,
            defer_projects=defer_projects,
        )


def _inspect_startup_sources(
    domains: DataInspection,
    cwd: Path | None,
    runtime_discovery: RuntimeDiscovery,
    local_bridge_root: Path | None,
    *,
    seed: StartupSeed,
    isolate_projects: bool = False,
    defer_projects: bool = False,
) -> StartupSources:
    with startup_phase("source.configuration"):
        service = str(SERVICE_DIR.absolute())
        config_data = domains.read(str(SCHOLARSEED_HOME.absolute()), CONFIG_PATH.name, 1024 * 1024)
        decode_config_object(config_data)
        profiles_data = domains.read(
            str(SCHOLARSEED_HOME.absolute()), profile_store_path().name, 1024 * 1024
        )
        ModelProfileStore.decode(profiles_data)
        auth_data = domains.read(str(SCHOLARSEED_HOME.absolute()), AUTH_FILE.name, 1024 * 1024)
        decode_auth_data(auth_data)
        seed_source, seed_data, config_seed = seed.read(
            domains, target_present=config_data is not None
        )
        settings_data = domains.read(service, SERVE_SETTINGS_FILE.name, 1024 * 1024)
        projects_data = domains.read(service, SERVICE_PROJECTS_FILE.name, 1024 * 1024)
        settings = SettingsService.decode(settings_data)
        registry = ChatProjectRegistry.decode(projects_data)
        workspace = resolve_workspace_root(
            cwd, configured_root=SettingsService.workspace_from(settings)
        )
        legacy = tuple(
            (Path(row["path"].strip()), row.get("name", "")) for row in registry[PROJECTS_KEY]
        )
    with startup_phase("source.user_databases"):
        with domains.inspection(service):
            catalog = ContentCatalog.read_roots(CONTENT_DB)
            # Each owner opens its own WAL snapshot. Directory qualification does
            # not make these separate connections one database transaction.
            session_journal = journal.inspect_schema(SESSION_CATALOG_DB)
            sessions = SessionCatalogStore.inspect_schema(SESSION_CATALOG_DB)
            events = ProductEventStore.inspect_schema(SESSION_CATALOG_DB)
            artifacts = SessionArtifactStore.inspect_schema(SESSION_CATALOG_DB)
            citations = CitationStore.inspect_schema(SESSION_CATALOG_DB)
            invocations = AssistantInvocationStore.inspect_schema(SESSION_CATALOG_DB)
            assistant = AssistantStore.inspect_schema(SESSION_CATALOG_DB)
            fulltext_authorizations = FulltextAuthorizer.inspect_schema(SESSION_CATALOG_DB)
            imports = ImportJobStore.inspect_schema(RESOURCE_IMPORTS_DB)
            handoff = HandoffClaimStore.inspect_schema(DESKTOP_HANDOFF_DB)
            credentials = ModelCredentialStore.inspect_schema(MODEL_CREDENTIALS_DB)
            literature = inspect_literature_startup(SERVICE_LITERATURE_DATABASE)
    with startup_phase("source.provider_storage"):
        provider_inventory = runtime_discovery.inspect_storage(domains)
        provider_storage = provider_inventory.roots
    core_roots = {
        SCHOLARSEED_HOME.absolute(),
        SERVICE_DIR.absolute(),
        TRACE_PATHS.home,
        (local_bridge_root or SERVICE_BRIDGE_DIR).absolute(),
        *(root.path for root in provider_storage),
        *((TRACE_PATHS.ledger_root,) if TRACE_PATHS.ledger_root is not None else ()),
        *((seed_source.parent,) if seed_source is not None else ()),
    }
    if defer_projects:
        roots = set(core_roots)
        unavailable_projects: tuple[UnavailableProject, ...] = ()
        unavailable_roots = set()
        project_qualification_roots = ()
        external_roots = set()
        project_sources = ProjectStorageSources((), ())
    else:
        with startup_phase("source.project_locations", projects=len(catalog.projects)):
            present_projects, unavailable_projects, project_qualification_roots = (
                inspect_project_locations(
                    domains,
                    tuple(
                        dict.fromkeys(
                            (
                                *catalog.projects,
                                *(
                                    ("", path)
                                    for path, _ in legacy
                                    if path not in {root for _, root in catalog.projects}
                                ),
                            )
                        )
                    ),
                )
            )
        if isolate_projects and seed.project_failures:
            ids = {root: project_id for project_id, root in catalog.projects}
            unavailable_projects = (
                *(row for row in unavailable_projects if row.root not in seed.project_failures),
                *(
                    UnavailableProject(ids.get(root, ""), root, str(root), (), None, True, reason)
                    for root, reason in seed.project_failures.items()
                    if root in ids or root in {path for path, _ in legacy} or root == workspace
                ),
            )
        unavailable_roots = {project.root for project in unavailable_projects}
        roots = {
            SCHOLARSEED_HOME.absolute(),
            SERVICE_DIR.absolute(),
            workspace,
            TRACE_PATHS.home,
            (local_bridge_root or SERVICE_BRIDGE_DIR).absolute(),
            *(root.path for root in provider_storage),
            *(path for path, _ in legacy if path not in unavailable_roots),
            *(
                Path(path)
                for path in project_qualification_roots
                if Path(path) not in unavailable_roots
            ),
            *(
                path.parent if kind is AssetKind.FILE else path
                for _, _, path, kind in catalog.external
            ),
        }
        if TRACE_PATHS.ledger_root is not None:
            roots.add(TRACE_PATHS.ledger_root)
        if seed_source is not None:
            roots.add(seed_source.parent)
        if workspace in unavailable_roots and workspace not in core_roots:
            roots.discard(workspace)
        # Legacy bytes and catalog inventory remain complete. Only registrations
        # proved unavailable lose business IO, not their identity or configuration.
        project_roots = (set(present_projects) - unavailable_roots) | {
            path for path, _ in legacy if path not in unavailable_roots
        }
        with startup_phase("source.project_storage", projects=len(project_roots)):
            project_sources = _inspect_project_sources(
                domains, tuple(sorted(project_roots)), isolate=isolate_projects
            )
        if project_sources.failures:
            seed.project_failures.update(project_sources.failures)
            ids = {root: project_id for project_id, root in catalog.projects}
            unavailable_projects = (
                *unavailable_projects,
                *(
                    UnavailableProject(ids.get(root, ""), root, str(root), (), None, True, reason)
                    for root, reason in project_sources.failures
                ),
            )
            unavailable_roots.update(root for root, _ in project_sources.failures)
            roots.difference_update(unavailable_roots)
        # External mounts belong to their project, not to application startup. An
        # unavailable mount blocks that project while preserving the catalog row.
        external_roots: set[str] = set()
        project_paths = {project_id: root for project_id, root in catalog.projects}
        for _, project_id, path, kind in catalog.external:
            project_root = project_paths.get(project_id)
            if project_root in unavailable_roots:
                roots.discard(path.parent if kind is AssetKind.FILE else path)
                continue
            target = path.parent if kind is AssetKind.FILE else path
            hint = domains.locator_hint(str(target), role=DirectoryRole.PROJECT)
            if isolate_projects and (hint.anchor_rejected or hint.remaining):
                if project_root is not None:
                    unavailable_projects = (
                        *unavailable_projects,
                        UnavailableProject(
                            project_id,
                            project_root,
                            str(target),
                            (),
                            None,
                            True,
                            ProjectFailure.MOUNT_UNAVAILABLE,
                        ),
                    )
                    unavailable_roots.add(project_root)
                    seed.project_failures[project_root] = ProjectFailure.MOUNT_UNAVAILABLE
            else:
                external_roots.add(str(target))
        if unavailable_roots:
            rejected = {str(root) for root in unavailable_roots}
            for _, project_id, path, kind in catalog.external:
                if project_paths.get(project_id) in unavailable_roots:
                    target = str(path.parent if kind is AssetKind.FILE else path)
                    external_roots.discard(target)
                    rejected.add(target)
            for source in project_sources.projects:
                if source.root in unavailable_roots and source.database is not None:
                    rejected.add(str(source.database.parent))
            roots.difference_update(Path(path) for path in rejected)
            project_sources = replace(
                project_sources,
                roots=tuple(path for path in project_sources.roots if path not in rejected),
                projects=tuple(
                    source
                    for source in project_sources.projects
                    if source.root not in unavailable_roots
                ),
            )
        # Project isolation removes business storage, but an unavailable
        # locator still needs its ancestor selected to prove absence. That
        # ancestor may also be a failed project's root or external mount.
        # Qualification failures are attributed through project_root_owners;
        # the next observation then retains an explicitly rejected locator.
        roots.update(
            Path(project.anchor) for project in unavailable_projects if not project.anchor_rejected
        )
    roots.update(core_roots)
    with startup_phase("source.trace"):
        trace_sources = inspect_trace_startup(domains, TRACE_PATHS)
    roots.update(Path(root) for root in trace_sources.roots)
    roots.update(Path(root) for root in project_sources.roots)
    pending_legacy = None
    available_legacy = (
        ()
        if defer_projects
        else tuple(entry for entry in legacy if entry[0] not in unavailable_roots)
    )
    with startup_phase("source.legacy", projects=len(available_legacy)):
        if not defer_projects and all(domains.selected(str(path)) for path, _ in available_legacy):
            with domains.inspection(service):
                pending_legacy = ProjectRegistry.pending_legacy_seeds(
                    available_legacy, tuple(path for _, path in catalog.projects)
                )
    return StartupSources(
        tuple(sorted(str(path) for path in roots)),
        workspace,
        legacy,
        catalog,
        sessions,
        events,
        artifacts,
        citations,
        invocations,
        assistant,
        fulltext_authorizations,
        imports,
        handoff,
        credentials,
        literature,
        project_sources.projects,
        trace_sources.files,
        settings_data,
        projects_data,
        pending_legacy,
        config_data,
        config_seed,
        profiles_data,
        auth_data,
        seed_source,
        seed_data,
        trace_sources.projection,
        trace_sources.formats,
        trace_sources.history,
        provider_storage=provider_storage,
        provider_sources=provider_inventory.sources,
        unavailable_projects=unavailable_projects,
        session_journal=session_journal,
        project_directories=tuple(
            sorted(
                (
                    set(project_sources.roots)
                    | external_roots
                    | {str(workspace)}
                    | set(project_qualification_roots)
                )
                & {str(root) for root in roots}
                - {
                    str(SCHOLARSEED_HOME.absolute()),
                    str(SERVICE_DIR.absolute()),
                    str(TRACE_PATHS.home),
                    str((local_bridge_root or SERVICE_BRIDGE_DIR).absolute()),
                    *(str(root.path) for root in provider_storage),
                    *trace_sources.roots,
                    *((str(seed_source.parent),) if seed_source is not None else ()),
                }
            )
        ),
        isolated_projects=isolate_projects,
        projects_deferred=defer_projects,
    )


def inspect_startup_creation_sources(native, domains: DataInspection, snapshot: StartupSources):
    plans = snapshot.catalog.project_creation_plans
    if bool(plans) != snapshot.catalog.has_project_creations:
        raise DomainChangedError("project creation inventory is incomplete")
    observed = observe_project_creations(native, domains, plans, snapshot.workspace)
    verified = tuple(row.root for row in observed if row.phase == "verified")
    storage = inspect_project_sources(domains, verified)
    projects = {entry.root: entry for entry in snapshot.project_storage}
    projects.update((entry.root, entry) for entry in storage.projects)
    roots = set(snapshot.roots) | set(storage.roots)
    roots.update(root for row in observed for root in row.roots)
    return (
        replace(
            snapshot,
            roots=tuple(sorted(roots)),
            project_storage=tuple(projects[root] for root in sorted(projects)),
            creation_observations=observed,
            project_directories=tuple(
                sorted(set(snapshot.project_directories) | (roots - set(snapshot.roots)))
            ),
        ),
        observed,
    )


@dataclass(frozen=True)
class ProjectCreationRecovery:
    creation: ProjectCreation
    observation: CreationObservation
    result: ProjectRef | None


def startup_creation_recovery(
    domains: DataInspection, snapshot: StartupSources
) -> tuple[ProjectCreationRecovery, ...] | None:
    """Qualify existing creation outcomes before projecting their catalog writes.

    None is an incomplete plan, never an empty or successful recovery. A missing
    project still needs exclusive native creation and a new receipt; inspection
    cannot manufacture its future directory identity. Row export rejects that
    case until the creation plan is complete.
    """
    plans = snapshot.catalog.project_creation_plans
    if bool(plans) != snapshot.catalog.has_project_creations:
        raise DomainChangedError("project creation inventory is incomplete")
    if not plans:
        return ()
    observed = snapshot.creation_observations
    if observed is None:
        return None
    if tuple(row.operation for row in observed) != tuple(row.operation_id for row in plans):
        raise DomainChangedError("project creation observations do not match inventory")
    if any(row.phase in ("absent", "unselected") for row in observed):
        return None
    result = []
    for creation, observation in zip(plans, observed, strict=True):
        root = Path(creation.plan.dir_root)
        if observation.root != root or root.parent != snapshot.workspace:
            raise DomainChangedError("project creation root changed")
        if observation.phase == "lost":
            if (
                creation.directory_identity is None
                or observation.identity is not None
                or observation.receipt is not None
                or observation.roots
            ):
                raise DomainChangedError("invalid lost project creation observation")
            if not domains.selected(str(snapshot.workspace)):
                return None
            # Re-observe absence under the occupied parent. Existence checks
            # that swallow permissions/reparse failures cannot prove this case.
            with domains.inspection(str(snapshot.workspace)):
                try:
                    restored = open_directory(snapshot.workspace, (root.name,))
                except FileNotFoundError:
                    pass
                else:
                    restored.close()
                    raise DomainChangedError("lost project creation directory reappeared")
            result.append(ProjectCreationRecovery(creation, observation, None))
            continue
        if observation.phase not in ("verified", "unproven") or not observation.identity:
            raise DomainChangedError("invalid project creation observation")
        roots = (str(snapshot.workspace), str(root), *observation.roots)
        if any(not domains.selected(path) for path in roots):
            return None
        if domains.directory_identity(str(root)) != observation.identity:
            raise DomainChangedError("project creation directory was replaced")
        state = str(root / PROJECT_STATE_DIRNAME)
        if state in observation.roots:
            receipt = domains.read(state, PROJECT_CREATION_RECEIPT_FILENAME, CREATION_RECEIPT_LIMIT)
            if receipt != observation.receipt:
                raise DomainChangedError("project creation receipt changed")
        elif observation.receipt is not None or observation.phase == "verified":
            raise DomainChangedError("project creation receipt has no qualified state directory")
        with inspect_directories(domains, roots):
            if observation.phase == "verified":
                verify_project_creation_record(creation, observation.identity, observation.receipt)
                reference = ProjectRegistry.creation_result(creation.plan)
                if not reference.available:
                    raise DomainChangedError("project creation directory disappeared")
            else:
                try:
                    verify_project_creation_record(
                        creation, observation.identity, observation.receipt
                    )
                except ContentError:
                    pass
                else:
                    raise DomainChangedError("project creation failure contradicts receipt")
                reference = None
            result.append(ProjectCreationRecovery(creation, observation, reference))
    return tuple(result)


@contextmanager
def startup_removal_plans(
    domains: DataInspection, snapshot: StartupSources, *, authorizations: bool = False
):
    """Retain all path qualifications used by the real removal eligibility rule.

    None denotes an incomplete discovery pass, never an admitted empty plan.
    The outer native discovery must acquire snapshot.roots and resample it.
    """
    plans = snapshot.catalog.project_removal_plans
    if bool(plans) != snapshot.catalog.has_project_removals:
        raise DomainChangedError("project removal inventory is incomplete")
    authorization_plans = snapshot.catalog.authorization_plans if authorizations else ()
    if (
        authorizations
        and bool(authorization_plans) != snapshot.catalog.has_authorization_reconciliations
    ):
        raise DomainChangedError("authorization inventory is incomplete")
    if not plans and not authorization_plans:
        with domains.inspection(str(SERVICE_DIR.absolute())):
            yield ()
        return
    roots = {
        str(SERVICE_DIR.absolute()),
        str(snapshot.workspace),
        *(str(path) for path, _ in snapshot.legacy_seeds),
        *(row.root for row in plans),
    }
    if authorization_plans:
        # Policy/repository discovery uses every mount of each affected project.
        # Retain the full discovered set instead of inspecting only the root
        # whose authorization happens to be completing.
        roots.update(snapshot.roots)
    if any(not domains.selected(root) for root in roots):
        with domains.inspection(str(SERVICE_DIR.absolute())):
            yield None
        return
    registered = dict(snapshot.catalog.projects)
    with inspect_directories(domains, tuple(roots)):
        for row in plans:
            if registered.get(row.project_id) != Path(row.root):
                raise DomainChangedError("project removal no longer matches registered root")
            ProjectRegistry.validate_forget_root(row.root, snapshot.workspace)
        yield plans


def startup_document_sources(
    snapshot: StartupSources, *, domains: DataInspection | None = None
) -> tuple[DocumentSource, ...]:
    """Use actual startup projectors and readers on already qualified bytes."""
    config = snapshot.config_data
    if snapshot.config_seed is not None:
        if config is not None or snapshot.config_seed.target != CONFIG_PATH:
            raise ValueError("startup config seed target changed")
        config = snapshot.config_seed.payload
    settings = SettingsService.preview_initialization(
        snapshot.settings_data,
        existing_projects=bool(snapshot.catalog.projects or snapshot.legacy_seeds),
    )
    projects = snapshot.projects_data
    if snapshot.catalog.has_project_removals and not requires_postcommit_recovery(
        snapshot.catalog.project_creation_plans
    ):
        if domains is None:
            raise ValueError("project removal document preview requires qualified directories")
        with startup_removal_plans(domains, snapshot) as removals:
            if removals is not None:
                projects = ChatProjectRegistry.preview_removals(
                    projects, tuple(Path(row.root) for row in removals)
                )
    return (
        DocumentSource("config", snapshot.config_data, config, decode_config_object),
        DocumentSource("settings", snapshot.settings_data, settings, SettingsService.decode),
        DocumentSource(
            "profiles", snapshot.profiles_data, snapshot.profiles_data, ModelProfileStore.decode
        ),
        DocumentSource("auth", snapshot.auth_data, snapshot.auth_data, decode_auth_data),
        DocumentSource("projects", snapshot.projects_data, projects, ChatProjectRegistry.decode),
    )


def _startup_sqlite_owners(
    *, recovery_at: float | None = None
) -> tuple[tuple[Path, str, tuple[SchemaOwner, ...]], ...]:
    def initialize_sessions(connection: sqlite3.Connection) -> None:
        SessionCatalogStore.initialize_schema(connection)
        if recovery_at is not None:
            SessionCatalogStore.recover_inflight_rows(
                connection, now=recovery_at, database=SESSION_CATALOG_DB
            )

    session_owners = (
        (
            "sessions",
            SessionCatalogStore,
            lambda connection: SessionCatalogStore.inspect_rows(
                connection, database=SESSION_CATALOG_DB
            ),
        ),
        (
            "events",
            ProductEventStore,
            lambda connection: ProductEventStore.inspect_rows(
                connection, database=SESSION_CATALOG_DB
            ),
        ),
        ("artifacts", SessionArtifactStore, SessionArtifactStore.inspect_rows),
        ("citations", CitationStore, CitationStore.inspect_rows),
        ("invocations", AssistantInvocationStore, AssistantInvocationStore.inspect_rows),
        ("assistant", AssistantStore, AssistantStore.inspect_rows),
        ("fulltext-authorizations", FulltextAuthorizer, FulltextAuthorizer.inspect_rows),
    )
    return (
        (
            SESSION_CATALOG_DB,
            "sessions",
            (
                SchemaOwner(
                    "session-journal",
                    journal.inspect_connection,
                    journal.initialize,
                    lambda connection: journal.inspect_index_rows(connection, SESSION_CATALOG_DB),
                ),
            )
            + tuple(
                SchemaOwner(
                    name,
                    owner.inspect_connection,
                    (
                        initialize_sessions
                        if owner is SessionCatalogStore
                        else owner.initialize_schema
                    ),
                    read_rows,
                )
                for name, owner, read_rows in session_owners
            ),
        ),
        (
            RESOURCE_IMPORTS_DB,
            "imports",
            (
                SchemaOwner(
                    "imports",
                    ImportJobStore.inspect_connection,
                    ImportJobStore.initialize_schema,
                    ImportJobStore.inspect_rows,
                ),
            ),
        ),
        (
            CONTENT_DB,
            "content",
            (
                SchemaOwner(
                    "content",
                    ContentCatalog.inspect_connection,
                    ContentCatalog.initialize_schema,
                    ContentCatalog.inspect_rows,
                ),
            ),
        ),
        (
            DESKTOP_HANDOFF_DB,
            "handoff",
            (
                SchemaOwner(
                    "handoff",
                    HandoffClaimStore.inspect_connection,
                    HandoffClaimStore.initialize_schema,
                    HandoffClaimStore.inspect_rows,
                ),
            ),
        ),
        (
            MODEL_CREDENTIALS_DB,
            "credentials",
            (
                SchemaOwner(
                    "credentials",
                    ModelCredentialStore.inspect_connection,
                    ModelCredentialStore.initialize_schema,
                    ModelCredentialStore.inspect_rows,
                ),
            ),
        ),
        (
            SERVICE_LITERATURE_DATABASE,
            "literature",
            (
                SchemaOwner(
                    "pdf",
                    lambda connection: inspect_pdf_connection(connection, "literature"),
                    lambda connection: initialize_pdf_schema(connection, "literature"),
                    lambda connection: inspect_pdf_rows(connection, "literature"),
                ),
                SchemaOwner(
                    "literature",
                    inspect_literature_connection,
                    initialize_literature_schema,
                    LiteratureRepository.inspect_rows,
                ),
            ),
        ),
    )


def _project_sqlite_owners(
    snapshot: StartupSources,
) -> tuple[tuple[ProjectStartupSource, str, tuple[SchemaOwner, ...]], ...]:
    owners = (
        SchemaOwner(
            "pdf",
            lambda connection: inspect_pdf_connection(connection, "project"),
            lambda connection: initialize_pdf_schema(connection, "project"),
            lambda connection: inspect_pdf_rows(connection, "project"),
        ),
        SchemaOwner(
            "resource-versions",
            VersionStore.inspect_connection,
            VersionStore.initialize_schema,
            VersionStore.inspect_rows,
            triggers=VersionStore.preview_triggers,
        ),
        SchemaOwner(
            "resource-catalog",
            inspect_catalog_connection,
            initialize_catalog_schema,
            inspect_catalog_rows,
        ),
    )
    groups = []
    for entry in snapshot.project_storage:
        if entry.pdf is None:
            # Discovery has not qualified this root or its private directory
            # yet. Its path stays in snapshot.roots for the next full acquire.
            continue
        digest = hashlib.sha256(str(entry.root).encode("utf-8")).digest()
        name = "project." + base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
        groups.append((entry, name, owners))
    return tuple(groups)


def preview_startup_cas(
    domains: DataInspection,
    snapshot: StartupSources,
    *,
    recovered: dict[str, CasStorageInspection] | None = None,
) -> tuple[tuple[str, CasStorageInspection | None], ...]:
    """Read CAS formats and residual evidence while each project stays qualified."""
    require_available_project_recovery(snapshot)
    require_qualified_project_locations(snapshot)
    result: list[tuple[str, CasStorageInspection | None]] = []
    for entry, name, owners in _project_sqlite_owners(snapshot):
        if recovered is not None and name in recovered:
            result.append((name, recovered[name]))
            continue
        with ExitStack() as held:
            roots = (
                (str(entry.root),)
                if entry.database is None
                else (str(entry.root), str(entry.database.parent))
            )
            held.enter_context(inspect_directories(domains, roots))
            database = held.enter_context(project_database(entry.root))
            if database != entry.database:
                raise DomainChangedError("project database changed before CAS preview")
            _preview, ledger, _deadline = held.enter_context(
                projected_database(database, name, owners)
            )
            storage = held.enter_context(project_version_storage(entry.root))
            if storage is None:
                VersionStore.inspect_cas_references(ledger, {})
                result.append((name, None))
            else:
                result.append((name, inspect_cas_storage(storage, ledger=ledger)))
    return tuple(result)


@contextmanager
def projected_startup_recovery(
    *,
    now: float,
    legacy_plans=(),
    project_creations=None,
    project_removals=(),
    authorization_snapshot: StartupSources | None = None,
    recovery_id: str | None = None,
    resource_objects: dict | None = None,
    resource_file: Callable[[str, str, str, str, str, bytes], None] | None = None,
):
    """Keep private databases alive through the real cross-owner recovery.

    The caller must already hold inspection admission for the service directory.
    The timestamp is an explicit plan input, shared with later row export; it is
    never sampled independently by either persistence owner.
    """
    if (
        isinstance(now, bool)
        or not isinstance(now, (int, float))
        or not math.isfinite(now)
        or now <= 0
    ):
        raise ValueError("invalid startup recovery timestamp")
    with ExitStack() as stack:
        copies = {}
        owners_by_name = {}
        for path, name, owners in _startup_sqlite_owners(recovery_at=now):
            if name not in (
                {"content", "imports", "literature"} if project_removals else {"content", "imports"}
            ):
                continue
            copies[name] = stack.enter_context(projected_database(path, name, owners))
            owners_by_name[name] = owners
        resource_projects = {}
        if authorization_snapshot is not None:
            if recovery_id is None:
                raise ValueError("authorization projection requires a recovery identity")
            planned = authorization_snapshot.catalog.authorization_plans
            if ContentCatalog._authorization_reconciliations(copies["content"][1]) != planned:
                raise DomainChangedError("authorization plan changed before projection")
            projects = dict(authorization_snapshot.catalog.projects)
            required = {row.root.project_id for row in planned}
            if not required <= projects.keys():
                raise DomainChangedError("authorization project is unavailable")
            for entry, name, owners in _project_sqlite_owners(authorization_snapshot):
                identities = tuple(
                    project for project in required if projects[project] == entry.root
                )
                if not identities:
                    continue
                database = stack.enter_context(project_database(entry.root))
                if database != entry.database:
                    raise DomainChangedError("authorization project database changed")
                copies[name] = stack.enter_context(projected_database(database, name, owners))
                owners_by_name[name] = owners
                storage = stack.enter_context(project_version_storage(entry.root))
                for identity in identities:
                    resource_projects[identity] = (name, entry.root, storage)
            if required != resource_projects.keys():
                raise DomainChangedError("authorization project sources are incomplete")

        @contextmanager
        def transaction(name):
            connection = copies[name][1]
            connection.execute("PRAGMA query_only=OFF")
            # Owner recovery connections enable foreign keys. Schema preview
            # deliberately disables them for table rebuilds; restore the real
            # recovery setting before beginning the transaction.
            connection.execute("PRAGMA foreign_keys=ON")
            try:
                with connection:
                    connection.execute("BEGIN IMMEDIATE")
                    yield connection
            finally:
                connection.execute("PRAGMA query_only=ON")

        if legacy_plans:
            with transaction("content") as content:
                for plan in legacy_plans:
                    ContentCatalog.insert_project_rows(content, plan)
        recover_startup_rows(
            lambda: transaction("content"),
            lambda: transaction("imports"),
            now=now,
            recover_operations=True,
        )
        if project_creations is not None:
            with transaction("content") as content:
                if ContentCatalog._project_creations(content) != tuple(
                    row.creation for row in project_creations
                ):
                    raise DomainChangedError("project creation plan changed before projection")
            # ContentOperations.start recovers creations before removals. Use
            # the same owner transitions, preserving each failure's provenance.
            for recovery in project_creations:
                creation, observation = recovery.creation, recovery.observation
                with transaction("content") as content:
                    ContentCatalog.resume_project_creation_rows(
                        content, creation.operation_id, creation.owner, now=now
                    )
                    if recovery.result is None:
                        lost = (
                            observation.phase == "lost"
                            and creation.directory_identity is not None
                            and observation.root == Path(creation.plan.dir_root)
                            and observation.identity is None
                            and observation.receipt is None
                            and not observation.roots
                        )
                        if observation.phase != "unproven" and not lost:
                            raise DomainChangedError("creation failure has no observed provenance")
                        ContentCatalog.defer_project_creation_rows(
                            content, creation.operation_id, now=now
                        )
                    else:
                        if observation.phase != "verified" or observation.root != Path(
                            creation.plan.dir_root
                        ):
                            raise DomainChangedError(
                                "creation registration has no verified provenance"
                            )
                        verify_project_creation_record(
                            creation, observation.identity, observation.receipt
                        )
                        ContentCatalog.record_project_creation_identity_rows(
                            content, creation.operation_id, observation.identity
                        )
                        ContentCatalog.insert_project_rows(
                            content,
                            creation.plan,
                            effect=(creation.operation_id, asdict(recovery.result)),
                        )
                        ContentCatalog.recover_operation_rows(content, now=now)
        if project_removals:
            with transaction("content") as content:
                if ContentCatalog._project_removals(content) != tuple(project_removals):
                    raise DomainChangedError("project removal plan changed before projection")
            for removal in project_removals:
                with transaction("literature") as literature:
                    LiteratureRepository.drop_project_link_rows(literature, removal.project_id)
                with transaction("content") as content:
                    ContentCatalog.delete_project_rows(
                        content,
                        removal.project_id,
                        now=now,
                        effect=(
                            removal.operation_id,
                            {"id": removal.project_id, "removed": True, "files_kept": True},
                        ),
                    )
                    ContentCatalog.recover_operation_rows(content, now=now)
        if authorization_snapshot is not None:
            if recovery_id is None:
                raise ValueError("authorization recovery requires an attempt identity")
            settings = SettingsService.initialized_values(
                SettingsService.decode(authorization_snapshot.settings_data),
                existing_projects=bool(
                    authorization_snapshot.catalog.projects or authorization_snapshot.legacy_seeds
                ),
            )
            policy = SettingsService.version_policy_values(settings)
            formats = WorkbenchFormatPolicy().version_patterns()
            emit_file = (
                None
                if resource_file is None
                else lambda project, object_id, kind, identifier, name, data: resource_file(
                    resource_projects[project][0], object_id, kind, identifier, name, data
                )
            )
            resources = ResourceProjection(emit_file=emit_file)
            content = copies["content"][1]
            # Read after removals: the normal removal owner can have cancelled
            # authorization work. Never resurrect a superseded operation.
            for record in ContentCatalog._authorization_reconciliations(content):
                name, root, storage = resource_projects[record.root.project_id]
                row = ContentCatalog.project_row(content, record.root.project_id)
                if row is None or Path(row.dir_root) != root:
                    raise DomainChangedError("authorization project changed during recovery")
                project = ProjectRegistry.creation_result(row)
                scope = ContentService.project_space(
                    project, ContentCatalog.external_root_rows(content, project.id)
                )
                reference = ExternalRootService.reference(record.root)
                if not reference.available:
                    raise ContentError("root_source_unavailable")
                with transaction(name) as ledger:
                    resources.linked_root(
                        scope,
                        ledger,
                        storage,
                        reference.mount_path,
                        policy=policy,
                        default_patterns=formats,
                        attempt=recovery_id,
                        operation=record.operation_id,
                        now_ms=int(now * 1000),
                    )
                payload = asdict(reference)
                payload["kind"] = reference.kind.value
                payload["agentSessionsAffected"] = []
                with transaction("content") as content:
                    ContentCatalog.finish_authorization_reconciliation_rows(
                        content, record.operation_id, payload
                    )
                    ContentCatalog.recover_operation_rows(content, now=now)
            if resource_objects is not None:
                resource_objects.update(
                    (resource_projects[project][0], objects)
                    for project, objects in resources.objects()
                )
        result = {}
        for name, (preview, connection, deadline) in copies.items():
            result[name] = (
                observe_recovered_database(
                    preview, connection, owners_by_name[name], deadline=deadline
                ),
                connection,
                deadline,
            )
        yield result


def _recovery_database_names(snapshot: StartupSources) -> set[str]:
    names = {"content", "imports"}
    if requires_postcommit_recovery(snapshot.catalog.project_creation_plans):
        return names
    if snapshot.catalog.has_project_removals:
        names.add("literature")
    projects = dict(snapshot.catalog.projects)
    roots = {
        projects[row.root.project_id]
        for row in snapshot.catalog.authorization_plans
        if row.root.project_id in projects
    }
    names.update(name for entry, name, _ in _project_sqlite_owners(snapshot) if entry.root in roots)
    return names


def preview_startup_sqlite(
    domains: DataInspection,
    snapshot: StartupSources,
    *,
    recovery_at: float | None = None,
    recovery_id: str | None = None,
    resource_cas: dict[str, CasStorageInspection] | None = None,
    recovery_report: dict | None = None,
) -> tuple[DatabasePreview, ...]:
    """Project actual startup migrations; row codecs and backup lifecycle remain separate."""
    require_available_project_recovery(snapshot)
    require_qualified_project_locations(snapshot)
    if snapshot.trace_projection is not None:
        require_trace_storage(
            snapshot.trace,
            snapshot.trace_projection,
            snapshot.trace_formats,
            snapshot.trace_history,
        )
    if recovery_report is not None:
        if (
            recovery_report
            or (not isinstance(recovery_at, int) or isinstance(recovery_at, bool))
            or not 0 < recovery_at <= 9007199254740991
            or not isinstance(recovery_id, str)
            or len(recovery_id) != 64
            or any(char not in "0123456789abcdef" for char in recovery_id)
        ):
            raise ValueError("invalid recovery report request")
    blocked: list[str] = []
    previews: list[DatabasePreview] = []
    size = 2

    def retain(preview: DatabasePreview) -> None:
        nonlocal size
        size += len(
            json.dumps(asdict(preview), ensure_ascii=True, separators=(",", ":")).encode("ascii")
        ) + bool(previews)
        if size > MAX_LAYOUT_BYTES or len(previews) >= MAX_LAYOUT_DATABASES:
            raise ValueError("aggregate SQLite preview exceeds budget")
        previews.append(preview)

    deferred = recovery_at is not None and requires_postcommit_recovery(
        snapshot.catalog.project_creation_plans
    )
    creations = (
        startup_creation_recovery(domains, snapshot)
        if recovery_at is not None and not deferred
        else None
    )
    scope = (
        startup_removal_plans(domains, snapshot, authorizations=True)
        if recovery_at is not None and not deferred
        else domains.inspection(str(SERVICE_DIR.absolute()))
    )
    with scope as observed_removals:
        removals = () if deferred else observed_removals
        if recovery_report is not None and not deferred:
            if creations is None:
                blocked.append("project-creations")
            if removals is None:
                blocked.append("project-removals")
            if snapshot.catalog.has_authorization_reconciliations and (
                creations is None or removals is None
            ):
                blocked.append("authorizations")
        recovered = {}
        if recovery_at is not None:
            plans = startup_legacy_plans(snapshot, recovery_at=recovery_at, recovery_id=recovery_id)
            authorization = (
                snapshot
                if not deferred
                and removals is not None
                and creations is not None
                and snapshot.catalog.has_authorization_reconciliations
                else None
            )
            publications = (
                CasPublicationSet()
                if resource_cas is not None and authorization is not None
                else None
            )
            with projected_startup_recovery(
                now=recovery_at,
                legacy_plans=plans,
                project_creations=creations,
                project_removals=removals or (),
                authorization_snapshot=authorization,
                recovery_id=recovery_id,
                resource_file=publications.add if publications is not None else None,
            ) as copies:
                if publications is not None:
                    if resource_cas is None:
                        raise RuntimeError("resource publication projection requires CAS state")
                    publications.finish()
                    for entry, name, _owners in _project_sqlite_owners(snapshot):
                        if name in copies:
                            with project_version_storage(entry.root) as storage:
                                resource_cas[name] = inspect_cas_storage(
                                    storage,
                                    ledger=copies[name][1],
                                    publications=publications.for_database(name),
                                )
                recovered = {name: value[0] for name, value in copies.items()}
        for path, name, owners in _startup_sqlite_owners(recovery_at=recovery_at):
            retain(recovered[name] if name in recovered else preview_database(path, name, owners))
    for entry, name, owners in _project_sqlite_owners(snapshot):
        if name in recovered:
            retain(recovered[name])
            continue
        roots = (
            (str(entry.root),)
            if entry.database is None
            else (str(entry.root), str(entry.database.parent))
        )
        with inspect_directories(domains, roots), project_database(entry.root) as database:
            if database != entry.database:
                raise DomainChangedError("project database changed before migration preview")
            if database is None:
                # Content proved the private directory absent while retaining
                # the project handle. Preview no filesystem path in this case.
                retain(preview_database(None, name, owners))
            else:
                retain(preview_database(database, name, owners))
    if recovery_report is not None:
        # Populate only after every projection and its private IO have closed.
        # This covers startup recovery, not all product writer/format admission.
        recovery_report.update(
            version=1, at=recovery_at, attempt=recovery_id, blocked=sorted(blocked)
        )
    return tuple(previews)


def export_startup_sqlite(
    domains: DataInspection,
    snapshot: StartupSources,
    wanted: DatabasePreview,
    emit: Callable[[bytes], None],
    *,
    recovery_at: float | None = None,
    recovery_id: str | None = None,
) -> None:
    """Reproject one compiled owner under qualification and stream only exact evidence."""
    require_available_project_recovery(snapshot)
    require_qualified_project_locations(snapshot)

    def export(path: Path | None, name: str, owners: tuple[SchemaOwner, ...]) -> None:
        with projected_database(path, name, owners) as (preview, connection, deadline):
            if preview != wanted:
                raise DomainChangedError("SQLite projection changed before row export")
            if rows_digest(connection, deadline=deadline, emit=emit) != wanted.rows_digest:
                raise DomainChangedError("SQLite projection changed during row export")

    if recovery_at is not None and wanted.name in _recovery_database_names(snapshot):
        plans = startup_legacy_plans(snapshot, recovery_at=recovery_at, recovery_id=recovery_id)
        deferred = requires_postcommit_recovery(snapshot.catalog.project_creation_plans)
        creations = None if deferred else startup_creation_recovery(domains, snapshot)
        if creations is None and not deferred:
            raise DomainChangedError("project creation recovery incomplete during row export")
        scope = (
            domains.inspection(str(SERVICE_DIR.absolute()))
            if deferred
            else startup_removal_plans(domains, snapshot, authorizations=True)
        )
        with scope as observed_removals:
            removals = () if deferred else observed_removals
            if removals is None:
                raise DomainChangedError("project removal roots incomplete during row export")
            authorization = (
                snapshot
                if not deferred and snapshot.catalog.has_authorization_reconciliations
                else None
            )
            with projected_startup_recovery(
                now=recovery_at,
                legacy_plans=plans,
                project_creations=creations,
                project_removals=removals,
                authorization_snapshot=authorization,
                recovery_id=recovery_id,
            ) as copies:
                preview, connection, deadline = copies[wanted.name]
                if preview != wanted:
                    raise DomainChangedError("SQLite recovery changed before row export")
                if rows_digest(connection, deadline=deadline, emit=emit) != wanted.rows_digest:
                    raise DomainChangedError("SQLite recovery changed during row export")
        return
    for path, name, owners in _startup_sqlite_owners(recovery_at=recovery_at):
        if name == wanted.name:
            with domains.inspection(str(SERVICE_DIR.absolute())):
                export(path, name, owners)
            return
    for entry, name, owners in _project_sqlite_owners(snapshot):
        if name != wanted.name:
            continue
        roots = (
            (str(entry.root),)
            if entry.database is None
            else (str(entry.root), str(entry.database.parent))
        )
        with inspect_directories(domains, roots), project_database(entry.root) as database:
            if database != entry.database:
                raise DomainChangedError("project database changed before row export")
            if database is None:
                export(None, name, owners)
            else:
                export(database, name, owners)
        return
    raise ValueError("SQLite row export owner is unavailable")


def prepare_startup_publications(
    domains: DataInspection,
    snapshot: StartupSources,
    wanted: dict[str, tuple[CasPublicationPreview, ...]],
    *,
    recovery_at: float,
    recovery_id: str,
) -> dict[str, tuple[CasPublication, ...]]:
    """Regenerate one complete export batch under qualified recovery inputs."""
    require_available_project_recovery(snapshot)
    require_qualified_project_locations(snapshot)
    groups = _project_sqlite_owners(snapshot)
    if not snapshot.catalog.has_authorization_reconciliations or set(wanted) != {
        name for _entry, name, _owners in groups
    }:
        raise ValueError("CAS publication recovery owner is unavailable")
    if requires_postcommit_recovery(snapshot.catalog.project_creation_plans):
        # Deferred authorization creates no precommit objects. Do not manufacture
        # a publication or read a future native identity to satisfy an export.
        if any(wanted.values()):
            raise DomainChangedError("deferred recovery cannot export future CAS publications")
        return {name: () for name in wanted}
    creations = startup_creation_recovery(domains, snapshot)
    if creations is None:
        raise DomainChangedError("project creation recovery incomplete during CAS export")
    plans = startup_legacy_plans(snapshot, recovery_at=recovery_at, recovery_id=recovery_id)
    with startup_removal_plans(domains, snapshot, authorizations=True) as removals:
        if removals is None:
            raise DomainChangedError("authorization roots incomplete during CAS export")
        publications = CasPublicationSet()
        with projected_startup_recovery(
            now=recovery_at,
            legacy_plans=plans,
            project_creations=creations,
            project_removals=removals,
            authorization_snapshot=snapshot,
            recovery_id=recovery_id,
            resource_file=publications.add,
        ):
            publications.finish()
            images = {name: publications.for_database(name) for name in wanted}
            if {
                name: tuple(image.preview() for image in group) for name, group in images.items()
            } != wanted:
                raise DomainChangedError("CAS publication batch changed before export")
    # Only immutable private images leave the successfully closed qualification.
    return images


def check_startup_publications(
    domains: DataInspection,
    snapshot: StartupSources,
    reports: dict[str, tuple[CasPublicationPreview, ...]],
    read_candidate: Callable[[str, CasPublicationPreview], CasPublication],
) -> dict[str, tuple[CasPublication, ...]]:
    """Interpret every future object, including ones with no remaining row refs."""
    groups = _project_sqlite_owners(snapshot)
    if set(reports) != {name for _entry, name, _owners in groups}:
        raise ValueError("CAS publication project coverage differs")
    received = {}
    deadline = time.monotonic() + MAX_CAS_SECONDS
    decoded = encoded = count = 0
    for entry, name, _owners in groups:
        roots = (
            (str(entry.root),)
            if entry.database is None
            else (str(entry.root), str(entry.database.parent))
        )
        with inspect_directories(domains, roots), project_version_storage(entry.root) as storage:
            pending = []
            for preview in reports[name]:
                if time.monotonic() > deadline:
                    raise ValueError("CAS source comparison exceeded time budget")
                count += 1
                encoded += preview.size
                if count > MAX_CAS_OBJECTS or encoded > MAX_CAS_BYTES:
                    raise ValueError("CAS source comparison exceeded publication budget")
                image = read_candidate(name, preview)
                decoded += image.verify().raw_size_bytes
                if decoded > MAX_CAS_BYTES:
                    raise ValueError("CAS source comparison exceeded decoded budget")
                pending.append(image)
            images = tuple(pending)
            result = inspect_cas_storage(storage, publications=images)
            if result.publications != reports[name]:
                raise DomainChangedError("CAS publication changed during source inspection")
            received[name] = images
    return received


def check_startup_sqlite(
    candidate: object,
    source: tuple[DatabasePreview, ...],
    snapshot: StartupSources,
    *,
    domains: DataInspection,
    read_candidate: Callable[[DatabasePreview], Iterable[bytes]] | None = None,
    read_publications: Callable[[str], tuple[CasPublication, ...]] | None = None,
) -> tuple[LayoutCheck, ...]:
    """Read candidate layouts with this signed version's exact owner code."""
    candidates = decode_previews(candidate)
    own = {preview.name: preview for preview in source}
    groups = (*_startup_sqlite_owners(), *_project_sqlite_owners(snapshot))
    if {preview.name for preview in candidates} != set(own) or set(own) != {
        name for _, name, _ in groups
    }:
        raise ValueError("SQLite compatibility coverage differs")
    proposed = {preview.name: preview for preview in candidates}
    checks = []
    for location, name, owners in groups:
        candidate_owners = owners
        if isinstance(location, ProjectStartupSource):

            def read_resources(connection, root=location.root, database=name):
                VersionStore.inspect_rows(connection)
                # These are the candidate's streamed rows, interpreted by the
                # source's reader against the same held physical CAS snapshot.
                with domains.inspection(str(root)), project_version_storage(root) as storage:
                    publications = () if read_publications is None else read_publications(database)
                    inspect_cas_storage(storage, ledger=connection, publications=publications)

            candidate_owners = tuple(
                (
                    replace(owner, read_rows=read_resources)
                    if owner.name == "resource-versions"
                    else owner
                )
                for owner in owners
            )
        checks.append(
            require_candidate_layout(
                proposed[name], own[name], candidate_owners, read_candidate=read_candidate
            )
        )
    return tuple(checks)


def startup_storage_needs_write(snapshot: StartupSources) -> bool:
    """Maintenance for inspected owners only; not whole-product admission."""
    require_qualified_project_locations(snapshot)
    require_trace_storage(
        snapshot.trace,
        snapshot.trace_projection,
        snapshot.trace_formats,
        snapshot.trace_history,
        allow_recovery=True,
    )
    if snapshot.pending_legacy_seeds is None:
        raise RuntimeError("legacy project roots have not been inspected")
    if snapshot.config_seed_source is not None and snapshot.config_seed_data is None:
        raise RuntimeError("config seed source has not been inspected")
    if snapshot.trace_projection.recovery is not None:
        return True
    if snapshot.session_journal is not None and snapshot.session_journal.needs_write:
        return True
    if snapshot.pending_legacy_seeds or snapshot.catalog.has_receipts:
        return True
    if snapshot.config_seed is not None:
        return True
    if any(entry.database is None and entry.pdf is not None for entry in snapshot.project_storage):
        return True
    settings = SettingsService.decode(snapshot.settings_data)
    if (
        SettingsService.initialized_values(
            settings, existing_projects=bool(snapshot.catalog.projects or snapshot.legacy_seeds)
        )
        != settings
    ):
        return True
    return any(
        schema.needs_write
        for schema in (
            snapshot.catalog.schema,
            snapshot.sessions,
            snapshot.events,
            snapshot.artifacts,
            snapshot.citations,
            snapshot.invocations,
            snapshot.assistant,
            snapshot.fulltext_authorizations,
            snapshot.imports,
            snapshot.handoff,
            snapshot.credentials,
            snapshot.literature,
            *(
                schema
                for entry in snapshot.project_storage
                for schema in (entry.pdf, entry.versions, entry.resources)
                if schema is not None
            ),
        )
    )


def recover_startup_rows(
    content_transaction: Callable[[], AbstractContextManager[sqlite3.Connection]],
    import_transaction: Callable[[], AbstractContextManager[sqlite3.Connection]],
    *,
    now: float,
    recover_operations: bool,
) -> None:
    """Compose real recovery steps on durable stores or caller-owned private copies.

    Import results commit before receipt acknowledgement. A failed acknowledgement
    leaves a retryable receipt; operation recovery runs only after all receipts
    have been reconciled. The caller owns exclusive admission and the clock input.
    """
    with content_transaction() as content:
        receipts = ContentCatalog.root_receipt_rows(content)
    for receipt in receipts:
        with import_transaction() as imports:
            ImportJobStore.recover_link_rows(
                imports,
                receipt.operation_id,
                receipt.request_json,
                tuple((row.project_id, row.mount_path) for row in receipt.roots),
                now=now,
            )
        with content_transaction() as content:
            ContentCatalog.acknowledge_root_receipt_rows(
                content,
                receipt.operation_id,
                receipt.request_json,
            )
    if recover_operations:
        with content_transaction() as content:
            ContentCatalog.recover_operation_rows(content, now=now)


def startup_legacy_plans(snapshot: StartupSources, *, recovery_at: float, recovery_id: str | None):
    if snapshot.pending_legacy_seeds is None:
        raise ValueError("legacy project roots have not been inspected")
    if not snapshot.pending_legacy_seeds:
        return ()
    if recovery_id is None:
        raise ValueError("legacy project projection requires an update identity")
    return ProjectRegistry.legacy_plans(
        snapshot.pending_legacy_seeds, now=recovery_at, attempt=recovery_id
    )


def initialize_project_storage_sources(entries: tuple[ProjectStartupSource, ...]) -> None:
    """Initialize only project owners under caller-held exclusive project qualification."""
    missing = tuple(entry for entry in entries if entry.database is None and entry.pdf is not None)
    if missing:
        for entry in missing:
            prepare_project_storage(entry.root)
        return
    for entry in entries:
        if (
            entry.database is not None
            and entry.resources is not None
            and entry.resources.needs_write
        ):
            initialize_resource_catalog(entry.database, entry.root)
        if entry.database is not None and entry.versions is not None and entry.versions.needs_write:
            VersionStore(entry.database, entry.root).ensure()


def initialize_startup_storage(
    snapshot: StartupSources,
    *,
    recover_operations: bool = False,
    recovery_at: int | None = None,
    recovery_id: str | None = None,
    project_failed: Callable[[Path, str], None] | None = None,
) -> None:
    """Initialize inspected storage while the caller holds exclusive domains.

    This synchronous callback closes owner IO before returning. It does not copy
    arbitrary configuration, create missing project roots, or grant business admission.
    prepare_startup_domains must re-read and prove convergence before release.
    """
    if snapshot.projects_deferred:
        raise ValueError("deferred project inspection cannot initialize storage")
    if recovery_at is not None and (
        (not isinstance(recovery_at, int) or isinstance(recovery_at, bool))
        or not 0 < recovery_at <= 9007199254740991
    ):
        raise ValueError("invalid startup recovery timestamp")
    require_trace_storage(
        snapshot.trace,
        snapshot.trace_projection,
        snapshot.trace_formats,
        snapshot.trace_history,
        allow_recovery=True,
    )
    if snapshot.pending_legacy_seeds is None:
        raise RuntimeError("legacy project roots have not been inspected")
    if snapshot.config_seed_source is not None and snapshot.config_seed_data is None:
        raise RuntimeError("config seed source has not been inspected")

    recover_trace_storage(TRACE_PATHS, snapshot.trace_projection)

    def initialize_project(entry: ProjectStartupSource) -> None:
        try:
            if entry.database is not None and entry.pdf is not None and entry.pdf.cutover:
                cutover_project_pdf_records((entry.database,))
            initialize_project_storage_sources((entry,))
        except Exception as error:
            reason = (
                project_inspection_failure(error)
                if snapshot.isolated_projects and project_failed
                else None
            )
            if reason is None:
                raise
            project_failed(entry.root, reason)
            _log.warning(
                "project_initialization_failed path=%s reason=%s error_type=%s",
                entry.root,
                reason,
                type(error).__name__,
            )

    missing_storage = tuple(
        entry
        for entry in snapshot.project_storage
        if entry.database is None and entry.pdf is not None
    )
    if missing_storage:
        for entry in missing_storage:
            initialize_project(entry)
        return
    if snapshot.config_seed is not None:
        publish_config_seed(snapshot.config_seed)
    if snapshot.catalog.schema.needs_write or snapshot.pending_legacy_seeds:
        catalog = ContentCatalog(CONTENT_DB)
        if recovery_at is None:
            ProjectRegistry(str(snapshot.workspace), catalog).seed_legacy(
                snapshot.pending_legacy_seeds
            )
        else:
            plans = startup_legacy_plans(snapshot, recovery_at=recovery_at, recovery_id=recovery_id)
            with catalog.recovery_transaction() as connection:
                for plan in plans:
                    ContentCatalog.insert_project_rows(connection, plan)
    if snapshot.session_journal is not None and snapshot.session_journal.needs_write:
        with transaction(SESSION_CATALOG_DB, immediate=True) as connection:
            journal.initialize(connection)
    for schema, owner in (
        (snapshot.sessions, SessionCatalogStore),
        (snapshot.events, ProductEventStore),
        (snapshot.artifacts, SessionArtifactStore),
        (snapshot.citations, CitationStore),
        (snapshot.invocations, AssistantInvocationStore),
        (snapshot.assistant, AssistantStore),
    ):
        if schema.needs_write:
            owner(SESSION_CATALOG_DB)
    if snapshot.imports.needs_write:
        ImportJobStore(RESOURCE_IMPORTS_DB)
    if snapshot.fulltext_authorizations.needs_write:
        FulltextAuthorizer.ensure_schema(SESSION_CATALOG_DB)
    if snapshot.catalog.has_receipts or (
        recover_operations and snapshot.catalog.has_pending_operations
    ):
        catalog = ContentCatalog(CONTENT_DB)
        imports = ImportJobStore(RESOURCE_IMPORTS_DB)
        recover_startup_rows(
            catalog.recovery_transaction,
            imports.recovery_transaction,
            now=time.time() if recovery_at is None else recovery_at,
            recover_operations=recover_operations,
        )
    if snapshot.handoff.needs_write:
        HandoffClaimStore(DESKTOP_HANDOFF_DB).ensure_schema()
    if snapshot.credentials.needs_write:
        ModelCredentialStore(MODEL_CREDENTIALS_DB).ensure_schema()
    if snapshot.literature.cutover:
        cutover_pdf_records(SERVICE_LITERATURE_DATABASE, ())
    if snapshot.literature.needs_write:
        connect_literature(SERVICE_LITERATURE_DATABASE).close()
    for entry in snapshot.project_storage:
        initialize_project(entry)
    SettingsService().initialize(
        existing_projects=bool(snapshot.catalog.projects or snapshot.legacy_seeds)
    )


def _bind_writable_roots(app: FastAPI, content: ContentService) -> None:
    """把「某个项目当前允许写哪些根」接到会话域。

    会话域不 import content: 它只拿一个 `Path → 可写根集合` 的函数。绑定发生在
    组合根, 因为「哪个域回答这个问题」是装配决策；约束见 docs/features/resources.md。
    未绑定时会话域回空集合 —— 等价于只有 cwd 可写, 即改造前的行为。
    """

    sessions = getattr(app.state, "session_service", None)
    if sessions is None:
        return

    def provider(scope: Path) -> tuple[Path, ...]:
        project = content.project_for_path(str(scope))
        if project is None or not project.available:
            return ()
        return tuple(
            dict.fromkeys(
                (
                    Path(project.root),
                    *(Path(root) for root in content.writable_roots(project.id)),
                )
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
            resolved = Path(content.resolve(project.id, directory.path))
            grant_current_user_directory_access(resolved)
            return resolved
        except ContentError as error:
            raise ValueError(error.code) from error

    sessions.bind_output_directory(output_directory)


def _bind_project_recognition(app: FastAPI, content: ContentService) -> None:
    """Recognize explicit content project roots, never an unregistered descendant."""

    policy = getattr(app.state, "project_workspace_policy", None)
    if policy is None:
        return

    def registered_root(path: Path) -> bool:
        project = content.project_for_path(str(path))
        return project is not None and project.available and Path(project.root) == path

    policy.bind_recognizer(registered_root)


def create_app(
    cwd: Path | None = None,
    *,
    cases_root: Optional[Path] = None,
    product: str = PRODUCT_ALL,
    renderer_dist: str = "",
    office_root: str = "",
    cors_origins: Optional[list[str]] = None,
    auth: Optional[bool] = None,
    auth_mode: str | None = None,
    ownership_axis: str | None = None,
    local_bridge_root: Path | None = None,
    runtime_discovery: RuntimeDiscovery | None = None,
) -> FastAPI:
    """Compose chat, capabilities, identity, and the renderer."""

    with startup_phase("application.features"):
        features = product_features()
        browser_host_client = BrowserHostClient.from_environment(enabled=features.browser_enabled)
    del cases_root
    # Query authenticated native authority before any startup initialization.
    # A warming candidate must use the same clock as its paired data preview.
    with startup_phase("application.admission"):
        guardian = native_guardian()
        admission = WorkbenchAdmission(guardian)
    with startup_phase("application.runtime_discovery"):
        runtime_discovery = runtime_discovery or RuntimeDiscovery.discover()
    with startup_phase("storage.native"):
        if sys.platform == "darwin":
            native = DarwinDirectoryNative()
        elif sys.platform == "win32":
            native = _windows_directory_native(guardian)
        elif sys.platform == "linux":
            native = LinuxDirectoryNative()
        else:
            raise LeaseError("ERR_LEASE_UNSUPPORTED")
    with startup_phase("storage.coordinator"):
        coordinator = str(coordination_root())
        pin = native.pin(coordinator, True)
        native.release(pin)
    with startup_phase("storage.reclamation"):
        try:
            reclaim_coordination(native, coordinator)
        except OSError as error:
            if getattr(error, "code", None) in {"ERR_LEASE_RELEASE", "ERR_DOMAIN_RELEASE"}:
                raise
            _startup_log.warning("coordination reclamation deferred: %s", error)
    # Existing-only provider roots must never be recreated, including when
    # another product-owned root shares their pathname.
    with startup_phase("storage.creation_roots"):
        owned, existing = startup_creation_roots(runtime_discovery, local_bridge_root)
    with startup_phase("storage.existing_roots", roots=len(existing)):
        for root in existing:
            pin = native.pin(root, False)
            native.release(pin)
    with startup_phase("storage.ensure_directories", roots=len(owned)):
        ensure_directories(native, coordinator, owned)
        if os.name != "nt":
            restrict_private_directory(SCHOLARSEED_HOME.absolute())
        else:
            home = SCHOLARSEED_HOME.absolute()
            for private_root in dict.fromkeys(
                (home, *runtime_discovery.private_configuration_roots(home))
            ):
                prepare_private_root(native, coordinator, private_root)
    with startup_phase("storage.seed"):
        seed = StartupSeed()

    def prepare_provider_structure(state: StartupSources) -> None:
        required = tuple(str(root.path) for root in state.provider_storage if not root.create)
        for root in required:
            pin = native.pin(root, False)
            native.release(pin)
        creatable = tuple(str(root.path) for root in state.provider_storage if root.create)
        if creatable:
            ensure_directories(native, coordinator, creatable)

    def qualification_failure(state: StartupSources, path: str, error: BaseException) -> bool:
        if not state.isolated_projects or not isinstance(error, Exception):
            return False
        projects = state.project_root_owners.get(path, ())
        reason = project_inspection_failure(error)
        if not projects or reason is None:
            return False
        for project in projects:
            seed.project_failures[project] = reason
        _log.warning("project_qualification_failed path=%s reason=%s", path, reason)
        return True

    def removed_project_roots(before: StartupSources, after: StartupSources) -> tuple[str, ...]:
        if not before.isolated_projects or not after.isolated_projects:
            return ()
        unavailable = {row.root for row in after.unavailable_projects}
        return tuple(
            path
            for path, projects in before.project_root_owners.items()
            if projects and set(projects) <= unavailable
        )

    def inspect_initial(held: DataInspection) -> StartupSources:
        state = inspect_startup_sources(
            held,
            cwd,
            runtime_discovery,
            local_bridge_root,
            seed=seed,
            isolate_projects=admission.ready,
        )
        require_available_project_recovery(state)
        return state

    with startup_phase("storage.prepare"):
        snapshot, domains = prepare_startup_domains(
            native,
            coordinator,
            (str(SCHOLARSEED_HOME.absolute()), str(SERVICE_DIR.absolute())),
            inspect_initial,
            lambda state: startup_storage_needs_write(state)
            or state.catalog.has_pending_operations,
            lambda state: initialize_startup_storage(
                state,
                project_failed=seed.project_failures.__setitem__,
                recover_operations=True,
                recovery_at=admission.recovery_at,
                recovery_id=admission.recovery_id,
            ),
            prepare_structure=prepare_provider_structure,
            qualification_failure=qualification_failure,
            removed_roots=removed_project_roots,
        )
    for project in snapshot.unavailable_projects:
        _log.warning(
            "project_directory_unavailable project_id=%s path=%s registration=retained",
            project.project_id,
            project.root,
        )
    # Once composition starts, a constructor can have created a resource whose
    # failure does not establish drain. Unsuccessful composition keeps native
    # qualifications until process death, never an unconditional finally-close.

    default_project_task: asyncio.Task[dict[str, object]] | None = None

    async def prepare_operations() -> None:
        nonlocal default_project_task
        await operations.start(
            defer_until_open=snapshot.isolated_projects
            or (
                not admission.ready
                and requires_postcommit_recovery(snapshot.catalog.project_creation_plans)
            )
        )
        if admission.ready:
            await operations.execute("local", EnsureDefaultProject())
        else:
            default_project_task = asyncio.create_task(
                operations.execute("local", EnsureDefaultProject()),
                name="default-project-after-admission",
            )

    with startup_phase(
        "application.compose", projects=len(snapshot.project_storage), roots=len(snapshot.roots)
    ):
        app = _compose_app(
            snapshot,
            features=features,
            browser_host_client=browser_host_client,
            prepare=prepare_operations,
            admission=admission,
            product=product,
            renderer_dist=renderer_dist,
            office_root=office_root,
            cors_origins=cors_origins,
            auth=auth,
            auth_mode=auth_mode,
            ownership_axis=ownership_axis,
            local_bridge_root=local_bridge_root,
            runtime_discovery=runtime_discovery,
        )
    owner = DomainOwner(domains)
    app.state.storage_domains = owner
    app.state.startup_sources = snapshot
    activities = app.state.activities
    discovery_roots = (str(SCHOLARSEED_HOME.absolute()), str(SERVICE_DIR.absolute()))

    def read_current(held: DataInspection) -> StartupSources:
        return inspect_startup_sources(
            held,
            cwd,
            runtime_discovery,
            local_bridge_root,
            seed=seed,
            isolate_projects=admission.ready,
        )

    def reconcile_authorization(operation_id: str, recovery: ReconcileAuthorization | None = None):
        pending = app.state.content_catalog.authorization_reconciliations()
        record = next((row for row in pending if row.operation_id == operation_id), None)
        if record is None:
            # Another qualified owner may have completed/cancelled this work
            # between our shared snapshot and exclusive acquisition.
            result = (
                app.state.content_catalog.operation_result(recovery.owner, operation_id)
                if recovery is not None
                else None
            )
            if result is not None and result["state"] == "succeeded":
                return result["result"]
            if result is not None and result["error"] == AUTHORIZATION_SUPERSEDED:
                raise ContentError(AUTHORIZATION_SUPERSEDED)
            raise RuntimeError("authorization reconciliation is missing")
        if recovery is not None and record.root.root_id != recovery.root_id:
            raise RuntimeError("authorization reconciliation identity changed")
        ref = next(
            row
            for row in app.state.content.external_roots(record.root.project_id)
            if row.root_id == record.root.root_id
        )
        if not ref.available:
            raise ContentError("root_source_unavailable")
        app.state.resource_version_supervisor.reconcile_linked_root(
            ref.project_id,
            ref.mount_path,
            observed_at_ms=(
                int(admission.recovery_at * 1000)
                if recovery is not None and admission.recovery_at is not None
                else None
            ),
            recovery_attempt=(
                admission.recovery_id
                if recovery is not None and admission.recovery_at is not None
                else None
            ),
            recovery_operation=(
                operation_id if recovery is not None and admission.recovery_at is not None else None
            ),
        )
        payload = asdict(ref)
        payload["kind"] = ref.kind.value
        payload["agentSessionsAffected"] = []
        app.state.content_catalog.finish_authorization_reconciliation(operation_id, payload)
        return payload

    def reconcile_project_removal(
        operation_id: str, recovery: ReconcileProjectRemoval | None = None
    ):
        pending = app.state.content_catalog.project_removals()
        record = next((row for row in pending if row.operation_id == operation_id), None)
        if record is None:
            result = (
                app.state.content_catalog.operation_result(recovery.owner, operation_id)
                if recovery is not None
                else None
            )
            if result is not None and result["state"] == "succeeded":
                return result["result"]
            raise RuntimeError("project removal is missing")
        if recovery is not None and record.project_id != recovery.project_id:
            raise RuntimeError("project removal identity changed")
        app.state.content.plan_project_forget(record.project_id)
        app.state.project_registry.remove(Path(record.root))
        app.state.content.forget_project(
            record.project_id,
            operation_id=operation_id,
            now=admission.recovery_at if recovery is not None else None,
        )
        return {"id": record.project_id, "removed": True, "files_kept": True}

    def create_project_concurrently(operation_id: str, command: CreateProject) -> ProjectRef:
        plan = app.state.content.plan_project_creation(command.name)
        candidate = Path(plan.dir_root)
        workspace_identity = owner.directory_identity(str(candidate.parent))
        provenance = app.state.content_catalog.begin_project_creation(operation_id, plan)
        with created_directory(
            native,
            coordinator,
            str(candidate.parent),
            candidate.name,
            expected_parent=workspace_identity,
            role=DirectoryRole.PROJECT,
        ) as fresh:
            identity = initialize_project_creation(native, fresh, provenance)
            with fresh.mutation():
                for relative in PROJECT_CREATION_DIRECTORIES:
                    if relative != PROJECT_STATE_DIRNAME:
                        prepare_private_directory(
                            candidate, tuple(Path(relative).parts), role=DirectoryRole.PROJECT
                        )
                prepare_project_storage(candidate)
            roots = (str(candidate), str(candidate / Path(PROJECT_DB_RELATIVE).parent))
            for _ in range(DIRECTORY_PREPARATION_ATTEMPTS):
                with fresh.descendants(roots, role=DirectoryRole.PROJECT) as view:
                    sources = inspect_project_sources(view, (candidate,))
                entries = sources.projects
                schemas = tuple(
                    schema
                    for entry in entries
                    for schema in (entry.pdf, entry.resources, entry.versions)
                )
                if any(schema is None for schema in schemas):
                    raise DomainChangedError("new project storage was not qualified")
                if not any(schema is not None and schema.needs_write for schema in schemas):
                    break
                with fresh.mutation():
                    initialize_project_storage_sources(entries)
            else:
                raise RuntimeError("new project initialization did not converge")
            verify_project_creation(native, fresh, provenance)
            with fresh.mutation():
                app.state.content_catalog.record_project_creation_identity(operation_id, identity)
        occupied = Domains(
            native,
            coordinator,
            sources.roots,
            roles={root: DirectoryRole.PROJECT for root in sources.roots},
        )
        retained = False
        try:
            occupied.occupy()
            occupied.check_writable()
            if verify_project_creation(native, occupied, provenance) != identity:
                raise DomainChangedError("new project changed before registration")
            observed = inspect_project_sources(occupied.inspection_view(), (candidate,))
            if observed != sources:
                raise DomainChangedError("new project schemas changed before registration")
            occupied.admit()
            owner.retain(occupied)
            retained = True
            return app.state.content.commit_project_creation(plan, operation_id=operation_id)
        finally:
            if not retained:
                occupied.close()

    def authorization_sources(command: AuthorizeRoot | LinkImport) -> tuple[str, ...]:
        if isinstance(command, AuthorizeRoot):
            return (command.source,)
        job = app.state.resource_imports.link_request(
            command.job_id, command.owner_id, command.generation
        )
        return tuple(
            job.sources[row.source_index]
            for row in job.source_results
            if row.status is ImportSourceStatus.PENDING
        )

    def authorization_plans(command: AuthorizeRoot | LinkImport) -> tuple[ExternalRootRow, ...]:
        if isinstance(command, AuthorizeRoot):
            return (
                app.state.content.plan_root_authorization(
                    command.project_id, command.source, command.mount
                ),
            )
        job = app.state.resource_imports.link_request(
            command.job_id, command.owner_id, command.generation
        )
        sources = authorization_sources(command)
        return (
            app.state.content.plan_import_roots(job.project_id, sources, job.target_dir)
            if sources
            else ()
        )

    def publish_authorization(
        operation_id: str, command: AuthorizeRoot | LinkImport, plans: tuple[ExternalRootRow, ...]
    ):
        if isinstance(command, LinkImport):
            job = app.state.resource_imports.link_request(
                command.job_id, command.owner_id, command.generation
            )
            receipt = app.state.resource_imports.link_receipt(job)
            result = {"job_id": job.job_id, "linked": len(plans)}
            refs = (
                app.state.content.commit_import_roots(
                    plans, receipt=(job.job_id, receipt), effect=(operation_id, result)
                )
                if plans
                else ()
            )
            app.state.resource_imports.record_links(job, refs)
            app.state.content.acknowledge_root_receipt(job.job_id, receipt)
            if not plans:
                app.state.content_catalog.record_operation_effect(operation_id, result)
            return result
        if not plans:
            raise ContentError(ROOT_SOURCE_CHANGED_ERROR)
        app.state.content.commit_root_authorization(
            plans[0], supersede=command.supersede, operation_id=operation_id
        )
        return reconcile_authorization(operation_id)

    def authorize_concurrently(operation_id: str, command: AuthorizeRoot | LinkImport):
        with activities.enter(ActivityDomain.RESOURCE):
            plans = authorization_plans(command)
            if not plans:
                return publish_authorization(operation_id, command, plans)
            sources = authorization_sources(command)
            roots: set[str] = set()
            files: list[tuple[str, str]] = []
            for source, plan in zip(sources, plans, strict=True):
                for path in (Path(source).expanduser().absolute(), Path(plan.source_path)):
                    root = canonical_root(path.parent if plan.kind is AssetKind.FILE else path)
                    roots.add(str(root))
                    if plan.kind is AssetKind.FILE:
                        files.append((str(root), path.name))
            occupied = Domains(
                native,
                coordinator,
                tuple(sorted(roots)),
                roles=app.state.startup_sources.project_roles(roots),
            )
            retained = False
            try:
                occupied.occupy()
                occupied.check_writable()
                current = authorization_plans(command)
                if tuple(
                    (row.project_id, row.source_path, row.kind, row.mount_path) for row in current
                ) != tuple(
                    (row.project_id, row.source_path, row.kind, row.mount_path) for row in plans
                ):
                    raise ContentError(ROOT_SOURCE_CHANGED_ERROR)
                for source_root, name in files:
                    if occupied.entry_kind(source_root, name) != AssetKind.FILE.value:
                        raise ContentError(ROOT_SOURCE_CHANGED_ERROR)
                occupied.admit()
                owner.retain(occupied)
                retained = True
                payload = publish_authorization(operation_id, command, current)
                app.state.startup_sources = replace(
                    app.state.startup_sources,
                    roots=tuple(sorted(set(app.state.startup_sources.roots) | roots)),
                    project_directories=app.state.startup_sources.extended_project_directories(
                        roots
                    ),
                )
                if isinstance(command, AuthorizeRoot):
                    app.state.resource_version_supervisor.schedule_scan(command.project_id)
                return payload
            finally:
                if not retained:
                    occupied.close()

    async def execute_command(operation_id: str, command: ContentCommand):
        if isinstance(command, EnsureDefaultProject):
            with activities.enter(ActivityDomain.RESOURCE):
                if app.state.content.projects():
                    result: dict[str, object] = {"created": False}
                    return result
                return create_project_concurrently(
                    operation_id, CreateProject(DEFAULT_PROJECT_NAME)
                )
        if isinstance(command, CreateProject):
            with activities.enter(ActivityDomain.RESOURCE):
                return create_project_concurrently(operation_id, command)
        if isinstance(command, LinkImport) or (
            isinstance(command, AuthorizeRoot) and not command.supersede
        ):
            return authorize_concurrently(operation_id, command)
        generation = activities.begin()
        released = False
        transition_started = False
        scan_project = None
        try:
            deadline = asyncio.get_running_loop().time() + DIRECTORY_DRAIN_TIMEOUT_SECONDS
            while True:
                attachments = await app.state.runtime_service.activation.drain_attachments(
                    generation
                )
                resources = await app.state.runtime_service.drain_resources(generation)
                connectors = (
                    await app.state.connector_broker.drain_resources(generation)
                    if not attachments and not resources
                    else ()
                )
                # A missing activity lease is not evidence of owner completion.
                # Explicit refusal must retain the current directory qualifications.
                if (
                    not attachments
                    and not resources
                    and not connectors
                    and activities.seal(generation)
                ):
                    break
                if asyncio.get_running_loop().time() >= deadline:
                    _log.warning(
                        "content_directory_drain_blocked attachments=%s resources=%s "
                        "connectors=%s activity_counts=%s",
                        attachments,
                        resources,
                        connectors,
                        activities.snapshot().counts,
                    )
                    raise ContentError("content_directory_busy")
                await asyncio.sleep(DIRECTORY_DRAIN_POLL_SECONDS)
            # From here cancellation cannot be allowed to abandon requalification.
            # This section is synchronous and closes all owner IO before returning.
            transition_started = True
            owner.close()
            released = True
            if isinstance(command, AuthorizeRoot):
                _, preparing = acquire_startup_domains(
                    native,
                    coordinator,
                    discovery_roots,
                    read_current,
                    maintenance=True,
                    busy_timeout=DIRECTORY_LEASE_WAIT_SECONDS,
                )
                try:
                    with preparing.mutation():
                        plans = activities.run_maintenance(
                            generation, lambda: authorization_plans(command)
                        )
                except MaintenanceIncomplete:
                    owner.install(preparing)
                    released = False
                    raise
                finally:
                    if released:
                        preparing.close()
                source_roots = {
                    str(
                        Path(plan.source_path).parent
                        if plan.kind is AssetKind.FILE
                        else Path(plan.source_path)
                    )
                    for plan in plans
                }

                def read_authorization(held: DataInspection) -> StartupSources:
                    current = read_current(held)
                    return replace(
                        current,
                        roots=tuple(sorted(set(current.roots) | source_roots)),
                        project_directories=current.extended_project_directories(source_roots),
                    )

                _, exclusive = acquire_startup_domains(
                    native,
                    coordinator,
                    (*discovery_roots, *sorted(source_roots)),
                    read_authorization,
                    discovery_roles=app.state.startup_sources.project_roles(source_roots),
                    maintenance=True,
                    busy_timeout=DIRECTORY_LEASE_WAIT_SECONDS,
                )
                try:
                    with exclusive.mutation():

                        def authorize():
                            current = authorization_plans(command)
                            if tuple(
                                (row.project_id, row.source_path, row.kind, row.mount_path)
                                for row in current
                            ) != tuple(
                                (row.project_id, row.source_path, row.kind, row.mount_path)
                                for row in plans
                            ):
                                raise ContentError(ROOT_SOURCE_CHANGED_ERROR)
                            return publish_authorization(operation_id, command, current)

                        payload = activities.run_maintenance(generation, authorize)
                        if isinstance(command, AuthorizeRoot):
                            scan_project = str(payload["project_id"])
                        return payload
                except MaintenanceIncomplete:
                    owner.install(exclusive)
                    released = False
                    raise
                finally:
                    if released:
                        exclusive.close()
            if isinstance(
                command,
                (RevokeRoot, ForgetProject, ReconcileAuthorization, ReconcileProjectRemoval),
            ):
                _, exclusive = acquire_startup_domains(
                    native,
                    coordinator,
                    discovery_roots,
                    read_current,
                    maintenance=True,
                    busy_timeout=DIRECTORY_LEASE_WAIT_SECONDS,
                )
                try:
                    with exclusive.mutation():
                        if isinstance(command, ReconcileAuthorization):
                            return activities.run_maintenance(
                                generation, lambda: reconcile_authorization(operation_id, command)
                            )
                        if isinstance(command, (ForgetProject, ReconcileProjectRemoval)):

                            def forget():
                                if isinstance(command, ForgetProject):
                                    app.state.content.begin_project_forget(
                                        command.project_id, operation_id=operation_id
                                    )
                                return reconcile_project_removal(
                                    operation_id,
                                    (
                                        command
                                        if isinstance(command, ReconcileProjectRemoval)
                                        else None
                                    ),
                                )

                            return activities.run_maintenance(generation, forget)
                        return activities.run_maintenance(
                            generation,
                            lambda: app.state.content.commit_root_revocation(
                                command.root_id, command.project_id, operation_id=operation_id
                            ),
                        )
                except MaintenanceIncomplete:
                    owner.install(exclusive)
                    released = False
                    raise
                finally:
                    if released:
                        exclusive.close()
            creation = None
            provenance = None
            created_identity = None
            if isinstance(command, (CreateProject, ReconcileProjectCreation)):
                source, preparing = acquire_startup_domains(
                    native,
                    coordinator,
                    discovery_roots,
                    read_current,
                    maintenance=True,
                    busy_timeout=DIRECTORY_LEASE_WAIT_SECONDS,
                )
                try:
                    with preparing.mutation():
                        if isinstance(command, ReconcileProjectCreation):
                            completed = activities.run_maintenance(
                                generation,
                                lambda: app.state.content_catalog.operation_result(
                                    command.owner, operation_id
                                ),
                            )
                            if completed is not None and completed["state"] == "succeeded":
                                return completed["result"]
                            if (
                                completed is not None
                                and completed["error"] == PROJECT_CREATION_PRESERVED
                            ):
                                raise ContentError(PROJECT_CREATION_PRESERVED)

                        def creation_record():
                            if isinstance(command, ReconcileProjectCreation):
                                return app.state.content_catalog.resume_project_creation(
                                    operation_id, command.owner, now=command.recovery_at
                                )
                            plan = app.state.content.plan_project_creation(command.name)
                            if Path(plan.dir_root).parent != source.workspace:
                                raise DomainChangedError("project creation workspace changed")
                            return app.state.content_catalog.begin_project_creation(
                                operation_id, plan
                            )

                        provenance = activities.run_maintenance(generation, creation_record)
                        creation = provenance.plan
                        candidate = Path(creation.dir_root)
                        if candidate.parent != source.workspace:
                            raise DomainChangedError("project creation workspace changed")
                        if (
                            isinstance(command, ReconcileProjectCreation)
                            and creation.project_id != command.project_id
                        ):
                            raise DomainChangedError("project creation identity changed")
                    if provenance.directory_identity is None:
                        try:
                            created_identity = prepare_project_creation(
                                native, preparing, provenance, source.workspace
                            )
                        except LeaseError as error:
                            # A prior attempt may have published a receipt before dying.
                            # Existing entries must pass proof under candidate qualification.
                            if error.code != DIRECTORY_EXISTS_ERROR:
                                raise
                except MaintenanceIncomplete:
                    owner.install(preparing)
                    released = False
                    raise
                finally:
                    if released:
                        preparing.close()
            else:
                candidate = Path(command.path).expanduser().absolute()

            def read_candidate(held: DataInspection) -> StartupSources:
                current = read_current(held)
                if (
                    created_identity is not None
                    and held.selected(str(candidate))
                    and held.directory_identity(str(candidate)) != created_identity
                ):
                    raise DomainChangedError("created project directory was replaced")
                if provenance is not None and held.selected(str(candidate)):
                    verify_project_creation(native, held, provenance)
                extra = inspect_project_sources(held, (candidate,))
                projects = {entry.root: entry for entry in current.project_storage}
                projects.update((entry.root, entry) for entry in extra.projects)
                return replace(
                    current,
                    roots=tuple(sorted(set(current.roots) | set(extra.roots))),
                    project_directories=current.extended_project_directories(extra.roots),
                    project_storage=tuple(projects[root] for root in sorted(projects)),
                )

            for _ in range(DIRECTORY_PREPARATION_ATTEMPTS):
                prepared, exclusive = acquire_startup_domains(
                    native,
                    coordinator,
                    (*discovery_roots, str(candidate)),
                    read_candidate,
                    discovery_roles=app.state.startup_sources.project_roles((str(candidate),)),
                    maintenance=True,
                    busy_timeout=DIRECTORY_LEASE_WAIT_SECONDS,
                )
                try:
                    if creation is not None:
                        if provenance is None:
                            raise DomainChangedError("project creation provenance is missing")
                        verified_identity = verify_project_creation(native, exclusive, provenance)
                        with exclusive.mutation():
                            activities.run_maintenance(
                                generation,
                                lambda identity=verified_identity: (
                                    app.state.content_catalog.record_project_creation_identity(
                                        operation_id, identity
                                    )
                                ),
                            )
                            for relative in PROJECT_CREATION_DIRECTORIES:
                                prepare_private_directory(
                                    candidate,
                                    tuple(Path(relative).parts),
                                    role=DirectoryRole.PROJECT,
                                )
                    if startup_storage_needs_write(prepared):
                        with exclusive.mutation():
                            recovery_clock = (
                                command.recovery_at
                                if isinstance(command, ReconcileProjectCreation)
                                else None
                            )
                            if recovery_clock is not None and (
                                not isinstance(recovery_clock, int)
                                or isinstance(recovery_clock, bool)
                            ):
                                raise ValueError("invalid startup recovery timestamp")
                            initialize_startup_storage(
                                prepared,
                                recovery_at=recovery_clock,
                                recovery_id=(
                                    admission.recovery_id if recovery_clock is not None else None
                                ),
                            )
                    else:
                        adoption_name = command.name if isinstance(command, AdoptProject) else None
                        with exclusive.mutation():
                            result = activities.run_maintenance(
                                generation,
                                lambda adoption_name=adoption_name: (
                                    app.state.content.commit_project_creation(
                                        creation, operation_id=operation_id
                                    )
                                    if creation is not None
                                    else app.state.content.adopt_project(
                                        str(candidate), adoption_name, operation_id=operation_id
                                    )
                                ),
                            )
                        break
                except MaintenanceIncomplete:
                    # Preserve native occupancy together with the unresolved
                    # maintenance lease; shutdown cannot report a clean release.
                    owner.install(exclusive)
                    released = False
                    raise
                finally:
                    if released:
                        exclusive.close()
            else:
                raise RuntimeError("candidate project initialization did not converge")
            return result
        except (DomainReleaseError, BaseExceptionGroup):
            released = False
            raise
        finally:
            # Even a failed candidate must reacquire the authoritative catalog's
            # roots before admission resumes. Failure here deliberately stays sealed.
            if released:
                current, occupied = prepare_startup_domains(
                    native,
                    coordinator,
                    discovery_roots,
                    read_current,
                    startup_storage_needs_write,
                    lambda state: initialize_startup_storage(
                        state,
                        project_failed=seed.project_failures.__setitem__,
                    ),
                    qualification_failure=qualification_failure,
                    removed_roots=removed_project_roots,
                    busy_timeout=DIRECTORY_LEASE_WAIT_SECONDS,
                )
                owner.install(occupied)
                app.state.startup_sources = current
                for project in current.unavailable_projects:
                    if project.project_id:
                        app.state.content.block_project(project.project_id, project.reason)
            if not transition_started or released:
                activities.resume(generation)
                if scan_project is not None:
                    app.state.resource_version_supervisor.schedule_scan(scan_project)

    def maintain_storage_exclusively(generation: str) -> bool:
        # The worker owns the whole transition, including restoring qualification.
        # Its future is awaited by SessionMaintenanceService even during shutdown.
        released = False
        try:
            owner.close()
            released = True
            _, exclusive = acquire_startup_domains(
                native,
                coordinator,
                discovery_roots,
                read_current,
                maintenance=True,
                busy_timeout=0.0,
            )
            try:
                with exclusive.mutation():
                    return activities.run_maintenance(
                        generation, lambda: maintain_session_storage(SESSION_CATALOG_DB)
                    )
            except MaintenanceIncomplete:
                owner.install(exclusive)
                released = False
                raise
            finally:
                if released:
                    exclusive.close()
        except (DomainReleaseError, BaseExceptionGroup):
            released = False
            raise
        finally:
            # A failed release/reacquisition must leave admission sealed.
            if released:
                current, occupied = prepare_startup_domains(
                    native,
                    coordinator,
                    discovery_roots,
                    read_current,
                    startup_storage_needs_write,
                    lambda state: initialize_startup_storage(
                        state,
                        project_failed=seed.project_failures.__setitem__,
                    ),
                    qualification_failure=qualification_failure,
                    removed_roots=removed_project_roots,
                    busy_timeout=DIRECTORY_LEASE_WAIT_SECONDS,
                )
                owner.install(occupied)
                app.state.startup_sources = current
                for project in current.unavailable_projects:
                    if project.project_id:
                        app.state.content.block_project(project.project_id, project.reason)
                activities.resume(generation)

    async def maintain_storage() -> bool | None:
        generation = activities.begin_if_idle()
        if generation is None:
            return None
        started = time.monotonic()
        sealed_at: float | None = None
        transitioned = False
        try:
            deadline = asyncio.get_running_loop().time() + SCHEDULED_DRAIN_TIMEOUT_SECONDS
            while True:
                attachments = await app.state.runtime_service.activation.drain_attachments(
                    generation
                )
                resources = await app.state.runtime_service.drain_resources(generation)
                connectors = (
                    await app.state.connector_broker.drain_resources(generation)
                    if not attachments and not resources
                    else ()
                )
                if (
                    not attachments
                    and not resources
                    and not connectors
                    and activities.seal(generation)
                ):
                    break
                if asyncio.get_running_loop().time() >= deadline:
                    _log.info("session_storage_maintenance_deferred reason=busy")
                    return None
                await asyncio.sleep(DIRECTORY_DRAIN_POLL_SECONDS)
            transitioned = True
            sealed_at = time.monotonic()
            # This is not an untracked detached writer: the scheduler shields and
            # joins its callback before any application owner is shut down.
            return await await_storage_maintenance(lambda: maintain_storage_exclusively(generation))
        finally:
            if not transitioned:
                activities.resume(generation)
            finished = time.monotonic()
            _log.info(
                "session_storage_maintenance_admission elapsed_seconds=%s drain_seconds=%s "
                "sealed_seconds=%s phase=%s",
                finished - started,
                (sealed_at or finished) - started,
                finished - sealed_at if sealed_at is not None else None,
                activities.snapshot().phase.value,
            )

    session_maintenance = SessionMaintenanceService(activities, maintain_storage)
    app.state.session_maintenance = session_maintenance

    def recovery_admission(command: ContentCommand) -> RecoveryAdmission:
        catalog = app.state.content_catalog
        if isinstance(command, (ReconcileProjectCreation, ReconcileProjectRemoval)):
            project_id = command.project_id
        elif isinstance(command, ReconcileAuthorization):
            record = next(
                (
                    row
                    for row in catalog.authorization_reconciliations()
                    if row.root.root_id == command.root_id
                ),
                None,
            )
            if record is None:
                raise RuntimeError("authorization recovery identity is missing")
            project_id = record.root.project_id
        else:
            raise TypeError("unsupported project recovery command")
        current = app.state.startup_sources
        blocked = next(
            (row.reason for row in current.unavailable_projects if row.project_id == project_id),
            None,
        )
        return RecoveryAdmission(project_id, blocked)

    def recovery_failure(command: ContentCommand, error: Exception) -> str | None:
        # Only project IO/content failures may defer. Core ledger corruption and
        # native drain failures remain fatal rather than pretending recovery ran.
        if isinstance(
            error,
            (DomainReleaseError, DomainChangedError, sqlite3.DatabaseError, BaseExceptionGroup),
        ):
            return None
        if not isinstance(error, (OSError, ContentError)):
            return None
        reason = project_inspection_failure(error)
        if reason is None:
            return None
        selected = recovery_admission(command)
        app.state.content.block_project(selected.project_id, reason)
        project = next(
            (
                root
                for project_id, root in app.state.startup_sources.catalog.projects
                if project_id == selected.project_id
            ),
            None,
        )
        if project is not None:
            seed.project_failures[project] = reason
        return reason

    async def execute_with_recovery_scope(operation_id: str, command: ContentCommand):
        if isinstance(
            command, (ReconcileProjectCreation, ReconcileProjectRemoval, ReconcileAuthorization)
        ):
            selected = recovery_admission(command)
            with app.state.content.recovery(selected.project_id):
                return await execute_command(operation_id, command)
        return await execute_command(operation_id, command)

    operations = ContentOperations(
        activities,
        execute_with_recovery_scope,
        app.state.content_catalog,
        recovery_at=admission.recovery_at,
        recovery_admission=recovery_admission if snapshot.isolated_projects else None,
        recovery_failure=recovery_failure if snapshot.isolated_projects else None,
        recovery_state=app.state.content.set_recovery_state if snapshot.isolated_projects else None,
    )
    app.state.content_operations = operations

    async def link_import(job: ImportJob) -> None:
        await operations.execute(
            job.owner_id, LinkImport(job.job_id, job.owner_id, job.lease_generation)
        )

    app.state.resource_imports.bind_linker(link_import)

    async def close_storage_and_operations() -> None:
        failures: list[BaseException] = []
        if default_project_task is not None:
            default_project_task.cancel()
            result = await asyncio.gather(default_project_task, return_exceptions=True)
            if isinstance(result[0], Exception):
                failures.append(result[0])
        try:
            with app.state.shutdown.stage(SessionMaintenanceService.aclose.__qualname__):
                await session_maintenance.aclose()
        except BaseException as error:
            failures.append(error)
        try:
            with app.state.shutdown.stage(ShutdownStage.OPERATIONS):
                await operations.aclose()
        except BaseException as error:
            failures.append(error)
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise BaseExceptionGroup("session storage and operations shutdown failed", failures)

    previous_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        admission = application.state.workbench_admission
        try:
            admission.start(activities.workbench_changed)
            async with previous_lifespan(application):
                await session_maintenance.start()
                try:
                    yield
                finally:
                    await close_storage_and_operations()
        finally:
            try:
                if not operations.closed:
                    await close_storage_and_operations()
            finally:
                with application.state.shutdown.stage(ShutdownStage.ADMISSION):
                    await admission.aclose()

    app.router.lifespan_context = lifespan
    return app


def _compose_app(
    snapshot: StartupSources,
    *,
    features: ProductFeatures,
    browser_host_client: BrowserHostClient,
    prepare: Callable[[], Awaitable[None]] | None = None,
    admission: WorkbenchAdmission | None = None,
    product: str,
    renderer_dist: str,
    office_root: str,
    cors_origins: list[str] | None,
    auth: bool | None,
    auth_mode: str | None,
    ownership_axis: str | None,
    local_bridge_root: Path | None,
    runtime_discovery: RuntimeDiscovery,
) -> FastAPI:
    require_qualified_project_locations(snapshot)
    settings = SettingsService()
    workspace = snapshot.workspace
    if runtime_discovery.sandbox_resources is not None:
        runtime_discovery = replace(
            runtime_discovery,
            sandbox_resources=runtime_discovery.sandbox_resources.with_workspace(
                workspace, metadata_directories=(SCHOLARSEED_HOME, SERVICE_DIR, SESSION_RUNTIME_DIR)
            ),
        )
    selected_product = (product or PRODUCT_ALL).strip().lower()
    catalog = ContentCatalog(CONTENT_DB)
    registry = ProjectRegistry(
        str(workspace),
        catalog,
        unavailable_roots=frozenset(str(project.root) for project in snapshot.unavailable_projects),
    )
    for project in snapshot.unavailable_projects:
        if project.project_id:
            registry.block(project.project_id, project.reason)
    admission = admission if admission is not None else WorkbenchAdmission(native_guardian())
    activities = Activities(workbench_ready=lambda: admission.ready)
    content = ContentService(registry, catalog, activities=activities)
    writer = ResourceWriter(content)
    resource_retention = ResourceRetentionService(content, settings)
    format_policy = WorkbenchFormatPolicy()
    literature_repository = LiteratureRepository()
    prune_download_results()
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
        activities=activities,
    )
    resource_versions.bind_admission_policy(version_supervisor)
    resource_deliveries = ResourceDeliveryService(
        content, resource_versions, version_supervisor, activities=activities
    )
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
        prune_download_results(project_id)

    content.bind_project_forget_sink(drop_project_links)
    resource_imports = ResourceImportJobService(
        content, ImportJobStore(RESOURCE_IMPORTS_DB), activities=activities
    )
    app = create_chat_app(
        workspace,
        settings=settings,
        lifecycles=(version_supervisor, resource_imports),
        recovery_at=admission.recovery_at,
        prepare=prepare,
        resource_deliveries=resource_deliveries,
        resource_review_batches=resource_review_batches,
        ownership_axis=ownership_axis,
        formats=format_policy,
        activities=activities,
        runtime_discovery=runtime_discovery,
    )
    app.state.workbench_admission = admission
    app.state.browser_host_client = browser_host_client
    app.state.product_features = features

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
    cards.register(NEXT_STEPS_CARD, validate_next_steps_card)
    cards.register(LITERATURE_REFERENCES_CARD, validate_references_card)
    cards.register(
        SEARCH_CARD,
        validate_search_card,
        direct=False,
        slot=search_card_slot,
    )
    cards.register(
        DELIVERY_CARD,
        validate_delivery_card,
        direct=False,
        slot=delivery_card_slot,
    )
    cards.register(
        DOWNLOADS_CARD,
        validate_download_card,
        direct=False,
        slot=download_card_slot,
    )
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
        activities=activities,
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
    browser_search_router = register_browser_search_routes(
        app, invocation_service, browser_host_client, activities=activities
    )
    app.state.literature_searches = LiteratureSearchService(
        invocation_service, activities=activities
    )

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

    pdf_indexes = PdfIndexService(content, assistant_store.database, activities=activities)
    index_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def with_pdf_indexes(application: FastAPI):
        try:
            async with index_lifespan(application):
                yield
        finally:
            with application.state.shutdown.stage(ShutdownStage.INDEXES):
                await pdf_indexes.aclose()

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
        fulltexts=ManagedFulltexts(),
    )
    app.state.runtime_service.bind_answer_filter(app.state.assistant_citations.filter_answer)
    app.state.runtime_service.bind_answer_guard(protect_answer)
    app.state.fulltext_authorizer = FulltextAuthorizer(
        assistant_store.database, app.state.session_catalog
    )
    app.state.fulltext_gate = FulltextGate(
        app.state.fulltext_authorizer, app.state.turn_service, activities=activities
    )
    app.state.runtime_service.bind_activity_observer(app.state.fulltext_gate.observe)
    context_providers: dict[ContextRefKind, AssistantContextProvider] = {
        ContextRefKind.FILE: content_context,
        ContextRefKind.DIR: content_context,
        ContextRefKind.LITERATURE: literature_context,
        ContextRefKind.SESSION: session_context,
        ContextRefKind.NOTE: annotation_service,
        ContextRefKind.SELECTION: selection_context,
    }
    app.state.content_catalog = catalog
    app.state.content = content
    app.state.pdf_records = annotation_store
    # 文献域删除附件时要顺带丢掉由该文件派生的全文索引缓存; 它只认这个端口,
    # 不直接依赖 Workbench 的实现。
    setattr(app.state, PDF_INDEX_STATE, pdf_indexes)
    content.bind_artifact_scope(
        ArtifactScopeKind.SESSION, SessionArtifactStorage(app.state.session_catalog).resolve
    )
    publications = PublicationService(content)
    app.state.session_service.bind_deletion(SessionDeletion(content, publications).delete)
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
        active_document_resolvers={
            ContextRefKind.FILE: content_context,
            ContextRefKind.LITERATURE: literature_context,
        },
    )
    history_router = register_history_routes(
        app, app.state.session_service, history, app.state.assistant, activities=activities
    )
    mcp_router = register_mcp_bridge(
        app,
        app.state.session_service,
        app.state.mcp_service,
        app.state.mcp_plan_service,
        activities=activities,
    )
    artifact_router = register_artifact_routes(app, resolve_artifact_caller, activities=activities)
    skill_router = register_skill_admission(
        app, resolve_skill_caller, app.state.runtime_service, activities=activities
    )
    skill_management_router = register_skill_management(
        app, app.state.session_service, app.state.skill_management, activities=activities
    )
    evidence_router = register_card_bridge(
        app, app.state.session_service, app.state.fulltext_authorizer, activities=activities
    )
    card_router = register_card_routes(
        app, resolve_display_card_caller, cards, activities=activities
    )
    result_router = register_result_routes(
        app,
        app.state.session_service,
        app.state.session_catalog,
        ResultStatusService(),
        app.state.product_events,
        app.state.artifact_service,
        app.state.fulltext_gate,
        app.state.fulltext_authorizer,
        activities=activities,
    )
    acquire_router = register_acquire_routes(
        app,
        app.state.session_service,
        app.state.fulltext_authorizer,
        project_for_session,
        activities=activities,
    )
    delivery_service = DeliveryService(content, writer, literature_repository)
    app.state.session_service.bind_task_documents(delivery_service.task_documents)
    delivery_router = register_delivery_routes(
        app,
        app.state.session_service,
        app.state.session_catalog,
        delivery_service,
        project_for_session,
        activities=activities,
    )
    download_router = register_download_routes(
        app, app.state.session_service, app.state.session_catalog, activities=activities
    )
    receipt_router = register_receipt_routes(
        app, app.state.session_service, app.state.fulltext_authorizer, activities=activities
    )
    plan_router = register_plan_routes(app, app.state.session_service, activities=activities)
    contract_router = register_contract_routes(app, resolve_artifact_caller, activities=activities)
    search_router = register_conversation_search_routes(
        app,
        app.state.session_service,
        SearchService(invocation_service),
        lambda session_id, turn_id: (
            (snapshot := citation_snapshot(session_id, turn_id)) is not None
            and snapshot.search_scope is SearchScope.WEB
        ),
        activities=activities,
    )
    task_router = register_task_routes(app, app.state.session_service, activities=activities)
    review_router = register_literature_review_routes(
        app, app.state.session_service, app.state.fulltext_gate, activities=activities
    )
    citation_router = register_citation_bridge(
        app,
        app.state.session_service,
        app.state.assistant_citations,
        app.state.fulltext_authorizer,
        PdfMaterializer(content),
        activities=activities,
    )
    library_projection = LibraryLinkProjection(
        content, app.state.session_catalog, app.state.product_events
    )
    app.state.assistant_literature = AssistantLiteratureService(
        content, app.state.artifact_service, project_for_session, library_projection
    )
    # curation 的 fulltext-attach 要把会话 artifact 的字节交给附件域 owner, 所以它显式
    # 依赖 assistant 层 (而不是从 app.state 摸字符串键): 构造顺序因此提前到这里。
    curation_router = register_curation_bridge(
        app,
        app.state.session_service,
        assistant=app.state.assistant_literature,
        activities=activities,
    )
    resource_bridge_router = register_resource_bridge(
        app,
        app.state.session_service,
        content,
        activities=activities,
        snapshot_by_id=assistant_store.snapshot_by_id,
    )
    agent_imports = ResourceAgentImportCatalog(content)
    content.bind_relocation_sink(agent_imports.relocate)
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
    literature_import_router = register_literature_import_bridge(
        app, app.state.session_service, app.state.assistant_literature, activities=activities
    )
    resource_import_router = register_resource_import_bridge(
        app, app.state.session_service, app.state.assistant_resources, activities=activities
    )
    resource_queries = ResourceQueries(content, resource_versions)
    literature_queries = LiteratureQueries(literature_repository)
    taxonomy_router = register_taxonomy_bridge(
        app,
        app.state.session_service,
        LiteratureTaxonomyService(literature_repository),
        activities=activities,
    )
    project_queries_router = register_project_queries(
        app,
        app.state.session_service,
        {
            ("resource", "search"): resource_queries.search,
            ("resource", "stat"): resource_queries.stat,
            ("resource", "versions"): resource_queries.versions,
            ("resource", "diff"): resource_queries.diff,
            ("literature", "search"): literature_queries.search,
            ("literature", "detail"): literature_queries.detail,
        },
        activities=activities,
    )
    browser_router = register_browser_routes(
        app, app.state.session_service, app.state.browser_host_client, activities=activities
    )
    browser_history_router = register_browser_history_routes(
        app, app.state.session_service, app.state.browser_host_client, activities=activities
    )
    if local_bridge_root is not None:
        bridge_router = APIRouter()
        bridge_router.include_router(history_router)
        bridge_router.include_router(mcp_router)
        bridge_router.include_router(artifact_router)
        bridge_router.include_router(skill_router)
        bridge_router.include_router(skill_management_router)
        bridge_router.include_router(card_router)
        bridge_router.include_router(result_router)
        bridge_router.include_router(acquire_router)
        bridge_router.include_router(delivery_router)
        bridge_router.include_router(download_router)
        bridge_router.include_router(receipt_router)
        bridge_router.include_router(review_router)
        bridge_router.include_router(plan_router)
        bridge_router.include_router(contract_router)
        bridge_router.include_router(search_router)
        bridge_router.include_router(browser_search_router)
        bridge_router.include_router(task_router)
        bridge_router.include_router(evidence_router)
        bridge_router.include_router(citation_router)
        bridge_router.include_router(curation_router)
        bridge_router.include_router(resource_bridge_router)
        bridge_router.include_router(literature_import_router)
        bridge_router.include_router(resource_import_router)
        bridge_router.include_router(project_queries_router)
        bridge_router.include_router(taxonomy_router)
        bridge_router.include_router(browser_router)
        bridge_router.include_router(browser_history_router)
        original_lifespan = app.router.lifespan_context

        @asynccontextmanager
        async def lifespan(application: FastAPI):
            async with local_listener(
                bridge_router, local_bridge_root, shutdown=application.state.shutdown
            ) as endpoint:
                application.state.runtime_service.bind_local_socket(endpoint)
                try:
                    async with original_lifespan(application):
                        yield
                finally:
                    application.state.runtime_service.bind_local_socket(None)

        app.router.lifespan_context = lifespan
    direct_model = InferenceProvider(app.state.model_service)
    app.state.assistant_actions = AssistantActionService(
        assistant_invocations,
        activities=activities,
        model=direct_model,
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
    app.state.resource_search = ResourceSearchService(
        app.state.skill_credentials, activities, OfficialSearchClient()
    )
    app.state.resource_search_fallback = ResourceSearchFallback(
        invocation_service,
        lambda: (app.state.skill_credentials.revision, app.state.account_tokens.revision),
        permission=lambda: app.state.runtime_service.permission_intent(
            RuntimePermissionMode(app.state.settings_service.permission_mode())
        ),
    )
    register_resource_search_routes(app)
    register_resource_import_routes(app)
    register_version_routes(app)
    register_version_setting_routes(
        app,
        settings=settings,
        retention=resource_retention,
        supervisor=version_supervisor,
    )
    register_global_routes(app)
    register_papermeta_routes(app)
    literature_pdf = LiteraturePdf(literature_repository)
    register_reading_routes(
        app,
        literature_repository,
        literature_attachments,
        literature_pdf,
        format_policy,
    )
    app.state.turn_service.bind_titles(
        SessionTitles(app.state.session_catalog, app.state.product_events, direct_model, activities)
    )
    app.state.runtime_service.bind_citation_coverage(
        CitationCoverage(
            web_fetcher,
            direct_model,
            lambda session_id, turn_id: (
                (snapshot := citation_snapshot(session_id, turn_id)) is not None
                and snapshot.search_scope is SearchScope.WEB
            ),
        )
    )
    direct_actions = AssistantActionService(
        assistant_invocations,
        activities=activities,
        model=direct_model,
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
        activities=activities,
        actions=direct_actions,
        tasks=assistant_invocations,
        models=app.state.model_service,
        pdf=literature_pdf,
        content=content,
        indexes=pdf_indexes,
    )
    register_workbench_routes(app)
    register_selection_action_routes(app)
    register_assistant_routes(app)
    register_invocation_routes(app)
    register_literature_search_routes(app)
    register_search_routes(app)

    auth_enabled = (
        enabled_for_mode(
            auth_mode or AUTH_MODE_AUTO, bool(decode_auth_data(snapshot.auth_data)["users"])
        )
        if auth is None
        else bool(auth)
    )
    try:
        register_auth(
            app,
            activities=activities,
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

    mount_renderer(app, renderer_dist, office_root)
    return app


__all__ = [
    "PRODUCT_ALL",
    "PRODUCT_CHAT",
    "PRODUCT_CHOICES",
    "create_app",
    "resolve_workspace_root",
]
