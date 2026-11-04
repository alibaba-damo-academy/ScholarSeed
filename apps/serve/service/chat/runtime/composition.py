"""Product runtime composition ownership."""

from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Mapping

from scholarseed_runtime.contract import (
    CallbackAudience,
    CallbackKind,
    CapabilitySet,
    CapabilityState,
    CommandReceipt,
    CommandState,
    ForkRequest,
    InterruptRequest,
    InventoryKind,
    InventoryRequest,
    ModelThinking,
    OpenSessionRequest,
    PermissionIntent,
    ResumeSessionRequest,
    RuntimeCallbackRequest,
    RuntimeCallbackResponse,
    RuntimeCapabilityName,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeInspectionRequest,
    RuntimeInventory,
    RuntimePermissionMode,
    RuntimeReadiness,
    RuntimeSession,
    RuntimeStatus,
    RuntimeValue,
    TurnRequest,
    service_tool_profile,
)
from scholarseed_runtime.contract.command import (
    RUNTIME_SKILL_POLICY_UNSUPPORTED,
    EmptyThreadReplacementProof,
    HostWarmupRequest,
    SkillConfiguration,
    SkillConfigurationRequest,
    ThreadReplacementProof,
)
from scholarseed_runtime.contract.evidence import NOOP_RUNTIME_TIMING, RuntimeTimingPort
from scholarseed_runtime.contract.incident import RuntimeRetryability
from scholarseed_runtime.contract.input import TurnAdmission as RuntimeTurnAdmission
from scholarseed_runtime.contract.inventory import ModelInventory, SkillInventory, SkillPolicy
from scholarseed_runtime.contract.mcp import RuntimeMcpConfiguration
from scholarseed_runtime.contract.provider import (
    RUNTIME_HOST_RECONFIGURATION_COMMAND,
    RuntimeHostReconfiguration,
    RuntimeHostWarmup,
    RuntimeOpenNotAppliedError,
)
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_BUSY,
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    RESOURCE_HOST_CONTEXT_REQUIRED,
    ResourcePurpose,
    ResourceRequest,
)
from scholarseed_runtime.contract.session import (
    RUNTIME_TRANSIENT_ACTIVITY_BLOCKERS,
    RuntimeExecutionThread,
    ThreadReplacementTarget,
)
from scholarseed_runtime.gateway.driver import (
    RuntimeDriver,
    RuntimeObservation,
    RuntimeObservationHandler,
    RuntimeTurnResult,
)
from service.capabilities.service.skills import (
    SkillCatalog,
    SkillProductState,
    load_skill_state,
    save_skill_state,
)
from service.chat.active import (
    RUNTIME_ALLOWED_NETWORK_DOMAINS,
    base_instructions,
    developer_instructions,
)
from service.chat.constants import PRODUCT_EVENT_SESSION_STATE, PRODUCT_SESSION_STATE_IDLE
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.catalog import (
    OpenState,
    QueuedMessageState,
    ReplacementKind,
    ReplacementState,
    SessionCatalogStore,
)
from service.chat.persistence.events import (
    SESSION_FORK_KEY,
    SESSION_FORK_SOURCE_CHANGED,
    ProductEventStore,
)
from service.chat.runtime.activation import (
    SESSION_OPEN_UNKNOWN,
    ActivationPlan,
    ResourceWaitObserver,
    SessionActivation,
    SessionActivationError,
)
from service.chat.runtime.evidence import SessionTrace, decode_evidence
from service.chat.runtime.inventory import (
    _model_inventory_from_runtime,
    _skill_inventory_from_runtime,
)
from service.chat.runtime.live import LiveSession, SessionActivityObserver
from service.chat.runtime.permission import session_permission
from service.chat.runtime.projection import (
    ONE_SHOT_RUNTIME_FAILURE_CODE,
    RUNTIME_DEFAULT_MODEL_UNAVAILABLE_ERROR,
)
from service.chat.runtime.reconfiguration import RECONFIGURATION_STALE, HostReconfiguration
from service.chat.runtime.secrets import _launch_secret_contract
from service.chat.runtime.selection import RuntimeDiscovery, RuntimeGateway
from service.chat.runtime.timing import ActivationStage
from service.chat.runtime.tools import (
    SERVICE_BRIDGE_TOOL,
    SESSION_SERVICE_TOOLS,
    execute_service_tool,
)
from service.chat.service.cards import CardRegistry
from service.chat.service.coverage import CitationCoverage
from service.chat.service.models import ModelService, SessionModelSpec
from service.chat.service.publication import PublicationService
from service.chat.service.recording import RecordingService
from service.identity.utils import LOCAL_USER_ID
from service.inference.reasoning import minimum_effort, require_declared_effort
from service.paths import SERVICE_SKILL_ROOTS
from service.platform.activity import (
    Activities,
    ActivityDomain,
    ActivityLease,
    ActivityPhase,
    MaintenanceActive,
    MaintenanceStale,
)
from service.platform.bridge import SkillCaller
from service.platform.citations import CitationAnswerFilter
from service.platform.python import prepare_commands
from service.platform.resources import AgentResourceChangeSink
from service.platform.startup import startup_phase
from service.platform.storage import filesystem_path
from service.platform.toolchain import CompilerResources, ToolchainReadiness, ToolchainState
from service.platform.vocabulary import (
    BRIDGE_SESSION_ENV,
    BRIDGE_SOCKET_ENV,
    BRIDGE_TOKEN_ENV,
    INTERNAL_BASE_URL_ENV,
)
from service.settings.capabilities import REASONING_EFFORT_LEVELS

THREAD_REBUILT_EVENT_KEY_PREFIX = "runtime:thread-rebuilt"


def _invocation_turn_identity(session_id: str) -> str:
    """一次性 invocation 的轮 id 解析器：它注册 bridge 用的 session_id 本身就是轮 id。

    会话型注册必须按会话反查「现在是哪一轮」（组合根注入 ModelService 的那个解析器），因为一次
    注册要跨这个会话之后所有的轮。``invoke_once`` 不是这个形状：一个 invocation 只跑一轮，而且它
    就是把 ``invocation_id`` 当 bridge 的 ``session_id`` 注册的。
    """

    return str(session_id or "")


@dataclass(frozen=True)
class OneShotRuntimeResult:
    """Resolved model identity plus the vendor-neutral result of one isolated turn."""

    model_key: str
    turn: RuntimeTurnResult
    vendor_thread_id: str = ""


class OneShotRuntimeError(RuntimeError):
    """Safe action failure classified by whether a vendor turn may have started."""

    def __init__(self, *, submitted: bool, safe_error: str = "") -> None:
        self.safe_error = (
            safe_error
            if not submitted
            and safe_error
            in {
                RESOURCE_HOST_CONFIGURATION_CONFLICT,
                RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
                RESOURCE_HOST_CONTEXT_REQUIRED,
                RESOURCE_HOST_BUSY,
                RUNTIME_SKILL_POLICY_UNSUPPORTED,
            }
            else ONE_SHOT_RUNTIME_FAILURE_CODE
        )
        super().__init__(self.safe_error)
        self.retryability = (
            RuntimeRetryability.UNKNOWN_OUTCOME if submitted else RuntimeRetryability.USER_RETRYABLE
        )


#: 技能盘点缓存的兜底 TTL。产品内启用/安装/删除路径都会重建缓存, 这里只兜
#: 「用户绕过产品手改技能目录」的漂移: 过期后读路径先回旧值, 再后台单飞刷新。
SKILL_INVENTORY_CACHE_TTL_SECONDS = 60.0


@dataclass(frozen=True)
class SkillInventoryCache:
    """One workspace's reconciled inventory plus the state it was reconciled to."""

    inventory: SkillInventory
    state: SkillProductState
    refreshed_at: float


@dataclass
class RuntimeOpening:
    runtime_id: str
    session_id: str
    activity: ActivityLease
    settled: bool = False
    project_id: str = ""
    directories: tuple[Path, ...] = ()


