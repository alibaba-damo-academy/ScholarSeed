"""Product runtime live ownership."""

from __future__ import annotations

import asyncio
import mimetypes
import secrets
import uuid
from dataclasses import asdict, replace
from hashlib import sha256
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from damoatrace.recording.redaction import SECRET_KEYS
from scholarseed_runtime.contract import (
    CapabilitySet,
    CommandState,
    InterruptRequest,
    InventoryKind,
    InventoryRequest,
    ModelThinking,
    PermissionIntent,
    RuntimeBinding,
    RuntimeCallbackRequest,
    RuntimeConfigurationIntent,
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
from scholarseed_runtime.contract.command import SkillConfiguration
from scholarseed_runtime.contract.evidence import (
    RuntimeProcessEvent,
    RuntimeRpcEvidence,
    RuntimeTimingPort,
)
from scholarseed_runtime.contract.history import HistoryEntry, MessagePhase
from scholarseed_runtime.contract.input import InputKind, TurnInput
from scholarseed_runtime.contract.inventory import SkillInventory
from scholarseed_runtime.contract.resource import ResourceReceipt
from scholarseed_runtime.contract.session import SuspendState
from scholarseed_runtime.gateway.driver import RuntimeDriver, RuntimeObservation, RuntimeTurnResult
from service.capabilities.service.skills import SkillCatalog, load_skill_state
from service.chat.constants import (
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
    PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
    PRODUCT_EVENT_REASONING_DELTA,
    PRODUCT_EVENT_RUNTIME_ERROR,
    PRODUCT_EVENT_RUNTIME_INCIDENT,
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_SESSION_TITLE_UPDATED,
    PRODUCT_EVENT_SKILL_STARTED,
    PRODUCT_EVENT_SUBAGENT_COMPLETED,
    PRODUCT_EVENT_SUBAGENT_FAILED,
    PRODUCT_EVENT_SUBAGENT_INTERRUPTED,
    PRODUCT_EVENT_SUBAGENT_SPAWNED,
    PRODUCT_EVENT_SUBAGENT_STARTED,
    PRODUCT_EVENT_SUBAGENT_STATUS_CHANGED,
    PRODUCT_EVENT_TOOL_COMPLETED,
    PRODUCT_EVENT_TOOL_OUTPUT_DELTA,
    PRODUCT_EVENT_TOOL_STARTED,
    PRODUCT_EVENT_USAGE_UPDATED,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
    PRODUCT_REFERENCE_ORIGIN_LOCAL_DIRECTORY,
    PRODUCT_REFERENCE_ORIGIN_LOCAL_FILE,
    PRODUCT_REFERENCE_SKILL,
    PRODUCT_SESSION_STATE_CLOSED,
    PRODUCT_SESSION_STATE_IDLE,
    PRODUCT_SESSION_STATE_RUNNING,
    PRODUCT_SESSION_STATE_WAITING,
    RUNTIME_LEGACY_ERROR,
    SESSION_RENAME_MAX_LENGTH,
    SESSION_TITLE_DEFAULT,
    SESSION_TITLE_ELLIPSIS,
    SSE_BACKPRESSURE_EVENT,
    USER_MESSAGE_BINDING_ADMITTED,
    USER_MESSAGE_BINDING_BOUND,
    USER_MESSAGE_ORIGIN_TURN,
    USER_MESSAGE_ORIGINS,
)
from service.chat.persistence.artifacts import ArtifactSource, ArtifactStatus, SessionArtifactStore
from service.chat.persistence.catalog import HilStatus, SessionCatalogStore, SessionStatus
from service.chat.persistence.events import (
    ProductEventRecord,
    ProductEventStore,
    upcast_product_event,
)
from service.chat.persistence.publications import PublicationRecord
from service.chat.provenance import MODEL_RUN_FIELD, ModelRun
from service.chat.runtime.content import MessageSnapshots
from service.chat.runtime.evidence import RUNTIME_EVIDENCE_LIMIT, SessionTrace, decode_evidence
from service.chat.runtime.extensions import EXTENSION_PROJECTIONS
from service.chat.runtime.history import _merge_history_entries
from service.chat.runtime.incidents import event_incident
from service.chat.runtime.interaction import SessionInteractions, interaction_snapshot
from service.chat.runtime.inventory import _skill_inventory_from_runtime
from service.chat.runtime.ledger import SessionLedger
from service.chat.runtime.projection import (
    ARTIFACT_CHANGE_DELETE,
    ARTIFACT_CHANGE_TYPES,
    ARTIFACT_CHANGE_UPDATE,
    ARTIFACT_DEFAULT_ROLE,
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
from service.chat.runtime.utils import integer, optional_integer
from service.chat.service.cards import (
    DISPLAY_CARD_IDEMPOTENCY_PREFIX,
    DISPLAY_CARD_MAX_BYTES_PER_TURN,
    DISPLAY_CARD_MAX_PER_TURN,
    CardRegistry,
    DisplayCardError,
    card_identity,
    normalize_card,
)
from service.chat.service.estimate import SkillDurationEstimator
from service.chat.service.plan import SessionPlans
from service.chat.service.publication import PublicationCommand, PublicationService
from service.chat.service.recording import RecordingService
from service.chat.service.rejections import terminal_provider_failure
from service.chat.service.sources import answer_sources
from service.chat.service.tasks import ProductTaskLease
from service.content.domain.model import ContentError
from service.platform.bridge import BRIDGE_TOKEN_BYTES, DisplayCardContent, PlanWrite
from service.platform.citations import CitationAnswerFilter
from service.platform.resources import AgentResourceChangeSink

READ_ONLY_TOOL_NAME = "read"

SessionActivityObserver = Callable[["LiveSession"], None]


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
        project_id: str = "",
        resource_changes: AgentResourceChangeSink | None = None,
        local_socket: Path | None = None,
        publications: PublicationService | None = None,
        cards: CardRegistry | None = None,
        reasoning_effort: str = "",
        thinking: ModelThinking | None = None,
        activity_observer: SessionActivityObserver | None = None,
        answer_filter: CitationAnswerFilter | None = None,
        skill_inventory_provider: Callable[[Path], Awaitable[SkillInventory]] | None = None,
    ) -> None:
        self.id = session_id
        self.bridge_token = secrets.token_urlsafe(BRIDGE_TOKEN_BYTES)
        self.local_socket = local_socket
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
        self.last_submission_id = ""
        # 当前已准入的**产品轮** id（= ``client_user_message_id``），出站计量的轮粒度真值：
        # bridge 每次模型调用按 session_id 反查它去填 ``X-Deeprd-Conv-Turn-id``。它与
        # ``ledger.active_turn_id`` 不是一回事 —— 后者是 vendor 轮 id，要等 Codex 的 turnStarted
        # 事件回来才落定，而这一轮的模型调用那时可能已经打出去了（会记到上一轮头上）。
        self.active_product_turn_id = ""
        self._model_bridge_failure: tuple[str, dict[str, str]] | None = None
        self.active_assistant_snapshot_id = ""
        self.active_assistant_revision: int | None = None
        self.active_task_type = ""
        self.product_turn_generation = 0
        self.active_task_lease: ProductTaskLease | None = None
        self.active_turn_started_at = 0.0
        self._activity_observer = activity_observer
        self._answer_filter = answer_filter
        self._catalog = catalog
        self.interactions = SessionInteractions(self.id, catalog, self.publish)
        self.plans = SessionPlans(self.id, events, catalog)
        self._events = events
        self._duration_estimator = SkillDurationEstimator(events)
        self._artifacts = artifacts
        self._skills = skills
        self._skill_inventory_provider = skill_inventory_provider
        self._logger = logger
        self._active = False
        self._projection_lock = asyncio.Lock()
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
            self.id, catalog, self.publish, self._trace, logger, self._projection_lock
        )

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

    def attach_gateway(self, session: RuntimeSession, *, resumed: bool) -> RuntimeDriver:
        binding = session.binding
        if binding.product_session_id != self.id:
            raise ValueError("runtime binding product session mismatch")
        if binding.runtime_id != self.runtime_id:
            raise ValueError("runtime binding provider mismatch")
        self.runtime_session = session
        self.runtime_binding = binding
        self.vendor_thread_id = binding.opaque_session_ref
        self.resumed = resumed
        generation = self.attachment_generation

        async def observe(observation: RuntimeObservation) -> None:
            if self.attachment_generation != generation or self.runtime_session is not session:
                return
            await self.on_runtime_observation(observation)

        self.runtime_driver = RuntimeDriver(session, observe)
        return self.runtime_driver

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

    async def set_writable_roots(self, roots: tuple[Path, ...]) -> bool:
        """把新的可写根集合推给 vendor 会话 (proposal 47 §6.9)。

        下一个 turn 生效: adapter 每个 turn 都会重新构造 `sandboxPolicy`,
        所以既不需要 rebind, 也不需要重开 vendor thread。正在跑的那个 turn
        无法中途剥夺 —— policy 已经下发过了, 上界是立即中断。

        返回是否真的推下去了: adapter 不具备这个能力 (native 会话没有沙箱可写
        根概念) 时回 False, 让调用方能把「Agent 面只读」如实告诉用户, 而不是
        假装授权已生效。
        """

        session = self.runtime_session
        if session is not None:
            mode = RuntimePermissionMode(
                self.applied_permission_mode or RuntimePermissionMode.ASK.value
            )
            permission = PermissionIntent(
                mode=mode,
                revision=f"permission:{mode.value}:roots",
                writable_roots=tuple(roots),
                local_sockets=(self.local_socket,) if self.local_socket else (),
            )
            applied = await session.reconfigure(
                RuntimeConfigurationIntent(
                    revision=permission.revision,
                    permission=permission,
                    required=True,
                )
            )
            if applied.state is not CommandState.APPLIED:
                return False
            self.writable_roots = tuple(roots)
            return True
        return False

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

    async def suspend_runtime(self) -> bool:
        async with self.lifecycle_lock:
            driver = self.runtime_driver
            if driver is None:
                self.active_product_turn_id = ""
                return True
            if (
                self.running
                or self.interrupting
                or self.terminating
                or self.steer_lock.locked()
                or self.ledger.has_unknown_outcome
                or self.pending_hil_snapshot()
                or (
                    self.resource_task is not None
                    and self.resource_task is not asyncio.current_task()
                    and not self.resource_task.done()
                )
            ):
                return False
            if not driver.suspending:
                activity = await driver.session.activity()
                if not activity.idle:
                    self.trace_resource("suspend_blocked", blockers=list(activity.blockers))
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
            self._skill_inventory = None
            self.bridge_token = ""
            self.active_product_turn_id = ""
            if self._on_release is not None:
                self._on_release(self.id)
            return True

    async def run_runtime(self, turn_input: TurnInput) -> RuntimeTurnResult:
        driver = self.runtime_driver
        if driver is None:
            raise RuntimeError("runtime session driver is unavailable")
        # 必须在把轮交给 runtime 之前落定：之后 Codex 子进程的每次模型调用都经 loopback bridge
        # 出站，bridge 只能按会话反查「这一轮是谁」。
        self.active_product_turn_id = turn_input.client_user_message_id
        self._running_model = self.model_run
        # Native hosts cache discovery independently; refresh before every new turn.
        await self.refresh_skills(force_reload=True)
        items: tuple[RuntimeValue, ...] = tuple(
            {
                "kind": item.kind.value,
                "text": item.text,
                "path": str(item.path) if item.path is not None else "",
                "name": item.name,
            }
            for item in turn_input.items
        )
        return await driver.submit(
            TurnRequest(
                command_id=turn_input.client_user_message_id,
                items=items,
                model=self.model_id,
                collaboration_mode=turn_input.collaboration_mode.value,
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

    async def on_runtime_observation(self, observation: RuntimeObservation) -> None:
        """Project one validated Gateway observation into durable product state."""

        async with self._projection_lock:
            if isinstance(observation, RuntimeCallbackRequest):
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
                self._catalog.record_hil(
                    product_request_id=observation.request_id,
                    session_id=self.id,
                    vendor_request_id=observation.request_id,
                    vendor_turn_id=observation.native_turn_id or None,
                    vendor_item_id=observation.native_item_id or None,
                    method=observation.kind.value,
                    payload=payload,
                )
                self._catalog.update_status(
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

    def _observe_activity(self) -> None:
        """Let product policy inspect workspace state after a completed runtime action."""

        if self._activity_observer is None:
            return
        try:
            self._activity_observer(self)
        except Exception:  # noqa: BLE001 - observers must not break runtime projection
            self._logger.warning("session_activity_observer_failed session_id=%s", self.id)

    async def _project_runtime_event(self, event: RuntimeEvent) -> None:
        if event.kind is RuntimeEventKind.RUNTIME_EVIDENCE:
            process, rpc = decode_evidence(event)
            for process_event in process:
                self._trace.runtime_process_event(process_event)
            for rpc_event in rpc:
                self._trace.runtime_rpc_evidence(rpc_event)
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
                    event = replace(event, payload={**dict(event.payload), **failure})
        event = self._recover_incident_attribution(event)
        self._trace.runtime_event(event)
        incident = event_incident(event)
        if incident is not None and event.kind is not RuntimeEventKind.RUNTIME_INCIDENT:
            await self.ledger.incident(
                replace(event, correlation_id=self.last_submission_id), incident
            )
        payload = dict(event.payload) if isinstance(event.payload, Mapping) else {}
        key = f"runtime:{event.event_id}"
        turn_id = event.native_turn_id
        item_id = event.native_item_id
        if event.kind in {
            RuntimeEventKind.SESSION_OPENED,
            RuntimeEventKind.SESSION_RESUMED,
        }:
            self._catalog.update_status(self.id, SessionStatus.READY)
            await self.publish(
                PRODUCT_EVENT_SESSION_STATE,
                {"state": PRODUCT_SESSION_STATE_IDLE, "runtime_id": event.runtime_id},
                idempotency_key=key,
            )
            return
        if event.kind is RuntimeEventKind.TURN_STARTED:
            if self._running_model is not None:
                self._turn_models[turn_id] = self._running_model
            queued = self._catalog.mark_queue_running(self.id, event.correlation_id, turn_id)
            if queued is not None:
                await self.publish(
                    PRODUCT_EVENT_MESSAGE_REMOVED,
                    {"queued_message_id": queued.queued_message_id, "reason": "started"},
                    turn_id=turn_id,
                    idempotency_key=f"queue:{queued.queued_message_id}:started",
                )
            await self.ledger.started(event)
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
            delta = str(payload.get("text") or payload.get("delta") or "")
            message = {
                "delta": (
                    delta
                    if role == "reasoning"
                    else self._message_snapshots.append(turn_id, item_id, delta)
                )
            }
            message.update(self.answer_model(turn_id))
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
            self._message_snapshots.finish(turn_id, item_id)
            if str(payload.get("role") or "") == "assistant":
                completed_phase = payload.get("phase")
                completed_text = str(payload.get("text") or "")
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
                    try:
                        source_projection = answer_sources(
                            completed_text,
                            self._events.turn_records(
                                self.id,
                                turn_id,
                                turn_id,
                                kinds=(
                                    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                                    PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
                                ),
                            ),
                        )
                        if source_projection["sources"]:
                            await self.publish(
                                PRODUCT_EVENT_ANSWER_SOURCES,
                                source_projection,
                                turn_id=turn_id,
                                item_id=item_id,
                                idempotency_key=f"{key}:answer-sources",
                            )
                    except Exception:  # noqa: BLE001
                        self._logger.error(
                            "answer_sources_projection_failed session_id=%s turn_id=%s",
                            self.id,
                            turn_id,
                            exc_info=True,
                        )
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
                },
                turn_id=turn_id,
                item_id=item_id,
                idempotency_key=key,
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
            product_event = self.plans.native(
                todos,
                runtime_id=self.runtime_id,
                vendor_thread_id=self.vendor_thread_id,
                turn_id=turn_id,
                item_id=item_id,
                key=key,
                explanation=str(payload.get("explanation") or "") or None,
            )
            if product_event is not None:
                self._broadcast_product_event(product_event)
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
                    self._catalog.resolve_hil(request_id, dict(payload))
                record = self._catalog.acknowledge_hil(request_id)
                resolved = interaction_snapshot(record)
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
        if event.kind is RuntimeEventKind.TURN_COMPLETED:
            await self.finalize_answer_model(turn_id, key)
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
            self._catalog.update_status(self.id, SessionStatus.CLOSED)
            await self.publish(
                PRODUCT_EVENT_SESSION_STATE,
                {"state": PRODUCT_SESSION_STATE_CLOSED, "runtime_id": event.runtime_id},
                idempotency_key=key,
            )

    def source_text(self, client_turn_id: str) -> str | None:
        record = self._events.by_key(self.id, f"{INTERNAL_EVENT_KEY_PREFIX}:user:{client_turn_id}")
        return str(record.payload.get("text") or "") if record is not None else None

    async def release_product_turn(self, client_turn_id: str) -> bool:
        """Release model provenance only after the native thread tree is quiescent."""

        if not client_turn_id or self.active_product_turn_id != client_turn_id:
            return False
        session = self.runtime_session
        if session is None:
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
        self.active_product_turn_id = ""
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
    ) -> None:
        if not text and not references:
            return
        if origin not in USER_MESSAGE_ORIGINS:
            raise ValueError("user message origin is invalid")
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
        if not error_code:
            # 无结构化 error_code 的 finished 诊断（成功轮 / 空终态）不参与归因，也不冲掉
            # 同 turn 已恢复的值——它没有可覆盖的信息。
            return
        # 同 turn 多次上游调用（Codex 流重试）取最后一条带 error_code 的 finished 诊断：
        # 命中白名单则恢复真实归因，未命中则清空，忠实反映最后一次上游结果。终态事件统一
        # 清槽，故不会跨 turn 串味。
        failure = terminal_provider_failure(fields)
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
        payload = event.payload if isinstance(event.payload, Mapping) else None
        raw = payload.get("incident") if isinstance(payload, Mapping) else None
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
        return replace(event, payload={**dict(payload), "incident": incident})

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

    async def adopt_user_title(self, text: str, *, turn_id: str) -> bool:
        """Persist the first natural-language request as the product-owned title."""

        clean = " ".join(text.split())
        if not clean:
            return False
        if len(clean) > SESSION_RENAME_MAX_LENGTH:
            clean = clean[: SESSION_RENAME_MAX_LENGTH - len(SESSION_TITLE_ELLIPSIS)].rstrip()
            clean = f"{clean}{SESSION_TITLE_ELLIPSIS}"
        record = self._catalog.adopt_generated_title(
            self.id,
            clean,
            replaceable_titles=(SESSION_TITLE_DEFAULT,),
        )
        if record.title != clean:
            return False
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

        inventory = self._skill_inventory
        if self._skill_inventory_provider is not None:
            inventory = await self._skill_inventory_provider(self.runtime_workdir)
        elif inventory is None or force_reload:
            inventory = await self.refresh_skills(force_reload=force_reload)
        rows = self._skills.payloads(inventory, load_skill_state(), user_id=self.user_id)
        return next(
            (row for row in rows if bool(row.get("active")) and str(row.get("name") or "") == name),
            None,
        )

    async def skill_identity(self, path: Path, name: str) -> Mapping[str, Any] | None:
        """Return the active product identity for one exact runtime Skill path."""

        canonical = path.expanduser().resolve()
        identity = await self.skill_identity_by_name(name)
        if identity is None:
            return None
        identity_path = Path(str(identity.get("path") or "")).expanduser().resolve()
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

    def clear_task_lease(self) -> None:
        self.active_task_lease = None
        self.active_task_type = ""

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

    async def write_plan(self, command: PlanWrite) -> ProductEventRecord:
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

            record = self.plans.write(
                command,
                runtime_id=self.runtime_id,
                vendor_thread_id=self.vendor_thread_id,
                require_turn=require_turn,
            )
            self._broadcast_product_event(record)
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
        key = idempotency_key or f"{INTERNAL_EVENT_KEY_PREFIX}:{uuid.uuid4().hex}"
        if turn_id and (
            kind in COLLABORATION_CLOSURE_STATUS
            or (
                kind in COLLABORATION_EVENT_KINDS
                and data.get("activity_type") == COLLABORATION_ACTIVITY_TYPE
            )
        ):
            return self._publish_collaboration_lifecycle(kind, data, turn_id, item_id, key)
        record = self._events.append(
            session_id=self.id,
            runtime_id=self.runtime_id,
            vendor_thread_id=self.vendor_thread_id,
            vendor_turn_id=turn_id or None,
            vendor_item_id=item_id or None,
            kind=kind,
            payload=dict(data),
            idempotency_key=key,
        )
        self._broadcast_product_event(record)
        return record

    def _publish_collaboration_lifecycle(
        self, kind: str, data: Mapping[str, Any], turn_id: str, item_id: str, key: str
    ) -> ProductEventRecord:
        published: list[ProductEventRecord] = []
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
                return completed[item_id]
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
            if kind not in COLLABORATION_EVENT_KINDS:
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
        for published_record in published:
            self._broadcast_product_event(published_record)
        return record

    def _broadcast_product_event(self, record: ProductEventRecord) -> None:
        """Expose only records whose owning persistence transaction has committed."""

        self._trace.product_event(record)
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
            self._broadcast_product_event(record)

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
        self._broadcast_product_event(declared)
        self._broadcast_product_event(changed)

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
        canonical = self._canonical_artifact_path(path)
        if canonical is None:
            raise ArtifactPublishError(ARTIFACT_PUBLISH_PATH_INVALID)
        if not declaration_id and not canonical.is_file():
            raise ArtifactPublishError(ARTIFACT_PUBLISH_FILE_NOT_FOUND)
        relative = str(canonical.relative_to(self.runtime_workdir))
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
        card_id = card_identity(self.id, turn_id, card_type, digest)
        payload = {"card_id": card_id, "type": card_type, "content": normalized}
        idempotency_key = f"{DISPLAY_CARD_IDEMPOTENCY_PREFIX}:{turn_id}:{card_type}:{digest}"
        with self._events.transaction() as connection:
            existing = self._events.by_key(self.id, idempotency_key, connection=connection)
            if existing is None:
                count, byte_count = self._events.turn_kind_usage(
                    self.id,
                    turn_id,
                    PRODUCT_EVENT_DISPLAY_CARD,
                    connection=connection,
                )
                if count >= DISPLAY_CARD_MAX_PER_TURN:
                    raise DisplayCardError("display_card_turn_limit_exceeded")
                if byte_count + encoded_size > DISPLAY_CARD_MAX_BYTES_PER_TURN:
                    raise DisplayCardError("display_card_turn_bytes_exceeded")
            record = self._events.append(
                session_id=self.id,
                runtime_id=self.runtime_id,
                vendor_thread_id=self.vendor_thread_id,
                vendor_turn_id=turn_id,
                vendor_item_id=None,
                kind=PRODUCT_EVENT_DISPLAY_CARD,
                payload=payload,
                idempotency_key=idempotency_key,
                connection=connection,
            )
        if existing is None:
            self._broadcast_product_event(record)
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
            self._broadcast_product_event(event)
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

    def pending_hil_snapshot(self) -> list[dict[str, Any]]:
        return [
            {
                "request_id": row.product_request_id,
                **row.payload,
                "turn_id": row.vendor_turn_id,
                "item_id": row.vendor_item_id,
            }
            for row in self._catalog.pending_hil(self.id)
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

    async def interrupt(self) -> None:
        if await self.cancel_resource_wait():
            return
        runtime_session = self.runtime_session
        if runtime_session is None:
            raise RuntimeError("runtime session is unavailable")
        self.interrupt_generation += 1
        self.interrupting = True
        self.last_interrupt_succeeded = None
        try:
            record = self._catalog.get(self.id)
            expected_turn_id = (record.last_turn_id if record is not None else "") or ""
            if runtime_session is not None:
                receipt = await runtime_session.interrupt(
                    InterruptRequest(
                        command_id=f"interrupt-{uuid.uuid4().hex}",
                        expected_turn_id=expected_turn_id,
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
            if not self._catalog.delete_queued_message(self.id, request_id):
                return False
            await self.publish(
                PRODUCT_EVENT_MESSAGE_REMOVED,
                {"queued_message_id": request_id, "reason": "cancelled"},
                idempotency_key=f"queue:{request_id}:cancelled",
            )
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return True

    async def terminate(self) -> None:
        runtime_session = self.runtime_session
        command_id = f"terminate-{uuid.uuid4().hex}"
        self.terminating = True
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

    async def aclose(self) -> None:
        self.clear_task_lease()
        self.active_product_turn_id = ""
        interactions = getattr(self, "interactions", None)
        if interactions is not None:
            await interactions.cancel_product_requests()
        resource_task = self.resource_task
        if resource_task is not None and resource_task is not asyncio.current_task():
            resource_task.cancel()
            await asyncio.gather(resource_task, return_exceptions=True)
        self.resource_task = None
        self.bridge_token = ""
        try:
            if self.runtime_driver is not None:
                await self.runtime_driver.close()
                self.runtime_driver = None
                self.runtime_session = None
            self._catalog.expire_pending_hil(self.id)
        finally:
            if self._on_release is not None:
                try:
                    self._on_release(self.id)
                except Exception:  # noqa: BLE001 - 清理失败不得遮蔽关闭路径
                    self._logger.warning("session_release_failed session_id=%s", self.id)
            self._trace.close()

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
