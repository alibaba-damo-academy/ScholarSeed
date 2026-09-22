"""Product runtime composition ownership."""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Mapping

from scholarseed_runtime.contract import (
    CapabilitySet,
    CommandState,
    InterruptRequest,
    InventoryKind,
    InventoryRequest,
    ModelThinking,
    OpenSessionRequest,
    PermissionIntent,
    ResumeSessionRequest,
    RuntimeCallbackResponse,
    RuntimeCapabilityName,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeInspectionRequest,
    RuntimePermissionMode,
    RuntimeReadiness,
    RuntimeSession,
    RuntimeValue,
    TurnRequest,
)
from scholarseed_runtime.contract.command import SkillConfiguration, SkillConfigurationRequest
from scholarseed_runtime.contract.evidence import NOOP_RUNTIME_TIMING, RuntimeTimingPort
from scholarseed_runtime.contract.incident import RuntimeRetryability
from scholarseed_runtime.contract.inventory import ModelInventory, SkillInventory
from scholarseed_runtime.contract.resource import ResourcePurpose, ResourceRequest
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
from service.chat.active import base_instructions, developer_instructions
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.catalog import OpenState, SessionCatalogStore
from service.chat.persistence.events import ProductEventStore
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
from service.chat.runtime.projection import (
    ONE_SHOT_RUNTIME_FAILURE_CODE,
    RUNTIME_DEFAULT_MODEL_UNAVAILABLE_ERROR,
)
from service.chat.runtime.secrets import _launch_secret_contract
from service.chat.runtime.selection import RuntimeGateway
from service.chat.service.cards import CardRegistry
from service.chat.service.models import ModelService, SessionModelSpec
from service.chat.service.publication import PublicationService
from service.chat.service.recording import RecordingService
from service.inference.reasoning import minimum_effort, require_declared_effort
from service.paths import SERVICE_SKILL_ROOTS
from service.platform.bridge import (
    BRIDGE_COMMAND,
    BRIDGE_SESSION_ENV,
    BRIDGE_SOCKET_ENV,
    BRIDGE_TOKEN_ENV,
    INTERNAL_BASE_URL_ENV,
)
from service.platform.citations import CitationAnswerFilter
from service.platform.executables import command_directories, probe_command, resolve_command
from service.platform.resources import AgentResourceChangeSink
from service.settings.capabilities import REASONING_EFFORT_LEVELS

EXECUTABLE_PATH_ENV = "PATH"
_LOGGER = logging.getLogger(__name__)


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

    def __init__(self, *, submitted: bool) -> None:
        super().__init__(ONE_SHOT_RUNTIME_FAILURE_CODE)
        self.retryability = (
            RuntimeRetryability.UNKNOWN_OUTCOME if submitted else RuntimeRetryability.USER_RETRYABLE
        )


