"""Cancellable product admission and checkpointed runtime attachment ownership."""

from __future__ import annotations

import asyncio
import time
import uuid
from contextlib import AsyncExitStack
from dataclasses import dataclass, replace
from typing import Any, Awaitable, Callable, Mapping

from scholarseed_runtime.contract import (
    OpenSessionRequest,
    ResumeSessionRequest,
    RuntimeBinding,
    RuntimeProvider,
)
from scholarseed_runtime.contract.evidence import RuntimeTimingPort
from scholarseed_runtime.contract.resource import (
    RESOURCE_CANCELLED,
    RESOURCE_QUEUE_FULL,
    RESOURCE_RESERVATION_INVALID,
    RESOURCE_WAIT_TIMEOUT,
    ResourcePurpose,
    ResourceReceipt,
    ResourceRequest,
    ResourceState,
)
from service.chat.provenance import ModelRun
from service.chat.runtime.live import LiveSession
from service.chat.runtime.timing import ActivationStage

SESSION_OPEN_UNKNOWN = "runtime_session_open_unknown"
SESSION_ACTIVATION_CLOSED = "runtime_session_activation_closed"
ACTIVATION_SAFE_ERRORS = frozenset(
    {
        RESOURCE_CANCELLED,
        RESOURCE_QUEUE_FULL,
        RESOURCE_RESERVATION_INVALID,
        RESOURCE_WAIT_TIMEOUT,
        SESSION_OPEN_UNKNOWN,
        SESSION_ACTIVATION_CLOSED,
    }
)
RESOURCE_SWEEP_INTERVAL_SECONDS = 1.0

ResourceWaitObserver = Callable[[ResourceReceipt, float], Awaitable[None]]


class SessionActivationError(RuntimeError):
    """An admission failure with a closed, user-safe code vocabulary."""

    def __init__(self, safe_error: str) -> None:
        self.safe_error = (
            safe_error if safe_error in ACTIVATION_SAFE_ERRORS else RESOURCE_RESERVATION_INVALID
        )
        super().__init__(self.safe_error)


@dataclass(frozen=True)
class ActivationPlan:
    provider: RuntimeProvider
    request: OpenSessionRequest | ResumeSessionRequest
    revision: tuple[object, ...]
    model_run: ModelRun | None = None
    replaces: RuntimeBinding | None = None


