"""Runtime provider discovery, readiness and session construction."""

from __future__ import annotations

import asyncio
import sys
import uuid
import weakref
from collections.abc import AsyncIterator, Callable
from contextlib import AsyncExitStack, ExitStack, asynccontextmanager
from dataclasses import replace
from functools import partial
from hashlib import sha256
from importlib.metadata import version
from pathlib import Path
from time import time

from scholarseed_codex.activity import NativeActivity
from scholarseed_codex.capacity import DEFAULT_ATTACHMENT_IDLE_SECONDS, CapacityPolicy, HostRole
from scholarseed_codex.catalog import CatalogPreflightError
from scholarseed_codex.command import _finish
from scholarseed_codex.configuration import native_mcp_configuration
from scholarseed_codex.control import CodexRuntimeControl
from scholarseed_codex.environment import (
    CODEX_CONFIG_FILENAME,
    CODEX_DISCOVERY_HOME_DIRNAME,
    configured_codex_executable,
    runtime_home,
    runtime_storage_roots,
)
from scholarseed_codex.isolation import ENVIRONMENT_NAME_PATTERN, managed_codex_launch
from scholarseed_codex.launch import model_connection, validate_model_connection
from scholarseed_codex.permission import WINDOWS_PLATFORM
from scholarseed_codex.pool import CodexHostPool, HostLease, PoolReservation
from scholarseed_codex.profile import (
    CODEX_DISPLAY_NAME,
    CODEX_PROTOCOL_SCHEMA_HASH,
    CODEX_PROTOCOL_VERSION,
    CODEX_RUNTIME_ABI_VERSION,
    CODEX_RUNTIME_VERSION_RANGE,
    capabilities,
    resumed_capabilities,
)
from scholarseed_codex.projection import CodexConfigurationEditor
from scholarseed_codex.protocol.session import CODEX_MANAGED_IDENTITY, CodexSessionOpenRequest
from scholarseed_codex.protocol.state import (
    CODEX_DEFAULT_SANDBOX_MODE,
    CODEX_RUNTIME_ID,
    AppServerError,
    CodexActivationStage,
)
from scholarseed_codex.sandbox import windows_sandbox_arguments
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_codex.utils import json_value, path_identity
from scholarseed_runtime.contract import (
    CommandReceipt,
    CommandState,
    InventoryKind,
    LaunchSecretScope,
    OpenSessionRequest,
    ResumeSessionRequest,
    RuntimeDescriptor,
    RuntimeInspectionRequest,
    RuntimeInventory,
    RuntimeProvider,
    RuntimeReadiness,
    RuntimeSession,
    RuntimeStatus,
    RuntimeValue,
)
from scholarseed_runtime.contract.binding import RuntimeBinding
from scholarseed_runtime.contract.command import HostWarmupRequest, SkillConfigurationRequest
from scholarseed_runtime.contract.inventory import SkillPolicy
from scholarseed_runtime.contract.mcp import (
    MCP_CONFIGURATION_UNSUPPORTED,
    MCP_INITIAL_CONFIGURATION_REVISION,
    McpConfigurationReceipt,
    McpConfigurationRequest,
)
from scholarseed_runtime.contract.model import MODEL_CATALOG_UNAVAILABLE
from scholarseed_runtime.contract.provider import (
    RUNTIME_HOST_RECONFIGURATION_COMMAND,
    RUNTIME_HOST_WARMUP_COMMAND,
    RuntimeOpenNotAppliedError,
)
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_BUSY,
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    RESOURCE_HOST_CONTEXT_REQUIRED,
    RESOURCE_RELEASE_BUSY,
    RESOURCE_RELEASE_FAILED,
    RESOURCE_RESERVATION_INVALID,
    ResourceLease,
    ResourcePolicy,
    ResourcePurpose,
    ResourceReceipt,
    ResourceRequest,
    ResourceState,
)
from scholarseed_runtime.contract.runtime import ProviderConfiguration
from scholarseed_runtime.contract.sandbox import SandboxRecovery, SandboxResources
from scholarseed_runtime.contract.session import RuntimeExecutionThread
from scholarseed_runtime.contract.storage import (
    RuntimeConfigurationStorage,
    StorageInspection,
    StorageRoot,
)