class LiveSessionService:
    """Open typed Codex adapters and expose runtime readiness."""

    def __init__(
        self,
        *,
        catalog: SessionCatalogStore,
        events: ProductEventStore,
        artifacts: SessionArtifactStore,
        skills: SkillCatalog,
        models: ModelService,
        logger: Any,
        gateway: RuntimeGateway | None = None,
        resource_changes: AgentResourceChangeSink | None = None,
    ) -> None:
        self._catalog = catalog
        self.recording = RecordingService(catalog, events)
        self._events = events
        self._artifacts = artifacts
        self._skills = skills
        self._models = models
        self._logger = logger
        self._gateway = gateway or RuntimeGateway.discover()
        self.activation = SessionActivation(
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
        self._one_shot_drivers: dict[str, tuple[str, RuntimeDriver]] = {}
        self._one_shot_tasks: dict[str, tuple[str, asyncio.Task[Any]]] = {}
        self._project_id_for_path: Callable[[Path], str] | None = None
        self._local_socket: Path | None = None
        self._publications: PublicationService | None = None
        self._cards = CardRegistry()
        self._activity_observer: SessionActivityObserver | None = None
        self._answer_filter: CitationAnswerFilter | None = None
        self._prewarm_task: asyncio.Task[object] | None = None
        self._prewarm_done = False

    def bind_publications(self, publications: PublicationService) -> None:
        self._publications = publications

    def bind_activity_observer(self, observer: SessionActivityObserver) -> None:
        """Bind the product policy that inspects workspace state after runtime actions."""

        self._activity_observer = observer

    def bind_answer_filter(self, answer_filter: CitationAnswerFilter) -> None:
        """Bind the product-owned final-answer integrity policy before sessions open."""

        self._answer_filter = answer_filter

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
        return await self._gateway.readiness(runtime_id or self.runtime_id)

    async def model_inventory(
        self,
        *,
        cwd: Path,
        executable: str = "",
        process_environment: Mapping[str, str] | None = None,
    ) -> ModelInventory:
        del executable
        launch_secrets, secret_port = _launch_secret_contract(process_environment)
        snapshot = await self._gateway.inspect(
            RuntimeInspectionRequest(
                cwd=cwd.expanduser().resolve(),
                inventory=InventoryRequest((InventoryKind.MODELS,)),
                roots=SERVICE_SKILL_ROOTS,
                launch_secrets=launch_secrets,
                secret_port=secret_port,
            ),
            self.runtime_id,
        )
        values = snapshot.values if isinstance(snapshot.values, Mapping) else {}
        return _model_inventory_from_runtime(values.get(InventoryKind.MODELS.value))

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
        executable: str = "",
        process_environment: Mapping[str, str] | None = None,
        force_reload: bool = False,
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
    ) -> SkillInventory:
        del executable
        launch_secrets, secret_port = _launch_secret_contract(process_environment)
        snapshot = await self._gateway.inspect(
            RuntimeInspectionRequest(
                cwd=cwd.expanduser().resolve(),
                inventory=InventoryRequest(
                    (InventoryKind.SKILLS,),
                    refresh=force_reload,
                ),
                roots=SERVICE_SKILL_ROOTS,
                launch_secrets=launch_secrets,
                secret_port=secret_port,
                timing=timing,
            ),
            self.runtime_id,
        )
        values = snapshot.values if isinstance(snapshot.values, Mapping) else {}
        return _skill_inventory_from_runtime(
            values.get(InventoryKind.SKILLS.value),
            cwd=cwd.expanduser().resolve(),
        )

    def schedule_skill_prewarm(self, *, cwd: Path) -> None:
        """Warm the pre-session inventory host in the background, off the request path.

        首启（以及宿主进程重启后）第一次技能盘点要付一遍 App Server 冷启; 桌面启动必然
        轮询就绪端点, 让它顺手把这段搬到后台, 用户真正打开技能面时已经是热进程。
        """

        if self._prewarm_done:
            return
        task = self._prewarm_task
        if task is not None and not task.done():
            return
        self._prewarm_task = asyncio.get_running_loop().create_task(
            self._run_skill_prewarm(cwd=cwd)
        )

    async def _run_skill_prewarm(self, *, cwd: Path) -> None:
        try:
            await self.skill_inventory(cwd=cwd, process_environment={}, force_reload=False)
        except Exception as exc:  # noqa: BLE001 - 预热失败只意味着首启仍走冷路径
            self._logger.warning("skill inventory prewarm skipped: %s", exc)
            return
        self._prewarm_done = True

    async def skill_admission(
        self, *, path: Path, cwd: Path, user_id: str
    ) -> Mapping[str, Any] | None:
        canonical = path.expanduser().resolve()
        inventory = await self.skill_inventory(cwd=cwd, force_reload=True)
        rows = self._skills.payloads(inventory, load_skill_state(), user_id=user_id)
        matches = [row for row in rows if canonical.is_relative_to(Path(str(row["path"])).parent)]
        return max(matches, key=lambda row: len(Path(str(row["path"])).parts), default=None)

    async def skill_configurations(
        self, *, cwd: Path, user_id: str
    ) -> tuple[SkillConfiguration, ...]:
        inventory = await self.skill_inventory(cwd=cwd, force_reload=True)
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
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
    ) -> SkillInventory:
        inventory = await self.skill_inventory(cwd=cwd, force_reload=True, timing=timing)
        plan = self._skills.enablement_plan(inventory, state)
        enabled_by_path = {
            self._skills.manifest(skill.path).expanduser().resolve(): skill.enabled
            for skill in inventory.skills
        }
        configurations = tuple(
            SkillConfiguration(path, enabled)
            for path, enabled in plan.configurations
            if enabled_by_path.get(path) != enabled
        )
        if configurations:
            receipt = await self._gateway.provider(self.runtime_id).configure_skills(
                SkillConfigurationRequest(
                    cwd=cwd, roots=SERVICE_SKILL_ROOTS, skills=configurations, timing=timing
                )
            )
            if receipt.state is not CommandState.APPLIED:
                raise RuntimeError(receipt.safe_error or "skill configuration was not applied")
            inventory = await self.skill_inventory(cwd=cwd, force_reload=True, timing=timing)
            effective = {
                self._skills.manifest(skill.path).expanduser().resolve(): skill.enabled
                for skill in inventory.skills
            }
            if any(effective.get(row.path) != row.enabled for row in configurations):
                raise RuntimeError("skill configuration verification failed")
        if plan.state != state:
            save_skill_state(plan.state)
        elif load_skill_state() != state:
            save_skill_state(state)
        return inventory

    def bind_sessions(self, sessions: Mapping[str, LiveSession]) -> None:
        self.activation.bind_sessions(sessions)

    async def start(self) -> None:
        await self.activation.start()

    async def aclose(self) -> None:
        await self.activation.aclose()
        tasks = tuple(task for _owner, task in self._one_shot_tasks.values())
        if self._prewarm_task is not None:
            tasks = (*tasks, self._prewarm_task)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        drivers = tuple(driver for _owner, driver in self._one_shot_drivers.values())
        await asyncio.gather(*(driver.close() for driver in drivers), return_exceptions=True)
        self._one_shot_drivers.clear()
        results = await asyncio.gather(
            *(
                self._gateway.provider(runtime_id).shutdown()
                for runtime_id in self._gateway.catalog.runtime_ids()
            ),
            return_exceptions=True,
        )
        failures = [result for result in results if isinstance(result, BaseException)]
        if failures:
            raise failures[0]

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
        inventory = await self.configure_skills(
            cwd=live.runtime_workdir, state=load_skill_state(), timing=timing
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
            project_id=project_id,
            resource_changes=self._resource_changes,
            local_socket=self._local_socket,
            publications=self._publications,
            cards=self._cards,
            activity_observer=self._activity_observer,
            answer_filter=self._answer_filter,
            skill_inventory_provider=lambda cwd: self.skill_inventory(cwd=cwd, force_reload=True),
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
        )

    def _activation_plan(self, live: LiveSession) -> ActivationPlan:
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
        launch_secrets, secret_port = _launch_secret_contract(self._launch_environment(live))
        mode = str(revision[1] or RuntimePermissionMode.ASK.value)
        permission = PermissionIntent(
            mode=RuntimePermissionMode(mode),
            revision=f"permission:{mode}",
            writable_roots=live.writable_roots,
            local_sockets=(live.local_socket,) if live.local_socket else (),
        )
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
        replaces = (
            binding
            if binding and self._events.rejected_turns(live.id, binding.opaque_session_ref)
            else None
        )
        request: OpenSessionRequest | ResumeSessionRequest
        if activation.open_state is OpenState.BOUND and replaces is None:
            if binding is None:
                raise SessionActivationError(SESSION_OPEN_UNKNOWN)
            request = ResumeSessionRequest(
                binding=binding,
                cwd=live.runtime_workdir,
                model=model_intent,
                credential_port=credential_port,
                launch_secrets=launch_secrets,
                secret_port=secret_port,
                permission=permission,
                base_instructions=base,
                developer_instructions=instructions,
                skill_roots=SERVICE_SKILL_ROOTS,
                skill_configurations=live.skill_configurations,
            )
            provider = self._gateway.provider_for(binding)
        else:
            request = OpenSessionRequest(
                product_session_id=live.id,
                cwd=live.runtime_workdir,
                model=model_intent,
                credential_port=credential_port,
                launch_secrets=launch_secrets,
                secret_port=secret_port,
                permission=permission,
                base_instructions=base,
                developer_instructions=instructions,
                skill_roots=SERVICE_SKILL_ROOTS,
                skill_configurations=live.skill_configurations,
                required_capabilities=activation.required_capabilities,
                initial_history=(
                    self._events.portable_history(live.id, exclude_rejected=True)
                    if replaces is not None
                    else ()
                ),
            )
            provider = self._gateway.provider(live.runtime_id)
        return ActivationPlan(provider, request, revision, model.model_run, replaces)

    async def _attach_runtime(
        self, live: LiveSession, plan: ActivationPlan, reservation_id: str
    ) -> None:
        request = replace(plan.request, reservation_id=reservation_id)
        attempt_id = ""
        runtime_session = None
        try:
            if isinstance(request, OpenSessionRequest):
                if plan.replaces is None:
                    attempt_id = uuid.uuid4().hex
                    if self._catalog.begin_open(live.id, attempt_id) is None:
                        raise SessionActivationError(SESSION_OPEN_UNKNOWN)
                runtime_session = await plan.provider.open(request)
                if plan.replaces is None:
                    self._catalog.bind_open(live.id, attempt_id, runtime_session.binding)
                else:
                    self._catalog.replace_runtime_binding(plan.replaces, runtime_session.binding)
                    self._logger.info(
                        "rejected_context_isolated session=%s previous_thread=%s thread=%s retained_messages=%d",
                        live.id,
                        plan.replaces.opaque_session_ref,
                        runtime_session.binding.opaque_session_ref,
                        len(request.initial_history),
                    )
            else:
                runtime_session = await plan.provider.resume(request)
            live.attachment_generation = self._catalog.begin_attachment(live.id)
            live.model_id = str(plan.revision[0])
            live.model_run = plan.model_run
            live.reasoning_effort = request.model.reasoning_effort if request.model else ""
            live.thinking = request.model.thinking if request.model else None
            live.applied_permission_mode = str(plan.revision[1] or RuntimePermissionMode.ASK.value)
            driver = live.attach_gateway(
                runtime_session, resumed=isinstance(request, ResumeSessionRequest)
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
        except BaseException:
            if attempt_id:
                self._catalog.mark_open_unknown(live.id, attempt_id)
            if runtime_session is not None:
                if live.runtime_driver is not None:
                    await live.runtime_driver.close()
                else:
                    await runtime_session.detach()
                live.runtime_session = None
                live.runtime_driver = None
            self._models.release_session(live.id)
            raise

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
        skill_identity: Mapping[str, str] | None = None,
        ephemeral: bool = False,
        minimum_reasoning: bool = False,
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

        if invocation_id in self._one_shot_tasks:
            raise ValueError("one-shot invocation is already running")
        invocation_task = asyncio.current_task()
        if invocation_task is None:
            raise RuntimeError("one-shot invocation requires an asyncio task")
        self._one_shot_tasks[invocation_id] = (owner_id, invocation_task)
        trace = SessionTrace(invocation_id, cwd, runtime_id=self.runtime_id)
        trace.invocation_started(
            purpose=purpose,
            requested_model_key=model_id,
            permission_mode=permission_mode.value,
            network_access=network_access,
            instruction_chars=len(developer_instructions),
            input_chars=len(input_text),
            skill_identity=skill_identity,
        )
        driver: RuntimeDriver | None = None
        submitted = False
        try:
            readiness = await self.readiness(executable=executable)
            if not readiness.ready:
                raise RuntimeError(readiness.safe_error or "harness_runtime_not_ready")
            launch_environment = dict(process_environment or {})
            if bridge_token:
                launch_environment = self._bridge_environment(
                    launch_environment,
                    scope_id=invocation_id,
                    token=bridge_token,
                    local_socket=self._local_socket,
                )
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
                        cwd=cwd, process_environment=launch_environment
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
                        (level for level in REASONING_EFFORT_LEVELS if level in supported), ""
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
            launch_secrets, secret_port = _launch_secret_contract(launch_environment)
            request = OpenSessionRequest(
                product_session_id=invocation_id,
                cwd=cwd,
                model=model_intent,
                credential_port=credential_port,
                launch_secrets=launch_secrets,
                secret_port=secret_port,
                permission=PermissionIntent(
                    mode=permission_mode,
                    revision=f"permission:{permission_mode.value}",
                    writable_roots=writable_roots,
                    local_sockets=(
                        (self._local_socket,) if bridge_token and self._local_socket else ()
                    ),
                    network_access=network_access,
                ),
                base_instructions=base_instructions,
                developer_instructions=developer_instructions,
                skill_roots=() if ephemeral else SERVICE_SKILL_ROOTS,
                skill_configurations=(
                    () if ephemeral else await self.skill_configurations(cwd=cwd, user_id=user_id)
                ),
                ephemeral=ephemeral,
                required_capabilities=required_capabilities,
            )
            provider = self._gateway.provider(self.runtime_id)
            receipt = await self.activation.acquire(
                provider,
                ResourceRequest(
                    invocation_id,
                    ResourcePurpose.INVOCATION,
                    time.time() + provider.resource_policy.wait_seconds,
                    request,
                ),
            )
            try:
                runtime_session = await provider.open(
                    replace(request, reservation_id=receipt.reservation_id)
                )
            finally:
                await provider.cancel_resource(receipt.reservation_id)

            async def observe(observation: RuntimeObservation) -> None:
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

            driver = RuntimeDriver(runtime_session, observe)
            driver.start()
            self._one_shot_drivers[invocation_id] = (owner_id, driver)
            submitted = True
            result = await driver.submit(
                TurnRequest(command_id=invocation_id, items=items or (input_text,))
            )
            trace.invocation_completed(
                purpose=purpose,
                model_key=model.key,
                vendor_thread_id=runtime_session.binding.opaque_session_ref,
                vendor_turn_id=result.native_turn_id,
                status=result.outcome.value,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
            )
            return OneShotRuntimeResult(
                model_key=model.key,
                turn=result,
                vendor_thread_id=runtime_session.binding.opaque_session_ref,
            )
        except Exception as exc:
            trace.invocation_failed(
                purpose=purpose,
                requested_model_key=model_id,
                failure_type=type(exc).__name__,
            )
            # Retry hints do not prove a turn never ran: a timeout may only have sent
            # an interrupt request. Only a returned SurfaceTurnResult confirms a terminal
            # outcome. Exceptions after submission remain uncertain, without replay.
            raise OneShotRuntimeError(submitted=submitted) from exc
        finally:
            self._one_shot_tasks.pop(invocation_id, None)
            self._one_shot_drivers.pop(invocation_id, None)
            if driver is not None:
                await driver.close()
            self._models.release_session(invocation_id)
            trace.close()

    async def cancel_once(self, invocation_id: str, *, owner_id: str) -> bool:
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
            InterruptRequest(command_id=f"{invocation_id}-interrupt")
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

    def realign_metering_identity(self, live: LiveSession, user_id: str) -> bool:
        """Hand a warm session to the account that is driving it now.

        ``LiveSession.user_id`` is fixed at construction, so a desktop account switch leaves an
        already-open session resolving its outbound token from the signed-out account's slot —
        the gateway then answers ``401 invalid user token`` for every model call until serve
        restarts. Pure in-memory: the vendor thread is untouched, so this is cheap enough to run
        on each authenticated request that addresses the session.
        """

        actor = str(user_id or "").strip()
        if not actor or live.user_id == actor:
            return False
        live.user_id = actor
        self._models.rebind_owner(live.id, actor)
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
        """Keep product capability credentials separate from skill credential alignment."""

        return LiveSessionService._bridge_environment(
            live.process_environment,
            scope_id=live.id,
            token=live.bridge_token,
            local_socket=live.local_socket,
        )

    @staticmethod
    def _bridge_environment(
        base: Mapping[str, str],
        *,
        scope_id: str,
        token: str,
        local_socket: Path | None,
    ) -> dict[str, str]:
        """Expose the installed product bridge command and its private execution scope."""

        environment = dict(base)
        environment.pop(BRIDGE_SOCKET_ENV, None)
        base_url = os.environ.get(INTERNAL_BASE_URL_ENV, "")
        if local_socket:
            environment[BRIDGE_SOCKET_ENV] = str(local_socket)
        if base_url or local_socket:
            bridge = LiveSessionService._resolve_bridge_executable()
            if bridge is not None:
                executable_dir = str(bridge.parent)
                inherited_path = environment.get(
                    EXECUTABLE_PATH_ENV, os.environ.get(EXECUTABLE_PATH_ENV, "")
                )
                entries = [entry for entry in inherited_path.split(os.pathsep) if entry]
                environment[EXECUTABLE_PATH_ENV] = os.pathsep.join(
                    [executable_dir, *(entry for entry in entries if entry != executable_dir)]
                )
            environment.update(
                {
                    INTERNAL_BASE_URL_ENV: base_url,
                    BRIDGE_SESSION_ENV: scope_id,
                    BRIDGE_TOKEN_ENV: token,
                }
            )
        return environment

    @staticmethod
    def _resolve_bridge_executable() -> Path | None:
        """Resolve and probe the first usable product/PATH/environment bridge."""
        seen: set[Path] = set()
        for directory in command_directories():
            candidate = resolve_command(BRIDGE_COMMAND, directory)
            if candidate is None or candidate in seen:
                continue
            seen.add(candidate)
            if LiveSessionService._probe_bridge(candidate):
                return candidate
        _LOGGER.warning(
            "scholarseed-bridge executable unavailable; no working launcher was selected"
        )
        return None

    @staticmethod
    def _probe_bridge(path: Path) -> bool:
        """Probe bridge help without entering a product operation."""
        return probe_command(path)

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
