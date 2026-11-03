"""Private launcher channel bootstrapped only through inherited stdin.

The socket is outbound loopback, authenticated by a one-use secret delivered on
that pipe. Neither credentials nor configuration go to stdout/stderr or HTTP.
A lost channel never resumes an owned maintenance generation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import struct
from collections.abc import Awaitable, Callable
from enum import Enum
from time import monotonic

from service.platform.activity import Activities, ActivityDomain, ActivityPhase, MaintenanceStale
from service.platform.toolchain import CompilerResources

BOOTSTRAP_BYTES = 4096
COMMAND_BYTES = 4096
MAINTENANCE_SETTLE_SECONDS = 1.0
MAINTENANCE_INTERRUPT_SECONDS = 30.0
MAINTENANCE_DRAIN_RETRY_SECONDS = 0.1
UPDATE_PREPARATION_SECONDS = 30.0
_TOKEN = re.compile(r"[a-f0-9]{64}\Z")
_GENERATION = re.compile(r"[a-f0-9]{32}\Z")
_LOGGER = logging.getLogger(__name__)
TOOLCHAIN_OPERATION = "toolchain"
SKILL_PYTHON_OPERATION = "skill-python"
PREPARATION_OPERATIONS = frozenset((TOOLCHAIN_OPERATION, SKILL_PYTHON_OPERATION))

IDLE_QUIESCE_OPERATION = "quiesce_if_idle"
UPDATE_PREPARATION_OPERATION = "prepare_update"


class ControlStage(str, Enum):
    CONNECT = "connect"
    AUTH_SEND = "auth_send"
    AUTH_RECEIVE = "auth_receive"
    COMMAND_READ = "command_read"
    COMMAND_APPLY = "command_apply"
    RESPONSE_SEND = "response_send"


class MaintenanceStage(str, Enum):
    INTERRUPT = "interrupt"
    ATTACHMENTS = "attachments"
    BUSINESS = "business"


class ParentControlError(RuntimeError):
    pass


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ParentControlError("invalid parent control frame")
        result[key] = value
    return result


def _decode(raw: bytes, keys: set[str]) -> dict:
    try:
        value = json.loads(raw, object_pairs_hook=_object)
    except (ValueError, UnicodeError, RecursionError):
        raise ParentControlError("invalid parent control frame") from None
    if not isinstance(value, dict) or set(value) != keys:
        raise ParentControlError("invalid parent control frame")
    return value


class ParentControl:
    def __init__(
        self,
        activities: Activities,
        interrupt_running: Callable[[], Awaitable[None]] | None = None,
        drain_attachments: Callable[[str], Awaitable[tuple[str, ...]]] | None = None,
        toolchain_complete: Callable[[bool, CompilerResources | None], None] | None = None,
        skill_python_complete: Callable[[bool], None] | None = None,
        prepare_update: Callable[[str], Awaitable[None]] | None = None,
        resume_update: Callable[[str], None] | None = None,
    ) -> None:
        self._activities = activities
        self._interrupt_running = interrupt_running
        self._drain_attachments = drain_attachments
        self._prepare_update = prepare_update
        self._resume_update = resume_update
        self._update_preparation: asyncio.Task[None] | None = None
        self._preparations = {
            TOOLCHAIN_OPERATION: toolchain_complete,
            SKILL_PYTHON_OPERATION: skill_python_complete,
        }
        self._reported: set[str] = set()
        self._generation: str | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._task: asyncio.Task[None] | None = None
        self._closed = False

    def start(self, bootstrap: bytes) -> None:
        if self._task is not None or self._closed or len(bootstrap) > BOOTSTRAP_BYTES:
            raise ParentControlError("parent control unavailable")
        value = _decode(bootstrap, {"version", "port", "token"})
        if (
            type(value["version"]) is not int
            or value["version"] != 1
            or type(value["port"]) is not int
            or not 0 < value["port"] < 65536
            or not isinstance(value["token"], str)
            or not _TOKEN.fullmatch(value["token"])
        ):
            raise ParentControlError("invalid parent control bootstrap")
        self._task = asyncio.create_task(
            self._run(value["port"], value["token"]), name="private-parent-control"
        )

    async def _run(self, port: int, token: str) -> None:
        stage = ControlStage.CONNECT
        started = monotonic()
        _LOGGER.info("parent_control_started pid=%s port=%s", os.getpid(), port)
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection("127.0.0.1", port, limit=COMMAND_BYTES + 1), 10
            )
            self._writer = writer
            stage = ControlStage.AUTH_SEND
            _LOGGER.info("parent_control_connected pid=%s port=%s", os.getpid(), port)
            writer.write(
                json.dumps({"token": token}, separators=(",", ":")).encode("ascii") + b"\n"
            )
            await asyncio.wait_for(writer.drain(), 10)
            stage = ControlStage.AUTH_RECEIVE
            if await asyncio.wait_for(reader.readline(), 10) != b"ready\n":
                raise ParentControlError("parent authentication unavailable")
            token = ""
            _LOGGER.info("parent_control_authenticated pid=%s port=%s", os.getpid(), port)
            while not self._closed:
                stage = ControlStage.COMMAND_READ
                raw = await reader.readline()
                if not raw:
                    _LOGGER.warning(
                        "parent_control_eof stage=%s pid=%s pending_preparations=%s",
                        stage.value,
                        os.getpid(),
                        len(PREPARATION_OPERATIONS - self._reported),
                    )
                    break
                if len(raw) > COMMAND_BYTES or not raw.endswith(b"\n"):
                    raise ParentControlError("invalid parent control command")
                command = json.loads(raw, object_pairs_hook=_object)
                if not isinstance(command, dict):
                    raise ParentControlError("invalid parent control command")
                keys = (
                    {"operation", "ready", "resources"}
                    if command.get("operation") == TOOLCHAIN_OPERATION
                    else (
                        {"operation", "ready"}
                        if command.get("operation") == SKILL_PYTHON_OPERATION
                        else {"operation", "generation"}
                    )
                )
                command = _decode(raw, keys)
                stage = ControlStage.COMMAND_APPLY
                try:
                    response = await self._command(command)
                except Exception as error:
                    self._diagnostic(stage, started, error)
                    # Zero is a precise no-maintenance-retained receipt. An earlier
                    # successful quiesce, another maintenance owner, or uncertain
                    # cleanup cannot authorize a fresh attempt on this channel.
                    retryable = (
                        self._generation is None
                        and self._activities.snapshot().phase is ActivityPhase.OPEN
                    )
                    response = b"\x00" if retryable else b"\x02"
                stage = ControlStage.RESPONSE_SEND
                writer.write(struct.pack(">I", len(response)))
                writer.write(response)
                await asyncio.wait_for(writer.drain(), 30)
                del response
        except Exception as error:
            self._diagnostic(stage, started, error)
        finally:
            _LOGGER.info(
                "parent_control_closed pid=%s stage=%s elapsed_ms=%.1f preparations_reported=%s",
                os.getpid(),
                stage.value,
                (monotonic() - started) * 1000,
                sorted(self._reported),
            )
            self._fail_pending_preparations()
            if self._writer is not None:
                # No request survives the private channel. Discard pending
                # output rather than letting a stalled parent prevent shutdown.
                self._writer.transport.abort()
                try:
                    await self._writer.wait_closed()
                except OSError:
                    pass

    def _diagnostic(self, stage: ControlStage, started: float, error: Exception) -> None:
        # No exception text, bootstrap, token or peer frame enters the log.
        _LOGGER.warning(
            "parent_control_failed stage=%s pid=%s elapsed_ms=%s error_type=%s errno=%s winerror=%s pending_preparations=%s",
            stage.value,
            os.getpid(),
            round((monotonic() - started) * 1000),
            type(error).__name__,
            (
                error.errno
                if isinstance(error, OSError)
                and isinstance(error.errno, int)
                and not isinstance(error.errno, bool)
                else None
            ),
            getattr(error, "winerror", None) if isinstance(error, OSError) else None,
            len(PREPARATION_OPERATIONS - self._reported),
        )

    async def _command(self, command: dict) -> bytes:
        if self._closed:
            raise ParentControlError("parent control unavailable")
        operation = command.get("operation")
        if operation in PREPARATION_OPERATIONS:
            complete = self._preparations[operation]
            if (
                set(command)
                != (
                    {"operation", "ready", "resources"}
                    if operation == TOOLCHAIN_OPERATION
                    else {"operation", "ready"}
                )
                or type(command["ready"]) is not bool
                or complete is None
                or operation in self._reported
            ):
                raise ParentControlError("invalid toolchain preparation receipt")
            if operation == SKILL_PYTHON_OPERATION:
                complete(command["ready"])
                self._reported.add(operation)
                return b"\x01"
            try:
                resources = (
                    CompilerResources.from_description(command["resources"])
                    if command["ready"]
                    else None
                )
                if not command["ready"] and command["resources"] is not None:
                    raise ValueError()
            except ValueError:
                raise ParentControlError("invalid toolchain preparation receipt") from None
            complete(command["ready"], resources)
            self._reported.add(operation)
            _LOGGER.info(
                "parent_control_preparation_receipt pid=%s operation=%s ready=%s",
                os.getpid(),
                operation,
                command["ready"],
            )
            return b"\x01"
        operation, requested = command["operation"], command["generation"]
        if operation == UPDATE_PREPARATION_OPERATION and requested is None:
            if self._generation is not None:
                raise ParentControlError("maintenance already owned")
            prepare_update = self._prepare_update
            if prepare_update is None or self._resume_update is None:
                raise ParentControlError("update shutdown preparation unavailable")
            generation = self._activities.begin_restart()
            self._generation = generation

            async def prepare() -> None:
                await prepare_update(generation)

            preparation = asyncio.create_task(prepare(), name="update-shutdown-preparation")
            self._update_preparation = preparation
            started = monotonic()

            def report_preparation(finished: asyncio.Task[None]) -> None:
                if finished.cancelled():
                    return
                error = finished.exception()
                if not isinstance(error, BaseExceptionGroup):
                    return
                cancelled, failures = error.split(asyncio.CancelledError)
                if cancelled is None or failures is None:
                    return
                pending: list[BaseException] = [failures]
                while pending:
                    failure = pending.pop()
                    if isinstance(failure, BaseExceptionGroup):
                        pending.extend(failure.exceptions)
                    elif isinstance(failure, Exception):
                        self._diagnostic(ControlStage.COMMAND_APPLY, started, failure)

            preparation.add_done_callback(report_preparation)
            try:
                completed, _pending = await asyncio.wait(
                    (preparation,), timeout=UPDATE_PREPARATION_SECONDS
                )
                if not completed:
                    raise ParentControlError("update shutdown preparation timed out")
                try:
                    preparation.result()
                except BaseExceptionGroup as error:
                    cancelled, failures = error.split(asyncio.CancelledError)
                    current = asyncio.current_task()
                    if (
                        cancelled is None
                        or not isinstance(failures, ExceptionGroup)
                        or (current is not None and current.cancelling())
                    ):
                        raise
                    raise ParentControlError("update shutdown preparation failed") from error
            except BaseException:
                if not preparation.done() and not preparation.cancelling():
                    preparation.cancel()
                raise
            return b"\x01" + generation.encode("ascii")
        if operation in ("quiesce", IDLE_QUIESCE_OPERATION) and requested is None:
            if self._generation is not None:
                raise ParentControlError("maintenance already owned")
            idle_only = operation == IDLE_QUIESCE_OPERATION
            generation = (
                self._activities.begin_if_idle() if idle_only else self._activities.begin_restart()
            )
            if generation is None:
                raise ParentControlError("maintenance requires idle workbench")
            self._generation = generation
            stage = MaintenanceStage.INTERRUPT
            try:
                # The native owner separately proves complete resource exit.
                # Idle queue polls briefly hold business leases too. Admission
                # is already closed; allow them to finish before deciding busy.
                # Interruption alone never proves resource hosts have exited.
                try:
                    async with asyncio.timeout(
                        MAINTENANCE_INTERRUPT_SECONDS
                        if self._interrupt_running is not None and not idle_only
                        else MAINTENANCE_SETTLE_SECONDS
                    ):
                        if self._interrupt_running is not None and not idle_only:
                            # The user confirmed a restart. Interrupt owned
                            # sessions, then prove their execution leases ended.
                            await self._interrupt_running()
                        if self._drain_attachments is not None:
                            stage = MaintenanceStage.ATTACHMENTS
                            # An interrupt receipt can precede native execution
                            # settlement. Retry attachment suspension after the
                            # session becomes idle, within this maintenance window.
                            while await self._drain_attachments(generation):
                                await asyncio.sleep(MAINTENANCE_DRAIN_RETRY_SECONDS)
                        stage = MaintenanceStage.BUSINESS
                        await self._activities.wait_business_drained(generation)
                except TimeoutError:
                    busy = {
                        domain: count
                        for domain, count in self._activities.snapshot().counts.items()
                        if domain
                        not in (ActivityDomain.RESOURCE.value, ActivityDomain.REQUEST.value)
                        and count
                    }
                    _LOGGER.warning(
                        "update maintenance refused: stage=%s active domains=%s", stage.value, busy
                    )
                    raise ParentControlError("maintenance requires idle workbench") from None
                # Maintenance admission only. The native owner still proves
                # complete source-family exit before candidate startup.
                return b"\x01" + generation.encode("ascii")
            except BaseException:
                snapshot = self._activities.snapshot()
                if snapshot.phase is ActivityPhase.DRAINING and snapshot.generation == generation:
                    self._activities.resume(generation, expected_phase=ActivityPhase.DRAINING)
                self._generation = None
                raise
        if (
            operation == "resume"
            and isinstance(requested, str)
            and _GENERATION.fullmatch(requested)
            and requested == self._generation
        ):
            if self._update_preparation is not None:
                preparation = self._update_preparation
                if (
                    not preparation.done()
                    or preparation.cancelled()
                    or preparation.exception() is not None
                ):
                    raise ParentControlError("update shutdown preparation incomplete")
                snapshot = self._activities.snapshot()
                if snapshot.phase is not ActivityPhase.DRAINING or snapshot.generation != requested:
                    raise MaintenanceStale("update_maintenance_stale")
                resume_update = self._resume_update
                if resume_update is None:
                    raise ParentControlError("update shutdown resume unavailable")
                resume_update(requested)
            self._activities.resume(requested, expected_phase=ActivityPhase.DRAINING)
            self._generation = None
            self._update_preparation = None
            return b"\x01"
        raise ParentControlError("parent control operation unavailable")

    def _fail_pending_preparations(self) -> None:
        for operation, complete in self._preparations.items():
            if complete is not None and operation not in self._reported:
                _LOGGER.warning(
                    "parent_control_preparation_missing pid=%s operation=%s", os.getpid(), operation
                )
                if operation == TOOLCHAIN_OPERATION:
                    complete(False, None)
                else:
                    complete(False)
                self._reported.add(operation)

    async def aclose(self) -> None:
        first_close = not self._closed
        self._closed = True
        self._fail_pending_preparations()
        if self._writer is not None:
            self._writer.transport.abort()
        preparation = self._update_preparation
        if preparation is not None and not preparation.done() and not preparation.cancelling():
            preparation.cancel()
        # Concurrent shutdown owners join the same task. A second cancel would
        # interrupt channel cleanup already handling the first cancellation.
        if first_close and self._task is not None:
            self._task.cancel()
        # Join channel shutdown even under repeated cancellation so lifespan
        # never races an unfinished control task.
        cancellation = None
        for task in (self._task, preparation):
            if task is None:
                continue
            joined = asyncio.gather(task, return_exceptions=True)
            while not joined.done():
                try:
                    await asyncio.shield(joined)
                except asyncio.CancelledError as error:
                    cancellation = error
        if cancellation is not None:
            raise cancellation
