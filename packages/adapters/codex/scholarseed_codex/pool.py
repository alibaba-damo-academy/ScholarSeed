"""Product runtime pool ownership."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import uuid
from collections import OrderedDict, deque
from contextlib import AsyncExitStack
from dataclasses import asdict, dataclass, field
from time import monotonic, time
from typing import Any, Coroutine, Mapping

from scholarseed_codex.capacity import (
    CODEX_POOL_CLOSE_ERROR,
    HOST_LEASE_RELEASED,
    PENDING_RESOURCE_STATES,
    SHAREABLE_HOST_STATES,
    CapacityPolicy,
    HostRole,
    HostState,
)
from scholarseed_codex.environment import (
    CODEX_HOME_ENV,
    CODEX_REMOTE_AUTH_CONFIG,
    CODEX_REMOTE_CONFIG_OPTION,
    prepare_codex_runtime_home,
)
from scholarseed_codex.executable import (
    _probe_codex_cli_readiness,
    _resolve_launch_arguments,
    discover_codex_executable,
)
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.control import CodexControlRequest
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
)
from scholarseed_runtime.contract.evidence import NOOP_RUNTIME_TIMING, RuntimeTimingPort
from scholarseed_runtime.contract.resource import (
    RESOURCE_CANCELLED,
    RESOURCE_LIFECYCLE_LOGGER,
    RESOURCE_QUEUE_FULL,
    RESOURCE_RESERVATION_INVALID,
    RESOURCE_WAIT_TIMEOUT,
    ResourceCapacity,
    ResourceEvidence,
    ResourceReceipt,
    ResourceState,
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

ReadinessKey = tuple[str, bool, str]


def _readiness_cache_key(
    executable: str,
    authentication_required: bool,
    process_environment: Mapping[str, str] | None,
) -> ReadinessKey:
    """预检结论只随这三项变化: 跑哪个可执行文件、是否要验登录、读哪份 auth.json。

    进程环境里其余项（技能凭据、归属 token 等）不影响 ``--version`` 与登录态判定。把它们
    一起放进键里, 会让带凭据的真实用户路径每次都是新键, 缓存永远命中不了。
    """

    environment = process_environment or {}
    return (executable, authentication_required, str(environment.get(CODEX_HOME_ENV, "")))


def _environment_digest(
    process_environment: Mapping[str, str],
    remove_environment: tuple[str, ...],
    resolved_arguments: tuple[str, ...],
    configuration: Mapping[str, object] | None = None,
    session_scope: str = "",
) -> str:
    """Stable digest of everything that changes what the launched process sees."""

    return hashlib.sha256(
        json.dumps(
            {
                "environment": sorted(process_environment.items()),
                "remove_environment": sorted(set(remove_environment)),
                "arguments": resolved_arguments,
                "configuration": dict(configuration or {}),
                "session_scope": session_scope,
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
    close_safe: bool = False
    close_generation: int = 0


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

    async def close(self, *, safe: bool = False, expected_generation: int | None = None) -> None:
        if self._closing is None:
            if safe and expected_generation is None:
                expected_generation = self.host.readiness.process_generation
            self._closing = self._pool._background(
                self._pool._release(
                    self._reservation, safe=safe, expected_generation=expected_generation
                )
            )
        await asyncio.shield(self._closing)

    async def retry_close(self, *, expected_generation: int) -> None:
        """Ensure a safe close, or retry a rejected pre-EOF close in its original generation."""
        if self._closing is None:
            # The preceding thread unsubscribe may have failed before lease release began.
            if expected_generation != self.host.readiness.process_generation:
                raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
            await self.close(safe=True, expected_generation=expected_generation)
            return
        if self._closing.done() and not self._closing.cancelled():
            if self._closing.exception() is not None:
                self._closing = self._pool._background(
                    self._pool._retry_release(self._reservation, expected_generation)
                )
        await asyncio.shield(self._closing)


class CodexHostPool:
    """Bound starting, resident and stopping hosts, with one physical close per slot."""

    def __init__(self, policy: CapacityPolicy = CapacityPolicy()) -> None:
        self.policy = policy
        self._hosts: dict[tuple[str, CodexRuntimeIdentity, str, HostRole], _HostSlot] = {}
        self._reservations: dict[str, PoolReservation] = {}
        self._requests: dict[str, str] = {}
        self._waiting: dict[HostRole, deque[PoolReservation]] = {role: deque() for role in HostRole}
        self._tombstones: OrderedDict[str, asyncio.TimerHandle] = OrderedDict()
        self._background_tasks: set[asyncio.Task[None]] = set()
        self._lock = asyncio.Lock()
        self._closed = False
        self._closing: asyncio.Task[None] | None = None
        self._readiness_cache: dict[ReadinessKey, tuple[float, CodexRuntimeReadiness]] = {}
        self._readiness_probe_lock = asyncio.Lock()
        self._pooled_readiness_signature = ""

    async def probe_readiness(
        self,
        executable: str = "",
        *,
        authentication_required: bool = False,
        process_environment: Mapping[str, str] | None = None,
        prefer_pooled: bool = False,
        timing: RuntimeTimingPort = NOOP_RUNTIME_TIMING,
    ) -> CodexRuntimeReadiness:
        """Probe runtime execution capability, folding repeats inside one TTL window."""

        if prefer_pooled:
            pooled = _pooled_runtime_readiness(self, executable)
            if pooled is not None:
                return pooled
        key = _readiness_cache_key(executable, authentication_required, process_environment)
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
            environment = process_environment
            if environment is None:
                environment = {CODEX_HOME_ENV: str(prepare_codex_runtime_home())}
            with timing.measure(CodexActivationStage.READINESS_PROBE):
                readiness = await _probe_codex_cli_readiness(
                    executable,
                    authentication_required=authentication_required,
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
        request: CodexSessionOpenRequest | CodexControlRequest,
        *,
        role: HostRole,
        request_id: str,
        deadline: float,
    ) -> PoolReservation:
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
        environment = dict(request.process_environment)
        require_authentication = request.authentication_required
        if require_authentication is None:
            require_authentication = not (
                isinstance(request, CodexSessionOpenRequest) and bool(request.model_provider)
            )
        launch_arguments = request.launch_arguments
        if not require_authentication:
            launch_arguments = (
                *launch_arguments,
                CodexRuntimeLaunchArgument(
                    option=CODEX_REMOTE_CONFIG_OPTION, value=CODEX_REMOTE_AUTH_CONFIG
                ),
            )
        resolved_arguments = _resolve_launch_arguments(
            launch_arguments, environment, request.remove_environment
        )
        configuration = (
            request.thread_config if isinstance(request, CodexSessionOpenRequest) else {}
        )
        session_scope = request.request_id if role is HostRole.EXECUTION else ""
        digest = _environment_digest(
            environment,
            request.remove_environment,
            resolved_arguments,
            configuration,
            session_scope,
        )
        fingerprint = self._digest(
            {
                "process_digest": digest,
                "executable": request.executable,
                "identity": asdict(request.identity),
                "cwd": str(request.cwd),
                "role": role.value,
            }
        )
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
        readiness = None
        resolved = discover_codex_executable(request.executable)
        async with self._lock:
            warm = self._hosts.get((resolved, request.identity, digest, role)) if resolved else None
            if warm is not None and warm.state is HostState.READY and warm.host.readiness.ready:
                readiness = warm.host.readiness
        if readiness is None:
            with request.timing.measure(CodexActivationStage.READINESS):
                readiness = await self.probe_readiness(
                    request.executable,
                    authentication_required=require_authentication,
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
            self._wake(role)
            slot = self._hosts.get(key)
            used = sum(value.role is role for value in self._hosts.values())
            can_share = (
                slot is not None and slot.state in SHAREABLE_HOST_STATES and not self._waiting[role]
            )
            can_start = slot is None and used < self.policy.limit(role) and not self._waiting[role]
            if (
                not can_share
                and not can_start
                and len(self._waiting[role]) >= self.policy.queue_limit
            ):
                return self._rejected(
                    request_id, role, actual_deadline, key, fingerprint, RESOURCE_QUEUE_FULL
                )
            reservation = self._new(request_id, role, actual_deadline, key, fingerprint)
            reservation.timing = request.timing
            reservation.arguments = {
                "executable": readiness.executable,
                "version": readiness.version,
                "identity": request.identity,
                "launch_cwd": request.cwd,
                "process_environment": environment,
                "remove_environment": request.remove_environment,
                "launch_arguments": launch_arguments,
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
        slot = self._hosts.get(reservation.key)
        if slot is None:
            try:
                host = CodexProcessHost(**reservation.arguments)
            except Exception as error:
                self._finish(
                    reservation,
                    ResourceState.REJECTED,
                    (
                        error.safe_error
                        if isinstance(error, AppServerError) and error.safe_error
                        else CODEX_UNAVAILABLE_ERROR
                    ),
                )
                self._remember(reservation)
                return
            slot = _HostSlot(
                key=reservation.key,
                host=host,
                host_id=uuid.uuid4().hex,
                role=reservation.role,
            )
            self._hosts[slot.key] = slot
            slot.startup = self._background(self._start(slot, reservation.timing))
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
            slot.startup_error = (
                error.safe_error
                if isinstance(error, AppServerError) and error.safe_error
                else CODEX_UNAVAILABLE_ERROR
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
            used = sum(value.role is role for value in self._hosts.values())
            if (slot is not None and slot.state not in SHAREABLE_HOST_STATES) or (
                slot is None and used >= self.policy.limit(role)
            ):
                if role is HostRole.CONTROL:
                    idle = next(
                        (
                            candidate
                            for candidate in self._hosts.values()
                            if candidate.role is role
                            and candidate.state is HostState.READY
                            and not candidate.owners
                            and candidate.key != reservation.key
                        ),
                        None,
                    )
                    if idle is not None:
                        self._stop_task(idle, safe=True)
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
                await asyncio.shield(slot.startup)
            if slot.startup_error or slot.state is not HostState.READY:
                raise AppServerError(
                    slot.startup_error or CODEX_UNAVAILABLE_ERROR,
                    safe_error=slot.startup_error or CODEX_UNAVAILABLE_ERROR,
                )
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
        self, reservation: PoolReservation, *, safe: bool, expected_generation: int | None = None
    ) -> asyncio.Task[None] | None:
        slot = reservation.slot
        if slot is None:
            self._remember(reservation)
            return reservation.closing
        if reservation._released:
            return reservation.closing
        reservation._released = True
        slot.owners.discard(reservation.reservation_id)
        if slot.state is HostState.STOPPED:
            self._detach(reservation, HostState.STOPPED.value)
        elif slot.owners:
            self._detach(reservation, HOST_LEASE_RELEASED)
        elif (
            slot.role is HostRole.CONTROL
            and slot.state is HostState.READY
            and reservation.state is ResourceState.CONSUMED
            and not safe
            and not self._closed
        ):
            # Unowned control hosts stay warm inside their own budget until replaced or closed.
            self._detach(reservation, HOST_LEASE_RELEASED)
            self._wake(slot.role)
        else:
            reservation.closing = self._stop_task(
                slot, safe=safe, expected_generation=expected_generation
            )
        return reservation.closing

    async def _release(
        self, reservation: PoolReservation, *, safe: bool, expected_generation: int | None = None
    ) -> None:
        async with self._lock:
            closing = self._release_locked(
                reservation, safe=safe, expected_generation=expected_generation
            )
        if closing is not None:
            await asyncio.shield(closing)

    def _stop_task(
        self, slot: _HostSlot, *, safe: bool, expected_generation: int | None = None
    ) -> asyncio.Task[None]:
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
        try:
            if slot.startup is not None:
                await asyncio.shield(slot.startup)
            if safe:
                await slot.host.stop_idle(expected_generation)
            else:
                await slot.host.aclose()
        except BaseException:
            self._log_slot(slot, POOL_CLOSE_FAILED)
            raise
        async with self._lock:
            # The host methods return only after OS exit; STOPPING retains the slot until here.
            slot.state = HostState.STOPPED
            if self._hosts.get(slot.key) is slot:
                self._hosts.pop(slot.key)
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

    async def acquire_control(self, request: CodexControlRequest) -> HostLease:
        reservation = await self.reserve(
            request,
            role=HostRole.CONTROL,
            request_id=request.request_id,
            deadline=time() + self.policy.wait_seconds,
        )
        return await self.consume(reservation)

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
            closing = tuple(
                self._stop_task(slot, safe=slot.role is HostRole.CONTROL)
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