PROVIDER_CONFIGURE_COMMAND = "provider.configure"
PROVIDER_CONFIGURATION_INVALID = "runtime_provider_configuration_invalid"
PROVIDER_CONFIGURATION_CONFLICT = "runtime_provider_configuration_conflict"

RESOURCE_TERMINAL_STATES = frozenset(
    {
        ResourceState.REJECTED,
        ResourceState.CANCELLED,
        ResourceState.EXPIRED,
    }
)


def _discard_prepared(
    provider_ref, reservation_id: str, settled: asyncio.Future[ResourceState]
) -> None:
    provider = provider_ref()
    if (
        provider is not None
        and not settled.cancelled()
        and settled.result() in RESOURCE_TERMINAL_STATES
    ):
        provider._prepared.pop(reservation_id, None)


async def _resolve_launch_secrets(
    request: OpenSessionRequest | HostWarmupRequest,
) -> tuple[dict[str, str], dict[str, str]]:
    bindings = request.launch_secrets.bindings
    if any(
        not ENVIRONMENT_NAME_PATTERN.fullmatch(name)
        for name in request.launch_secrets.remove_environment
    ):
        raise ValueError("runtime removed environment name is invalid")
    if not bindings:
        return {}, {}
    if request.secret_port is None:
        raise ValueError("runtime secret port is required")
    environment: dict[str, str] = {}
    tool_environment: dict[str, str] = {}
    for binding in bindings:
        if not ENVIRONMENT_NAME_PATTERN.fullmatch(binding.name):
            raise ValueError("runtime secret environment name is invalid")
        target = (
            environment
            if binding.scope is LaunchSecretScope.PROCESS
            else tool_environment if binding.scope is LaunchSecretScope.TOOL else None
        )
        if target is None:
            raise ValueError("runtime secret scope is invalid")
        if binding.name in target:
            raise ValueError("runtime secret environment name is duplicated")
        material = await request.secret_port.resolve(binding.secret_ref)
        target[binding.name] = material.value
    return environment, tool_environment


