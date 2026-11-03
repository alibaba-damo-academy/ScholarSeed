"""Observable application-owned shared-host replacement after admission conflicts."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from scholarseed_runtime.contract.command import CommandReceipt, CommandState
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_BUSY,
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    RESOURCE_WAIT_TIMEOUT,
)
from service.platform.activity import (
    Activities,
    ActivityDomain,
    ActivityLease,
    ActivityPhase,
    MaintenanceActive,
)

RECONFIGURATION_STALE = "runtime_reconfiguration_stale"
RECONFIGURATION_INVALID = "runtime_reconfiguration_invalid"
RECONFIGURATION_NOT_FOUND = "runtime_reconfiguration_not_found"
PREPARATION_INVALID = "runtime_preparation_invalid"
PREPARATION_DEFAULT_FAILED = "runtime_preparation_default_failed"
PREPARATION_INSTANCE_CHANGED = "runtime_preparation_instance_changed"
PREPARATION_CLOSED = "runtime_preparation_closed"


class PreparationError(ValueError):
    pass


@dataclass
class ReconfigurationOperation:
    request_id: str
    session_id: str | None
    user_id: str
    model_id: str
    state: CommandState = CommandState.ACCEPTED
    safe_error: str = ""
    commit_requested: bool = False

    def payload(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "session_id": self.session_id,
            "model_id": self.model_id,
            "state": self.state.value,
            "error": self.safe_error,
        }


class HostReconfiguration:
    def __init__(
        self,
        *,
        activities: Activities,
        drain: Callable[[str], Awaitable[tuple[str, ...]]],
        logger: Any,
    ) -> None:
        self._activities = activities
        self._drain = drain
        self._logger = logger
        self._operations: dict[str, ReconfigurationOperation] = {}
        self._task: asyncio.Task[None] | None = None
        self._latest_request_id: str | None = None
        self._closed = False

    @property
    def pending(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def state(self) -> CommandState | None:
        operation = self._operations.get(self._latest_request_id or "")
        return operation.state if operation is not None else None

    def current(self, session_id: str | None, user_id: str) -> dict[str, Any] | None:
        operation = self._operations.get(self._latest_request_id or "")
        if operation is None or (operation.session_id, operation.user_id) != (session_id, user_id):
            return None
        return operation.payload()

    def status(self, request_id: str, session_id: str | None, user_id: str) -> dict[str, Any]:
        operation = self._operations.get(request_id)
        if operation is None or (operation.session_id, operation.user_id) != (session_id, user_id):
            raise ValueError(RECONFIGURATION_NOT_FOUND)
        return operation.payload()

    async def wait_pending(self) -> None:
        if self._closed:
            raise ValueError(PREPARATION_CLOSED)
        task = self._task
        if task is not None:
            await asyncio.shield(task)

    async def wait(self, request_id: str, session_id: str | None, user_id: str) -> dict[str, Any]:
        operation = self.status(request_id, session_id, user_id)
        if operation["state"] == CommandState.ACCEPTED.value:
            await self.wait_pending()
        return self.status(request_id, session_id, user_id)

    def start(
        self,
        *,
        request_id: str,
        session_id: str | None,
        user_id: str,
        model_id: str,
        wait_seconds: float,
        validate: Callable[[], None],
        apply: Callable[[ActivityLease], Awaitable[CommandReceipt]],
        warm: Callable[[ActivityLease], Awaitable[CommandReceipt]] | None = None,
        commit: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        try:
            UUID(request_id)
        except (ValueError, TypeError, AttributeError):
            raise ValueError(RECONFIGURATION_INVALID) from None
        existing = self._operations.get(request_id)
        if existing is not None:
            if (
                existing.session_id,
                existing.user_id,
                existing.model_id,
                existing.commit_requested,
            ) != (
                session_id,
                user_id,
                model_id,
                commit is not None,
            ):
                raise ValueError(RECONFIGURATION_STALE)
            return existing.payload()
        if self._closed:
            raise ValueError(PREPARATION_CLOSED)
        if self.state is CommandState.RESTART_REQUIRED:
            raise ValueError(RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
        if self.pending:
            raise ValueError(RESOURCE_HOST_BUSY)
        if warm is None:
            validate()
        owner = self._activities.enter(ActivityDomain.RESOURCE, root=True)
        try:
            generation = self._activities.begin() if warm is None else None
        except BaseException:
            owner.close()
            raise
        operation = ReconfigurationOperation(
            request_id, session_id, user_id, model_id, commit_requested=commit is not None
        )
        self._operations[request_id] = operation
        self._latest_request_id = request_id
        if warm is not None:
            try:
                validate()
            except Exception:
                operation.state = CommandState.REJECTED
                operation.safe_error = PREPARATION_INVALID
                owner.close()
                return operation.payload()
        if commit is not None:
            try:
                commit()
            except Exception:
                operation.state = CommandState.REJECTED
                operation.safe_error = PREPARATION_DEFAULT_FAILED
                owner.close()
                self._logger.exception(
                    "runtime_preparation_default_failed request_id=%s", request_id
                )
                return operation.payload()

        async def execute() -> None:
            nonlocal generation
            with owner:
                reopen = True
                try:
                    if warm is not None:
                        try:
                            receipt = await warm(owner)
                        except BaseException as error:
                            if (
                                str(getattr(error, "safe_error", "") or error)
                                != RESOURCE_HOST_CONFIGURATION_CONFLICT
                            ):
                                reopen = False
                                raise
                            receipt = None
                        if receipt is not None and (
                            (
                                receipt.state is CommandState.RESTART_REQUIRED
                                and receipt.safe_error != RESOURCE_HOST_CONFIGURATION_CONFLICT
                            )
                            or receipt.safe_error == RESOURCE_HOST_CONFIGURATION_UNCERTAIN
                        ):
                            reopen = False
                            generation = self._activities.begin()
                            operation.state = CommandState.RESTART_REQUIRED
                            operation.safe_error = (
                                receipt.safe_error or RESOURCE_HOST_CONFIGURATION_UNCERTAIN
                            )
                            return
                        validate()
                        if (
                            receipt is not None
                            and receipt.safe_error != RESOURCE_HOST_CONFIGURATION_CONFLICT
                        ):
                            if receipt.state not in {
                                CommandState.APPLIED,
                                CommandState.REJECTED,
                                CommandState.RESTART_REQUIRED,
                                CommandState.UNSUPPORTED,
                            }:
                                raise RuntimeError(RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
                            operation.state = receipt.state
                            operation.safe_error = receipt.safe_error
                            return
                        generation = self._activities.begin()
                    if generation is None:
                        raise RuntimeError(RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
                    self._logger.info(
                        "runtime_host_reconfiguration_business_wait request_id=%s counts=%s",
                        request_id,
                        self._activities.snapshot().counts,
                    )
                    await asyncio.wait_for(
                        self._activities.wait_business_drained(generation), wait_seconds
                    )
                    validate()
                    blocked = await self._drain(generation)
                    reopen = False
                    if not blocked:
                        self._logger.info(
                            "runtime_host_reconfiguration_resource_wait request_id=%s counts=%s",
                            request_id,
                            self._activities.snapshot().counts,
                        )
                        await asyncio.wait_for(
                            self._activities.wait_resources_drained(generation, owner), wait_seconds
                        )
                    snapshot = self._activities.snapshot()
                    if (
                        blocked
                        or snapshot.generation != generation
                        or snapshot.phase is not ActivityPhase.DRAINING
                        or snapshot.counts.get(ActivityDomain.RESOURCE.value, 0) != 1
                        or any(
                            count
                            for domain, count in snapshot.counts.items()
                            if domain
                            not in {ActivityDomain.RESOURCE.value, ActivityDomain.REQUEST.value}
                        )
                    ):
                        self._logger.warning(
                            "runtime_host_reconfiguration_drain_blocked request_id=%s "
                            "blocked=%s generation_matches=%s phase=%s counts=%s",
                            request_id,
                            blocked,
                            snapshot.generation == generation,
                            snapshot.phase.value,
                            snapshot.counts,
                        )
                        reopen = False
                        operation.state = CommandState.RESTART_REQUIRED
                        operation.safe_error = RESOURCE_HOST_CONFIGURATION_UNCERTAIN
                        return
                    validate()
                    reopen = False
                    receipt = await apply(owner)
                    if receipt.state not in {
                        CommandState.APPLIED,
                        CommandState.REJECTED,
                        CommandState.RESTART_REQUIRED,
                    }:
                        raise RuntimeError(RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
                    operation.state = receipt.state
                    operation.safe_error = receipt.safe_error
                    reopen = receipt.state in {CommandState.APPLIED, CommandState.REJECTED}
                except TimeoutError:
                    self._logger.warning(
                        "runtime_host_reconfiguration_timeout request_id=%s counts=%s",
                        request_id,
                        self._activities.snapshot().counts,
                    )
                    operation.state = (
                        CommandState.REJECTED if reopen else CommandState.RESTART_REQUIRED
                    )
                    operation.safe_error = (
                        RESOURCE_WAIT_TIMEOUT if reopen else RESOURCE_HOST_CONFIGURATION_UNCERTAIN
                    )
                except (ValueError, MaintenanceActive) as error:
                    operation.state = (
                        CommandState.REJECTED if reopen else CommandState.RESTART_REQUIRED
                    )
                    operation.safe_error = (
                        RESOURCE_HOST_CONFIGURATION_UNCERTAIN
                        if not reopen
                        else (
                            RECONFIGURATION_STALE
                            if str(error) == RECONFIGURATION_STALE
                            else RESOURCE_HOST_BUSY
                        )
                    )
                except BaseException:
                    reopen = False
                    operation.state = CommandState.RESTART_REQUIRED
                    operation.safe_error = RESOURCE_HOST_CONFIGURATION_UNCERTAIN
                    self._logger.exception(
                        "runtime_host_reconfiguration_failed request_id=%s", request_id
                    )
                finally:
                    if (
                        not reopen
                        and generation is None
                        and self._activities.snapshot().phase is ActivityPhase.OPEN
                    ):
                        generation = self._activities.begin()
                    if reopen and generation is not None:
                        self._activities.resume(generation, expected_phase=ActivityPhase.DRAINING)
                    elif generation is not None:
                        # The mutation has ended, but its unknown physical state
                        # still fences new work. A confirmed restart may now
                        # claim that fence and independently drain the instance.
                        owner.close()
                        self._activities.release_for_restart(generation)
                    self._logger.info(
                        "runtime_host_reconfiguration request_id=%s session_id=%s state=%s code=%s",
                        request_id,
                        session_id,
                        operation.state.value,
                        operation.safe_error,
                    )

        self._task = asyncio.create_task(execute())
        self._task.add_done_callback(lambda _task: owner.close())
        return operation.payload()

    async def aclose(self) -> None:
        self._closed = True
        if self._task is not None:
            cancellation = None
            while not self._task.done():
                try:
                    await asyncio.shield(self._task)
                except asyncio.CancelledError as error:
                    cancellation = error
            self._task.result()
            if cancellation is not None:
                raise cancellation
