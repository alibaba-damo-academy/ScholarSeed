"""Runtime provider discovery, readiness and session construction."""

from __future__ import annotations

import asyncio
import re
import uuid
import weakref
from contextlib import AsyncExitStack
from dataclasses import replace
from functools import partial
from hashlib import sha256
from importlib.metadata import version
from pathlib import Path
from time import time

from scholarseed_codex.capacity import CapacityPolicy
from scholarseed_codex.control import CodexRuntimeControl
from scholarseed_codex.environment import (
    configured_codex_executable,
    prepare_codex_runtime_home,
)
from scholarseed_codex.isolation import managed_codex_launch
from scholarseed_codex.pool import CodexHostPool, PoolReservation
from scholarseed_codex.profile import (
    CODEX_DISPLAY_NAME,
    CODEX_PROTOCOL_SCHEMA_HASH,
    CODEX_PROTOCOL_VERSION,
    CODEX_RUNTIME_VERSION_RANGE,
    capabilities,
    resumed_capabilities,
)
from scholarseed_codex.protocol.control import CodexControlRequest
from scholarseed_codex.protocol.session import CodexRuntimeIdentity
from scholarseed_codex.protocol.state import CODEX_RUNTIME_ID, AppServerError, CodexActivationStage
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_codex.utils import json_value
from scholarseed_runtime.contract import (
    CommandReceipt,
    CommandState,
    InventoryKind,
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
from scholarseed_runtime.contract.command import SkillConfigurationRequest
from scholarseed_runtime.contract.evidence import NOOP_RUNTIME_TIMING, RuntimeTimingPort
from scholarseed_runtime.contract.resource import (
    RESOURCE_RESERVATION_INVALID,
    ResourcePolicy,
    ResourcePurpose,
    ResourceReceipt,
    ResourceRequest,
    ResourceState,
)
from scholarseed_runtime.contract.runtime import ProviderConfiguration

PROVIDER_CONFIGURE_COMMAND = "provider.configure"
PROVIDER_CONFIGURATION_INVALID = "runtime_provider_configuration_invalid"
PROVIDER_CONFIGURATION_CONFLICT = "runtime_provider_configuration_conflict"

ENVIRONMENT_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
RESOURCE_TERMINAL_STATES = frozenset(
    {ResourceState.REJECTED, ResourceState.CANCELLED, ResourceState.EXPIRED}
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
    request: OpenSessionRequest | RuntimeInspectionRequest,
) -> dict[str, str]:
    bindings = request.launch_secrets.bindings
    if any(
        not ENVIRONMENT_NAME_PATTERN.fullmatch(name)
        for name in request.launch_secrets.remove_environment
    ):
        raise ValueError("runtime removed environment name is invalid")
    if not bindings:
        return {}
    if request.secret_port is None:
        raise ValueError("runtime secret port is required")
    environment: dict[str, str] = {}
    for binding in bindings:
        if not ENVIRONMENT_NAME_PATTERN.fullmatch(binding.name):
            raise ValueError("runtime secret environment name is invalid")
        if binding.name in environment:
            raise ValueError("runtime secret environment name is duplicated")
        material = await request.secret_port.resolve(binding.secret_ref)
        environment[binding.name] = material.value
    return environment


class CodexRuntimeProvider:
    """Provider discovered through the public ``scholarseed_runtime.providers`` entry point."""

    def __init__(self) -> None:
        self._pool = CodexHostPool()
        self._configuration: CapacityPolicy | None = None
        self._prepared: dict[str, tuple[ResourceRequest, CodexRuntimeSession, PoolReservation]] = {}
        self._prepare_lock = asyncio.Lock()
        self._request_fingerprints: dict[str, str] = {}

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
        if self._configuration is not None and self._configuration != policy:
            return CommandReceipt(
                PROVIDER_CONFIGURE_COMMAND,
                CommandState.REJECTED,
                safe_error=PROVIDER_CONFIGURATION_CONFLICT,
            )
        if self._configuration is None:
            if self._prepared or any(row.used for row in self._pool.snapshot()):
                return CommandReceipt(
                    PROVIDER_CONFIGURE_COMMAND,
                    CommandState.REJECTED,
                    safe_error=PROVIDER_CONFIGURATION_CONFLICT,
                )
            self._pool = CodexHostPool(policy)
            self._configuration = policy
        return CommandReceipt(PROVIDER_CONFIGURE_COMMAND, CommandState.APPLIED)

    @property
    def resource_policy(self) -> ResourcePolicy:
        return ResourcePolicy(self._pool.policy.wait_seconds, self._pool.policy.idle_seconds)

    @staticmethod
    def _open_request(request: OpenSessionRequest | ResumeSessionRequest) -> OpenSessionRequest:
        if isinstance(request, OpenSessionRequest):
            return replace(request, reservation_id="")
        binding = request.binding
        if binding.runtime_id != CODEX_RUNTIME_ID:
            raise ValueError("runtime binding belongs to a different provider")
        return OpenSessionRequest(
            product_session_id=binding.product_session_id,
            cwd=request.cwd,
            model=request.model,
            credential_port=request.credential_port,
            launch_secrets=request.launch_secrets,
            secret_port=request.secret_port,
            permission=request.permission,
            base_instructions=request.base_instructions,
            developer_instructions=request.developer_instructions,
            skill_roots=request.skill_roots,
            skill_configurations=request.skill_configurations,
            artifact_directives=request.artifact_directives,
            required_capabilities=resumed_capabilities(binding),
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
            fingerprint = sha256(repr(request).encode()).hexdigest()
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
            with timing.measure(CodexActivationStage.LAUNCH_CREDENTIALS):
                launch_environment = await _resolve_launch_secrets(open_request)
            session = CodexRuntimeSession(
                open_request,
                resume_binding=(
                    request.session_request.binding
                    if isinstance(request.session_request, ResumeSessionRequest)
                    else None
                ),
                launch_environment=launch_environment,
                host_pool=self._pool,
            )
            reservation = await session.prepare_resource(request.request_id, request.deadline)
            receipt = self._pool.receipt(reservation)
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

    async def _control(
        self,
        *,
        cwd: Path,
        roots: tuple[Path, ...],
        environment: dict[str, str],
        authentication_required: bool,
        remove_environment: tuple[str, ...] = (),
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
    ) -> CodexRuntimeControl:
        executable = configured_codex_executable()
        runtime_home = prepare_codex_runtime_home(native_authentication=authentication_required)
        process_environment, launch_arguments = managed_codex_launch(
            runtime_home,
            environment,
            (),
        )
        control = CodexRuntimeControl(
            CodexControlRequest(
                request_id=f"runtime-inspect-{uuid.uuid4().hex}",
                runtime_id=CODEX_RUNTIME_ID,
                cwd=cwd,
                executable=executable,
                identity=CodexRuntimeIdentity(
                    client_name="scholarseed_desktop",
                    client_title="书深",
                    service_name="scholarseed",
                ),
                skill_roots=roots,
                process_environment=process_environment,
                remove_environment=remove_environment,
                launch_arguments=launch_arguments,
                authentication_required=authentication_required,
                timing=timing,
            ),
            host_pool=self._pool,
        )
        await control.open()
        return control

    async def configure_skills(self, request: SkillConfigurationRequest) -> CommandReceipt:
        control = await self._control(
            cwd=request.cwd,
            roots=request.roots,
            environment={},
            authentication_required=False,
            timing=request.timing,
        )
        try:
            for skill in request.skills:
                await control.skill_control.configure(skill.path, skill.enabled)
            await control.skill_control.list_skills(force_reload=True)
            return CommandReceipt("skills.configure", CommandState.APPLIED)
        finally:
            await control.aclose()

    async def inspect(self, request: RuntimeInspectionRequest) -> RuntimeInventory:
        """Inspect App Server state without creating or resuming a Codex thread."""

        with request.timing.measure(CodexActivationStage.LAUNCH_CREDENTIALS):
            environment = await _resolve_launch_secrets(request)
        control = await self._control(
            cwd=request.cwd,
            roots=request.roots,
            environment=environment,
            remove_environment=request.launch_secrets.remove_environment,
            authentication_required=InventoryKind.MODELS in request.inventory.kinds,
            timing=request.timing,
        )
        try:
            values: dict[str, RuntimeValue] = {}
            revisions: list[str] = []
            for kind in request.inventory.kinds:
                if kind is InventoryKind.MODELS:
                    models = await control.model_control.list_models()
                    values[kind.value] = json_value(models)
                elif kind is InventoryKind.SKILLS:
                    skills = await control.skill_control.list_skills(
                        cwd=request.cwd,
                        force_reload=request.inventory.refresh,
                    )
                    revisions.append(skills.revision)
                    values[kind.value] = json_value(skills)
                else:
                    raise ValueError(f"pre-session inventory is unsupported: {kind.value}")
            return RuntimeInventory(
                revision=":".join(part for part in revisions if part),
                values=values,
            )
        finally:
            await control.aclose()

    async def open(self, request: OpenSessionRequest) -> RuntimeSession:
        return await self._materialize(request)

    async def resume(self, request: ResumeSessionRequest) -> RuntimeSession:
        return await self._materialize(request)

    async def shutdown(self) -> CommandReceipt:
        await self._pool.aclose()
        self._prepared.clear()
        self._request_fingerprints.clear()
        return CommandReceipt("shutdown", CommandState.APPLIED)


def provider() -> RuntimeProvider:
    return CodexRuntimeProvider()


__all__ = ["CodexRuntimeProvider", "provider"]