class LiveSessionService:
    """Open typed Codex adapters and expose runtime readiness."""

    def __init__(
        self,
        *,
        activities: Activities,
        catalog: SessionCatalogStore,
        events: ProductEventStore,
        artifacts: SessionArtifactStore,
        skills: SkillCatalog,
        models: ModelService,
        logger: Any,
        gateway: RuntimeGateway | None = None,
        discovery: RuntimeDiscovery | None = None,
        resource_changes: AgentResourceChangeSink | None = None,
    ) -> None:
        self._activities = activities
        self.toolchain = ToolchainReadiness()
        self._uncertain_attachments: dict[str, RuntimeOpening] = {}
        self._skill_configuration_lock = asyncio.Lock()
        self._skill_inventory_cache: dict[tuple[str, str, Path], SkillInventoryCache] = {}
        self._skill_inventory_refresh: dict[tuple[str, str, Path], asyncio.Task[SkillInventory]] = (
            {}
        )
        self._catalog = catalog
        self.recording = RecordingService(catalog, events)
        self._events = events
        self._artifacts = artifacts
        self._skills = skills
        self._models = models
        self._logger = logger
        if gateway is not None and discovery is not None:
            raise ValueError("runtime composition requires one discovery source")
        selected_discovery = discovery or (RuntimeDiscovery.discover() if gateway is None else None)
        self._tool_resources = selected_discovery.sandbox_resources if selected_discovery else None
        self._compiler_resources = CompilerResources.from_tool_resources(self._tool_resources)
        if gateway is not None:
            self._gateway = gateway
        elif selected_discovery is not None:
            self._gateway = selected_discovery.configure(
                resource_lease=self._runtime_resource_lease
            )
        else:
            raise ValueError("runtime composition requires a discovery source")
        self.activation = SessionActivation(
            activities=activities,
            build=self._activation_plan,
            revision=self._activation_revision,
            attach=self._attach_runtime,
            provider=self._gateway.provider,
            prepare=self._prepare_attachment,
            discard=self._discard_attachment,
            logger=logger,
        )
        self._resource_changes = resource_changes
        self.runtime_id = self._gateway.default_runtime_id
        self._closed = False
        self._one_shot_close_failures: dict[str, BaseException] = {}
        self._one_shot_drivers: dict[str, tuple[str, RuntimeDriver]] = {}
        self._one_shot_tasks: dict[str, tuple[str, asyncio.Task[Any]]] = {}
        self._one_shot_directories: dict[str, tuple[Path, ...]] = {}
        self._project_id_for_path: Callable[[Path], str] | None = None
        self._local_socket: Path | None = None
        self._publications: PublicationService | None = None
        self._cards = CardRegistry()
        self._activity_observer: SessionActivityObserver | None = None
        self._answer_filter: CitationAnswerFilter | None = None
        self._citation_coverage: CitationCoverage | None = None
        self._answer_guard: Callable[[str, bool], str] | None = None
        self._readiness_task: asyncio.Task[None] | None = None
        self._host_warmup_cwd: Path | None = None
        self._host_environment: Callable[[str], Awaitable[Mapping[str, str]]] | None = None
        self.reconfiguration = HostReconfiguration(
            activities=activities, drain=self.drain_for_update, logger=logger
        )
        self._host_models: dict[str, str] = {}

    def bind_host_warmup(
        self,
        *,
        cwd: Path,
        environment: Callable[[str], Awaitable[Mapping[str, str]]],
    ) -> None:
        if self._host_environment is not None:
            raise ValueError("runtime host warmup context is already bound")
        self._host_warmup_cwd = cwd
        self._host_environment = environment

    @property
    def reconfiguration_wait_seconds(self) -> float:
        return self._gateway.provider(self.runtime_id).resource_policy.wait_seconds

    @property
    def reconfiguration_supported(self) -> bool:
        provider = self._gateway.provider(self.runtime_id)
        return isinstance(provider, RuntimeHostReconfiguration) and any(
            item.name == RuntimeCapabilityName.HOST_RECONFIGURATION.value
            and item.state is CapabilityState.SUPPORTED
            for item in provider.descriptor.capabilities.entries
        )

    @asynccontextmanager
    async def _host_context(
        self,
        *,
        cwd: Path,
        user_id: str,
        model_id: str = "",
        process_environment: Mapping[str, str] | None = None,
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
    ) -> AsyncIterator[tuple[HostWarmupRequest, str]]:
        async with self._host_intent(
            cwd=cwd,
            user_id=user_id,
            model_id=model_id,
            process_environment=process_environment,
            timing=timing,
        ) as host:
            receipt = await self._gateway.provider(self.runtime_id).prewarm(host)
            if receipt.state is not CommandState.APPLIED or not receipt.correlation_id:
                raise SessionActivationError(receipt.safe_error or RESOURCE_HOST_CONTEXT_REQUIRED)
            yield host, receipt.correlation_id

    @asynccontextmanager
    async def _host_intent(
        self,
        *,
        cwd: Path,
        user_id: str,
        model_id: str = "",
        process_environment: Mapping[str, str] | None = None,
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
        catalog_activity: ActivityLease | None = None,
        expected_model_id: str = "",
    ) -> AsyncIterator[HostWarmupRequest]:
        if not user_id.strip() or self._host_environment is None:
            raise ValueError(RESOURCE_HOST_CONTEXT_REQUIRED)
        provider = self._gateway.provider(self.runtime_id)
        required = {
            RuntimeCapabilityName.HOST_WARMUP.value,
            RuntimeCapabilityName.SHARED_HOST_CONTROL.value,
        }
        supported = {
            item.name
            for item in provider.descriptor.capabilities.entries
            if item.state is CapabilityState.SUPPORTED
        }
        if not isinstance(provider, RuntimeHostWarmup) or not required <= supported:
            raise ValueError(RESOURCE_HOST_CONTEXT_REQUIRED)
        environment = dict(await self._host_environment(user_id))
        if process_environment is not None and dict(process_environment) != environment:
            raise ValueError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
        launch_secrets, secret_port = _launch_secret_contract(environment)
        request_id = uuid.uuid4().hex
        try:
            model = self._models.session_spec(
                self._models.selected_model_key(
                    model_id or self._host_models.get(user_id, ""), user_id=user_id
                ),
                session_id=request_id,
                user_id=user_id,
                catalog_activity=catalog_activity,
            )
            if expected_model_id and model.key != expected_model_id:
                raise ValueError(RECONFIGURATION_STALE)
            intent, credential_port = model.runtime_model()
            host = HostWarmupRequest(
                request_id=request_id,
                cwd=cwd.expanduser().resolve(),
                process_sharing_scope=user_id,
                model=intent,
                credential_port=credential_port,
                launch_secrets=launch_secrets,
                secret_port=secret_port,
                base_instructions=base_instructions(),
                skill_roots=SERVICE_SKILL_ROOTS,
                timing=timing,
            )
            yield host
        finally:
            self._models.release_session(request_id)

    async def warm_host(
        self, *, user_id: str, model_id: str, owner: ActivityLease, cwd: Path | None = None
    ) -> CommandReceipt:
        await self.toolchain.wait()
        resolved = cwd if cwd is not None else self._host_warmup_cwd
        if resolved is None:
            raise ValueError(RESOURCE_HOST_CONTEXT_REQUIRED)
        provider = self._gateway.provider(self.runtime_id)
        if not isinstance(provider, RuntimeHostWarmup):
            return CommandReceipt(RUNTIME_HOST_RECONFIGURATION_COMMAND, CommandState.UNSUPPORTED)
        async with self._host_intent(
            cwd=resolved,
            user_id=user_id,
            model_id=model_id,
            catalog_activity=owner,
            expected_model_id=model_id,
        ) as host:
            receipt = await provider.prewarm(host)
            if receipt.state is CommandState.APPLIED:
                if not receipt.correlation_id:
                    raise RuntimeError(RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
                self._host_models[user_id] = model_id
            return receipt

    async def reconfigure_host(
        self, *, user_id: str, model_id: str, owner: ActivityLease, cwd: Path | None = None
    ) -> CommandReceipt:
        resolved = cwd if cwd is not None else self._host_warmup_cwd
        if resolved is None:
            raise ValueError(RESOURCE_HOST_CONTEXT_REQUIRED)
        provider = self._gateway.provider(self.runtime_id)
        supported = {
            item.name
            for item in provider.descriptor.capabilities.entries
            if item.state is CapabilityState.SUPPORTED
        }
        if (
            not isinstance(provider, RuntimeHostReconfiguration)
            or RuntimeCapabilityName.HOST_RECONFIGURATION.value not in supported
        ):
            return CommandReceipt(
                RUNTIME_HOST_RECONFIGURATION_COMMAND,
                CommandState.UNSUPPORTED,
                safe_error=RESOURCE_HOST_CONTEXT_REQUIRED,
            )
        async with self._host_intent(
            cwd=resolved,
            user_id=user_id,
            model_id=model_id,
            catalog_activity=owner,
            expected_model_id=model_id,
        ) as host:
            receipt = await provider.reconfigure(host)
            if receipt.state is CommandState.APPLIED:
                if not receipt.correlation_id:
                    raise RuntimeError(RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
                self._host_models[user_id] = model_id
                self._skill_inventory_cache.clear()
            return receipt

    @asynccontextmanager
    async def host_control(
        self,
        *,
        user_id: str,
        cwd: Path | None = None,
        model_id: str = "",
        process_environment: Mapping[str, str] | None = None,
    ) -> AsyncIterator[HostWarmupRequest]:
        await self.toolchain.wait()
        resolved = cwd if cwd is not None else self._host_warmup_cwd
        if resolved is None:
            raise ValueError(RESOURCE_HOST_CONTEXT_REQUIRED)
        with self._activities.enter(ActivityDomain.RUNTIME):
            async with self._host_context(
                cwd=resolved,
                user_id=user_id,
                model_id=model_id,
                process_environment=process_environment,
            ) as (host, _identity):
                yield host

    def bind_publications(self, publications: PublicationService) -> None:
        self._publications = publications

    def mcp_configuration_port(self) -> RuntimeMcpConfiguration | None:
        provider = self._gateway.provider(self.runtime_id)
        return provider if isinstance(provider, RuntimeMcpConfiguration) else None

    async def execution_threads(
        self, session_id: str, *, user_id: str, root_thread_id: str = ""
    ) -> tuple[RuntimeExecutionThread, ...]:
        record = self._catalog.get(session_id)
        binding = self._catalog.runtime_binding(session_id)
        if record is None or binding is None or not record.runtime_workdir:
            raise ValueError("session runtime binding unavailable")
        if root_thread_id:
            binding = replace(binding, opaque_session_ref=root_thread_id)
        async with self.host_control(
            cwd=Path(record.runtime_workdir),
            user_id=user_id,
            model_id=record.model_id or "",
        ) as host:
            return await self._gateway.provider_for(binding).execution_threads(
                binding,
                host.cwd,
                host=host,
            )

    def bind_activity_observer(self, observer: SessionActivityObserver) -> None:
        """Bind the product policy that inspects workspace state after runtime actions."""

        self._activity_observer = observer

    def bind_answer_filter(self, answer_filter: CitationAnswerFilter) -> None:
        """Bind the product-owned final-answer integrity policy before sessions open."""

        self._answer_filter = answer_filter

    def bind_citation_coverage(self, coverage: CitationCoverage) -> None:
        self._citation_coverage = coverage

    def bind_answer_guard(self, answer_guard: Callable[[str, bool], str]) -> None:
        self._answer_guard = answer_guard

    def bind_cards(self, cards: CardRegistry) -> None:
        """Bind product-composed domain card validators before sessions open."""

        self._cards = cards

    def recover_publications(self, session_id: str) -> None:
        """Restore offline product projections without opening a runtime thread."""
        record = self._catalog.get(session_id)
        if record is None or self._publications is None:
            return
        project_id = (
            self._project_id_for_path(Path(record.project_path))
            if record.project_path and self._project_id_for_path is not None
            else ""
        )
        self._publications.recover(record, project_id, self._events, self._artifacts)

    def bind_local_socket(self, path: Path | None) -> None:
        """Bind the product-owned endpoint before admitting runtime sessions."""

        self._local_socket = path

    def permission_intent(
        self,
        mode: RuntimePermissionMode,
        *,
        writable_roots: tuple[Path, ...] = (),
    ) -> PermissionIntent:
        return session_permission(
            mode,
            revision=f"permission:{mode.value}",
            writable_roots=writable_roots,
            local_socket=self._local_socket,
            network_domains=RUNTIME_ALLOWED_NETWORK_DOMAINS,
        )

    def bind_project_resolver(
        self,
        project_id_for_path: Callable[[Path], str],
    ) -> None:
        """Bind the product-owned project path to identity resolver."""

        self._project_id_for_path = project_id_for_path

    @property
    def gateway_capabilities(self) -> CapabilitySet:
        return self._gateway.provider(self.runtime_id).descriptor.capabilities

    async def readiness(self, *, runtime_id: str = "", executable: str = "") -> RuntimeReadiness:
        del executable
        if self.toolchain.state is not ToolchainState.READY:
            return RuntimeReadiness(
                runtime_id=runtime_id or self.runtime_id,
                ready=False,
                status=RuntimeStatus.UNAVAILABLE,
                safe_error=self.toolchain.state.value,
            )
        readiness = await self._activities.finish(
            ActivityDomain.STARTUP,
            lambda: self._gateway.readiness(runtime_id or self.runtime_id),
        )
        if readiness.ready and self.toolchain.state is not ToolchainState.READY:
            return replace(
                readiness,
                ready=False,
                status=RuntimeStatus.UNAVAILABLE,
                safe_error=self.toolchain.state.value,
            )
        return readiness

    def _runtime_resource_lease(self) -> ActivityLease:
        self.toolchain.require_ready()
        return self._activities.enter(ActivityDomain.RESOURCE, allow_startup_probe=False)

    def schedule_readiness(self) -> None:
        if (
            self._closed
            or self._readiness_task is not None
            or self._activities.snapshot().phase is not ActivityPhase.OPEN
        ):
            return
        self._readiness_task = asyncio.create_task(self._prewarm_readiness())

    async def _prewarm_readiness(self) -> None:
        try:
            with startup_phase("lifecycle.toolchain_admission"):
                await self.toolchain.wait()
            with startup_phase("lifecycle.workbench_admission"):
                await self._activities.wait_open()
            with startup_phase("lifecycle.readiness"):
                with self._activities.enter(ActivityDomain.STARTUP, root=True):
                    await self.readiness()
        except MaintenanceActive:
            return
        except Exception:
            self._logger.exception("Runtime startup readiness probe failed")

    async def stop_readiness(self) -> None:
        tasks = (self._readiness_task,) if self._readiness_task is not None else ()
        if not tasks:
            return
        for task in tasks:
            if not task.done():
                task.cancel()
        joined = asyncio.gather(*tasks, return_exceptions=True)
        cancellation: asyncio.CancelledError | None = None
        while not joined.done():
            try:
                await asyncio.shield(joined)
            except asyncio.CancelledError as error:
                cancellation = error
        if cancellation is not None:
            raise cancellation
        for result in joined.result():
            if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                raise result

    async def _inspect(
        self, request: RuntimeInspectionRequest, runtime_id: str
    ) -> RuntimeInventory:
        await self.toolchain.wait()
        # Provider.inspect owns its control connection through its final close.
        return await self._activities.finish(
            ActivityDomain.RUNTIME,
            lambda: self._gateway.inspect(request, runtime_id),
        )

    async def _inventory_owned(
        self,
        *,
        cwd: Path,
        user_id: str,
        kind: InventoryKind,
        model_id: str = "",
        process_environment: Mapping[str, str] | None = None,
        refresh: bool = False,
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
    ) -> RuntimeInventory:
        await self.toolchain.wait()
        async with self._host_context(
            cwd=cwd,
            user_id=user_id,
            model_id=model_id,
            process_environment=process_environment,
            timing=timing,
        ) as (host, identity):
            snapshot = await self._inspect(
                RuntimeInspectionRequest(
                    cwd=host.cwd,
                    inventory=InventoryRequest((kind,), refresh=refresh),
                    roots=host.skill_roots,
                    host=host,
                    timing=timing,
                ),
                self.runtime_id,
            )
            if snapshot.host_identity != identity:
                raise RuntimeError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
            return snapshot

    async def model_inventory(
        self,
        *,
        cwd: Path,
        user_id: str,
        model_id: str = "",
        executable: str = "",
        process_environment: Mapping[str, str] | None = None,
    ) -> ModelInventory:
        del executable
        snapshot = await self._activities.finish(
            ActivityDomain.RUNTIME,
            lambda: self._inventory_owned(
                cwd=cwd,
                user_id=user_id,
                kind=InventoryKind.MODELS,
                model_id=model_id,
                process_environment=process_environment,
            ),
        )
        values = snapshot.values if isinstance(snapshot.values, Mapping) else {}
        return _model_inventory_from_runtime(values.get(InventoryKind.MODELS.value))

    async def mcp_inventory(
        self, *, cwd: Path, user_id: str, model_id: str = ""
    ) -> RuntimeInventory:
        return await self._activities.finish(
            ActivityDomain.RUNTIME,
            lambda: self._inventory_owned(
                cwd=cwd,
                user_id=user_id,
                kind=InventoryKind.MCP,
                model_id=model_id,
            ),
        )

    def resolve_model(
        self,
        model_id: str,
        *,
        reasoning_effort: str | None = None,
        thinking: ModelThinking | None = None,
        user_id: str = "",
        session_id: str = "",
    ) -> SessionModelSpec:
        """Resolve one durable UI model key before mutating a live session."""

        return self._models.session_spec(
            model_id,
            reasoning_effort=reasoning_effort,
            thinking=thinking,
            user_id=user_id,
            session_id=session_id,
        )

    async def validate_effort(self, model_id: str, effort: str, *, user_id: str = "") -> None:
        await self._models.validate_effort(model_id, effort, user_id=user_id)

    async def validate_thinking(
        self, model_id: str, thinking: ModelThinking, *, user_id: str = ""
    ) -> None:
        await self._models.validate_thinking(model_id, thinking, user_id=user_id)

    def selected_model_key(self, model_id: str, *, user_id: str) -> str:
        """Validate account-visible intent without registering execution credentials."""
        return self._models.selected_model_key(model_id, user_id=user_id)

    @staticmethod
    def _default_runtime_model(inventory: ModelInventory) -> str:
        model = next(
            (
                item.model.strip()
                for item in inventory.models
                if item.is_default and item.model.strip()
            ),
            "",
        )
        if not model:
            raise RuntimeError(RUNTIME_DEFAULT_MODEL_UNAVAILABLE_ERROR)
        return model

    async def skill_inventory(
        self,
        *,
        cwd: Path,
        user_id: str,
        model_id: str = "",
        executable: str = "",
        process_environment: Mapping[str, str] | None = None,
        force_reload: bool = False,
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
    ) -> SkillInventory:
        del executable
        snapshot = await self._activities.finish(
            ActivityDomain.RUNTIME,
            lambda: self._inventory_owned(
                cwd=cwd,
                user_id=user_id,
                kind=InventoryKind.SKILLS,
                model_id=model_id,
                process_environment=process_environment,
                refresh=force_reload,
                timing=timing,
            ),
        )
        values = snapshot.values if isinstance(snapshot.values, Mapping) else {}
        return _skill_inventory_from_runtime(
            values.get(InventoryKind.SKILLS.value), cwd=cwd.expanduser().resolve()
        )

    async def skill_admission(self, *, path: Path, caller: SkillCaller) -> Mapping[str, Any] | None:
        canonical = filesystem_path(path.expanduser()).resolve()
        inventory = await caller.refresh_skills()
        rows = self._skills.payloads(inventory, load_skill_state(), user_id=caller.user_id)
        matches = [
            row
            for row in rows
            if canonical.is_relative_to(
                filesystem_path(Path(str(row["path"])).expanduser()).resolve().parent
            )
        ]
        return max(matches, key=lambda row: len(Path(str(row["path"])).parts), default=None)

    async def skill_configurations(
        self,
        *,
        cwd: Path,
        user_id: str,
        model_id: str = "",
        process_environment: Mapping[str, str] | None = None,
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
    ) -> tuple[SkillConfiguration, ...]:
        inventory = await self.skill_inventory(
            cwd=cwd,
            user_id=user_id,
            model_id=model_id,
            process_environment=process_environment,
            timing=timing,
        )
        return tuple(
            SkillConfiguration(path, enabled)
            for path, enabled in self._skills.session_enablement(
                inventory, load_skill_state(), user_id=user_id
            )
        )

    async def configure_skills(
        self,
        *,
        cwd: Path,
        state: SkillProductState,
        user_id: str,
        model_id: str = "",
        process_environment: Mapping[str, str] | None = None,
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
    ) -> SkillInventory:
        return await self._activities.finish(
            ActivityDomain.RUNTIME,
            lambda: self._configure_skills(
                cwd=cwd,
                state=state,
                user_id=user_id,
                model_id=model_id,
                process_environment=process_environment,
                timing=timing,
                refresh=True,
            ),
        )

    async def cached_skill_inventory(
        self,
        *,
        cwd: Path,
        state: SkillProductState,
        user_id: str,
        model_id: str = "",
    ) -> SkillInventory:
        return await self._activities.finish(
            ActivityDomain.RUNTIME,
            lambda: self._configure_skills(
                cwd=cwd,
                state=state,
                user_id=user_id,
                model_id=model_id,
                cached=True,
            ),
        )

    def invalidate_skill_inventory(self, *, cwd: Path) -> None:
        resolved = cwd.expanduser().resolve()
        for key in tuple(self._skill_inventory_cache):
            if key[2] == resolved:
                self._skill_inventory_cache.pop(key, None)

    def _schedule_skill_inventory_refresh(
        self, *, key: tuple[str, str, Path], state: SkillProductState, model_id: str
    ) -> None:
        if self._closed:
            return
        pending = self._skill_inventory_refresh.get(key)
        if pending is not None and not pending.done():
            return
        try:
            task = self._activities.spawn(
                ActivityDomain.RUNTIME,
                lambda: self._activities.finish(
                    ActivityDomain.RUNTIME,
                    lambda: self._configure_skills(
                        cwd=key[2],
                        user_id=key[0],
                        state=state,
                        model_id=model_id,
                        refresh_key=key,
                    ),
                ),
            )
        except MaintenanceActive:
            return
        self._skill_inventory_refresh[key] = task

        def finished(done: asyncio.Task[SkillInventory]) -> None:
            if self._skill_inventory_refresh.get(key) is done:
                self._skill_inventory_refresh.pop(key, None)
            if not done.cancelled() and done.exception() is not None:
                self._logger.warning(
                    "skill_inventory_refresh_failed exception_type=%s",
                    type(done.exception()).__name__,
                )

        task.add_done_callback(finished)

    async def _configure_skills(
        self,
        *,
        cwd: Path,
        state: SkillProductState,
        user_id: str,
        model_id: str = "",
        process_environment: Mapping[str, str] | None = None,
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
        cached: bool = False,
        refresh: bool = False,
        refresh_key: tuple[str, str, Path] | None = None,
    ) -> SkillInventory:
        await self.toolchain.wait()
        async with self._host_context(
            cwd=cwd,
            user_id=user_id,
            model_id=model_id,
            process_environment=process_environment,
            timing=timing,
        ) as (host, identity):
            key = (user_id, identity, host.cwd)
            async with self._skill_configuration_lock:
                entry = self._skill_inventory_cache.get(key)
                if refresh_key is not None and (
                    refresh_key != key or entry is None or entry.state != state
                ):
                    raise RuntimeError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
                if cached or refresh_key is not None:
                    state = load_skill_state()
                if cached and entry is not None and entry.state == state:
                    if time.monotonic() - entry.refreshed_at >= SKILL_INVENTORY_CACHE_TTL_SECONDS:
                        self._schedule_skill_inventory_refresh(
                            key=key, state=state, model_id=model_id
                        )
                    return entry.inventory
                return await self._reconcile_skills(
                    host=host,
                    key=key,
                    state=state,
                    timing=timing,
                    refresh=refresh or refresh_key is not None,
                )

    async def _reconcile_skills(
        self,
        *,
        host: HostWarmupRequest,
        key: tuple[str, str, Path],
        state: SkillProductState,
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
        refresh: bool = False,
    ) -> SkillInventory:
        async def inventory(*, force_reload: bool = False) -> SkillInventory:
            snapshot = await self._inspect(
                RuntimeInspectionRequest(
                    cwd=host.cwd,
                    roots=host.skill_roots,
                    host=host,
                    inventory=InventoryRequest((InventoryKind.SKILLS,), refresh=force_reload),
                    timing=timing,
                ),
                self.runtime_id,
            )
            if snapshot.host_identity != key[1]:
                raise RuntimeError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
            values = snapshot.values if isinstance(snapshot.values, Mapping) else {}
            return _skill_inventory_from_runtime(
                values.get(InventoryKind.SKILLS.value), cwd=host.cwd
            )

        discovered = await inventory(force_reload=refresh)
        plan = await self._activities.to_thread(
            ActivityDomain.RUNTIME, self._skills.enablement_plan, discovered, state
        )
        components = self._skills.components
        unavailable: set[str] = set()
        snapshots = (
            await self._activities.to_thread(
                ActivityDomain.RUNTIME,
                self._skills.component_snapshots,
                discovered,
                plan.state,
                unavailable=unavailable,
            )
            if components is not None
            else []
        )
        if components is not None:
            await self._activities.to_thread(ActivityDomain.RUNTIME, components.check, snapshots)
        enabled_by_path = {
            filesystem_path(self._skills.manifest(skill.path).expanduser()).resolve(): skill.enabled
            for skill in discovered.skills
        }
        configurations = tuple(
            SkillConfiguration(path, enabled)
            for path, enabled in plan.configurations
            if enabled_by_path.get(filesystem_path(path).resolve()) != enabled
        )
        if configurations:
            receipt = await self._gateway.provider(self.runtime_id).configure_skills(
                SkillConfigurationRequest(
                    cwd=host.cwd,
                    roots=host.skill_roots,
                    host=host,
                    skills=configurations,
                    timing=timing,
                )
            )
            if receipt.state is not CommandState.APPLIED:
                raise RuntimeError(receipt.safe_error or "skill configuration was not applied")
            discovered = await inventory()
            effective = {
                filesystem_path(
                    self._skills.manifest(skill.path).expanduser()
                ).resolve(): skill.enabled
                for skill in discovered.skills
            }
            if any(
                effective.get(filesystem_path(row.path).resolve()) != row.enabled
                for row in configurations
            ):
                raise RuntimeError("skill configuration verification failed")
        if plan.state != state:
            save_skill_state(plan.state)
        elif load_skill_state() != state:
            save_skill_state(state)
        if components is not None:
            components.publish(snapshots, unavailable=frozenset(unavailable))
        self._skill_inventory_cache[key] = SkillInventoryCache(
            inventory=discovered,
            state=plan.state,
            refreshed_at=time.monotonic(),
        )
        return discovered

    def bind_sessions(self, sessions: Mapping[str, LiveSession]) -> None:
        self.activation.bind_sessions(sessions)

    async def release_directory_attachments(
        self, project_id: str, source: Path, project_root: Path
    ) -> tuple[str, ...]:
        blocked = set(await self.activation.release_directory_attachments(project_id, source))
        related = {live.id for live in self.activation.directory_sessions(project_id, source)}
        blocked.update(
            opening.session_id
            for opening in self._uncertain_attachments.values()
            if opening.session_id in related
            or opening.project_id == project_id
            or not opening.directories
            or any(
                path.is_relative_to(project_root)
                or path.is_relative_to(source)
                or source.is_relative_to(path)
                for path in opening.directories
            )
        )
        blocked.update(
            identity
            for identity, paths in self._one_shot_directories.items()
            if any(
                path.is_relative_to(project_root)
                or path.is_relative_to(source)
                or source.is_relative_to(path)
                for path in paths
            )
        )
        return tuple(sorted(blocked))

    async def start(self) -> None:
        await self.activation.start()
        self.schedule_readiness()

    async def drain_for_update(self, generation: str) -> tuple[str, ...]:
        blocked = await self.activation.drain_attachments(generation)
        if blocked:
            return blocked
        openings = tuple(
            (identity, opening)
            for identity, opening in self._uncertain_attachments.items()
            if opening.settled
        )
        runtime_ids = set(self._gateway.catalog.runtime_ids())
        blocked_runtimes = set(await self.drain_resources(generation))
        for identity, opening in openings:
            if (
                opening.runtime_id in runtime_ids - blocked_runtimes
                and self._uncertain_attachments.get(identity) is opening
            ):
                opening.activity.close()
                self._uncertain_attachments.pop(identity)
                self._logger.info(
                    "update_opening_released opening_id=%s session_id=%s runtime_id=%s",
                    identity,
                    opening.session_id,
                    opening.runtime_id,
                )
        blocked_runtimes.update(
            opening.runtime_id for opening in self._uncertain_attachments.values()
        )
        return tuple(sorted(blocked_runtimes))

    async def drain_resources(self, generation: str) -> tuple[str, ...]:
        """Release idle provider pools after attachments; never authorizes restart.

        Physical resource leases protect each native close even if this caller is
        cancelled. Other owners and uncertain opens remain in Activities.
        """

        def check_generation() -> None:
            snapshot = self._activities.snapshot()
            if snapshot.phase is not ActivityPhase.DRAINING or snapshot.generation != generation:
                raise MaintenanceStale("update_maintenance_stale")

        check_generation()
        blocked: list[str] = []
        for runtime_id in self._gateway.catalog.runtime_ids():
            check_generation()
            receipt = await self._gateway.provider(runtime_id).release_idle_resources()
            check_generation()
            if receipt.state is not CommandState.APPLIED:
                blocked.append(runtime_id)
        check_generation()
        return tuple(blocked)

    async def aclose(self) -> None:
        if any(task is asyncio.current_task() for _, task in self._one_shot_tasks.values()):
            raise RuntimeError("runtime cannot close from its active one-shot invocation")
        self._closed = True
        await self.reconfiguration.aclose()
        failures: list[BaseException] = []
        try:
            await self.activation.aclose()
        except BaseException as error:
            failures.append(error)
        tasks: tuple[asyncio.Task[Any], ...] = tuple(
            task for _owner, task in self._one_shot_tasks.values()
        )
        if self._readiness_task is not None:
            tasks = (*tasks, self._readiness_task)
        tasks = (*tasks, *self._skill_inventory_refresh.values())
        for task in tasks:
            task.cancel()
        try:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            failures.extend(
                result
                for result in results
                if isinstance(result, BaseException)
                and not isinstance(result, asyncio.CancelledError)
            )
        except BaseException as error:
            failures.append(error)
        for invocation_id, (owner, driver) in tuple(self._one_shot_drivers.items()):
            if invocation_id in self._one_shot_close_failures:
                continue
            try:
                await driver.close()
            except BaseException as error:
                self._one_shot_close_failures[invocation_id] = error
            else:
                if self._one_shot_drivers.get(invocation_id) == (owner, driver):
                    self._one_shot_drivers.pop(invocation_id)
        failures.extend(self._one_shot_close_failures.values())

        async def shutdown(runtime_id: str) -> None:
            result = await self._gateway.provider(runtime_id).shutdown()
            if result.state is not CommandState.APPLIED:
                raise RuntimeError("runtime shutdown was not confirmed")
            for identity, opening in tuple(self._uncertain_attachments.items()):
                if opening.runtime_id == runtime_id:
                    opening.activity.close()
                    self._uncertain_attachments.pop(identity, None)

        try:
            results = await asyncio.gather(
                *(shutdown(runtime_id) for runtime_id in self._gateway.catalog.runtime_ids()),
                return_exceptions=True,
            )
            failures.extend(result for result in results if isinstance(result, BaseException))
        except BaseException as error:
            failures.append(error)
        failures = list({id(error): error for error in failures}.values())
        if len(failures) == 1:
            raise failures[0]
        if failures:
            raise BaseExceptionGroup("runtime shutdown failed", failures)

    async def cancel_activation(self, session_id: str) -> bool:
        return await self.activation.cancel(session_id)

    async def wait_until_suspended(
        self,
        live: LiveSession,
        *,
        deadline: float | None = None,
    ) -> None:
        await self.activation.wait_until_suspended(live, deadline=deadline)

    async def ensure_active(
        self,
        live: LiveSession,
        *,
        purpose: ResourcePurpose = ResourcePurpose.SESSION,
        request_id: str = "",
        deadline: float | None = None,
        on_wait: ResourceWaitObserver | None = None,
    ) -> None:
        binding = self._catalog.runtime_binding(live.id)
        if (
            binding is not None
            and self._events.rejected_turns(live.id, binding.opaque_session_ref)
            and live.runtime_session is not None
            and not await live.suspend_runtime()
        ):
            raise SessionActivationError(SESSION_OPEN_UNKNOWN)
        await self.activation.ensure_active(
            live, purpose=purpose, request_id=request_id, deadline=deadline, on_wait=on_wait
        )

    async def _prepare_attachment(self, live: LiveSession, timing: RuntimeTimingPort) -> None:
        await self._activities.finish(
            ActivityDomain.RUNTIME,
            lambda: self._activities.to_thread(
                ActivityDomain.RUNTIME, prepare_commands, live.runtime_workdir
            ),
        )
        inventory = await self._activities.finish(
            ActivityDomain.RUNTIME,
            lambda: self._configure_skills(
                cwd=live.runtime_workdir,
                state=load_skill_state(),
                user_id=live.user_id,
                model_id=live.model_id,
                process_environment=live.process_environment,
                timing=timing,
                cached=True,
            ),
        )
        live.skill_configurations = tuple(
            SkillConfiguration(path, enabled)
            for path, enabled in self._skills.session_enablement(
                inventory, load_skill_state(), user_id=live.user_id
            )
        )

    def _discard_attachment(self, live: LiveSession) -> None:
        self._models.release_session(live.id)
        live.bridge_token = ""

    @asynccontextmanager
    async def operation(
        self, live: LiveSession, *, request_id: str = ""
    ) -> AsyncIterator[RuntimeSession]:
        """Pin an attachment for a complete product operation, including its await points."""
        self._activities.require_workbench()
        while True:
            await self.ensure_active(live, request_id=request_id)
            await live.lifecycle_lock.acquire()
            session = live.runtime_session
            if session is None:
                live.lifecycle_lock.release()
                continue
            try:
                yield session
            finally:
                live.lifecycle_lock.release()
            return

    async def open(
        self,
        *,
        session_id: str,
        runtime_id: str = "",
        cwd: Path,
        project_path: Path | None,
        output_root: Path,
        resume_vendor_thread_id: str,
        model_id: str,
        permission_mode: str,
        executable: str,
        process_environment: Mapping[str, str] | None = None,
        user_id: str = "",
        writable_roots: tuple[Path, ...] = (),
        required_capabilities: tuple[RuntimeCapabilityName, ...] = (),
        reasoning_effort: str = "",
        thinking: ModelThinking | None = None,
    ) -> LiveSession:
        """Construct product state; native open/resume occurs only during admission."""
        del executable, required_capabilities
        selected_model = self._models.selected_model_key(model_id, user_id=user_id)
        selected_runtime_id = runtime_id.strip().lower() or self.runtime_id
        project_id = (
            self._project_id_for_path(project_path)
            if project_path is not None and self._project_id_for_path is not None
            else ""
        )
        live = LiveSession(
            recording=self.recording,
            recover_empty=lambda proof: self._recover_empty(live, proof),
            rebuild_thread=lambda target: self._rebuild_thread(live, target),
            trace_secrets=(),
            session_id=session_id,
            runtime_id=selected_runtime_id,
            runtime_workdir=cwd,
            project_path=project_path,
            output_root=output_root,
            model_id=selected_model,
            reasoning_effort=reasoning_effort,
            thinking=thinking,
            catalog=self._catalog,
            events=self._events,
            artifacts=self._artifacts,
            skills=self._skills,
            logger=self._logger,
            process_environment=process_environment,
            user_id=user_id,
            on_release=self._models.release_session,
            on_suspend=self._models.suspend_session,
            project_id=project_id,
            resource_changes=self._resource_changes,
            local_socket=self._local_socket,
            network_domains=RUNTIME_ALLOWED_NETWORK_DOMAINS,
            publications=self._publications,
            cards=self._cards,
            activity_observer=self._activity_observer,
            answer_filter=self._answer_filter,
            citation_coverage=self._citation_coverage,
            answer_guard=self._answer_guard,
            skill_inventory_provider=lambda cwd: self.skill_inventory(
                cwd=cwd,
                user_id=live.user_id,
                model_id=live.model_id,
                process_environment=live.process_environment,
            ),
        )
        live.runtime_binding = self._catalog.runtime_binding(session_id)
        live.vendor_thread_id = resume_vendor_thread_id
        live.resumed = bool(resume_vendor_thread_id)
        live.writable_roots = tuple(writable_roots)
        live.applied_permission_mode = ""
        if live.runtime_binding is not None:
            live.recover_publications()
        return live

    def _activation_revision(self, live: LiveSession) -> tuple[object, ...]:
        record = self._catalog.get(live.id)
        if record is None:
            raise RuntimeError("allocated product session is unavailable")
        model_state = self._catalog.model_state(live.id)
        selected = model_state.selected_model_id
        return (
            selected,
            record.policy_id,
            live.runtime_workdir,
            live.project_path,
            live.output_root,
            live.writable_roots,
            live.user_id,
            tuple(sorted(live.process_environment.items())),
            model_state.selected_reasoning_effort,
            model_state.selected_thinking,
            self._skills.availability_revision(live.user_id),
            self._catalog.runtime_binding(live.id),
            record.archived,
            live.closing,
        )

    @staticmethod
    def _revision_digest(revision: tuple[object, ...]) -> str:
        return hashlib.sha256(repr(revision).encode()).hexdigest()

    async def _recover_empty(
        self, live: LiveSession, proof: EmptyThreadReplacementProof
    ) -> RuntimeTurnAdmission:
        record = self._catalog.get(live.id)
        if record is None or record.archived or live.closing:
            raise SessionActivationError(SESSION_OPEN_UNKNOWN)
        revision = self._activation_revision(live)
        generation = live.interrupt_generation
        if (
            live.runtime_session is None
            or live.runtime_driver is None
            or live.runtime_session.binding != proof.binding
            or live.active_product_turn_id != proof.command_id
            or live.pending_hil_snapshot()
            or live.terminating
            or live.terminated
            or asyncio.get_running_loop().time() >= proof.submission_deadline
        ):
            raise SessionActivationError(SESSION_OPEN_UNKNOWN)
        await live.persistence.run(
            self._catalog.record_replacement, proof, self._revision_digest(revision)
        )
        live.replacement_proof = proof
        live.replacement_revision = revision
        try:
            async with asyncio.timeout_at(proof.submission_deadline):
                await live.runtime_driver.close()
                live.runtime_session = None
                live.runtime_driver = None
                live.release_attachment_activity()
                if (
                    self._activation_revision(live) != revision
                    or live.interrupt_generation != generation
                ):
                    raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                await self.ensure_active(
                    live,
                    purpose=ResourcePurpose.TURN,
                    request_id=proof.call_id,
                    deadline=time.time()
                    + max(0.0, proof.submission_deadline - asyncio.get_running_loop().time()),
                )
                if live.interrupt_generation != generation:
                    raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                live.restore_admitted_user(proof.command_id)
                session = live.runtime_session
                if session is None:
                    raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                driver = live.runtime_driver
                if driver is None:
                    raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                while True:
                    await driver.drain_observations()
                    activity = await session.activity()
                    if activity.idle and activity.execution_tree_idle:
                        break
                    if (
                        not activity.blockers
                        or set(activity.blockers) - RUNTIME_TRANSIENT_ACTIVITY_BLOCKERS
                        or activity.execution_tree_blockers
                    ):
                        raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                replacement_revision = self._activation_revision(live)
                attachment_generation = live.attachment_generation

                def current() -> bool:
                    queued = self._catalog.queued_message(live.id, proof.command_id)
                    record = self._catalog.get(live.id)
                    return (
                        live.runtime_session is session
                        and live.attachment_generation == attachment_generation
                        and live.interrupt_generation == generation
                        and not live.terminating
                        and not live.terminated
                        and not live.closing
                        and record is not None
                        and not record.archived
                        and self._activation_revision(live) == replacement_revision
                        and queued is not None
                        and queued.state is QueuedMessageState.SUBMITTING
                        and not queued.native_turn_id
                        and not live.pending_hil_snapshot()
                        and not live.ledger.uncertainty_snapshot()
                        and self._activities.snapshot().phase is ActivityPhase.OPEN
                    )

                return RuntimeTurnAdmission(
                    activity.generation, activity.revision, activity.watermark, current
                )
        finally:
            self._catalog.settle_replacement(live.id, proof.proof_id, ReplacementState.UNKNOWN)
            live.replacement_proof = None
            live.replacement_revision = None

    async def _rebuild_thread(
        self, live: LiveSession, target: ThreadReplacementTarget
    ) -> ThreadReplacementProof:
        driver = live.runtime_driver
        session = live.runtime_session
        revision = self._activation_revision(live)
        interrupt_generation = live.interrupt_generation
        source = self._catalog.queued_message(live.id, target.command_id)

        def current() -> bool:
            record = self._catalog.get(live.id)
            queued = self._catalog.queued_message(live.id, target.command_id)
            return (
                live.runtime_driver is driver
                and live.runtime_session is session
                and session is not None
                and session.binding == target.binding
                and source is not None
                and source.operation_seq is not None
                and queued is not None
                and queued.operation_seq == source.operation_seq
                and queued.state
                in (
                    QueuedMessageState.SUBMITTING,
                    QueuedMessageState.RUNNING,
                    QueuedMessageState.OUTCOME_UNKNOWN,
                )
                and live.last_submission_id == target.command_id
                and live.interrupt_generation == interrupt_generation
                and self._activation_revision(live) == revision
                and record is not None
                and not record.archived
                and not live.closing
                and not live.interrupting
                and not live.terminating
                and not live.terminated
                and not live.pending_hil_snapshot()
                and self._activities.snapshot().phase is ActivityPhase.OPEN
            )

        if driver is None or not current():
            raise SessionActivationError(SESSION_OPEN_UNKNOWN)
        provider = self._gateway.provider_for(target.binding)
        deadline = asyncio.get_running_loop().time() + provider.resource_policy.wait_seconds
        proof = None
        detached = False
        failure: BaseException | None = None
        try:
            async with asyncio.timeout_at(deadline):
                ticket = await driver.prepare_thread_replacement(target)
                if not current():
                    raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                receipt = await driver.commit_thread_replacement(ticket)
                if receipt.state is not CommandState.APPLIED or not current():
                    raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                proof = ticket.proof
                live.thread_replacement_proof = proof
                await driver.close()
                detached = True
                while True:
                    owners = {
                        task
                        for task in (
                            live.current_task,
                            (
                                live.resource_task
                                if live.waiting_request_id == target.command_id
                                else None
                            ),
                        )
                        if task is not None and not task.done()
                    }
                    if not owners:
                        break
                    await asyncio.shield(asyncio.gather(*owners, return_exceptions=True))
                if not current():
                    raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                await live.persistence.run(
                    self._catalog.record_replacement, proof, self._revision_digest(revision)
                )
                live.replacement_proof = proof
                live.replacement_revision = revision
                live.runtime_driver = None
                live.runtime_session = None
                live.release_attachment_activity()
                if live.active_product_turn_id == target.command_id:
                    if not await live.release_product_turn(target.command_id):
                        raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                if (
                    self._activation_revision(live) != revision
                    or live.interrupt_generation != interrupt_generation
                ):
                    raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                await self.ensure_active(
                    live,
                    purpose=ResourcePurpose.TURN,
                    request_id=proof.proof_id,
                    deadline=time.time() + max(0.0, deadline - asyncio.get_running_loop().time()),
                )
                async with live.lifecycle_lock:
                    replacement_revision = self._activation_revision(live)
                    if (
                        live.runtime_session is None
                        or live.interrupt_generation != interrupt_generation
                        or live.closing
                        or live.terminating
                        or live.terminated
                        or not await live.ledger.confirm_thread_replacement(proof)
                    ):
                        raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                    if (
                        live.interrupt_generation != interrupt_generation
                        or live.closing
                        or live.terminating
                        or live.terminated
                        or self._activation_revision(live) != replacement_revision
                        or self._activities.snapshot().phase is not ActivityPhase.OPEN
                    ):
                        raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                    await live.publish(
                        PRODUCT_EVENT_SESSION_STATE,
                        {
                            "state": PRODUCT_SESSION_STATE_IDLE,
                            "runtime_id": proof.binding.runtime_id,
                            "recovery_blocked": False,
                            "recovery_pending": False,
                            "reason": ReplacementKind.HISTORY_REBUILD.value,
                            "proof_id": proof.proof_id,
                            "previous_native_session_id": proof.binding.opaque_session_ref,
                            "native_session_id": live.runtime_session.binding.opaque_session_ref,
                        },
                        turn_id=proof.command_id,
                        idempotency_key=f"{THREAD_REBUILT_EVENT_KEY_PREFIX}:{proof.proof_id}",
                    )
                return proof
        except BaseException as error:
            failure = error
            raise
        finally:
            try:
                if proof is not None:
                    self._catalog.settle_replacement(
                        live.id, proof.proof_id, ReplacementState.UNKNOWN
                    )
            except Exception:
                if failure is None:
                    raise
                self._logger.error(
                    "thread_replacement_cleanup_failed session_id=%s proof_id=%s",
                    live.id,
                    proof.proof_id if proof is not None else "",
                    exc_info=True,
                )
            finally:
                if detached and live.runtime_driver is driver and live.runtime_session is session:
                    live.runtime_driver = None
                    live.runtime_session = None
                    live.release_attachment_activity()
                live.thread_replacement_proof = None
                live.replacement_proof = None
                live.replacement_revision = None

    def _activation_plan(self, live: LiveSession) -> ActivationPlan:
        proof = live.replacement_proof
        manual = False
        if proof is None:
            proof = self._catalog.manual_replacement_proof(live.id, live.waiting_request_id)
            manual = proof is not None
        replacement = self._catalog.replacement(live.id)
        if replacement is not None and replacement["state"] is not ReplacementState.BOUND:
            if (
                proof is None
                or replacement["state"] is not ReplacementState.PROVEN
                or replacement["proof_id"] != proof.proof_id
            ):
                raise SessionActivationError(SESSION_OPEN_UNKNOWN)
        if (
            proof is not None
            and not manual
            and self._activation_revision(live) != live.replacement_revision
        ):
            raise SessionActivationError(SESSION_OPEN_UNKNOWN)
        activation = self._catalog.activation(live.id)
        if activation is None or activation.open_state in {
            OpenState.OPENING,
            OpenState.OPEN_UNKNOWN,
        }:
            raise SessionActivationError(SESSION_OPEN_UNKNOWN)
        revision = self._activation_revision(live)
        model_state = self._catalog.model_state(live.id)
        effort = model_state.selected_reasoning_effort
        thinking = model_state.selected_thinking
        model, _options, _environment = self._session_options(
            model_id=str(revision[0]),
            executable="",
            process_environment=live.process_environment,
            session_id=live.id,
            user_id=live.user_id,
            reasoning_effort=effort,
            thinking=thinking,
        )
        model_intent, credential_port = model.runtime_model(effort, thinking)
        live._trace.add_secrets(tuple((model.process_environment or {}).values()))
        launch_environment = self._launch_environment(live)
        compiler = self.toolchain.resources or self._compiler_resources
        execution_environment = (
            compiler.prepare_environment(live.runtime_workdir) if compiler else {}
        )
        launch_secrets, secret_port = _launch_secret_contract(
            launch_environment,
            execution_environment=execution_environment,
            include_skill_credentials=True,
            cwd=live.runtime_workdir,
        )
        mode = str(revision[1] or RuntimePermissionMode.ASK.value)
        permission = live.permission_intent(RuntimePermissionMode(mode))
        base = base_instructions()
        instructions = developer_instructions(
            output_directory=live.output_root.relative_to(live.runtime_workdir).as_posix(),
            project_context=(
                self._publications.project_context(live.project_id, live.runtime_workdir)
                if self._publications
                else ""
            ),
        )
        binding = self._catalog.runtime_binding(live.id)
        service_tools = SESSION_SERVICE_TOOLS
        replaces = (
            binding
            if binding
            and (
                activation.open_state is OpenState.UNSUBMITTED
                or self._events.rejected_turns(live.id, binding.opaque_session_ref)
                or binding.profile != service_tool_profile(service_tools)
            )
            else None
        )
        if proof is not None:
            replaces = proof.binding
        request: OpenSessionRequest | ResumeSessionRequest
        if activation.open_state is OpenState.BOUND and replaces is None:
            if binding is None:
                raise SessionActivationError(SESSION_OPEN_UNKNOWN)
            request = ResumeSessionRequest(
                binding=binding,
                cwd=live.runtime_workdir,
                execution_scope=live.id,
                process_sharing_scope=live.user_id,
                execution_environment=execution_environment,
                model=model_intent,
                credential_port=credential_port,
                launch_secrets=launch_secrets,
                secret_port=secret_port,
                permission=permission,
                base_instructions=base,
                developer_instructions=instructions,
                service_tools=service_tools,
                skill_roots=SERVICE_SKILL_ROOTS,
                skill_configurations=live.skill_configurations,
                skill_policy=binding.skill_policy,
            )
            provider = self._gateway.provider_for(binding)
        else:
            fork_source = None
            origin = self._events.by_key(live.id, SESSION_FORK_KEY)
            if origin is not None and replaces is None:
                source = self._catalog.runtime_binding(str(origin.payload["source_session_id"]))
                if (
                    source is None
                    or source.opaque_session_ref != origin.payload["source_thread_id"]
                ):
                    raise SessionActivationError(SESSION_FORK_SOURCE_CHANGED)
                fork_source = ForkRequest(
                    command_id=SESSION_FORK_KEY,
                    product_session_id=live.id,
                    source=source,
                    source_turn_id=str(origin.payload["source_turn_id"]),
                )
            request = OpenSessionRequest(
                product_session_id=live.id,
                cwd=live.runtime_workdir,
                execution_scope=live.id,
                process_sharing_scope=live.user_id,
                execution_environment=execution_environment,
                model=model_intent,
                credential_port=credential_port,
                launch_secrets=launch_secrets,
                secret_port=secret_port,
                permission=permission,
                base_instructions=base,
                developer_instructions=instructions,
                service_tools=service_tools,
                skill_roots=SERVICE_SKILL_ROOTS,
                skill_configurations=live.skill_configurations,
                skill_policy=binding.skill_policy if binding else SkillPolicy.INHERIT,
                required_capabilities=activation.required_capabilities,
                fork_source=fork_source,
                initial_history=(
                    self._events.portable_history(live.id, exclude_rejected=True)
                    if (proof is None or isinstance(proof, ThreadReplacementProof))
                    and replaces is not None
                    and activation.open_state is not OpenState.UNSUBMITTED
                    else ()
                ),
            )
            provider = self._gateway.provider(live.runtime_id)
        return ActivationPlan(provider, request, revision, model.model_run, replaces, proof, manual)

    async def _attach_runtime(
        self, live: LiveSession, plan: ActivationPlan, reservation_id: str
    ) -> None:
        await self._activities.finish(
            ActivityDomain.RUNTIME,
            lambda: self._attach_runtime_owned(live, plan, reservation_id),
        )

    async def _attach_runtime_owned(
        self, live: LiveSession, plan: ActivationPlan, reservation_id: str
    ) -> None:
        request = replace(plan.request, reservation_id=reservation_id)
        attempt_id = ""
        replacement_claimed = False
        runtime_session = None
        opening = self._activities.enter(ActivityDomain.RUNTIME)
        opening_id = uuid.uuid4().hex
        opening_record = RuntimeOpening(
            live.runtime_id,
            live.id,
            opening,
            project_id=live.project_id,
            directories=(live.runtime_workdir, live.output_root, *live.writable_roots),
        )
        self._uncertain_attachments[opening_id] = opening_record
        release_opening = True
        try:
            if isinstance(request, OpenSessionRequest):
                if plan.replacement_proof is not None:
                    if self._activation_revision(live) != plan.revision:
                        raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                    self._catalog.begin_replacement(
                        plan.replacement_proof,
                        self._revision_digest(plan.revision),
                        reservation_id,
                        manual=plan.replacement_manual,
                    )
                    replacement_claimed = True
                if plan.replaces is None:
                    attempt_id = uuid.uuid4().hex
                    if self._catalog.begin_open(live.id, attempt_id) is None:
                        raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                release_opening = False
                runtime_session = await plan.provider.open(request)
                if plan.replaces is None:
                    self._catalog.bind_open(
                        live.id,
                        attempt_id,
                        runtime_session.binding,
                        unsubmitted=request.fork_source is None and not request.initial_history,
                    )
                else:
                    if plan.replacement_proof is not None:
                        self._catalog.settle_replacement(
                            live.id,
                            plan.replacement_proof.proof_id,
                            ReplacementState.OPENING,
                            runtime_session.binding,
                        )
                        if self._activation_revision(live) != plan.revision:
                            raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                    self._catalog.replace_runtime_binding(
                        plan.replaces,
                        runtime_session.binding,
                        proof=plan.replacement_proof,
                        revision=self._revision_digest(plan.revision),
                        manual=plan.replacement_manual,
                    )
                    self._logger.info(
                        "runtime_binding_replaced session=%s previous_thread=%s thread=%s retained_messages=%d",
                        live.id,
                        plan.replaces.opaque_session_ref,
                        runtime_session.binding.opaque_session_ref,
                        len(request.initial_history),
                    )
            else:
                release_opening = False
                runtime_session = await plan.provider.resume(request)
            if plan.replacement_proof is not None:
                activation = self._catalog.activation(live.id)
                if activation is None:
                    raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                live.attachment_generation = activation.generation
            else:
                live.attachment_generation = self._catalog.begin_attachment(live.id)
            live.model_id = str(plan.revision[0])
            live.model_run = plan.model_run
            live.reasoning_effort = request.model.reasoning_effort if request.model else ""
            live.thinking = request.model.thinking if request.model else None
            live.applied_permission_mode = str(plan.revision[1] or RuntimePermissionMode.ASK.value)
            driver = live.attach_gateway(
                runtime_session,
                resumed=isinstance(request, ResumeSessionRequest),
                activities=self._activities,
            )
            await live.hydrate_runtime_history()
            self._catalog.apply_model(
                live.id,
                live.model_id,
                reasoning_effort=live.reasoning_effort,
                thinking=live.thinking,
                preserve_selection=True,
            )
            if live._active:
                driver.start()
                await live.refresh_skills()
            await live.reconcile_resumed_turns()
            release_opening = True
        except BaseException as error:
            try:
                if replacement_claimed and plan.replacement_proof is not None:
                    not_applied = (
                        isinstance(error, RuntimeOpenNotAppliedError)
                        and error.reservation_id == reservation_id
                        and runtime_session is None
                    )
                    self._catalog.settle_replacement(
                        live.id,
                        plan.replacement_proof.proof_id,
                        ReplacementState.NOT_APPLIED if not_applied else ReplacementState.UNKNOWN,
                        runtime_session.binding if runtime_session is not None else None,
                    )
                    if not_applied:
                        release_opening = True
                if attempt_id:
                    if (
                        isinstance(error, RuntimeOpenNotAppliedError)
                        and error.reservation_id == reservation_id
                        and plan.replaces is None
                        and runtime_session is None
                    ):
                        if not self._catalog.reset_open_not_applied(live.id, attempt_id):
                            raise SessionActivationError(SESSION_OPEN_UNKNOWN) from error
                        release_opening = True
                        self._logger.info(
                            "runtime_open_not_applied session_id=%s attempt_id=%s reservation_id=%s",
                            live.id,
                            attempt_id,
                            reservation_id,
                        )
                    else:
                        self._catalog.mark_open_unknown(live.id, attempt_id)
                if runtime_session is not None:
                    if live.runtime_driver is not None:
                        await live.runtime_driver.close()
                    else:
                        await runtime_session.detach()
                    live.runtime_session = None
                    live.runtime_driver = None
                    live.release_attachment_activity()
                    release_opening = True
            finally:
                self._models.release_session(live.id)
            raise
        finally:
            opening_record.settled = True
            if release_opening:
                self._uncertain_attachments.pop(opening_id, None)
                opening.close()
            else:
                self._logger.warning(
                    "runtime_opening_unresolved opening_id=%s session_id=%s runtime_id=%s",
                    opening_id,
                    live.id,
                    live.runtime_id,
                )

    async def invoke_once(
        self,
        *,
        invocation_id: str,
        owner_id: str,
        user_id: str,
        cwd: Path,
        model_id: str,
        base_instructions: str,
        developer_instructions: str,
        input_text: str,
        executable: str,
        permission_mode: RuntimePermissionMode,
        purpose: str,
        process_environment: Mapping[str, str] | None = None,
        items: tuple[RuntimeValue, ...] | None = None,
        observer: RuntimeObservationHandler | None = None,
        bridge_token: str = "",
        writable_roots: tuple[Path, ...] = (),
        network_access: bool = False,
        reasoning_effort: str = "",
        service_tier: str = "",
        required_capabilities: tuple[RuntimeCapabilityName, ...] = (),
        optional_capabilities: tuple[RuntimeCapabilityName, ...] = (),
        skill_identity: Mapping[str, str] | None = None,
        ephemeral: bool = False,
        minimum_reasoning: bool = False,
        permission: PermissionIntent | None = None,
    ) -> OneShotRuntimeResult:
        """Run one isolated turn through the configured surface runtime.

        This deliberately skips ``SessionCatalogStore`` and product message events, so the
        invocation never appears in the conversation list.  It still opens the registered
        runtime adapter (Codex today), preserving runtime selection, authentication,
        metering and trace behavior instead of calling a vendor endpoint directly.

        ``owner_id`` controls the invocation lifecycle and artifact boundary. ``user_id`` is
        the authenticated account whose current token credentials the model bridge resolves.
        Desktop machine ownership intentionally makes these values different.
        """

        if self._closed:
            raise RuntimeError("runtime service is closed")
        if invocation_id in self._one_shot_close_failures:
            raise RuntimeError("one-shot invocation cleanup was not confirmed")
        if invocation_id in self._one_shot_tasks:
            raise ValueError("one-shot invocation is already running")
        invocation_task = asyncio.current_task()
        if invocation_task is None:
            raise RuntimeError("one-shot invocation requires an asyncio task")
        self._one_shot_tasks[invocation_id] = (owner_id, invocation_task)
        self._one_shot_directories[invocation_id] = (
            cwd,
            *(permission.writable_roots if permission is not None else writable_roots),
        )
        if permission is not None:
            permission_mode = permission.mode
            network_access = permission.network_access
        trace: SessionTrace | None = None
        driver: RuntimeDriver | None = None
        runtime_session: RuntimeSession | None = None
        submitted = False
        opening_id = uuid.uuid4().hex
        opening_record: RuntimeOpening | None = None
        release_opening = False
        service_callbacks: set[asyncio.Task[None]] = set()
        try:
            trace = SessionTrace(invocation_id, cwd, runtime_id=self.runtime_id)
            trace.invocation_started(
                purpose=purpose,
                requested_model_key=model_id,
                permission_mode=permission_mode.value,
                network_access=network_access,
                instruction_chars=len(developer_instructions),
                input_chars=len(input_text),
                skill_identity=skill_identity,
                required_capabilities=tuple(item.value for item in required_capabilities),
                optional_capabilities=tuple(item.value for item in optional_capabilities),
            )
            timing = trace.activation(invocation_id)

            async def respond_service(callback: RuntimeCallbackRequest) -> None:
                active_session = runtime_session
                if active_session is None:
                    raise RuntimeError(ONE_SHOT_RUNTIME_FAILURE_CODE)
                prompt = callback.prompt if isinstance(callback.prompt, Mapping) else {}
                if (
                    callback.kind is CallbackKind.DYNAMIC_TOOL
                    and callback.native_session_id == active_session.binding.opaque_session_ref
                    and callback.native_turn_id
                    and prompt.get("tool") == SERVICE_BRIDGE_TOOL.name
                ):
                    try:
                        result = await execute_service_tool(
                            prompt.get("arguments"),
                            session_id=invocation_id,
                            token=bridge_token,
                            local_socket=self._local_socket,
                            callback_request_id=callback.request_id,
                            callback_turn_id=callback.native_turn_id,
                        )
                    except Exception:
                        self._logger.exception(
                            "service_tool_execution_failed invocation_id=%s", invocation_id
                        )
                        result = {"ok": False, "error": "bridge_execution_failed"}
                else:
                    result = {"ok": False, "error": "bridge_access_denied"}
                await active_session.respond(
                    RuntimeCallbackResponse(
                        request_id=callback.request_id,
                        decision=CallbackKind.DYNAMIC_TOOL.value,
                        values=result,
                        idempotency_key=callback.request_id,
                        responded_at=datetime.now(UTC).isoformat(),
                    )
                )

            async def observe(observation: RuntimeObservation) -> None:
                if (
                    isinstance(observation, RuntimeCallbackRequest)
                    and observation.audience is CallbackAudience.SERVICE
                ):
                    task = asyncio.create_task(respond_service(observation))
                    service_callbacks.add(task)
                    task.add_done_callback(service_callbacks.discard)
                    return
                if isinstance(observation, RuntimeEvent):
                    if observation.kind is RuntimeEventKind.RUNTIME_EVIDENCE:
                        process, rpc = decode_evidence(observation)
                        for process_event in process:
                            trace.runtime_process_event(process_event)
                        for rpc_event in rpc:
                            trace.runtime_rpc_evidence(rpc_event)
                    else:
                        trace.runtime_event(observation)
                if observer is not None:
                    await observer(observation)

            with timing.measure(ActivationStage.TOTAL):
                with timing.measure(ActivationStage.READINESS):
                    readiness = await self.readiness(executable=executable)
                if not readiness.ready:
                    raise RuntimeError(readiness.safe_error or "harness_runtime_not_ready")
                launch_environment = dict(process_environment or {})
                with timing.measure(ActivationStage.PLAN):
                    model, _options, _environment = self._session_options(
                        model_id=model_id,
                        executable=readiness.executable or executable,
                        process_environment=launch_environment,
                        session_id=invocation_id,
                        user_id=user_id,
                        turn_id_provider=_invocation_turn_identity,
                        source_text=input_text,
                    )
                    model_intent, credential_port = model.runtime_model()
                    if minimum_reasoning:
                        # 声明优先：我们在这条坐标上知道有哪些档；只有压根没声明档位形态时，
                        # 才退回 runtime 上报的清单兜底（订阅模型等我们未登记的情况）。
                        reasoning_effort = minimum_effort(model.reasoning_options)
                        if not reasoning_effort:
                            inventory = await self.model_inventory(
                                cwd=cwd,
                                process_environment=launch_environment,
                                user_id=user_id,
                                model_id=model_id,
                            )
                            selected = next(
                                (
                                    item
                                    for item in inventory.models
                                    if item.model == model.model_name
                                    or item.model_id == model.model_name
                                    or (not model.model_name and item.is_default)
                                ),
                                None,
                            )
                            supported = (
                                {item.value for item in selected.supported_reasoning_efforts}
                                if selected
                                else set()
                            )
                            reasoning_effort = next(
                                (level for level in REASONING_EFFORT_LEVELS if level in supported),
                                "",
                            )
                        # Missing effort metadata does not make generation unsupported;
                        # an empty effort preserves the subscription model's default.
                    else:
                        require_declared_effort(model.reasoning_options, reasoning_effort)
                    model_intent = replace(
                        model_intent,
                        reasoning_effort=reasoning_effort,
                        service_tier=service_tier,
                    )
                await self._activities.finish(
                    ActivityDomain.RUNTIME,
                    lambda: self._activities.to_thread(
                        ActivityDomain.RUNTIME, prepare_commands, cwd
                    ),
                )
                launch_secrets, secret_port = _launch_secret_contract(
                    launch_environment, include_skill_credentials=True, cwd=cwd
                )
                skill_configurations: tuple[SkillConfiguration, ...] = ()
                if not ephemeral:
                    with timing.measure(ActivationStage.SKILLS):
                        skill_configurations = await self.skill_configurations(
                            cwd=cwd,
                            user_id=user_id,
                            model_id=model_id,
                            process_environment=launch_environment,
                            timing=timing,
                        )
                request = OpenSessionRequest(
                    product_session_id=invocation_id,
                    cwd=cwd,
                    execution_scope=invocation_id,
                    process_sharing_scope=user_id,
                    model=model_intent,
                    credential_port=credential_port,
                    launch_secrets=launch_secrets,
                    secret_port=secret_port,
                    permission=permission
                    or PermissionIntent(
                        mode=permission_mode,
                        revision=f"permission:{permission_mode.value}",
                        writable_roots=writable_roots,
                        network_access=network_access,
                    ),
                    base_instructions=base_instructions,
                    developer_instructions=developer_instructions,
                    service_tools=(SERVICE_BRIDGE_TOOL,) if bridge_token else (),
                    skill_roots=SERVICE_SKILL_ROOTS,
                    skill_policy=SkillPolicy.DENY if ephemeral else SkillPolicy.INHERIT,
                    skill_configurations=skill_configurations,
                    timing=timing,
                    ephemeral=ephemeral,
                    required_capabilities=required_capabilities,
                    optional_capabilities=optional_capabilities,
                )
                provider = self._gateway.provider(self.runtime_id)
                with timing.measure(ActivationStage.ADMISSION):
                    receipt = await self.activation.acquire(
                        provider,
                        ResourceRequest(
                            invocation_id,
                            ResourcePurpose.INVOCATION,
                            time.time() + provider.resource_policy.wait_seconds,
                            request,
                        ),
                    )
                with timing.measure(ActivationStage.ATTACH):
                    try:
                        opening_record = RuntimeOpening(
                            self.runtime_id,
                            invocation_id,
                            self._activities.enter(ActivityDomain.RUNTIME),
                            directories=self._one_shot_directories[invocation_id],
                        )
                        self._uncertain_attachments[opening_id] = opening_record
                        try:
                            runtime_session = await provider.open(
                                replace(request, reservation_id=receipt.reservation_id)
                            )
                        except RuntimeOpenNotAppliedError as error:
                            release_opening = error.reservation_id == receipt.reservation_id
                            raise
                        driver = RuntimeDriver(runtime_session, observe)
                    finally:
                        await provider.cancel_resource(receipt.reservation_id)

            driver.start()
            self._one_shot_drivers[invocation_id] = (owner_id, driver)
            submitted = True
            result = await driver.submit(
                TurnRequest(command_id=invocation_id, items=items or (input_text,))
            )
            if service_callbacks:
                await asyncio.gather(*service_callbacks)
            trace.invocation_completed(
                purpose=purpose,
                model_key=model.key,
                vendor_thread_id=runtime_session.binding.opaque_session_ref,
                vendor_turn_id=result.native_turn_id,
                status=result.outcome.value,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
                runtime_capabilities={
                    item.name: item.state.value
                    for item in runtime_session.binding.capabilities.entries
                },
            )
            return OneShotRuntimeResult(
                model_key=model.key,
                turn=result,
                vendor_thread_id=runtime_session.binding.opaque_session_ref,
            )
        except Exception as exc:
            if trace is not None:
                trace.invocation_failed(
                    purpose=purpose,
                    requested_model_key=model_id,
                    failure_type=type(exc).__name__,
                )
            # Retry hints do not prove a turn never ran: a timeout may only have sent
            # an interrupt request. Only a returned SurfaceTurnResult confirms a terminal
            # outcome. Exceptions after submission remain uncertain, without replay.
            raise OneShotRuntimeError(
                submitted=submitted,
                safe_error=str(getattr(exc, "safe_error", "") or exc),
            ) from exc
        finally:
            failures: list[BaseException] = []
            for task in tuple(service_callbacks):
                task.cancel()
            try:
                results = await asyncio.gather(*service_callbacks, return_exceptions=True)
                failures.extend(
                    result
                    for result in results
                    if isinstance(result, BaseException)
                    and not isinstance(result, asyncio.CancelledError)
                )
            except BaseException as error:
                failures.append(error)
            if driver is not None:
                self._one_shot_drivers[invocation_id] = (owner_id, driver)
                try:
                    await self._activities.finish(ActivityDomain.RUNTIME, driver.close)
                except BaseException as error:
                    failures.append(error)
                else:
                    self._one_shot_drivers.pop(invocation_id, None)
            elif runtime_session is not None:
                try:
                    await self._activities.finish(ActivityDomain.RUNTIME, runtime_session.detach)
                except BaseException as error:
                    failures.append(error)
            try:
                if not failures:
                    self._models.release_session(invocation_id)
            except BaseException as error:
                failures.append(error)
            if trace is not None:
                try:
                    trace.close()
                except BaseException as error:
                    failures.append(error)
            self._one_shot_tasks.pop(invocation_id, None)
            if opening_record is not None:
                opening_record.settled = True
                if not failures and (release_opening or runtime_session is not None):
                    self._uncertain_attachments.pop(opening_id, None)
                    opening_record.activity.close()
            if failures:
                cleanup_error = (
                    failures[0]
                    if len(failures) == 1
                    else BaseExceptionGroup("one-shot cleanup failed", failures)
                )
                self._one_shot_close_failures[invocation_id] = cleanup_error
                raise cleanup_error
            self._one_shot_directories.pop(invocation_id, None)

    async def interrupt_invocations_for_update(self) -> None:
        """Interrupt this instance's admitted one-shots without releasing ownership.

        Session interruption does not cover independent runtime invocations.
        Keep their tasks, drivers and leases until their existing owners finish
        cleanup; the parent control still must prove business drain afterwards.
        """
        snapshot = self._activities.snapshot()
        if snapshot.phase is not ActivityPhase.DRAINING:
            raise MaintenanceStale("update_maintenance_stale")
        selected = tuple(self._one_shot_tasks.items())

        async def interrupt_one(identity: str, owner: str, task: asyncio.Task[Any]) -> bool:
            self._logger.info("update invocation interruption started: invocation_id=%s", identity)
            accepted = await self.cancel_once(
                identity, owner_id=owner, cleanup_background_processes=True
            )
            # Completion can win the race with interruption. Only the owning
            # invocation's own removal proves it no longer needs the request.
            finished = self._one_shot_tasks.get(identity) != (owner, task)
            self._logger.info(
                "update invocation interruption returned: invocation_id=%s accepted=%s finished=%s",
                identity,
                accepted,
                finished,
            )
            return accepted or finished

        results = await asyncio.gather(
            *(interrupt_one(identity, owner, task) for identity, (owner, task) in selected),
            return_exceptions=True,
        )
        if any(result is not True for result in results) or self._one_shot_close_failures:
            raise RuntimeError("update invocation interruption failed")

    async def cancel_once(
        self, invocation_id: str, *, owner_id: str, cleanup_background_processes: bool = False
    ) -> bool:
        """Request an owned turn's interrupt; a receipt is not a confirmed terminal state."""

        active = self._one_shot_drivers.get(invocation_id)
        if active is None:
            pending = self._one_shot_tasks.get(invocation_id)
            if pending is None or pending[0] != owner_id:
                return False
            pending[1].cancel()
            await asyncio.gather(pending[1], return_exceptions=True)
            return True
        if active[0] != owner_id:
            return False
        driver = active[1]
        receipt = await driver.session.interrupt(
            InterruptRequest(
                command_id=f"{invocation_id}-interrupt",
                cleanup_background_processes=cleanup_background_processes,
            )
        )
        return receipt.state is CommandState.ACCEPTED

    async def respond_once(
        self,
        invocation_id: str,
        *,
        owner_id: str,
        response: RuntimeCallbackResponse,
    ) -> bool:
        """Deliver an owned callback response to an active isolated turn."""

        active = self._one_shot_drivers.get(invocation_id)
        if active is None or active[0] != owner_id:
            return False
        receipt = await active[1].session.respond(response)
        return receipt.state in {CommandState.ACCEPTED, CommandState.APPLIED}

    async def one_shot_inventory(
        self,
        invocation_id: str,
        *,
        owner_id: str,
        cwd: Path,
        force_reload: bool = False,
    ) -> SkillInventory:
        active = self._one_shot_drivers.get(invocation_id)
        if active is None or active[0] != owner_id:
            raise RuntimeError(RESOURCE_HOST_CONTEXT_REQUIRED)
        snapshot = await active[1].session.inventory(
            InventoryRequest((InventoryKind.SKILLS,), refresh=force_reload)
        )
        if self._one_shot_drivers.get(invocation_id) is not active:
            raise RuntimeError(RESOURCE_HOST_CONTEXT_REQUIRED)
        values = snapshot.values if isinstance(snapshot.values, Mapping) else {}
        return _skill_inventory_from_runtime(values.get(InventoryKind.SKILLS.value), cwd=cwd)

    async def realign_metering_identity(self, live: LiveSession, user_id: str) -> bool:
        """Validate the shared host before changing an existing outbound identity."""
        actor = str(user_id or "").strip()
        if not actor or actor == LOCAL_USER_ID or live.user_id == actor:
            return False
        previous = (live.user_id, live.model_id)
        async with self.host_control(
            cwd=live.runtime_workdir,
            user_id=actor,
            model_id=live.model_id,
        ):
            if (live.user_id, live.model_id) != previous:
                raise RuntimeError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
            self._models.rebind_owner(live.id, actor)
            live.user_id = actor
        self._logger.info(
            "codex_session_metering_identity_realigned",
            extra={"session_id": live.id},
        )
        return True

    async def rebind(
        self,
        live: LiveSession,
        *,
        cwd: Path,
        project_path: Path | None,
        output_root: Path,
        model_id: str,
        writable_roots: tuple[Path, ...],
        process_environment: Mapping[str, str] | None = None,
    ) -> None:
        """Change detached product roots; the next operation resumes the durable binding."""
        if live.runtime_session is not None and not await live.suspend_runtime():
            raise RuntimeError("runtime relocation requires a quiescent session")
        async with live.lifecycle_lock:
            if process_environment is not None:
                live.retarget_environment(process_environment)
            live.relocate(cwd=cwd, project_path=project_path, output_root=output_root)
            live.project_id = (
                self._project_id_for_path(project_path)
                if project_path and self._project_id_for_path
                else ""
            )
            live.writable_roots = writable_roots
            live.model_id = model_id

    async def realign_environment(
        self,
        live: LiveSession,
        *,
        model_id: str,
        process_environment: Mapping[str, str],
    ) -> bool:
        """Invalidate an idle attachment before changing its credential intent."""
        if live.runtime_session is not None and not await live.suspend_runtime():
            raise RuntimeError("runtime credentials require a quiescent session")
        async with live.lifecycle_lock:
            live.retarget_environment(process_environment)
            live.model_id = model_id
        return True

    async def switch_model(
        self, live: LiveSession, *, model_id: str, reasoning_effort: str = ""
    ) -> None:
        """Release an idle attachment before retargeting its next admission."""
        if live.runtime_session is not None and not await live.suspend_runtime():
            raise RuntimeError("runtime model switch requires a quiescent session")
        async with live.lifecycle_lock:
            live.model_id = model_id
            live.reasoning_effort = reasoning_effort

    @staticmethod
    def _launch_environment(live: LiveSession) -> dict[str, str]:
        """Keep session-scoped bridge identity out of the shared App Server process."""

        blocked = {BRIDGE_SESSION_ENV, BRIDGE_TOKEN_ENV, BRIDGE_SOCKET_ENV, INTERNAL_BASE_URL_ENV}
        return {
            name: value for name, value in live.process_environment.items() if name not in blocked
        }

    def _session_options(
        self,
        *,
        model_id: str,
        executable: str,
        process_environment: Mapping[str, str] | None,
        session_id: str = "",
        user_id: str = "",
        reasoning_effort: str | None = None,
        thinking: ModelThinking | None = None,
        turn_id_provider: Callable[[str], str] | None = None,
        source_text: str | None = None,
    ) -> tuple[SessionModelSpec, dict[str, Any], dict[str, str]]:
        """Resolve the model spec plus the surface options and env for one session.

        ``session_id`` is the *product* session id, not the vendor thread id: the gateway
        aggregates cost per product session, and its materialised view drops rows whose
        chat id is empty — so omitting it means the session never appears in metering at
        all. ``user_id`` lets the outbound token be resolved per call rather than
        snapshotted at registration.

        ``turn_id_provider`` is the third metering dimension (per-turn aggregation) and is
        likewise resolved per call; only one-shot invocations pass their own, everyone else
        keeps the session-keyed resolver the composition root injected into ``ModelService``.
        """

        model = self._models.session_spec(
            model_id,
            reasoning_effort=reasoning_effort,
            thinking=thinking,
            session_id=session_id,
            user_id=user_id,
            turn_id_provider=turn_id_provider,
            source_text=source_text,
        )
        del executable
        return model, {}, dict(process_environment or {})
