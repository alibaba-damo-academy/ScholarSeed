"""Application-owned execution leases and atomic maintenance admission.

Leases belong to actual work, not UI sessions or HTTP response headers. A child
may finish an admitted operation during drain; a new root must wait for resume.
Only the composition owner may seal after every execution owner is integrated.
"""

from __future__ import annotations

import asyncio
import contextvars
import inspect
import logging
import threading
from collections import Counter
from collections.abc import Callable, Coroutine, Iterator
from concurrent.futures import Executor, Future
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from enum import Enum
from functools import partial
from typing import Any, TypeVar
from uuid import uuid4

T = TypeVar("T")


class ActivityPhase(str, Enum):
    OPEN = "open"
    DRAINING = "draining"
    SEALED = "sealed"


class ActivityDomain(str, Enum):
    STARTUP = "startup"
    REQUEST = "request"
    BRIDGE = "bridge"
    TURN = "turn"
    SETTLEMENT = "settlement"
    INVOCATION = "invocation"
    IMPORT = "import"
    INDEX = "index"
    RESOURCE = "resource"
    LITERATURE = "literature"
    MODEL = "model"
    RUNTIME = "runtime"
    CREDENTIAL = "credential"
    DIAGNOSTIC = "diagnostic"
    ACTION = "action"


class MaintenanceActive(RuntimeError):
    """A new root operation was not admitted during maintenance."""


class MaintenanceStale(RuntimeError):
    """The caller no longer owns this instance's maintenance generation."""


class MaintenanceIncomplete(RuntimeError):
    """A maintenance callback did not establish synchronous resource completion."""


@dataclass(frozen=True)
class ActivitySnapshot:
    instance_id: str
    generation: str | None
    phase: ActivityPhase
    counts: dict[str, int]
    maintenance_revision: int = 0


class ActivityLease:
    def __init__(
        self,
        owner: Activities,
        identity: str,
        domain: ActivityDomain,
        *,
        startup_probe: bool = False,
    ) -> None:
        self._owner = owner
        self._identity = identity
        self.domain = domain
        self._startup_probe = startup_probe
        self._context_token: contextvars.Token[ActivityLease | None] | None = None

    def __enter__(self) -> ActivityLease:
        with self._owner._lock:
            if self._context_token is not None or self._identity not in self._owner._leases:
                raise RuntimeError("activity lease is closed or already entered")
            self._context_token = self._owner._current.set(self)
        return self

    def __exit__(self, *_exc: object) -> None:
        token, self._context_token = self._context_token, None
        if token is not None:
            self._owner._current.reset(token)
        self.close()

    def close(self) -> None:
        with self._owner._lock:
            if self._owner._leases.pop(self._identity, None) is not None:
                self._owner._notify_drain_waiters()


