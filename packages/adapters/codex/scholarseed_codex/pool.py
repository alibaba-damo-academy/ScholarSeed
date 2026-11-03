"""Product runtime pool ownership."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import uuid
from collections import OrderedDict, deque
from collections.abc import AsyncIterator, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import asdict, dataclass, field
from functools import partial
from pathlib import Path
from time import monotonic, time
from typing import Any, Coroutine, Mapping
from weakref import ReferenceType, ref

from scholarseed_codex import catalog
from scholarseed_codex.capacity import (
    CODEX_HOST_START_FAILED,
    CODEX_POOL_CLOSE_ERROR,
    CODEX_THREAD_UNLOAD_CONFIG,
    HOST_LEASE_RELEASED,
    PENDING_RESOURCE_STATES,
    SHAREABLE_HOST_STATES,
    CapacityPolicy,
    HostRole,
    HostState,
)
from scholarseed_codex.command import _finish
from scholarseed_codex.configuration import NativeMcpConfiguration
from scholarseed_codex.coordination import McpCoordinator
from scholarseed_codex.environment import (
    CODEX_HOME_ENV,
    CODEX_REMOTE_AUTH_CONFIG,
    CODEX_REMOTE_CONFIG_OPTION,
    CODEX_RUNTIME_HOME,
    prepare_codex_runtime_home,
    process_environment_snapshot,
    runtime_home,
    store_model_catalog,
)
from scholarseed_codex.executable import (
    _probe_codex_cli_readiness,
    _resolve_launch_arguments,
    discover_codex_executable,
)
from scholarseed_codex.launch import CODEX_SKILLS_POLICY_UNSUPPORTED
from scholarseed_codex.permission import sandbox_policy
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.projection import CodexConfigurationEditor
from scholarseed_codex.protocol.session import (
    CodexRuntimeIdentity,
    CodexRuntimeLaunchArgument,
    CodexRuntimeReadiness,
    CodexSessionOpenRequest,
)
from scholarseed_codex.protocol.state import (
    CODEX_DIAGNOSTIC_ENCODING,
    CODEX_PREFLIGHT_TIMEOUT_ERROR,
    CODEX_READINESS_CACHE_TTL_SECONDS,
    CODEX_UNAVAILABLE_ERROR,
    AppServerError,
    CodexActivationStage,
    normalized_roots,
)
from scholarseed_codex.sandbox import SANDBOX_ARGUMENT, SANDBOX_SETUP_TIMEOUT_SECONDS
from scholarseed_runtime.contract.evidence import NOOP_RUNTIME_TIMING, RuntimeTimingPort
from scholarseed_runtime.contract.incident import RuntimeRetryability
from scholarseed_runtime.contract.inventory import SkillPolicy
from scholarseed_runtime.contract.mcp import MCP_CONFIGURATION_UNSUPPORTED, McpConfigurationReceipt
from scholarseed_runtime.contract.model import ModelIntent
from scholarseed_runtime.contract.resource import (
    RESOURCE_CANCELLED,
    RESOURCE_HOST_BUSY,
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    RESOURCE_HOST_CONTEXT_REQUIRED,
    RESOURCE_LIFECYCLE_LOGGER,
    RESOURCE_QUEUE_FULL,
    RESOURCE_RESERVATION_INVALID,
    RESOURCE_WAIT_TIMEOUT,
    ResourceCapacity,
    ResourceEvidence,
    ResourceLease,
    ResourceReceipt,
    ResourceState,
)
from scholarseed_runtime.contract.sandbox import (
    SANDBOX_PREPARING_ERROR,
    SandboxRecovery,
    SandboxResources,
)
from scholarseed_runtime.contract.session import RUNTIME_SUSPEND_BUSY, RUNTIME_SUSPEND_STALE

logger = logging.getLogger(RESOURCE_LIFECYCLE_LOGGER)
# A child of the lifecycle logger: it inherits that logger's configured level, so the record
# survives the desktop's default root WARNING, while staying out of the ResourceEvidence stream
# consumers read off the parent.
READINESS_LOGGER = f"{RESOURCE_LIFECYCLE_LOGGER}.readiness"
readiness_logger = logging.getLogger(READINESS_LOGGER)
POOL_RESOURCE_LOG = "codex_resource_lifecycle"
POOL_READINESS_LOG = "codex_pooled_readiness_fallback"
POOL_LEASE_RELEASED = "released"
POOL_HOST_EXITED = "exited"
POOL_CLOSE_FAILED = "close_failed"

ReadinessKey = tuple[str, str]


def _readiness_cache_key(
    executable: str,
    process_environment: Mapping[str, str] | None,
) -> ReadinessKey:
    """Cache executable compatibility per runtime Home, never credentials."""

    environment = process_environment or {}
    return (executable, str(environment.get(CODEX_HOME_ENV, "")))


def _environment_digest(
    process_environment: Mapping[str, str],
    resolved_arguments: tuple[str, ...],
) -> str:
    """Stable digest of everything that changes what the launched process sees."""

    return hashlib.sha256(
        json.dumps(
            {
                "environment": sorted(process_environment.items()),
                "arguments": resolved_arguments,
            },
            sort_keys=True,
        ).encode(CODEX_DIAGNOSTIC_ENCODING)
    ).hexdigest()


@dataclass
class _HostSlot:
    key: tuple[str, CodexRuntimeIdentity, str, HostRole] = field(repr=False)
    host: CodexProcessHost = field(repr=False)
    host_id: str
    role: HostRole
    state: HostState = HostState.STARTING
    owners: set[str] = field(default_factory=set)
    startup: asyncio.Task[None] | None = field(default=None, repr=False)
    closing: asyncio.Task[None] | None = field(default=None, repr=False)
    startup_error: str = ""
    startup_retryability: RuntimeRetryability | None = None
    startup_wait_seconds: float | None = None
    close_safe: bool = False
    close_generation: int = 0
    idle_timer: asyncio.TimerHandle | None = field(default=None, repr=False)
    resource_lease: ResourceLease | None = field(default=None, repr=False)


@dataclass
class PoolReservation:
    """Admission state; settled lets the provider release prepared secret material."""

    request_id: str
    reservation_id: str
    role: HostRole
    deadline: float
    key: tuple[str, CodexRuntimeIdentity, str, HostRole] = field(repr=False)
    fingerprint: str = field(repr=False)
    arguments: dict[str, Any] = field(repr=False)
    future: asyncio.Future[None] = field(repr=False)
    settled: asyncio.Future[ResourceState] = field(repr=False)
    state: ResourceState = ResourceState.WAITING
    slot: _HostSlot | None = field(default=None, repr=False)
    safe_error: str = ""
    authority: str = field(default="", repr=False)
    expiry: asyncio.TimerHandle | None = field(default=None, repr=False)
    closing: asyncio.Task[None] | None = field(default=None, repr=False)
    _host_id: str = ""
    _generation: int = 0
    _phase: str = ""
    _released: bool = False
    timing: RuntimeTimingPort = field(default=NOOP_RUNTIME_TIMING, repr=False, compare=False)

    @property
    def host_id(self) -> str:
        return self.slot.host_id if self.slot is not None else self._host_id

    @property
    def lease_id(self) -> str:
        return self.reservation_id if self.host_id else ""

    @property
    def process_generation(self) -> int:
        if self.slot is not None:
            return self.slot.host.readiness.process_generation
        return self._generation

    @property
    def phase(self) -> str:
        if self.slot is not None:
            return self.slot.state.value
        return self._phase or self.state.value


class HostLease:
    """One idempotent owner of a physical host, including its shutdown obligation."""

    def __init__(self, pool: "CodexHostPool", reservation: PoolReservation) -> None:
        if reservation.slot is None:
            raise ValueError(RESOURCE_RESERVATION_INVALID)
        self.host = reservation.slot.host
        self.host_id = reservation.slot.host_id
        self.lease_id = reservation.reservation_id
        self.request_id = reservation.request_id
        self.role = reservation.role
        self._pool = pool
        self._reservation = reservation
        self._closing: asyncio.Task[None] | None = None

    @property
    def evidence(self) -> ResourceEvidence:
        return self._pool.evidence(self._reservation)

    async def close(
        self, *, safe: bool = False, expected_generation: int | None = None, retain: bool = False
    ) -> None:
        if self._closing is None:
            if safe and expected_generation is None:
                expected_generation = self.host.readiness.process_generation
            self._closing = self._pool._background(
                self._pool._release(
                    self._reservation,
                    safe=safe,
                    expected_generation=expected_generation,
                    retain=retain,
                )
            )
        await asyncio.shield(self._closing)

    async def retry_close(self, *, expected_generation: int, retain: bool = False) -> None:
        """Ensure a safe close, or retry a rejected pre-EOF close in its original generation."""
        if self._closing is None:
            # The preceding thread unsubscribe may have failed before lease release began.
            if expected_generation != self.host.readiness.process_generation:
                raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
            await self.close(safe=True, expected_generation=expected_generation, retain=retain)
            return
        if self._closing.done() and not self._closing.cancelled():
            if self._closing.exception() is not None:
                self._closing = self._pool._background(
                    self._pool._retry_release(self._reservation, expected_generation)
                )
        await asyncio.shield(self._closing)


class CodexHostPool:
    """Bound starting, resident and stopping hosts, with one physical close per slot."""

    def __init__(
        self,
        policy: CapacityPolicy = CapacityPolicy(),
        *,
        resource_lease: Callable[[], ResourceLease] | None = None,
        mcp_editor: CodexConfigurationEditor | None = None,
        sandbox_resources: SandboxResources | None = None,
        sandbox_recovery: SandboxRecovery | None = None,
    ) -> None:
        self.policy = policy
        self._resource_lease = resource_lease
        self._sandbox_resources = sandbox_resources
        self._sandbox_recovery = sandbox_recovery
        self._commands: dict[str, tuple[ResourceLease | None, asyncio.Event]] = {}
        self._publication = asyncio.Lock()
        self._mcp = (
            McpCoordinator(mcp_editor, publication=self._publication)
            if mcp_editor is not None
            else None
        )
        self._hosts: dict[tuple[str, CodexRuntimeIdentity, str, HostRole], _HostSlot] = {}
        self._reservations: dict[str, PoolReservation] = {}
        self._requests: dict[str, str] = {}
        self._waiting: dict[HostRole, deque[PoolReservation]] = {role: deque() for role in HostRole}
        self._tombstones: OrderedDict[str, asyncio.TimerHandle] = OrderedDict()
        self._background_tasks: set[asyncio.Task[None]] = set()
        self._lock = asyncio.Lock()
        self._sandbox_setup_locks: dict[str, asyncio.Lock] = {}
        self._closed = False
        self._closing: asyncio.Task[None] | None = None
        self._readiness_cache: dict[ReadinessKey, tuple[float, CodexRuntimeReadiness]] = {}
        self._readiness_probe_lock = asyncio.Lock()
        self._pooled_readiness_signature = ""
        self._execution_key: tuple[str, CodexRuntimeIdentity, str, HostRole] | None = None
        self._execution_authority: str | None = None
        self._execution_catalog: catalog.ModelCatalogSnapshot | None = None
        self._catalog_candidates: dict[
            int, tuple[ReferenceType[CodexRuntimeLaunchArgument], catalog.ModelCatalogSnapshot]
        ] = {}
        self._control_error = ""

    def configure_mcp(self, configuration: NativeMcpConfiguration) -> McpConfigurationReceipt:
        if self._mcp is None:
            raise ValueError(MCP_CONFIGURATION_UNSUPPORTED)
        return self._mcp.submit(configuration)

    @property
    def execution_configured(self) -> bool:
        return self._execution_key is not None

    async def mcp_configuration(self) -> McpConfigurationReceipt:
        if self._mcp is None:
            raise ValueError(MCP_CONFIGURATION_UNSUPPORTED)
        return await self._mcp.refresh()

    @property
    def mcp_configuration_enabled(self) -> bool:
        return self._mcp is not None

    def reload_mcp(self) -> McpConfigurationReceipt:
        if self._mcp is None:
            raise ValueError(MCP_CONFIGURATION_UNSUPPORTED)
        return self._mcp.reload()

    async def probe_readiness(
        self,
        executable: str = "",
        *,
        process_environment: Mapping[str, str] | None = None,
        prefer_pooled: bool = False,
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
    ) -> CodexRuntimeReadiness:
        # The isolated version probe does not access persistent credentials.
        pooled = _pooled_runtime_readiness(self, executable) if prefer_pooled else None
        async with self._command_admission():
            if pooled is not None:
                return pooled
            return await self._probe_readiness(
                executable,
                process_environment=process_environment,
                prefer_pooled=prefer_pooled,
                timing=timing,
            )

    @asynccontextmanager
    async def _command_admission(self) -> AsyncIterator[None]:
        if self._closed:
            raise AppServerError("runtime pool is closed", safe_error=CODEX_UNAVAILABLE_ERROR)
        key, finished = str(uuid.uuid4()), asyncio.Event()
        self._commands[key] = (None, finished)
        try:
            yield
        finally:
            cleanup = asyncio.create_task(self._close_command(key))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                await _finish(cleanup)
                raise
            finally:
                finished.set()

    async def _close_command(self, key: str) -> None:
        resource, _ = self._commands[key]
        if resource is not None:
            resource.close()
        self._commands.pop(key)

    async def require_skill_policy(self, policy: SkillPolicy, executable: str) -> None:
        if policy is not SkillPolicy.INHERIT:
            raise AppServerError(
                CODEX_SKILLS_POLICY_UNSUPPORTED, safe_error=CODEX_SKILLS_POLICY_UNSUPPORTED
            )

    async def native_catalog(self, request: CodexSessionOpenRequest) -> dict[str, Any]:
        self.authorize_scope(request.process_sharing_scope)
        if request.provider_configuration:
            if self._mcp is None:
                raise AppServerError(
                    RESOURCE_HOST_CONTEXT_REQUIRED, safe_error=RESOURCE_HOST_CONTEXT_REQUIRED
                )
            async with self._mcp.catalog_configuration(request.provider_configuration):
                return await self._native_catalog(request)
        return await self._native_catalog(request)

    async def model_catalog_argument(
        self, intent: ModelIntent, request: CodexSessionOpenRequest
    ) -> CodexRuntimeLaunchArgument:
        async with self._lock:
            self.authorize_scope(request.process_sharing_scope)
            if (
                self._execution_catalog is not None
                and self._execution_catalog.path.parent.parent
                == Path(request.process_environment[CODEX_HOME_ENV])
                and self._execution_catalog.declares(intent)
            ):
                return self._catalog_argument(self._execution_catalog, request)

        async def select(candidate: catalog.ModelCatalogSnapshot) -> CodexRuntimeLaunchArgument:
            async with self._lock:
                self.authorize_scope(request.process_sharing_scope)
                snapshot = self._execution_catalog
                if (
                    snapshot is None
                    or snapshot.path.parent != candidate.path.parent
                    or not snapshot.covers(candidate)
                ):
                    snapshot = candidate
                return self._catalog_argument(snapshot, request)

        return await catalog.model_catalog_argument(
            intent, request, native=self.native_catalog, select=select
        )

    def _catalog_argument(
        self, snapshot: catalog.ModelCatalogSnapshot, request: CodexSessionOpenRequest
    ) -> CodexRuntimeLaunchArgument:
        path = store_model_catalog(
            Path(request.process_environment[CODEX_HOME_ENV]), snapshot.document
        )
        if path != snapshot.path:
            raise ValueError(catalog.CATALOG_CONFLICT_ERROR)
        argument = snapshot.argument
        identifier = id(argument)
        self._catalog_candidates[identifier] = (
            ref(argument, partial(self._forget_catalog_candidate, identifier)),
            snapshot,
        )
        return argument

    def _forget_catalog_candidate(
        self, identifier: int, reference: ReferenceType[CodexRuntimeLaunchArgument]
    ) -> None:
        candidate = self._catalog_candidates.get(identifier)
        if candidate is not None and candidate[0] is reference:
            self._catalog_candidates.pop(identifier)

    async def _native_catalog(self, request: CodexSessionOpenRequest) -> dict[str, Any]:
        return await catalog.native_catalog(request)

    async def _probe_readiness(
        self,
        executable: str = "",
        *,
        process_environment: Mapping[str, str] | None = None,
        prefer_pooled: bool = False,
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
    ) -> CodexRuntimeReadiness:
        """Probe runtime execution capability, folding repeats inside one TTL window."""

        if prefer_pooled:
            pooled = _pooled_runtime_readiness(self, executable)
            if pooled is not None:
                return pooled
        # Version readiness does not own runtime storage initialization. Resolve
        # the declared home without creating it; real host startup owns prepare.
        environment = (
            {CODEX_HOME_ENV: str(runtime_home())}
            if process_environment is None
            else process_environment
        )
        resolved = discover_codex_executable(executable)
        key = _readiness_cache_key(resolved or executable, environment)
        cached = self._cached_readiness(key)
        if cached is not None:
            return cached
        async with AsyncExitStack() as readiness_scope:
            with timing.measure(CodexActivationStage.READINESS_LOCK_WAIT):
                await readiness_scope.enter_async_context(self._readiness_probe_lock)
            # 锁内重查: 并发的重复预检应该收敛成一次真实探测, 而不是排队各跑一遍。
            cached = self._cached_readiness(key)
            if cached is not None:
                return cached
            with timing.measure(CodexActivationStage.READINESS_PROBE):
                readiness = await _probe_codex_cli_readiness(
                    resolved or executable,
                    process_environment=environment,
                )
            # 「问不出结论」不进缓存 —— 一次机器繁忙导致的超时不该把未知态钉住一整个 TTL。
            if readiness.safe_error != CODEX_PREFLIGHT_TIMEOUT_ERROR:
                self._readiness_cache[key] = (monotonic(), readiness)
            return readiness

    def _cached_readiness(self, key: ReadinessKey) -> CodexRuntimeReadiness | None:
        entry = self._readiness_cache.get(key)
        if entry is None:
            return None
        probed_at, readiness = entry
        if monotonic() - probed_at >= CODEX_READINESS_CACHE_TTL_SECONDS:
            return None
        return readiness

    def snapshot(self) -> tuple[ResourceCapacity, ...]:
        return tuple(
            ResourceCapacity(
                role=role.value,
                limit=self.policy.limit(role),
                used=sum(slot.role is role for slot in self._hosts.values()),
                waiting=sum(row.state is ResourceState.WAITING for row in self._waiting[role]),
            )
            for role in HostRole
        )

    def reservation(self, reservation_id: str) -> PoolReservation | None:
        """Look up live admission or a retained terminal receipt without resolving secrets."""
        return self._reservations.get(reservation_id)

    def reservation_for(self, request_id: str) -> PoolReservation | None:
        reservation_id = self._requests.get(request_id)
        return self._reservations.get(reservation_id) if reservation_id is not None else None

    def receipt(self, reservation: PoolReservation) -> ResourceReceipt:
        return ResourceReceipt(
            request_id=reservation.request_id,
            reservation_id=reservation.reservation_id,
            state=reservation.state,
            capacity=self.snapshot(),
            safe_error=reservation.safe_error,
            deadline=reservation.deadline,
            evidence=self.evidence(reservation),
        )

    def evidence(self, reservation: PoolReservation) -> ResourceEvidence:
        return ResourceEvidence(
            event_id=uuid.uuid4().hex,
            request_id=reservation.request_id,
            reservation_id=reservation.reservation_id,
            host_id=reservation.host_id,
            lease_id=reservation.lease_id,
            role=reservation.role.value,
            state=reservation.phase,
            observed_at=time(),
            capacity=self.snapshot(),
            process_generation=reservation.process_generation,
        )

    def _log_resource(self, reservation: PoolReservation, transition: str) -> None:
        # Serialize only the public evidence allowlist, never reservation arguments or keys.
        self._log_evidence(self.evidence(reservation), transition, reservation.state.value)

    def _log_slot(self, slot: _HostSlot, transition: str) -> None:
        reservation = next(
            (value for value in self._reservations.values() if value.host_id == slot.host_id), None
        )
        evidence = ResourceEvidence(
            event_id=uuid.uuid4().hex,
            request_id=reservation.request_id if reservation is not None else "",
            reservation_id=reservation.reservation_id if reservation is not None else "",
            host_id=slot.host_id,
            lease_id=reservation.lease_id if reservation is not None else "",
            role=slot.role.value,
            state=slot.state.value,
            observed_at=time(),
            capacity=self.snapshot(),
            process_generation=slot.host.readiness.process_generation,
        )
        self._log_evidence(evidence, transition, reservation.state.value if reservation else "")

    def _log_evidence(
        self, evidence: ResourceEvidence, transition: str, reservation_state: str
    ) -> None:
        payload = {
            **asdict(evidence),
            "capacity": [asdict(row) for row in evidence.capacity],
            "transition": transition,
            "reservation_state": reservation_state,
        }
        logger.info(
            "%s %s",
            POOL_RESOURCE_LOG,
            json.dumps(payload, sort_keys=True),
            extra={"resource_evidence": payload},
        )

    def _background(self, coroutine: Coroutine[Any, Any, None]) -> asyncio.Task[None]:
        task = asyncio.create_task(coroutine)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_done)
        return task

    def _background_done(self, task: asyncio.Task[None]) -> None:
        self._background_tasks.discard(task)
        # The owning slot/lease retains the outcome for callers to inspect/retry.
        if not task.cancelled():
            task.exception()

    def _existing(self, request_id: str, fingerprint: str) -> PoolReservation | None:
        reservation_id = self._requests.get(request_id)
        if reservation_id is None:
            return None
        existing = self._reservations[reservation_id]
        if existing.fingerprint != fingerprint:
            raise AppServerError(
                RESOURCE_RESERVATION_INVALID, safe_error=RESOURCE_RESERVATION_INVALID
            )
        return existing

    async def reserve(
        self,
        request: CodexSessionOpenRequest,
        *,
        role: HostRole,
        request_id: str,
        deadline: float,
    ) -> PoolReservation:
        if role is not HostRole.EXECUTION or not isinstance(request, CodexSessionOpenRequest):
            raise AppServerError(
                RESOURCE_HOST_CONTEXT_REQUIRED, safe_error=RESOURCE_HOST_CONTEXT_REQUIRED
            )
        self.authorize_scope(request.process_sharing_scope)
        await self.require_skill_policy(request.skill_policy, request.executable)
        if request.provider_configuration and self._mcp is None:
            raise AppServerError(
                RESOURCE_HOST_CONTEXT_REQUIRED, safe_error=RESOURCE_HOST_CONTEXT_REQUIRED
            )
        if (
            not isinstance(request_id, str)
            or not request_id.strip()
            or not isinstance(role, HostRole)
            or isinstance(deadline, bool)
            or not isinstance(deadline, (float, int))
            or not math.isfinite(deadline)
        ):
            raise AppServerError(
                RESOURCE_RESERVATION_INVALID, safe_error=RESOURCE_RESERVATION_INVALID
            )
        actual_deadline = min(deadline, time() + self.policy.wait_seconds)
        provider_configuration = json.loads(
            json.dumps(request.provider_configuration, allow_nan=False)
        )
        environment = process_environment_snapshot(
            request.process_environment, request.remove_environment
        )
        launch_arguments = (
            *request.launch_arguments,
            CodexRuntimeLaunchArgument(
                option=CODEX_REMOTE_CONFIG_OPTION,
                value=f"{CODEX_THREAD_UNLOAD_CONFIG}={int(self.policy.idle_seconds)}",
            ),
        )
        launch_arguments = (
            *launch_arguments,
            CodexRuntimeLaunchArgument(
                option=CODEX_REMOTE_CONFIG_OPTION, value=CODEX_REMOTE_AUTH_CONFIG
            ),
        )
        resolved_arguments = _resolve_launch_arguments(launch_arguments, environment)
        digest = _environment_digest(
            environment,
            resolved_arguments,
        )
        sharing = isinstance(request, CodexSessionOpenRequest) and bool(
            request.process_sharing_scope
        )
        launch_cwd = (
            (
                request.launch_cwd
                if sharing
                and isinstance(request, CodexSessionOpenRequest)
                and request.launch_cwd is not None
                else request.cwd
            )
            .expanduser()
            .resolve()
        )
        compatibility: dict[str, Any] = {
            "process_digest": digest,
            "provider_configuration": provider_configuration,
            "cwd": str(launch_cwd),
            "skill_roots": sorted(
                {str(root.expanduser().resolve()) for root in request.skill_roots}
            ),
        }
        if isinstance(request, CodexSessionOpenRequest):
            compatibility.update(
                execution_scope="" if sharing else request.execution_scope,
                process_sharing_scope=request.process_sharing_scope,
            )
        digest = self._digest(compatibility)
        fingerprint = self._digest(
            {
                "process_digest": digest,
                "remove_environment": sorted(set(request.remove_environment)),
                "base_instructions": (
                    request.base_instructions
                    if isinstance(request, CodexSessionOpenRequest)
                    else ""
                ),
                "executable": request.executable,
                "identity": asdict(request.identity),
                "cwd": str(request.cwd),
                "thread_config": (
                    request.thread_config if isinstance(request, CodexSessionOpenRequest) else {}
                ),
                "thread_policy": (
                    {
                        "sandbox": sandbox_policy(
                            request, normalized_roots(request.writable_roots)
                        ),
                        "permissions_profile": request.permissions_profile,
                        "approval_policy": request.approval_policy,
                        "approval_reviewer": request.approval_reviewer,
                    }
                    if isinstance(request, CodexSessionOpenRequest)
                    else {}
                ),
                "role": role.value,
                "request_id": request.request_id,
                "execution_scope": (
                    request.execution_scope if isinstance(request, CodexSessionOpenRequest) else ""
                ),
            }
        )
        resolved = discover_codex_executable(request.executable)
        candidate_key = (resolved or request.executable, request.identity, digest, role)
        async with self._lock:
            existing = self._existing(request_id, fingerprint)
            if existing is not None:
                return existing
            if self._closed or actual_deadline <= time():
                return self._rejected(
                    request_id,
                    role,
                    actual_deadline,
                    (request.executable, request.identity, digest, role),
                    fingerprint,
                    RESOURCE_CANCELLED if self._closed else RESOURCE_WAIT_TIMEOUT,
                )
            if self._execution_conflict(candidate_key):
                return self._rejected(
                    request_id,
                    role,
                    actual_deadline,
                    candidate_key,
                    fingerprint,
                    RESOURCE_HOST_CONFIGURATION_CONFLICT,
                )
        readiness = None
        async with self._lock:
            warm = self._hosts.get((resolved, request.identity, digest, role)) if resolved else None
            if warm is not None and warm.state is HostState.READY and warm.host.readiness.ready:
                readiness = warm.host.readiness
        if readiness is None:
            with request.timing.measure(CodexActivationStage.READINESS):
                readiness = await self.probe_readiness(
                    request.executable,
                    process_environment=environment,
                    timing=request.timing,
                )
        if not readiness.ready:
            raise AppServerError(
                readiness.safe_error or CODEX_UNAVAILABLE_ERROR,
                safe_error=readiness.safe_error or CODEX_UNAVAILABLE_ERROR,
            )
        key = (readiness.executable, request.identity, digest, role)
        async with self._lock:
            existing = self._existing(request_id, fingerprint)
            if existing is not None:
                return existing
            if self._closed or actual_deadline <= time():
                return self._rejected(
                    request_id,
                    role,
                    actual_deadline,
                    key,
                    fingerprint,
                    RESOURCE_CANCELLED if self._closed else RESOURCE_WAIT_TIMEOUT,
                )
            if self._execution_conflict(key):
                return self._rejected(
                    request_id,
                    role,
                    actual_deadline,
                    key,
                    fingerprint,
                    RESOURCE_HOST_CONFIGURATION_CONFLICT,
                )
            self._wake(role)
            slot = self._hosts.get(key)
            used = sum(value.role is role for value in self._hosts.values())
            limit = self.policy.limit(role)
            can_share = (
                slot is not None
                and slot.state in SHAREABLE_HOST_STATES
                and slot.host.reusable
                and not self._waiting[role]
            )
            can_start = slot is None and (limit is None or used < limit) and not self._waiting[role]
            if (
                not can_share
                and not can_start
                and len(self._waiting[role]) >= self.policy.queue_limit
            ):
                return self._rejected(
                    request_id, role, actual_deadline, key, fingerprint, RESOURCE_QUEUE_FULL
                )
            reservation = self._new(request_id, role, actual_deadline, key, fingerprint)
            reservation.authority = self._digest(request.process_sharing_scope)
            reservation.timing = request.timing
            reservation.arguments = {
                "executable": readiness.executable,
                "version": readiness.version,
                "identity": request.identity,
                "launch_cwd": Path(compatibility["cwd"]),
                "process_environment": dict(request.process_environment),
                "launch_environment": environment,
                "remove_environment": request.remove_environment,
                "launch_arguments": launch_arguments,
                "skill_roots": request.skill_roots,
                "provider_configuration": provider_configuration,
            }
            reservation.expiry = asyncio.get_running_loop().call_later(
                max(0.0, actual_deadline - time()), self._expire, reservation.reservation_id
            )
            if can_share or can_start:
                self._grant(reservation)
            else:
                self._waiting[role].append(reservation)
                self._log_resource(reservation, ResourceState.WAITING.value)
                self._wake(role)
            return reservation

    @staticmethod
    def _digest(value: object) -> str:
        return hashlib.sha256(
            json.dumps(value, sort_keys=True).encode(CODEX_DIAGNOSTIC_ENCODING)
        ).hexdigest()

    def _execution_conflict(self, key: tuple[str, CodexRuntimeIdentity, str, HostRole]) -> bool:
        return (
            key[3] is HostRole.EXECUTION
            and self._execution_key is not None
            and key != self._execution_key
        )

    def _new(
        self,
        request_id: str,
        role: HostRole,
        deadline: float,
        key: tuple[str, CodexRuntimeIdentity, str, HostRole],
        fingerprint: str,
    ) -> PoolReservation:
        loop = asyncio.get_running_loop()
        reservation = PoolReservation(
            request_id=request_id,
            reservation_id=uuid.uuid4().hex,
            role=role,
            deadline=deadline,
            key=key,
            fingerprint=fingerprint,
            arguments={},
            future=loop.create_future(),
            settled=loop.create_future(),
        )
        self._reservations[reservation.reservation_id] = reservation
        self._requests[request_id] = reservation.reservation_id
        return reservation

    def _rejected(
        self,
        request_id: str,
        role: HostRole,
        deadline: float,
        key: tuple[str, CodexRuntimeIdentity, str, HostRole],
        fingerprint: str,
        safe_error: str,
    ) -> PoolReservation:
        reservation = self._new(request_id, role, deadline, key, fingerprint)
        self._finish(reservation, ResourceState.REJECTED, safe_error)
        self._remember(reservation)
        return reservation

    def _finish(
        self, reservation: PoolReservation, state: ResourceState, safe_error: str = ""
    ) -> None:
        reservation.state = state
        reservation.safe_error = safe_error
        reservation.arguments.clear()
        if reservation.expiry is not None:
            reservation.expiry.cancel()
            reservation.expiry = None
        if not reservation.future.done():
            reservation.future.set_result(None)
        if not reservation.settled.done():
            reservation.settled.set_result(state)
        self._log_resource(reservation, state.value)

    def _expire(self, reservation_id: str) -> None:
        reservation = self._reservations.get(reservation_id)
        if reservation is not None and reservation.state in PENDING_RESOURCE_STATES:
            self._background(self._expire_reservation(reservation))

    async def _expire_reservation(self, reservation: PoolReservation) -> None:
        await self.cancel(reservation, expired=True)

    def _grant(self, reservation: PoolReservation) -> None:
        if self._control_error:
            self._finish(reservation, ResourceState.REJECTED, self._control_error)
            self._remember(reservation)
            return
        if self._execution_conflict(reservation.key):
            self._finish(reservation, ResourceState.REJECTED, RESOURCE_HOST_CONFIGURATION_CONFLICT)
            self._remember(reservation)
            return
        slot = self._hosts.get(reservation.key)
        if slot is None:
            resource_lease = None
            host_id = uuid.uuid4().hex
            try:
                runtime_home = reservation.arguments["launch_environment"].get(
                    CODEX_HOME_ENV, str(CODEX_RUNTIME_HOME)
                )
                setup_key = os.path.normcase(str(Path(runtime_home).expanduser().resolve()))
                setup_lock = self._sandbox_setup_locks.setdefault(setup_key, asyncio.Lock())
                host = CodexProcessHost(
                    **reservation.arguments,
                    sandbox_setup_lock=setup_lock,
                    sandbox_resources=self._sandbox_resources,
                    sandbox_recovery=self._sandbox_recovery,
                    startup_scope=partial(self._mcp.startup, host_id) if self._mcp else None,
                )
                resource_lease = (
                    self._resource_lease() if self._resource_lease is not None else None
                )
                if self._mcp is not None:
                    self._mcp.register(host_id, host)
            except Exception as error:
                if resource_lease is not None:
                    resource_lease.close()
                self._finish(
                    reservation,
                    ResourceState.REJECTED,
                    (
                        error.safe_error
                        if isinstance(error, AppServerError) and error.safe_error
                        else CODEX_HOST_START_FAILED
                    ),
                )
                self._remember(reservation)
                return
            slot = _HostSlot(
                key=reservation.key,
                host=host,
                host_id=host_id,
                role=reservation.role,
                resource_lease=resource_lease,
                startup_wait_seconds=(
                    SANDBOX_SETUP_TIMEOUT_SECONDS
                    if os.name == "nt"
                    and SANDBOX_ARGUMENT in reservation.arguments["launch_arguments"]
                    else None
                ),
            )
            self._hosts[slot.key] = slot
            if reservation.role is HostRole.EXECUTION:
                self._execution_key = reservation.key
                self._execution_authority = reservation.authority
                self._execution_catalog = next(
                    (
                        self._catalog_candidates[id(argument)][1]
                        for argument in reservation.arguments["launch_arguments"]
                        if id(argument) in self._catalog_candidates
                        and self._catalog_candidates[id(argument)][0]() is argument
                    ),
                    self._execution_catalog,
                )
            slot.startup = self._background(self._start(slot, reservation.timing))
        if slot.idle_timer is not None:
            slot.idle_timer.cancel()
            slot.idle_timer = None
        slot.owners.add(reservation.reservation_id)
        reservation.slot = slot
        reservation.arguments.clear()
        reservation.state = ResourceState.GRANTED
        self._log_resource(reservation, ResourceState.GRANTED.value)
        if not reservation.future.done():
            reservation.future.set_result(None)

    async def _start(self, slot: _HostSlot, timing: RuntimeTimingPort) -> None:
        try:
            with timing.measure(CodexActivationStage.PROCESS_START):
                await slot.host.start()
        except BaseException as error:
            # Preserve the failure at its origin, including chained native errors.
            # Client-facing receipts retain only safe_error; never log launch
            # arguments, environment, authentication or configuration payloads.
            if not isinstance(error, asyncio.CancelledError):
                logger.exception(
                    "codex_host_start_failed host_id=%s role=%s exception_type=%s",
                    slot.host_id,
                    slot.role.value,
                    type(error).__name__,
                )
            slot.startup_error = (
                error.safe_error
                if isinstance(error, AppServerError) and error.safe_error
                else CODEX_HOST_START_FAILED
            )
            slot.startup_retryability = (
                error.retryability if isinstance(error, AppServerError) else None
            )
            async with self._lock:
                for reservation_id in tuple(slot.owners):
                    reservation = self._reservations[reservation_id]
                    self._finish(reservation, ResourceState.REJECTED, slot.startup_error)
                    self._release_locked(reservation, safe=False)
                self._stop_task(slot, safe=False)
            return
        async with self._lock:
            if slot.state is HostState.STARTING:
                slot.state = HostState.READY
                for reservation_id in slot.owners:
                    self._log_resource(self._reservations[reservation_id], HostState.READY.value)
                if not slot.owners:
                    self._stop_task(slot, safe=False)

    def _wake(self, role: HostRole) -> None:
        if self._closed:
            return
        waiting = self._waiting[role]
        while waiting:
            reservation = waiting[0]
            if reservation.state is not ResourceState.WAITING:
                waiting.popleft()
                continue
            if reservation.deadline <= time():
                waiting.popleft()
                self._finish(reservation, ResourceState.EXPIRED, RESOURCE_WAIT_TIMEOUT)
                self._remember(reservation)
                continue
            slot = self._hosts.get(reservation.key)
            if self._execution_conflict(reservation.key):
                waiting.popleft()
                self._finish(
                    reservation, ResourceState.REJECTED, RESOURCE_HOST_CONFIGURATION_CONFLICT
                )
                self._remember(reservation)
                continue
            used = sum(value.role is role for value in self._hosts.values())
            limit = self.policy.limit(role)
            if (
                slot is not None
                and (slot.state not in SHAREABLE_HOST_STATES or not slot.host.reusable)
            ) or (slot is None and limit is not None and used >= limit):
                break
            waiting.popleft()
            self._grant(reservation)

    async def wait(self, reservation: PoolReservation) -> ResourceReceipt:
        with reservation.timing.measure(CodexActivationStage.RESOURCE_WAIT):
            try:
                if reservation.state in PENDING_RESOURCE_STATES and reservation.deadline <= time():
                    await self.cancel(reservation, expired=True)
                if reservation.state is ResourceState.WAITING:
                    await asyncio.wait_for(
                        asyncio.shield(reservation.future),
                        timeout=max(0.0, reservation.deadline - time()),
                    )
            except asyncio.TimeoutError:
                await self.cancel(reservation, expired=True)
            except asyncio.CancelledError:
                await self.cancel(reservation)
                raise
        return self.receipt(reservation)

    async def consume(self, reservation: PoolReservation) -> HostLease:
        await self.wait(reservation)
        async with self._lock:
            if reservation.state is ResourceState.GRANTED and reservation.deadline <= time():
                self._finish(reservation, ResourceState.EXPIRED, RESOURCE_WAIT_TIMEOUT)
                self._release_locked(reservation, safe=False)
            if (
                self._closed
                or reservation.state is not ResourceState.GRANTED
                or self._reservations.get(reservation.reservation_id) is not reservation
            ):
                raise AppServerError(
                    reservation.safe_error or RESOURCE_RESERVATION_INVALID,
                    safe_error=reservation.safe_error or RESOURCE_RESERVATION_INVALID,
                )
            self._finish(reservation, ResourceState.CONSUMED)
            lease = HostLease(self, reservation)
            slot = reservation.slot
        try:
            if slot is None or slot.startup is None:
                raise AppServerError(RESOURCE_RESERVATION_INVALID)
            with reservation.timing.measure(CodexActivationStage.PROCESS_READY_WAIT):
                try:
                    async with asyncio.timeout(slot.startup_wait_seconds):
                        await asyncio.shield(slot.startup)
                except TimeoutError as error:
                    logger.warning("codex_startup_wait event=timeout host_id=%s", slot.host_id)
                    raise AppServerError(
                        "Windows startup is still in progress",
                        safe_error=SANDBOX_PREPARING_ERROR,
                        retryability=RuntimeRetryability.IN_PROGRESS,
                    ) from error
            if slot.startup_error or slot.state is not HostState.READY:
                raise AppServerError(
                    slot.startup_error or CODEX_HOST_START_FAILED,
                    safe_error=slot.startup_error or CODEX_HOST_START_FAILED,
                    retryability=slot.startup_retryability or RuntimeRetryability.USER_RETRYABLE,
                )
            slot.host.admission.require_healthy()
            if not slot.host.readiness.ready:
                recovery = self._background(slot.host.start())
                try:
                    await asyncio.shield(recovery)
                except asyncio.CancelledError:
                    await _finish(recovery)
                    raise
            slot.host.admission.require_healthy()
            if not slot.host.readiness.ready:
                raise AppServerError(CODEX_HOST_START_FAILED, safe_error=CODEX_HOST_START_FAILED)
        except BaseException:
            await lease.close()
            raise
        return lease

    async def cancel(
        self, reservation: PoolReservation, *, expired: bool = False
    ) -> ResourceReceipt:
        async with self._lock:
            if reservation.state in PENDING_RESOURCE_STATES:
                self._finish(
                    reservation,
                    ResourceState.EXPIRED if expired else ResourceState.CANCELLED,
                    RESOURCE_WAIT_TIMEOUT if expired else RESOURCE_CANCELLED,
                )
                if reservation in self._waiting[reservation.role]:
                    self._waiting[reservation.role].remove(reservation)
                self._release_locked(reservation, safe=False)
                self._wake(reservation.role)
            closing = reservation.closing
        if closing is not None:
            await asyncio.shield(closing)
        return self.receipt(reservation)

    def _remember(self, reservation: PoolReservation) -> None:
        if reservation.reservation_id in self._tombstones:
            return
        if reservation.slot is not None:
            return
        self._tombstones[reservation.reservation_id] = asyncio.get_running_loop().call_later(
            self.policy.tombstone_seconds, self._forget, reservation.reservation_id
        )
        while len(self._tombstones) > self.policy.tombstone_limit:
            oldest = next(iter(self._tombstones))
            self._forget(oldest)

    def _forget(self, reservation_id: str) -> None:
        timer = self._tombstones.pop(reservation_id, None)
        if timer is not None:
            timer.cancel()
        reservation = self._reservations.get(reservation_id)
        if reservation is None or reservation.slot is not None:
            return
        self._reservations.pop(reservation_id, None)
        if self._requests.get(reservation.request_id) == reservation_id:
            self._requests.pop(reservation.request_id, None)

    def _detach(self, reservation: PoolReservation, phase: str) -> None:
        reservation._host_id = reservation.host_id
        reservation._generation = reservation.process_generation
        reservation._phase = phase
        reservation.slot = None
        self._log_resource(reservation, POOL_LEASE_RELEASED)
        self._remember(reservation)

    def _release_locked(
        self,
        reservation: PoolReservation,
        *,
        safe: bool,
        expected_generation: int | None = None,
        retain: bool = False,
    ) -> asyncio.Task[None] | None:
        slot = reservation.slot
        if slot is None:
            self._remember(reservation)
            return reservation.closing
        if reservation._released:
            return reservation.closing
        if expected_generation is not None and (
            slot.host.readiness.process_generation != expected_generation
        ):
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        reservation._released = True
        slot.owners.discard(reservation.reservation_id)
        if slot.state is HostState.STOPPED:
            self._detach(reservation, HostState.STOPPED.value)
        elif slot.owners:
            self._detach(reservation, HOST_LEASE_RELEASED)
        elif (
            slot.state is HostState.STARTING
            and not slot.startup_error
            and slot.startup is not None
            and not slot.startup.done()
            and not self._closed
        ):
            # The operation owns the slot, MCP scope and resource lease until it
            # finishes. The last UI waiter is not its lifetime owner.
            self._detach(reservation, HOST_LEASE_RELEASED)
        elif (
            slot.role is HostRole.EXECUTION
            and slot.state is HostState.READY
            and reservation.state is ResourceState.CONSUMED
            and safe
            and retain
            and not self._closed
        ):
            self._detach(reservation, HOST_LEASE_RELEASED)
            slot.idle_timer = asyncio.get_running_loop().call_later(
                self.policy.idle_seconds, self._expire_idle_host, slot
            )
        elif slot.host.reusable and slot.state is HostState.READY and not safe and not self._closed:
            # Reusable hosts retain their physical lease until explicit drain or safe closure.
            self._detach(reservation, HOST_LEASE_RELEASED)
            self._wake(slot.role)
        else:
            reservation.closing = self._stop_task(
                slot, safe=safe, expected_generation=expected_generation
            )
        return reservation.closing

    def _expire_idle_host(self, slot: _HostSlot) -> None:
        self._background(self._close_idle_host(slot))

    async def _close_idle_host(self, slot: _HostSlot) -> None:
        async with self._lock:
            if slot.idle_timer is not None:
                slot.idle_timer.cancel()
            slot.idle_timer = None
            if (
                self._hosts.get(slot.key) is not slot
                or slot.owners
                or self._closed
                or slot.state is HostState.STARTING
            ):
                return
            closing = self._stop_task(slot, safe=True)
        try:
            await asyncio.shield(closing)
        except AppServerError as error:
            if (
                error.safe_error != RUNTIME_SUSPEND_BUSY
                or not slot.close_safe
                or slot.host.stop_committed
            ):
                raise
            async with self._lock:
                if (
                    self._hosts.get(slot.key) is slot
                    and slot.closing is closing
                    and not slot.owners
                    and not self._closed
                ):
                    slot.state = HostState.READY
                    slot.closing = None
                    slot.idle_timer = asyncio.get_running_loop().call_later(
                        self.policy.idle_seconds, self._expire_idle_host, slot
                    )
                    self._wake(slot.role)

    async def _release(
        self,
        reservation: PoolReservation,
        *,
        safe: bool,
        expected_generation: int | None = None,
        retain: bool = False,
    ) -> None:
        async with self._lock:
            closing = self._release_locked(
                reservation, safe=safe, expected_generation=expected_generation, retain=retain
            )
        if closing is not None:
            await asyncio.shield(closing)

    def _stop_task(
        self, slot: _HostSlot, *, safe: bool, expected_generation: int | None = None
    ) -> asyncio.Task[None]:
        if slot.idle_timer is not None:
            slot.idle_timer.cancel()
            slot.idle_timer = None
        if slot.closing is None:
            slot.state = HostState.STOPPING
            generation = (
                slot.host.readiness.process_generation
                if expected_generation is None
                else expected_generation
            )
            slot.close_safe = safe
            slot.close_generation = generation
            slot.closing = self._background(
                self._stop(slot, safe=safe, expected_generation=generation)
            )
            self._log_slot(slot, HostState.STOPPING.value)
        return slot.closing

    async def _retry_release(self, reservation: PoolReservation, expected_generation: int) -> None:
        async with self._lock:
            slot = reservation.slot
            if slot is None:
                if reservation.phase == HostState.STOPPED.value:
                    return
                raise AppServerError(
                    RESOURCE_RESERVATION_INVALID, safe_error=RESOURCE_RESERVATION_INVALID
                )
            closing = slot.closing
            if closing is None:
                raise AppServerError(
                    RESOURCE_RESERVATION_INVALID, safe_error=RESOURCE_RESERVATION_INVALID
                )
            if (
                slot.close_generation != expected_generation
                or slot.host.readiness.process_generation != expected_generation
            ):
                raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
            if closing.done() and not closing.cancelled():
                failure = closing.exception()
                if failure is not None:
                    # Only a rejected quiescence check is known to precede irreversible EOF.
                    if (
                        slot.state is not HostState.STOPPING
                        or not slot.close_safe
                        or slot.host.stop_committed
                        or not isinstance(failure, AppServerError)
                        or failure.safe_error != RUNTIME_SUSPEND_BUSY
                    ):
                        raise failure
                    slot.closing = self._background(
                        self._stop(slot, safe=True, expected_generation=slot.close_generation)
                    )
                    closing = slot.closing
                    reservation.closing = closing
        await asyncio.shield(closing)

    async def _stop(self, slot: _HostSlot, *, safe: bool, expected_generation: int) -> None:
        closed_during_startup = False
        try:
            if slot.startup is not None:
                if not safe and not slot.startup.done():
                    slot.startup.cancel()
                    # Close our app-server transport before joining startup. A
                    # pending completion notification may never arrive after UI
                    # shutdown. Official helpers retain their native setup lock;
                    # this closes only our owned process, never those helpers.
                    await slot.host.aclose()
                    closed_during_startup = True
                    await asyncio.gather(slot.startup, return_exceptions=True)
                    safe = False
                else:
                    await asyncio.shield(slot.startup)
            if safe:
                await slot.host.stop_idle(expected_generation)
            elif not closed_during_startup:
                await slot.host.aclose()
        except BaseException:
            self._log_slot(slot, POOL_CLOSE_FAILED)
            raise
        async with self._lock:
            try:
                if slot.resource_lease is not None:
                    slot.resource_lease.close()
                    slot.resource_lease = None
            except BaseException:
                self._log_slot(slot, POOL_CLOSE_FAILED)
                raise
            slot.state = HostState.STOPPED
            if self._hosts.get(slot.key) is slot:
                self._hosts.pop(slot.key)
            if self._mcp is not None:
                self._mcp.remove(slot.host_id)
            slot.owners.clear()
            reservations = tuple(
                reservation
                for reservation in self._reservations.values()
                if reservation.slot is slot
            )
            self._log_slot(slot, POOL_HOST_EXITED)
            for reservation in reservations:
                self._detach(reservation, HostState.STOPPED.value)
            self._wake(slot.role)

    async def acquire(self, request: CodexSessionOpenRequest) -> HostLease:
        reservation = await self.reserve(
            request,
            role=HostRole.EXECUTION,
            request_id=request.request_id,
            deadline=time() + self.policy.wait_seconds,
        )
        return await self.consume(reservation)

    @asynccontextmanager
    async def control_mutation(self, lease: HostLease) -> AsyncIterator[None]:
        host = lease.host
        async with self._publication:
            admission = host.admission
            if not admission.accepting or admission.active:
                raise AppServerError(RESOURCE_HOST_BUSY, safe_error=RESOURCE_HOST_BUSY)
            revision = admission.desired_revision
            admission.freeze(revision)
            epoch = admission.epoch
            publishing = False
            try:
                ticket = await host.configuration_quiescence(revision)
                if ticket is None or admission.epoch != epoch:
                    raise AppServerError(RESOURCE_HOST_BUSY, safe_error=RESOURCE_HOST_BUSY)
                publishing = True
                yield
                if (
                    admission.epoch != epoch
                    or await host.configuration_quiescence(revision) is None
                ):
                    raise AppServerError(
                        RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
                        safe_error=RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
                    )
                publishing = False
            except BaseException:
                if publishing:
                    self._control_error = RESOURCE_HOST_CONFIGURATION_UNCERTAIN
                    admission.fail(RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
                raise
            finally:
                if admission.epoch == epoch and admission.frozen(revision):
                    admission.applied(revision)

    def authorize_scope(self, scope: str) -> None:
        if self._control_error:
            raise AppServerError(self._control_error, safe_error=self._control_error)
        if not self.matches_scope(scope):
            raise AppServerError(
                RESOURCE_HOST_CONFIGURATION_CONFLICT,
                safe_error=RESOURCE_HOST_CONFIGURATION_CONFLICT,
            )

    def matches_scope(self, scope: str) -> bool:
        return self._execution_authority is None or self._execution_authority == self._digest(scope)

    async def replace_execution_scope(self, scope: str) -> None:
        """Commit an explicit identity handover only after physical resource drain.

        Ordinary reset keeps its authority. A new scope cannot reuse any old host,
        pending reservation, command, or cleanup; late old requests fail admission.
        Uncertain control state is never recoverable through this operation.
        """
        async with self._lock:
            if self._control_error:
                raise AppServerError(self._control_error, safe_error=self._control_error)
            if not scope.strip():
                raise AppServerError(
                    RESOURCE_HOST_CONTEXT_REQUIRED, safe_error=RESOURCE_HOST_CONTEXT_REQUIRED
                )
            if (
                self._closed
                or self._hosts
                or self._commands
                or any(not task.done() for task in self._background_tasks)
                or any(row.state in PENDING_RESOURCE_STATES for row in self._reservations.values())
            ):
                raise AppServerError(RESOURCE_HOST_BUSY, safe_error=RESOURCE_HOST_BUSY)
            self._execution_key = None
            self._execution_catalog = None
            self._execution_authority = self._digest(scope)
            self._readiness_cache.clear()

    def prepare_home(self) -> Path:
        return prepare_codex_runtime_home()

    async def reset_execution_configuration(self, scope: str) -> None:
        async with self._lock:
            self.authorize_scope(scope)
            if (
                self._closed
                or self._hosts
                or self._commands
                or any(not task.done() for task in self._background_tasks)
                or any(row.state in PENDING_RESOURCE_STATES for row in self._reservations.values())
            ):
                raise AppServerError(RESOURCE_HOST_BUSY, safe_error=RESOURCE_HOST_BUSY)
            self._execution_key = None
            self._execution_catalog = None
            self._readiness_cache.clear()

    def fence_reconfiguration(self) -> None:
        self._control_error = RESOURCE_HOST_CONFIGURATION_UNCERTAIN

    async def release_idle(self) -> bool:
        """Release unowned hosts without terminating sessions or closing admission."""
        async with self._lock:
            closing = tuple(
                self._background(self._close_idle_host(slot))
                for slot in self._hosts.values()
                if not slot.owners
            )
        outcomes = await asyncio.gather(
            *(asyncio.shield(task) for task in closing), return_exceptions=True
        )
        errors = [outcome for outcome in outcomes if isinstance(outcome, BaseException)]
        if errors:
            raise BaseExceptionGroup(CODEX_POOL_CLOSE_ERROR, errors)
        async with self._lock:
            return (
                not self._hosts
                and not self._commands
                and not any(
                    row.state in PENDING_RESOURCE_STATES for row in self._reservations.values()
                )
            )

    async def aclose(self) -> None:
        if self._closing is None:
            self._closing = self._background(self._shutdown())
        await asyncio.shield(self._closing)

    async def _shutdown(self) -> None:
        async with self._lock:
            self._closed = True
            for reservation in self._reservations.values():
                if reservation.state in PENDING_RESOURCE_STATES:
                    self._finish(reservation, ResourceState.CANCELLED, RESOURCE_CANCELLED)
            for waiting in self._waiting.values():
                waiting.clear()
            for timer in self._tombstones.values():
                timer.cancel()
            self._tombstones.clear()
        if self._mcp is not None:
            await self._mcp.aclose()
        await asyncio.gather(*(finished.wait() for _, finished in tuple(self._commands.values())))
        if self._commands:
            raise AppServerError(
                "native command cleanup is uncertain", safe_error=CODEX_POOL_CLOSE_ERROR
            )
        async with self._lock:
            closing = tuple(
                self._stop_task(
                    slot, safe=slot.role is HostRole.CONTROL and slot.state is HostState.READY
                )
                for slot in self._hosts.values()
            )
        outcomes = await asyncio.gather(
            *(asyncio.shield(task) for task in closing), return_exceptions=True
        )
        errors = [outcome for outcome in outcomes if isinstance(outcome, BaseException)]
        if errors:
            raise BaseExceptionGroup(CODEX_POOL_CLOSE_ERROR, errors)
        async with self._lock:
            for timer in self._tombstones.values():
                timer.cancel()
            self._tombstones.clear()
            self._reservations.clear()
            self._requests.clear()
            self._readiness_cache.clear()
            self._pooled_readiness_signature = ""
            self._execution_catalog = None
            self._catalog_candidates.clear()


def _pooled_runtime_readiness(
    pool: CodexHostPool, executable: str = ""
) -> CodexRuntimeReadiness | None:
    """A resident host is positive evidence only; it never proves the runtime unusable.

    ``probe_readiness(prefer_pooled=True)`` answers a runtime-level question: can this
    executable be used at all. A pooled slot that is starting, stopping or closing is a
    session-level transient — it says nothing about the executable, so it must not be
    projected as ``ready=False``. Reporting it as such made one activation's ~2s startup
    window surface as ``agent runtime not ready`` to every caller, including sessions that
    already owned a healthy host (AOne bug 86998131). Without a READY host we return
    ``None`` and let the caller fall back to the real CLI probe.
    """

    resolved = discover_codex_executable(executable)
    if not resolved:
        return None
    ready = [
        slot
        for (host_executable, _identity, _environment, _role), slot in pool._hosts.items()
        if host_executable == resolved
        and slot.state is HostState.READY
        and slot.host.readiness.ready
    ]
    if ready:
        # Newest generation wins: it is the most recent successful initialize we observed.
        return max(ready, key=lambda slot: slot.host.readiness.process_generation).host.readiness
    _log_pooled_readiness_fallback(pool, resolved)
    return None


def _log_pooled_readiness_fallback(pool: CodexHostPool, resolved: str) -> None:
    """Record why pooled evidence was declined, deduplicated on the observed slot states.

    ``/api/healthz`` is filtered out of the uvicorn access log, so a readiness dip is
    otherwise invisible. Only slot-scoped identifiers are emitted — never the host key,
    which carries the environment digest and runtime identity.
    """

    slots = [
        {
            "host_id": slot.host_id,
            "role": slot.role.value,
            "slot_state": slot.state.value,
            "process_state": slot.host.readiness.process_state,
            "process_generation": slot.host.readiness.process_generation,
        }
        for (host_executable, _identity, _environment, _role), slot in pool._hosts.items()
        if host_executable == resolved
    ]
    payload = json.dumps(
        {"slots": sorted(slots, key=lambda row: str(row["host_id"]))}, sort_keys=True
    )
    if payload == pool._pooled_readiness_signature:
        return
    pool._pooled_readiness_signature = payload
    readiness_logger.info("%s %s", POOL_READINESS_LOG, payload)