class SessionActivation:
    """Serialize attachments, release idle leases, and leave native execution to providers."""

    def __init__(
        self,
        *,
        build: Callable[[LiveSession], ActivationPlan],
        revision: Callable[[LiveSession], tuple[object, ...]],
        attach: Callable[[LiveSession, ActivationPlan, str], Awaitable[None]],
        provider: Callable[[str], RuntimeProvider],
        prepare: Callable[[LiveSession, RuntimeTimingPort], Awaitable[None]],
        discard: Callable[[LiveSession], None],
        logger: Any,
    ) -> None:
        self._build = build
        self._revision = revision
        self._attach = attach
        self._provider = provider
        self._prepare = prepare
        self._discard = discard
        self._logger = logger
        self._sessions: Mapping[str, LiveSession] = {}
        self._pending: dict[str, asyncio.Task[Any]] = {}
        self._acquisitions: set[asyncio.Task[Any]] = set()
        self._idle_since: dict[str, float] = {}
        self._idle_task: asyncio.Task[None] | None = None
        self._closed = False

    def bind_sessions(self, sessions: Mapping[str, LiveSession]) -> None:
        self._sessions = sessions

    async def start(self) -> None:
        if self._idle_task is None:
            self._idle_task = asyncio.create_task(self._maintain())

    async def ensure_active(
        self,
        live: LiveSession,
        *,
        purpose: ResourcePurpose = ResourcePurpose.SESSION,
        request_id: str = "",
        deadline: float | None = None,
        on_wait: ResourceWaitObserver | None = None,
    ) -> None:
        timing = live.activation_timing(request_id or live.id)
        async with AsyncExitStack() as activation_scope:
            activation_scope.enter_context(timing.measure(ActivationStage.TOTAL))
            with timing.measure(ActivationStage.LOCK_WAIT):
                await activation_scope.enter_async_context(live.activation_lock)
            task = asyncio.current_task()
            if task is None:
                raise RuntimeError("session activation requires an asyncio task")
            self._pending[live.id] = task
            expires = deadline
            try:
                while True:
                    async with AsyncExitStack() as lifecycle_scope:
                        with timing.measure(ActivationStage.LIFECYCLE_LOCK_WAIT):
                            await lifecycle_scope.enter_async_context(live.lifecycle_lock)
                        if (
                            self._closed
                            or live.terminated
                            or (live.terminating and live.termination_task is not task)
                        ):
                            raise SessionActivationError(SESSION_ACTIVATION_CLOSED)
                        if live.runtime_session is not None:
                            return
                        preparing_revision = self._revision(live)
                    with timing.measure(ActivationStage.SKILLS):
                        await self._prepare(live, timing)
                    async with AsyncExitStack() as lifecycle_scope:
                        with timing.measure(ActivationStage.LIFECYCLE_LOCK_WAIT):
                            await lifecycle_scope.enter_async_context(live.lifecycle_lock)
                        if (
                            self._closed
                            or live.terminated
                            or (live.terminating and live.termination_task is not task)
                        ):
                            raise SessionActivationError(SESSION_ACTIVATION_CLOSED)
                        if live.runtime_session is not None:
                            return
                        if self._revision(live) != preparing_revision:
                            continue
                        live.prepare_runtime_attachment()
                        with timing.measure(ActivationStage.PLAN):
                            plan = self._build(live)
                            plan = replace(plan, request=replace(plan.request, timing=timing))
                    if expires is None:
                        expires = time.time() + plan.provider.resource_policy.wait_seconds
                    # A fresh opaque admission id prevents a changed configuration from
                    # being mistaken for a retry of the former reservation fingerprint.
                    admission_id = f"{request_id or live.id}:{uuid.uuid4().hex}"

                    async def waiting(receipt: ResourceReceipt, wait_deadline: float) -> None:
                        live.waiting_resources = True
                        live.trace_resource("waiting", receipt)
                        if on_wait is not None:
                            await on_wait(receipt, wait_deadline)

                    with timing.measure(ActivationStage.ADMISSION):
                        receipt = await self.acquire(
                            plan.provider,
                            ResourceRequest(admission_id, purpose, expires, plan.request),
                            on_wait=waiting,
                        )
                    if receipt.deadline:
                        expires = min(expires, receipt.deadline)
                    live.trace_resource("granted", receipt)
                    try:
                        async with AsyncExitStack() as lifecycle_scope:
                            with timing.measure(ActivationStage.LIFECYCLE_LOCK_WAIT):
                                await lifecycle_scope.enter_async_context(live.lifecycle_lock)
                            if (
                                self._closed
                                or live.terminated
                                or (live.terminating and live.termination_task is not task)
                            ):
                                raise SessionActivationError(SESSION_ACTIVATION_CLOSED)
                            if self._revision(live) != plan.revision:
                                # Configuration changed while no lifecycle lock was held.
                                # The granted slot must not launch with stale authorization.
                                continue
                            live.waiting_resources = False
                            with timing.measure(ActivationStage.ATTACH):
                                await self._attach(live, plan, receipt.reservation_id)
                            return
                    finally:
                        # Consumed reservations make this a no-op; unused grants are freed
                        # on stale intent, cancellation, and native-open failures alike.
                        await plan.provider.cancel_resource(receipt.reservation_id)
            finally:
                live.waiting_resources = False
                if live.runtime_session is None:
                    self._discard(live)
                if self._pending.get(live.id) is task:
                    self._pending.pop(live.id, None)

    async def wait_until_suspended(
        self,
        live: LiveSession,
        *,
        deadline: float | None = None,
    ) -> None:
        expires = deadline
        if expires is None:
            expires = time.time() + self._provider(live.runtime_id).resource_policy.wait_seconds
        while True:
            if self._closed or live.terminated or live.terminating:
                raise SessionActivationError(SESSION_ACTIVATION_CLOSED)
            if await live.suspend_runtime():
                return
            remaining = expires - time.time()
            if remaining <= 0:
                raise SessionActivationError(RESOURCE_WAIT_TIMEOUT)
            await asyncio.sleep(min(RESOURCE_SWEEP_INTERVAL_SECONDS, remaining))

    async def acquire(
        self,
        provider: RuntimeProvider,
        request: ResourceRequest,
        on_wait: ResourceWaitObserver | None = None,
    ) -> ResourceReceipt:
        if self._closed:
            raise SessionActivationError(SESSION_ACTIVATION_CLOSED)
        task = asyncio.current_task()
        if task is not None:
            self._acquisitions.add(task)
        receipt: ResourceReceipt | None = None
        granted = False
        try:
            receipt = await provider.reserve(request)
            if receipt.state is ResourceState.WAITING:
                if on_wait is not None:
                    await on_wait(receipt, receipt.deadline or request.deadline)
                await self._reclaim(provider.descriptor.runtime_id, pressure=True)
                receipt = await provider.wait_resource(receipt.reservation_id)
            if receipt.state is not ResourceState.GRANTED:
                raise SessionActivationError(receipt.safe_error or RESOURCE_RESERVATION_INVALID)
            granted = True
            return receipt
        finally:
            if task is not None:
                self._acquisitions.discard(task)
            if receipt is not None and not granted:
                await provider.cancel_resource(receipt.reservation_id)

    async def cancel(self, session_id: str) -> bool:
        task = self._pending.get(session_id)
        if task is None or task.done():
            return False
        if task is asyncio.current_task():
            raise RuntimeError("activation cannot cancel its own task")
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return True

    async def _reclaim(self, runtime_id: str, *, pressure: bool) -> None:
        now = time.monotonic()
        for live in tuple(self._sessions.values()):
            if (
                live.runtime_id != runtime_id
                or live.runtime_session is None
                or live.activation_lock.locked()
                or live.lifecycle_lock.locked()
                or live.running
                or live.waiting_resources
            ):
                self._idle_since.pop(live.id, None)
                continue
            try:
                if live.runtime_driver is not None and live.runtime_driver.suspending:
                    if await live.suspend_runtime():
                        self._idle_since.pop(live.id, None)
                    continue
                activity = await live.runtime_session.activity()
                if not activity.idle:
                    self._idle_since.pop(live.id, None)
                    continue
                since = self._idle_since.setdefault(live.id, now)
                if not pressure:
                    policy = self._provider(runtime_id).resource_policy
                    if now - since < policy.idle_seconds:
                        continue
                if await live.suspend_runtime():
                    self._idle_since.pop(live.id, None)
            except Exception:
                # Inspection failure is never positive evidence of quiescence.
                self._idle_since.pop(live.id, None)
                self._logger.exception("session_runtime_suspend_failed session_id=%s", live.id)

    async def _maintain(self) -> None:
        while True:
            await asyncio.sleep(RESOURCE_SWEEP_INTERVAL_SECONDS)
            runtime_ids = {live.runtime_id for live in self._sessions.values()}
            for runtime_id in runtime_ids:
                await self._reclaim(runtime_id, pressure=False)

    async def aclose(self) -> None:
        self._closed = True
        tasks = set(self._pending.values()) | self._acquisitions
        if self._idle_task is not None:
            tasks.add(self._idle_task)
        tasks.discard(asyncio.current_task())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._idle_task = None
