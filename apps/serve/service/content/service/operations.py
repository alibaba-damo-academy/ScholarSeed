"""Instance-owned asynchronous content directory commands and results."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from uuid import uuid4

from service.content.domain.model import (
    OPERATION_INTERRUPTED,
    PROJECT_RECOVERY_PENDING,
    ContentError,
    OperationState,
)
from service.content.domain.naming import DEFAULT_PROJECT_NAME
from service.content.persistence.catalog import (
    AUTHORIZATION_SUPERSEDED,
    PROJECT_CREATION_PRESERVED,
    PROJECT_CREATION_RECOVERY_REQUIRED,
    ContentCatalog,
    ProjectCreation,
    ProjectCreationActive,
)
from service.platform.activity import Activities, ActivityDomain, ActivityPhase, MaintenanceActive
from service.platform.content import ProjectRef
from service.platform.domains import measure_directory_validation

OPERATION_LIMIT = 128
OPERATION_RETENTION_SECONDS = 3600.0
OPERATION_UNKNOWN = "content_operation_unknown"
OPERATION_FAILED = "content_operation_failed"
DIRECTORY_BUSY = "ERR_LEASE_BUSY"
_log = logging.getLogger(__name__)


class ContentPhase(StrEnum):
    QUALIFY = "qualify"
    PREPARE = "prepare"
    INSPECT = "inspect"
    INITIALIZE = "initialize"
    RETAIN = "retain"
    REGISTER = "register"


@contextmanager
def content_phase(operation_id: str, phase: ContentPhase) -> Iterator[None]:
    started = time.monotonic()
    error_type = ""
    _log.info("content_operation_phase operation_id=%s phase=%s event=started", operation_id, phase)
    with measure_directory_validation() as metrics:
        try:
            yield
        except BaseException as error:
            error_type = type(error).__name__
            raise
        finally:
            _log.info(
                "content_operation_phase operation_id=%s phase=%s event=%s elapsed_seconds=%.3f "
                "validation_calls=%s validation_directories=%s validation_seconds=%.3f error_type=%s",
                operation_id,
                phase,
                "failed" if error_type else "finished",
                time.monotonic() - started,
                metrics.calls,
                metrics.directories,
                metrics.elapsed_seconds,
                error_type,
            )


def requires_postcommit_recovery(creations: tuple[ProjectCreation, ...]) -> bool:
    """An unrecorded native identity cannot be predicted by update inspection.

    Keep the complete ordered directory-recovery batch after commit in this
    case; removals and authorizations must not overtake its project creations.
    """
    return any(creation.directory_identity is None for creation in creations)


@dataclass(frozen=True)
class AdoptProject:
    path: str
    name: str


@dataclass(frozen=True)
class CreateProject:
    name: str


@dataclass(frozen=True)
class EnsureDefaultProject:
    name: str = DEFAULT_PROJECT_NAME


@dataclass(frozen=True)
class RevokeRoot:
    root_id: str
    project_id: str | None = None


@dataclass(frozen=True)
class ForgetProject:
    project_id: str


@dataclass(frozen=True)
class AuthorizeRoot:
    project_id: str
    source: str
    mount: str
    supersede: bool = False


@dataclass(frozen=True)
class LinkImport:
    job_id: str
    owner_id: str
    generation: int


@dataclass(frozen=True)
class ReconcileAuthorization:
    root_id: str
    owner: str


@dataclass(frozen=True)
class ReconcileProjectRemoval:
    project_id: str
    owner: str


@dataclass(frozen=True)
class ReconcileProjectCreation:
    project_id: str
    owner: str
    recovery_at: float | None = None


ContentCommand = (
    AdoptProject
    | CreateProject
    | EnsureDefaultProject
    | RevokeRoot
    | ForgetProject
    | AuthorizeRoot
    | LinkImport
    | ReconcileAuthorization
    | ReconcileProjectRemoval
    | ReconcileProjectCreation
)
ContentResult = ProjectRef | dict[str, object]
RecoveryBatches = tuple[tuple[tuple[str, str, ContentCommand], ...], ...]


@dataclass(frozen=True)
class RecoveryAdmission:
    """Owner-qualified project scope and an optional reason to retain pending work."""

    project_id: str
    blocked_reason: str | None = None


@dataclass
class _Operation:
    owner: str
    command: ContentCommand
    state: OperationState = OperationState.QUEUED
    result: dict[str, object] | None = None
    error: str | None = None
    finished_at: float | None = None
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    recovery_at: float | None = None
    recovery_project: str | None = None
    recovery_blocked_reason: str | None = None
    accepted_at: float = field(default_factory=time.monotonic)
    submitted_at: float = field(default_factory=time.monotonic)


class ContentOperations:
    """Never reserve an execution lease while waiting for a directory drain.

    The lifecycle owns the worker and waits for its current transaction on close.
    Accepted identities and terminal responses live in the catalog. Cold startup
    recovers committed effects and fences other unfinished commands as interrupted;
    it never automatically replays them.
    """

    def __init__(
        self,
        activities: Activities,
        execute: Callable[[str, ContentCommand], Awaitable[ContentResult]],
        catalog: ContentCatalog,
        *,
        recovery_at: float | None = None,
        recovery_admission: Callable[[ContentCommand], RecoveryAdmission] | None = None,
        recovery_failure: Callable[[ContentCommand, Exception], str | None] | None = None,
        recovery_state: Callable[[str, str | None], None] | None = None,
    ) -> None:
        self._activities = activities
        self._catalog = catalog
        self._recovery_at = recovery_at
        self._recovery_admission = recovery_admission
        if recovery_state is not None and recovery_admission is None:
            raise ValueError("project recovery state requires explicit admission ownership")
        self._recovery_state = recovery_state
        self._pending_recovery: dict[str, set[str]] = {}
        self._recovery_projects: dict[str, str] = {}
        self._recovery_failure = recovery_failure
        self._blocked_recovery_projects: dict[str, str] = {}
        self._execute = execute
        self._operations: dict[str, _Operation] = {}
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()
        self._worker: asyncio.Task[None] | None = None
        self._closing = False
        self._ready = asyncio.Event()
        self._startup: asyncio.Task[None] | None = None
        self._startup_error: Exception | None = None
        self._stop_startup = asyncio.Event()

    async def start(self, *, defer_until_open: bool = False) -> None:
        if self._worker is not None or self._startup is not None or self._closing:
            raise RuntimeError("content operation worker already started or closed")
        if defer_until_open:
            batches = None
            if (
                self._recovery_state is not None
                and self._activities.snapshot().phase is ActivityPhase.OPEN
                and self._activities.workbench_ready
            ):
                batches = self._prepare_recovery()
            self._startup = asyncio.create_task(
                self._start_after_admission(batches), name="content-recovery-admission"
            )
            return
        await self._start_recovery()

    async def _start_after_admission(self, batches: RecoveryBatches | None = None) -> None:
        opened = asyncio.create_task(self._activities.wait_open())
        stopped = asyncio.create_task(self._stop_startup.wait())
        try:
            await asyncio.wait((opened, stopped), return_when=asyncio.FIRST_COMPLETED)
            if self._closing:
                return
            await opened
            # No await between the closing check and starting owned recovery.
            # Shutdown joins this task before putting the worker's sentinel.
            await self._start_recovery(batches)
        except Exception as error:
            self._startup_error = error
            _log.exception("Deferred content recovery failed")
        finally:
            for task in (opened, stopped):
                if not task.done():
                    task.cancel()
            await asyncio.gather(opened, stopped, return_exceptions=True)
            # Wake callers on failure too. submit rejects failed startup rather
            # than leaving an execute caller waiting forever.
            self._ready.set()

    def _prepare_recovery(self) -> RecoveryBatches:
        with self._activities.enter(ActivityDomain.RESOURCE, root=True):
            removals = self._catalog.project_removals()
            creations = self._catalog.project_creations()
            authorizations = self._catalog.authorization_reconciliations()
        batches = (
            tuple(
                (
                    row.operation_id,
                    row.owner,
                    ReconcileProjectCreation(row.plan.project_id, row.owner, self._recovery_at),
                )
                for row in creations
            ),
            tuple(
                (row.operation_id, row.owner, ReconcileProjectRemoval(row.project_id, row.owner))
                for row in removals
            ),
            tuple(
                (row.operation_id, row.owner, ReconcileAuthorization(row.root.root_id, row.owner))
                for row in authorizations
            ),
        )
        if self._recovery_admission is not None:
            # Freeze every affected project before exposing the general command
            # queue. No await permits a command to overtake this inventory.
            for batch in batches:
                for identity, _, command in batch:
                    admission = self._recovery_admission(command)
                    project = admission.project_id
                    self._recovery_projects[identity] = project
                    self._pending_recovery.setdefault(project, set()).add(identity)
                    if admission.blocked_reason is not None:
                        self._blocked_recovery_projects[project] = admission.blocked_reason
        if self._recovery_state is not None:
            for project in self._pending_recovery:
                self._recovery_state(
                    project, self._blocked_recovery_projects.get(project, PROJECT_RECOVERY_PENDING)
                )
        return batches

    async def _start_recovery(self, batches: RecoveryBatches | None = None) -> None:
        if batches is None:
            batches = self._prepare_recovery()
        self._worker = asyncio.create_task(self._run(), name="content-operations")
        if self._recovery_state is not None:
            self._ready.set()
        for batch in batches:
            await self._recover(batch)
        self._ready.set()

    def _complete_recovery(self, identity: str, project: str | None) -> None:
        if self._recovery_state is None or project is None:
            return
        pending = self._pending_recovery[project]
        pending.discard(identity)
        if not pending and project not in self._blocked_recovery_projects:
            self._recovery_state(project, None)

    async def _recover(self, pending: tuple[tuple[str, str, ContentCommand], ...]) -> None:
        for identity, owner, command in pending:
            project = self._recovery_projects.get(identity)
            with self._activities.enter(ActivityDomain.RESOURCE, root=True):
                persisted = self._catalog.operation_result(owner, identity)
            if persisted is not None and (
                persisted["state"] == OperationState.SUCCEEDED.value
                or persisted["error"] == AUTHORIZATION_SUPERSEDED
            ):
                # An earlier removal may already have consumed this authorization
                # marker. Its project identity comes from the frozen inventory.
                self._complete_recovery(identity, project)
                continue
            admission = self._recovery_admission(command) if self._recovery_admission else None
            if admission is not None and project != admission.project_id:
                raise RuntimeError("project recovery ownership changed")
            if admission is not None:
                reason = self._blocked_recovery_projects.get(project) or admission.blocked_reason
                if reason is not None:
                    self._defer_recovery(identity, project, reason)
                    continue
            row = _Operation(
                owner,
                command,
                OperationState.RUNNING,
                recovery_at=self._recovery_at,
                recovery_project=project,
            )
            self._operations[identity] = row
            self._queue.put_nowait(identity)
            await self._wait_finished(row)
            if project is not None and row.recovery_blocked_reason is not None:
                self._defer_recovery(identity, project, row.recovery_blocked_reason)
                continue
            if row.state is not OperationState.SUCCEEDED and not (
                (
                    isinstance(command, ReconcileAuthorization)
                    and row.error == AUTHORIZATION_SUPERSEDED
                )
                or (
                    isinstance(command, ReconcileProjectCreation)
                    and row.error
                    in (PROJECT_CREATION_RECOVERY_REQUIRED, PROJECT_CREATION_PRESERVED)
                )
            ):
                raise ContentError(row.error or OPERATION_FAILED)
            if project is not None and row.error == PROJECT_CREATION_RECOVERY_REQUIRED:
                self._defer_recovery(identity, project, row.error)
            else:
                self._complete_recovery(identity, project)

    def _defer_recovery(self, identity: str, project: str, reason: str) -> None:
        self._blocked_recovery_projects[project] = reason
        if self._recovery_state is not None:
            self._recovery_state(project, reason)
        _log.warning(
            "content_recovery_deferred operation_id=%s project_id=%s reason=%s durable=retained",
            identity,
            project,
            reason,
            extra={"operation_id": identity, "project_id": project, "blocked_reason": reason},
        )

    def submit(self, owner: str, command: ContentCommand) -> str:
        submitted_at = time.monotonic()
        self._activities.require_workbench()
        if (
            self._closing
            or self._startup_error is not None
            or self._worker is None
            or self._worker.done()
            or not self._ready.is_set()
        ):
            raise MaintenanceActive("content_operations_unavailable")
        if self._activities.snapshot().phase is not ActivityPhase.OPEN:
            raise MaintenanceActive("update_maintenance")
        cutoff = time.monotonic() - OPERATION_RETENTION_SECONDS
        self._operations = {
            key: row
            for key, row in self._operations.items()
            if row.finished_at is None or row.finished_at >= cutoff
        }
        identity = uuid4().hex
        with self._activities.enter(ActivityDomain.RESOURCE, root=True):
            accepted = self._catalog.accept_operation(
                identity,
                owner,
                json.dumps(
                    {"kind": type(command).__name__, "parameters": asdict(command)},
                    ensure_ascii=False,
                ),
                limit=OPERATION_LIMIT,
                retention=OPERATION_RETENTION_SECONDS,
            )
        if not accepted:
            raise MaintenanceActive("content_operation_capacity")
        self._operations[identity] = _Operation(
            owner, command, accepted_at=time.monotonic(), submitted_at=submitted_at
        )
        self._queue.put_nowait(identity)
        _log.info(
            "content_operation_accepted operation_id=%s command=%s queue_depth=%s accept_seconds=%.3f",
            identity,
            type(command).__name__,
            self._queue.qsize(),
            self._operations[identity].accepted_at - submitted_at,
        )
        return identity

    async def execute(self, owner: str, command: ContentCommand) -> dict[str, object]:
        """Wait without an execution lease; cancellation retains the accepted command's tail."""
        await self._ready.wait()
        if self._closing or self._startup_error is not None:
            raise MaintenanceActive("content_operations_unavailable")
        await self._activities.wait_open()
        identity = self.submit(owner, command)
        row = self._operations[identity]
        await self._wait_finished(row)
        if row.state is not OperationState.SUCCEEDED or row.result is None:
            raise ContentError(row.error or OPERATION_FAILED)
        return row.result

    @staticmethod
    async def _wait_finished(row: _Operation) -> None:
        finished = asyncio.create_task(row.finished.wait())
        cancellation: asyncio.CancelledError | None = None
        while True:
            try:
                await asyncio.shield(finished)
                break
            except asyncio.CancelledError as error:
                cancellation = error
        if cancellation is not None:
            raise cancellation

    def result(self, owner: str, identity: str) -> dict[str, object]:
        with self._activities.enter(ActivityDomain.RESOURCE, root=True):
            result = self._catalog.operation_result(owner, identity)
        if result is None:
            raise ContentError(OPERATION_UNKNOWN)
        return result

    def creation_recoveries(self, owner: str) -> list[dict[str, object]]:
        with self._activities.enter(ActivityDomain.RESOURCE, root=True):
            return [
                {
                    "operation": row.operation_id,
                    "project": asdict(row.plan),
                    "outcome": self._catalog.operation_result(owner, row.operation_id),
                }
                for row in self._catalog.project_creations()
                if row.owner == owner
            ]

    def retry_creation(self, owner: str, identity: str) -> None:
        self._activities.require_workbench()
        if (
            self._closing
            or self._startup_error is not None
            or self._worker is None
            or self._worker.done()
            or not self._ready.is_set()
        ):
            raise MaintenanceActive("content_operations_unavailable")
        with self._activities.enter(ActivityDomain.RESOURCE, root=True):
            creation = next(
                (
                    row
                    for row in self._catalog.project_creations()
                    if row.owner == owner and row.operation_id == identity
                ),
                None,
            )
            if creation is None:
                raise ContentError(OPERATION_UNKNOWN)
            existing = self._operations.get(identity)
            if existing is not None and not existing.finished.is_set():
                raise MaintenanceActive("content_operation_running")
            self._catalog.resume_project_creation(identity, owner)
        self._operations[identity] = _Operation(
            owner, ReconcileProjectCreation(creation.plan.project_id, owner), OperationState.RUNNING
        )
        self._queue.put_nowait(identity)

    def preserve_creation(self, owner: str, identity: str) -> None:
        self._activities.require_workbench()
        if (
            self._closing
            or self._startup_error is not None
            or self._worker is None
            or self._worker.done()
            or not self._ready.is_set()
        ):
            raise MaintenanceActive("content_operations_unavailable")
        with self._activities.enter(ActivityDomain.RESOURCE, root=True):
            existing = self._operations.get(identity)
            if existing is not None and existing.owner == owner and not existing.finished.is_set():
                raise MaintenanceActive("content_operation_running")
            try:
                preserved = self._catalog.preserve_project_creation(identity, owner)
            except ProjectCreationActive as error:
                raise MaintenanceActive("content_operation_running") from error
            if not preserved:
                raise ContentError(OPERATION_UNKNOWN)

    def _save_result(self, identity: str, row: _Operation) -> None:
        if row.recovery_blocked_reason is not None:
            # A qualified owner classified this as project-local. No terminal
            # write may consume the durable reconciliation/creation/removal.
            return
        with self._activities.enter(ActivityDomain.RESOURCE, root=True):
            if (
                row.state is OperationState.FAILED
                and row.error != DIRECTORY_BUSY
                and any(
                    creation.operation_id == identity
                    for creation in self._catalog.project_creations()
                )
            ):
                self._catalog.defer_project_creation(identity, now=row.recovery_at)
                row.error = PROJECT_CREATION_RECOVERY_REQUIRED
                return
            self._catalog.finish_operation(
                identity, row.state, row.result, row.error, now=row.recovery_at
            )

    async def _run(self) -> None:
        try:
            while (identity := await self._queue.get()) is not None:
                row = self._operations[identity]
                if self._closing:
                    row.state = OperationState.FAILED
                    row.error = "content_operations_closed"
                    try:
                        self._save_result(identity, row)
                    except MaintenanceActive:
                        # Closed admission is not permission to write. Cold
                        # exclusive startup will fence the durable queued row.
                        pass
                    row.finished_at = time.monotonic()
                    row.finished.set()
                    continue
                if row.state is OperationState.QUEUED:
                    with self._activities.enter(ActivityDomain.RESOURCE, root=True):
                        self._catalog.start_operation(identity)
                    row.state = OperationState.RUNNING
                execution_started = time.monotonic()
                _log.info(
                    "content_operation_started operation_id=%s command=%s queue_seconds=%.3f",
                    identity,
                    type(row.command).__name__,
                    execution_started - row.accepted_at,
                )
                try:
                    result = await self._execute(identity, row.command)
                    if isinstance(result, ProjectRef):
                        row.result = asdict(result)
                        row.result["layout"] = result.layout.value
                    else:
                        row.result = result
                    row.state = OperationState.SUCCEEDED
                except Exception as error:
                    _log.exception("Content directory operation failed")
                    row.error = error.code if isinstance(error, ContentError) else OPERATION_FAILED
                    if (
                        isinstance(
                            row.command,
                            (
                                AdoptProject,
                                CreateProject,
                                EnsureDefaultProject,
                                ReconcileProjectCreation,
                            ),
                        )
                        and getattr(error, "code", None) == DIRECTORY_BUSY
                    ):
                        row.error = DIRECTORY_BUSY
                    row.state = OperationState.FAILED
                    if row.recovery_project is not None and self._recovery_failure is not None:
                        row.recovery_blocked_reason = self._recovery_failure(row.command, error)
                        if row.recovery_blocked_reason is None and row.error not in (
                            AUTHORIZATION_SUPERSEDED,
                            PROJECT_CREATION_PRESERVED,
                        ):
                            # The owner did not prove a project-local failure.
                            # In particular, legacy creation deferral cannot turn
                            # core database or release errors into a usable app.
                            raise
                self._save_result(identity, row)
                row.finished_at = time.monotonic()
                row.finished.set()
                _log.info(
                    "content_operation_completed operation_id=%s command=%s state=%s "
                    "elapsed_seconds=%.3f queue_seconds=%.3f total_seconds=%.3f error=%s",
                    identity,
                    type(row.command).__name__,
                    row.state.value,
                    row.finished_at - execution_started,
                    execution_started - row.accepted_at,
                    row.finished_at - row.submitted_at,
                    row.error or "",
                )
        finally:
            # A dead worker cannot leave internal callers waiting forever.
            # Durable pending records remain for qualified startup recovery.
            for row in self._operations.values():
                if not row.finished.is_set():
                    row.state = OperationState.FAILED
                    row.result = None
                    row.error = OPERATION_INTERRUPTED
                    row.finished.set()

    @property
    def closed(self) -> bool:
        return self._closing

    async def aclose(self) -> None:
        self._closing = True
        self._stop_startup.set()
        self._ready.set()
        cancellation: asyncio.CancelledError | None = None
        if self._startup is not None:
            while True:
                try:
                    await asyncio.shield(self._startup)
                    break
                except asyncio.CancelledError as error:
                    if self._startup.cancelled():
                        raise
                    cancellation = error
        worker = self._worker
        if worker is None:
            if cancellation is not None:
                raise cancellation
            return
        self._queue.put_nowait(None)
        while True:
            try:
                await asyncio.shield(worker)
                break
            except asyncio.CancelledError as error:
                if worker.cancelled():
                    raise
                cancellation = error
        if cancellation is not None:
            raise cancellation