class Activities:
    """One registry per Serve instance, shared by all accounts and workspaces.

    The lock covers admission, counts and seal, including thread-pool producers.
    Context inheritance permits children only while their parent lease is live;
    copying a stale context cannot revive a completed operation during drain.
    """

    def __init__(self, *, workbench_ready: Callable[[], bool] | None = None) -> None:
        self.instance_id = uuid4().hex
        self._lock = threading.RLock()
        self._leases: dict[str, ActivityDomain] = {}
        self._current: contextvars.ContextVar[ActivityLease | None] = contextvars.ContextVar(
            "serve_activity", default=None
        )
        self._phase = ActivityPhase.OPEN
        self._maintenance_parent: ActivityLease | None = None
        self._generation: str | None = None
        self._restart_generation: str | None = None
        self._maintenance_revision = 0
        self._waiters: set[asyncio.Future[None]] = set()
        self._drain_waiters: set[asyncio.Future[None]] = set()
        self._observers_stopped = False
        self._observer_stop_waiters: set[asyncio.Future[None]] = set()
        self._workbench_ready = workbench_ready or (lambda: True)

    @property
    def workbench_ready(self) -> bool:
        return self._workbench_ready()

    def require_workbench(self) -> None:
        if not self.workbench_ready:
            raise MaintenanceActive("update_maintenance")

    def workbench_changed(self) -> None:
        with self._lock:
            if not self.workbench_ready:
                return
            waiters, self._waiters = self._waiters, set()
        for future in waiters:
            future.get_loop().call_soon_threadsafe(self._wake, future)

    def stop_observers(self) -> None:
        """End passive transports before the HTTP server waits for requests.

        This terminal, instance-local notification changes no execution lease,
        maintenance phase or admission permission. It is not a drain receipt.
        """
        with self._lock:
            self._observers_stopped = True
            waiters, self._observer_stop_waiters = self._observer_stop_waiters, set()
            for future in waiters:
                future.get_loop().call_soon_threadsafe(self._wake, future)

    async def wait_observers_stopped(self) -> None:
        with self._lock:
            if self._observers_stopped:
                return
            future = asyncio.get_running_loop().create_future()
            self._observer_stop_waiters.add(future)
        try:
            await future
        finally:
            with self._lock:
                self._observer_stop_waiters.discard(future)

    def enter(
        self, domain: ActivityDomain, *, root: bool = False, allow_startup_probe: bool = True
    ) -> ActivityLease:
        with self._lock:
            parent = self._current.get()
            continuing = (
                not root
                and parent is not None
                and parent._owner is self
                and parent._identity in self._leases
            )
            # Startup probes may use their owned runtime resources, but cannot
            # authorize a turn, bridge call or detached root through inheritance.
            startup_probe = (
                allow_startup_probe
                and continuing
                and parent is not None
                and parent._startup_probe
                and domain is ActivityDomain.RUNTIME
            )
            if (
                domain
                in {
                    ActivityDomain.BRIDGE,
                    ActivityDomain.TURN,
                    ActivityDomain.SETTLEMENT,
                    ActivityDomain.INVOCATION,
                    ActivityDomain.IMPORT,
                    ActivityDomain.LITERATURE,
                    ActivityDomain.MODEL,
                    ActivityDomain.RUNTIME,
                    ActivityDomain.CREDENTIAL,
                    ActivityDomain.ACTION,
                    ActivityDomain.INDEX,
                    ActivityDomain.DIAGNOSTIC,
                }
                # Persistent provider resources cannot borrow the startup
                # exemption reserved for readiness/version observations.
                or (domain is ActivityDomain.RESOURCE and not allow_startup_probe)
            ) and not startup_probe:
                self.require_workbench()
            maintaining = (
                continuing
                and self._maintenance_parent is not None
                and self._maintenance_parent._identity in self._leases
            )
            if (self._phase is ActivityPhase.SEALED and not maintaining) or (
                self._phase is ActivityPhase.DRAINING and not continuing
            ):
                raise MaintenanceActive("update_maintenance")
            identity = uuid4().hex
            self._leases[identity] = domain
            return ActivityLease(
                self,
                identity,
                domain,
                startup_probe=domain is ActivityDomain.STARTUP or startup_probe,
            )

    def run_maintenance(self, generation: str, operation: Callable[[], T]) -> T:
        """Run a synchronous owner mutation only after the whole instance seals."""
        with self._lock:
            self._check_generation(generation)
            if self._phase is not ActivityPhase.SEALED or self._leases:
                raise MaintenanceActive("maintenance requires complete drain")
            identity = uuid4().hex
            self._leases[identity] = ActivityDomain.RESOURCE
            lease = ActivityLease(self, identity, ActivityDomain.RESOURCE)
            self._maintenance_parent = lease
        token = self._current.set(lease)
        asynchronous = False
        try:
            result = operation()
            asynchronous = inspect.isawaitable(result)
            if inspect.iscoroutine(result):
                result.close()
            return result
        finally:
            self._current.reset(token)
            with self._lock:
                if asynchronous or set(self._leases) != {identity}:
                    # Retain the owner lease: neither a returned awaitable nor
                    # escaped child resources establish completion. Even a later
                    # child close cannot authorize reopening this generation.
                    raise MaintenanceIncomplete("maintenance callback did not finish synchronously")
                lease.close()
                self._maintenance_parent = None

    def _reject_maintenance_async(self) -> None:
        if self._maintenance_parent is not None:
            raise MaintenanceActive("maintenance callbacks must finish synchronously")

    def continue_from(self, parent: ActivityLease | None, domain: ActivityDomain) -> ActivityLease:
        """Reserve a continuation from a server-held live capability.

        Owners validate account/turn/callback authority before using this method.
        A request-supplied task identifier is never an execution capability.
        """
        with self._lock:
            self.require_workbench()
            if parent is None or parent._owner is not self or parent._identity not in self._leases:
                raise MaintenanceStale("update_activity_expired")
            if self._phase is ActivityPhase.SEALED:
                raise MaintenanceActive("update_maintenance")
            identity = uuid4().hex
            self._leases[identity] = domain
            return ActivityLease(self, identity, domain)

    @contextmanager
    def observe_request(self) -> Iterator[None]:
        """Hold the transport barrier without granting execution admission.

        During drain, existing operations still need HTTP confirmations and
        cancellation requests. Their owners independently validate a live
        continuation capability. Opening an HTTP connection must never install
        an ambient parent which permits new work during drain.
        """
        with self._lock:
            if self._phase is ActivityPhase.SEALED:
                raise MaintenanceActive("update_maintenance")
            identity = uuid4().hex
            self._leases[identity] = ActivityDomain.REQUEST
        try:
            yield
        finally:
            with self._lock:
                self._leases.pop(identity, None)

    def begin(self) -> str:
        with self._lock:
            if self._phase is not ActivityPhase.OPEN:
                raise MaintenanceActive("update_maintenance")
            self._generation = uuid4().hex
            self._maintenance_revision += 1
            self._phase = ActivityPhase.DRAINING
            self._notify_drain_waiters()
            return self._generation

    def release_for_restart(self, generation: str) -> None:
        """Retain a terminal owner's fence, permitting explicit restart takeover.

        This is not a drain receipt: existing execution/resources must still be
        settled by the restart owner. Ordinary maintenance cannot take it over.
        """
        with self._lock:
            self._check_generation(generation)
            if self._phase is not ActivityPhase.DRAINING or self._maintenance_parent is not None:
                raise MaintenanceActive("update_maintenance")
            if self._restart_generation is not None:
                raise MaintenanceActive("update_maintenance")
            self._restart_generation = generation
            logging.getLogger(__name__).info(
                "maintenance_restart_fence instance_id=%s generation=%s",
                self.instance_id,
                generation,
            )

    def begin_restart(self) -> str:
        """Claim open admission or a terminal restart fence without opening it."""
        with self._lock:
            if self._phase is ActivityPhase.OPEN:
                return self.begin()
            if (
                self._phase is not ActivityPhase.DRAINING
                or self._restart_generation is None
                or self._generation != self._restart_generation
            ):
                raise MaintenanceActive("update_maintenance")
            self._generation = uuid4().hex
            self._maintenance_revision += 1
            self._notify_drain_waiters()
            logging.getLogger(__name__).info(
                "maintenance_restart_claim instance_id=%s fence=%s generation=%s",
                self.instance_id,
                self._restart_generation,
                self._generation,
            )
            return self._generation

    def begin_if_idle(self) -> str | None:
        """Atomically defer scheduled maintenance while business execution is live.

        Requests and resource leases may include passive transports and idle
        provider attachments. Allowing them starts drain only; it does not prove
        that resources are idle. The caller still must obtain owner completion
        and seal every lease before releasing directory qualifications.
        """
        with self._lock:
            if (
                self._phase is not ActivityPhase.OPEN
                or not self.workbench_ready
                or any(
                    domain not in (ActivityDomain.REQUEST, ActivityDomain.RESOURCE)
                    for domain in self._leases.values()
                )
            ):
                return None
            self._generation = uuid4().hex
            self._maintenance_revision += 1
            self._phase = ActivityPhase.DRAINING
            self._notify_drain_waiters()
            return self._generation

    def _notify_drain_waiters(self) -> None:
        """Called under the registry lock; consumers recheck the condition."""
        waiters, self._drain_waiters = self._drain_waiters, set()
        for future in waiters:
            future.get_loop().call_soon_threadsafe(self._wake, future)

    async def wait_execution_drained(self) -> str:
        """Wait for maintenance with no execution leases, ignoring transports.

        This only tells passive observers to close. It never seals the instance
        or claims that execution owners not yet integrated have stopped.
        """
        while True:
            with self._lock:
                if self._phase is not ActivityPhase.OPEN and all(
                    domain is ActivityDomain.REQUEST for domain in self._leases.values()
                ):
                    assert self._generation is not None
                    return self._generation
                future = asyncio.get_running_loop().create_future()
                self._drain_waiters.add(future)
            try:
                await future
            finally:
                with self._lock:
                    self._drain_waiters.discard(future)

    async def wait_business_drained(self, generation: str) -> None:
        """Wait under the exact maintenance gate; resource exit remains separate."""
        while True:
            with self._lock:
                self._check_generation(generation)
                if self._phase is not ActivityPhase.DRAINING:
                    raise MaintenanceStale("update_maintenance_stale")
                if all(
                    domain in (ActivityDomain.REQUEST, ActivityDomain.RESOURCE)
                    for domain in self._leases.values()
                ):
                    return
                logging.getLogger(__name__).debug(
                    "maintenance_business_wait generation=%s counts=%s",
                    generation,
                    dict(Counter(domain.value for domain in self._leases.values())),
                )
                future = asyncio.get_running_loop().create_future()
                self._drain_waiters.add(future)
            try:
                await future
            finally:
                with self._lock:
                    self._drain_waiters.discard(future)

    async def wait_resources_drained(self, generation: str, owner: ActivityLease) -> None:
        """Wait for physical cleanup while retaining the exact maintenance owner."""
        while True:
            with self._lock:
                self._check_generation(generation)
                if (
                    self._phase is not ActivityPhase.DRAINING
                    or owner._owner is not self
                    or self._leases.get(owner._identity) is not ActivityDomain.RESOURCE
                ):
                    raise MaintenanceStale("update_maintenance_stale")
                if all(
                    identity == owner._identity or domain is ActivityDomain.REQUEST
                    for identity, domain in self._leases.items()
                ):
                    return
                future = asyncio.get_running_loop().create_future()
                self._drain_waiters.add(future)
            try:
                await future
            finally:
                with self._lock:
                    self._drain_waiters.discard(future)

    def _check_generation(self, generation: str) -> None:
        if not generation or generation != self._generation:
            raise MaintenanceStale("update_maintenance_stale")

    def resume(self, generation: str, *, expected_phase: ActivityPhase | None = None) -> None:
        with self._lock:
            self._check_generation(generation)
            if expected_phase is not None and self._phase is not expected_phase:
                raise MaintenanceStale("update_maintenance_stale")
            if self._maintenance_parent is not None:
                raise MaintenanceActive("maintenance callback has not finished")
            if self._restart_generation is not None:
                if generation == self._restart_generation:
                    raise MaintenanceActive("update_maintenance")
                self._phase = ActivityPhase.DRAINING
                self._generation = self._restart_generation
                self._notify_drain_waiters()
                logging.getLogger(__name__).info(
                    "maintenance_restart_restore instance_id=%s fence=%s generation=%s",
                    self.instance_id,
                    self._restart_generation,
                    generation,
                )
                return
            self._phase = ActivityPhase.OPEN
            self._generation = None
            self._notify_drain_waiters()
            waiters, self._waiters = self._waiters, set()
        for future in waiters:
            future.get_loop().call_soon_threadsafe(self._wake, future)

    @staticmethod
    def _wake(future: asyncio.Future[None]) -> None:
        if not future.done():
            future.set_result(None)

    async def wait_open(self) -> None:
        while True:
            with self._lock:
                if self._phase is ActivityPhase.OPEN and self.workbench_ready:
                    return
                future = asyncio.get_running_loop().create_future()
                self._waiters.add(future)
            try:
                await future
            finally:
                with self._lock:
                    self._waiters.discard(future)

    def seal(self, generation: str) -> bool:
        with self._lock:
            self._check_generation(generation)
            if self._leases:
                return False
            self._phase = ActivityPhase.SEALED
            return True

    def snapshot(self) -> ActivitySnapshot:
        with self._lock:
            return ActivitySnapshot(
                instance_id=self.instance_id,
                generation=self._generation,
                phase=self._phase,
                counts=dict(Counter(domain.value for domain in self._leases.values())),
                maintenance_revision=self._maintenance_revision,
            )

    def spawn(
        self,
        domain: ActivityDomain,
        operation: Callable[[], Coroutine[Any, Any, T]],
        *,
        root: bool = False,
        name: str | None = None,
    ) -> asyncio.Task[T]:
        self._reject_maintenance_async()
        lease = self.enter(domain, root=root)

        async def execute() -> T:
            with lease:
                return await operation()

        coroutine = execute()
        try:
            task = asyncio.create_task(coroutine, name=name)
        except BaseException:
            coroutine.close()
            lease.close()
            raise
        # Cancellation before the coroutine's first instruction never enters its
        # finally block. The done callback also covers this case (close is idempotent).
        task.add_done_callback(lambda _done: lease.close())
        return task

    def submit(
        self,
        executor: Executor,
        domain: ActivityDomain,
        operation: Callable[..., T],
        *args: Any,
        **kwargs: Any,
    ) -> Future[T]:
        self._reject_maintenance_async()
        lease = self.enter(domain)
        context = contextvars.copy_context()

        def execute() -> T:
            with lease:
                return operation(*args, **kwargs)

        try:
            future = executor.submit(context.run, execute)
        except BaseException:
            lease.close()
            raise
        future.add_done_callback(lambda _done: lease.close())
        return future

    async def to_thread(
        self, domain: ActivityDomain, operation: Callable[..., T], *args: Any, **kwargs: Any
    ) -> T:
        return await asyncio.shield(self._thread(domain, operation, *args, **kwargs))

    async def observe_thread(self, operation: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        return await asyncio.shield(self._thread(None, operation, *args, **kwargs))

    async def finish(
        self, domain: ActivityDomain, operation: Callable[[], Coroutine[Any, Any, T]]
    ) -> T:
        """Keep the caller's serialization locks until the whole operation completes.

        Cancellation is delivered after completion, including repeated requests.
        Use for writes whose result must be reconciled before releasing a lock.
        """
        future = self.spawn(domain, operation)
        cancellation: asyncio.CancelledError | None = None
        while True:
            try:
                result = await asyncio.shield(future)
            except asyncio.CancelledError as error:
                if future.cancelled():
                    raise
                cancellation = error
                continue
            except BaseException:
                if cancellation is not None:
                    raise cancellation
                raise
            if cancellation is not None:
                raise cancellation
            return result

    def _thread(
        self, domain: ActivityDomain | None, operation: Callable[..., T], *args: Any, **kwargs: Any
    ) -> asyncio.Future[T]:
        self._reject_maintenance_async()
        barrier = ExitStack()
        if domain is None:
            barrier.enter_context(self.observe_request())
            lease = None
        else:
            lease = self.enter(domain)
        context = contextvars.copy_context()

        def execute() -> T:
            if lease is not None:
                with lease:
                    return operation(*args, **kwargs)
            return operation(*args, **kwargs)

        def close() -> None:
            if lease is not None:
                lease.close()
            barrier.close()

        try:
            future = asyncio.get_running_loop().run_in_executor(None, partial(context.run, execute))
        except BaseException:
            close()
            raise

        def completed(done: asyncio.Future[T]) -> None:
            close()
            # A cancelled waiter must not leave an unobserved thread exception.
            if not done.cancelled():
                done.exception()

        future.add_done_callback(completed)
        return future
