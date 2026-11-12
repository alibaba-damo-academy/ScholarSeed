"""Product runtime live ownership."""

from __future__ import annotations

import asyncio
import inspect
import json
import mimetypes
import secrets
import uuid
from dataclasses import asdict, replace
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from damoatrace.recording.redaction import SECRET_KEYS
from scholarseed_runtime.contract import (
    CallbackAudience,
    CallbackKind,
    CapabilitySet,
    CommandState,
    InterruptRequest,
    InventoryKind,
    InventoryRequest,
    ModelThinking,
    PermissionIntent,
    RuntimeBinding,
    RuntimeCallbackRequest,
    RuntimeCallbackResponse,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimePermissionMode,
    RuntimeSession,
    RuntimeValue,
    SteerRequest,
    TerminateSessionRequest,
    TurnRequest,
)
from scholarseed_runtime.contract.artifact import ArtifactRole
from scholarseed_runtime.contract.command import (
    EmptyThreadReplacementProof,
    SkillConfiguration,
    SubmissionRetryProof,
    ThreadReplacementProof,
)
from scholarseed_runtime.contract.content import (
    PUBLIC_REASONING_SUMMARY,
    REASONING_SOURCE,
    REASONING_SUMMARY_INDEX,
)
from scholarseed_runtime.contract.event import ActorKind
from scholarseed_runtime.contract.evidence import (
    RuntimeProcessEvent,
    RuntimeRpcEvidence,
    RuntimeTimingPort,
)
from scholarseed_runtime.contract.history import HistoryEntry, MessagePhase
from scholarseed_runtime.contract.incident import (
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
)
from scholarseed_runtime.contract.input import InputKind
from scholarseed_runtime.contract.input import TurnAdmission as RuntimeTurnAdmission
from scholarseed_runtime.contract.input import TurnInput
from scholarseed_runtime.contract.inventory import SkillInventory
from scholarseed_runtime.contract.permission import PERMISSION_MODE_KEY
from scholarseed_runtime.contract.resource import ResourceReceipt
from scholarseed_runtime.contract.session import SuspendState, ThreadReplacementTarget
from scholarseed_runtime.gateway.driver import RuntimeDriver, RuntimeObservation, RuntimeTurnResult
from service.capabilities.domain import COMPONENT_ANSWER_CAPABILITY
from service.capabilities.service.components import ComponentRegistry
from service.capabilities.service.delivery import INSTALLATION_FIELD, validate_receipt
from service.capabilities.service.descriptor import validate_component_value
from service.capabilities.service.plugins import PLUGIN_DISPLAY_PREFIX, PLUGIN_QUESTION_SLOT
from service.capabilities.service.presentation import TurnSkillBinding
from service.capabilities.service.skills import SkillCatalog, load_skill_state
from service.chat.constants import (
    AUTOMATIC_RECOVERY_MESSAGE,
    GENERIC_PROVIDER_FAILURE_CODE,
    HIL_STATE_CANCELLED,
    HIL_STATE_RESOLVED,
    PRODUCT_EVENT_ANSWER_SOURCES,
    PRODUCT_EVENT_ARTIFACT_CHANGED,
    PRODUCT_EVENT_ARTIFACT_DECLARED,
    PRODUCT_EVENT_ARTIFACT_FAILED,
    PRODUCT_EVENT_ARTIFACT_REMOVE,
    PRODUCT_EVENT_ARTIFACT_UPSERT,
    PRODUCT_EVENT_CONTEXT_COMPACTED,
    PRODUCT_EVENT_DISPLAY_CARD,
    PRODUCT_EVENT_FILE_CHANGED,
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_MESSAGE_REMOVED,
    PRODUCT_EVENT_MODEL_CAPABILITY_RESOLUTION,
    PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
    PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED,
    PRODUCT_EVENT_NATIVE_SOURCES,
    PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
    PRODUCT_EVENT_REASONING_COMPLETED,
    PRODUCT_EVENT_REASONING_DELTA,
    PRODUCT_EVENT_RUNTIME_INCIDENT,
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_SESSION_TITLE_UPDATED,
    PRODUCT_EVENT_SKILL_STARTED,
    PRODUCT_EVENT_SOURCE_CANDIDATES,
    PRODUCT_EVENT_SUBAGENT_COMPLETED,
    PRODUCT_EVENT_SUBAGENT_FAILED,
    PRODUCT_EVENT_SUBAGENT_INTERRUPTED,
    PRODUCT_EVENT_SUBAGENT_SPAWNED,
    PRODUCT_EVENT_SUBAGENT_STARTED,
    PRODUCT_EVENT_SUBAGENT_STATUS_CHANGED,
    PRODUCT_EVENT_TOOL_COMPLETED,
    PRODUCT_EVENT_TOOL_OUTPUT_DELTA,
    PRODUCT_EVENT_TOOL_STARTED,
    PRODUCT_EVENT_UPDATE_SHUTDOWN_PREPARED,
    PRODUCT_EVENT_USAGE_UPDATED,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
    PRODUCT_RECOVERY_BLOCKED_KEY_PREFIX,
    PRODUCT_REFERENCE_DIRECTORY,
    PRODUCT_REFERENCE_FILE,
    PRODUCT_REFERENCE_ORIGIN_LOCAL_DIRECTORY,
    PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE,
    PRODUCT_REFERENCE_SKILL,
    PRODUCT_SESSION_STATE_CLOSED,
    PRODUCT_SESSION_STATE_FAILED,
    PRODUCT_SESSION_STATE_IDLE,
    PRODUCT_SESSION_STATE_RUNNING,
    PRODUCT_SESSION_STATE_WAITING,
    QUEUED_DISPLAY_TEXT,
    QUEUED_REFERENCES,
    SESSION_RENAME_MAX_LENGTH,
    SESSION_TITLE_DEFAULT,
    SSE_BACKPRESSURE_EVENT,
    USER_MESSAGE_BINDING_ADMITTED,
    USER_MESSAGE_BINDING_BOUND,
    USER_MESSAGE_BINDING_CANCELLED,
    USER_MESSAGE_ORIGIN_RECOVERY,
    USER_MESSAGE_ORIGIN_TURN,
    USER_MESSAGE_ORIGINS,
)
from service.chat.persistence.artifacts import ArtifactSource, ArtifactStatus, SessionArtifactStore
from service.chat.persistence.catalog import (
    INITIAL_PRODUCT_SEQUENCE,
    QUEUE_PURPOSE_RECOVERY,
    HilStatus,
    QueuedMessageRecord,
    SessionAccessError,
    SessionCatalogStore,
    SessionStatus,
)
from service.chat.persistence.events import (
    MAXIMUM_REPLAY_LIMIT,
    ProductEventRecord,
    ProductEventStore,
    upcast_product_event,
)
from service.chat.persistence.publications import PublicationRecord
from service.chat.persistence.worker import PersistenceWorker
from service.chat.provenance import MODEL_RUN_FIELD, ModelRun
from service.chat.runtime.content import MessageSnapshots
from service.chat.runtime.evidence import (
    RUNTIME_EVIDENCE_LIMIT,
    TRACE_FAILURES,
    SessionTrace,
    TraceRecordingError,
    decode_evidence,
)
from service.chat.runtime.extensions import EXTENSION_PROJECTIONS
from service.chat.runtime.history import _merge_history_entries
from service.chat.runtime.incidents import event_incident
from service.chat.runtime.interaction import SessionInteractions, interaction_snapshot
from service.chat.runtime.inventory import _skill_inventory_from_runtime
from service.chat.runtime.ledger import SessionLedger
from service.chat.runtime.permission import session_permission
from service.chat.runtime.projection import (
    ARTIFACT_CHANGE_DELETE,
    ARTIFACT_CHANGE_TYPES,
    ARTIFACT_CHANGE_UPDATE,
    ARTIFACT_DEFAULT_ROLE,
    ARTIFACT_PUBLISH_ACCESS_DENIED,
    ARTIFACT_PUBLISH_FILE_NOT_FOUND,
    ARTIFACT_PUBLISH_IO_FAILED,
    ARTIFACT_PUBLISH_PATH_INVALID,
    COLLABORATION_ACTIVITY_TYPE,
    COLLABORATION_CLOSURE_REASON,
    COLLABORATION_CLOSURE_STATUS,
    COLLABORATION_EVENT_KINDS,
    COLLABORATION_LIFECYCLE_KINDS,
    FILE_HASH_CHUNK_BYTES,
    INTERNAL_EVENT_KEY_PREFIX,
    PORTABLE_ASSISTANT_ROLE,
    PORTABLE_HISTORY_ROLES,
    RUNTIME_DECISION_LABELS,
    RUNTIME_EXTENSION_KIND_KEY,
    RUNTIME_INCIDENT_FAILED_STATE,
    RUNTIME_INCIDENT_MANUAL_RETRY_STRATEGY,
    RUNTIME_INCIDENT_PROTOCOL_SCOPE,
    RUNTIME_INCIDENT_STREAM_GAP_KIND,
    RUNTIME_INCIDENT_UNKNOWN_RETRYABILITY,
    RUNTIME_NATIVE_ACTIVITY_PRODUCT_EVENTS,
    RUNTIME_STREAM_GAP_ERROR,
    ArtifactPublishError,
    artifact_payload,
    artifact_snapshot_payload,
)
from service.chat.runtime.tools import SERVICE_TOOL_CAPABILITIES, execute_service_tool
from service.chat.runtime.utils import integer, optional_integer
from service.chat.service.cards import (
    DISPLAY_CARD_IDEMPOTENCY_PREFIX,
    DISPLAY_CARD_MAX_BYTES_PER_TURN,
    DISPLAY_CARD_TURN_BYTES,
    CardRegistry,
    DisplayCardError,
    card_identity,
    normalize_card,
)
from service.chat.service.coverage import CitationCoverage, CoverageStatus, merge_review
from service.chat.service.estimate import SkillDurationEstimator
from service.chat.service.plan import SessionPlans
from service.chat.service.provenance import MESSAGE_ITEM, SEARCH_ITEM
from service.chat.service.publication import PublicationCommand, PublicationService
from service.chat.service.receipts import search_receipts
from service.chat.service.recording import RecordingService
from service.chat.service.rejections import terminal_provider_failure
from service.chat.service.sources import answer_sources
from service.chat.service.tasks import ProductTaskLease, restore_task_binding
from service.content.domain.model import ContentError
from service.inference.source import ContentSource, SourceReference
from service.persistence.project import inspect_database
from service.platform.activity import Activities, ActivityDomain, ActivityLease
from service.platform.bridge import (
    BRIDGE_TOKEN_BYTES,
    COMPONENT_CARD_TYPE,
    COMPONENT_HOST_PLUGIN,
    COMPONENT_REQUEST_MARKER,
    COMPONENT_SCHEMA_DEFAULT,
    PLAN_SOURCE,
    PLUGIN_INSTALL_CAPABILITY,
    ComponentInvocation,
    DisplayCardContent,
    PlanCommand,
    PluginInstallation,
)
from service.platform.citations import CitationAnswerFilter
from service.platform.context import ContextOrigin, ContextRefKind, ContextResolutionState
from service.platform.files import FILE_ACCESS_DENIED, file_access_code
from service.platform.resources import AgentResourceChangeSink
from service.platform.storage import filesystem_path

READ_ONLY_TOOL_NAME = "read"
PENDING_HIL_BLOCKER = "pending_hil"
SUSPEND_CLOSING_BLOCKER = "closing"
RUNTIME_ACTIVITY_UNAVAILABLE_BLOCKER = "runtime_activity_unavailable"
STRUCTURED_PLAN_TURN_CONTEXT = (
    "ScholarSeed has an existing structured conversation plan. Before substantive work in "
    "this turn, call update_plan with operation=get using its declared tool contract. "
    "If the user is continuing that task, record execution state for the same plan_id "
    "with the returned turn_id before continuing its work; preserve unrelated step states. "
    "If the request is unrelated, "
    "do not claim the old plan belongs to it. This is product context, not user text."
)

SessionActivityObserver = Callable[["LiveSession"], None]


PROGRESS_BATCH_BYTE_LIMIT = 1024 * 1024