class CodexRuntimeProvider:
    """Provider discovered through the public ``scholarseed_runtime.providers`` entry point."""

    def __init__(self) -> None:
        self._pool = CodexHostPool()
        self._configuration: CapacityPolicy | None = None
        self._resource_lease: Callable[[], ResourceLease] | None = None
        self._configuration_storage: RuntimeConfigurationStorage | None = None
        self._sandbox_resources: SandboxResources | None = None
        self._sandbox_recovery: SandboxRecovery | None = None
        self._prepared: dict[str, tuple[ResourceRequest, CodexRuntimeSession, PoolReservation]] = {}
        self._prepare_lock = asyncio.Lock()
        self._request_fingerprints: dict[str, str] = {}

    def storage_roots(self, inspection: StorageInspection | None = None) -> tuple[StorageRoot, ...]:
        return tuple(
            StorageRoot(path, create=True) for path in runtime_storage_roots(inspection=inspection)
        )

    def configuration_files(self) -> tuple[Path, ...]:
        return (runtime_home() / CODEX_CONFIG_FILENAME,)

    def configure(self, configuration: ProviderConfiguration) -> CommandReceipt:
        if configuration.runtime_id != CODEX_RUNTIME_ID:
            return CommandReceipt(
                PROVIDER_CONFIGURE_COMMAND,
                CommandState.REJECTED,
                safe_error=PROVIDER_CONFIGURATION_INVALID,
            )
        try:
            policy = CapacityPolicy.parse(configuration.values)
        except ValueError:
            return CommandReceipt(
                PROVIDER_CONFIGURE_COMMAND,
                CommandState.REJECTED,
                safe_error=PROVIDER_CONFIGURATION_INVALID,
            )
        if self._configuration is not None and (
            self._configuration != policy
            or self._resource_lease is not configuration.resource_lease
            or self._configuration_storage is not configuration.configuration_storage
            or self._sandbox_resources is not configuration.sandbox_resources
            or self._sandbox_recovery is not configuration.sandbox_recovery
        ):
            return CommandReceipt(
                PROVIDER_CONFIGURE_COMMAND,
                CommandState.REJECTED,
                safe_error=PROVIDER_CONFIGURATION_CONFLICT,
            )
        if self._configuration is None:
            if (
                self._prepared
                or self._pool.execution_configured
                or any(row.used for row in self._pool.snapshot())
            ):
                return CommandReceipt(
                    PROVIDER_CONFIGURE_COMMAND,
                    CommandState.REJECTED,
                    safe_error=PROVIDER_CONFIGURATION_CONFLICT,
                )
            self._pool = CodexHostPool(
                policy,
                resource_lease=configuration.resource_lease,
                sandbox_resources=configuration.sandbox_resources,
                sandbox_recovery=configuration.sandbox_recovery,
                mcp_editor=(
                    CodexConfigurationEditor(configuration.configuration_storage, runtime_home())
                    if configuration.configuration_storage is not None
                    else None
                ),
            )
            self._configuration = policy
            self._resource_lease = configuration.resource_lease
            self._configuration_storage = configuration.configuration_storage
            self._sandbox_resources = configuration.sandbox_resources
            self._sandbox_recovery = configuration.sandbox_recovery
        return CommandReceipt(PROVIDER_CONFIGURE_COMMAND, CommandState.APPLIED)

    async def configure_mcp(self, request: McpConfigurationRequest) -> McpConfigurationReceipt:
        if not self._pool.mcp_configuration_enabled:
            return McpConfigurationReceipt(
                request.revision, safe_error=MCP_CONFIGURATION_UNSUPPORTED
            )
        return self._pool.configure_mcp(await native_mcp_configuration(request))

    async def mcp_configuration(self) -> McpConfigurationReceipt:
        if not self._pool.mcp_configuration_enabled:
            return McpConfigurationReceipt(
                MCP_INITIAL_CONFIGURATION_REVISION, safe_error=MCP_CONFIGURATION_UNSUPPORTED
            )
        return await self._pool.mcp_configuration()

    @property
    def resource_policy(self) -> ResourcePolicy:
        return ResourcePolicy(
            self._pool.policy.wait_seconds,
            DEFAULT_ATTACHMENT_IDLE_SECONDS,
            refresh_before_turn=sys.platform == WINDOWS_PLATFORM,
        )

    @asynccontextmanager
    async def _borrow_host(
        self, request: HostWarmupRequest | None, *, reconfigure: bool = False
    ) -> AsyncIterator[HostLease]:
        if request is None:
            raise AppServerError(
                RESOURCE_HOST_CONTEXT_REQUIRED, safe_error=RESOURCE_HOST_CONTEXT_REQUIRED
            )
        if not request.request_id.strip() or not request.process_sharing_scope.strip():
            raise ValueError("host warmup requires an identity and an explicit sharing scope")
        reservation = None
        lease = None
        configuration_reset = False
        identity_transferred = False
        borrow_id = uuid.uuid4().hex
        async with AsyncExitStack() as preparation:
            if self._resource_lease is not None:
                preparation.callback(self._resource_lease().close)
            try:
                async with self._prepare_lock:
                    if reconfigure and not self._pool.matches_scope(request.process_sharing_scope):
                        if not await self._pool.release_idle():
                            raise AppServerError(RESOURCE_HOST_BUSY, safe_error=RESOURCE_HOST_BUSY)
                        await self._pool.replace_execution_scope(request.process_sharing_scope)
                        identity_transferred = configuration_reset = True
                    self._pool.authorize_scope(request.process_sharing_scope)
                    environment, tool_environment = await _resolve_launch_secrets(request)
                    if tool_environment:
                        raise ValueError("host warmup does not accept tool-scoped secrets")
                    validate_model_connection(request.model)
                    home = self._pool.prepare_home()
                    environment, arguments = managed_codex_launch(
                        home,
                        environment,
                        windows_sandbox_arguments(CODEX_DEFAULT_SANDBOX_MODE),
                    )
                    native = CodexSessionOpenRequest(
                        request_id=borrow_id,
                        runtime_id=CODEX_RUNTIME_ID,
                        cwd=request.cwd,
                        launch_cwd=home / CODEX_DISCOVERY_HOME_DIRNAME,
                        process_sharing_scope=request.process_sharing_scope,
                        executable=configured_codex_executable(),
                        process_environment=environment,
                        remove_environment=request.launch_secrets.remove_environment,
                        launch_arguments=arguments,
                        base_instructions=request.base_instructions,
                        skill_roots=request.skill_roots,
                        identity=CODEX_MANAGED_IDENTITY,
                        timing=request.timing,
                    )
                    native = await model_connection(
                        request.model, native, request.credential_port, timing=request.timing
                    )
                    with request.timing.measure(CodexActivationStage.MODEL_CATALOG):
                        catalog = await self._pool.model_catalog_argument(request.model, native)
                    native = replace(native, launch_arguments=(*native.launch_arguments, catalog))
                    if reconfigure:
                        if not await self._pool.release_idle():
                            raise AppServerError(RESOURCE_HOST_BUSY, safe_error=RESOURCE_HOST_BUSY)
                        await self._pool.reset_execution_configuration(
                            request.process_sharing_scope
                        )
                        configuration_reset = True
                    reservation = await self._pool.reserve(
                        native,
                        role=HostRole.EXECUTION,
                        request_id=borrow_id,
                        deadline=time() + self.resource_policy.wait_seconds,
                    )
                    if reconfigure:
                        lease = await self._pool.consume(reservation)
                if lease is None:
                    lease = await self._pool.consume(reservation)
                self._pool.authorize_scope(request.process_sharing_scope)
                yield lease
            except BaseException as error:
                if configuration_reset:
                    self._pool.fence_reconfiguration()
                if identity_transferred and isinstance(error, Exception):
                    raise AppServerError(
                        RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
                        safe_error=RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
                    ) from error
                raise
            finally:
                cleanup = (
                    lease.close()
                    if lease is not None
                    else self._pool.cancel(reservation) if reservation is not None else None
                )
                if cleanup is not None:
                    task = asyncio.create_task(cleanup)
                    try:
                        await asyncio.shield(task)
                    except asyncio.CancelledError:
                        await _finish(task)
                        raise

    async def reconfigure(self, request: HostWarmupRequest) -> CommandReceipt:
        operation = asyncio.create_task(self._warm_host(request, reconfigure=True))
        try:
            return await asyncio.shield(operation)
        except asyncio.CancelledError:
            await _finish(operation)
            raise

    async def prewarm(self, request: HostWarmupRequest) -> CommandReceipt:
        return await self._warm_host(request)

    async def _warm_host(
        self, request: HostWarmupRequest, *, reconfigure: bool = False
    ) -> CommandReceipt:
        command = (
            RUNTIME_HOST_RECONFIGURATION_COMMAND if reconfigure else RUNTIME_HOST_WARMUP_COMMAND
        )
        try:
            async with self._borrow_host(request, reconfigure=reconfigure) as lease:
                return CommandReceipt(
                    command,
                    CommandState.APPLIED,
                    correlation_id=f"{lease.host_id}:{lease.host.readiness.process_generation}",
                )
        except CatalogPreflightError:
            return CommandReceipt(
                command, CommandState.REJECTED, safe_error=MODEL_CATALOG_UNAVAILABLE
            )
        except AppServerError as error:
            if reconfigure and error.safe_error == RESOURCE_HOST_BUSY:
                return CommandReceipt(command, CommandState.REJECTED, safe_error=error.safe_error)
            if error.safe_error not in {
                RESOURCE_HOST_CONFIGURATION_CONFLICT,
                RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
            }:
                raise
            return CommandReceipt(
                command,
                CommandState.RESTART_REQUIRED,
                safe_error=error.safe_error,
            )

    @staticmethod
    def _open_request(request: OpenSessionRequest | ResumeSessionRequest) -> OpenSessionRequest:
        if not isinstance(request.skill_policy, SkillPolicy):
            raise ValueError("invalid runtime skill policy")
        if isinstance(request, OpenSessionRequest):
            return replace(request, reservation_id="")
        binding = request.binding
        if binding.runtime_id != CODEX_RUNTIME_ID:
            raise ValueError("runtime binding belongs to a different provider")
        if not isinstance(binding.skill_policy, SkillPolicy):
            raise ValueError("invalid runtime binding skill policy")
        return OpenSessionRequest(
            product_session_id=binding.product_session_id,
            cwd=request.cwd,
            execution_scope=request.execution_scope,
            process_sharing_scope=request.process_sharing_scope,
            execution_environment=request.execution_environment,
            model=request.model,
            credential_port=request.credential_port,
            launch_secrets=request.launch_secrets,
            secret_port=request.secret_port,
            permission=request.permission,
            base_instructions=request.base_instructions,
            developer_instructions=request.developer_instructions,
            service_tools=request.service_tools,
            skill_roots=request.skill_roots,
            skill_configurations=request.skill_configurations,
            skill_policy=(
                SkillPolicy.DENY
                if SkillPolicy.DENY in (request.skill_policy, binding.skill_policy)
                else SkillPolicy.INHERIT
            ),
            artifact_directives=request.artifact_directives,
            required_capabilities=resumed_capabilities(binding),
            optional_capabilities=binding.optional_capabilities,
            timing=request.timing,
        )

    async def reserve(self, request: ResourceRequest) -> ResourceReceipt:
        timing = request.session_request.timing
        async with AsyncExitStack() as preparation:
            with timing.measure(CodexActivationStage.PREPARE_LOCK_WAIT):
                await preparation.enter_async_context(self._prepare_lock)
            # Retain only an opaque intent digest with the pool's bounded receipts.
            self._request_fingerprints = {
                key: value
                for key, value in self._request_fingerprints.items()
                if self._pool.reservation(key) is not None
            }
            fingerprint = sha256(
                repr((request, request.session_request.process_sharing_scope)).encode()
            ).hexdigest()
            previous = self._pool.reservation_for(request.request_id)
            if previous is not None:
                if self._request_fingerprints.get(previous.reservation_id) != fingerprint:
                    raise AppServerError(
                        RESOURCE_RESERVATION_INVALID, safe_error=RESOURCE_RESERVATION_INVALID
                    )
                return self._pool.receipt(previous)
            for original, _session, reservation in self._prepared.values():
                if original.request_id == request.request_id:
                    if original != request:
                        raise AppServerError(
                            RESOURCE_RESERVATION_INVALID, safe_error=RESOURCE_RESERVATION_INVALID
                        )
                    return self._pool.receipt(reservation)
            open_request = self._open_request(request.session_request)
            self._pool.authorize_scope(open_request.process_sharing_scope)
            # Directory preparation and credential synchronization happen in the
            # session constructor, before the pool acquires its physical lease.
            # Retain host admission over this whole preparation transaction too.
            if self._resource_lease is not None:
                preparation.callback(self._resource_lease().close)
            with timing.measure(CodexActivationStage.LAUNCH_CREDENTIALS):
                launch_environment, tool_environment = await _resolve_launch_secrets(open_request)
            with ExitStack() as partition:
                isolated_home = (
                    self._pool.prepare_home(isolated=True)
                    if request.purpose is ResourcePurpose.INVOCATION
                    else None
                )
                if isolated_home is not None:
                    partition.callback(self._pool.release_home, isolated_home)
                session = CodexRuntimeSession(
                    open_request,
                    resume_binding=(
                        request.session_request.binding
                        if isinstance(request.session_request, ResumeSessionRequest)
                        else None
                    ),
                    launch_environment=launch_environment,
                    tool_environment=tool_environment,
                    host_pool=self._pool,
                    isolated_home=isolated_home,
                )
                reservation = await session.prepare_resource(request.request_id, request.deadline)
                receipt = self._pool.receipt(reservation)
                if receipt.state in {ResourceState.GRANTED, ResourceState.WAITING}:
                    partition.pop_all()
            self._request_fingerprints[receipt.reservation_id] = fingerprint
            if receipt.state in {ResourceState.GRANTED, ResourceState.WAITING}:
                self._prepared[receipt.reservation_id] = (request, session, reservation)
                reservation.settled.add_done_callback(
                    partial(_discard_prepared, weakref.ref(self), receipt.reservation_id)
                )
            return receipt

    async def wait_resource(self, reservation_id: str) -> ResourceReceipt:
        prepared = self._prepared.get(reservation_id)
        if prepared is None:
            previous = self._pool.reservation(reservation_id)
            if previous is not None:
                return self._pool.receipt(previous)
            return ResourceReceipt(
                "", reservation_id, ResourceState.REJECTED, safe_error=RESOURCE_RESERVATION_INVALID
            )
        try:
            return await self._pool.wait(prepared[2])
        except asyncio.CancelledError:
            self._prepared.pop(reservation_id, None)
            raise

    async def cancel_resource(self, reservation_id: str) -> ResourceReceipt:
        prepared = self._prepared.pop(reservation_id, None)
        if prepared is None:
            previous = self._pool.reservation(reservation_id)
            if previous is not None:
                return await self._pool.cancel(previous)
            return ResourceReceipt("", reservation_id, ResourceState.CANCELLED)
        return await self._pool.cancel(prepared[2])

    async def _materialize(
        self, request: OpenSessionRequest | ResumeSessionRequest
    ) -> RuntimeSession:
        reservation_id = request.reservation_id
        if not reservation_id:
            receipt = await self.reserve(
                ResourceRequest(
                    uuid.uuid4().hex,
                    ResourcePurpose.SESSION,
                    time() + self.resource_policy.wait_seconds,
                    request,
                )
            )
            reservation_id = receipt.reservation_id
            if receipt.state in RESOURCE_TERMINAL_STATES:
                raise AppServerError(receipt.safe_error, safe_error=receipt.safe_error)
        prepared = self._prepared.get(reservation_id)
        if prepared is None:
            raise AppServerError(
                RESOURCE_RESERVATION_INVALID, safe_error=RESOURCE_RESERVATION_INVALID
            )
        original, session, reservation = prepared
        if replace(request, reservation_id="") != replace(
            original.session_request, reservation_id=""
        ):
            raise AppServerError(
                RESOURCE_RESERVATION_INVALID, safe_error=RESOURCE_RESERVATION_INVALID
            )
        # Claim the prepared session before yielding; a losing redeemer must never detach it.
        self._prepared.pop(reservation_id)
        try:
            await session.consume_resource(reservation)
        except BaseException as error:
            cleanup_errors: list[BaseException] = []
            try:
                await self._pool.cancel(reservation)
            except BaseException as cleanup_error:
                cleanup_errors.append(cleanup_error)
            try:
                await session.detach()
            except BaseException as cleanup_error:
                cleanup_errors.append(cleanup_error)
            if cleanup_errors:
                raise BaseExceptionGroup(
                    "Runtime opening and resource cleanup failed", [error, *cleanup_errors]
                ) from error
            if (
                isinstance(request, OpenSessionRequest)
                and isinstance(error, Exception)
                and reservation.slot is None
            ):
                raise RuntimeOpenNotAppliedError(
                    reservation_id, getattr(error, "safe_error", "")
                ) from error
            raise
        try:
            await session.open()
            if (
                isinstance(request, ResumeSessionRequest)
                and session.binding.opaque_session_ref != request.binding.opaque_session_ref
            ):
                raise RuntimeError("runtime resumed a different native session")
            return session
        except BaseException:
            await session.detach()
            raise

    @property
    def descriptor(self) -> RuntimeDescriptor:
        return RuntimeDescriptor(
            abi_version=CODEX_RUNTIME_ABI_VERSION,
            runtime_id=CODEX_RUNTIME_ID,
            display_name=CODEX_DISPLAY_NAME,
            adapter_version=version("scholarseed-codex"),
            runtime_version_range=CODEX_RUNTIME_VERSION_RANGE,
            protocol_version=CODEX_PROTOCOL_VERSION,
            protocol_schema_hash=CODEX_PROTOCOL_SCHEMA_HASH,
            capabilities=capabilities(),
        )

    async def probe(self) -> RuntimeReadiness:
        readiness = await self._pool.probe_readiness(
            configured_codex_executable(), prefer_pooled=True
        )
        return RuntimeReadiness(
            runtime_id=readiness.runtime_id,
            status=RuntimeStatus(readiness.status.value),
            ready=readiness.ready,
            executable=readiness.executable,
            version=readiness.version,
            authenticated=readiness.authenticated,
            safe_error=readiness.safe_error,
            warning=readiness.warning,
            process_state=readiness.process_state,
            process_generation=readiness.process_generation,
            recovery_attempt=readiness.recovery_attempt,
            max_recovery_attempts=readiness.max_recovery_attempts,
        )

    @asynccontextmanager
    async def _control(
        self, *, cwd: Path, roots: tuple[Path, ...], host: HostWarmupRequest | None
    ) -> AsyncIterator[CodexRuntimeControl]:
        if host is None:
            raise AppServerError(
                RESOURCE_HOST_CONTEXT_REQUIRED, safe_error=RESOURCE_HOST_CONTEXT_REQUIRED
            )
        if cwd.expanduser().resolve() != host.cwd.expanduser().resolve() or (
            {path.expanduser().resolve() for path in roots}
            != {path.expanduser().resolve() for path in host.skill_roots}
        ):
            raise AppServerError(
                RESOURCE_HOST_CONFIGURATION_CONFLICT,
                safe_error=RESOURCE_HOST_CONFIGURATION_CONFLICT,
            )
        async with self._borrow_host(host) as lease:
            control = CodexRuntimeControl(cwd=cwd, lease=lease, host_pool=self._pool)
            await control.open()
            try:
                yield control
            finally:
                await control.aclose()

    async def configure_skills(self, request: SkillConfigurationRequest) -> CommandReceipt:
        async with self._control(
            cwd=request.cwd, roots=request.roots, host=request.host
        ) as control:
            async with control.reading():
                for skill in request.skills:
                    await control.skill_control.configure(skill.path, skill.enabled)
                inventory = await control.skill_control.list_skills(force_reload=True)
                effective = {path_identity(skill.path): skill.enabled for skill in inventory.skills}
                if inventory.errors or any(
                    effective.get(path_identity(skill.path)) != skill.enabled
                    for skill in request.skills
                ):
                    raise RuntimeError("skill configuration verification failed")
            return CommandReceipt("skills.configure", CommandState.APPLIED)

    async def inspect(self, request: RuntimeInspectionRequest) -> RuntimeInventory:
        if (
            request.launch_secrets.bindings
            or request.launch_secrets.remove_environment
            or request.secret_port is not None
        ):
            raise AppServerError(
                RESOURCE_HOST_CONTEXT_REQUIRED, safe_error=RESOURCE_HOST_CONTEXT_REQUIRED
            )
        async with self._control(
            cwd=request.cwd, roots=request.roots, host=request.host
        ) as control:
            values: dict[str, RuntimeValue] = {}
            revisions: list[str] = []
            for kind in request.inventory.kinds:
                if kind is InventoryKind.MODELS:
                    values[kind.value] = json_value(await control.model_control.list_models())
                elif kind is InventoryKind.SKILLS:
                    skills = await control.skill_control.list_skills(
                        cwd=request.cwd,
                        force_reload=request.inventory.refresh,
                    )
                    revisions.append(skills.revision)
                    values[kind.value] = json_value(skills)
                elif kind is InventoryKind.MCP:
                    values[kind.value] = json_value(await control.mcp_inventory())
                else:
                    raise ValueError(f"pre-session inventory is unsupported: {kind.value}")
            return RuntimeInventory(
                revision=":".join(part for part in revisions if part),
                values=values,
                host_identity=control.identity,
            )

    async def execution_threads(
        self, binding: RuntimeBinding, cwd: Path, *, host: HostWarmupRequest | None = None
    ) -> tuple[RuntimeExecutionThread, ...]:
        if binding.runtime_id != CODEX_RUNTIME_ID or not binding.opaque_session_ref:
            raise ValueError("runtime binding does not identify a Codex thread")
        async with self._control(
            cwd=cwd, roots=host.skill_roots if host else (), host=host
        ) as control:
            async with control.reading():
                return await NativeActivity(control, binding.opaque_session_ref).descendants()

    async def open(self, request: OpenSessionRequest) -> RuntimeSession:
        return await self._materialize(request)

    async def resume(self, request: ResumeSessionRequest) -> RuntimeSession:
        return await self._materialize(request)

    async def release_idle_resources(self) -> CommandReceipt:
        try:
            released = await self._pool.release_idle()
        except Exception:
            return CommandReceipt(
                "resources.release_idle",
                CommandState.REJECTED,
                safe_error=RESOURCE_RELEASE_FAILED,
            )
        return CommandReceipt(
            "resources.release_idle",
            CommandState.APPLIED if released else CommandState.REJECTED,
            safe_error="" if released else RESOURCE_RELEASE_BUSY,
        )

    async def shutdown(self) -> CommandReceipt:
        await self._pool.aclose()
        self._prepared.clear()
        self._request_fingerprints.clear()
        return CommandReceipt("shutdown", CommandState.APPLIED)


def provider() -> RuntimeProvider:
    return CodexRuntimeProvider()


__all__ = ["CodexRuntimeProvider", "provider"]
