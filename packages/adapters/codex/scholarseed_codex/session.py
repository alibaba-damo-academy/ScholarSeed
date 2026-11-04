"""RuntimeSession commands and normalized observation stream for Codex."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator, Mapping
from dataclasses import asdict, replace
from datetime import UTC, datetime
from functools import wraps
from importlib.metadata import version
from pathlib import Path
from typing import Any, Callable

from scholarseed_codex.activity import NativeActivity
from scholarseed_codex.capacity import HostRole
from scholarseed_codex.diagnostic import THREAD_HISTORY_MISSING_ERROR
from scholarseed_codex.directive import parse_declarations
from scholarseed_codex.environment import (
    CODEX_DISCOVERY_HOME_DIRNAME,
    configured_codex_executable,
)
from scholarseed_codex.events import RUNTIME_EVENT_SCHEMA_VERSION, translate_event
from scholarseed_codex.isolation import managed_codex_launch, managed_shell_environment
from scholarseed_codex.launch import model_connection, validate_model_connection
from scholarseed_codex.loop import ToolLoopGuard
from scholarseed_codex.mailbox import ObservationMailbox
from scholarseed_codex.permission import (
    CODEX_PERMISSION_POLICIES,
    PERMISSION_SCOPE_NEXT_TURN,
    PERMISSION_SCOPE_SESSION,
    PermissionUpdate,
    local_socket_permissions,
    reviewer_only_update,
    thread_permission_config,
)
from scholarseed_codex.pool import CodexHostPool, PoolReservation
from scholarseed_codex.profile import (
    CODEX_MULTI_AGENT_V2_ENABLED_CONFIG,
    CODEX_PROTOCOL_SCHEMA_HASH,
    CODEX_PROTOCOL_VERSION,
    CODEX_WEB_SEARCH_DISABLED_MODE,
    CODEX_WEB_SEARCH_LIVE_MODE,
    CODEX_WEB_SEARCH_MODE_KEY,
    SESSION_SCOPED_CAPABILITIES,
    capabilities,
    native_web_search_supported,
    optional_capabilities,
    required_capabilities,
    session_thread_config,
)
from scholarseed_codex.protocol.mcp import (
    McpListRequest,
    McpLoginRequest,
    McpLogoutRequest,
    McpReadRequest,
    McpReloadRequest,
    McpToolCallRequest,
    McpTrustRequest,
)
from scholarseed_codex.protocol.session import (
    CODEX_MANAGED_IDENTITY,
    CODEX_REASONING_SUMMARY_AUTO,
    CODEX_REASONING_SUMMARY_CONFIG,
    CodexDynamicTool,
    CodexSessionEvent,
    CodexSessionEventKind,
    CodexSessionOpenRequest,
    CodexToolResponse,
)
from scholarseed_codex.protocol.state import (
    CODEX_DEFAULT_SANDBOX_MODE,
    CODEX_RUNTIME_ID,
    AppServerError,
    CodexActivationStage,
)
from scholarseed_codex.sandbox import windows_sandbox_arguments
from scholarseed_codex.skill import session_skill_config, session_skill_inventory
from scholarseed_codex.thread import CODEX_THREAD_RESTORE_FAILED, CodexThreadSession
from scholarseed_codex.utils import json_value
from scholarseed_runtime.contract import (
    AppliedState,
    ArchiveRequest,
    CallbackKind,
    CapabilitySet,
    CommandReceipt,
    CommandState,
    DeleteRequest,
    DeliveryClass,
    ForkRequest,
    InterruptRequest,
    InventoryKind,
    InventoryRequest,
    ModelCredentialPort,
    ModelIntent,
    ModelToolProtocol,
    OpenSessionRequest,
    RuntimeBinding,
    RuntimeCallbackRequest,
    RuntimeCallbackResponse,
    RuntimeCapabilityName,
    RuntimeConfigurationIntent,
    RuntimeControlKind,
    RuntimeControlRequest,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeInventory,
    RuntimeSession,
    RuntimeValue,
    SteerRequest,
    TerminateSessionRequest,
    TurnRequest,
    service_tool_profile,
)
from scholarseed_runtime.contract.command import SubmissionRetryProof, ThreadReplacementProof
from scholarseed_runtime.contract.incident import (
    RUNTIME_TURN_NOT_SUBMITTED,
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.input import (
    TURN_ADMISSION_STALE,
    CollaborationMode,
    InputItem,
    InputKind,
    SubmissionRetry,
    TurnAdmission,
    TurnInput,
)
from scholarseed_runtime.contract.mcp import McpTrustDecision
from scholarseed_runtime.contract.permission import PermissionIntent, PermissionUpdateScope
from scholarseed_runtime.contract.resource import ResourceEvidence
from scholarseed_runtime.contract.session import (
    RUNTIME_ACTIVITY_CHANGED,
    RUNTIME_CONFIRMATION_BUSY,
    RUNTIME_CONFIRMATION_STALE,
    RUNTIME_CONFIRMATION_UNPERSISTED,
    RUNTIME_OBSERVATION_PENDING,
    RUNTIME_SUSPEND_BUSY,
    RUNTIME_SUSPEND_FAILED,
    RUNTIME_SUSPEND_STALE,
    RUNTIME_SUSPEND_UNPERSISTED,
    RUNTIME_SUSPEND_UNSUPPORTED,
    RUNTIME_THREAD_REPLACEMENT_BUSY,
    RUNTIME_THREAD_REPLACEMENT_STALE,
    RUNTIME_THREAD_REPLACEMENT_UNPERSISTED,
    RuntimeActivitySnapshot,
    SuspendReceipt,
    SuspendState,
    SuspendTicket,
    ThreadReplacementReceipt,
    ThreadReplacementTarget,
    ThreadReplacementTicket,
    TurnConfirmationReceipt,
    TurnConfirmationTarget,
    TurnConfirmationTicket,
)

DEFAULT_COLLABORATION_MODE = "explicitRequestOnly"
CODEX_WEB_SEARCH_CAPABILITY_KEY = "webSearch"
CODEX_WEB_SEARCH_CAPABILITY_ERROR = "runtime_web_search_capability_unavailable"
CODEX_REASONING_EFFORT_CONFIG = "model_reasoning_effort"
CODEX_SERVICE_TIER_CONFIG = "service_tier"
TURN_SUBMISSION_FAILED_ERROR = "runtime_turn_submission_failed"
FAILED_STATE = "failed"
UNKNOWN_STATE = "unknown"
ACTIVITY_COMMAND_PENDING = "runtime_command_pending"
ACTIVITY_OPERATION_PENDING = "runtime_operation_pending"
SUBAGENT_LIFECYCLE_KINDS = frozenset(
    {
        RuntimeEventKind.SUBAGENT_STARTED,
        RuntimeEventKind.SUBAGENT_STATUS_CHANGED,
        RuntimeEventKind.SUBAGENT_COMPLETED,
        RuntimeEventKind.SUBAGENT_FAILED,
        RuntimeEventKind.SUBAGENT_INTERRUPTED,
    }
)
REPEATED_TOOL_LOOP_ERROR = "codex_repeated_tool_loop"
REPEATED_TOOL_INTERRUPT_ERROR = "codex_repeated_tool_interrupt_failed"
REPEATED_TOOL_INCIDENT_SUFFIX = "repeated-tool-loop"
logger = logging.getLogger(__name__)


def _admitted(method):
    """Serialize command admission with suspension while leaving the event pump independent."""

    @wraps(method)
    async def guarded(self, *args, **kwargs):
        async with self._admission_lock:
            receipt = self._suspend_receipt
            if receipt is not None and receipt.state is not SuspendState.ABORTED:
                raise AppServerError(RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY)
            self._active_operations += 1
            self._activity_revision += 1
        try:
            return await method(self, *args, **kwargs)
        finally:
            self._active_operations -= 1
            self._activity_revision += 1

    return guarded


def _same_model_connection(current: ModelIntent, requested: ModelIntent) -> bool:
    left = current.transport
    right = requested.transport
    return (
        left.mode is right.mode
        and left.endpoint.rstrip("/") == right.endpoint.rstrip("/")
        and left.wire_protocol is right.wire_protocol
        and left.supports_websockets == right.supports_websockets
    )


def _same_thread_preferences(current: ModelIntent, requested: ModelIntent) -> bool:
    return (
        current.model_ref == requested.model_ref
        and current.capabilities == requested.capabilities
        and current.reasoning_effort == requested.reasoning_effort
        and current.service_tier == requested.service_tier
        # ``model_context_window`` is written into the thread config at start; the
        # per-turn overrides do not carry it. Comparing it here is what turns a
        # changed declaration into RESTART_REQUIRED instead of a stale in-place apply.
        and current.context_window == requested.context_window
        # Same reason for the non-effort thinking forms: the bridge registration is
        # built once per connection, so a changed toggle/budget must not look applied.
        and current.thinking == requested.thinking
        and current.approval_model_ref == requested.approval_model_ref
    )


def _same_process_configuration(
    current: CodexSessionOpenRequest, requested: CodexSessionOpenRequest
) -> bool:
    return (
        current.executable == requested.executable
        and current.identity == requested.identity
        and current.cwd == requested.cwd
        and current.launch_cwd == requested.launch_cwd
        and current.execution_scope == requested.execution_scope
        and current.process_sharing_scope == requested.process_sharing_scope
        and current.process_environment == requested.process_environment
        and current.remove_environment == requested.remove_environment
        and current.launch_arguments == requested.launch_arguments
        and current.model_provider == requested.model_provider
        and current.sandbox == requested.sandbox
        and current.permissions_profile == requested.permissions_profile
        and current.approval_policy == requested.approval_policy
        and current.approval_reviewer == requested.approval_reviewer
        and current.multi_agent_mode == requested.multi_agent_mode
        and current.base_instructions == requested.base_instructions
        and current.developer_instructions == requested.developer_instructions
        and current.dynamic_tools == requested.dynamic_tools
        and current.skill_roots == requested.skill_roots
        and current.skill_policy == requested.skill_policy
        and current.writable_roots == requested.writable_roots
        and current.network_access == requested.network_access
    )


def capability_resolution(model: ModelIntent, effective_window: int) -> dict[str, Any] | None:
    """Compare the window we declared with the window the runtime reports as live.

    Codex 会把自己配置里的 ``model_context_window`` 夹到它认得的上限，声明因此可能被静默
    削平；不比对，产品面和 trace 都看不见（proposal 78 §6 步骤 5）。生效值来自
    ``thread/tokenUsage/updated`` 的 ``modelContextWindow``，没回报过时返回 ``None`` ——
    拿 0 当生效值会把「还没上报」误判成「被削到 0」。
    """

    if effective_window <= 0:
        return None
    declared = model.context_window
    return {
        "wire_model": model.model_ref,
        "declared_context_window": declared,
        "effective_context_window": effective_window,
        "clamped": declared is not None and declared != effective_window,
    }


def _page_limit(value: RuntimeValue) -> int:
    if value is None:
        return McpListRequest().limit
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("MCP page limit must be a positive integer")
    return value


def _input_item(value: RuntimeValue) -> InputItem:
    if isinstance(value, str):
        return InputItem(InputKind.TEXT, text=value)
    if not isinstance(value, dict):
        raise ValueError("turn input must be a string or typed object")
    kind = InputKind(str(value.get("kind") or InputKind.TEXT.value))
    raw_path = str(value.get("path") or "")
    return InputItem(
        kind,
        text=str(value.get("text") or ""),
        path=Path(raw_path) if raw_path else None,
        name=str(value.get("name") or ""),
    )


class CodexRuntimeSession:
    """One typed runtime session and its normalized event stream."""

    def __init__(
        self,
        request: OpenSessionRequest,
        resume_binding: RuntimeBinding | None = None,
        launch_environment: Mapping[str, str] | None = None,
        tool_environment: Mapping[str, str] | None = None,
        host_pool: CodexHostPool | None = None,
    ) -> None:
        self._host_pool = host_pool or CodexHostPool()
        self._owns_pool = host_pool is None
        self._tool_environment = dict(tool_environment or {})
        managed_shell_environment(
            self._tool_environment, execution_environment=request.execution_environment
        )
        self._model_prepared = False
        self._admission_lock = asyncio.Lock()
        self._interrupt_lock = asyncio.Lock()
        self._active_operations = 0
        self._activity_revision = 0
        self._watermark = 0
        self._suspend_receipt: SuspendReceipt | None = None
        self._confirmation_ticket: TurnConfirmationTicket | None = None
        self._confirmation_receipt: TurnConfirmationReceipt | None = None
        self._confirmation_host: object | None = None
        self._confirmation_registration_epoch = 0
        self._confirmation_admission_epoch = 0
        self._replacement_ticket: ThreadReplacementTicket | None = None
        self._replacement_receipt: ThreadReplacementReceipt | None = None
        self._replacement_host: object | None = None
        self._replacement_registration_epoch = 0
        self._replacement_admission_epoch = 0
        self._suspend_task: asyncio.Task[None] | None = None
        self._suspend_generation: int | None = None
        self._released_evidence: ResourceEvidence | None = None
        self._request = replace(request, secret_port=None)
        fork = request.fork_source
        if fork is not None and (
            resume_binding is not None
            or fork.product_session_id != request.product_session_id
            or fork.source.runtime_id != CODEX_RUNTIME_ID
            or not fork.source.opaque_session_ref
            or not fork.source_turn_id
            or request.initial_history
        ):
            raise ValueError("invalid Codex fork source")
        self._required_capabilities = required_capabilities(request.required_capabilities)
        self._optional_capabilities = optional_capabilities(
            request.optional_capabilities, self._required_capabilities
        )
        self._enabled_capabilities = self._required_capabilities
        self._events = ObservationMailbox()
        self._tasks: set[asyncio.Task[Any]] = set()
        self._sequence = 0
        self._evidence_sequence = 0
        self._event_namespace = uuid.uuid4().hex
        self._seen_subagents: set[str] = set()
        # 上一次播报过的「声明窗口 / 生效窗口」比对；tokenUsage 每轮到，比对没变就不重复发事件。
        self._capability_resolution: dict[str, Any] | None = None
        self._active_command_id = ""
        self._committed_commands: set[str] = set()
        self._loop_guard = ToolLoopGuard()
        executable = configured_codex_executable()
        validate_model_connection(request.model)
        runtime_home = self._host_pool.prepare_home()
        permission_policy = CODEX_PERMISSION_POLICIES[request.permission.mode]
        permissions_profile, self._permission_config = thread_permission_config(
            permission_policy.sandbox,
            request.permission.local_sockets,
            network_access=request.permission.network_access,
            network_domains=request.permission.network_domains,
            deny_read_roots=request.permission.deny_read_roots,
        )
        launch_arguments = windows_sandbox_arguments(CODEX_DEFAULT_SANDBOX_MODE)
        process_environment, launch_arguments = managed_codex_launch(
            runtime_home,
            dict(launch_environment or {}),
            launch_arguments,
        )
        self._native = CodexThreadSession(
            CodexSessionOpenRequest(
                request_id=request.product_session_id,
                runtime_id=CODEX_RUNTIME_ID,
                cwd=request.cwd,
                launch_cwd=runtime_home / CODEX_DISCOVERY_HOME_DIRNAME,
                execution_scope=request.execution_scope or request.product_session_id,
                process_sharing_scope=request.process_sharing_scope,
                resume_session_id=(
                    resume_binding.opaque_session_ref if resume_binding is not None else ""
                ),
                fork_session_id=fork.source.opaque_session_ref if fork is not None else "",
                fork_turn_id=fork.source_turn_id if fork is not None else "",
                model=request.model.model_ref,
                process_environment=process_environment,
                remove_environment=request.launch_secrets.remove_environment,
                sandbox=permission_policy.sandbox,
                permissions_profile=permissions_profile,
                launch_arguments=launch_arguments,
                approval_policy=permission_policy.approval_policy,
                approval_reviewer=permission_policy.approval_reviewer,
                multi_agent_mode=DEFAULT_COLLABORATION_MODE,
                executable=executable,
                identity=CODEX_MANAGED_IDENTITY,
                developer_instructions=request.developer_instructions,
                dynamic_tools=tuple(
                    CodexDynamicTool(
                        name=tool.name,
                        description=tool.description,
                        input_schema=(
                            tool.input_schema if isinstance(tool.input_schema, Mapping) else {}
                        ),
                    )
                    for tool in request.service_tools
                ),
                base_instructions=request.base_instructions,
                ephemeral=request.ephemeral,
                skill_policy=request.skill_policy,
                skill_roots=request.skill_roots,
                writable_roots=request.permission.writable_roots,
                network_access=request.permission.network_access,
                timing=request.timing,
            ),
            on_event=self._on_native_event,
            host_pool=self._host_pool,
        )
        self._native_base_request = self._native.request
        self._binding: RuntimeBinding | None = None
        self._permission = request.permission
        self._model = request.model
        self._skill_configurations = request.skill_configurations

    async def prepare_resource(self, request_id: str, deadline: float) -> PoolReservation:
        if not self._model_prepared:
            await self._apply_model_connection()
            self._model_prepared = True
        return await self._host_pool.reserve(
            self._native.request,
            role=HostRole.EXECUTION,
            request_id=request_id,
            deadline=deadline,
        )

    @property
    def resource_evidence(self) -> ResourceEvidence | None:
        lease = self._native.lease
        return lease.evidence if lease is not None else self._released_evidence

    def _current_activity_revision(self) -> int:
        return self._activity_revision + self._native.host.thread_activity_revision(
            self._native.session_id
        )

    async def consume_resource(self, reservation: PoolReservation) -> None:
        self._native.adopt_lease(await self._host_pool.consume(reservation))

    async def _publish_observation(
        self, observation: RuntimeEvent | RuntimeCallbackRequest
    ) -> None:
        async def accept() -> None:
            await self._events.put(observation)
            if isinstance(observation, RuntimeEvent):
                self._watermark = observation.sequence

        # Cancellation may arrive during a spill. Finish admission and its
        # watermark together before propagating it to the producer.
        await ObservationMailbox._finish(asyncio.create_task(accept()))

    async def activity(self) -> RuntimeActivitySnapshot:
        generation = f"{self._event_namespace}:{self._native.host.process_generation}"
        blockers = list(self._native.host.suspend_blockers(self._native.session_id))
        if self._active_command_id or any(not task.done() for task in self._tasks):
            blockers.append(ACTIVITY_COMMAND_PENDING)
        if self._active_operations:
            blockers.append(ACTIVITY_OPERATION_PENDING)
        if self._events.qsize():
            blockers.append(RUNTIME_OBSERVATION_PENDING)
        revision = self._current_activity_revision()
        native = await NativeActivity(
            self._native.host,
            self._native.session_id,
            known_roots=self._native.host.known_roots,
        ).inspect()
        if native.complete:
            self._native.host.retain_loaded_roots(native.loaded_thread_ids)
        blockers.extend(native.blockers)
        if revision != self._current_activity_revision():
            blockers.append(RUNTIME_ACTIVITY_CHANGED)
        if generation != f"{self._event_namespace}:{self._native.host.process_generation}":
            blockers.append(RUNTIME_ACTIVITY_CHANGED)
        return RuntimeActivitySnapshot(
            generation,
            self._current_activity_revision(),
            self._watermark,
            native.complete,
            tuple(blockers),
            execution_tree_complete=native.complete and RUNTIME_ACTIVITY_CHANGED not in blockers,
            execution_tree_blockers=native.execution_tree_blockers,
        )

    def _confirmation_idle(self) -> bool:
        return (
            self._suspend_receipt is None
            and not self._active_command_id
            and not self._active_operations
            and not any(not task.done() for task in self._tasks)
        )

    def _confirmation_current(self, ticket: TurnConfirmationTicket) -> bool:
        host = self._native.host
        target = ticket.target
        return (
            self._confirmation_idle()
            and host is self._confirmation_host
            and self._confirmation_ticket == ticket
            and target.product_session_id == self.binding.product_session_id
            and target.native_session_id == self._native.session_id
            and ticket.generation == f"{self._event_namespace}:{host.process_generation}"
            and ticket.revision == self._current_activity_revision()
            and ticket.watermark == self._watermark
            and self._confirmation_admission_epoch == host.admission.epoch
            and host.turn_confirmation_current(
                target.native_session_id,
                target.client_submission_id,
                target.incident_id,
                target.process_generation,
                host.process_generation,
                self._confirmation_registration_epoch,
                host.thread_activity_revision(target.native_session_id),
            )
        )

    async def prepare_turn_confirmation(
        self, target: TurnConfirmationTarget
    ) -> TurnConfirmationTicket:
        async with self._admission_lock:
            receipt = self._confirmation_receipt
            if receipt is not None and receipt.ticket.target == target:
                return receipt.ticket
            if not self._confirmation_idle():
                raise AppServerError(
                    RUNTIME_CONFIRMATION_BUSY, safe_error=RUNTIME_CONFIRMATION_BUSY
                )
            host = self._native.host
            generation, registration_epoch, _revision = host.turn_confirmation_identity(
                target.native_session_id
            )
            ticket = TurnConfirmationTicket(
                uuid.uuid4().hex,
                target,
                f"{self._event_namespace}:{generation}",
                self._current_activity_revision(),
                self._watermark,
            )
            self._confirmation_ticket = ticket
            self._confirmation_host = host
            self._confirmation_registration_epoch = registration_epoch
            self._confirmation_admission_epoch = host.admission.epoch
            if not self._confirmation_current(ticket):
                raise AppServerError(
                    RUNTIME_CONFIRMATION_STALE, safe_error=RUNTIME_CONFIRMATION_STALE
                )
            native = await NativeActivity(
                host, target.native_session_id, known_roots=host.known_roots
            ).inspect()
            if not native.complete or native.blockers or not self._confirmation_current(ticket):
                raise AppServerError(
                    RUNTIME_CONFIRMATION_BUSY, safe_error=RUNTIME_CONFIRMATION_BUSY
                )
            return ticket

    async def commit_turn_confirmation(
        self, ticket: TurnConfirmationTicket, persisted_watermark: int
    ) -> TurnConfirmationReceipt:
        async with self._admission_lock:
            receipt = self._confirmation_receipt
            if receipt is not None and receipt.ticket == ticket:
                return receipt
            if persisted_watermark < ticket.watermark:
                return TurnConfirmationReceipt(
                    ticket, CommandState.REJECTED, RUNTIME_CONFIRMATION_UNPERSISTED
                )
            if not self._confirmation_current(ticket):
                return TurnConfirmationReceipt(
                    ticket, CommandState.REJECTED, RUNTIME_CONFIRMATION_STALE
                )
            host = self._native.host
            target = ticket.target
            if not host.confirm_turn_submission(
                target.native_session_id,
                target.client_submission_id,
                target.incident_id,
                target.process_generation,
                host.process_generation,
                self._confirmation_registration_epoch,
                host.thread_activity_revision(target.native_session_id),
            ):
                return TurnConfirmationReceipt(
                    ticket, CommandState.REJECTED, RUNTIME_CONFIRMATION_STALE
                )
            receipt = TurnConfirmationReceipt(ticket, CommandState.APPLIED)
            self._confirmation_receipt = receipt
            return receipt

    def _replacement_current(self, ticket: ThreadReplacementTicket) -> bool:
        host = self._native.host
        proof = ticket.proof
        return (
            self._confirmation_idle()
            and host is self._replacement_host
            and self._replacement_ticket == ticket
            and proof.binding == self.binding
            and proof.binding.opaque_session_ref == self._native.session_id
            and ticket.generation == f"{self._event_namespace}:{host.process_generation}"
            and ticket.revision == self._current_activity_revision()
            and proof.watermark == ticket.watermark == self._watermark
            and self._replacement_admission_epoch == host.admission.epoch
            and host.thread_replacement_current(
                self._native.session_id,
                proof.command_id,
                proof.incident_id,
                proof.failed_generation,
                proof.absence_generation,
                self._replacement_registration_epoch,
                host.thread_activity_revision(self._native.session_id),
            )
        )

    async def prepare_thread_replacement(
        self, target: ThreadReplacementTarget
    ) -> ThreadReplacementTicket:
        async with self._admission_lock:
            receipt = self._replacement_receipt
            if receipt is not None:
                previous = receipt.ticket.proof
                if target == ThreadReplacementTarget(
                    previous.binding,
                    previous.command_id,
                    previous.incident_id,
                    previous.failed_generation,
                ):
                    return receipt.ticket
            if (
                target.binding != self.binding
                or not isinstance(target.command_id, str)
                or not target.command_id.strip()
                or not isinstance(target.incident_id, str)
                or not target.incident_id.strip()
            ):
                raise AppServerError(
                    RUNTIME_THREAD_REPLACEMENT_STALE, safe_error=RUNTIME_THREAD_REPLACEMENT_STALE
                )
            host = self._native.host
            try:
                async with asyncio.timeout(host.recovery_total_timeout):
                    recovery = host.recovery_task
                    if recovery is not None and not recovery.done():
                        await host.start()
                    if self._native.host is not host:
                        raise AppServerError(
                            RUNTIME_THREAD_REPLACEMENT_STALE,
                            safe_error=RUNTIME_THREAD_REPLACEMENT_STALE,
                        )
                    if (
                        self._suspend_receipt is not None
                        or self._active_operations
                        or self._active_command_id not in ("", target.command_id)
                    ):
                        raise AppServerError(
                            RUNTIME_THREAD_REPLACEMENT_BUSY,
                            safe_error=RUNTIME_THREAD_REPLACEMENT_BUSY,
                        )
                    pending = tuple(task for task in self._tasks if not task.done())
                    if pending:
                        generation, registration_epoch, revision = host.turn_confirmation_identity(
                            self._native.session_id
                        )
                        if not host.thread_replacement_current(
                            self._native.session_id,
                            target.command_id,
                            target.incident_id,
                            target.failed_generation,
                            generation,
                            registration_epoch,
                            revision,
                        ):
                            raise AppServerError(
                                RUNTIME_THREAD_REPLACEMENT_BUSY,
                                safe_error=RUNTIME_THREAD_REPLACEMENT_BUSY,
                            )
                        await asyncio.shield(asyncio.gather(*pending, return_exceptions=True))
                    if not self._confirmation_idle():
                        raise AppServerError(
                            RUNTIME_THREAD_REPLACEMENT_BUSY,
                            safe_error=RUNTIME_THREAD_REPLACEMENT_BUSY,
                        )
                    return await self._prepare_thread_replacement_ticket(target)
            except TimeoutError as error:
                raise AppServerError(
                    RUNTIME_THREAD_REPLACEMENT_BUSY, safe_error=RUNTIME_THREAD_REPLACEMENT_BUSY
                ) from error

    async def _prepare_thread_replacement_ticket(
        self, target: ThreadReplacementTarget
    ) -> ThreadReplacementTicket:
        host = self._native.host
        generation, registration_epoch, _revision = host.turn_confirmation_identity(
            self._native.session_id
        )
        self._replacement_host = host
        self._replacement_registration_epoch = registration_epoch
        self._replacement_admission_epoch = host.admission.epoch
        for _attempt in range(host.max_recovery_attempts):
            if (
                self._native.host is not host
                or host.process_generation != generation
                or host.admission.epoch != self._replacement_admission_epoch
            ):
                raise AppServerError(
                    RUNTIME_THREAD_REPLACEMENT_STALE, safe_error=RUNTIME_THREAD_REPLACEMENT_STALE
                )
            proof = ThreadReplacementProof(
                uuid.uuid4().hex,
                self.binding,
                target.command_id,
                target.incident_id,
                target.failed_generation,
                generation,
                self._watermark,
            )
            ticket = ThreadReplacementTicket(
                proof,
                f"{self._event_namespace}:{generation}",
                self._current_activity_revision(),
                self._watermark,
            )
            self._replacement_ticket = ticket
            if not self._replacement_current(ticket):
                raise AppServerError(
                    RUNTIME_THREAD_REPLACEMENT_STALE, safe_error=RUNTIME_THREAD_REPLACEMENT_STALE
                )
            native = await NativeActivity(
                host, self._native.session_id, known_roots=host.known_roots
            ).inspect_absence()
            if (
                not native.complete
                or native.blockers
                or native.execution_tree_blockers
                or native.process_generation != generation
                or self._native.session_id in native.loaded_thread_ids
            ):
                raise AppServerError(
                    RUNTIME_THREAD_REPLACEMENT_BUSY, safe_error=RUNTIME_THREAD_REPLACEMENT_BUSY
                )
            if self._replacement_current(ticket):
                return ticket
        raise AppServerError(
            RUNTIME_THREAD_REPLACEMENT_BUSY, safe_error=RUNTIME_THREAD_REPLACEMENT_BUSY
        )

    async def commit_thread_replacement(
        self, ticket: ThreadReplacementTicket, persisted_watermark: int
    ) -> ThreadReplacementReceipt:
        async with self._admission_lock:
            receipt = self._replacement_receipt
            if receipt is not None and receipt.ticket == ticket:
                return receipt
            if persisted_watermark < ticket.watermark:
                return ThreadReplacementReceipt(
                    ticket, CommandState.REJECTED, RUNTIME_THREAD_REPLACEMENT_UNPERSISTED
                )
            if not self._replacement_current(ticket):
                return ThreadReplacementReceipt(
                    ticket, CommandState.REJECTED, RUNTIME_THREAD_REPLACEMENT_STALE
                )
            host = self._native.host
            proof = ticket.proof
            if not host.seal_thread_replacement(
                self._native.session_id,
                proof.command_id,
                proof.incident_id,
                proof.failed_generation,
                proof.absence_generation,
                self._replacement_registration_epoch,
                host.thread_activity_revision(self._native.session_id),
            ):
                return ThreadReplacementReceipt(
                    ticket, CommandState.REJECTED, RUNTIME_THREAD_REPLACEMENT_STALE
                )
            receipt = ThreadReplacementReceipt(ticket, CommandState.APPLIED)
            self._replacement_receipt = receipt
            return receipt

    async def prepare_suspend(self, expected_revision: int) -> SuspendTicket:
        async with self._admission_lock:
            if (
                self._suspend_receipt is not None
                and self._suspend_receipt.state is not SuspendState.ABORTED
            ):
                raise AppServerError(RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY)
            snapshot = await self.activity()
            if snapshot.revision != expected_revision:
                raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
            if not snapshot.idle:
                code = RUNTIME_SUSPEND_BUSY if snapshot.blockers else RUNTIME_SUSPEND_UNSUPPORTED
                raise AppServerError(code, safe_error=code)
            ticket = SuspendTicket(
                uuid.uuid4().hex, snapshot.generation, snapshot.revision, snapshot.watermark
            )
            self._suspend_receipt = SuspendReceipt(ticket, SuspendState.PREPARED)
            return ticket

    def _check_ticket(self, ticket: SuspendTicket) -> SuspendReceipt:
        receipt = self._suspend_receipt
        if receipt is None or receipt.ticket != ticket:
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        return receipt

    async def commit_suspend(
        self, ticket: SuspendTicket, persisted_watermark: int
    ) -> SuspendReceipt:
        async with self._admission_lock:
            receipt = self._check_ticket(ticket)
            if receipt.state is SuspendState.RELEASED:
                return receipt
            if receipt.state is SuspendState.ABORTED:
                raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
            if persisted_watermark < ticket.watermark:
                raise AppServerError(
                    RUNTIME_SUSPEND_UNPERSISTED, safe_error=RUNTIME_SUSPEND_UNPERSISTED
                )
            if receipt.finished and receipt.safe_error:
                generation = self._suspend_generation
                if generation is None or generation != self._native.host.process_generation:
                    raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
                self._suspend_receipt = SuspendReceipt(ticket, SuspendState.COMMITTING)
                self._suspend_task = asyncio.create_task(
                    self._commit_release(ticket, generation, retry=True)
                )
            if self._suspend_task is None:
                snapshot = await self.activity()
                if (
                    not snapshot.idle
                    or snapshot.generation != ticket.generation
                    or snapshot.revision != ticket.revision
                ):
                    raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
                if persisted_watermark < ticket.watermark:
                    raise AppServerError(
                        RUNTIME_SUSPEND_UNPERSISTED, safe_error=RUNTIME_SUSPEND_UNPERSISTED
                    )
                self._suspend_receipt = SuspendReceipt(ticket, SuspendState.COMMITTING)
                generation = self._native.host.process_generation
                self._suspend_generation = generation
                self._suspend_task = asyncio.create_task(self._commit_release(ticket, generation))
            task = self._suspend_task
        await asyncio.shield(task)
        return self._check_ticket(ticket)

    async def _commit_release(
        self, ticket: SuspendTicket, generation: int, *, retry: bool = False
    ) -> None:
        lease = self._native.lease
        try:
            await self._native.suspend(generation, retry=retry)
        except BaseException:
            # The command gate stays closed: unsubscribe/EOF may already have committed.
            self._suspend_receipt = SuspendReceipt(
                ticket, SuspendState.COMMITTING, RUNTIME_SUSPEND_FAILED, finished=True
            )
            raise
        self._released_evidence = lease.evidence if lease is not None else None
        self._suspend_receipt = SuspendReceipt(ticket, SuspendState.RELEASED, finished=True)

    async def abort_suspend(self, ticket: SuspendTicket) -> SuspendReceipt:
        async with self._admission_lock:
            receipt = self._check_ticket(ticket)
            if receipt.state is SuspendState.PREPARED:
                self._suspend_receipt = SuspendReceipt(ticket, SuspendState.ABORTED, finished=True)
                self._suspend_task = None
            return self._check_ticket(ticket)

    async def suspend_status(self, ticket: SuspendTicket) -> SuspendReceipt:
        return self._check_ticket(ticket)

    async def open(self) -> None:
        try:
            if not self._model_prepared:
                await self._apply_model_connection()
                self._model_prepared = True
            await self._verify_required_capabilities()
            stage = (
                CodexActivationStage.SESSION_RESUME
                if self._native.request.resume_session_id
                else CodexActivationStage.SESSION_OPEN
            )
            with self._request.timing.measure(stage):
                await self._native.open()
            if self._request.fork_source is not None:
                self._native.request = replace(
                    self._native.request, fork_session_id="", fork_turn_id=""
                )
                self._native_base_request = replace(
                    self._native_base_request, fork_session_id="", fork_turn_id=""
                )
                self._request = replace(self._request, fork_source=None)
            if self._request.initial_history:
                await self._native.host.seed_history(
                    self._native.session_id, self._request.initial_history
                )
        except BaseException:
            try:
                await self._native.aclose()
            finally:
                if self._owns_pool:
                    await self._host_pool.aclose()
            raise
        readiness = self._native.host.readiness
        self._binding = RuntimeBinding(
            product_session_id=self._request.product_session_id,
            runtime_id=CODEX_RUNTIME_ID,
            adapter_version=version("scholarseed-codex"),
            runtime_version=readiness.version,
            protocol_version=CODEX_PROTOCOL_VERSION,
            protocol_schema_hash=CODEX_PROTOCOL_SCHEMA_HASH,
            opaque_session_ref=self._native.session_id,
            skill_policy=self._request.skill_policy,
            capabilities=self.capabilities,
            profile=service_tool_profile(self._request.service_tools),
            optional_capabilities=self._request.optional_capabilities,
        )

    async def _verify_required_capabilities(self) -> None:
        requested = self._required_capabilities | self._optional_capabilities
        if RuntimeCapabilityName.WEB_SEARCH not in requested:
            return
        supported = native_web_search_supported(self._request.model)
        if supported:
            provider_capabilities = await self._native.model_provider_capabilities()
            supported = provider_capabilities.get(CODEX_WEB_SEARCH_CAPABILITY_KEY) is True
        if not supported and RuntimeCapabilityName.WEB_SEARCH in self._required_capabilities:
            raise AppServerError(
                "The selected model provider cannot forward native Web Search",
                safe_error=CODEX_WEB_SEARCH_CAPABILITY_ERROR,
            )
        if RuntimeCapabilityName.WEB_SEARCH in self._optional_capabilities:
            self._enabled_capabilities = self._required_capabilities | (
                {RuntimeCapabilityName.WEB_SEARCH} if supported else set()
            )
            config = dict(self._native.request.thread_config)
            config[CODEX_WEB_SEARCH_MODE_KEY] = (
                CODEX_WEB_SEARCH_LIVE_MODE if supported else CODEX_WEB_SEARCH_DISABLED_MODE
            )
            self._native.request = replace(self._native.request, thread_config=config)

    async def _apply_model_connection(self) -> None:
        self._native.request = await self._project_model_connection(
            self._request.model, self._request.credential_port
        )

    async def _project_model_connection(
        self, intent: ModelIntent, credential_port: ModelCredentialPort | None
    ) -> CodexSessionOpenRequest:
        request = replace(
            await self._configure_model_connection(
                intent, self._native_base_request, credential_port
            ),
            model=intent.model_ref,
        )
        with self._request.timing.measure(CodexActivationStage.MODEL_CATALOG):
            catalog_argument = await self._host_pool.model_catalog_argument(intent, request)
        return replace(request, launch_arguments=(*request.launch_arguments, catalog_argument))

    async def _configure_model_connection(
        self,
        intent: ModelIntent,
        request: CodexSessionOpenRequest,
        credential_port: ModelCredentialPort | None,
    ) -> CodexSessionOpenRequest:
        await self._host_pool.require_skill_policy(self._request.skill_policy, request.executable)
        config = session_thread_config(
            self._enabled_capabilities,
            frozenset(tool.name for tool in self._request.service_tools),
        )
        if not native_web_search_supported(intent):
            config[CODEX_WEB_SEARCH_MODE_KEY] = CODEX_WEB_SEARCH_DISABLED_MODE
        if intent.capabilities.native_agent_messages is False:
            config[CODEX_MULTI_AGENT_V2_ENABLED_CONFIG] = False
        config.update(session_skill_config(self._skill_configurations))
        config.update(self._permission_config)
        config.update(
            managed_shell_environment(
                self._tool_environment,
                execution_environment=self._request.execution_environment,
            )
        )
        if intent.reasoning_effort:
            config[CODEX_REASONING_EFFORT_CONFIG] = intent.reasoning_effort
        if intent.service_tier:
            config[CODEX_SERVICE_TIER_CONFIG] = intent.service_tier
        if intent.capabilities.tool_protocol is ModelToolProtocol.PROVIDER_NATIVE:
            config[CODEX_REASONING_SUMMARY_CONFIG] = CODEX_REASONING_SUMMARY_AUTO
        return await model_connection(
            intent,
            replace(request, thread_config=config),
            credential_port,
            timing=self._request.timing,
        )

    @property
    def binding(self) -> RuntimeBinding:
        if self._binding is None:
            raise RuntimeError("Codex runtime session is not open")
        return self._binding

    @property
    def capabilities(self) -> CapabilitySet:
        enabled = self._enabled_capabilities & SESSION_SCOPED_CAPABILITIES
        if not native_web_search_supported(self._request.model):
            enabled = enabled - {RuntimeCapabilityName.WEB_SEARCH}
        return capabilities(enabled)

    async def _on_native_event(self, event: CodexSessionEvent) -> None:
        self._activity_revision += 1
        await self._observe_evidence(event)
        process_exit_unknown = (
            event.kind is CodexSessionEventKind.TURN_UNKNOWN
            and event.incident is not None
            and event.incident.kind is RuntimeIncidentKind.PROCESS_EXIT
        )
        client_id = event.payload.get("client_user_message_id") or (
            "" if process_exit_unknown else event.turn_id
        )
        owns_unknown_command = (
            event.kind is CodexSessionEventKind.TURN_UNKNOWN
            and self._binding is not None
            and event.session_id == self._binding.opaque_session_ref
            and bool(self._active_command_id)
            and client_id == self._active_command_id
        )
        if (
            event.kind is CodexSessionEventKind.TURN_STARTED or owns_unknown_command
        ) and self._active_command_id:
            self._committed_commands.add(self._active_command_id)
        if event.kind is CodexSessionEventKind.DYNAMIC_TOOL_REQUESTED:
            tool_name = str(event.payload.get("tool") or "")
            declared_tools = {tool.name for tool in self._request.service_tools}
            if tool_name not in declared_tools:
                logger.warning(
                    "codex_dynamic_tool_undeclared session_id=%s tool=%s namespace=%s declared=%s",
                    event.session_id,
                    tool_name,
                    str(event.payload.get("namespace") or ""),
                    sorted(declared_tools),
                )
                await self._native.resolve_tool(
                    str(event.payload.get("request_id") or ""),
                    CodexToolResponse(
                        success=False,
                        content_items=(
                            {"type": "inputText", "text": "runtime_service_tool_unknown"},
                        ),
                    ),
                )
                return
        parsed = None
        if event.kind is CodexSessionEventKind.ASSISTANT_COMPLETED:
            parsed = parse_declarations(
                str(event.payload.get("text") or ""),
                self._request.artifact_directives,
                message_identity=f"{event.session_id}\0{event.turn_id}\0{event.item_id}",
            )
            event = replace(event, payload={**event.payload, "text": parsed.text})
        self._sequence += 1
        normalized = translate_event(
            event,
            product_session_id=self._request.product_session_id,
            process_generation=self._native.host.readiness.process_generation,
            sequence=self._sequence,
        )
        if isinstance(normalized, RuntimeEvent) and not normalized.correlation_id:
            normalized = replace(normalized, correlation_id=self._active_command_id)
        if isinstance(normalized, RuntimeEvent) and normalized.kind in SUBAGENT_LIFECYCLE_KINDS:
            actor_id = normalized.actor_id
            if actor_id not in self._seen_subagents:
                self._seen_subagents.add(actor_id)
                self._sequence += 1
                spawned_payload = (
                    {**normalized.payload, "status": RuntimeEventKind.SUBAGENT_SPAWNED.value}
                    if isinstance(normalized.payload, dict)
                    else normalized.payload
                )
                await self._publish_observation(
                    replace(
                        normalized,
                        event_id=self._event_id(event.session_id, suffix="spawned"),
                        sequence=self._sequence,
                        kind=RuntimeEventKind.SUBAGENT_SPAWNED,
                        payload=spawned_payload,
                    )
                )
                self._sequence += 1
                normalized = replace(normalized, sequence=self._sequence)
        if isinstance(normalized, RuntimeEvent):
            normalized = replace(normalized, event_id=self._event_id(event.session_id))
        await self._publish_observation(normalized)
        if self._loop_guard.observe(event):
            await self._publish_loop_incident(event, REPEATED_TOOL_LOOP_ERROR)
            task = asyncio.create_task(self._interrupt_loop(event))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        if parsed is not None and isinstance(normalized, RuntimeEvent):
            declarations = (
                (RuntimeEventKind.ARTIFACT_DECLARED, asdict(item)) for item in parsed.declarations
            )
            failures = (
                (RuntimeEventKind.ARTIFACT_DECLARATION_FAILED, asdict(item))
                for item in parsed.failures
            )
            for kind, payload in (*declarations, *failures):
                self._sequence += 1
                await self._publish_observation(
                    replace(
                        normalized,
                        kind=kind,
                        sequence=self._sequence,
                        event_id=self._event_id(event.session_id),
                        causation_id=normalized.event_id,
                        payload=json_value(payload),
                    )
                )
        if (
            isinstance(normalized, RuntimeEvent)
            and normalized.kind is RuntimeEventKind.USAGE_UPDATED
        ):
            await self._publish_capability_resolution(event, normalized)
        if event.kind in {
            CodexSessionEventKind.TURN_COMPLETED,
            CodexSessionEventKind.TURN_FAILED,
            CodexSessionEventKind.TURN_INTERRUPTED,
        } or (
            process_exit_unknown and owns_unknown_command and client_id == self._active_command_id
        ):
            self._committed_commands.discard(self._active_command_id)
            self._active_command_id = ""

    async def _publish_loop_incident(self, event: CodexSessionEvent, safe_error: str) -> None:
        self._sequence += 1
        failed = safe_error == REPEATED_TOOL_INTERRUPT_ERROR
        await self._publish_observation(
            RuntimeEvent(
                schema_version=RUNTIME_EVENT_SCHEMA_VERSION,
                event_id=self._event_id(event.session_id),
                runtime_id=CODEX_RUNTIME_ID,
                product_session_id=self._request.product_session_id,
                native_session_id=event.session_id,
                native_turn_id=event.turn_id,
                process_generation=self._native.host.readiness.process_generation,
                sequence=self._sequence,
                kind=RuntimeEventKind.RUNTIME_INCIDENT,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at=datetime.now(UTC).isoformat(),
                correlation_id=self._active_command_id,
                payload={
                    "incident": {
                        "incident_id": (
                            f"{event.session_id}:{event.turn_id}:{REPEATED_TOOL_INCIDENT_SUFFIX}"
                        ),
                        "scope": RuntimeIncidentScope.TURN.value,
                        "state": (
                            RuntimeIncidentState.FAILED.value
                            if failed
                            else RuntimeIncidentState.DETECTED.value
                        ),
                        "kind": RuntimeIncidentKind.REPEATED_TOOL_LOOP.value,
                        "strategy": RuntimeRecoveryStrategy.MANUAL_RETRY.value,
                        "retryability": RuntimeRetryability.USER_RETRYABLE.value,
                        "safe_error": safe_error,
                        "process_generation": self._native.host.readiness.process_generation,
                        "attempt": 0,
                        "max_attempts": 0,
                        "native_session_id": event.session_id,
                        "native_turn_id": event.turn_id,
                    }
                },
            )
        )

    async def _interrupt_loop(self, event: CodexSessionEvent) -> None:
        try:
            await self._native.host.attachment(self._native.session_id).turn.interrupt()
        except Exception:
            logger.exception("codex_repeated_tool_interrupt_failed turn_id=%s", event.turn_id)
            if self._native.active_turn_id == event.turn_id:
                await self._publish_loop_incident(event, REPEATED_TOOL_INTERRUPT_ERROR)

    async def _publish_capability_resolution(
        self, event: CodexSessionEvent, source: RuntimeEvent
    ) -> None:
        """播报一次「声明窗口 vs 生效窗口」的比对；tokenUsage 每轮到，比对没变就不重发。"""

        resolution = capability_resolution(self._model, self._native.context_window)
        if resolution is None or resolution == self._capability_resolution:
            return
        self._capability_resolution = resolution
        self._sequence += 1
        await self._publish_observation(
            replace(
                source,
                kind=RuntimeEventKind.MODEL_CAPABILITY_RESOLUTION,
                sequence=self._sequence,
                event_id=self._event_id(event.session_id, suffix="capability"),
                causation_id=source.event_id,
                payload=json_value(resolution),
            )
        )

    async def _observe_evidence(self, event: CodexSessionEvent) -> None:
        process = tuple(
            row for row in self._native.process_events if row.evidence_seq > self._evidence_sequence
        )
        rpc = tuple(
            row for row in self._native.rpc_evidence if row.evidence_seq > self._evidence_sequence
        )
        if not process and not rpc:
            return
        self._evidence_sequence = max(
            [row.evidence_seq for row in process] + [row.evidence_seq for row in rpc]
        )
        self._sequence += 1
        await self._publish_observation(
            RuntimeEvent(
                schema_version=RUNTIME_EVENT_SCHEMA_VERSION,
                event_id=self._event_id(event.session_id, suffix="evidence"),
                runtime_id=CODEX_RUNTIME_ID,
                product_session_id=self._request.product_session_id,
                native_session_id=event.session_id,
                process_generation=self._native.host.readiness.process_generation,
                sequence=self._sequence,
                kind=RuntimeEventKind.RUNTIME_EVIDENCE,
                delivery=DeliveryClass.EVIDENCE_ONLY,
                observed_at=event.created_at or datetime.now(UTC).isoformat(),
                payload={"process": json_value(process), "rpc": json_value(rpc)},
            )
        )

    async def snapshot(self) -> RuntimeValue:
        return {
            "binding": self.binding.opaque_session_ref,
            "active_turn_id": self._native.active_turn_id,
            "usage": dict(self._native.usage),
            "resume_turns": json_value(self._native.resume_turns),
        }

    def _event_id(self, native_session_id: str, *, suffix: str = "") -> str:
        parts = (
            CODEX_RUNTIME_ID,
            native_session_id,
            self._event_namespace,
            str(self._sequence),
            suffix,
        )
        return ":".join(part for part in parts if part)

    async def history(self, cursor: RuntimeValue = None) -> RuntimeValue:
        del cursor
        return [
            {
                "role": entry.role,
                "text": (
                    parse_declarations(
                        entry.text,
                        self._request.artifact_directives,
                        message_identity=f"{entry.turn_id}\0{entry.item_id}",
                    ).text
                    if entry.role == "assistant"
                    else entry.text
                ),
                "phase": entry.phase.value if entry.phase is not None else None,
                "turn_id": entry.turn_id,
                "item_id": entry.item_id,
            }
            for entry in self._native.history
        ]

    async def events(self) -> AsyncIterator[RuntimeEvent | RuntimeCallbackRequest]:
        while True:
            yield await self._events.get()

    async def submit(self, request: TurnRequest) -> CommandReceipt:
        async with self._admission_lock:
            receipt = self._suspend_receipt
            if receipt is not None and receipt.state is not SuspendState.ABORTED:
                raise AppServerError(RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY)
            return self._submit_locked(request)

    def _check_turn_admission(self, admission: TurnAdmission) -> None:
        try:
            authorized = admission.current()
        except Exception as error:
            raise AppServerError(TURN_ADMISSION_STALE, safe_error=TURN_ADMISSION_STALE) from error
        if (
            admission.generation
            != f"{self._event_namespace}:{self._native.host.process_generation}"
            or admission.revision != self._current_activity_revision()
            or admission.watermark != self._watermark
            or not authorized
        ):
            raise AppServerError(TURN_ADMISSION_STALE, safe_error=TURN_ADMISSION_STALE)

    def _submit_locked(self, request: TurnRequest) -> CommandReceipt:
        if self._active_command_id:
            return CommandReceipt(
                request.command_id,
                CommandState.REJECTED,
                safe_error="runtime_turn_already_active",
            )
        admission = request.admission
        if admission is not None:
            self._check_turn_admission(admission)
        self._activity_revision += 1
        if admission is not None:
            admission = replace(admission, revision=self._current_activity_revision())
            fence = admission
            host = self._native.host
            epoch = host.admission.epoch
            admission = replace(
                admission,
                current=lambda: (
                    self._native.host is host
                    and host.admission.epoch == epoch
                    and host.admission.accepting
                    and self._turn_admission_current(fence)
                ),
            )
        call_id = uuid.uuid4().hex

        async def observe_retry(submission: SubmissionRetry) -> Callable[[], bool]:
            if request.retry_authorizer is not None:
                return await request.retry_authorizer(
                    SubmissionRetryProof(
                        self.binding,
                        request.command_id,
                        call_id,
                        self._watermark,
                        submission,
                    )
                )
            return lambda: True

        turn_input = TurnInput(
            tuple(_input_item(item) for item in request.items),
            client_user_message_id=request.command_id,
            collaboration_mode=CollaborationMode(
                request.collaboration_mode or CollaborationMode.DEFAULT.value
            ),
            model=self._model.model_ref,
            admission=admission,
            submission_deadline=request.submission_deadline,
            submission_attempts=request.submission_attempts,
            retry_observer=observe_retry if request.retry_authorizer is not None else None,
        )
        self._active_command_id = request.command_id
        task = asyncio.create_task(self._native.run(turn_input))
        self._tasks.add(task)
        task.add_done_callback(
            lambda completed: asyncio.create_task(
                self._finish_turn_task(completed, request.command_id, call_id)
            )
        )
        return CommandReceipt(request.command_id, CommandState.ACCEPTED, correlation_id=call_id)

    def _turn_admission_current(self, admission: TurnAdmission) -> bool:
        self._check_turn_admission(admission)
        return True

    async def _finish_turn_task(
        self, task: asyncio.Task[Any], command_id: str, call_id: str = ""
    ) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is None or self._active_command_id != command_id:
            return
        # App Server can publish turn/started before the turn/start RPC task
        # unwinds with an error (observed after an official thread resume).
        # Once a native turn id exists, execution has crossed the commit
        # boundary: its later native terminal notification is authoritative.
        # Emitting TURN_FAILED here would unlock the product early and discard
        # the real AgentMessage/task_complete that is still in flight.
        if command_id in self._committed_commands:
            return
        observed_at = datetime.now(UTC).isoformat()
        if (
            call_id
            and isinstance(error, AppServerError)
            and error.submission_not_applied
            and error.safe_error == THREAD_HISTORY_MISSING_ERROR
        ):
            generations = self._native.host.seal_empty_replacement(self.binding.opaque_session_ref)
            if generations is not None:
                failed_generation, absence_generation = generations
                self._sequence += 1
                await self._publish_observation(
                    RuntimeEvent(
                        schema_version=RUNTIME_EVENT_SCHEMA_VERSION,
                        event_id=self._event_id(self.binding.opaque_session_ref),
                        runtime_id=CODEX_RUNTIME_ID,
                        product_session_id=self._request.product_session_id,
                        native_session_id=self.binding.opaque_session_ref,
                        process_generation=absence_generation,
                        sequence=self._sequence,
                        kind=RuntimeEventKind.TURN_NOT_SUBMITTED,
                        delivery=DeliveryClass.MUST_PERSIST,
                        observed_at=observed_at,
                        correlation_id=command_id,
                        call_id=call_id,
                        payload={
                            "proof_id": uuid.uuid4().hex,
                            "failed_generation": failed_generation,
                            "absence_generation": absence_generation,
                            "submission_deadline": self._native.submission_deadline,
                            "submission_attempts": self._native.submission_attempts,
                        },
                    )
                )
                self._active_command_id = ""
                return
        retryability = (
            error.retryability
            if isinstance(error, AppServerError)
            else RuntimeRetryability.USER_RETRYABLE
        )
        unknown = retryability is RuntimeRetryability.UNKNOWN_OUTCOME
        safe_error = (
            RUNTIME_TURN_NOT_SUBMITTED
            if isinstance(error, AppServerError) and error.submission_not_applied
            else TURN_SUBMISSION_FAILED_ERROR
        )
        generation = self._native.host.readiness.process_generation
        if isinstance(error, AppServerError):
            generation = error.generation or generation
        incident = RuntimeIncident(
            incident_id=uuid.uuid4().hex,
            scope=RuntimeIncidentScope.TURN,
            state=RuntimeIncidentState.FAILED,
            kind=RuntimeIncidentKind.SUBMISSION_FAILED,
            strategy=RuntimeRecoveryStrategy.MANUAL_RETRY,
            retryability=retryability,
            safe_error=safe_error,
            process_generation=generation,
            vendor_thread_id=self.binding.opaque_session_ref,
            rpc_method=error.method if isinstance(error, AppServerError) else "",
            rpc_code=error.rpc_code if isinstance(error, AppServerError) else None,
            rpc_latency_ms=error.rpc_latency_ms if isinstance(error, AppServerError) else 0,
            ambiguous_commit=unknown,
        )
        self._sequence += 1
        translated = translate_event(
            CodexSessionEvent(
                runtime_id=CODEX_RUNTIME_ID,
                session_id=self.binding.opaque_session_ref,
                kind=CodexSessionEventKind.RUNTIME_INCIDENT,
                created_at=observed_at,
                incident=incident,
            ),
            product_session_id=self._request.product_session_id,
            process_generation=generation,
            sequence=self._sequence,
        )
        assert isinstance(translated, RuntimeEvent)
        await self._publish_observation(
            replace(
                translated,
                event_id=self._event_id(self.binding.opaque_session_ref),
                correlation_id=command_id,
            )
        )
        self._sequence += 1
        await self._publish_observation(
            RuntimeEvent(
                schema_version=RUNTIME_EVENT_SCHEMA_VERSION,
                event_id=self._event_id(self.binding.opaque_session_ref),
                runtime_id=CODEX_RUNTIME_ID,
                product_session_id=self._request.product_session_id,
                native_session_id=self.binding.opaque_session_ref,
                process_generation=generation,
                sequence=self._sequence,
                kind=RuntimeEventKind.TURN_UNKNOWN if unknown else RuntimeEventKind.TURN_FAILED,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at=observed_at,
                correlation_id=command_id,
                payload={
                    "status": UNKNOWN_STATE if unknown else FAILED_STATE,
                    "safe_error": safe_error,
                    "error_code": safe_error,
                    "retryability": retryability.value,
                },
            )
        )
        if unknown:
            self._committed_commands.add(command_id)
        else:
            self._active_command_id = ""

    @_admitted
    async def steer(self, request: SteerRequest) -> CommandReceipt:
        active_turn_id = self._native.active_turn_id
        if request.expected_turn_id and request.expected_turn_id != active_turn_id:
            return CommandReceipt(
                request.command_id,
                CommandState.REJECTED,
                correlation_id=active_turn_id,
                safe_error="runtime_active_turn_changed",
            )
        native_turn_id = await self._native.steer(
            TurnInput(
                tuple(_input_item(item) for item in request.items),
                client_user_message_id=request.command_id,
            )
        )
        return CommandReceipt(
            request.command_id,
            CommandState.ACCEPTED,
            correlation_id=native_turn_id,
        )

    @_admitted
    async def interrupt(self, request: InterruptRequest) -> CommandReceipt:
        async with self._interrupt_lock:
            host = self._native.host
            # Root completion wakes one-shot cleanup. Keep the attachment until
            # its whole tree is interrupted, not merely until the root receipt.
            await host.attachment(self._native.session_id).turn.interrupt()
            await NativeActivity(
                host, self._native.session_id, known_roots=host.known_roots
            ).interrupt(cleanup_background_processes=request.cleanup_background_processes)
        return CommandReceipt(request.command_id, CommandState.ACCEPTED)

    @_admitted
    async def terminate(self, request: TerminateSessionRequest) -> CommandReceipt:
        await self._native.host.close_thread(self._native.session_id)
        self._sequence += 1
        await self._publish_observation(
            RuntimeEvent(
                schema_version=RUNTIME_EVENT_SCHEMA_VERSION,
                event_id=self._event_id(self.binding.opaque_session_ref),
                runtime_id=CODEX_RUNTIME_ID,
                product_session_id=self._request.product_session_id,
                native_session_id=self.binding.opaque_session_ref,
                process_generation=self._native.host.readiness.process_generation,
                sequence=self._sequence,
                kind=RuntimeEventKind.SESSION_CLOSED,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at=datetime.now(UTC).isoformat(),
                correlation_id=request.command_id,
                payload={"status": "terminated"},
            )
        )
        return CommandReceipt(request.command_id, CommandState.APPLIED)

    @_admitted
    async def respond(self, response: RuntimeCallbackResponse) -> CommandReceipt:
        values = response.values if isinstance(response.values, Mapping) else {}
        if response.decision == CallbackKind.DYNAMIC_TOOL.value:
            payload = json_value(values)
            resolved = await self._native.resolve_tool(
                response.request_id,
                CodexToolResponse(
                    success=bool(values.get("ok")),
                    content_items=(
                        {"type": "inputText", "text": json.dumps(payload, ensure_ascii=False)},
                    ),
                ),
            )
            return CommandReceipt(
                response.idempotency_key,
                CommandState.APPLIED if resolved else CommandState.REJECTED,
            )
        resolved = await self._native.resolve_hil(response.request_id, values)
        return CommandReceipt(
            response.idempotency_key,
            CommandState.APPLIED if resolved else CommandState.REJECTED,
        )

    async def _switch_model_in_place(self, model: ModelIntent) -> bool:
        async with self._admission_lock:
            if (
                not self._model_prepared
                or self._optional_capabilities
                or self._native.lease is None
                or self._native.request.ephemeral
                or model.transport.credential_ref
                or self._active_operations != 1
                or self._active_command_id
                or any(not task.done() for task in self._tasks)
                or not (self._native.history or any(self._native.usage.values()))
            ):
                return False
            candidate = await self._project_model_connection(model, None)
            if not _same_process_configuration(self._native.request, candidate):
                return False
            host = self._native.host
            activity_revision = host.thread_activity_revision(self._native.session_id)
            if host.suspend_blockers(self._native.session_id):
                return False
            activity = await NativeActivity(
                host,
                self._native.session_id,
                known_roots=host.known_roots,
            ).inspect()
            if (
                not activity.complete
                or activity.blockers
                or activity_revision != host.thread_activity_revision(self._native.session_id)
            ):
                return False
            try:
                await self._native.reopen(
                    replace(candidate, resume_session_id=self._native.session_id)
                )
            except AppServerError as error:
                if error.safe_error == CODEX_THREAD_RESTORE_FAILED:
                    raise
                logger.warning(
                    "codex_same_process_model_switch_failed safe_error=%s",
                    error.safe_error,
                )
                return False
            return True

    def _permission_candidate(self, intent: PermissionIntent) -> CodexSessionOpenRequest | None:
        if self._permission.deny_read_roots != intent.deny_read_roots:
            return None
        current_policy = CODEX_PERMISSION_POLICIES[self._permission.mode]
        requested_policy = CODEX_PERMISSION_POLICIES[intent.mode]
        current_profile, current_arguments = local_socket_permissions(
            current_policy.sandbox,
            self._permission.local_sockets,
            network_access=self._permission.network_access,
            network_domains=self._permission.network_domains,
            deny_read_roots=self._permission.deny_read_roots,
        )
        requested_profile, requested_arguments = local_socket_permissions(
            requested_policy.sandbox,
            intent.local_sockets,
            network_access=intent.network_access,
            network_domains=intent.network_domains,
            deny_read_roots=intent.deny_read_roots,
        )
        if current_profile != requested_profile or current_arguments != requested_arguments:
            return None
        return replace(
            self._native.request,
            sandbox=requested_policy.sandbox,
            approval_policy=requested_policy.approval_policy,
            approval_reviewer=requested_policy.approval_reviewer,
            writable_roots=intent.writable_roots,
            network_access=intent.network_access,
        )

    def permission_update_scope(self, intent: PermissionIntent) -> PermissionUpdateScope:
        candidate = self._permission_candidate(intent)
        if candidate is not None and reviewer_only_update(self._native.request, candidate):
            return PermissionUpdateScope.TURN
        return PermissionUpdateScope.NEXT_TURN

    @_admitted
    async def reconfigure(self, request: RuntimeConfigurationIntent) -> AppliedState:
        if request.permission is not None:
            requested_policy = CODEX_PERMISSION_POLICIES[request.permission.mode]
            candidate = self._permission_candidate(request.permission)
            if candidate is not None:
                roots_only = (
                    replace(
                        request.permission,
                        revision=self._permission.revision,
                        writable_roots=self._permission.writable_roots,
                    )
                    == self._permission
                )
                if roots_only:
                    await self._native.set_writable_roots(request.permission.writable_roots)
                    applied = PermissionUpdate(
                        PERMISSION_SCOPE_NEXT_TURN
                        if self._active_command_id or self._native.active_turn_id
                        else PERMISSION_SCOPE_SESSION
                    )
                else:
                    applied = await self._native.update_permissions(candidate)
                scope = applied.scope
                if self._active_command_id and not applied.turn_id:
                    scope = PERMISSION_SCOPE_NEXT_TURN
                self._permission = request.permission
                self._request = replace(self._request, permission=request.permission)
                self._native_base_request = replace(
                    self._native_base_request,
                    sandbox=requested_policy.sandbox,
                    approval_policy=requested_policy.approval_policy,
                    approval_reviewer=requested_policy.approval_reviewer,
                    writable_roots=request.permission.writable_roots,
                    network_access=request.permission.network_access,
                )
                return AppliedState(
                    requested_revision=request.revision,
                    applied_revision=(
                        "" if scope == PERMISSION_SCOPE_NEXT_TURN else request.revision
                    ),
                    state=(
                        CommandState.ACCEPTED
                        if scope == PERMISSION_SCOPE_NEXT_TURN
                        else CommandState.APPLIED
                    ),
                    scope=scope,
                    safe_error=applied.safe_error,
                    values={"turn_id": applied.turn_id},
                )
        if request.model is not None:
            if _same_model_connection(self._model, request.model) and _same_thread_preferences(
                self._model, request.model
            ):
                self._model = request.model
                self._request = replace(self._request, model=request.model)
                return AppliedState(
                    requested_revision=request.revision,
                    applied_revision=request.revision,
                    state=CommandState.APPLIED,
                    scope="session",
                )
            if await self._switch_model_in_place(request.model):
                self._model = request.model
                self._request = replace(self._request, model=request.model)
                return AppliedState(
                    requested_revision=request.revision,
                    applied_revision=request.revision,
                    state=CommandState.APPLIED,
                    scope="session",
                )
        return AppliedState(
            requested_revision=request.revision,
            applied_revision="",
            state=CommandState.RESTART_REQUIRED,
            scope="session",
        )

    @_admitted
    async def fork(self, request: ForkRequest) -> RuntimeSession:
        del request
        raise NotImplementedError("fork requires product binding orchestration")

    @_admitted
    async def archive(self, request: ArchiveRequest) -> CommandReceipt:
        return CommandReceipt(request.command_id, CommandState.UNSUPPORTED)

    @_admitted
    async def delete(self, request: DeleteRequest) -> CommandReceipt:
        return CommandReceipt(request.command_id, CommandState.UNSUPPORTED)

    @_admitted
    async def inventory(self, request: InventoryRequest) -> RuntimeInventory:
        values: dict[str, RuntimeValue] = {}
        revisions: list[str] = []
        async with self._native.inventory_control() as control:
            for kind in request.kinds:
                if kind is InventoryKind.MODELS:
                    values[kind.value] = json_value(await control.model_control.list_models())
                elif kind is InventoryKind.SKILLS:
                    skills = await control.skill_control.list_skills(
                        cwd=self._request.cwd,
                        force_reload=request.refresh,
                    )
                    skills = session_skill_inventory(skills, self._skill_configurations)
                    values[kind.value] = json_value(skills)
                    revisions.append(skills.revision)
                elif kind is InventoryKind.MCP:
                    mcp = await control.mcp_inventory(thread_id=self._native.session_id)
                    values[kind.value] = json_value(mcp)
                    revisions.append(mcp.revision)
            return RuntimeInventory(
                revision=":".join(part for part in revisions if part),
                values=values,
                host_identity=control.identity,
            )

    @_admitted
    async def control(self, request: RuntimeControlRequest) -> AppliedState:
        control = self._native.mcp_control
        if control is None:
            return AppliedState(
                request.command_id,
                "",
                CommandState.UNSUPPORTED,
                safe_error="runtime_mcp_control_unavailable",
            )
        values = dict(request.values) if isinstance(request.values, Mapping) else {}
        kind = request.kind
        if kind is RuntimeControlKind.MCP_SNAPSHOT:
            snapshot_result = await control.snapshot()
            payload = json_value(snapshot_result)
            if isinstance(payload, dict):
                payload["capabilities"] = json_value(control.capabilities)
        elif kind is RuntimeControlKind.MCP_LIST_TOOLS:
            list_tools_result = await control.list_tools(
                McpListRequest(
                    server=str(values.get("server") or ""),
                    cursor=str(values.get("cursor") or ""),
                    limit=_page_limit(values.get("limit")),
                    include_schema=bool(values.get("include_schema")),
                )
            )
            payload = json_value(list_tools_result)
        elif kind is RuntimeControlKind.MCP_LIST_RESOURCES:
            list_resources_result = await control.list_resources(
                McpListRequest(
                    server=str(values.get("server") or ""),
                    cursor=str(values.get("cursor") or ""),
                    limit=_page_limit(values.get("limit")),
                )
            )
            payload = json_value(list_resources_result)
        elif kind is RuntimeControlKind.MCP_READ_RESOURCE:
            read_resource_result = await control.read_resource(
                McpReadRequest(
                    server=str(values.get("server") or ""),
                    uri=str(values.get("uri") or ""),
                )
            )
            payload = json_value(read_resource_result)
        elif kind is RuntimeControlKind.MCP_RELOAD:
            reload_result = await control.reload(
                McpReloadRequest(server=str(values.get("server") or ""))
            )
            return AppliedState(
                request.command_id,
                request.command_id,
                CommandState.ACCEPTED,
                scope="runtime",
                values=json_value(reload_result),
            )
        elif kind is RuntimeControlKind.MCP_CALL_TOOL:
            arguments = values.get("arguments")
            meta = values.get("meta")
            call_tool_result = await control.call_tool(
                McpToolCallRequest(
                    server=str(values.get("server") or ""),
                    tool=str(values.get("tool") or ""),
                    arguments=dict(arguments) if isinstance(arguments, Mapping) else {},
                    meta=dict(meta) if isinstance(meta, Mapping) else {},
                )
            )
            payload = json_value(call_tool_result)
        elif kind is RuntimeControlKind.MCP_LOGIN:
            scopes = values.get("scopes")
            begin_login_result = await control.begin_login(
                McpLoginRequest(
                    server=str(values.get("server") or ""),
                    scopes=(
                        tuple(str(scope) for scope in scopes) if isinstance(scopes, list) else ()
                    ),
                )
            )
            payload = json_value(begin_login_result)
        elif kind is RuntimeControlKind.MCP_LIST_PROMPTS:
            list_prompts_result = await control.list_prompts(
                McpListRequest(server=str(values.get("server") or ""))
            )
            payload = json_value(list_prompts_result)
        elif kind is RuntimeControlKind.MCP_LOGOUT:
            logout_result = await control.logout(
                McpLogoutRequest(server=str(values.get("server") or ""))
            )
            payload = json_value(logout_result)
        elif kind is RuntimeControlKind.MCP_TRUST:
            decide_trust_result = await control.decide_trust(
                McpTrustRequest(
                    server=str(values.get("server") or ""),
                    decision=McpTrustDecision(str(values.get("decision") or "")),
                )
            )
            payload = json_value(decide_trust_result)
        else:
            return AppliedState(request.command_id, "", CommandState.UNSUPPORTED)
        return AppliedState(
            request.command_id,
            request.command_id,
            CommandState.APPLIED,
            scope="session",
            values=payload,
        )

    async def detach(self) -> None:
        async with self._interrupt_lock:
            try:
                await self._native.aclose()
            finally:
                try:
                    if self._owns_pool:
                        await self._host_pool.aclose()
                finally:
                    await self._events.close()