class LiveSession:
    """One product session bound to exactly one typed runtime adapter."""

    def __init__(
        self,
        *,
        session_id: str,
        runtime_id: str,
        runtime_workdir: Path,
        project_path: Path | None,
        output_root: Path,
        model_id: str,
        catalog: SessionCatalogStore,
        events: ProductEventStore,
        artifacts: SessionArtifactStore,
        skills: SkillCatalog,
        logger: Any,
        trace: SessionTrace | None = None,
        recording: RecordingService | None = None,
        trace_secrets: tuple[str, ...] = (),
        process_environment: Mapping[str, str] | None = None,
        user_id: str = "",
        on_release: Callable[[str], Any] | None = None,
        on_suspend: Callable[[str], Awaitable[Any]] | None = None,
        project_id: str = "",
        resource_changes: AgentResourceChangeSink | None = None,
        local_socket: Path | None = None,
        network_domains: tuple[str, ...] = (),
        publications: PublicationService | None = None,
        cards: CardRegistry | None = None,
        reasoning_effort: str = "",
        thinking: ModelThinking | None = None,
        activity_observer: SessionActivityObserver | None = None,
        answer_filter: CitationAnswerFilter | None = None,
        citation_coverage: CitationCoverage | None = None,
        answer_guard: Callable[[str, bool], str] | None = None,
        skill_inventory_provider: Callable[[Path], Awaitable[SkillInventory]] | None = None,
        recover_empty: (
            Callable[[EmptyThreadReplacementProof], Awaitable[RuntimeTurnAdmission]] | None
        ) = None,
        rebuild_thread: (
            Callable[[ThreadReplacementTarget], Awaitable[ThreadReplacementProof]] | None
        ) = None,
    ) -> None:
        self.turn_activity: ActivityLease | None = None
        self.attachment_activity: ActivityLease | None = None
        self.id = session_id
        self.recover_empty = recover_empty
        self.rebuild_thread = rebuild_thread
        self.replacement_proof: EmptyThreadReplacementProof | ThreadReplacementProof | None = None
        self.thread_replacement_proof: ThreadReplacementProof | None = None
        self.replacement_revision: tuple[object, ...] | None = None
        self.submission_retry_authorizer: (
            Callable[[SubmissionRetryProof], Awaitable[Callable[[], bool]]] | None
        ) = None
        self.bridge_token = secrets.token_urlsafe(BRIDGE_TOKEN_BYTES)
        self.held_model_bridge_id = ""
        self.browser_scope_instance = secrets.token_hex(16)
        self._browser_scope: (
            tuple[dict[str, object], dict[str, Callable[[], Awaitable[dict[str, object]]]]] | None
        ) = None
        self._browser_scope_lock = asyncio.Lock()
        self._browser_delivery_lock = asyncio.Lock()
        self._browser_scope_end_pending = False
        self.local_socket = local_socket
        self.network_domains = network_domains
        if not runtime_id.strip():
            raise ValueError("runtime id must not be empty")
        self.runtime_id = runtime_id.strip().lower()
        self.runtime_workdir = runtime_workdir.expanduser().resolve()
        self.project_path = project_path.expanduser().resolve() if project_path else None
        self.output_root = output_root.expanduser().resolve()
        self.model_id = model_id
        self.model_run: ModelRun | None = None
        self._running_model: ModelRun | None = None
        self._turn_models = events.model_runs(session_id)
        self.reasoning_effort = reasoning_effort
        self.thinking = thinking
        # 该会话当前授权的额外可写根 (来自 content 域的 external_roots)。
        self.writable_roots: tuple[Path, ...] = ()
        # 当前 vendor thread 实际绑定的权限模式 (产品口径的 mode id, 由 SessionService 维护)。
        # 与 catalog 的 policy_id 分开: policy_id 是用户的选择, 可以随时改; 换 sandbox/审批策略
        # 却要重开 thread, 跑着 turn 时只能等 turn 边界。空串表示未知, 按需重开一次即收敛。
        # 只在进程内有效 —— 会话重开一定按 policy_id 绑定, 两者天然一致。
        self.applied_permission_mode = ""
        self.applied_permission_turn_id = ""
        self.permission_switch_warning = ""
        self.skill_configurations: tuple[SkillConfiguration, ...] = ()
        # 会话进程要额外带上的环境变量 (App Server 与 skill 共用的 SCHOLARSEED_API_KEY)。挂在会话上而非只在
        # open 的参数里: relocate 走 rebind → _resume 重开 vendor thread, 那条路上没有
        # 用户凭据可重新签发, 环境必须跟着会话一起搬。
        self.process_environment: dict[str, str] = dict(process_environment or {})
        # 真实账号身份, 用于网关用量归属与凭据缓存键控 —— **不是**数据归属身份 (归属由
        # session_catalog.principal_id 承担, 可以是机器级的)。挂在会话上而非只在 open 的
        # 参数里：relocate 走 rebind → _resume 重建 bridge 注册，那条路上拿不到请求上下文，
        # 计量身份必须跟着会话一起搬。
        # （只存 user_id，**不存 token** —— token 由 AccountTokenHolder 持有、调用时现取。）
        self.user_id = str(user_id or "")
        self.project_id = project_id
        self._publications = publications
        self._cards = cards or CardRegistry()
        self._resource_changes = resource_changes
        # 会话关闭时需要掉的进程内资源（当前是 bridge 注册项，内含 api_key）。仅靠 TTL
        # 惰性淘汰会让已关闭会话的凭据再可用几小时；关闭即摘才是真正框住窗口的那一步。
        self._on_release = on_release
        self._on_suspend = on_suspend
        self.runtime_session: RuntimeSession | None = None
        self.runtime_driver: RuntimeDriver | None = None
        self.runtime_binding: RuntimeBinding | None = None
        self.vendor_thread_id = ""
        self.resumed = False
        self.subscribers: list[asyncio.Queue[dict[str, Any]]] = []
        self.lifecycle_lock = asyncio.Lock()
        self.activation_lock = asyncio.Lock()
        self.attachment_generation = 0
        self.resource_task: asyncio.Task[Any] | None = None
        self.submission_tasks: set[asyncio.Task[Any]] = set()
        self.waiting_request_id = ""
        self.waiting_resources = False
        self.turn_lock = asyncio.Lock()
        self.steer_lock = asyncio.Lock()
        self.interrupting = False
        self.interrupt_generation = 0
        self.terminating = False
        self.termination_task: asyncio.Task[Any] | None = None
        self.terminated = False
        self.last_interrupt_succeeded: bool | None = None
        self.current_task: asyncio.Task[Any] | None = None
        self.settlement_observer: Callable[[LiveSession], None] | None = None
        self.last_submission_id = ""
        self.recovery_observer: Callable[[LiveSession, RuntimeEvent], Awaitable[None]] | None = None
        # 当前已准入的**产品轮** id（= ``client_user_message_id``），出站计量的轮粒度真值：
        # bridge 每次模型调用按 session_id 反查它去填 ``X-Deeprd-Conv-Turn-id``。它与
        # ``ledger.active_turn_id`` 不是一回事 —— 后者是 vendor 轮 id，要等 Codex 的 turnStarted
        # 事件回来才落定，而这一轮的模型调用那时可能已经打出去了（会记到上一轮头上）。
        self.active_product_turn_id = ""
        self._model_bridge_failure: tuple[str, dict[str, Any]] | None = None
        self.active_assistant_snapshot_id = ""
        self.active_assistant_revision: int | None = None
        self.active_task_type = ""
        self.product_turn_generation = 0
        self.active_task_lease: ProductTaskLease | None = None
        self.active_skill_presentation: TurnSkillBinding | None = None
        self.task_lease_revision = 0
        self.active_turn_started_at = 0.0
        self._activity_observer = activity_observer
        self._answer_filter = answer_filter
        self._citation_coverage = citation_coverage
        self._citation_review_task: asyncio.Task[dict] | None = None
        self._settlement_review_lock = asyncio.Lock()
        self._citation_review_closed = False
        self._answer_guard = answer_guard
        self._catalog = catalog
        self.interactions = SessionInteractions(
            self.id,
            catalog,
            self.publish,
            events=events,
            broadcast=self._broadcast_product_event,
            bind_component=self.bind_component,
            finish_component=self.finish_component,
        )
        self.plans = SessionPlans(self.id, events, catalog)
        self._events = events
        self._persistence = PersistenceWorker(session_id=self.id)
        self._close_task: asyncio.Task[None] | None = None
        self._update_shutdown_generation: str | None = None
        self._publication_lock = asyncio.Lock()
        self._component_lock = asyncio.Lock()
        catalog_record = catalog.get(self.id)
        self._broadcast_sequence = (
            catalog_record.last_product_seq if catalog_record else INITIAL_PRODUCT_SEQUENCE
        )
        self._publication_task: asyncio.Task[None] | None = None
        self._publication_records: list[ProductEventRecord] = []
        self._publication_error: Exception | None = None
        self._duration_estimator = SkillDurationEstimator(events)
        self._artifacts = artifacts
        self._skills = skills
        self._skill_inventory_provider = skill_inventory_provider
        self._logger = logger
        self._active = False
        self._projection_lock = asyncio.Lock()
        self._service_callbacks: set[asyncio.Task[None]] = set()
        self._projection_recovery_lock = asyncio.Lock()
        self._local_history: list[dict[str, Any]] = []
        self._message_snapshots = MessageSnapshots()
        self._skill_inventory: SkillInventory | None = None
        self._trace = trace or SessionTrace(
            session_id,
            self.runtime_workdir,
            runtime_id=self.runtime_id,
            recording=recording,
            secrets=(
                *trace_secrets,
                self.bridge_token,
                *tuple(
                    value
                    for key, value in self.process_environment.items()
                    if SECRET_KEYS.search(key)
                ),
            ),
        )
        self._runtime_evidence_seq = 0
        self._process_evidence: list[RuntimeProcessEvent] = []
        self._rpc_evidence: list[RuntimeRpcEvidence] = []
        self._local_input_paths: dict[str, tuple[Path, InputKind]] = {}
        self._local_input_path_ids: dict[Path, str] = {}
        self._restore_local_input_paths()
        self.ledger = SessionLedger(
            self.id,
            catalog,
            self.publish,
            self._trace,
            logger,
            self._projection_lock,
            self._persistence,
        )

    @property
    def persistence(self) -> PersistenceWorker:
        return self._persistence

    @property
    def catalog(self) -> SessionCatalogStore:
        return self._catalog

    @property
    def gateway_capabilities(self) -> CapabilitySet:
        if self.runtime_session is None:
            return (
                self.runtime_binding.capabilities
                if self.runtime_binding is not None
                else CapabilitySet()
            )
        return self.runtime_session.capabilities

    @property
    def running(self) -> bool:
        return (
            bool(self.ledger.active_turn_id)
            or self.turn_lock.locked()
            or (self.current_task is not None and not self.current_task.done())
        )

    @property
    def closing(self) -> bool:
        return (
            self._close_task is not None
            or self.termination_task is not None
            or self.terminating
            or self.terminated
        )

    @property
    def turn_active(self) -> bool:
        """Whether the product still owns a non-terminal user-visible turn."""

        return bool(self.ledger.active_turn_id)

    def restore_turn_context(self) -> None:
        if self.active_assistant_snapshot_id or not self.ledger.active_turn_id:
            return
        payload = self._events.turn_context(self.id, self.ledger.active_turn_id)
        self.active_assistant_snapshot_id = str(payload.get("assistant_snapshot_id") or "")
        revision = payload.get("assistant_context_revision")
        self.active_assistant_revision = revision if type(revision) is int else None

    @property
    def last_seq(self) -> int:
        record = self._catalog.get(self.id)
        return record.last_product_seq if record is not None else 0

    @property
    def history_entries(self) -> tuple[HistoryEntry, ...]:
        return self._catalog.portable_history(self.id)

    @property
    def portable_history_entries(self) -> tuple[HistoryEntry, ...]:
        """Return visible text detached from provider-private runtime identifiers."""

        local = tuple(
            HistoryEntry(
                role=str(row.get("role") or ""),
                text=str(row.get("text") or ""),
                turn_id=str(row.get("turn_id") or ""),
                item_id=str(row.get("item_id") or ""),
                phase=(
                    MessagePhase(row["phase"])
                    if row.get("phase") in {phase.value for phase in MessagePhase}
                    else (
                        MessagePhase.FINAL_ANSWER
                        if str(row.get("role") or "") == PORTABLE_ASSISTANT_ROLE
                        else None
                    )
                ),
            )
            for row in self._local_history
            if str(row.get("role") or "") in PORTABLE_HISTORY_ROLES and str(row.get("text") or "")
        )
        return _merge_history_entries(self.history_entries, local)

    def has_user_message(self, item_id: str) -> bool:
        """Return whether one admitted user message is durably recorded."""

        if not item_id:
            return False
        return any(
            event.kind == PRODUCT_EVENT_USER_MESSAGE
            and (
                event.vendor_item_id == item_id
                or str(event.payload.get("client_turn_id") or "") == item_id
            )
            for event in self._events.replay(self.id)
        )

    def attach_gateway(
        self, session: RuntimeSession, *, resumed: bool, activities: Activities
    ) -> RuntimeDriver:
        binding = session.binding
        if binding.product_session_id != self.id:
            raise ValueError("runtime binding product session mismatch")
        if binding.runtime_id != self.runtime_id:
            raise ValueError("runtime binding provider mismatch")
        if self.runtime_session is not None or self.attachment_activity is not None:
            raise RuntimeError("runtime attachment is already owned")
        activity = activities.enter(ActivityDomain.RESOURCE, allow_startup_probe=False)
        self.attachment_activity = activity
        self.runtime_session = session
        self.runtime_binding = binding
        self.vendor_thread_id = binding.opaque_session_ref
        self.resumed = resumed
        generation = self.attachment_generation

        async def observe(observation: RuntimeObservation) -> None:
            if self.attachment_generation != generation or self.runtime_session is not session:
                return
            with activities.continue_from(activity, ActivityDomain.RUNTIME):
                await self.on_runtime_observation(observation)

        async def observe_batch(observations: tuple[RuntimeObservation, ...]) -> None:
            if self.attachment_generation != generation or self.runtime_session is not session:
                return
            with activities.continue_from(activity, ActivityDomain.RUNTIME):
                await self.on_runtime_observations(observations)

        self.runtime_driver = RuntimeDriver(session, observe, on_observations=observe_batch)
        return self.runtime_driver

    def release_attachment_activity(self) -> None:
        """Called only after native suspension or detachment confirms release."""
        activity, self.attachment_activity = self.attachment_activity, None
        if activity is not None:
            activity.close()

    async def hydrate_runtime_history(self) -> None:
        session = self.runtime_session
        if session is None:
            raise RuntimeError("runtime session is unavailable")
        history = await session.history()
        if not isinstance(history, list):
            raise RuntimeError("runtime history must be a list")
        self._local_history = [
            {
                "kind": (
                    "user"
                    if str(row.get("role") or "") == "user"
                    else (
                        "thinking"
                        if str(row.get("role") or "") == "reasoning"
                        or row.get("phase") == MessagePhase.COMMENTARY.value
                        else "text"
                    )
                ),
                "role": str(row.get("role") or ""),
                "text": str(row.get("text") or ""),
                "turn_id": str(row.get("turn_id") or ""),
                "item_id": str(row.get("item_id") or ""),
                "phase": row.get("phase"),
            }
            for row in history
            if isinstance(row, Mapping)
            and str(row.get("role") or "") in {"user", "assistant", "reasoning"}
            and str(row.get("text") or "")
        ]

    def permission_intent(
        self,
        mode: RuntimePermissionMode,
        *,
        writable_roots: tuple[Path, ...] | None = None,
    ) -> PermissionIntent:
        return session_permission(
            mode,
            revision=f"permission:{mode.value}",
            writable_roots=self.writable_roots if writable_roots is None else writable_roots,
            local_socket=self.local_socket,
            network_domains=self.network_domains,
        )

    def retarget_environment(self, process_environment: Mapping[str, str]) -> None:
        """换掉本会话进程要带的 env（key 被轮换后）。

        只改意图, 不改任何已在跑的进程 —— env 在子进程启动时就固化了, 真正生效要靠调用方
        随后重开 vendor thread (LiveSessionService.realign_environment)。
        """

        self.process_environment = dict(process_environment or {})

    def runtime_evidence_snapshot(self) -> dict[str, Any]:
        return {
            "last_evidence_seq": self._runtime_evidence_seq,
            "process": [
                {
                    "evidence_seq": row.evidence_seq,
                    "kind": row.kind.value,
                    "process_generation": row.process_generation,
                    "process_state": row.process_state,
                    "recovery_attempt": row.recovery_attempt,
                    "created_at": row.created_at,
                }
                for row in self._process_evidence
            ],
            "rpc": [
                {
                    "evidence_seq": row.evidence_seq,
                    "method": row.method,
                    "process_generation": row.process_generation,
                    "latency_ms": row.latency_ms,
                    "created_at": row.created_at,
                }
                for row in self._rpc_evidence
            ],
        }

    def rebind_vendor_thread(self, vendor_thread_id: str) -> None:
        """Advance the runtime identity after a durable product binding transition."""

        target = vendor_thread_id.strip()
        if not target:
            raise ValueError("vendor thread id must not be empty")
        self.vendor_thread_id = target
        self._local_history.clear()

    def relocate(
        self,
        *,
        cwd: Path,
        project_path: Path | None,
        output_root: Path,
    ) -> None:
        """Rebind runtime-owned roots without replacing UI/SSE session identity."""

        self.runtime_workdir = cwd.expanduser().resolve()
        self.project_path = project_path.expanduser().resolve() if project_path else None
        self.output_root = output_root.expanduser().resolve()
        self._trace.relocate(self.runtime_workdir)
        self._local_history.clear()
        self._skill_inventory = None
        self.suspend_blockers: tuple[str, ...] = ()

    async def activate(self) -> None:
        self._active = True
        if self.runtime_driver is not None:
            self.runtime_driver.start()
            await self.refresh_skills()

    def prepare_runtime_attachment(self) -> None:
        if self.runtime_session is not None:
            raise RuntimeError("runtime attachment is already active")
        self.bridge_token = secrets.token_urlsafe(BRIDGE_TOKEN_BYTES)
        self._trace.add_secrets(
            (
                self.bridge_token,
                *(
                    value
                    for key, value in self.process_environment.items()
                    if SECRET_KEYS.search(key)
                ),
            )
        )

    def activation_timing(self, request_id: str) -> RuntimeTimingPort:
        return self._trace.activation(request_id)

    def trace_resource(
        self, action: str, receipt: ResourceReceipt | None = None, **attributes: Any
    ) -> None:
        evidence = (
            self.runtime_session.resource_evidence if self.runtime_session is not None else None
        )
        if evidence is not None:
            attributes["ownership"] = asdict(evidence)
        self._trace.resource(
            action, receipt, attachment_generation=self.attachment_generation, **attributes
        )

    async def previous_turn_blockers(self) -> tuple[str, ...]:
        if self.pending_hil_snapshot():
            return (PENDING_HIL_BLOCKER,)
        if not self.active_product_turn_id or self.runtime_session is None:
            return ()
        try:
            activity = await self.runtime_session.activity()
        except Exception:
            return (RUNTIME_ACTIVITY_UNAVAILABLE_BLOCKER,)
        if activity.idle:
            return ()
        return activity.blockers or (RUNTIME_ACTIVITY_UNAVAILABLE_BLOCKER,)

    async def recover_runtime_projection(self) -> None:
        """Recheck storage before replaying the retained, unacknowledged observation."""
        async with self._projection_recovery_lock:
            driver = self.runtime_driver
            if driver is None or not driver.projection_failed:
                return
            await self._persistence.run(
                inspect_database,
                self._events.database,
                SessionCatalogStore.inspect_connection,
                stable_sidecars=False,
            )
            await self._persistence.run(
                inspect_database,
                self._events.database,
                ProductEventStore.inspect_connection,
                stable_sidecars=False,
            )
            self._publication_error = None
            if self._publication_task is not None and self._publication_task.done():
                if not self._publication_task.cancelled():
                    self._publication_task.exception()
                self._publication_task = None
            watermark = await driver.recover_projection()
            self.trace_resource("projection_recovered", watermark=watermark)

    def attachment_model_bridge_id(self) -> str | None:
        """The bridge id the attached native runtime holds; None only when detached.

        Protection deliberately extends through closing/archive waits: the native
        process keeps the bridge URL until an actual detach, and aclose releases the
        registration explicitly (on_release) even when the driver close fails.
        """

        if self.runtime_session is None:
            return None
        return self.held_model_bridge_id or None

    def durable_suspend_refusal(self) -> str | None:
        """Sync refusal subset that cannot clear by waiting; shared with suspend_runtime.

        Transient refusals (running/interrupting/steer/unknown outcome/resource task) are
        deliberately absent: callers keep polling for those, as they always have.
        """

        if self.closing or self.terminating:
            return SUSPEND_CLOSING_BLOCKER
        if self.pending_hil_snapshot():
            return PENDING_HIL_BLOCKER
        return None

    async def suspend_runtime(self, *, require_unsubscribed: bool = False) -> bool:
        async with self.lifecycle_lock:
            self.suspend_blockers = ()
            driver = self.runtime_driver
            if (
                require_unsubscribed
                and self.subscribers
                and (driver is None or not driver.suspending)
            ):
                return False
            if driver is None:
                await self.end_browser_scope()
                self.active_product_turn_id = ""
                return True
            if (
                self.running
                or self.interrupting
                or self.closing
                or self.steer_lock.locked()
                or self.ledger.has_unknown_outcome
                or (
                    self.resource_task is not None
                    and self.resource_task is not asyncio.current_task()
                    and not self.resource_task.done()
                )
            ):
                return False
            if self.durable_suspend_refusal() == PENDING_HIL_BLOCKER:
                self.suspend_blockers = (PENDING_HIL_BLOCKER,)
                self.trace_resource("suspend_blocked", blockers=list(self.suspend_blockers))
                return False
            if not driver.suspending:
                activity = await driver.session.activity()
                if not activity.idle or not activity.execution_tree_idle:
                    self.suspend_blockers = tuple(activity.blockers)
                    self.trace_resource("suspend_blocked", blockers=list(self.suspend_blockers))
                    return False

            async def checkpoint(watermark: int) -> None:
                self._trace.checkpoint(self.attachment_generation, watermark)

            receipt = await driver.suspend(checkpoint)
            if receipt.state is not SuspendState.RELEASED:
                self.trace_resource(
                    "suspend_pending",
                    ticket_id=receipt.ticket.ticket_id,
                    state=receipt.state.value,
                    safe_error=receipt.safe_error,
                    finished=receipt.finished,
                )
                return False
            self.trace_resource("released", ticket_id=receipt.ticket.ticket_id)
            self.runtime_driver = None
            self.runtime_session = None
            self.release_attachment_activity()
            self.suspend_blockers = ()
            self._skill_inventory = None
            self.bridge_token = ""
            self.held_model_bridge_id = ""
            await self.end_browser_scope()
            self.active_product_turn_id = ""
            if self._on_suspend is not None:
                await self._on_suspend(self.id)
            elif self._on_release is not None:
                self._on_release(self.id)
            return True

    async def run_runtime(
        self, turn_input: TurnInput, *, frozen_request: TurnRequest | None = None
    ) -> RuntimeTurnResult:
        driver = self.runtime_driver
        if driver is None:
            raise RuntimeError("runtime session driver is unavailable")
        # 必须在把轮交给 runtime 之前落定：之后 Codex 子进程的每次模型调用都经 loopback bridge
        # 出站，bridge 只能按会话反查「这一轮是谁」。
        self.active_product_turn_id = turn_input.client_user_message_id
        self._running_model = self.model_run
        if frozen_request is not None:
            if frozen_request.command_id != turn_input.client_user_message_id:
                raise RuntimeError("frozen runtime command does not match the current input")
            return await driver.submit(
                replace(
                    frozen_request,
                    admission=turn_input.admission,
                    submission_deadline=turn_input.submission_deadline,
                    submission_attempts=turn_input.submission_attempts,
                )
            )
        if turn_input.admission is None:
            await self.refresh_skills()
        items: tuple[RuntimeValue, ...] = tuple(
            {
                "kind": item.kind.value,
                "text": item.text,
                "path": str(item.path) if item.path is not None else "",
                "name": item.name,
            }
            for item in turn_input.items
        )
        recovery_context = await restore_task_binding(self)
        if recovery_context:
            items = (
                {
                    "kind": InputKind.TEXT.value,
                    "text": recovery_context,
                    "path": "",
                    "name": "",
                },
                *items,
            )
        plan = self.plans.current().get("plan")
        if isinstance(plan, Mapping) and plan.get("source") == PLAN_SOURCE:
            items = (
                {
                    "kind": InputKind.TEXT.value,
                    "text": STRUCTURED_PLAN_TURN_CONTEXT,
                    "path": "",
                    "name": "",
                },
                *items,
            )
        return await driver.submit(
            TurnRequest(
                command_id=turn_input.client_user_message_id,
                items=items,
                model=self.model_id,
                collaboration_mode=turn_input.collaboration_mode.value,
                admission=turn_input.admission,
                submission_deadline=turn_input.submission_deadline,
                submission_attempts=turn_input.submission_attempts,
                retry_authorizer=self.submission_retry_authorizer,
            )
        )

    async def steer_runtime(self, turn_input: TurnInput) -> str:
        session = self.runtime_session
        if session is None:
            raise RuntimeError("runtime session is unavailable")
        # 插队消息也是一个已准入的产品轮（自己的用户消息行、自己的 client turn id），它触发的
        # 模型调用要记到它头上，而不是记到之前那一轮。
        self.active_product_turn_id = turn_input.client_user_message_id
        receipt = await session.steer(
            SteerRequest(
                command_id=turn_input.client_user_message_id,
                items=tuple(
                    {
                        "kind": item.kind.value,
                        "text": item.text,
                        "path": str(item.path) if item.path is not None else "",
                        "name": item.name,
                    }
                    for item in turn_input.items
                ),
                expected_turn_id=self.ledger.active_turn_id,
            )
        )
        if receipt.state is not CommandState.ACCEPTED:
            raise RuntimeError(receipt.safe_error or "runtime steer was rejected")
        return receipt.correlation_id or self.ledger.active_turn_id

    async def on_runtime_observations(self, observations: tuple[RuntimeObservation, ...]) -> None:
        """Amortize consecutive progress I/O, retaining every observation identity."""
        progress: list[RuntimeEvent] = []
        size = 0
        for observation in observations:
            eligible = (
                isinstance(observation, RuntimeEvent)
                and observation.kind is RuntimeEventKind.TOOL_PROGRESS
                and observation.actor_kind is ActorKind.MAIN
                and isinstance(observation.payload, Mapping)
                and event_incident(observation) is None
            )
            if eligible and isinstance(observation, RuntimeEvent):
                payload = observation.payload if isinstance(observation.payload, Mapping) else {}
                added = len(str(payload.get("output") or "").encode("utf-8"))
                if progress and (
                    size + added > PROGRESS_BATCH_BYTE_LIMIT
                    or (
                        observation.process_generation,
                        observation.native_turn_id,
                        observation.native_item_id,
                    )
                    != (
                        progress[-1].process_generation,
                        progress[-1].native_turn_id,
                        progress[-1].native_item_id,
                    )
                ):
                    await self._project_progress_batch(tuple(progress))
                    progress, size = [], 0
                progress.append(observation)
                size += added
            else:
                if progress:
                    await self._project_progress_batch(tuple(progress))
                    progress, size = [], 0
                await self.on_runtime_observation(observation)
        if progress:
            await self._project_progress_batch(tuple(progress))

    async def _project_progress_batch(self, events: tuple[RuntimeEvent, ...]) -> None:
        async with self._projection_lock, self._publication_lock:
            if self._publication_error is not None:
                raise self._publication_error
            try:
                records = await self._persistence.run(
                    self._persist_progress_batch, events, self._broadcast_sequence
                )
            except Exception as error:
                self._publication_error = error
                raise
            for record in records:
                if record.product_seq != self._broadcast_sequence + 1:
                    raise RuntimeError("committed product event sequence gap")
                self._broadcast_product_event(record)
                self._broadcast_sequence = record.product_seq

    def _persist_progress_batch(
        self, events: tuple[RuntimeEvent, ...], cursor: int
    ) -> tuple[ProductEventRecord, ...]:
        pairs: list[tuple[RuntimeEvent, ProductEventRecord]] = []
        with (
            self._events.transaction() as connection,
            self._events.batch(connection) as block_store,
        ):
            for event in events:
                payload = event.payload if isinstance(event.payload, Mapping) else {}
                record = self._events.append(
                    session_id=self.id,
                    runtime_id=self.runtime_id,
                    vendor_thread_id=self.vendor_thread_id,
                    vendor_turn_id=event.native_turn_id or None,
                    vendor_item_id=event.native_item_id or None,
                    kind=PRODUCT_EVENT_TOOL_OUTPUT_DELTA,
                    payload={
                        "tool_id": event.native_item_id,
                        "delta": str(payload.get("output") or ""),
                    },
                    idempotency_key=f"runtime:{event.event_id}",
                    connection=connection,
                    block_store=block_store,
                )
                pairs.append((event, record))
        prefix: list[ProductEventRecord] = []
        first = next((record for _, record in pairs if record.product_seq > cursor), None)
        if first is not None and first.product_seq > cursor + 1:
            after = cursor
            while after < first.product_seq - 1:
                page = tuple(
                    record
                    for record in self._events.replay(
                        self.id, after_seq=after, limit=MAXIMUM_REPLAY_LIMIT
                    )
                    if record.product_seq < first.product_seq
                )
                if not page or page[0].product_seq != after + 1:
                    raise RuntimeError("committed product event sequence missing")
                prefix.extend(page)
                after = page[-1].product_seq
        records = list(prefix)
        with self._trace.batch():
            for record in prefix:
                self._trace.product_event(record)
            for event, record in pairs:
                self._trace.runtime_event(event)
                if record.product_seq > (records[-1].product_seq if records else cursor):
                    self._trace.product_event(record)
                    records.append(record)
        return tuple(records)

    async def on_runtime_observation(self, observation: RuntimeObservation) -> None:
        """Project one validated Gateway observation into durable product state."""

        async with self._projection_lock:
            if isinstance(observation, RuntimeCallbackRequest):
                if observation.audience is CallbackAudience.SERVICE:
                    task = asyncio.create_task(self._respond_service_callback(observation))
                    self._service_callbacks.add(task)
                    task.add_done_callback(self._service_callbacks.discard)
                    return
                payload = (
                    dict(observation.prompt)
                    if isinstance(observation.prompt, Mapping)
                    else {"prompt": observation.prompt}
                )
                payload.update(
                    {
                        "request_id": observation.request_id,
                        "kind": observation.kind.value,
                        "options": [
                            {
                                "id": decision,
                                "label": RUNTIME_DECISION_LABELS.get(decision, decision),
                            }
                            for decision in observation.allowed_decisions
                        ],
                    }
                )
                if observation.kind is CallbackKind.USER_INPUT:
                    questions = payload.get("questions")
                    if isinstance(questions, list):
                        bound_questions = []
                        for index, question in enumerate(questions):
                            if not isinstance(question, Mapping):
                                bound_questions.append(question)
                                continue
                            component = await self.component_for(
                                PLUGIN_QUESTION_SLOT,
                                interaction_id=f"{observation.request_id}:{question.get('id', index)}",
                            )
                            bound = (
                                {**question, "component": component}
                                if component is not None
                                else dict(question)
                            )
                            self.bind_component(bound)
                            bound_questions.append(bound)
                        payload["questions"] = bound_questions
                await self._persistence.run(
                    self._catalog.record_hil,
                    product_request_id=observation.request_id,
                    session_id=self.id,
                    vendor_request_id=observation.request_id,
                    vendor_turn_id=observation.native_turn_id or None,
                    vendor_item_id=observation.native_item_id or None,
                    method=observation.kind.value,
                    payload=payload,
                )
                await self._persistence.run(
                    self._catalog.update_status,
                    self.id,
                    SessionStatus.WAITING_HIL,
                    turn_id=observation.native_turn_id,
                    turn_status=PRODUCT_SESSION_STATE_WAITING,
                )
                await self.publish(
                    PRODUCT_EVENT_HIL_REQUESTED,
                    payload,
                    turn_id=observation.native_turn_id,
                    item_id=observation.native_item_id,
                    idempotency_key=f"runtime:callback:{observation.request_id}",
                )
                return
            await self._project_runtime_event(observation)
            if self._publication_task is not None:
                await self._publication_task
        if self.recovery_observer is not None:
            await self.recovery_observer(self, observation)

    async def _respond_service_callback(self, callback: RuntimeCallbackRequest) -> None:
        session = self.runtime_session
        generation = self.attachment_generation
        if session is None or not callback.request_id:
            return
        prompt = callback.prompt if isinstance(callback.prompt, Mapping) else {}
        if (
            callback.kind is not CallbackKind.DYNAMIC_TOOL
            or callback.native_session_id != self.vendor_thread_id
            or callback.native_turn_id != self.ledger.active_turn_id
            or prompt.get("tool") not in SERVICE_TOOL_CAPABILITIES
        ):
            result: dict[str, Any] = {"ok": False, "error": "bridge_access_denied"}
        else:
            try:
                result = await execute_service_tool(
                    prompt.get("arguments"),
                    session_id=self.id,
                    token=self.bridge_token,
                    local_socket=self.local_socket,
                    callback_request_id=callback.request_id,
                    callback_turn_id=callback.native_turn_id,
                    tool_name=str(prompt.get("tool")),
                )
            except Exception:
                self._logger.exception("service_tool_execution_failed session_id=%s", self.id)
                result = {"ok": False, "error": "bridge_execution_failed"}
        if self.runtime_session is not session or self.attachment_generation != generation:
            return
        receipt = await session.respond(
            RuntimeCallbackResponse(
                request_id=callback.request_id,
                decision=CallbackKind.DYNAMIC_TOOL.value,
                values=result,
                idempotency_key=callback.request_id,
                responded_at=datetime.now(UTC).isoformat(),
            )
        )
        if receipt.state is not CommandState.APPLIED:
            self._logger.warning(
                "service_tool_response_rejected session_id=%s request_id=%s",
                self.id,
                callback.request_id,
            )

    def _observe_activity(self) -> None:
        """Let product policy inspect workspace state after a completed runtime action."""

        if self._activity_observer is None:
            return
        try:
            self._activity_observer(self)
        except Exception:  # noqa: BLE001 - observers must not break runtime projection
            self._logger.warning("session_activity_observer_failed session_id=%s", self.id)

    async def _project_runtime_event(self, event: RuntimeEvent) -> None:
        if event.kind is RuntimeEventKind.TURN_NOT_SUBMITTED:
            await self._persistence.run(self._trace.runtime_event, event)
            return
        if event.kind is RuntimeEventKind.RUNTIME_EVIDENCE:
            process, rpc = decode_evidence(event)
            for process_event in process:
                await self._persistence.run(self._trace.runtime_process_event, process_event)
            for rpc_event in rpc:
                await self._persistence.run(self._trace.runtime_rpc_evidence, rpc_event)
            self._process_evidence = (self._process_evidence + list(process))[
                -RUNTIME_EVIDENCE_LIMIT:
            ]
            self._rpc_evidence = (self._rpc_evidence + list(rpc))[-RUNTIME_EVIDENCE_LIMIT:]
            self._runtime_evidence_seq = max(
                [row.evidence_seq for row in process] + [row.evidence_seq for row in rpc],
                default=self._runtime_evidence_seq,
            )
            return
        if event.kind in {
            RuntimeEventKind.TURN_COMPLETED,
            RuntimeEventKind.TURN_FAILED,
            RuntimeEventKind.TURN_INTERRUPTED,
            RuntimeEventKind.TURN_UNKNOWN,
        }:
            model_failure = self._model_bridge_failure
            self._model_bridge_failure = None
            if event.kind is RuntimeEventKind.TURN_FAILED and model_failure is not None:
                client_turn_id, failure = model_failure
                if client_turn_id == self.active_product_turn_id:
                    event_payload = event.payload if isinstance(event.payload, dict) else {}
                    event = replace(event, payload={**event_payload, **failure})
        event = self._recover_incident_attribution(event)
        await self._persistence.run(self._trace.runtime_event, event)
        incident = event_incident(event)
        if incident is not None and event.kind is not RuntimeEventKind.RUNTIME_INCIDENT:
            await self.ledger.incident(
                replace(event, correlation_id=self.last_submission_id), incident
            )
        if event.kind is RuntimeEventKind.TURN_UNKNOWN:
            await self.ledger.refine_unknown(event)
        payload = dict(event.payload) if isinstance(event.payload, Mapping) else {}
        key = f"runtime:{event.event_id}"
        turn_id = event.native_turn_id
        item_id = event.native_item_id
        if event.kind in {
            RuntimeEventKind.SESSION_OPENED,
            RuntimeEventKind.SESSION_RESUMED,
        }:
            recovering = self.replacement_proof is not None and self.running
            await self._persistence.run(
                self._catalog.update_status,
                self.id,
                SessionStatus.RUNNING if recovering else SessionStatus.READY,
            )
            await self.publish(
                PRODUCT_EVENT_SESSION_STATE,
                {
                    "state": (
                        PRODUCT_SESSION_STATE_RUNNING if recovering else PRODUCT_SESSION_STATE_IDLE
                    ),
                    "runtime_id": event.runtime_id,
                },
                idempotency_key=key,
            )
            return
        if event.kind is RuntimeEventKind.TURN_STARTED:
            if self._running_model is not None:
                self._turn_models[turn_id] = self._running_model
            queued = await self._persistence.run(
                self._catalog.mark_queue_running, self.id, event.correlation_id, turn_id
            )
            if queued is not None:
                await self.publish(
                    PRODUCT_EVENT_MESSAGE_REMOVED,
                    {"queued_message_id": queued.queued_message_id, "reason": "started"},
                    turn_id=turn_id,
                    idempotency_key=f"queue:{queued.queued_message_id}:started",
                )
            await self.ledger.started(event)
            applied_mode = str(payload.get(PERMISSION_MODE_KEY) or "")
            if (
                applied_mode in {mode.value for mode in RuntimePermissionMode}
                and self.applied_permission_turn_id != turn_id
            ):
                self.applied_permission_mode = applied_mode
                self.permission_switch_warning = ""
            await self.bind_user_history(event.correlation_id, vendor_turn_id=turn_id)
            if self._resource_changes is not None and self.last_submission_id:
                await self._resource_changes.bind_turn(
                    self.id,
                    self.last_submission_id,
                    turn_id,
                    self._resource_generation(event),
                )
            await self.publish(
                PRODUCT_EVENT_SESSION_STATE,
                {
                    "state": PRODUCT_SESSION_STATE_RUNNING,
                    "runtime_id": event.runtime_id,
                    "active_turn_id": turn_id,
                },
                turn_id=turn_id,
                idempotency_key=key,
            )
            self._observe_activity()
            return
        if event.kind is RuntimeEventKind.CONTENT_DELTA:
            role = str(payload.get("role") or "assistant")
            if role == "reasoning" and payload.get(REASONING_SOURCE) != PUBLIC_REASONING_SUMMARY:
                return
            delta = str(payload.get("text") or payload.get("delta") or "")
            message: dict[str, Any] = {
                "delta": (
                    delta
                    if role == "reasoning"
                    else self._message_snapshots.append(turn_id, item_id, delta)
                )
            }
            if role != "reasoning" and self._answer_guard is not None:
                message["delta"] = self._answer_guard(message["delta"], False)
            message.update(self.answer_model(turn_id))
            if role == "reasoning":
                message[REASONING_SUMMARY_INDEX] = payload.get(REASONING_SUMMARY_INDEX, 0)
            phase = str(payload.get("phase") or "")
            if phase in {item.value for item in MessagePhase}:
                message["phase"] = phase
            await self.publish(
                (
                    PRODUCT_EVENT_REASONING_DELTA
                    if role == "reasoning"
                    else PRODUCT_EVENT_MESSAGE_DELTA
                ),
                message,
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=key,
            )
            return
        if event.kind is RuntimeEventKind.CONTENT_COMPLETED:
            if str(payload.get("role") or "") == "reasoning":
                if payload.get(REASONING_SOURCE) == PUBLIC_REASONING_SUMMARY:
                    await self.publish(
                        PRODUCT_EVENT_REASONING_COMPLETED,
                        {},
                        turn_id=turn_id,
                        item_id=item_id,
                        idempotency_key=key,
                    )
                return
            self._message_snapshots.finish(turn_id, item_id)
            if str(payload.get("role") or "") == "assistant":
                completed_phase = payload.get("phase")
                completed_text = str(payload.get("text") or "")
                if self._answer_guard is not None:
                    completed_text = self._answer_guard(completed_text, True)
                if self._answer_filter is not None and self.active_assistant_snapshot_id:
                    completed_text = self._answer_filter(
                        self.id,
                        self.active_assistant_snapshot_id,
                        completed_text,
                    )
                message = {"delta": completed_text, **self.answer_model(turn_id)}
                if isinstance(completed_phase, str) and completed_phase in {
                    item.value for item in MessagePhase
                }:
                    message["phase"] = completed_phase
                # Product message deltas are cumulative snapshots. The completed
                # native item is authoritative, including an empty cleaned body.
                await self.publish(
                    PRODUCT_EVENT_MESSAGE_DELTA,
                    message,
                    turn_id=turn_id,
                    item_id=item_id,
                    idempotency_key=key,
                )
                if completed_phase == MessagePhase.FINAL_ANSWER.value:
                    await self._publish_answer_sources(turn_id, item_id, completed_text)
                self.add_assistant_history(
                    completed_text,
                    turn_id=turn_id,
                    item_id=item_id,
                    phase=(
                        MessagePhase(completed_phase)
                        if isinstance(completed_phase, str)
                        and completed_phase in {item.value for item in MessagePhase}
                        else None
                    ),
                )
            return
        if event.kind in {
            RuntimeEventKind.ARTIFACT_DECLARED,
            RuntimeEventKind.ARTIFACT_DECLARATION_FAILED,
        }:
            declaration_id = str(payload.get("declaration_id") or event.event_id)
            try:
                if event.kind is RuntimeEventKind.ARTIFACT_DECLARATION_FAILED:
                    raise ArtifactPublishError(
                        str(payload.get("code") or "artifact_directive_invalid")
                    )
                role = ArtifactRole(str(payload.get("role") or ArtifactRole.INTERMEDIATE.value))
                if role is ArtifactRole.INTERMEDIATE:
                    self._declare_working_artifact(payload, turn_id=turn_id, item_id=item_id)
                else:
                    await self.publish_artifact(
                        str(payload.get("path") or ""),
                        role.value,
                        turn_id=turn_id,
                        item_id=item_id,
                        declaration_id=declaration_id,
                        title=str(payload.get("title") or ""),
                        expected_sha256=str(payload.get("expected_sha256") or ""),
                    )
            except (ArtifactPublishError, ValueError, OSError) as error:
                await self.publish(
                    PRODUCT_EVENT_ARTIFACT_FAILED,
                    {
                        "declaration_id": declaration_id,
                        "code": (
                            ARTIFACT_PUBLISH_IO_FAILED if isinstance(error, OSError) else str(error)
                        ),
                    },
                    turn_id=turn_id,
                    item_id=item_id,
                    # Failures describe this observation, not a committed declaration.
                    # A later attempt can fail differently (or succeed); replaying the
                    # same runtime event must still reuse its original failure.
                    idempotency_key=f"{key}:artifact-failed",
                )
            return
        if event.kind is RuntimeEventKind.TOOL_STARTED:
            tool_name = str(payload.get("name") or "tool")
            tool_input = payload.get("input")
            if self._resource_changes is not None and tool_name != READ_ONLY_TOOL_NAME:
                await self._resource_changes.record_tool_call(
                    self.id,
                    turn_id,
                    tool_input,
                    generation=self._resource_generation(event),
                    event_id=event.event_id,
                )
            await self.publish(
                PRODUCT_EVENT_TOOL_STARTED,
                {
                    "tool_id": item_id,
                    "name": tool_name,
                    "input": tool_input,
                },
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=key,
            )
            return
        if event.kind is RuntimeEventKind.TOOL_PROGRESS:
            await self.publish(
                PRODUCT_EVENT_TOOL_OUTPUT_DELTA,
                {"tool_id": item_id, "delta": str(payload.get("output") or "")},
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=key,
            )
            return
        if event.kind is RuntimeEventKind.TOOL_COMPLETED:
            await self.publish(
                PRODUCT_EVENT_TOOL_COMPLETED,
                {
                    "tool_id": item_id,
                    "name": str(payload.get("name") or "tool"),
                    "output": str(payload.get("output") or ""),
                    "success": bool(payload.get("ok")),
                    **(
                        {"exit_code": payload["exit_code"]}
                        if type(payload.get("exit_code")) is int
                        else {}
                    ),
                },
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=key,
            )
            if payload.get("ok"):
                try:
                    receipts = search_receipts(str(payload.get("output") or ""))
                except ValueError:
                    receipts = []
                    self._logger.warning(
                        "search_receipt_invalid session_id=%s item_id=%s", self.id, item_id
                    )
                for index, receipt in enumerate(receipts):
                    await self.publish(
                        PRODUCT_EVENT_SOURCE_CANDIDATES,
                        {**receipt, "search_id": item_id},
                        turn_id=turn_id,
                        item_id=item_id,
                        idempotency_key=f"{key}:search-receipt:{index}",
                    )
            self._observe_activity()
            return
        if event.kind is RuntimeEventKind.ARTIFACT_OBSERVED:
            await self._project_file_changes(
                payload,
                turn_id=turn_id,
                item_id=item_id,
                idempotency_prefix=key,
                generation=self._resource_generation(event),
            )
            return
        if event.kind is RuntimeEventKind.RUNTIME_EXTENSION:
            extension_kind = str(payload.get(RUNTIME_EXTENSION_KIND_KEY) or "")
            extension = EXTENSION_PROJECTIONS.get(extension_kind)
            if extension is not None:
                projected = extension.build(event, payload, extension.completed)
                if extension.product_kind == PRODUCT_EVENT_WEB_SEARCH_COMPLETED:
                    native_records = self._events.turn_records(
                        self.id,
                        self.active_product_turn_id,
                        turn_id,
                        kinds=(PRODUCT_EVENT_NATIVE_SOURCES,),
                    )
                    native = next(
                        (
                            record.payload
                            for record in reversed(native_records)
                            if record.vendor_item_id == item_id
                            and record.payload.get("provided")
                            and record.payload.get("kind") == SEARCH_ITEM
                        ),
                        None,
                    )
                    if native is not None:
                        projected.update(
                            results=native["sources"],
                            result_count=len(native["sources"]),
                            results_truncated=native.get("truncated", False),
                        )
                if extension.product_kind == PRODUCT_EVENT_SKILL_STARTED:
                    estimate = self._duration_estimator.estimate(
                        str(projected.get("skill") or ""),
                        excluded_session_id=self.id,
                    )
                    projected.update(
                        model_id=self.model_id,
                        reasoning_effort=self.reasoning_effort,
                    )
                    if estimate is not None:
                        projected["estimate"] = estimate.payload()
                await self.publish(
                    extension.product_kind,
                    projected,
                    turn_id=turn_id,
                    item_id=item_id,
                    idempotency_key=(
                        f"runtime:{self.id}:{turn_id}:{item_id}:{extension_kind}"
                        if extension.completed
                        else key
                    ),
                )
                if extension.completed:
                    self._observe_activity()
                return
            native_activity = RUNTIME_NATIVE_ACTIVITY_PRODUCT_EVENTS.get(extension_kind)
            if native_activity is not None:
                product_kind, completed = native_activity
                details = payload.get("details")
                activity_payload: dict[str, Any] = {
                    "activity_id": item_id,
                    "activity_type": str(payload.get("activity_type") or "runtime_activity"),
                    "category": str(payload.get("category") or "other"),
                    "details": dict(details) if isinstance(details, Mapping) else {},
                    "status": str(
                        payload.get("status") or ("completed" if completed else "running")
                    ),
                }
                if completed:
                    activity_payload["success"] = bool(payload.get("ok"))
                await self.publish(
                    product_kind,
                    activity_payload,
                    turn_id=turn_id,
                    item_id=item_id,
                    idempotency_key=key,
                )
                if completed:
                    self._observe_activity()
            return
        if event.kind is RuntimeEventKind.PLAN_UPDATED:
            raw_todos = payload.get("todos", [])
            if not isinstance(raw_todos, list):
                raise ValueError("runtime plan items must be an array")
            if any(not isinstance(row, Mapping) for row in raw_todos):
                raise ValueError("runtime plan item must be an object")
            todos = [dict(row) for row in raw_todos if isinstance(row, Mapping)]
            product_event = await self._persistence.run(
                self.plans.native,
                todos,
                runtime_id=self.runtime_id,
                vendor_thread_id=self.vendor_thread_id,
                turn_id=turn_id,
                item_id=item_id,
                key=key,
                explanation=str(payload.get("explanation") or "") or None,
            )
            if product_event is not None:
                async with self._publication_lock:
                    await self._deliver_committed(product_event)
            return
        if event.kind is RuntimeEventKind.USAGE_UPDATED:
            await self.publish(
                PRODUCT_EVENT_USAGE_UPDATED,
                {
                    name: integer(payload.get(name, 0))
                    for name in (
                        "input_tokens",
                        "output_tokens",
                        "cache_read_tokens",
                        "cache_creation_tokens",
                    )
                },
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=key,
            )
            return
        if event.kind is RuntimeEventKind.INTERACTION_RESOLVED:
            request_id = str(payload.get("request_id") or event.correlation_id)
            if request_id:
                current = self._catalog.hil(request_id)
                if current.status is HilStatus.PENDING and bool(payload.get("cancelled")):
                    await self._persistence.run(
                        self._catalog.resolve_hil, request_id, dict(payload)
                    )
                record = await self._persistence.run(self._catalog.acknowledge_hil, request_id)
                resolved = interaction_snapshot(record)
                if record.status is HilStatus.RESOLVED:
                    for question in record.payload.get("questions", []):
                        if isinstance(question, Mapping):
                            self.finish_component(question)
            else:
                resolved = {
                    "request_id": request_id,
                    "state": (
                        HIL_STATE_CANCELLED
                        if bool(payload.get("cancelled"))
                        else HIL_STATE_RESOLVED
                    ),
                }
            await self.publish(
                PRODUCT_EVENT_HIL_RESOLVED,
                resolved,
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=key,
            )
            return
        subagent_events = {
            RuntimeEventKind.SUBAGENT_SPAWNED: PRODUCT_EVENT_SUBAGENT_SPAWNED,
            RuntimeEventKind.SUBAGENT_STARTED: PRODUCT_EVENT_SUBAGENT_STARTED,
            RuntimeEventKind.SUBAGENT_STATUS_CHANGED: PRODUCT_EVENT_SUBAGENT_STATUS_CHANGED,
            RuntimeEventKind.SUBAGENT_COMPLETED: PRODUCT_EVENT_SUBAGENT_COMPLETED,
            RuntimeEventKind.SUBAGENT_FAILED: PRODUCT_EVENT_SUBAGENT_FAILED,
            RuntimeEventKind.SUBAGENT_INTERRUPTED: PRODUCT_EVENT_SUBAGENT_INTERRUPTED,
        }
        subagent_product_kind = subagent_events.get(event.kind)
        if subagent_product_kind is not None:
            await self.publish(
                subagent_product_kind,
                {
                    **payload,
                    "subagent_id": str(payload.get("subagent_id") or event.actor_id),
                    "parent_agent_id": str(payload.get("parent_agent_id") or event.parent_actor_id),
                    "root_turn_id": str(payload.get("root_turn_id") or turn_id),
                    "actor_kind": event.actor_kind.value,
                    "actor_id": event.actor_id,
                    "parent_actor_id": event.parent_actor_id,
                },
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=key,
            )
            return
        if self.active_product_turn_id and event.kind in {
            RuntimeEventKind.TURN_COMPLETED,
            RuntimeEventKind.TURN_FAILED,
            RuntimeEventKind.TURN_INTERRUPTED,
            RuntimeEventKind.TURN_UNKNOWN,
        }:
            settlement_event = replace(
                event,
                native_turn_id=(
                    event.native_turn_id
                    or event.correlation_id
                    or self.ledger.active_turn_id
                    or self.active_product_turn_id
                ),
            )
            await self._persistence.run(
                self._catalog.record_turn_settlement,
                self.id,
                self.active_product_turn_id,
                settlement_event,
            )
            if not self.running and self.settlement_observer is not None:
                self.settlement_observer(self)
            return
        if await self.ledger.terminal(
            event,
            fallback_submission_id=self.last_submission_id,
            finish_messages=self._message_snapshots.finish_turn,
        ):
            return

        if event.kind is RuntimeEventKind.RUNTIME_INCIDENT:
            incident = event_incident(event)
            if incident is None:
                raise ValueError("runtime incident event has no incident")
            await self.ledger.incident(
                replace(event, correlation_id=self.last_submission_id), incident
            )
            pending = self._catalog.pending_turn_settlement(self.id)
            if (
                pending is not None
                and (
                    (
                        incident.scope is RuntimeIncidentScope.THREAD
                        and incident.kind is RuntimeIncidentKind.RESUME_FAILED
                    )
                    or (
                        incident.scope is RuntimeIncidentScope.PROCESS
                        and incident.kind is RuntimeIncidentKind.PROCESS_EXIT
                    )
                )
                and incident.state is RuntimeIncidentState.FAILED
                and event.native_session_id == pending.event.native_session_id
                and event.process_generation == incident.process_generation
                and event.process_generation
                >= max(
                    (row.process_generation for row in self._process_evidence),
                    default=pending.event.process_generation,
                )
                and event.process_generation >= pending.event.process_generation
            ):
                await self._persistence.run(self._catalog.mark_turn_recovery_blocked, self.id, True)
                await self.publish(
                    PRODUCT_EVENT_SESSION_STATE,
                    {
                        "state": PRODUCT_SESSION_STATE_FAILED,
                        "runtime_id": self.runtime_id,
                        "reason": incident.safe_error,
                        "recovery_blocked": True,
                        "recovery_pending": True,
                        "incident_id": incident.incident_id,
                    },
                    turn_id=pending.native_turn_id,
                    idempotency_key=(
                        f"{PRODUCT_RECOVERY_BLOCKED_KEY_PREFIX}:{pending.client_turn_id}:"
                        f"{incident.incident_id}:{incident.process_generation}"
                    ),
                )
            return
        if event.kind is RuntimeEventKind.RUNTIME_STREAM_GAP:
            await self.publish(
                PRODUCT_EVENT_RUNTIME_INCIDENT,
                {
                    "incident_id": event.event_id,
                    "scope": RUNTIME_INCIDENT_PROTOCOL_SCOPE,
                    "state": RUNTIME_INCIDENT_FAILED_STATE,
                    "kind": RUNTIME_INCIDENT_STREAM_GAP_KIND,
                    "strategy": RUNTIME_INCIDENT_MANUAL_RETRY_STRATEGY,
                    "retryability": RUNTIME_INCIDENT_UNKNOWN_RETRYABILITY,
                    "safe_error": RUNTIME_STREAM_GAP_ERROR,
                    "process_generation": event.process_generation,
                    "attempt": 0,
                    "max_attempts": 0,
                    "expected": payload.get("expected"),
                    "observed": payload.get("observed"),
                },
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=key,
            )
            return
        if event.kind is RuntimeEventKind.CONTEXT_COMPACTED:
            await self.publish(
                PRODUCT_EVENT_CONTEXT_COMPACTED,
                {"phase": str(payload.get("phase") or "completed")},
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=key,
            )
            return
        if event.kind is RuntimeEventKind.MODEL_CAPABILITY_RESOLUTION:
            await self.publish(
                PRODUCT_EVENT_MODEL_CAPABILITY_RESOLUTION,
                {
                    "wire_model": str(payload.get("wire_model") or ""),
                    "declared_context_window": optional_integer(
                        payload.get("declared_context_window")
                    ),
                    "effective_context_window": integer(payload.get("effective_context_window")),
                    "clamped": bool(payload.get("clamped")),
                },
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=key,
            )
            return
        if event.kind is RuntimeEventKind.SESSION_CLOSED:
            await self._persistence.run(self._catalog.update_status, self.id, SessionStatus.CLOSED)
            await self.publish(
                PRODUCT_EVENT_SESSION_STATE,
                {"state": PRODUCT_SESSION_STATE_CLOSED, "runtime_id": event.runtime_id},
                idempotency_key=key,
            )

    async def settle_product_turn(self, event: RuntimeEvent) -> bool:
        async with self._settlement_review_lock:
            return await self._settle_reviewed_turn(event)

    async def _settle_reviewed_turn(self, event: RuntimeEvent) -> bool:
        if self._citation_review_closed:
            return False
        if event.kind is RuntimeEventKind.TURN_COMPLETED:
            await self._review_answer_sources(event)
        async with self._projection_lock:
            pending = self._catalog.pending_turn_settlement(self.id)
            if (
                pending is None
                or pending.event != event
                or self.terminating
                or self.terminated
                or self._citation_review_closed
            ):
                return False
            if self._catalog.pending_hil(self.id):
                return False
            if event.kind is RuntimeEventKind.TURN_COMPLETED:
                await self.finalize_answer_model(event.native_turn_id, f"runtime:{event.event_id}")
            await self.ledger.terminal(
                event,
                fallback_submission_id=self.last_submission_id,
                finish_messages=self._message_snapshots.finish_turn,
            )
            return True

    async def _review_answer_sources(self, event: RuntimeEvent) -> None:
        pending = self._catalog.pending_turn_settlement(self.id)
        if pending is None or pending.event != event or self.terminating or self.terminated:
            return
        records = self._events.turn_records(
            self.id,
            pending.client_turn_id,
            event.native_turn_id,
            kinds=(PRODUCT_EVENT_MESSAGE_DELTA, PRODUCT_EVENT_ANSWER_SOURCES),
        )
        messages: dict[str, str] = {}
        projections: dict[str, dict] = {}
        for record in records:
            item_id = record.vendor_item_id or ""
            if (
                record.kind == PRODUCT_EVENT_MESSAGE_DELTA
                and record.payload.get("phase") == MessagePhase.FINAL_ANSWER.value
            ):
                messages[item_id] = str(record.payload.get("delta") or "")
            elif record.kind == PRODUCT_EVENT_ANSWER_SOURCES:
                projections[item_id] = record.payload
        for item_id, projection in projections.items():
            if self._citation_review_closed or self.terminating or self.terminated:
                return
            if "coverage" not in projection or item_id not in messages:
                continue
            status = projection["coverage"]["status"]
            if status not in (CoverageStatus.PENDING.value, CoverageStatus.REVIEWING.value):
                continue
            generation = self.interrupt_generation
            result = {**projection, "coverage": {"status": CoverageStatus.UNAVAILABLE.value}}
            if status == CoverageStatus.REVIEWING.value:
                result["coverage"]["status"] = CoverageStatus.INTERRUPTED.value
            elif self._citation_coverage is not None:
                await self._publish_source_projection(
                    event.native_turn_id,
                    item_id,
                    {**projection, "coverage": {"status": CoverageStatus.REVIEWING.value}},
                )
                if self._citation_review_closed or self.terminating or self.terminated:
                    return
                self._citation_review_task = asyncio.create_task(
                    self._citation_coverage.review(
                        messages[item_id],
                        projection,
                        invocation_id=f"citation-{self.id}-{event.native_turn_id}-{item_id}",
                        owner_id=self.user_id,
                        project_id=self.project_id,
                        model_key=self.model_id,
                        session_id=self.id,
                        turn_id=event.native_turn_id,
                    )
                )
                try:
                    result = await self._citation_review_task
                except asyncio.CancelledError:
                    result["coverage"]["status"] = CoverageStatus.INTERRUPTED.value
                    current_task = asyncio.current_task()
                    if current_task is not None and current_task.cancelling():
                        raise
                except Exception:
                    self._logger.exception("citation_review_failed session_id=%s", self.id)
                finally:
                    self._citation_review_task = None
            current = self._catalog.pending_turn_settlement(self.id)
            if current is None or current.event != event:
                return
            if generation != self.interrupt_generation:
                result = {**projection, "coverage": {"status": CoverageStatus.INTERRUPTED.value}}
            async with self._projection_lock:
                current = self._catalog.pending_turn_settlement(self.id)
                if (
                    current is None
                    or current.event != event
                    or self.terminating
                    or self.terminated
                    or self._citation_review_closed
                ):
                    return
                latest = self._events.turn_records(
                    self.id,
                    pending.client_turn_id,
                    event.native_turn_id,
                    kinds=(
                        PRODUCT_EVENT_MESSAGE_DELTA,
                        PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                        PRODUCT_EVENT_SOURCE_CANDIDATES,
                        PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
                        PRODUCT_EVENT_NATIVE_SOURCES,
                    ),
                )
                message = next(
                    (
                        record
                        for record in reversed(latest)
                        if record.kind == PRODUCT_EVENT_MESSAGE_DELTA
                        and record.vendor_item_id == item_id
                    ),
                    None,
                )
                if message is None:
                    continue
                fresh = answer_sources(
                    str(message.payload.get("delta") or ""), latest, item_id=item_id
                )
                if fresh["answer_revision"] != result["answer_revision"]:
                    continue
                await self._publish_source_projection(
                    event.native_turn_id, item_id, merge_review(fresh, result)
                )

    def content_source(self, client_turn_id: str) -> ContentSource | None:
        record = self._events.by_key(self.id, f"{INTERNAL_EVENT_KEY_PREFIX}:user:{client_turn_id}")
        if record is None or record.payload.get("binding") != USER_MESSAGE_BINDING_ADMITTED:
            return None
        references: list[SourceReference] = []
        for reference in record.payload.get("refs", ()):
            kind = reference.get("type")
            identity = reference.get("id")
            if kind == "assistant_context":
                if reference.get("origin") != ContextOrigin.EXPLICIT.value or reference.get(
                    "state"
                ) not in (
                    ContextResolutionState.READY.value,
                    ContextResolutionState.TRUNCATED.value,
                ):
                    continue
                try:
                    kind = ContextRefKind(reference.get("kind")).value
                except (TypeError, ValueError):
                    continue
                identity = reference.get("ref_id")
            elif kind not in (
                PRODUCT_REFERENCE_FILE,
                PRODUCT_REFERENCE_DIRECTORY,
                PRODUCT_REFERENCE_SKILL,
            ):
                continue
            if not isinstance(identity, str) or not identity:
                continue
            references.append(
                SourceReference(kind=kind, identity=sha256(identity.encode()).hexdigest())
            )
        return ContentSource(str(record.payload.get("text") or ""), tuple(references))

    async def release_product_turn(self, client_turn_id: str) -> bool:
        """Release model provenance only after the native thread tree is quiescent."""

        if not client_turn_id or self.active_product_turn_id != client_turn_id:
            return False
        session = self.runtime_session
        if session is None:
            if not await self.end_browser_scope():
                return False
            self.active_product_turn_id = ""
            return True
        try:
            activity = await session.activity()
        except Exception:
            warning = getattr(self._logger, "warning", None)
            if warning is not None:
                warning(
                    "product_turn_release_inspection_failed session_id=%s",
                    self.id,
                    exc_info=True,
                )
            return False
        if not activity.idle:
            self.trace_resource(
                "product_turn_retained",
                client_turn_id=client_turn_id,
                blockers=list(activity.blockers),
            )
            return False
        if not await self.end_browser_scope():
            return False
        self.active_product_turn_id = ""
        return True

    def bind_browser_scope_end(
        self,
        scope: Mapping[str, object],
        callback: Callable[[], Awaitable[dict[str, object]]],
        *,
        owner: str = "browser",
    ) -> None:
        if not owner:
            raise ValueError("browser scope owner is required")
        if self._browser_scope is not None:
            if self._browser_scope[0] != scope:
                raise RuntimeError("browser scope remains active")
            self._browser_scope[1].setdefault(owner, callback)
            return
        self._browser_scope = (dict(scope), {owner: callback})
        self._browser_scope_end_pending = False

    @property
    def browser_scope_end_pending(self) -> bool:
        return self._browser_scope_end_pending

    @property
    def browser_delivery_lock(self) -> asyncio.Lock:
        return self._browser_delivery_lock

    async def end_browser_scope(self) -> bool:
        async with self._browser_scope_lock:
            current = self._browser_scope
            if current is None:
                self._browser_scope_end_pending = False
                return True
            async with self._browser_delivery_lock:
                self._browser_scope_end_pending = True
            try:
                for callback in tuple(current[1].values()):
                    result = await callback()
                    if result.get("ok") is not True:
                        return False
            except Exception:
                return False
            try:
                self._catalog.archive_browser_action_scope(current[0])
            except Exception:
                return False
            if self._browser_scope is current:
                self._browser_scope = None
                self._browser_scope_end_pending = False
            return True

    async def record_user_history(
        self,
        text: str,
        *,
        references: tuple[Mapping[str, Any], ...] = (),
        turn_id: str = "",
        item_id: str = "",
        assistant_snapshot_id: str = "",
        assistant_context_revision: int | None = None,
        origin: str = USER_MESSAGE_ORIGIN_TURN,
        reuse_admitted: bool = False,
    ) -> None:
        if not text and not references:
            return
        if origin not in USER_MESSAGE_ORIGINS:
            raise ValueError("user message origin is invalid")
        if reuse_admitted:
            previous = self._events.by_key(self.id, f"{INTERNAL_EVENT_KEY_PREFIX}:user:{turn_id}")
            if (
                previous is None
                or previous.kind != PRODUCT_EVENT_USER_MESSAGE
                or previous.payload.get("text") != text
                or previous.payload.get("client_turn_id") != turn_id
                or previous.payload.get("origin") != origin
                or previous.payload.get("assistant_snapshot_id", "") != assistant_snapshot_id
                or previous.payload.get("assistant_context_revision") != assistant_context_revision
            ):
                raise ValueError("manual retry changed the admitted user message")
            prior_references = previous.payload.get("refs", [])

            def source_references(rows: Any) -> list[dict[str, Any]]:
                return [
                    (
                        {
                            key: value
                            for key, value in dict(row).items()
                            if key not in {"estimate", "model_id", "reasoning_effort"}
                        }
                        if row.get("type") == PRODUCT_REFERENCE_SKILL
                        else dict(row)
                    )
                    for row in rows
                ]

            if source_references(prior_references) != source_references(references):
                raise ValueError("manual retry changed admitted references")
            self.restore_admitted_user(turn_id)
            return
        enriched_references: list[dict[str, Any]] = []
        for raw_reference in references:
            reference = dict(raw_reference)
            if str(reference.get("type") or "") == PRODUCT_REFERENCE_SKILL:
                skill = str(reference.get("id") or "").strip()
                estimate = self._duration_estimator.estimate(
                    skill,
                    excluded_session_id=self.id,
                )
                if estimate is not None:
                    reference.update(
                        estimate=estimate.payload(),
                        model_id=self.model_id,
                        reasoning_effort=self.reasoning_effort,
                    )
            enriched_references.append(reference)
        payload: dict[str, Any] = {
            "text": text,
            "refs": enriched_references,
            "client_turn_id": turn_id,
            "binding": USER_MESSAGE_BINDING_ADMITTED,
            "origin": origin,
        }
        history_row: dict[str, Any] = {
            "kind": "user",
            "role": "user",
            "text": text,
            "turn_id": turn_id,
            "item_id": item_id,
            "refs": payload["refs"],
            "origin": origin,
        }
        if assistant_snapshot_id:
            payload["assistant_snapshot_id"] = assistant_snapshot_id
            payload["assistant_context_revision"] = assistant_context_revision
            history_row["assistant_snapshot_id"] = assistant_snapshot_id
            history_row["assistant_context_revision"] = assistant_context_revision
        self._local_history.append(history_row)
        await self.publish(
            PRODUCT_EVENT_USER_MESSAGE,
            payload,
            turn_id=turn_id,
            item_id=item_id,
            idempotency_key=f"{INTERNAL_EVENT_KEY_PREFIX}:user:{turn_id}",
        )

    def restore_admitted_user(self, client_turn_id: str) -> None:
        previous = self._events.by_key(
            self.id, f"{INTERNAL_EVENT_KEY_PREFIX}:user:{client_turn_id}"
        )
        if (
            previous is None
            or previous.kind != PRODUCT_EVENT_USER_MESSAGE
            or previous.payload.get("client_turn_id") != client_turn_id
        ):
            raise ValueError("admitted user message is unavailable")
        if not any(
            row.get("item_id") == client_turn_id and row.get("role") == "user"
            for row in self._local_history
        ):
            self._local_history.append(
                {
                    "kind": "user",
                    "role": "user",
                    **dict(previous.payload),
                    "turn_id": client_turn_id,
                    "item_id": client_turn_id,
                }
            )

    async def record_cancelled_user_history(self, queued: QueuedMessageRecord) -> None:
        recovery = queued.purpose == QUEUE_PURPOSE_RECOVERY
        text = str(queued.body.get(QUEUED_DISPLAY_TEXT) or "")
        references = queued.body.get(QUEUED_REFERENCES)
        if references is None:
            text = "\n".join(
                str(item.get("text") or "")
                for item in queued.body.get("input", [])
                if isinstance(item, Mapping) and item.get("type") == InputKind.TEXT.value
            )
        await self.publish(
            PRODUCT_EVENT_USER_MESSAGE,
            {
                "text": AUTOMATIC_RECOVERY_MESSAGE if recovery else text,
                "refs": references if isinstance(references, list) else [],
                "client_turn_id": queued.queued_message_id,
                "binding": USER_MESSAGE_BINDING_CANCELLED,
                "origin": USER_MESSAGE_ORIGIN_RECOVERY if recovery else USER_MESSAGE_ORIGIN_TURN,
            },
            idempotency_key=f"queue:{queued.queued_message_id}:cancelled-user",
        )

    async def bind_user_history(self, client_turn_id: str, *, vendor_turn_id: str) -> None:
        """Bind admitted product metadata to the vendor turn returned by Codex."""

        if not client_turn_id or not vendor_turn_id:
            return
        row = next(
            (
                item
                for item in reversed(self._local_history)
                if item.get("role") == "user" and item.get("item_id") == client_turn_id
            ),
            None,
        )
        if row is None:
            return
        row["turn_id"] = vendor_turn_id
        payload: dict[str, Any] = {
            "text": str(row.get("text") or ""),
            "refs": list(row.get("refs") or []),
            "client_turn_id": client_turn_id,
            "binding": USER_MESSAGE_BINDING_BOUND,
            "origin": str(row.get("origin") or USER_MESSAGE_ORIGIN_TURN),
        }
        if row.get("assistant_snapshot_id"):
            payload["assistant_snapshot_id"] = str(row["assistant_snapshot_id"])
            payload["assistant_context_revision"] = row.get("assistant_context_revision")
        await self.publish(
            PRODUCT_EVENT_USER_MESSAGE,
            payload,
            turn_id=vendor_turn_id,
            item_id=str(row.get("item_id") or client_turn_id),
            idempotency_key=f"{INTERNAL_EVENT_KEY_PREFIX}:user-bound:{client_turn_id}",
        )

    async def finalize_answer_model(self, turn_id: str, event_key: str) -> None:
        """Capture a model reported only in the final upstream response frame."""
        model = self.answer_model(turn_id)
        if not model:
            return
        row = next(
            (
                row
                for row in reversed(self._local_history)
                if row.get("turn_id") == turn_id and row.get("role") == "assistant"
            ),
            None,
        )
        if row is None or row.get(MODEL_RUN_FIELD) == model[MODEL_RUN_FIELD]:
            return
        row.update(model)
        await self.publish(
            PRODUCT_EVENT_MESSAGE_DELTA,
            {
                "delta": row["text"],
                **model,
                **({"phase": row["phase"]} if row.get("phase") else {}),
            },
            turn_id=turn_id,
            item_id=str(row.get("item_id") or ""),
            idempotency_key=f"{event_key}:model",
        )

    async def _publish_answer_sources(self, turn_id: str, item_id: str, text: str) -> None:
        try:
            projection = answer_sources(
                text,
                self._events.turn_records(
                    self.id,
                    self.active_product_turn_id,
                    turn_id,
                    kinds=(
                        PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                        PRODUCT_EVENT_SOURCE_CANDIDATES,
                        PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
                        PRODUCT_EVENT_NATIVE_SOURCES,
                    ),
                ),
                item_id=item_id,
            )
            previous = self._events.turn_records(
                self.id,
                self.active_product_turn_id,
                turn_id,
                kinds=(PRODUCT_EVENT_ANSWER_SOURCES,),
            )
            for record in reversed(previous):
                if (
                    record.vendor_item_id == item_id
                    and record.payload.get("answer_revision") == projection["answer_revision"]
                ):
                    if record.payload.get("coverage", {}).get("status") not in (
                        None,
                        CoverageStatus.PENDING.value,
                    ):
                        projection = merge_review(projection, record.payload)
                    break
            if (
                projection["sources"]
                or "native_citations" in projection
                or "coverage" in projection
            ):
                await self._publish_source_projection(turn_id, item_id, projection)
        except Exception:
            self._logger.error(
                "answer_sources_projection_failed session_id=%s turn_id=%s",
                self.id,
                turn_id,
                exc_info=True,
            )

    async def _publish_source_projection(
        self, turn_id: str, item_id: str, projection: dict
    ) -> None:
        fingerprint = sha256(json.dumps(projection, sort_keys=True).encode()).hexdigest()
        await self.publish(
            PRODUCT_EVENT_ANSWER_SOURCES,
            projection,
            turn_id=turn_id,
            item_id=item_id,
            idempotency_key=f"{turn_id}:{item_id}:answer-sources:{fingerprint}",
        )

    async def observe_sources(self, client_turn_id: str, fields: Mapping[str, Any]) -> None:
        if not client_turn_id or client_turn_id != self.active_product_turn_id:
            return
        turn_id = self.ledger.active_turn_id
        if not turn_id:
            self._logger.warning("native_provenance_unbound_turn session_id=%s", self.id)
            return
        fingerprint = sha256(json.dumps(dict(fields), sort_keys=True).encode()).hexdigest()
        await self.publish(
            PRODUCT_EVENT_NATIVE_SOURCES,
            {**dict(fields), "client_turn_id": client_turn_id},
            turn_id=turn_id,
            item_id=str(fields.get("item_id") or ""),
            idempotency_key=f"{client_turn_id}:native-sources:{fingerprint}",
        )
        records = self._events.turn_records(
            self.id,
            client_turn_id,
            turn_id,
            kinds=(PRODUCT_EVENT_WEB_SEARCH_COMPLETED, PRODUCT_EVENT_MESSAGE_DELTA),
        )
        item_id = str(fields.get("item_id") or "")
        if fields.get("kind") == SEARCH_ITEM and fields.get("provided"):
            search = next(
                (
                    record
                    for record in reversed(records)
                    if record.kind == PRODUCT_EVENT_WEB_SEARCH_COMPLETED
                    and record.vendor_item_id == item_id
                ),
                None,
            )
            if search is not None:
                await self.publish(
                    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                    {
                        **search.payload,
                        "results": fields["sources"],
                        "result_count": len(fields["sources"]),
                        "results_truncated": fields.get("truncated", False),
                    },
                    turn_id=turn_id,
                    item_id=item_id,
                    idempotency_key=f"{client_turn_id}:search-sources:{fingerprint}",
                )
        seen: set[str] = set()
        for message in reversed(records):
            message_id = message.vendor_item_id or ""
            if (
                message.kind != PRODUCT_EVENT_MESSAGE_DELTA
                or message_id in seen
                or message.payload.get("phase") != MessagePhase.FINAL_ANSWER.value
                or (fields.get("kind") == MESSAGE_ITEM and message_id != item_id)
            ):
                continue
            seen.add(message_id)
            await self._publish_answer_sources(
                turn_id, message_id, str(message.payload.get("delta") or "")
            )

    def trace_completion(self, fields: Mapping[str, Any]) -> None:
        self._trace.completion(fields)
        client_turn_id = str(fields.get("client_user_message_id") or "")
        if not (
            client_turn_id
            and client_turn_id == self.active_product_turn_id
            and fields.get("phase") == "finished"
        ):
            return
        downstream = fields.get("downstream")
        error_code = (
            str(downstream.get("error_code") or "") if isinstance(downstream, Mapping) else ""
        )
        failure = terminal_provider_failure(fields)
        if not error_code and not failure:
            # 无结构化 error_code 的 finished 诊断（成功轮 / 空终态）不参与归因，也不冲掉
            # 同 turn 已恢复的值——它没有可覆盖的信息。
            return
        # 同 turn 多次上游调用（Codex 流重试）取最后一条带 error_code 的 finished 诊断：
        # 命中白名单则恢复真实归因，未命中则清空，忠实反映最后一次上游结果。终态事件统一
        # 清槽，故不会跨 turn 串味。
        self._model_bridge_failure = (client_turn_id, failure) if failure else None

    def _recover_incident_attribution(self, event: RuntimeEvent) -> RuntimeEvent:
        """Backfill a flattened ``provider_error_code`` on provider incidents.

        Codex drops the upstream ``error.code``, so adapter-emitted provider incidents
        (the retrying spans and the terminal failed span) carry only the generic
        fallback. When the bridge already recovered a structured code for the same
        turn, stamp it onto the incident so every span of one rejection attributes
        consistently. Best-effort: a diagnostic that lands after the incident leaves
        the incident untouched (the terminal payload still recovers), so this never
        blocks projection.
        """

        cached = self._model_bridge_failure
        if cached is None:
            return event
        client_turn_id, failure = cached
        if client_turn_id != self.active_product_turn_id:
            return event
        code = str(failure.get("error_code") or "")
        if not code:
            return event
        payload = event.payload if isinstance(event.payload, dict) else {}
        raw = payload.get("incident")
        if not isinstance(raw, Mapping):
            return event
        existing = str(raw.get("provider_error_code") or "").strip()
        if existing and existing.casefold() != GENERIC_PROVIDER_FAILURE_CODE.casefold():
            # 已带具体上游码（如 Codex 白名单放行的 rate_limit_exceeded）：bridge 恢复
            # 只补「无具体归因」的通用码/空值，绝不覆盖 adapter 已解析出的真实码。
            return event
        incident = dict(raw)
        incident["provider_error_code"] = code
        http_status = failure.get("provider_http_status")
        if http_status is not None:
            incident["provider_http_status"] = http_status
        return replace(event, payload={**payload, "incident": incident})

    def observe_model(self, client_turn_id: str, actual_model: str) -> None:
        """A late HTTP response must never change another execution's identity."""
        if client_turn_id != self.active_product_turn_id or self._running_model is None:
            return
        self._running_model = replace(self._running_model, actual_model_id=actual_model)
        if self.ledger.active_turn_id:
            self._turn_models[self.ledger.active_turn_id] = self._running_model

    def answer_model(self, turn_id: str) -> dict[str, Any]:
        run = self._turn_models.get(turn_id)
        return {MODEL_RUN_FIELD: run.payload()} if run is not None else {}

    def add_assistant_history(
        self,
        text: str,
        *,
        turn_id: str = "",
        item_id: str = "",
        phase: MessagePhase | None = None,
    ) -> None:
        if text:
            self._local_history.append(
                {
                    "kind": "thinking" if phase is MessagePhase.COMMENTARY else "text",
                    "role": "assistant",
                    **self.answer_model(turn_id),
                    "text": text,
                    "turn_id": turn_id,
                    "item_id": item_id,
                    **({"phase": phase.value} if phase is not None else {}),
                }
            )

    async def adopt_generated_title(self, text: str, *, turn_id: str) -> bool:
        """Publish an independently generated product title."""

        clean = " ".join(text.split())
        if not clean or len(clean) > SESSION_RENAME_MAX_LENGTH:
            return False
        record = self._catalog.adopt_generated_title(
            self.id,
            clean,
            replaceable_titles=(SESSION_TITLE_DEFAULT,),
        )
        if record.title != clean:
            return False
        previous = self._events.by_key(
            self.id, f"{INTERNAL_EVENT_KEY_PREFIX}:title:{self.id}:{turn_id}"
        )
        if previous is not None and previous.payload.get("title") == clean:
            return True
        await self.publish(
            PRODUCT_EVENT_SESSION_TITLE_UPDATED,
            {"title": clean, "title_fallback": None},
            turn_id=turn_id,
            idempotency_key=f"{INTERNAL_EVENT_KEY_PREFIX}:title:{self.id}:{turn_id}",
        )
        return True

    def trace_turn_input(
        self,
        turn_input: TurnInput,
        *,
        skill_versions: Mapping[str, str],
        user_text: str = "",
        product_context: str = "",
        steer: bool = False,
        assistant_snapshot_id: str = "",
        assistant_context_revision: int | None = None,
    ) -> None:
        self._trace.turn_input(
            turn_input,
            vendor_thread_id=self.vendor_thread_id,
            skill_versions=skill_versions,
            user_text=user_text,
            product_context=product_context,
            steer=steer,
            assistant_snapshot_id=assistant_snapshot_id,
            assistant_context_revision=assistant_context_revision,
        )

    def trace_turn_execution_failed(
        self, *, failure_type: str, retryability: str, failure_code: str = ""
    ) -> None:
        self._trace.turn_execution_failed(
            failure_type=failure_type,
            retryability=retryability,
            failure_code=failure_code,
        )

    def trace_relocation(
        self,
        *,
        previous_workdir: Path,
        target_workdir: Path,
        status: str,
        stage: str,
        failure_type: str = "",
        failure_detail: str = "",
    ) -> None:
        self._trace.runtime_relocated(
            previous_workdir=previous_workdir,
            target_workdir=target_workdir,
            status=status,
            stage=stage,
            failure_type=failure_type,
            failure_detail=failure_detail,
        )

    def trace_mcp_control_started(
        self,
        *,
        request_id: str,
        operation: str,
        server: str,
        target: str = "",
        explicitly_approved: bool = False,
    ) -> None:
        self._trace.mcp_control_started(
            request_id=request_id,
            vendor_thread_id=self.vendor_thread_id,
            operation=operation,
            server=server,
            target=target,
            explicitly_approved=explicitly_approved,
        )

    def trace_mcp_control_completed(
        self,
        *,
        request_id: str,
        operation: str,
        server: str,
        target: str = "",
        success: bool,
        failure_type: str = "",
    ) -> None:
        self._trace.mcp_control_completed(
            request_id=request_id,
            vendor_thread_id=self.vendor_thread_id,
            operation=operation,
            server=server,
            target=target,
            success=success,
            failure_type=failure_type,
        )

    def history(self) -> list[dict[str, Any]]:
        history = [
            {
                "kind": (
                    "user"
                    if entry.role == "user"
                    else ("thinking" if entry.phase == MessagePhase.COMMENTARY else "text")
                ),
                "role": entry.role,
                "text": entry.text,
                "turn_id": entry.turn_id,
                "item_id": entry.item_id,
                "phase": entry.phase.value if entry.phase is not None else None,
            }
            for entry in self.history_entries
        ]
        history.extend(self._local_history)
        return history

    async def refresh_skills(self, *, force_reload: bool = False) -> SkillInventory:
        if self.runtime_session is not None:
            snapshot = await self.runtime_session.inventory(
                InventoryRequest((InventoryKind.SKILLS,), refresh=force_reload)
            )
            values = snapshot.values if isinstance(snapshot.values, Mapping) else {}
            inventory = _skill_inventory_from_runtime(
                values.get(InventoryKind.SKILLS.value),
                cwd=self.runtime_workdir,
            )
            self._skill_inventory = inventory
            return inventory
        raise RuntimeError("runtime session is unavailable")

    async def allows_skill(self, path: Path, name: str) -> bool:
        return await self.skill_identity(path, name) is not None

    async def skill_identity_by_name(
        self, name: str, *, force_reload: bool = True
    ) -> Mapping[str, Any] | None:
        """Return one enabled identity from the authoritative runtime inventory."""

        identity = await self.skill_state_by_name(name, force_reload=force_reload)
        return identity if identity is not None and bool(identity.get("active")) else None

    async def skill_state_by_name(
        self, name: str, *, force_reload: bool = True
    ) -> Mapping[str, Any] | None:
        """Return authoritative identity and availability, including login requirements."""

        inventory = self._skill_inventory
        if self._skill_inventory_provider is not None:
            inventory = await self._skill_inventory_provider(self.runtime_workdir)
        elif inventory is None or force_reload:
            inventory = await self.refresh_skills(force_reload=force_reload)
        rows = self._skills.payloads(inventory, load_skill_state(), user_id=self.user_id)
        return next(
            (row for row in rows if str(row.get("name") or "") == name),
            None,
        )

    async def skill_identity(self, path: Path, name: str) -> Mapping[str, Any] | None:
        """Return the active product identity for one exact runtime Skill path."""

        canonical = filesystem_path(path.expanduser()).resolve()
        identity = await self.skill_identity_by_name(name)
        if identity is None:
            return None
        identity_path = filesystem_path(
            Path(str(identity.get("path") or "")).expanduser()
        ).resolve()
        return identity if identity_path == canonical else None

    def set_task_lease(self, lease: ProductTaskLease) -> None:
        """Install only a lease for the currently admitted turn generation."""

        if (
            lease.turn_id != self.active_product_turn_id
            or lease.generation != self.product_turn_generation
            or self.current_task is None
            or self.current_task.done()
        ):
            raise ValueError("task_context_stale")
        self.active_task_lease = lease
        self.active_task_type = lease.task_type.value
        self.task_lease_revision += 1

    def clear_task_lease(self) -> None:
        self.active_task_lease = None
        self.active_task_type = ""
        self.task_lease_revision += 1

    def register_local_input_path(self, path: Path, kind: InputKind) -> str:
        """Authorize one exact user-selected file or directory for this session."""

        canonical = path.expanduser()
        existing = self._local_input_path_ids.get(canonical)
        if existing and self._local_input_paths[existing][1] == kind:
            return existing
        reference_id = uuid.uuid4().hex
        self._local_input_paths[reference_id] = (canonical, kind)
        self._local_input_path_ids[canonical] = reference_id
        return reference_id

    def resolve_local_input_path(self, reference_id: str, kind: InputKind) -> Path | None:
        """Resolve only opaque ids with the registered path kind."""

        registered = self._local_input_paths.get(reference_id.strip())
        if registered is None:
            return None
        path, registered_kind = registered
        if registered_kind == kind or (
            registered_kind == InputKind.FILE and kind == InputKind.LOCAL_IMAGE
        ):
            return path
        return None

    def authorized_local_input_file(self, path: Path) -> Path | None:
        """Return an exact authorized path for in-product preview, never a parent root."""

        canonical = path.expanduser().resolve()
        reference_id = self._local_input_path_ids.get(canonical)
        registered = self._local_input_paths.get(reference_id or "")
        return canonical if registered is not None and registered[1] == InputKind.FILE else None

    def _restore_local_input_paths(self) -> None:
        """Rehydrate sent local path references from the durable product event log."""

        for event in self._events.replay(self.id):
            if event.kind != PRODUCT_EVENT_USER_MESSAGE:
                continue
            references = event.payload.get("refs")
            if not isinstance(references, list):
                continue
            for raw in references:
                if not isinstance(raw, Mapping):
                    continue
                origin = raw.get("origin")
                if origin not in (
                    PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE,
                    PRODUCT_REFERENCE_ORIGIN_LOCAL_DIRECTORY,
                ):
                    continue
                reference_id = str(raw.get("reference_id") or "").strip()
                raw_path = str(raw.get("path") or "").strip()
                if not reference_id or not raw_path:
                    continue
                canonical = Path(raw_path).expanduser()
                kind = (
                    InputKind.DIRECTORY
                    if origin == PRODUCT_REFERENCE_ORIGIN_LOCAL_DIRECTORY
                    else InputKind.FILE
                )
                self._local_input_paths[reference_id] = (canonical, kind)
                self._local_input_path_ids[canonical] = reference_id

    async def write_plan(self, command: PlanCommand) -> ProductEventRecord:
        async with self._projection_lock:

            def require_turn() -> None:
                if (
                    not self.running
                    or self.interrupting
                    or self.terminating
                    or self.terminated
                    or not self.publication_turn_id
                    or command.turn_id != self.publication_turn_id
                ):
                    raise PermissionError("plan_turn_inactive")

            record = await self._persistence.run(
                self.plans.write,
                command,
                runtime_id=self.runtime_id,
                vendor_thread_id=self.vendor_thread_id,
                require_turn=require_turn,
            )
            self._trace_and_broadcast(record)
            return record

    async def publish(
        self,
        kind: str,
        data: Mapping[str, Any],
        *,
        turn_id: str = "",
        item_id: str = "",
        idempotency_key: str = "",
    ) -> ProductEventRecord:
        async with self._publication_lock:
            if self._publication_error is not None:
                raise self._publication_error
            return await self._persist_publication(
                kind, data, turn_id=turn_id, item_id=item_id, idempotency_key=idempotency_key
            )

    async def _persist_publication(
        self,
        kind: str,
        data: Mapping[str, Any],
        *,
        turn_id: str = "",
        item_id: str = "",
        idempotency_key: str = "",
    ) -> ProductEventRecord:
        key = idempotency_key or f"{INTERNAL_EVENT_KEY_PREFIX}:{uuid.uuid4().hex}"
        if turn_id and (
            kind in COLLABORATION_CLOSURE_STATUS
            or (
                kind in COLLABORATION_EVENT_KINDS
                and data.get("activity_type") == COLLABORATION_ACTIVITY_TYPE
            )
        ):
            record, published = await self._persistence.run(
                self._publish_collaboration_lifecycle, kind, data, turn_id, item_id, key
            )
            for published_record in published:
                await self._deliver_committed(published_record)
            return record
        record = await self._persistence.run(
            self._events.append,
            session_id=self.id,
            runtime_id=self.runtime_id,
            vendor_thread_id=self.vendor_thread_id,
            vendor_turn_id=turn_id or None,
            vendor_item_id=item_id or None,
            kind=kind,
            payload=dict(data),
            idempotency_key=key,
        )
        await self._deliver_committed(record)
        return record

    def _publish_collaboration_lifecycle(
        self, kind: str, data: Mapping[str, Any], turn_id: str, item_id: str, key: str
    ) -> tuple[ProductEventRecord, list[ProductEventRecord]]:
        published: list[ProductEventRecord] = []
        record: ProductEventRecord | None = None
        with self._events.transaction() as connection:
            records = self._events.turn_records(
                self.id,
                turn_id,
                turn_id,
                kinds=COLLABORATION_LIFECYCLE_KINDS,
                connection=connection,
            )
            pending: dict[str, dict[str, Any]] = {}
            completed: dict[str, ProductEventRecord] = {}
            terminal_kind = ""
            for previous in records:
                if (previous.runtime_id, previous.vendor_thread_id) != (
                    self.runtime_id,
                    self.vendor_thread_id,
                ):
                    continue
                if previous.kind in COLLABORATION_CLOSURE_STATUS:
                    terminal_kind = previous.kind
                if previous.payload.get("activity_type") != COLLABORATION_ACTIVITY_TYPE:
                    continue
                identity = previous.vendor_item_id
                if identity is None:
                    continue
                if previous.kind == PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED:
                    pending.pop(identity, None)
                    completed[identity] = previous
                elif identity not in completed:
                    pending[identity] = previous.payload
            if kind in COLLABORATION_EVENT_KINDS and item_id in completed:
                return completed[item_id], []
            if kind in COLLABORATION_EVENT_KINDS:
                record = self._events.append(
                    session_id=self.id,
                    runtime_id=self.runtime_id,
                    vendor_thread_id=self.vendor_thread_id,
                    vendor_turn_id=turn_id,
                    vendor_item_id=item_id or None,
                    kind=kind,
                    payload=dict(data),
                    idempotency_key=key,
                    connection=connection,
                )
                published.append(record)
                if kind == PRODUCT_EVENT_NATIVE_ACTIVITY_STARTED:
                    pending[item_id] = dict(data)
                else:
                    pending.pop(item_id, None)
            else:
                terminal_kind = kind
            if terminal_kind:
                for identity, activity in pending.items():
                    details = dict(activity.get("details") or {})
                    details[COLLABORATION_CLOSURE_REASON] = terminal_kind
                    closed = self._events.append(
                        session_id=self.id,
                        runtime_id=self.runtime_id,
                        vendor_thread_id=self.vendor_thread_id,
                        vendor_turn_id=turn_id,
                        vendor_item_id=identity,
                        kind=PRODUCT_EVENT_NATIVE_ACTIVITY_COMPLETED,
                        payload={
                            **activity,
                            "status": COLLABORATION_CLOSURE_STATUS[terminal_kind],
                            "success": False,
                            "details": details,
                        },
                        idempotency_key=(
                            f"{INTERNAL_EVENT_KEY_PREFIX}:collaboration-closure:"
                            f"{self.id}:{self.vendor_thread_id}:{turn_id}:{identity}"
                        ),
                        connection=connection,
                    )
                    published.append(closed)
            if record is None:
                record = self._events.append(
                    session_id=self.id,
                    runtime_id=self.runtime_id,
                    vendor_thread_id=self.vendor_thread_id,
                    vendor_turn_id=turn_id,
                    vendor_item_id=item_id or None,
                    kind=kind,
                    payload=dict(data),
                    idempotency_key=key,
                    connection=connection,
                )
                published.append(record)
        return record, published

    def _trace_and_broadcast(self, record: ProductEventRecord) -> None:
        """Project records committed by synchronous chat-domain operations."""

        if self._publication_error is not None:
            raise self._publication_error
        self._publication_records.append(record)
        if self._publication_task is None or self._publication_task.done():
            self._publication_task = asyncio.create_task(self._drain_committed())

    async def _drain_committed(self) -> None:
        try:
            async with self._publication_lock:
                if self._publication_error is not None:
                    raise self._publication_error
                while self._publication_records:
                    await self._deliver_committed(self._publication_records.pop(0))
        except Exception as error:
            self._publication_error = error
            self._logger.exception("session_publication_failed session_id=%s", self.id)
            raise

    async def _deliver_committed(self, record: ProductEventRecord) -> None:
        """Drain any concurrent domain commit before this record's sequence.

        Runtime commits and synchronous domain commits can interleave while I/O
        runs off-thread. The journal is authoritative: completion never overtakes
        an earlier durable delta, even if its owning publisher has not resumed.
        """

        while self._broadcast_sequence < record.product_seq:
            records: tuple[ProductEventRecord, ...]
            if record.product_seq == self._broadcast_sequence + 1:
                records = (record,)
            else:
                records = await self._persistence.run(
                    self._events.replay,
                    self.id,
                    after_seq=self._broadcast_sequence,
                    limit=MAXIMUM_REPLAY_LIMIT,
                )
                records = tuple(row for row in records if row.product_seq <= record.product_seq)
            if not records:
                raise RuntimeError("committed product event sequence missing")
            for committed in records:
                if committed.product_seq != self._broadcast_sequence + 1:
                    raise RuntimeError("committed product event sequence gap")
                await self._persistence.run(self._trace.product_event, committed)
                self._broadcast_product_event(committed)
                self._broadcast_sequence = committed.product_seq

    def _broadcast_product_event(self, record: ProductEventRecord) -> None:
        """Expose only records whose owning persistence transaction has committed."""

        envelope = self.event_envelope(record)
        for queue in tuple(self.subscribers):
            try:
                queue.put_nowait(envelope)
            except asyncio.QueueFull:
                self.subscribers.remove(queue)
                self._logger.warning(
                    SSE_BACKPRESSURE_EVENT,
                    extra={"session_id": self.id, "product_seq": record.product_seq},
                )

    def broadcast_product_events(self, records: tuple[ProductEventRecord, ...]) -> None:
        """Expose a batch committed by another chat-domain service."""

        for record in records:
            self._trace_and_broadcast(record)

    def _declare_working_artifact(
        self, payload: Mapping[str, Any], *, turn_id: str, item_id: str
    ) -> None:
        path = str(payload.get("path") or "")
        identity = str(payload.get("declaration_id") or "")
        key = f"artifact-declaration:{identity}"
        existing = self._artifacts.by_key(self.id, f"{key}:record") if identity else None
        if existing is not None:
            source = self._events.by_sequence(self.id, existing.source_product_seq)
            if (
                source is None
                or source.payload != dict(payload)
                or source.vendor_turn_id != turn_id
                or source.vendor_item_id != (item_id or None)
            ):
                raise ArtifactPublishError("artifact_declaration_conflict")
            return
        canonical = self._canonical_artifact_path(path)
        if not identity or not path or Path(path).is_absolute() or canonical is None:
            raise ArtifactPublishError(ARTIFACT_PUBLISH_PATH_INVALID)
        if not canonical.is_file():
            raise ArtifactPublishError(ARTIFACT_PUBLISH_FILE_NOT_FOUND)
        digest = self._file_sha256(canonical)
        expected = str(payload.get("expected_sha256") or "")
        if expected and expected != digest:
            raise ArtifactPublishError("artifact_snapshot_source_changed")
        relative = str(canonical.relative_to(self.runtime_workdir))
        with self._events.transaction() as connection:
            declared = self._events.append(
                session_id=self.id,
                runtime_id=self.runtime_id,
                vendor_thread_id=self.vendor_thread_id,
                vendor_turn_id=turn_id,
                vendor_item_id=item_id or None,
                kind=PRODUCT_EVENT_ARTIFACT_DECLARED,
                payload=dict(payload),
                idempotency_key=key,
                connection=connection,
            )
            record = self._artifacts.index(
                session_id=self.id,
                runtime_id=self.runtime_id,
                vendor_thread_id=self.vendor_thread_id,
                vendor_turn_id=turn_id,
                vendor_item_id=item_id or None,
                source_kind=ArtifactSource.ARTIFACT_DECLARATION,
                source_product_seq=declared.product_seq,
                original_path=relative,
                canonical_path=str(canonical),
                role=ArtifactRole.INTERMEDIATE.value,
                status=ArtifactStatus.COMPLETED,
                mime_type=mimetypes.guess_type(canonical.name)[0],
                content_sha256=digest,
                size_bytes=self._file_size(canonical),
                metadata={"title": str(payload.get("title") or canonical.name)},
                saved_to=(
                    self._publications.resource_destination(self.project_id, canonical)
                    if self._publications
                    else None
                ),
                idempotency_key=f"{key}:record",
                connection=connection,
            )
            changed = self._events.append(
                session_id=self.id,
                runtime_id=self.runtime_id,
                vendor_thread_id=self.vendor_thread_id,
                vendor_turn_id=turn_id,
                vendor_item_id=item_id or None,
                kind=PRODUCT_EVENT_ARTIFACT_CHANGED,
                payload={
                    "op": PRODUCT_EVENT_ARTIFACT_UPSERT,
                    "artifact": artifact_payload(record, change=ARTIFACT_CHANGE_UPDATE),
                },
                idempotency_key=f"{key}:changed",
                connection=connection,
            )
        self._trace_and_broadcast(declared)
        self._trace_and_broadcast(changed)

    @property
    def bridge_activity(self) -> ActivityLease | None:
        return self.turn_activity

    @property
    def publication_turn_id(self) -> str:
        """Current execution identity admitted by the artifact publication port."""
        return self.ledger.active_turn_id

    async def publish_artifact(
        self,
        path: str,
        role: str,
        *,
        turn_id: str,
        declaration_id: str = "",
        title: str = "",
        expected_sha256: str = "",
        item_id: str = "",
    ) -> dict[str, Any]:
        """Publish one existing workdir file as an explicit, content-bound artifact."""

        candidate = Path(path)
        if candidate.is_absolute():
            raise ArtifactPublishError(ARTIFACT_PUBLISH_PATH_INVALID)
        try:
            canonical = self._canonical_artifact_path(path)
            if canonical is None:
                raise ArtifactPublishError(ARTIFACT_PUBLISH_PATH_INVALID)
            if not declaration_id and not canonical.is_file():
                raise ArtifactPublishError(ARTIFACT_PUBLISH_FILE_NOT_FOUND)
            relative = str(canonical.relative_to(self.runtime_workdir))
        except ArtifactPublishError:
            raise
        except OSError as error:
            code = (
                ARTIFACT_PUBLISH_ACCESS_DENIED
                if file_access_code(error) == FILE_ACCESS_DENIED
                else ARTIFACT_PUBLISH_IO_FAILED
            )
            self._logger.warning(
                "artifact_publish_file_access_failed session_id=%s path=%s code=%s errno=%s winerror=%s",
                self.id,
                path,
                code,
                error.errno,
                getattr(error, "winerror", None),
            )
            raise ArtifactPublishError(code) from error
        if self._publications is None:
            raise ArtifactPublishError("artifact_publication_unavailable")
        try:
            publication = self._publications.publish(
                PublicationCommand(
                    self.project_id,
                    self.id,
                    turn_id,
                    declaration_id,
                    self._publications.source_path(self.project_id, self.runtime_workdir, relative),
                    ArtifactRole(role),
                    title,
                    expected_sha256,
                ),
                provenance={
                    "runtime_id": self.runtime_id,
                    "thread_id": self.vendor_thread_id,
                    "item_id": item_id,
                },
            )
        except OSError as error:
            raise ArtifactPublishError(ARTIFACT_PUBLISH_IO_FAILED) from error
        except (ValueError, ContentError) as error:
            raise ArtifactPublishError(str(error)) from error
        return self._project_publication(publication)

    async def component_for(
        self, slot: str, *, skill_name: str = "", interaction_id: str = ""
    ) -> dict[str, str] | None:
        if self._skills.components is None:
            return None
        return self._skills.components.resolve(
            slot,
            session_id=self.id,
            turn_id=self.active_product_turn_id,
            user_id=self.user_id,
            interaction_id=interaction_id,
        )

    @property
    def component_registry(self) -> ComponentRegistry:
        if self._skills.components is None:
            raise ValueError("component_registry_unavailable")
        return self._skills.components

    def bind_component(self, question: Mapping[str, Any]) -> None:
        reference = question.get("component")
        if isinstance(reference, Mapping):
            data = question.get("component_data")
            self.component_registry.bind_data(
                reference, dict(data if isinstance(data, Mapping) else question)
            )

    def finish_component(self, question: Mapping[str, Any]) -> None:
        reference = question.get("component")
        if isinstance(reference, Mapping):
            self.component_registry.finish(reference)

    def component_catalog(self) -> list[dict[str, Any]]:
        return self.component_registry.catalog(user_id=self.user_id)

    def component_ui_catalog(self) -> dict[str, Any]:
        return self.component_registry.ui_catalog()

    def component_preflight(self, slots: list[str]) -> dict[str, Any]:
        return self.component_registry.preflight(slots)

    def validate_installation_answer(
        self, question: Mapping[str, Any], body: Mapping[str, Any]
    ) -> None:
        report = question[INSTALLATION_FIELD]
        state = self._catalog.hil(question["id"]).payload.get("installation_state", {})
        receipt = state.get("receipt")
        if not state:
            receipt = self._skills.installation_receipt(report)
        if body == {"cancelled": True} and receipt is None:
            return
        answers = body.get("answers")
        if not isinstance(answers, Mapping) or set(answers) != {question["id"]}:
            raise ValueError("plugin_installation_receipt_invalid")
        validate_receipt(
            receipt,
            json.loads(answers[question["id"]]),
        )

    async def plugin_installation(
        self, command: PluginInstallation, *, turn_id: str
    ) -> dict[str, Any]:
        signature = sha256(command.model_dump_json().encode()).hexdigest()
        request_id = card_identity(self.id, turn_id, PLUGIN_INSTALL_CAPABILITY, command.request_id)
        async with self._component_lock:
            try:
                previous = self._catalog.hil(request_id)
            except SessionAccessError:
                previous = None
            if previous is not None:
                question = previous.payload["questions"][0]
                if (
                    previous.session_id != self.id
                    or question.get("installation_signature") != signature
                ):
                    raise ValueError("plugin_installation_request_conflict")
                if previous.status is HilStatus.RESOLVED:
                    return dict(previous.decision or {})
            else:
                report = self._skills.installation_report(
                    self.runtime_workdir, command.path, command.sha256
                )
                if not report.get("valid"):
                    return {"installed": False, "report": report}
                question = {
                    "id": request_id,
                    "header": "plugin-installation",
                    "question": report["descriptor"]["id"],
                    "options": [],
                    INSTALLATION_FIELD: report,
                    "installation_path": command.path,
                    "installation_signature": signature,
                }
            await self.interactions.publish_product_input(question, turn_id=turn_id)
        report = question[INSTALLATION_FIELD]
        return {
            "published": True,
            "request_id": request_id,
            "package": {
                "id": report["descriptor"]["id"],
                "version": report["descriptor"]["version"],
                "sha256": report["sha256"],
            },
        }

    async def component_interaction(
        self, command: ComponentInvocation, *, turn_id: str, waiting: bool
    ) -> dict[str, Any]:
        encoded = json.dumps(command.model_dump(), sort_keys=True, separators=(",", ":"))
        signature = sha256(encoded.encode()).hexdigest()
        request_id = card_identity(self.id, turn_id, COMPONENT_CARD_TYPE, command.request_id)
        async with self._component_lock:
            if waiting:
                try:
                    previous = self._catalog.hil(request_id)
                except SessionAccessError:
                    previous = None
                if previous is not None:
                    question = previous.payload["questions"][0]
                    if (
                        previous.session_id != self.id
                        or question.get(COMPONENT_REQUEST_MARKER) != signature
                    ):
                        raise ValueError("component_request_conflict")
                    self.component_registry.snapshot(question["component"], user_id=self.user_id)
                    if previous.status is HilStatus.RESOLVED:
                        return dict(previous.decision or {})
                else:
                    question = None
            else:
                previous_card = self._events.by_key(self.id, request_id)
                if previous_card is not None:
                    if previous_card.payload.get(COMPONENT_REQUEST_MARKER) != signature:
                        raise ValueError("component_request_conflict")
                    self.component_registry.snapshot(
                        previous_card.payload["component"], user_id=self.user_id
                    )
                    return previous_card.payload
                question = None
            if question is None:
                reference = await self.component_for(command.slot, interaction_id=request_id)
                if reference is None:
                    raise ValueError("plugin_component_slot_missing")
                if reference.get("plugin") == COMPONENT_HOST_PLUGIN:
                    raise ValueError("component_requires_domain_publication")
                snapshot = self.component_registry.snapshot(reference, user_id=self.user_id)
                definition = next(
                    item
                    for item in snapshot["descriptor"]["components"]
                    if item["id"] == reference["component"]
                )
                validate_component_value(
                    definition.get("input_schema", COMPONENT_SCHEMA_DEFAULT), command.data
                )
                if waiting and not any(
                    action["capability"] == COMPONENT_ANSWER_CAPABILITY
                    for action in definition["actions"]
                ):
                    raise ValueError("component_answer_action_missing")
                self.component_registry.bind_data(reference, command.data)
                question = {
                    "id": request_id,
                    "header": command.title,
                    "question": command.prompt or command.title,
                    "options": [],
                    "component": reference,
                    "component_data": command.data,
                    COMPONENT_REQUEST_MARKER: signature,
                }
            if not waiting:
                return self._publish_card(
                    COMPONENT_CARD_TYPE,
                    command.data,
                    signature,
                    len(encoded.encode()),
                    question["component"],
                    turn_id=turn_id,
                    key=request_id,
                    metadata={COMPONENT_REQUEST_MARKER: signature},
                )
            self.interactions.prepare_product_input(question, turn_id=turn_id)
        return await self.interactions.request_product_input(
            question,
            turn_id=turn_id,
            activity=self.bridge_activity,
        )

    async def display_card(
        self,
        card_type: str,
        content: DisplayCardContent,
        *,
        turn_id: str,
    ) -> dict[str, Any]:
        """Validate and durably publish one typed card in the active conversation."""

        normalized, digest, encoded_size = normalize_card(
            self.runtime_workdir, self._cards, card_type, content
        )
        component = await self.component_for(
            PLUGIN_DISPLAY_PREFIX + card_type,
            skill_name=content.skill,
            interaction_id=card_identity(self.id, turn_id, card_type, digest),
        )
        if component is not None:
            self.component_registry.bind_data(component, normalized)
        return self._publish_card(
            card_type, normalized, digest, encoded_size, component, turn_id=turn_id
        )

    def _publish_card(
        self,
        card_type: str,
        normalized: dict[str, Any],
        digest: str,
        encoded_size: int,
        component: dict[str, str] | None,
        *,
        turn_id: str,
        key: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if component is not None:
            encoded = json.dumps(component, sort_keys=True, separators=(",", ":")).encode()
            digest = sha256(digest.encode() + encoded).hexdigest()
            encoded_size += len(encoded)
        card_id = card_identity(self.id, turn_id, card_type, digest)
        slot = self._cards.slot(card_type, normalized)
        item_slot = card_identity(self.id, turn_id, card_type, slot) if slot is not None else None
        idempotency_key = key or f"{DISPLAY_CARD_IDEMPOTENCY_PREFIX}:{turn_id}:{card_type}:{digest}"
        with self._events.transaction() as connection:
            if item_slot is not None:
                previous = self._events.latest_kind(
                    self.id,
                    PRODUCT_EVENT_DISPLAY_CARD,
                    connection=connection,
                    vendor_turn_id=turn_id,
                    vendor_item_id=item_slot,
                )
                if (
                    previous is not None
                    and previous.payload.get("content") == normalized
                    and previous.payload.get("component") == component
                ):
                    return previous.payload
                predecessor = previous.product_seq if previous is not None else 0
                idempotency_key = f"{idempotency_key}:{predecessor}"
                card_id = card_identity(self.id, turn_id, card_type, idempotency_key)
            payload = {"card_id": card_id, "type": card_type, "content": normalized}
            if metadata is not None:
                payload.update(metadata)
            if component is not None:
                payload["component"] = component
            existing = self._events.by_key(self.id, idempotency_key, connection=connection)
            if existing is None:
                _, byte_count = self._events.turn_kind_usage(
                    self.id,
                    turn_id,
                    PRODUCT_EVENT_DISPLAY_CARD,
                    connection=connection,
                    item_slot=item_slot,
                )
                if byte_count + encoded_size > DISPLAY_CARD_MAX_BYTES_PER_TURN:
                    raise DisplayCardError(DISPLAY_CARD_TURN_BYTES)
            record = self._events.append(
                session_id=self.id,
                runtime_id=self.runtime_id,
                vendor_thread_id=self.vendor_thread_id,
                vendor_turn_id=turn_id,
                vendor_item_id=item_slot,
                kind=PRODUCT_EVENT_DISPLAY_CARD,
                payload=payload,
                idempotency_key=idempotency_key,
                connection=connection,
            )
        if existing is None:
            self._trace_and_broadcast(record)
        return payload

    def recover_publications(self) -> None:
        """Drain committed publications before exposing the reopened session."""
        if self._publications is None:
            return
        store = self._publications.store(self.project_id, self.id)
        for publication in store.list_session(self.id, pending_only=True):
            self._project_publication(publication)

    def _project_publication(self, publication: PublicationRecord) -> dict[str, Any]:
        if publication.session_id != self.id or self._publications is None:
            raise ArtifactPublishError("artifact_publication_invalid")
        session = self._catalog.get(self.id)
        if session is None:
            raise ArtifactPublishError("artifact_publication_invalid")
        payload, committed = self._publications.project(
            publication, session, self._events, self._artifacts
        )
        for event in committed:
            self._trace_and_broadcast(event)
        self._publications.acknowledge(publication)
        return payload

    @staticmethod
    def event_envelope(record: ProductEventRecord) -> dict[str, Any]:
        record = upcast_product_event(record)
        envelope: dict[str, Any] = {
            "v": record.schema_version,
            "seq": record.product_seq,
            "ts": record.created_at,
            "type": record.kind,
            "session_id": record.session_id,
            "data": record.payload,
        }
        if record.vendor_turn_id:
            envelope["turn_id"] = record.vendor_turn_id
        if record.vendor_item_id:
            envelope["item_id"] = record.vendor_item_id
        return envelope

    def artifact_snapshot(self) -> list[dict[str, Any]]:
        return artifact_snapshot_payload(self._artifacts.list_session(self.id))

    def pending_hil_snapshot(self, *, blocking_only: bool = True) -> list[dict[str, Any]]:
        return [
            {
                "request_id": row.product_request_id,
                **row.payload,
                "turn_id": row.vendor_turn_id,
                "item_id": row.vendor_item_id,
            }
            for row in self._catalog.pending_hil(self.id, blocking_only=blocking_only)
        ]

    async def reconcile_resumed_turns(self) -> None:
        if self.runtime_session is None:
            return
        snapshot = await self.runtime_session.snapshot()
        async with self._projection_lock:
            await self.ledger.reconcile(
                snapshot,
                runtime_id=self.runtime_id,
                native_session_id=self.vendor_thread_id,
                finish_messages=self._message_snapshots.finish_turn,
            )

    async def interrupt(self, *, cleanup_background_processes: bool = False) -> None:
        await self.end_browser_scope()
        if await self.cancel_resource_wait():
            return
        runtime_session = self.runtime_session
        if runtime_session is None:
            raise RuntimeError("runtime session is unavailable")
        self.interrupt_generation += 1
        if self._citation_review_task is not None:
            self._citation_review_task.cancel()
        self.interrupting = True
        self.last_interrupt_succeeded = None
        try:
            record = self._catalog.get(self.id)
            expected_turn_id = (record.last_turn_id if record is not None else "") or ""
            receipt = await runtime_session.interrupt(
                InterruptRequest(
                    command_id=f"interrupt-{uuid.uuid4().hex}",
                    expected_turn_id=expected_turn_id,
                    cleanup_background_processes=cleanup_background_processes,
                )
            )
            handled = receipt.state in {
                CommandState.ACCEPTED,
                CommandState.APPLIED,
            }
            if not handled:
                raise RuntimeError("runtime did not accept the interrupt")
            interactions = getattr(self, "interactions", None)
            if interactions is not None:
                await interactions.cancel_product_requests()
            await self._broadcast_expired_hil(reason="interrupt")
            self.last_interrupt_succeeded = True
        except Exception:
            self.last_interrupt_succeeded = False
            raise
        finally:
            self.interrupting = False

    async def _broadcast_expired_hil(self, *, reason: str) -> None:
        """Expire pending HIL and emit `hil_resolved(state=stale)` per record so
        the front-end permission overlay dismisses along with the interrupt.
        Turn-level `settlePendingHil` alone is insufficient: a released bridge
        plan (or any HIL whose vendor_turn_id disagrees with the interrupted
        turn_id) never matches the front-end's per-turn cleanup filter."""
        try:
            expired = self._catalog.expire_pending_hil(self.id)
        except TypeError:
            # 兼容 legacy 存根 (仅 tests): 老 mock 返回 None, 无事件可广播。
            return
        if not expired:
            return
        for record in expired:
            snapshot = interaction_snapshot(record)
            snapshot["state"] = "stale"
            try:
                await self.publish(
                    PRODUCT_EVENT_HIL_RESOLVED,
                    snapshot,
                    turn_id=record.vendor_turn_id or "",
                    item_id=record.vendor_item_id or "",
                    idempotency_key=f"{reason}:hil:{record.product_request_id}:stale",
                )
            except Exception:  # noqa: BLE001 - 广播失败不得阻断中断/终止路径
                self._logger.warning(
                    "hil_resolved_broadcast_failed session_id=%s request_id=%s reason=%s",
                    self.id,
                    record.product_request_id,
                    reason,
                )

    async def cancel_resource_wait(self) -> bool:
        """Cancel unsent admission without awaiting its cleanup under the lifecycle lock."""
        async with self.lifecycle_lock:
            task = self.resource_task
            request_id = self.waiting_request_id
            if task is None or task.done() or not request_id:
                return False
            queued = self._catalog.queued_message(self.id, request_id)
            if queued is None:
                return False
            if not self._catalog.delete_queued_message(self.id, request_id):
                return False
            await self.record_cancelled_user_history(queued)
            await self.publish(
                PRODUCT_EVENT_MESSAGE_REMOVED,
                {"queued_message_id": request_id, "reason": "cancelled"},
                idempotency_key=f"queue:{request_id}:cancelled",
            )
            self.interrupting = True
            self.interrupt_generation += 1
            self.last_interrupt_succeeded = None
            task.cancel()
        try:
            await asyncio.gather(task, return_exceptions=True)
            self.last_interrupt_succeeded = True
        finally:
            self.interrupting = False
        return True

    async def terminate(self) -> None:
        await self.end_browser_scope()
        runtime_session = self.runtime_session
        command_id = f"terminate-{uuid.uuid4().hex}"
        self.terminating = True
        await self._cancel_citation_review()
        try:
            if runtime_session is not None:
                receipt = await runtime_session.terminate(
                    TerminateSessionRequest(command_id=command_id)
                )
                if receipt.state not in {CommandState.ACCEPTED, CommandState.APPLIED}:
                    raise RuntimeError("runtime did not accept session termination")
                command_id = receipt.command_id
        except Exception:
            self.terminating = False
            raise
        self.terminated = True
        await self._broadcast_expired_hil(reason="terminate")
        self._catalog.update_status(self.id, SessionStatus.CLOSED)
        # Termination closes the adapter immediately after this method returns, so
        # commit the product-visible terminal state before the observation pump is
        # torn down. A later native SESSION_CLOSED observation remains idempotent.
        await self.publish(
            PRODUCT_EVENT_SESSION_STATE,
            {
                "state": PRODUCT_SESSION_STATE_CLOSED,
                "runtime_id": self.runtime_id,
            },
            idempotency_key=f"session-terminated:{command_id}",
        )

    async def prepare_update_shutdown(self, generation: str) -> None:
        if uuid.UUID(hex=generation).hex != generation:
            raise ValueError("invalid update maintenance generation")
        if self._update_shutdown_generation == generation:
            return
        if self._update_shutdown_generation is not None or self._close_task is not None:
            raise RuntimeError("update shutdown preparation changed")
        operation = asyncio.create_task(
            self._persistence.run(
                self._events.append,
                session_id=self.id,
                runtime_id=self.runtime_id,
                vendor_thread_id=self.vendor_thread_id,
                vendor_turn_id=None,
                vendor_item_id=None,
                kind=PRODUCT_EVENT_UPDATE_SHUTDOWN_PREPARED,
                payload={"generation": generation},
                idempotency_key=f"update:{generation}:{self.id}",
            )
        )
        try:
            await asyncio.shield(operation)
        except asyncio.CancelledError as cancellation:
            self._persistence.stop_waiting()
            while not operation.done():
                try:
                    await asyncio.shield(operation)
                except asyncio.CancelledError:
                    pass
                except Exception:
                    break
            try:
                operation.result()
            except asyncio.CancelledError:
                pass
            except Exception as error:
                raise BaseExceptionGroup(
                    "update shutdown preparation failed during cancellation", [error, cancellation]
                ) from None
            raise
        self._update_shutdown_generation = generation

    def resume_after_update_shutdown(self, generation: str) -> None:
        if self._update_shutdown_generation == generation:
            self._update_shutdown_generation = None

    def _close_update_trace(self) -> None:
        try:
            self._trace.close()
        except TRACE_FAILURES as failure:
            self._logger.warning(
                "update_trace_close_degraded session_id=%s generation=%s error_type=%s",
                self.id,
                self._update_shutdown_generation,
                type(failure).__name__,
            )

    async def aclose(self) -> None:
        current = asyncio.current_task()
        if (
            current in self._service_callbacks
            or current in self.submission_tasks
            or current
            in (
                self._close_task,
                self.current_task,
                self.resource_task,
                self._citation_review_task,
                self._publication_task,
            )
        ):
            raise RuntimeError("session cannot await its own close")
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close_owned())
        cancelled = False
        while not self._close_task.done():
            try:
                await asyncio.shield(self._close_task)
            except asyncio.CancelledError:
                cancelled = True
            except BaseException:
                break
        try:
            self._close_task.result()
        except BaseException as error:
            if cancelled and not isinstance(error, asyncio.CancelledError):
                raise BaseExceptionGroup(
                    "session close failed during cancellation", [error, asyncio.CancelledError()]
                ) from None
            raise
        if cancelled:
            raise asyncio.CancelledError

    async def _close_owned(self) -> None:
        failures: list[BaseException] = []

        def diagnostic_gap(error: BaseException) -> bool:
            if self._update_shutdown_generation is None or not isinstance(
                error, TraceRecordingError
            ):
                return False
            self._logger.warning(
                "update_trace_projection_degraded session_id=%s generation=%s error_type=%s",
                self.id,
                self._update_shutdown_generation,
                type(error).__name__,
            )
            return True

        async def close(call: Callable[[], Any]) -> bool:
            try:
                result = call()
                if inspect.isawaitable(result):
                    await result
                return True
            except BaseException as error:
                if diagnostic_gap(error):
                    return True
                failures.append(error)
                return False

        async def cancel(
            tasks: tuple[asyncio.Task[Any], ...], *, request_cancel: bool = True
        ) -> bool:
            if request_cancel:
                for task in tasks:
                    task.cancel()
            results = await asyncio.gather(*tasks, return_exceptions=True)
            errors = [
                result
                for result in results
                if isinstance(result, BaseException)
                and not isinstance(result, asyncio.CancelledError)
                and not diagnostic_gap(result)
            ]
            failures.extend(errors)
            return not errors

        async def settle() -> None:
            async with self._settlement_review_lock:
                pass

        self._citation_review_closed = True
        self._persistence.stop_waiting()

        async def close_browser_scope() -> None:
            if not await self.end_browser_scope():
                raise RuntimeError("Browser scope did not drain")

        await close(self._cancel_citation_review)
        await close(settle)
        await close(close_browser_scope)
        await cancel(tuple(self._service_callbacks))
        resource_task = self.resource_task
        if resource_task is not None and await cancel((resource_task,)):
            self.resource_task = None
        # A submitted turn is no longer resource_task: it owns current_task and
        # can still persist an unknown outcome or delivery during cancellation.
        # Drain that work while its ledger, context and persistence remain alive.
        current_task = self.current_task
        if current_task is not None and await cancel((current_task,)):
            self.current_task = None
        # Admission releases resource_task before its wrapper awaits the turn.
        # Cancelling the turn wakes that wrapper's persistence cleanup; await it
        # without cancelling a second time in the middle of that cleanup.
        await cancel(tuple(self.submission_tasks), request_cancel=False)
        self.clear_task_lease()
        self.active_product_turn_id = ""
        interactions = getattr(self, "interactions", None)
        if interactions is not None:
            await close(interactions.cancel_product_requests)
        self.bridge_token = ""
        if self.runtime_driver is not None and await close(self.runtime_driver.close):
            self.runtime_driver = None
            self.runtime_session = None
            self.held_model_bridge_id = ""
        # The observation pump could enqueue callbacks while earlier owners drained.
        await cancel(tuple(self._service_callbacks))
        await close(lambda: self._catalog.expire_pending_hil(self.id))
        release = self._on_release
        if release is not None:
            await close(lambda: release(self.id))
        self.held_model_bridge_id = ""
        if self._publication_task is not None:
            await close(lambda: self._publication_task)
        # An uncertain worker shutdown cannot authorize closing its Trace dependency.
        if await close(self._persistence.close):
            await close(
                self._close_update_trace
                if self._update_shutdown_generation is not None
                else self._trace.close
            )
        if failures:
            unique = list({id(error): error for error in failures}.values())
            if len(unique) == 1:
                raise unique[0]
            raise BaseExceptionGroup("session resource cleanup failed", unique)
        self.release_attachment_activity()

    async def _cancel_citation_review(self) -> None:
        self.interrupt_generation += 1
        task = self._citation_review_task
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            async with self._projection_lock:
                records = self._events.turn_records(
                    self.id,
                    self.active_product_turn_id,
                    self.ledger.active_turn_id,
                    kinds=(PRODUCT_EVENT_ANSWER_SOURCES,),
                )
                seen: set[str] = set()
                for record in reversed(records):
                    item_id = record.vendor_item_id or ""
                    if item_id in seen:
                        continue
                    seen.add(item_id)
                    if (
                        record.payload.get("coverage", {}).get("status")
                        == CoverageStatus.REVIEWING.value
                    ):
                        await self._publish_source_projection(
                            record.vendor_turn_id or "",
                            item_id,
                            {
                                **record.payload,
                                "coverage": {"status": CoverageStatus.INTERRUPTED.value},
                            },
                        )

    async def _project_file_changes(
        self,
        payload: Mapping[str, Any],
        *,
        turn_id: str,
        item_id: str,
        idempotency_prefix: str,
        generation: str,
    ) -> tuple[tuple[str, str], ...]:
        if str(payload.get("status") or "") != "completed":
            return ()
        changes = [row for row in list(payload.get("changes") or []) if isinstance(row, Mapping)]
        projected: list[tuple[str, str]] = []
        for index, change_row in enumerate(changes):
            original_path = str(
                change_row.get("path")
                or change_row.get("filePath")
                or change_row.get("file_path")
                or ""
            ).strip()
            if not original_path:
                continue
            change = str(change_row.get("change") or change_row.get("kind") or "update").lower()
            if change not in ARTIFACT_CHANGE_TYPES:
                change = ARTIFACT_CHANGE_UPDATE
            candidate = Path(original_path).expanduser()
            candidate = (
                candidate if candidate.is_absolute() else self.runtime_workdir / candidate
            ).resolve()
            if self._publications and self._publications.outside_session_root(
                self.project_id, self.output_root, candidate
            ):
                continue
            canonical = self._canonical_artifact_path(original_path)
            if self._resource_changes is not None and (
                canonical is not None
                or (
                    self._publications
                    and self._publications.resource_destination(self.project_id, candidate)
                    is not None
                )
            ):
                await self._resource_changes.record_change(
                    self.id,
                    turn_id,
                    str(candidate),
                    change,
                    generation=generation,
                )
            if canonical is None:
                continue
            relative = str(canonical.relative_to(self.runtime_workdir))
            projected.append((relative, change))
            file_event = await self.publish(
                PRODUCT_EVENT_FILE_CHANGED,
                {"change": change, "path": relative},
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=f"{idempotency_prefix}:file-{index}",
            )
            record = self._artifacts.index(
                session_id=self.id,
                runtime_id=self.runtime_id,
                vendor_thread_id=self.vendor_thread_id,
                vendor_turn_id=turn_id or None,
                vendor_item_id=item_id or None,
                source_kind=ArtifactSource.FILE_CHANGE,
                source_product_seq=file_event.product_seq,
                original_path=relative,
                canonical_path=str(canonical),
                role=ARTIFACT_DEFAULT_ROLE,
                status=ArtifactStatus.COMPLETED,
                mime_type=mimetypes.guess_type(canonical.name)[0],
                content_sha256=(
                    None if change == ARTIFACT_CHANGE_DELETE else self._file_sha256(canonical)
                ),
                size_bytes=self._file_size(canonical),
                metadata={"change": change},
                saved_to=(
                    self._publications.resource_destination(self.project_id, canonical)
                    if self._publications and change != ARTIFACT_CHANGE_DELETE
                    else None
                ),
                idempotency_key=f"{idempotency_prefix}:artifact-{index}",
            )
            await self.publish(
                PRODUCT_EVENT_ARTIFACT_CHANGED,
                {
                    "op": (
                        PRODUCT_EVENT_ARTIFACT_REMOVE
                        if change == ARTIFACT_CHANGE_DELETE
                        else PRODUCT_EVENT_ARTIFACT_UPSERT
                    ),
                    "artifact": artifact_payload(record, change=change),
                },
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=f"{idempotency_prefix}:artifact-event-{index}",
            )
        return tuple(projected)

    def _resource_generation(self, event: RuntimeEvent) -> str:
        return f"{event.runtime_id}:{event.native_session_id}:{event.process_generation}"

    def _canonical_artifact_path(self, value: str) -> Path | None:
        if not value.strip():
            return None
        candidate = Path(value).expanduser()
        if not candidate.is_absolute():
            candidate = self.runtime_workdir / candidate
        canonical = candidate.resolve()
        try:
            canonical.relative_to(self.runtime_workdir)
        except ValueError:
            return None
        return canonical

    @staticmethod
    def _file_size(path: Path) -> int | None:
        try:
            return path.stat().st_size if path.is_file() else None
        except OSError:
            return None

    @staticmethod
    def _file_sha256(path: Path) -> str | None:
        if not path.is_file():
            return None
        digest = sha256()
        try:
            with path.open("rb") as handle:
                while chunk := handle.read(FILE_HASH_CHUNK_BYTES):
                    digest.update(chunk)
        except OSError:
            return None
        return digest.hexdigest()
