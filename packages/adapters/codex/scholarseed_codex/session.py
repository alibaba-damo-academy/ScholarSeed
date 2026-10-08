"""RuntimeSession commands and normalized observation stream for Codex."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from collections.abc import AsyncIterator, Mapping
from dataclasses import asdict, replace
from datetime import UTC, datetime
from functools import wraps
from importlib.metadata import version
from pathlib import Path
from typing import Any

from scholarseed_codex.activity import NativeActivity
from scholarseed_codex.capacity import HostRole
from scholarseed_codex.catalog import model_catalog_argument
from scholarseed_codex.directive import parse_declarations
from scholarseed_codex.environment import (
    configured_codex_executable,
    prepare_codex_runtime_home,
    proxy_bypass_environment,
    source_model_provider,
)
from scholarseed_codex.events import RUNTIME_EVENT_SCHEMA_VERSION, translate_event
from scholarseed_codex.isolation import managed_codex_launch
from scholarseed_codex.loop import ToolLoopGuard
from scholarseed_codex.mailbox import ObservationMailbox
from scholarseed_codex.permission import (
    CODEX_PERMISSION_POLICIES,
    PERMISSION_SCOPE_NEXT_TURN,
    local_socket_permissions,
    reviewer_only_update,
)
from scholarseed_codex.pool import CodexHostPool, PoolReservation
from scholarseed_codex.profile import (
    CODEX_PROTOCOL_SCHEMA_HASH,
    CODEX_PROTOCOL_VERSION,
    SESSION_SCOPED_CAPABILITIES,
    capabilities,
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
    CODEX_REASONING_SUMMARY_AUTO,
    CODEX_REASONING_SUMMARY_CONFIG,
    CodexDynamicTool,
    CodexRuntimeIdentity,
    CodexSessionEvent,
    CodexSessionEventKind,
    CodexSessionOpenRequest,
    CodexToolResponse,
)
from scholarseed_codex.protocol.state import CODEX_RUNTIME_ID, AppServerError, CodexActivationStage
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
    ModelConnectionMode,
    ModelCredential,
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
from scholarseed_runtime.contract.incident import (
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.input import CollaborationMode, InputItem, InputKind, TurnInput
from scholarseed_runtime.contract.mcp import McpTrustDecision
from scholarseed_runtime.contract.permission import PermissionIntent, PermissionUpdateScope
from scholarseed_runtime.contract.resource import ResourceEvidence
from scholarseed_runtime.contract.session import (
    RUNTIME_SUSPEND_BUSY,
    RUNTIME_SUSPEND_FAILED,
    RUNTIME_SUSPEND_STALE,
    RUNTIME_SUSPEND_UNPERSISTED,
    RUNTIME_SUSPEND_UNSUPPORTED,
    RuntimeActivitySnapshot,
    SuspendReceipt,
    SuspendState,
    SuspendTicket,
)

TOOL_ENVIRONMENT_POLICY_CONFIG = "shell_environment_policy"
TOOL_ENVIRONMENT_INHERIT_CONFIG = "inherit"
TOOL_ENVIRONMENT_SET_CONFIG = "set"
TOOL_ENVIRONMENT_CORE = "core"
CODEX_REMOTE_PROVIDER_ID = "scholarseed"
CODEX_REMOTE_PROVIDER_NAME = "ScholarSeed"
CODEX_MODEL_API_KEY_ENV = "SCHOLARSEED_MODEL_API_KEY"
CODEX_MODEL_HEADER_ENV_PREFIX = "SCHOLARSEED_MODEL_HEADER"
HEADER_ENV_PATTERN = re.compile(r"[^A-Z0-9]+")
DEFAULT_COLLABORATION_MODE = "explicitRequestOnly"
CODEX_WEB_SEARCH_CAPABILITY_KEY = "webSearch"
CODEX_WEB_SEARCH_CAPABILITY_ERROR = "runtime_web_search_capability_unavailable"
CODEX_REASONING_EFFORT_CONFIG = "model_reasoning_effort"
CODEX_SERVICE_TIER_CONFIG = "service_tier"
TURN_SUBMISSION_FAILED_KIND = "turn_submission_failed"
TURN_SUBMISSION_FAILED_ERROR = "runtime_turn_submission_failed"
FAILED_STATE = "failed"
ACTIVITY_COMMAND_PENDING = "runtime_command_pending"
ACTIVITY_OPERATION_PENDING = "runtime_operation_pending"
ACTIVITY_OBSERVATION_PENDING = "runtime_observation_pending"
ACTIVITY_CHANGED = "runtime_activity_changed"
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
        and current.execution_scope == requested.execution_scope
        and current.process_environment == requested.process_environment
        and current.remove_environment == requested.remove_environment
        and current.launch_arguments == requested.launch_arguments
        and current.authentication_required == requested.authentication_required
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
        self._tool_environment = dict(tool_environment or {})
        self._model_prepared = False
        self._admission_lock = asyncio.Lock()
        self._active_operations = 0
        self._activity_revision = 0
        self._watermark = 0
        self._suspend_receipt: SuspendReceipt | None = None
        self._suspend_task: asyncio.Task[None] | None = None
        self._suspend_generation: int | None = None
        self._released_evidence: ResourceEvidence | None = None
        self._request = replace(request, secret_port=None)
        self._required_capabilities = required_capabilities(request.required_capabilities)
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
        runtime_home = prepare_codex_runtime_home(
            native_authentication=request.model.transport.mode is ModelConnectionMode.NATIVE
        )
        permission_policy = CODEX_PERMISSION_POLICIES[request.permission.mode]
        permissions_profile, launch_arguments = local_socket_permissions(
            permission_policy.sandbox,
            request.permission.local_sockets,
            network_access=request.permission.network_access,
            network_domains=request.permission.network_domains,
            deny_read_roots=request.permission.deny_read_roots,
        )
        launch_arguments += windows_sandbox_arguments(permission_policy.sandbox)
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
                execution_scope=request.execution_scope,
                resume_session_id=(
                    resume_binding.opaque_session_ref if resume_binding is not None else ""
                ),
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
                identity=CodexRuntimeIdentity(
                    client_name="scholarseed_desktop",
                    client_title="书深",
                    service_name="scholarseed",
                ),
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
        return self._activity_revision + self._native.host.activity_revision

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
            blockers.append(ACTIVITY_OBSERVATION_PENDING)
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
            blockers.append(ACTIVITY_CHANGED)
        if generation != f"{self._event_namespace}:{self._native.host.process_generation}":
            blockers.append(ACTIVITY_CHANGED)
        return RuntimeActivitySnapshot(
            generation,
            self._current_activity_revision(),
            self._watermark,
            native.complete,
            tuple(blockers),
            execution_tree_complete=native.complete and ACTIVITY_CHANGED not in blockers,
            execution_tree_blockers=native.execution_tree_blockers,
        )

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
                if generation != self._native.host.process_generation:
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
            if self._request.initial_history:
                await self._native.host.seed_history(
                    self._native.session_id, self._request.initial_history
                )
        except BaseException:
            await self._native.aclose()
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
            capabilities=self.capabilities,
            profile=service_tool_profile(self._request.service_tools),
        )

    async def _verify_required_capabilities(self) -> None:
        if RuntimeCapabilityName.WEB_SEARCH not in self._required_capabilities:
            return
        capabilities = await self._native.model_provider_capabilities()
        if capabilities.get(CODEX_WEB_SEARCH_CAPABILITY_KEY) is not True:
            raise AppServerError(
                "Codex model provider does not support Web Search",
                safe_error=CODEX_WEB_SEARCH_CAPABILITY_ERROR,
            )

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
            catalog_argument = await model_catalog_argument(intent, request)
        return replace(request, launch_arguments=(*request.launch_arguments, catalog_argument))

    async def _configure_model_connection(
        self,
        intent: ModelIntent,
        request: CodexSessionOpenRequest,
        credential_port: ModelCredentialPort | None,
    ) -> CodexSessionOpenRequest:
        config = session_thread_config(self._required_capabilities)
        config.update(session_skill_config(self._skill_configurations))
        if self._tool_environment:
            config[TOOL_ENVIRONMENT_POLICY_CONFIG] = {
                TOOL_ENVIRONMENT_INHERIT_CONFIG: TOOL_ENVIRONMENT_CORE,
                TOOL_ENVIRONMENT_SET_CONFIG: dict(self._tool_environment),
            }
        if intent.reasoning_effort:
            config[CODEX_REASONING_EFFORT_CONFIG] = intent.reasoning_effort
        if intent.service_tier:
            config[CODEX_SERVICE_TIER_CONFIG] = intent.service_tier
        if intent.capabilities.tool_protocol is ModelToolProtocol.PROVIDER_NATIVE:
            config[CODEX_REASONING_SUMMARY_CONFIG] = CODEX_REASONING_SUMMARY_AUTO
        if intent.transport.mode is ModelConnectionMode.NATIVE:
            provider_id, definition = source_model_provider()
            if definition:
                config["model_providers"] = {provider_id: definition}
            return replace(
                request,
                model_provider=provider_id,
                thread_config=config,
            )
        transport = intent.transport
        if not transport.endpoint:
            raise ValueError("remote model endpoint is required")
        provider: dict[str, Any] = {
            "name": CODEX_REMOTE_PROVIDER_NAME,
            "base_url": transport.endpoint.rstrip("/"),
            "wire_api": transport.wire_protocol.value,
            "requires_openai_auth": False,
            "supports_websockets": transport.supports_websockets,
        }
        # 出站重试预算由产品按 endpoint 归属决定并经契约下行（``None`` 即交回 Codex 默认）。
        # adapter 只应用预算值，不认网关地址、不解析 endpoint 归属——那是 Serve 的拓扑知识。
        if transport.stream_max_retries is not None:
            provider["stream_max_retries"] = transport.stream_max_retries
        if transport.request_max_retries is not None:
            provider["request_max_retries"] = transport.request_max_retries
        environment = dict(request.process_environment)
        # 子进程从 os.environ 继承代理变量，而厂商模型客户端默认不豁免 loopback，
        # 所以产品声明的内部通道 host 必须合并进 NO_PROXY，否则请求被宿主代理截走。
        # adapter 只落地键名与合并语义，不解析 endpoint 归属 —— 那是产品的拓扑知识。
        environment.update(
            proxy_bypass_environment({**os.environ, **environment}, transport.proxy_bypass_hosts)
        )
        material = ModelCredential()
        if transport.credential_ref:
            if credential_port is None:
                raise ValueError("model credential port is required")
            with self._request.timing.measure(CodexActivationStage.MODEL_CREDENTIALS):
                material = await credential_port.resolve(transport.credential_ref)
        if material.api_key:
            provider["env_key"] = CODEX_MODEL_API_KEY_ENV
            environment[CODEX_MODEL_API_KEY_ENV] = material.api_key
        env_headers: dict[str, str] = {}
        for index, (raw_name, raw_value) in enumerate(material.headers.items()):
            name = str(raw_name).strip()
            value = str(raw_value).strip()
            if not name or not value:
                continue
            slug = HEADER_ENV_PATTERN.sub("_", name.upper()).strip("_") or str(index)
            env_name = f"{CODEX_MODEL_HEADER_ENV_PREFIX}_{slug}_{index}"
            env_headers[name] = env_name
            environment[env_name] = value
        if env_headers:
            provider["env_http_headers"] = env_headers
        config["model_providers"] = {CODEX_REMOTE_PROVIDER_ID: provider}
        if intent.context_window is not None:
            config["model_context_window"] = intent.context_window
        return replace(
            request,
            model_provider=CODEX_REMOTE_PROVIDER_ID,
            authentication_required=False,
            thread_config=config,
            process_environment=environment,
        )

    @property
    def binding(self) -> RuntimeBinding:
        if self._binding is None:
            raise RuntimeError("Codex runtime session is not open")
        return self._binding

    @property
    def capabilities(self) -> CapabilitySet:
        return capabilities(self._required_capabilities & SESSION_SCOPED_CAPABILITIES)

    async def _on_native_event(self, event: CodexSessionEvent) -> None:
        self._activity_revision += 1
        await self._observe_evidence(event)
        if (
            event.kind
            in {
                CodexSessionEventKind.TURN_STARTED,
                CodexSessionEventKind.TURN_UNKNOWN,
            }
            and self._active_command_id
        ):
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
        }:
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

    @_admitted
    async def submit(self, request: TurnRequest) -> CommandReceipt:
        if self._active_command_id:
            return CommandReceipt(
                request.command_id,
                CommandState.REJECTED,
                safe_error="runtime_turn_already_active",
            )
        turn_input = TurnInput(
            tuple(_input_item(item) for item in request.items),
            client_user_message_id=request.command_id,
            collaboration_mode=CollaborationMode(
                request.collaboration_mode or CollaborationMode.DEFAULT.value
            ),
            model=self._model.model_ref,
        )
        self._active_command_id = request.command_id
        task = asyncio.create_task(self._native.run(turn_input))
        self._tasks.add(task)
        task.add_done_callback(
            lambda completed: asyncio.create_task(
                self._finish_turn_task(completed, request.command_id)
            )
        )
        return CommandReceipt(request.command_id, CommandState.ACCEPTED)

    async def _finish_turn_task(self, task: asyncio.Task[Any], command_id: str) -> None:
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
                kind=RuntimeEventKind.RUNTIME_INCIDENT,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at=observed_at,
                correlation_id=command_id,
                payload={
                    "kind": TURN_SUBMISSION_FAILED_KIND,
                    "state": FAILED_STATE,
                    "safe_error": TURN_SUBMISSION_FAILED_ERROR,
                },
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
                process_generation=self._native.host.readiness.process_generation,
                sequence=self._sequence,
                kind=RuntimeEventKind.TURN_FAILED,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at=observed_at,
                correlation_id=command_id,
                payload={"status": FAILED_STATE, "safe_error": TURN_SUBMISSION_FAILED_ERROR},
            )
        )
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
        await self._native.host.attachment(self._native.session_id).turn.interrupt(
            cleanup_background_processes=request.cleanup_background_processes
        )
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
            activity_revision = host.activity_revision
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
                or activity_revision != host.activity_revision
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
        if (
            current_profile != requested_profile
            or current_arguments != requested_arguments
            or windows_sandbox_arguments(current_policy.sandbox)
            != windows_sandbox_arguments(requested_policy.sandbox)
        ):
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
        for kind in request.kinds:
            if kind is InventoryKind.MODELS:
                model_control = self._native.model_control
                if model_control is None:
                    raise RuntimeError("runtime_model_inventory_unavailable")
                models = await model_control.list_models()
                values[kind.value] = json_value(models)
            elif kind is InventoryKind.SKILLS:
                skill_control = self._native.skill_control
                if skill_control is None:
                    raise RuntimeError("runtime_skill_inventory_unavailable")
                skills = await skill_control.list_skills(
                    cwd=self._request.cwd,
                    force_reload=request.refresh,
                )
                skills = session_skill_inventory(skills, self._skill_configurations)
                values[kind.value] = json_value(skills)
                revisions.append(skills.revision)
            elif kind is InventoryKind.MCP:
                mcp_control = self._native.mcp_control
                if mcp_control is None:
                    raise RuntimeError("runtime_mcp_inventory_unavailable")
                mcp = await mcp_control.snapshot()
                values[kind.value] = json_value(mcp)
                revisions.append(mcp.revision)
        revision = ":".join(part for part in revisions if part)
        return RuntimeInventory(revision=revision, values=values)

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
            payload = json_value(reload_result)
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
        try:
            await self._native.aclose()
        finally:
            await self._events.close()
