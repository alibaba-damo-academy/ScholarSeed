"""Product runtime process ownership."""

from __future__ import annotations

import asyncio
import logging
import os
import random
import shutil
import time
import uuid
from collections import deque
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from functools import partial
from pathlib import Path
from typing import Any, Callable, Mapping

from scholarseed_codex.activity import (
    NativeActivity,
    subagent_item_summary,
    subagent_lifecycle_payload,
    subagent_status_payload,
)
from scholarseed_codex.admission import NativeAdmission, NativeQuiescence
from scholarseed_codex.attachment import ThreadAttachment
from scholarseed_codex.diagnostic import (
    THREAD_HISTORY_MISSING_ERROR,
    UNSPECIFIED_REASON,
    enable_mcp_diagnostics,
    native_diagnostic,
    stream_diagnostics,
)
from scholarseed_codex.emitter import CodexEmitter
from scholarseed_codex.environment import (
    CODEX_HOME_ENV,
    CODEX_RUNTIME_HOME,
    process_environment_snapshot,
)
from scholarseed_codex.executable import _resolve_launch_arguments
from scholarseed_codex.history import (
    history_entries,
    resume_turn_snapshots,
    terminal_turn_status,
)
from scholarseed_codex.interaction import hil_payload, hil_response
from scholarseed_codex.isolation import projected_mcp_arguments
from scholarseed_codex.launch import (
    CODEX_SKILLS_POLICY_UNSUPPORTED,
    validate_thread_model,
)
from scholarseed_codex.launcher import MCP_SECRET_ENVIRONMENT_PREFIX
from scholarseed_codex.mcp import MCP_RELOAD_METHOD, NativeMcpInventory, verify_mcp_inventory
from scholarseed_codex.mutex import startup_mutex
from scholarseed_codex.permission import (
    PERMISSION_SCOPE_NEXT_TURN,
    PERMISSION_SCOPE_SESSION,
    PERMISSION_SCOPE_TURN,
    PERMISSION_SETTINGS_UNCONFIRMED,
    THREAD_SETTINGS_UPDATE_METHOD,
    THREAD_SETTINGS_UPDATED_METHOD,
    TURN_SETTINGS_APPLIED,
    TURN_SETTINGS_UNAVAILABLE,
    TURN_SETTINGS_UPDATE_METHOD,
    PermissionUpdate,
    reviewer_only_update,
    sandbox_policy,
)
from scholarseed_codex.protocol.mcp import JsonValue
from scholarseed_codex.protocol.session import (
    CodexRuntimeIdentity,
    CodexRuntimeLaunchArgument,
    CodexRuntimeReadiness,
    CodexRuntimeStatus,
    CodexSessionEventKind,
    CodexSessionEventObserver,
    CodexSessionOpenRequest,
    CodexToolResponse,
)
from scholarseed_codex.protocol.state import (
    AGENT_RUNTIME_STOP_TIMEOUT_SECONDS,
    CODEX_APP_SERVER_LISTEN,
    CODEX_BENIGN_NOTIFICATION_METHODS,
    CODEX_DEFAULT_APPROVAL_POLICY,
    CODEX_DEFAULT_BIN,
    CODEX_DEFAULT_CLIENT_NAME,
    CODEX_DEFAULT_CLIENT_TITLE,
    CODEX_DEFAULT_CLIENT_VERSION,
    CODEX_DEFAULT_SANDBOX_MODE,
    CODEX_DEFAULT_SERVICE_NAME,
    CODEX_FS_CHANGED_METHOD,
    CODEX_HISTORY_ROLE_ASSISTANT,
    CODEX_HISTORY_ROLE_USER,
    CODEX_MAX_CONCURRENT_THREAD_RESUMES,
    CODEX_MAX_DIAGNOSTIC_LINES,
    CODEX_MAX_RECOVERY_ATTEMPTS,
    CODEX_MAX_RUNTIME_EVIDENCE,
    CODEX_MULTI_AGENT_MODES,
    CODEX_RECOVERY_BACKOFF_MULTIPLIER,
    CODEX_RECOVERY_INITIAL_DELAY_SECONDS,
    CODEX_RECOVERY_JITTER_RATIO,
    CODEX_RECOVERY_MAX_DELAY_SECONDS,
    CODEX_RECOVERY_TOTAL_TIMEOUT_SECONDS,
    CODEX_RPC_TIMEOUT_SECONDS,
    CODEX_RUNTIME_ID,
    CODEX_SKILLS_EXTRA_ROOTS_SET_METHOD,
    CODEX_STREAM_LIMIT_BYTES,
    CODEX_SUBMISSION_RETRY_STALE,
    CODEX_THREAD_INJECT_ITEMS_METHOD,
    CODEX_UNAVAILABLE_ERROR,
    MCP_CONFIG_NOTIFICATION_PREFIX,
    MCP_NOTIFICATION_PREFIX,
    RPC_INVALID_PARAMS,
    RPC_METHOD_NOT_FOUND,
    AppServerError,
    CodexProcessState,
    CodexThreadAttachmentState,
    McpNotificationHandler,
    _PendingRequest,
    logger,
    normalized_roots,
)
from scholarseed_codex.router import AgentRoute, ThreadRouter
from scholarseed_codex.rpc import (
    JsonLineWriter,
    PendingRequests,
    RpcSubmission,
    RpcSubmissionState,
    read_messages,
)
from scholarseed_codex.sandbox import (
    SANDBOX_COMPLETED_METHOD,
    SANDBOX_EXECUTION_TIMEOUT_MS,
    SANDBOX_READONLY_ARGUMENT,
    WindowsSandboxBootstrap,
)
from scholarseed_codex.shutdown import ShutdownObservation, observe_shutdown
from scholarseed_codex.turn import CodexTurnRuntime
from scholarseed_codex.watch import WorkspaceWatch
from scholarseed_runtime.contract.evidence import (
    RuntimeProcessEvent,
    RuntimeProcessEventKind,
    RuntimeRpcEvidence,
)
from scholarseed_runtime.contract.history import (
    HistoryEntry,
    ResumeTurnSnapshot,
)
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.inventory import SkillPolicy
from scholarseed_runtime.contract.resource import RESOURCE_HOST_CONFIGURATION_CONFLICT
from scholarseed_runtime.contract.sandbox import (
    SANDBOX_STARTUP_ERRORS,
    SandboxRecovery,
    SandboxResources,
)
from scholarseed_runtime.contract.session import RUNTIME_SUSPEND_BUSY, RUNTIME_SUSPEND_STALE

LOGGER = logging.getLogger(__name__)

NATIVE_PROCESS_NOT_READY = "native_process_not_ready"
NATIVE_COMMAND_UNSETTLED = "native_command_unsettled"
NATIVE_CALLBACK_PENDING = "native_callback_pending"
THREAD_CONFIGURATION_MISMATCH = "codex_thread_configuration_mismatch"
THREAD_UNSUBSCRIBE_METHOD = "thread/unsubscribe"
THREAD_ID_KEY = "threadId"
UNSUBSCRIBE_STATUS_KEY = "status"
THREAD_UNSUBSCRIBE_STATUSES = frozenset({"unsubscribed", "notSubscribed", "notLoaded"})
SUBAGENT_PROGRESS_INTERVAL_SECONDS = 15
SUBAGENT_STREAM_ACTIVITIES = {
    "item/agentMessage/delta": "message",
    "item/reasoning/summaryTextDelta": "reasoning",
    "item/reasoning/textDelta": "reasoning",
    "item/commandExecution/outputDelta": "command",
}
SUBAGENT_ITEM_ACTIVITIES = {
    "agentMessage": "message",
    "reasoning": "reasoning",
    "webSearch": "search",
    "commandExecution": "command",
    "mcpToolCall": "tool",
    "dynamicToolCall": "tool",
    "fileChange": "edit",
    "plan": "plan",
}
SUBAGENT_ITEM_BOUNDARIES = frozenset({"item/started", "item/completed"})
SUBAGENT_GENERIC_ACTIVITY = "work"
THREAD_RESUME_FAILED = "thread_resume_failed"
THREAD_CLOSED_ERROR = "codex_thread_closed"
THREAD_RECOVERY_FAILED = "agent_runtime_unavailable"
THREAD_ATTACHMENT_RECOVERABLE_ERRORS = frozenset(
    {"agent_runtime_exit", "runtime_transport_lost", "runtime_rpc_timeout", RUNTIME_SUSPEND_STALE}
)


@dataclass(eq=False)
class _ThreadOpening:
    thread_id: str
    remaining_attempts: int
    generation: int = 0
    process: asyncio.subprocess.Process | None = None
    reader: asyncio.Task[None] | None = None


def _confirmed_thread_model(result: Mapping[str, Any], request: CodexSessionOpenRequest) -> str:
    model = str(result.get("model") or "")
    provider = str(result.get("modelProvider") or "")
    if (
        not model
        or not provider
        or (request.model and model != request.model)
        or (request.model_provider and provider != request.model_provider)
    ):
        raise AppServerError(
            "Codex App Server did not apply the requested thread model configuration",
            safe_error=THREAD_CONFIGURATION_MISMATCH,
            retryability=RuntimeRetryability.TERMINAL,
        )
    return model


class CodexProcessHost:
    """Own one App Server process and route all of its Codex threads."""

    def __init__(
        self,
        *,
        executable: str = "",
        version: str = "",
        identity: CodexRuntimeIdentity | None = None,
        launch_cwd: Path | None = None,
        process_environment: Mapping[str, str] | None = None,
        launch_environment: Mapping[str, str] | None = None,
        remove_environment: tuple[str, ...] = (),
        launch_arguments: tuple[CodexRuntimeLaunchArgument, ...] = (),
        skill_roots: tuple[Path, ...] = (),
        rpc_timeout: float = CODEX_RPC_TIMEOUT_SECONDS,
        max_threads: int | None = None,
        max_recovery_attempts: int = CODEX_MAX_RECOVERY_ATTEMPTS,
        recovery_initial_delay: float = CODEX_RECOVERY_INITIAL_DELAY_SECONDS,
        recovery_max_delay: float = CODEX_RECOVERY_MAX_DELAY_SECONDS,
        recovery_jitter_ratio: float = CODEX_RECOVERY_JITTER_RATIO,
        recovery_total_timeout: float = CODEX_RECOVERY_TOTAL_TIMEOUT_SECONDS,
        sandbox_setup_lock: asyncio.Lock | None = None,
        sandbox_resources: SandboxResources | None = None,
        sandbox_recovery: SandboxRecovery | None = None,
        startup_scope: Callable[[], AbstractAsyncContextManager[None]] | None = None,
        provider_configuration: Mapping[str, Any] | None = None,
    ) -> None:
        self.executable = executable or shutil.which(CODEX_DEFAULT_BIN) or CODEX_DEFAULT_BIN
        self.version = version
        self.identity = identity or CodexRuntimeIdentity()
        self.launch_cwd = (launch_cwd or Path.cwd()).expanduser().resolve()
        self.process_environment = {
            str(name): str(value)
            for name, value in dict(process_environment or {}).items()
            if str(name).strip()
        }
        self.launch_arguments = tuple(launch_arguments)
        self._startup_scope = startup_scope
        self.provider_configuration = dict(provider_configuration or {})
        self._mcp_environment: tuple[tuple[str, str], ...] | None = None
        self._sandbox = WindowsSandboxBootstrap(
            self.launch_arguments,
            sandbox_setup_lock,
            sandbox_resources,
            version,
            recovery=sandbox_recovery,
            executable=Path(self.executable),
        )
        self.remove_environment = tuple(sorted(set(remove_environment)))
        self._launch_environment = (
            process_environment_snapshot(self.process_environment, self.remove_environment)
            if launch_environment is None
            else dict(launch_environment)
        )
        self.rpc_timeout = rpc_timeout
        self.max_threads = max_threads
        self.max_recovery_attempts = max(1, max_recovery_attempts)
        self.recovery_initial_delay = max(0.0, recovery_initial_delay)
        self.recovery_max_delay = max(0.0, recovery_max_delay)
        self.recovery_jitter_ratio = max(0.0, recovery_jitter_ratio)
        self.recovery_total_timeout = max(0.0, recovery_total_timeout)
        self.state = CodexProcessState.STOPPED
        self.initialize_result: dict[str, Any] = {}
        self._generation = 0
        self._exited_generations: deque[int] = deque(maxlen=CODEX_MAX_RUNTIME_EVIDENCE)
        self._activity_revision = 0
        self._unscoped_activity_revision = 0
        self._thread_activity_revisions: dict[str, int] = {}
        self._stop_committed = False
        self._recovery_attempt = 0
        self._registration_epoch = 0
        self._closed = False
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._recovery_task: asyncio.Task[None] | None = None
        self._start_lock = asyncio.Lock()
        self._rpc_writer = JsonLineWriter()
        self._emitter = CodexEmitter()
        self._evidence_seq = 0
        self._started_evidence_seq = 0
        self._rpc_requests = PendingRequests()
        self._threads: dict[str, ThreadAttachment] = {}
        self._opening_threads: set[_ThreadOpening] = set()
        self._known_roots: set[str] = set()
        self._unconfirmed_attachment_generations: set[int] = set()
        self._router = ThreadRouter()
        self._pending_hil: dict[str, _PendingRequest] = {}
        self._pending_tools: dict[str, _PendingRequest] = {}
        self._request_routes: dict[str, tuple[str, str]] = {}
        self._stderr_lines: deque[str] = deque(maxlen=CODEX_MAX_DIAGNOSTIC_LINES)
        self._diagnostics: deque[str] = deque(maxlen=CODEX_MAX_DIAGNOSTIC_LINES)
        self._watcher = WorkspaceWatch(self._request_connected, self._diagnostics.append)
        self._protocol_errors: deque[str] = deque(maxlen=CODEX_MAX_DIAGNOSTIC_LINES)
        self._process_events: deque[RuntimeProcessEvent] = deque(maxlen=CODEX_MAX_RUNTIME_EVIDENCE)
        self._rpc_evidence: deque[RuntimeRpcEvidence] = deque(maxlen=CODEX_MAX_RUNTIME_EVIDENCE)
        self._skill_roots = {str(path.expanduser().resolve()) for path in skill_roots}
        self.admission = NativeAdmission()

    @property
    def known_roots(self) -> tuple[str, ...]:
        return tuple(sorted(self._known_roots))

    @property
    def reusable(self) -> bool:
        return not self._unconfirmed_attachment_generations and not self.admission.failed

    def _unconfirm_attachment(self, generation: int) -> None:
        if generation not in self._exited_generations:
            self._unconfirmed_attachment_generations.add(generation)

    @property
    def activity_revision(self) -> int:
        return self._activity_revision

    def thread_activity_revision(self, thread_id: str) -> int:
        return self._unscoped_activity_revision + self._thread_activity_revisions.get(thread_id, 0)

    def _record_activity(self, thread_id: str) -> None:
        self._activity_revision += 1
        agent = self._router.agent(thread_id)
        owner = agent.owner_thread_id if agent is not None else thread_id
        if owner in self._threads:
            self._thread_activity_revisions[owner] = (
                self._thread_activity_revisions.get(owner, 0) + 1
            )
        else:
            self._unscoped_activity_revision += 1

    @property
    def stop_committed(self) -> bool:
        return self._stop_committed

    def retain_loaded_roots(self, loaded: tuple[str, ...]) -> None:
        self._known_roots.intersection_update(set(loaded) | self._threads.keys())
        self._thread_activity_revisions = {
            thread_id: revision
            for thread_id, revision in self._thread_activity_revisions.items()
            if thread_id in self._threads
        }

    def _configuration_threads(self) -> tuple[str, ...]:
        return tuple(
            sorted(
                thread_id
                for thread_id, state in self._threads.items()
                if state.attachment_state is not CodexThreadAttachmentState.CLOSED
                and (not self._generation or state.absent_generation != self._generation)
            )
        )

    def configuration_quiescence_current(self, ticket: NativeQuiescence) -> bool:
        return (
            not self._closed
            and self.state is CodexProcessState.READY
            and self._proc is not None
            and self._proc.returncode is None
            and ticket.process_generation == self._generation
            and ticket.activity_revision == self._activity_revision
            and ticket.admission_epoch == self.admission.epoch
            and self.admission.frozen(ticket.configuration_revision)
            and not self._rpc_requests.unsettled(self._generation)
            and not self._pending_hil
            and not self._pending_tools
            and not any(
                self.suspend_blockers(thread_id) for thread_id in self._configuration_threads()
            )
        )

    @property
    def configuration_blockers(self) -> tuple[str, ...]:
        return tuple(
            sorted(
                {
                    blocker
                    for thread_id in self._configuration_threads()
                    for blocker in self.suspend_blockers(thread_id)
                }
            )
        )

    async def configuration_quiescence(self, revision: int) -> NativeQuiescence | None:
        ticket = NativeQuiescence(
            revision, self._generation, self._activity_revision, self.admission.epoch
        )
        if not self.configuration_quiescence_current(ticket):
            return None
        activity = await NativeActivity(self, known_roots=self.known_roots).inspect()
        for thread_id in activity.loaded_thread_ids:
            state = self._threads.get(thread_id)
            if state is not None and state.absent_generation == self._generation:
                state.absent_generation = 0
                self._activity_revision += 1
        if (
            not activity.complete
            or activity.blockers
            or activity.process_generation != ticket.process_generation
            or not self.configuration_quiescence_current(ticket)
        ):
            return None
        return ticket

    async def reload_mcp(self, ticket: NativeQuiescence) -> None:
        if not self.configuration_quiescence_current(ticket):
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        for state in self._threads.values():
            if state.mcp_invalidate is not None:
                state.mcp_invalidate()
        try:
            await self._request_connected(
                MCP_RELOAD_METHOD, None, generation=ticket.process_generation
            )
        finally:
            for state in self._threads.values():
                if state.mcp_invalidate is not None:
                    state.mcp_invalidate()

    async def verify_mcp_configuration(
        self,
        ticket: NativeQuiescence,
        expected_servers: frozenset[str],
        *,
        disabled_servers: frozenset[str] = frozenset(),
        include_threads: bool = True,
    ) -> NativeMcpInventory:
        thread_ids = self._configuration_threads() if include_threads else ()

        def check() -> None:
            if (
                self._closed
                or self.state is not CodexProcessState.READY
                or ticket.process_generation != self._generation
                or ticket.admission_epoch != self.admission.epoch
                or not self.admission.frozen(ticket.configuration_revision)
                or thread_ids != (self._configuration_threads() if include_threads else ())
            ):
                raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)

        async def request(method: str, params: Any) -> dict[str, Any]:
            check()
            result = await self._request_connected(
                method, params, generation=ticket.process_generation
            )
            check()
            return result

        check()
        return await verify_mcp_inventory(
            request,
            thread_ids,
            expected_servers,
            disabled_servers,
        )

    def prepare_mcp_launch(self, environment: tuple[tuple[str, str], ...]) -> None:
        if self._proc is not None:
            raise AppServerError(RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY)
        self._mcp_environment = environment

    def mcp_launch_matches(self, environment: tuple[tuple[str, str], ...]) -> bool:
        return self._mcp_environment == environment

    async def verify_mcp_startup(
        self,
        expected_servers: frozenset[str],
        *,
        disabled_servers: frozenset[str] = frozenset(),
        include_threads: bool = False,
    ) -> NativeMcpInventory:
        generation = self._generation
        thread_ids = self._configuration_threads() if include_threads else ()

        async def request(method: str, params: Any) -> dict[str, Any]:
            if (
                generation != self._generation
                or self.state is not CodexProcessState.READY
                or thread_ids != (self._configuration_threads() if include_threads else ())
            ):
                raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
            result = await self._request_connected(method, params, generation=generation)
            if (
                generation != self._generation
                or self.state is not CodexProcessState.READY
                or thread_ids != (self._configuration_threads() if include_threads else ())
            ):
                raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
            return result

        return await verify_mcp_inventory(
            request,
            thread_ids,
            expected_servers,
            disabled_servers,
        )

    def suspend_blockers(self, thread_id: str) -> tuple[str, ...]:
        state = self._threads.get(thread_id)
        blockers: list[str] = []
        if self.state is not CodexProcessState.READY or state is None:
            blockers.append(NATIVE_PROCESS_NOT_READY)
        if state is not None and (
            state.turn.active_turn_id
            or state.turn.ambiguous_submission_id
            or (state.turn.turn_done is not None and not state.turn.turn_done.done())
        ):
            blockers.append(NATIVE_COMMAND_UNSETTLED)
        if any(
            pending.thread_id == thread_id
            for pending in (*self._pending_hil.values(), *self._pending_tools.values())
        ):
            blockers.append(NATIVE_CALLBACK_PENDING)
        return tuple(blockers)

    def turn_confirmation_current(
        self,
        thread_id: str,
        submission_id: str,
        incident_id: str,
        failed_generation: int,
        generation: int,
        registration_epoch: int,
        revision: int,
    ) -> bool:
        state = self._threads.get(thread_id)
        return (
            state is not None
            and not self._closed
            and not self.admission.failed
            and self.state is CodexProcessState.READY
            and self._proc is not None
            and self._proc.returncode is None
            and failed_generation > 0
            and failed_generation in self._exited_generations
            and generation == self._generation
            and generation > failed_generation
            and state.registration_epoch == registration_epoch
            and state.attachment_state is CodexThreadAttachmentState.ATTACHED
            and state.attached_generation == generation
            and self.thread_activity_revision(thread_id) == revision
            and state.turn.ambiguous_submission_id == submission_id
            and state.turn.ambiguous_incident_id == incident_id
            and state.turn.ambiguous_generation == failed_generation
            and bool(submission_id and incident_id)
            and not state.turn.active_turn_id
            and not state.turn.interrupted_turn_id
            and (state.turn.turn_done is None or state.turn.turn_done.done())
            and not self._rpc_requests.unsettled(self._generation)
            and not any(
                pending.thread_id == thread_id
                for pending in (*self._pending_hil.values(), *self._pending_tools.values())
            )
        )

    def turn_confirmation_identity(self, thread_id: str) -> tuple[int, int, int]:
        state = self._threads.get(thread_id)
        if state is None:
            return self._generation, 0, self.thread_activity_revision(thread_id)
        return self._generation, state.registration_epoch, self.thread_activity_revision(thread_id)

    def confirm_turn_submission(
        self,
        thread_id: str,
        submission_id: str,
        incident_id: str,
        failed_generation: int,
        generation: int,
        registration_epoch: int,
        revision: int,
    ) -> bool:
        if not self.turn_confirmation_current(
            thread_id,
            submission_id,
            incident_id,
            failed_generation,
            generation,
            registration_epoch,
            revision,
        ):
            return False
        turn = self._threads[thread_id].turn
        turn.ambiguous_submission_id = ""
        turn.ambiguous_incident_id = ""
        turn.ambiguous_generation = 0
        self._record_activity(thread_id)
        return True

    async def suspend_thread(self, thread_id: str, expected_generation: int) -> None:
        if expected_generation != self._generation:
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        if self.suspend_blockers(thread_id):
            raise AppServerError(RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY)
        state = self.attachment(thread_id)
        result = await self.request(
            THREAD_UNSUBSCRIBE_METHOD,
            {THREAD_ID_KEY: thread_id},
            generation=expected_generation,
        )
        if result.get(UNSUBSCRIBE_STATUS_KEY) not in THREAD_UNSUBSCRIBE_STATUSES:
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        if expected_generation != self._generation:
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        await self._watcher.close(state.turn, self._generation, True)
        state.turn.abandon_files()
        state.attachment_state = CodexThreadAttachmentState.CLOSED
        self._threads.pop(thread_id, None)
        self._router.close(thread_id)

    async def stop_idle(self, expected_generation: int) -> None:
        """Commit a safe shutdown; EOF may take time, but never escalates to killing."""
        async with observe_shutdown("idle_stop", self.pid, expected_generation) as observation:
            with observation.phase("idle_stop"):
                await self._stop_observed_idle(expected_generation, observation)

    async def _stop_observed_idle(
        self, expected_generation: int, observation: ShutdownObservation
    ) -> None:
        if expected_generation != self._generation:
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        if self._threads or self._pending_hil or self._pending_tools:
            raise AppServerError(RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY)
        if self._known_roots:
            activity_revision = self._activity_revision
            with observation.phase("native_activity_inspection"):
                activity = await NativeActivity(self, known_roots=self.known_roots).inspect()
            if (
                not activity.complete
                or activity.blockers
                or activity_revision != self._activity_revision
            ):
                raise AppServerError(RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY)
            if expected_generation != self._generation:
                raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        self._closed = True
        self.state = CodexProcessState.CLOSING
        self._stop_committed = True
        self.admission.close()
        proc = self._proc
        if proc is not None:
            observation.process = proc
            with observation.phase("stdin_close"):
                if proc.stdin is not None and not proc.stdin.is_closing():
                    proc.stdin.close()
            with observation.phase("process_wait"):
                # An already-pending Process.wait() also waits for pipe EOF.
                # Descendants can inherit those pipes after the owned process exits;
                # returncode is set by the OS exit callback independently of EOF.
                while proc.returncode is None:
                    await asyncio.sleep(0.01)
                await proc.wait()
            observation.emit("process_exited", returncode=proc.returncode)
            # Real OS exit is the ownership boundary; do not detach the reader earlier.
            await self._discard_process(proc, expected_generation)
        self.state = CodexProcessState.STOPPED
        self._record_process_event(RuntimeProcessEventKind.STOPPED)

    @property
    def pid(self) -> int | None:
        return self._proc.pid if self._proc is not None else None

    @property
    def thread_count(self) -> int:
        return len(self._threads)

    @property
    def process_generation(self) -> int:
        return self._generation

    @property
    def recovery_task(self) -> asyncio.Task[None] | None:
        return self._recovery_task

    @property
    def stderr_lines(self) -> tuple[str, ...]:
        return tuple(self._stderr_lines)

    @property
    def protocol_errors(self) -> tuple[str, ...]:
        return tuple(self._protocol_errors)

    @property
    def diagnostics(self) -> tuple[str, ...]:
        return tuple(self._diagnostics)

    @property
    def skill_roots(self) -> tuple[str, ...]:
        return tuple(sorted(self._skill_roots))

    @property
    def process_events(self) -> tuple[RuntimeProcessEvent, ...]:
        return tuple(self._process_events)

    @property
    def rpc_evidence(self) -> tuple[RuntimeRpcEvidence, ...]:
        return tuple(self._rpc_evidence)

    @property
    def readiness(self) -> CodexRuntimeReadiness:
        ready = self.state == CodexProcessState.READY
        return CodexRuntimeReadiness(
            runtime_id=CODEX_RUNTIME_ID,
            status=CodexRuntimeStatus.READY if ready else CodexRuntimeStatus.ERROR,
            ready=ready,
            executable=self.executable,
            version=self.version or str(self.initialize_result.get("userAgent") or ""),
            authenticated=None,
            process_state=self.state.value,
            safe_error="" if ready else "agent runtime not ready",
            process_generation=self._generation,
            recovery_attempt=self._recovery_attempt,
            max_recovery_attempts=self.max_recovery_attempts,
        )

    def _record_process_event(
        self,
        kind: RuntimeProcessEventKind,
        *,
        generation: int | None = None,
        incident_id: str = "",
        process_exit_code: int | None = None,
    ) -> None:
        self._evidence_seq += 1
        event = RuntimeProcessEvent(
            runtime_id=CODEX_RUNTIME_ID,
            kind=kind,
            process_generation=self._generation if generation is None else generation,
            process_state=self.state.value,
            evidence_seq=self._evidence_seq,
            created_at=datetime.now(timezone.utc).isoformat(),
            pid=self.pid,
            executable=self.executable,
            version=self.version or str(self.initialize_result.get("userAgent") or ""),
            incident_id=incident_id,
            process_exit_code=process_exit_code,
            recovery_attempt=self._recovery_attempt,
        )
        self._process_events.append(event)
        if kind == RuntimeProcessEventKind.STARTED:
            self._started_evidence_seq = event.evidence_seq

    def _record_rpc_success(self, method: str, generation: int, latency_ms: int) -> None:
        self._evidence_seq += 1
        self._rpc_evidence.append(
            RuntimeRpcEvidence(
                runtime_id=CODEX_RUNTIME_ID,
                method=method,
                process_generation=generation,
                latency_ms=max(0, latency_ms),
                evidence_seq=self._evidence_seq,
                created_at=datetime.now(timezone.utc).isoformat(),
            )
        )

    async def start(self) -> None:
        self.admission.require_healthy()
        recovery_task = self._recovery_task
        if (
            recovery_task is not None
            and recovery_task is not asyncio.current_task()
            and not recovery_task.done()
        ):
            await asyncio.shield(recovery_task)
            if self.state == CodexProcessState.READY:
                return
            raise AppServerError(
                "Codex App Server recovery did not restore the process",
                safe_error="agent_runtime_unavailable",
            )
        async with self._start_lock:
            if self._closed or self.state == CodexProcessState.CLOSING:
                raise AppServerError(
                    "Codex App Server host is closed",
                    safe_error="agent_runtime_closed",
                    retryability=RuntimeRetryability.TERMINAL,
                )
            if (
                self._proc is not None
                and self._proc.returncode is None
                and self.state in {CodexProcessState.READY, CodexProcessState.RECOVERING}
            ):
                return
            await self._start_process()

    async def _start_process(self) -> None:
        self.admission.require_healthy()
        self._require_process_release()
        async with AsyncExitStack() as scope:
            if self._startup_scope is not None:
                await scope.enter_async_context(self._startup_scope())
            await scope.enter_async_context(startup_mutex())
            if os.name != "nt":
                await self._launch_process()
                return
            # Cancellation must not release coordination while the official
            # elevated helper is still finishing its setup request.
            launch = asyncio.create_task(self._launch_process())
            cancelled = False
            while not launch.done():
                try:
                    await asyncio.shield(launch)
                except asyncio.CancelledError:
                    cancelled = True
                except Exception:
                    break
            if cancelled:
                # Consume the terminal result and close the process before the
                # next owner is admitted, including repeated caller cancellation.
                failure = None
                if not launch.cancelled():
                    failure = launch.exception()
                    if failure is not None:
                        LOGGER.warning(
                            "codex_launch_failed_during_cancellation",
                            exc_info=(type(failure), failure, failure.__traceback__),
                        )
                if self._proc is not None:
                    cleanup = asyncio.create_task(
                        self._discard_process(self._proc, self._generation)
                    )
                    while not cleanup.done():
                        try:
                            await asyncio.shield(cleanup)
                        except asyncio.CancelledError:
                            pass
                        except Exception:
                            break
                    try:
                        cleanup.result()
                    except Exception:
                        LOGGER.exception("codex_launch_cleanup_failed_during_cancellation")
                if isinstance(failure, AppServerError):
                    if failure.safe_error in SANDBOX_STARTUP_ERRORS:
                        raise asyncio.CancelledError from failure
                raise asyncio.CancelledError
            launch.result()

    def _require_process_release(self) -> None:
        if self._proc is not None:
            # Transport EOF does not prove that the owned OS process has exited.
            raise AppServerError(
                "Codex App Server process exit is still pending",
                safe_error="agent_runtime_unavailable",
                generation=self._generation,
                retryability=RuntimeRetryability.IN_PROGRESS,
            )

    async def _launch_process(self) -> None:
        self.admission.require_healthy()
        self._require_process_release()
        self._generation += 1
        self._stop_committed = False
        generation = self._generation
        self.state = CodexProcessState.STARTING
        self._record_process_event(RuntimeProcessEventKind.STARTING)
        child_environment = dict(self._launch_environment)
        if self._mcp_environment is not None:
            child_environment = {
                name: value
                for name, value in child_environment.items()
                if not name.casefold().startswith(MCP_SECRET_ENVIRONMENT_PREFIX.casefold())
            }
            child_environment.update(self._mcp_environment)
            enable_mcp_diagnostics(child_environment)
        arguments = ["app-server", "--listen", CODEX_APP_SERVER_LISTEN]
        resolved_arguments = _resolve_launch_arguments(self.launch_arguments, child_environment)
        if self._mcp_environment is not None:
            resolved_arguments = projected_mcp_arguments(resolved_arguments)
        arguments.extend(resolved_arguments)
        if self._sandbox.enabled:
            arguments.extend((SANDBOX_READONLY_ARGUMENT.option, SANDBOX_READONLY_ARGUMENT.value))

        try:
            proc = await asyncio.create_subprocess_exec(
                self.executable,
                *arguments,
                cwd=str(self.launch_cwd),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=CODEX_STREAM_LIMIT_BYTES,
                env=child_environment,
            )
        except FileNotFoundError as exc:
            self.state = CodexProcessState.UNAVAILABLE
            self._record_process_event(RuntimeProcessEventKind.UNAVAILABLE)
            raise AppServerError(
                f"Codex CLI not found: {self.executable!r}; install it and authenticate first",
                safe_error=CODEX_UNAVAILABLE_ERROR,
                generation=generation,
                retryability=RuntimeRetryability.TERMINAL,
            ) from exc
        self._proc = proc
        if self._closed:
            # Shutdown may finish while CreateProcess is still being awaited.
            # Never initialize this late child or trigger native setup from it.
            await self._discard_process(proc, generation)
            raise AppServerError(
                "Codex host closed during startup",
                safe_error="agent_runtime_closed",
                retryability=RuntimeRetryability.TERMINAL,
            )
        self._rpc_writer.attach(proc.stdin, generation)
        self._reader_task = asyncio.create_task(self._read_stdout(proc, generation))
        self._stderr_task = asyncio.create_task(self._drain_stderr(proc, generation))
        try:
            self.initialize_result = await self._request_connected(
                "initialize",
                {
                    "clientInfo": {
                        "name": self.identity.client_name or CODEX_DEFAULT_CLIENT_NAME,
                        "title": self.identity.client_title or CODEX_DEFAULT_CLIENT_TITLE,
                        "version": self.identity.client_version or CODEX_DEFAULT_CLIENT_VERSION,
                    },
                    "capabilities": {"experimentalApi": True},
                },
                generation=generation,
            )
            await self._notify("initialized", {}, generation=generation)
            initialization_cwd = self._sandbox.initialization_cwd(self.launch_cwd)
            await self._sandbox.verify_initialization_permissions(
                self._request_connected, initialization_cwd
            )
            await self._sandbox.ensure_ready(
                self._request_connected,
                initialization_cwd,
                generation,
                cleanup=lambda: self._discard_process(proc, generation),
                pid=proc.pid,
                home=Path(child_environment.get(CODEX_HOME_ENV, str(CODEX_RUNTIME_HOME))),
                prepare_resources=False,
            )
            await self._sandbox.ensure_execution_ready(
                partial(
                    self._request_connected,
                    timeout=self._sandbox.initial_execution_timeout(generation, self.rpc_timeout),
                ),
            )
            if self._skill_roots:
                await self._set_skill_roots(self._skill_roots, generation=generation)
            if generation != self._generation or proc is not self._proc:
                raise AppServerError(
                    "Codex App Server generation changed during initialization",
                    safe_error="codex_generation_changed",
                    generation=generation,
                )
            self.state = CodexProcessState.READY
            self._record_process_event(RuntimeProcessEventKind.STARTED)
        except BaseException as error:
            if self.state != CodexProcessState.CLOSING:
                self.state = CodexProcessState.CRASHED
            if proc is self._proc and generation == self._generation:
                self._unconfirm_attachment(generation)
                try:
                    await self._discard_process(proc, generation)
                except Exception as cleanup_error:
                    LOGGER.exception("codex_launch_cleanup_failed")
                    raise error from cleanup_error
            if self.state != CodexProcessState.CLOSING and generation in self._exited_generations:
                self._record_process_event(
                    RuntimeProcessEventKind.EXITED,
                    generation=generation,
                )
            raise

    async def request(
        self, method: str, params: Any, *, generation: int | None = None
    ) -> dict[str, Any]:
        if generation is None:
            await self.start()
        return await self._request_connected(method, params, generation=generation)

    async def _request_connected(
        self,
        method: str,
        params: Any,
        *,
        generation: int | None = None,
        timeout: float | None = None,
        before_write: Callable[[], None] | None = None,
        submission: RpcSubmission | None = None,
    ) -> dict[str, Any]:
        request_generation = self._generation if generation is None else generation
        request_proc = self._proc
        if request_proc is None or request_generation != self._generation:
            raise AppServerError(
                "Codex App Server transport is not connected",
                safe_error="runtime_transport_lost",
                method=method,
                generation=request_generation,
                retryability=RuntimeRetryability.USER_RETRYABLE,
            )
        thread_id = params.get(THREAD_ID_KEY) if isinstance(params, Mapping) else None
        request_id, pending = self._rpc_requests.begin(
            request_generation,
            method,
            thread_id=thread_id if isinstance(thread_id, str) else "",
            submission=submission,
        )
        future = pending.future
        try:
            await self._rpc_writer.write(
                {"id": request_id, "method": method, "params": params},
                generation=request_generation,
                on_written=pending.mark_written,
                before_write=before_write,
                on_write_attempt=pending.submission.attempt,
            )
            result = await asyncio.wait_for(
                asyncio.shield(future), timeout=self.rpc_timeout if timeout is None else timeout
            )
            self._record_rpc_success(
                method,
                request_generation,
                round((asyncio.get_running_loop().time() - pending.started_at) * 1000),
            )
            return result
        except AppServerError as exc:
            exc.rpc_latency_ms = max(
                0,
                round((asyncio.get_running_loop().time() - pending.started_at) * 1000),
            )
            if exc.safe_error == "runtime_transport_lost":
                future.cancel()
                await self._discard_process(request_proc, request_generation)
                await self._handle_process_exit(generation=request_generation)
            raise
        except asyncio.TimeoutError as exc:
            retryability = (
                RuntimeRetryability.UNKNOWN_OUTCOME
                if pending.written
                or pending.submission.state is not RpcSubmissionState.NOT_SUBMITTED
                else RuntimeRetryability.USER_RETRYABLE
            )
            raise AppServerError(
                f"App Server request timed out: {method}",
                safe_error="runtime_rpc_timeout",
                method=method,
                generation=request_generation,
                rpc_latency_ms=max(
                    0,
                    round((asyncio.get_running_loop().time() - pending.started_at) * 1000),
                ),
                retryability=retryability,
            ) from exc
        finally:
            self._rpc_requests.discard(request_id)

    async def _notify(
        self,
        method: str,
        params: Mapping[str, Any],
        *,
        generation: int | None = None,
    ) -> None:
        await self._rpc_writer.write(
            {"method": method, "params": dict(params)},
            generation=self._generation if generation is None else generation,
        )

    async def _respond(
        self,
        request_id: Any,
        result: Mapping[str, Any],
        *,
        generation: int | None = None,
    ) -> None:
        await self._rpc_writer.write(
            {"id": request_id, "result": dict(result)},
            generation=self._generation if generation is None else generation,
        )

    async def _respond_error(
        self,
        request_id: Any,
        code: int,
        message: str,
        *,
        generation: int | None = None,
    ) -> None:
        await self._rpc_writer.write(
            {"id": request_id, "error": {"code": code, "message": message}},
            generation=self._generation if generation is None else generation,
        )

    async def open_thread(
        self,
        request: CodexSessionOpenRequest,
        listener: CodexSessionEventObserver | None,
    ) -> tuple[str, str, tuple[HistoryEntry, ...]]:
        async with self.admission.enter():
            opening = _ThreadOpening(request.resume_session_id, self.max_recovery_attempts)
            self._opening_threads.add(opening)
            deadline = None
            try:
                for attempt in range(self.max_recovery_attempts + 1):
                    opening.remaining_attempts = self.max_recovery_attempts - attempt
                    try:
                        async with asyncio.timeout_at(deadline):
                            return await self._open_thread(request, listener, opening=opening)
                    except AppServerError as error:
                        if (
                            attempt == self.max_recovery_attempts
                            or not opening.thread_id
                            or opening.process is None
                            or opening.reader is None
                            or self._closed
                            or error.retryability == RuntimeRetryability.TERMINAL
                            or error.safe_error not in THREAD_ATTACHMENT_RECOVERABLE_ERRORS
                            or (
                                opening.process.returncode is None
                                and not (
                                    self._generation == opening.generation
                                    and self.state == CodexProcessState.CRASHED
                                )
                                and opening.generation not in self._exited_generations
                            )
                        ):
                            raise
                        if deadline is None:
                            deadline = (
                                asyncio.get_running_loop().time() + self.recovery_total_timeout
                            )
                        async with asyncio.timeout_at(deadline):
                            reader_results = await asyncio.shield(
                                asyncio.gather(opening.reader, return_exceptions=True)
                            )
                            reader_error = reader_results[0]
                            if isinstance(reader_error, Exception):
                                LOGGER.error(
                                    "codex_process_exit_cleanup_failed",
                                    exc_info=(
                                        type(reader_error),
                                        reader_error,
                                        reader_error.__traceback__,
                                    ),
                                )
                                raise AppServerError(
                                    "Codex process exit cleanup failed",
                                    safe_error=THREAD_RECOVERY_FAILED,
                                ) from reader_error
                            if (
                                self._closed
                                or self._proc is opening.process
                                or opening.process.returncode is None
                                or self.state == CodexProcessState.UNAVAILABLE
                            ):
                                raise error
                            await self.start()
                        request = replace(request, resume_session_id=opening.thread_id)
            except TimeoutError as error:
                raise AppServerError(
                    "Codex thread recovery budget exhausted",
                    safe_error=THREAD_RECOVERY_FAILED,
                    retryability=RuntimeRetryability.USER_RETRYABLE,
                ) from error
            finally:
                self._opening_threads.discard(opening)

    async def _open_thread(
        self,
        request: CodexSessionOpenRequest,
        listener: CodexSessionEventObserver | None,
        *,
        opening: _ThreadOpening | None = None,
    ) -> tuple[str, str, tuple[HistoryEntry, ...]]:
        await self.start()
        generation = self._generation
        process = self._proc
        if opening is not None:
            opening.generation = generation
            opening.process = process
            opening.reader = self._reader_task
        if self.max_threads is not None and len(self._threads) >= self.max_threads:
            raise AppServerError(f"Codex App Server thread capacity reached: {self.max_threads}")
        await self.ensure_skill_roots(request.skill_roots)
        await self._prepare_thread_resources(request, generation)
        resumed = bool(request.resume_session_id)
        forking = bool(request.fork_session_id)
        if forking and (resumed or not request.fork_turn_id):
            raise AppServerError("invalid Codex fork source")
        params = self._thread_params(request, include_dynamic_tools=not (resumed or forking))
        if forking:
            params["threadId"] = request.fork_session_id
            params["lastTurnId"] = request.fork_turn_id
            method = "thread/fork"
        elif resumed:
            params["threadId"] = request.resume_session_id
            method = "thread/resume"
        else:
            params["serviceName"] = request.identity.service_name or CODEX_DEFAULT_SERVICE_NAME
            method = "thread/start"
        result = await self._request_thread_attachment(
            method,
            params,
            generation,
            expected_thread_id=request.resume_session_id,
            opening=opening,
        )
        try:
            thread = dict(result.get("thread") or {})
        except BaseException:
            self._unconfirm_attachment(generation)
            raise
        thread_id = thread.get("id")
        if not isinstance(thread_id, str) or not thread_id.strip():
            self._unconfirm_attachment(generation)
            raise AppServerError("Codex App Server returned no thread id")
        if forking and thread_id == request.fork_session_id:
            raise AppServerError("Codex returned the source thread instead of an independent fork")
        if resumed and thread_id != request.resume_session_id:
            self._unconfirm_attachment(generation)
            raise AppServerError(
                "Codex App Server resumed a different thread",
                safe_error="codex_thread_identity_mismatch",
                retryability=RuntimeRetryability.TERMINAL,
            )
        if thread_id in self._threads:
            self._unconfirm_attachment(generation)
            raise AppServerError(f"Codex thread is already attached: {thread_id}")
        try:
            confirmed_model = _confirmed_thread_model(result, request)
            history = history_entries(thread)
            resume_turns = resume_turn_snapshots(thread)
        except BaseException:
            cleanup = asyncio.create_task(
                self._unsubscribe_uncommitted_thread(thread_id, generation, process)
            )
            await self._settle_attachment_operation(cleanup)
            cleanup.result()
            raise
        process_reused = bool(self._threads)
        self._registration_epoch += 1
        state = ThreadAttachment(
            request=request,
            listener=listener,
            thread_id=thread_id,
            writable_roots=normalized_roots(request.writable_roots),
            model=confirmed_model,
            history=history,
            attachment_state=CodexThreadAttachmentState.ATTACHED,
            attached_generation=generation,
            registration_epoch=self._registration_epoch,
            fresh_generation=(
                generation if not (resumed or forking) and not history and not resume_turns else 0
            ),
        )
        state.turn = CodexTurnRuntime(
            state,
            admission=self.admission,
            request=self._request_connected,
            ensure_attached=self.ensure_attached,
            stale_requests=self._stale_requests,
            emitter=self._emitter,
            router=self._router,
            watcher=self._watcher,
            diagnostic=self._diagnostics.append,
            protocol_error=self._protocol_errors.append,
            resume_turns=resume_turns,
        )
        self._threads[thread_id] = state
        self._known_roots.add(thread_id)
        try:
            watching = asyncio.create_task(self._watcher.open(state.turn, generation))
            cancelled = await self._settle_attachment_operation(watching)
            watching.result()
            if cancelled:
                raise asyncio.CancelledError
            self._check_attachment_process(process, generation)
            await self._emitter.emit(
                state,
                CodexSessionEventKind.RESUMED if resumed else CodexSessionEventKind.OPENED,
                payload={
                    "model": state.model,
                    "resumed": resumed,
                    "pid": self.pid,
                    "version": self.version or str(self.initialize_result.get("userAgent") or ""),
                    "process_state": self.state.value,
                    "executable": self.executable,
                    "process_reused": process_reused,
                    "process_generation": generation,
                    "process_started_evidence_seq": self._started_evidence_seq,
                    "attachment_state": state.attachment_state.value,
                },
            )
        except BaseException:
            cleanup = asyncio.create_task(self._rollback_attachment(state, generation))
            await self._settle_attachment_operation(cleanup)
            cleanup.result()
            raise
        return thread_id, state.model, history

    @staticmethod
    async def _settle_attachment_operation(operation: asyncio.Task[Any]) -> bool:
        cancelled = False
        while not operation.done():
            try:
                await asyncio.shield(operation)
            except asyncio.CancelledError:
                cancelled = True
            except Exception:
                break
        return cancelled

    def _check_attachment_process(
        self, process: asyncio.subprocess.Process | None, generation: int
    ) -> None:
        if (
            process is None
            or process is not self._proc
            or process.returncode is not None
            or generation != self._generation
            or self.state not in (CodexProcessState.READY, CodexProcessState.RECOVERING)
        ):
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)

    async def _request_thread_attachment(
        self,
        method: str,
        params: dict[str, Any],
        generation: int,
        *,
        expected_thread_id: str = "",
        opening: _ThreadOpening | None = None,
    ) -> dict[str, Any]:
        process = self._proc
        operation = asyncio.create_task(
            self._request_connected(method, params, generation=generation)
        )
        if not await self._settle_attachment_operation(operation):
            try:
                result = operation.result()
                if opening is not None:
                    thread_id = (result.get("thread") or {}).get("id")
                    if (
                        isinstance(thread_id, str)
                        and thread_id.strip()
                        and expected_thread_id
                        and thread_id != expected_thread_id
                    ):
                        raise AppServerError(
                            "Codex App Server resumed a different thread",
                            safe_error="codex_thread_identity_mismatch",
                            retryability=RuntimeRetryability.TERMINAL,
                        )
                    if (
                        isinstance(thread_id, str)
                        and thread_id.strip()
                        and (not expected_thread_id or thread_id == expected_thread_id)
                    ):
                        opening.thread_id = thread_id
                self._check_attachment_process(process, generation)
                return result
            except AppServerError as error:
                if (
                    error.safe_error != THREAD_HISTORY_MISSING_ERROR
                    or error.generation != generation
                ):
                    self._unconfirm_attachment(generation)
                raise
            except BaseException:
                self._unconfirm_attachment(generation)
                raise
        if not operation.cancelled() and operation.exception() is None:
            result = operation.result()
            try:
                thread_id = (result.get("thread") or {}).get("id")
            except Exception:
                self._unconfirm_attachment(generation)
                raise asyncio.CancelledError
            if (
                isinstance(thread_id, str)
                and thread_id.strip()
                and (not expected_thread_id or thread_id == expected_thread_id)
            ):
                cleanup = asyncio.create_task(
                    self._unsubscribe_uncommitted_thread(thread_id, generation, process)
                )
                await self._settle_attachment_operation(cleanup)
                cleanup.result()
            else:
                self._unconfirm_attachment(generation)
        else:
            self._unconfirm_attachment(generation)
        raise asyncio.CancelledError

    async def _unsubscribe_uncommitted_thread(
        self,
        thread_id: str,
        generation: int,
        process: asyncio.subprocess.Process | None,
    ) -> None:
        if (
            thread_id in self._threads
            or process is None
            or process is not self._proc
            or process.returncode is not None
            or generation != self._generation
        ):
            return
        self._known_roots.add(thread_id)
        try:
            result = await self._request_connected(
                THREAD_UNSUBSCRIBE_METHOD, {THREAD_ID_KEY: thread_id}, generation=generation
            )
            if result.get(UNSUBSCRIBE_STATUS_KEY) in THREAD_UNSUBSCRIBE_STATUSES:
                return
        except Exception:
            self._unconfirm_attachment(generation)
            self._diagnostics.append("thread_attachment_cleanup_unconfirmed")
            return
        except BaseException:
            self._unconfirm_attachment(generation)
            raise
        self._unconfirm_attachment(generation)
        self._diagnostics.append("thread_attachment_cleanup_unconfirmed")

    async def _rollback_attachment(self, state: ThreadAttachment, generation: int) -> None:
        process = self._proc
        await self._watcher.close(
            state.turn,
            generation,
            generation == self._generation and process is not None and process.returncode is None,
        )
        if self._threads.get(state.thread_id) is state:
            self._threads.pop(state.thread_id)
            self._router.close(state.thread_id)
            state.attachment_state = CodexThreadAttachmentState.CLOSED
            await self._unsubscribe_uncommitted_thread(state.thread_id, generation, process)

    async def _prepare_thread_resources(
        self, request: CodexSessionOpenRequest, generation: int
    ) -> None:
        if not self._sandbox.enabled:
            return
        process = self._proc
        policy = sandbox_policy(request, normalized_roots(request.writable_roots))

        async def prepare() -> None:
            await self._sandbox.prepare_resources(request.cwd)
            self._check_attachment_process(process, generation)
            await self._sandbox.ensure_thread_execution_ready(
                partial(
                    self._request_connected,
                    generation=generation,
                    timeout=SANDBOX_EXECUTION_TIMEOUT_MS / 1000 + self.rpc_timeout,
                    before_write=lambda: self._check_attachment_process(process, generation),
                ),
                request.cwd,
                policy,
            )

        async with startup_mutex():
            self._check_attachment_process(process, generation)
            preparation = asyncio.create_task(prepare())
            cancelled = await self._settle_attachment_operation(preparation)
            if cancelled:
                if not preparation.cancelled():
                    preparation.exception()
                raise asyncio.CancelledError
            preparation.result()
            self._check_attachment_process(process, generation)

    async def fork_thread(
        self,
        source_thread_id: str,
        request: CodexSessionOpenRequest,
        *,
        portable_history: tuple[HistoryEntry, ...] | None = None,
    ) -> str:
        async with self.admission.enter():
            return await self._fork_thread(
                source_thread_id, request, portable_history=portable_history
            )

    async def _fork_thread(
        self,
        source_thread_id: str,
        request: CodexSessionOpenRequest,
        *,
        portable_history: tuple[HistoryEntry, ...] | None = None,
    ) -> str:
        """Clone an idle thread without carrying provider-private response ids."""

        await self.ensure_attached(source_thread_id)
        await self._prepare_thread_resources(request, self._generation)
        state = self.attachment(source_thread_id)
        if state.turn.active_turn_id:
            raise AppServerError(
                "Codex cannot fork a thread while its turn is active",
                safe_error="codex_thread_running",
                retryability=RuntimeRetryability.USER_RETRYABLE,
            )
        params = self._thread_params(request, include_dynamic_tools=False)
        generation = self._generation
        if portable_history is None:
            params["threadId"] = source_thread_id
            method = "thread/fork"
        else:
            params["serviceName"] = request.identity.service_name or CODEX_DEFAULT_SERVICE_NAME
            method = "thread/start"
        result = await self._request_thread_attachment(method, params, generation)
        thread = dict(result.get("thread") or {})
        thread_id = str(thread.get("id") or "").strip()
        if not thread_id or thread_id == source_thread_id:
            raise AppServerError(
                "Codex App Server returned an invalid forked thread id",
                safe_error="codex_thread_identity_mismatch",
                retryability=RuntimeRetryability.TERMINAL,
            )
        if portable_history is not None:
            await self.seed_history(thread_id, portable_history)
        return thread_id

    async def seed_history(self, thread_id: str, history: tuple[HistoryEntry, ...]) -> None:
        """Initialize a newly created thread with portable text, never vendor response ids."""
        if history:
            self.attachment(thread_id).fresh_generation = 0
        items = self._portable_history_items(history)
        if items:
            await self.request(
                CODEX_THREAD_INJECT_ITEMS_METHOD, {"threadId": thread_id, "items": items}
            )

    @staticmethod
    def _portable_history_items(
        history: tuple[HistoryEntry, ...],
    ) -> list[dict[str, Any]]:
        """Project visible text only; vendor response ids and tool refs are not portable."""

        items: list[dict[str, Any]] = []
        for entry in history:
            role = entry.role.strip().lower()
            text = entry.text.strip()
            if not text or role not in {CODEX_HISTORY_ROLE_USER, CODEX_HISTORY_ROLE_ASSISTANT}:
                continue
            content_type = "input_text" if role == CODEX_HISTORY_ROLE_USER else "output_text"
            items.append(
                {
                    "type": "message",
                    "role": role,
                    "content": [{"type": content_type, "text": text}],
                }
            )
        return items

    def history(self, thread_id: str) -> tuple[HistoryEntry, ...]:
        return self.attachment(thread_id).history

    def resume_turns(self, thread_id: str) -> tuple[ResumeTurnSnapshot, ...]:
        return self.attachment(thread_id).turn.resume_turns

    async def set_writable_roots(self, thread_id: str, roots: tuple[Path, ...]) -> None:
        """替换某个 thread 的额外可写根。

        不需要额外 RPC: `sandbox_policy()` 在每个 turn 都会被调用一次, 改这里
        的集合下一个 turn 自然生效 —— 也因此正在跑的那个 turn 无法中途剥夺
        (policy 已下发给 vendor), 能做到的上界是立即中断。
        """

        state = self._threads.get(thread_id)
        if state is None:
            return
        state.writable_roots = normalized_roots(roots)
        state.request = replace(state.request, writable_roots=roots)

    def thread_writable_roots(self, thread_id: str) -> tuple[str, ...]:
        """该 thread 下一个 turn 会下发的额外可写根。"""

        state = self._threads.get(thread_id)
        return () if state is None else state.writable_roots

    def confirm_permission_settings(
        self, state: ThreadAttachment, settings: Mapping[str, Any]
    ) -> None:
        confirmation = state.permission_confirmation
        if confirmation is None or confirmation.done():
            return
        for key, expected in state.permission_expected.items():
            actual = settings.get(key)
            if isinstance(expected, dict):
                if not isinstance(actual, dict) or any(
                    actual.get(field) != value for field, value in expected.items()
                ):
                    return
            elif actual != expected:
                return
        confirmation.set_result(dict(settings))

    async def update_permissions(
        self, thread_id: str, request: CodexSessionOpenRequest
    ) -> PermissionUpdate:
        state = self.attachment(thread_id)
        async with state.permission_lock:
            generation = await self.ensure_attached(thread_id)
            epoch = state.registration_epoch
            active_turn_id = state.turn.active_turn_id
            previous = state.request
            roots = normalized_roots(request.writable_roots)
            params: dict[str, Any] = {
                "threadId": thread_id,
                "approvalPolicy": request.approval_policy or CODEX_DEFAULT_APPROVAL_POLICY,
            }
            if request.approval_reviewer is not None:
                params["approvalsReviewer"] = request.approval_reviewer.value
            if request.permissions_profile:
                params["permissions"] = request.permissions_profile
            else:
                params["sandboxPolicy"] = sandbox_policy(request, roots)
            state.permission_expected = {
                key: value
                for key, value in params.items()
                if key not in {"threadId", "permissions"}
            }
            if request.permissions_profile:
                state.permission_expected["activePermissionProfile"] = {
                    "id": request.permissions_profile
                }
            confirmation = asyncio.get_running_loop().create_future()
            state.permission_confirmation = confirmation
            scope = PERMISSION_SCOPE_SESSION
            safe_error = ""
            try:
                await self._request_connected(
                    THREAD_SETTINGS_UPDATE_METHOD, params, generation=generation
                )
                try:
                    await asyncio.wait_for(asyncio.shield(confirmation), timeout=self.rpc_timeout)
                except TimeoutError as error:
                    raise AppServerError(
                        "Codex permission settings were not confirmed",
                        safe_error=PERMISSION_SETTINGS_UNCONFIRMED,
                        retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                    ) from error
                if generation != self._generation or state.registration_epoch != epoch:
                    raise AppServerError(
                        "Codex permission settings attachment changed",
                        safe_error=PERMISSION_SETTINGS_UNCONFIRMED,
                        retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                    )
                state.request = request
                state.writable_roots = roots
                if active_turn_id:
                    scope = PERMISSION_SCOPE_NEXT_TURN
                    if reviewer_only_update(previous, request):
                        assert request.approval_reviewer is not None
                        try:
                            result = await self._request_connected(
                                TURN_SETTINGS_UPDATE_METHOD,
                                {
                                    "threadId": thread_id,
                                    "turnId": active_turn_id,
                                    "approvalsReviewer": request.approval_reviewer.value,
                                },
                                generation=generation,
                            )
                        except AppServerError as error:
                            if error.rpc_code != RPC_METHOD_NOT_FOUND:
                                safe_error = error.safe_error or PERMISSION_SETTINGS_UNCONFIRMED
                        else:
                            if result.get("status") == TURN_SETTINGS_APPLIED:
                                if (
                                    generation == self._generation
                                    and state.registration_epoch == epoch
                                ):
                                    scope = PERMISSION_SCOPE_TURN
                                else:
                                    safe_error = PERMISSION_SETTINGS_UNCONFIRMED
                            elif result.get("status") != TURN_SETTINGS_UNAVAILABLE:
                                safe_error = PERMISSION_SETTINGS_UNCONFIRMED
            except AppServerError as error:
                if error.rpc_code != RPC_METHOD_NOT_FOUND:
                    raise
                scope = PERMISSION_SCOPE_NEXT_TURN
            finally:
                state.permission_confirmation = None
                state.permission_expected = {}
                if confirmation.done() and not confirmation.cancelled():
                    confirmation.exception()
                else:
                    confirmation.cancel()
            state.request = request
            state.writable_roots = roots
            return PermissionUpdate(scope, safe_error, active_turn_id)

    async def ensure_skill_roots(self, roots: tuple[Path, ...]) -> None:
        normalized = {str(path.expanduser().resolve()) for path in roots if str(path).strip()}
        if normalized != self._skill_roots:
            raise AppServerError(
                RESOURCE_HOST_CONFIGURATION_CONFLICT,
                safe_error=RESOURCE_HOST_CONFIGURATION_CONFLICT,
            )

    async def _set_skill_roots(
        self,
        roots: set[str],
        *,
        generation: int | None = None,
    ) -> None:
        await self._request_connected(
            CODEX_SKILLS_EXTRA_ROOTS_SET_METHOD,
            {"extraRoots": sorted(roots)},
            generation=self._generation if generation is None else generation,
        )

    def _thread_params(
        self,
        request: CodexSessionOpenRequest,
        *,
        include_dynamic_tools: bool,
    ) -> dict[str, Any]:
        validate_thread_model(request)
        if request.skill_policy is not SkillPolicy.INHERIT:
            raise AppServerError(
                CODEX_SKILLS_POLICY_UNSUPPORTED, safe_error=CODEX_SKILLS_POLICY_UNSUPPORTED
            )
        params: dict[str, Any] = {
            "cwd": str(request.cwd.expanduser().resolve()),
            "approvalPolicy": request.approval_policy or CODEX_DEFAULT_APPROVAL_POLICY,
            "sandbox": request.sandbox or CODEX_DEFAULT_SANDBOX_MODE,
        }
        if request.permissions_profile:
            params.pop("sandbox")
            params["permissions"] = request.permissions_profile
            params["runtimeWorkspaceRoots"] = [
                str(request.cwd.expanduser().resolve()),
                *(str(root.expanduser().resolve()) for root in request.writable_roots),
            ]
        if request.approval_reviewer is not None:
            params["approvalsReviewer"] = request.approval_reviewer.value
        if request.model:
            params["model"] = request.model
        if request.model_provider:
            params["modelProvider"] = request.model_provider
        if request.multi_agent_mode:
            if request.multi_agent_mode not in CODEX_MULTI_AGENT_MODES:
                raise ValueError(
                    f"unsupported Codex multi-agent mode {request.multi_agent_mode!r}; "
                    f"expected {CODEX_MULTI_AGENT_MODES}"
                )
            params["multiAgentMode"] = request.multi_agent_mode
        if request.thread_config:
            params["config"] = dict(request.thread_config)
        if request.base_instructions:
            params["baseInstructions"] = request.base_instructions
        if request.developer_instructions:
            params["developerInstructions"] = request.developer_instructions
        if request.ephemeral:
            params["ephemeral"] = True
        if request.dynamic_tools and include_dynamic_tools:
            params["dynamicTools"] = [
                {
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": dict(tool.input_schema),
                    "deferLoading": tool.defer_loading,
                }
                for tool in request.dynamic_tools
            ]
        return params

    async def _resume_registered_threads(
        self,
        generation: int,
        process_incident: RuntimeIncident,
    ) -> bool:
        semaphore = asyncio.Semaphore(CODEX_MAX_CONCURRENT_THREAD_RESUMES)

        async def resume(state: ThreadAttachment, process_reused: bool) -> bool:
            async with semaphore:
                if (
                    state.attachment_state == CodexThreadAttachmentState.CLOSED
                    or self._resume_retry_blocked(state, generation, process_incident is not None)
                ):
                    return True
                restored = await self._resume_thread(
                    state,
                    generation,
                    process_incident,
                    process_reused=process_reused,
                )
                return (
                    restored
                    or self._threads.get(state.thread_id) is not state
                    or (
                        state.attachment_state == CodexThreadAttachmentState.CLOSED
                        or self._resume_retry_blocked(
                            state, generation, process_incident is not None
                        )
                    )
                )

        results = await asyncio.gather(
            *(
                resume(state, process_reused=index > 0)
                for index, state in enumerate(tuple(self._threads.values()))
            )
        )
        return all(results)

    def _resume_retry_blocked(
        self, state: ThreadAttachment, generation: int, automatic: bool
    ) -> bool:
        failure = state.attachment_incident
        if failure is None or failure.state != RuntimeIncidentState.FAILED:
            return False
        if failure.retryability == RuntimeRetryability.TERMINAL:
            return (
                failure.safe_error != THREAD_HISTORY_MISSING_ERROR
                or state.absent_generation == generation
            )
        return (
            automatic
            and failure.safe_error in SANDBOX_STARTUP_ERRORS
            and failure.process_generation == generation
        )

    def _resume_failure_incident(
        self,
        state: ThreadAttachment,
        error: Exception,
        generation: int,
        automatic: bool,
    ) -> RuntimeIncident:
        terminal = (
            isinstance(error, AppServerError) and error.retryability == RuntimeRetryability.TERMINAL
        )
        sandbox_error = (
            error
            if isinstance(error, AppServerError) and error.safe_error in SANDBOX_STARTUP_ERRORS
            else None
        )
        recovering = automatic and not terminal and sandbox_error is None
        previous = state.attachment_incident
        return RuntimeIncident(
            incident_id=previous.incident_id if previous else uuid.uuid4().hex,
            scope=RuntimeIncidentScope.THREAD,
            state=RuntimeIncidentState.RETRYING if recovering else RuntimeIncidentState.FAILED,
            kind=RuntimeIncidentKind.RESUME_FAILED,
            strategy=(
                RuntimeRecoveryStrategy.AUTO_RESUME
                if recovering
                else RuntimeRecoveryStrategy.MANUAL_RETRY
            ),
            retryability=(
                sandbox_error.retryability
                if sandbox_error is not None
                else (
                    RuntimeRetryability.TERMINAL
                    if terminal
                    else (
                        RuntimeRetryability.IN_PROGRESS
                        if recovering
                        else RuntimeRetryability.USER_RETRYABLE
                    )
                )
            ),
            safe_error=(
                error.safe_error if isinstance(error, AppServerError) else THREAD_RESUME_FAILED
            ),
            process_generation=generation,
            attempt=max(1, self._recovery_attempt),
            max_attempts=self.max_recovery_attempts,
            vendor_thread_id=state.thread_id,
            rpc_method=error.method if isinstance(error, AppServerError) else "",
            rpc_code=error.rpc_code if isinstance(error, AppServerError) else None,
            rpc_latency_ms=error.rpc_latency_ms if isinstance(error, AppServerError) else 0,
            ambiguous_commit=bool(previous and previous.ambiguous_commit)
            or (
                sandbox_error is not None
                and sandbox_error.retryability == RuntimeRetryability.UNKNOWN_OUTCOME
            ),
        )

    async def _resume_thread(
        self,
        state: ThreadAttachment,
        generation: int,
        process_incident: RuntimeIncident | None = None,
        *,
        process_reused: bool = True,
    ) -> bool:
        async with state.attachment_lock:
            if (
                self._threads.get(state.thread_id) is not state
                or state.attachment_state is CodexThreadAttachmentState.CLOSED
            ):
                return False
            if (
                state.attachment_state == CodexThreadAttachmentState.ATTACHED
                and state.attached_generation == generation
            ):
                return True
            epoch = state.registration_epoch
            process = self._proc
            state.attachment_state = CodexThreadAttachmentState.RESUMING
            attachment_incident = state.attachment_incident
            if attachment_incident is not None:
                await self._emitter.incident(
                    state,
                    replace(
                        attachment_incident,
                        state=RuntimeIncidentState.RETRYING,
                        attempt=max(1, self._recovery_attempt),
                    ),
                )
            params = self._thread_params(state.request, include_dynamic_tools=False)
            params["threadId"] = state.thread_id
            try:
                await self._prepare_thread_resources(state.request, generation)
                result = await self._request_thread_attachment(
                    "thread/resume", params, generation, expected_thread_id=state.thread_id
                )
                thread = dict(result.get("thread") or {})
                returned_thread_id = str(thread.get("id") or state.thread_id)
                if returned_thread_id != state.thread_id:
                    raise AppServerError(
                        "Codex App Server resumed a different thread",
                        safe_error="codex_thread_identity_mismatch",
                        retryability=RuntimeRetryability.TERMINAL,
                    )
                confirmed_model = _confirmed_thread_model(result, state.request)
            except Exception as exc:
                if (
                    self._threads.get(state.thread_id) is state
                    and state.registration_epoch == epoch
                    and state.attachment_state != CodexThreadAttachmentState.CLOSED
                    and generation == self._generation
                    and self._proc is process
                ):
                    state.attachment_state = CodexThreadAttachmentState.BROKEN
                    state.attached_generation = 0
                    state.last_resume_failure = type(exc).__name__
                    if (
                        isinstance(exc, AppServerError)
                        and exc.safe_error == THREAD_HISTORY_MISSING_ERROR
                        and exc.generation == generation
                    ):
                        state.absent_generation = generation
                        self._activity_revision += 1
                    incident = self._resume_failure_incident(
                        state, exc, generation, process_incident is not None
                    )
                    state.last_incident_id = incident.incident_id
                    state.attachment_incident = incident
                    await self._emitter.incident(state, incident)
                return False
            if (
                self._threads.get(state.thread_id) is not state
                or state.registration_epoch != epoch
                or state.attachment_state == CodexThreadAttachmentState.CLOSED
                or generation != self._generation
                or self._proc is not process
                or self._proc is None
                or self._proc.returncode is not None
            ):
                return False
            state.model = confirmed_model
            state.absent_generation = 0
            state.attachment_state = CodexThreadAttachmentState.ATTACHED
            if state.mcp_invalidate is not None:
                state.mcp_invalidate()
            state.attached_generation = generation
            state.last_resume_failure = ""
            try:
                await self._watcher.open(state.turn, generation)
                await state.turn.reconcile(thread, generation)
            except asyncio.CancelledError:
                if (
                    self._threads.get(state.thread_id) is state
                    and state.registration_epoch == epoch
                    and generation == self._generation
                    and state.attachment_state != CodexThreadAttachmentState.CLOSED
                ):
                    state.attachment_state = CodexThreadAttachmentState.BROKEN
                    state.attached_generation = 0
                raise
            except Exception as exc:
                if (
                    self._threads.get(state.thread_id) is not state
                    or state.registration_epoch != epoch
                    or generation != self._generation
                    or state.attachment_state == CodexThreadAttachmentState.CLOSED
                ):
                    return False
                state.attachment_state = CodexThreadAttachmentState.BROKEN
                state.attached_generation = 0
                state.last_resume_failure = type(exc).__name__
                incident = self._resume_failure_incident(
                    state, exc, generation, process_incident is not None
                )
                state.attachment_incident = incident
                state.last_incident_id = incident.incident_id
                await self._emitter.incident(state, incident)
                return False
            if (
                self._threads.get(state.thread_id) is not state
                or state.registration_epoch != epoch
                or state.attachment_state == CodexThreadAttachmentState.CLOSED
                or generation != self._generation
                or self._proc is not process
                or self._proc is None
                or self._proc.returncode is not None
            ):
                return False
            if attachment_incident is not None:
                await self._emitter.incident(
                    state,
                    replace(
                        attachment_incident,
                        state=RuntimeIncidentState.RECOVERED,
                        retryability=RuntimeRetryability.TERMINAL,
                        process_generation=generation,
                        attempt=max(1, self._recovery_attempt),
                    ),
                )
                state.attachment_incident = None
            state.disconnected_generation = 0
            state.last_incident_id = (
                process_incident.incident_id if process_incident is not None else ""
            )
            await self._emitter.emit(
                state,
                CodexSessionEventKind.RESUMED,
                payload={
                    "model": state.model,
                    "recovered_process": process_incident is not None,
                    "pid": self.pid,
                    "version": self.version or str(self.initialize_result.get("userAgent") or ""),
                    "process_state": self.state.value,
                    "executable": self.executable,
                    "process_reused": process_reused,
                    "process_generation": generation,
                    "process_started_evidence_seq": self._started_evidence_seq,
                    "attachment_state": state.attachment_state.value,
                    "resolved_ambiguous_incident_id": "",
                },
            )
            return True

    async def ensure_attached(self, thread_id: str) -> int:
        state = self.attachment(thread_id)
        if state.attachment_state is CodexThreadAttachmentState.CLOSED:
            raise AppServerError(
                THREAD_CLOSED_ERROR,
                safe_error=THREAD_CLOSED_ERROR,
                retryability=RuntimeRetryability.TERMINAL,
            )
        await self.start()
        generation = self._generation
        if state.absent_generation == generation:
            raise AppServerError(
                THREAD_HISTORY_MISSING_ERROR,
                safe_error=THREAD_HISTORY_MISSING_ERROR,
                generation=generation,
                retryability=RuntimeRetryability.TERMINAL,
            )
        if (
            state.attachment_state == CodexThreadAttachmentState.ATTACHED
            and state.attached_generation == generation
        ):
            return generation
        if not await self._resume_thread(state, generation):
            raise AppServerError(
                f"Codex thread could not be attached: {thread_id}",
                safe_error="codex_thread_not_attached",
            )
        return generation

    async def prepare_submission_retry(
        self, thread_id: str, client_submission_id: str
    ) -> Callable[[], None]:
        generation = await self.ensure_attached(thread_id)
        state = self.attachment(thread_id)
        epoch = self.admission.epoch
        registration = state.registration_epoch
        revision = self.thread_activity_revision(thread_id)
        request = state.request
        model = state.model
        roots = state.writable_roots

        def current() -> bool:
            return (
                self.reusable
                and not self._closed
                and self.state is CodexProcessState.READY
                and self._proc is not None
                and self._proc.returncode is None
                and self._generation == generation
                and self._threads.get(thread_id) is state
                and state.attachment_state is CodexThreadAttachmentState.ATTACHED
                and state.attached_generation == generation
                and state.registration_epoch == registration
                and self.thread_activity_revision(thread_id) == revision
                and self.admission.accepting
                and self.admission.epoch == epoch
                and state.request is request
                and state.model == model
                and state.writable_roots == roots
                and not state.turn.active_turn_id
                and not state.turn.ambiguous_submission_id
                and not state.turn.interrupted_turn_id
                and not self._rpc_requests.unsettled(generation)
                and not self._pending_hil
                and not self._pending_tools
            )

        if self.suspend_blockers(thread_id) or not current():
            raise AppServerError(
                CODEX_SUBMISSION_RETRY_STALE, safe_error=CODEX_SUBMISSION_RETRY_STALE
            )
        activity = await NativeActivity(self, thread_id, known_roots=self.known_roots).inspect()
        if (
            not activity.complete
            or activity.blockers
            or activity.process_generation != generation
            or not current()
        ):
            raise AppServerError(
                CODEX_SUBMISSION_RETRY_STALE, safe_error=CODEX_SUBMISSION_RETRY_STALE
            )

        def authorize() -> None:
            if not current() or state.turn.active_turn_client_id != client_submission_id:
                raise AppServerError(
                    CODEX_SUBMISSION_RETRY_STALE, safe_error=CODEX_SUBMISSION_RETRY_STALE
                )

        return authorize

    def seal_empty_replacement(self, thread_id: str) -> tuple[int, int] | None:
        state = self.attachment(thread_id)
        turn = state.turn
        if (
            not state.fresh_generation
            or state.fresh_generation not in self._exited_generations
            or not state.fresh_generation < state.absent_generation == self._generation
            or state.history
            or turn.resume_turns
            or turn.submission_attempted
            or turn.execution_observed
            or turn.replacement_sealed
            or turn.active_turn_id
            or turn.ambiguous_submission_id
            or turn.interrupted_turn_id
            or (turn.turn_done is not None and not turn.turn_done.done())
            or self._pending_hil
            or self._pending_tools
        ):
            return None
        turn.seal_replacement()
        state.attachment_state = CodexThreadAttachmentState.CLOSED
        self._record_activity(thread_id)
        return state.fresh_generation, state.absent_generation

    def thread_replacement_current(
        self,
        thread_id: str,
        command_id: str,
        incident_id: str,
        failed_generation: int,
        generation: int,
        registration_epoch: int,
        revision: int,
    ) -> bool:
        state = self._threads.get(thread_id)
        if state is None:
            return False
        turn = state.turn
        incident = state.attachment_incident
        return (
            not self._closed
            and not self.admission.failed
            and self.state is CodexProcessState.READY
            and self._proc is not None
            and self._proc.returncode is None
            and type(failed_generation) is int
            and 0 < failed_generation < generation == self._generation
            and failed_generation in self._exited_generations
            and state.disconnected_generation == failed_generation
            and state.absent_generation == generation
            and state.registration_epoch == registration_epoch
            and self.thread_activity_revision(thread_id) == revision
            and state.attachment_state is CodexThreadAttachmentState.BROKEN
            and incident is not None
            and incident.incident_id == incident_id
            and incident.scope is RuntimeIncidentScope.THREAD
            and incident.kind is RuntimeIncidentKind.RESUME_FAILED
            and incident.state is RuntimeIncidentState.FAILED
            and incident.retryability is RuntimeRetryability.TERMINAL
            and incident.safe_error == THREAD_HISTORY_MISSING_ERROR
            and incident.process_generation == generation
            and incident.vendor_thread_id == thread_id
            and bool(command_id and incident_id)
            and not turn.replacement_sealed
            and not turn.active_turn_id
            and (turn.turn_done is None or turn.turn_done.done())
            and (
                not turn.ambiguous_submission_id
                or (
                    turn.ambiguous_submission_id == command_id
                    and turn.ambiguous_generation == failed_generation
                )
            )
            and (
                not turn.interrupted_turn_client_id
                or (
                    turn.interrupted_turn_client_id == command_id
                    and turn.interrupted_turn_generation == failed_generation
                )
            )
            and not self._rpc_requests.unsettled(generation)
            and not any(
                pending.thread_id == thread_id
                or (
                    (route := self._router.agent(pending.thread_id)) is not None
                    and route.owner_thread_id == thread_id
                )
                for pending in (*self._pending_hil.values(), *self._pending_tools.values())
            )
        )

    def seal_thread_replacement(
        self,
        thread_id: str,
        command_id: str,
        incident_id: str,
        failed_generation: int,
        generation: int,
        registration_epoch: int,
        revision: int,
    ) -> bool:
        if not self.thread_replacement_current(
            thread_id,
            command_id,
            incident_id,
            failed_generation,
            generation,
            registration_epoch,
            revision,
        ):
            return False
        self._threads[thread_id].turn.seal_replacement()
        self._threads[thread_id].attachment_state = CodexThreadAttachmentState.CLOSED
        self._record_activity(thread_id)
        return True

    async def close_thread(self, thread_id: str) -> None:
        state = self._threads.get(thread_id)
        if state is None:
            return
        confirmation = state.permission_confirmation
        if confirmation is not None and not confirmation.done():
            confirmation.set_exception(
                AppServerError(
                    "Codex permission settings attachment closed",
                    safe_error=PERMISSION_SETTINGS_UNCONFIRMED,
                    retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                )
            )
        generation = self._generation
        connected = self.state == CodexProcessState.READY and not state.turn.replacement_sealed
        await self._watcher.close(state.turn, generation, connected)
        self._registration_epoch += 1
        state.registration_epoch = self._registration_epoch
        state.attachment_state = CodexThreadAttachmentState.CLOSED
        await state.turn.close(generation, connected)
        self._threads.pop(thread_id, None)
        self._router.close(thread_id)
        # Release the event subscription for durable threads too. This preserves
        # the rollout; configuration isolation is owned by the host pool.
        if connected:
            try:
                result = await self.request(
                    THREAD_UNSUBSCRIBE_METHOD,
                    {THREAD_ID_KEY: thread_id},
                    generation=generation,
                )
                if result.get(UNSUBSCRIBE_STATUS_KEY) not in THREAD_UNSUBSCRIBE_STATUSES:
                    raise AppServerError("Thread cleanup was not confirmed")
            except BaseException:
                self._unconfirm_attachment(generation)
                raise
        recovery_task = self._recovery_task
        if (
            not self._has_recoverable_threads
            and recovery_task is not None
            and recovery_task is not asyncio.current_task()
            and not recovery_task.done()
        ):
            recovery_task.cancel()
            await asyncio.gather(recovery_task, return_exceptions=True)
            self._recovery_task = None
            self._recovery_attempt = 0
            self.state = (
                CodexProcessState.READY
                if self._proc is not None and self._proc.returncode is None
                else CodexProcessState.CRASHED
            )

    def set_mcp_handler(
        self,
        thread_id: str,
        handler: McpNotificationHandler,
        invalidate: Callable[[], None] | None = None,
    ) -> None:
        state = self.attachment(thread_id)
        state.mcp_handler = handler
        state.mcp_invalidate = invalidate

    async def emit_mcp_event(self, thread_id: str, payload: Mapping[str, JsonValue]) -> None:
        await self._emitter.emit(
            self.attachment(thread_id),
            CodexSessionEventKind.MCP_EVENT,
            payload=payload,
        )

    async def resolve_hil(
        self,
        thread_id: str,
        request_id: str,
        response: Mapping[str, JsonValue],
    ) -> bool:
        await self.ensure_attached(thread_id)
        state = self.attachment(thread_id)
        pending = self._pending_hil.get(request_id)
        if (
            pending is None
            or pending.thread_id != thread_id
            or pending.generation != state.attached_generation
        ):
            return False
        params = dict(response)
        cancelled = bool(params.get("cancelled"))
        option_id = str(params.get("option_id") or "")
        raw = hil_response(pending.method, pending.params, cancelled, option_id, params)
        try:
            await self._respond(pending.rpc_id, raw, generation=pending.generation)
        except AppServerError as exc:
            if exc.retryability == RuntimeRetryability.UNKNOWN_OUTCOME:
                self._pending_hil.pop(request_id, None)
                self._request_routes.pop(str(pending.rpc_id), None)
                await self._emit_unknown_write_incident(
                    state,
                    method="server-response/hil",
                    turn_id=pending.turn_id,
                    item_id=pending.item_id,
                    error=exc,
                )
            raise
        self._pending_hil.pop(request_id, None)
        self._request_routes.pop(str(pending.rpc_id), None)
        await self._emitter.emit(
            state,
            CodexSessionEventKind.HIL_RESOLVED,
            turn_id=pending.turn_id,
            item_id=pending.item_id,
            payload={"request_id": request_id, "option_id": option_id, "cancelled": cancelled},
        )
        return True

    async def resolve_tool(
        self,
        thread_id: str,
        request_id: str,
        response: CodexToolResponse,
    ) -> bool:
        await self.ensure_attached(thread_id)
        state = self.attachment(thread_id)
        pending = self._pending_tools.get(request_id)
        if (
            pending is None
            or pending.thread_id != thread_id
            or pending.generation != state.attached_generation
        ):
            return False
        try:
            await self._respond(
                pending.rpc_id,
                {
                    "success": response.success,
                    "contentItems": [dict(item) for item in response.content_items],
                },
                generation=pending.generation,
            )
        except AppServerError as exc:
            if exc.retryability == RuntimeRetryability.UNKNOWN_OUTCOME:
                self._pending_tools.pop(request_id, None)
                self._request_routes.pop(str(pending.rpc_id), None)
                await self._emit_unknown_write_incident(
                    state,
                    method="server-response/tool",
                    turn_id=pending.turn_id,
                    item_id=pending.item_id,
                    error=exc,
                )
            raise
        self._pending_tools.pop(request_id, None)
        self._request_routes.pop(str(pending.rpc_id), None)
        return True

    async def _read_stdout(
        self,
        proc: asyncio.subprocess.Process,
        generation: int,
    ) -> None:
        assert proc.stdout is not None
        try:
            async for message in read_messages(proc.stdout, self._protocol_errors.append):
                try:
                    await self._dispatch(message, generation=generation)
                except Exception as exc:
                    self._protocol_errors.append(f"dispatch_failed:{type(exc).__name__}")
                    logger.exception("Codex App Server dispatch failed")
        finally:
            await self._handle_process_exit(proc=proc, generation=generation)

    async def _drain_stderr(
        self,
        proc: asyncio.subprocess.Process,
        generation: int,
    ) -> None:
        assert proc.stderr is not None
        async for diagnostic in stream_diagnostics(proc.stderr):
            if generation != self._generation:
                return
            self._stderr_lines.append(diagnostic.summary)
            logger.log(
                logging.DEBUG if diagnostic.reason == UNSPECIFIED_REASON else logging.WARNING,
                "Codex App Server stderr diagnostic: pid=%s generation=%s %s",
                proc.pid,
                generation,
                diagnostic.summary,
            )

    async def _dispatch(
        self,
        message: Mapping[str, Any],
        *,
        generation: int | None = None,
    ) -> None:
        message_generation = self._generation if generation is None else generation
        if message_generation != self._generation:
            self._diagnostics.append("stale_generation_message")
            return
        request_id = message.get("id")
        method = str(message.get("method") or "")
        if request_id is not None and not method:
            self._rpc_requests.resolve(message, message_generation, pid=self.pid)
            return
        raw_params = message.get("params")
        params = dict(raw_params) if isinstance(raw_params, Mapping) else {}
        if request_id is not None:
            await self._handle_server_request(
                request_id,
                method,
                params,
                generation=message_generation,
            )
            return
        await self._handle_notification(method, params, generation=message_generation)

    async def _handle_notification(
        self,
        method: str,
        params: Mapping[str, Any],
        *,
        generation: int | None = None,
    ) -> None:
        message_generation = self._generation if generation is None else generation
        if message_generation != self._generation:
            self._diagnostics.append(f"stale_generation_notification:{method}")
            return
        raw_turn = params.get("turn")
        nested_turn = dict(raw_turn) if isinstance(raw_turn, Mapping) else {}
        notification_turn_id = str(params.get("turnId") or nested_turn.get("id") or "")
        thread_id = self._router.resolve(params)
        if not thread_id and notification_turn_id:
            thread_id = self._router.turn_owner(notification_turn_id)
        self._record_activity(thread_id)
        if method == "thread/started":
            return
        if method == SANDBOX_COMPLETED_METHOD:
            self._sandbox.completed(params, message_generation)
            return
        if method == "serverRequest/resolved":
            await self._server_request_resolved(params)
            return
        if method == "skills/changed":
            self._diagnostics.append("invalidation:skills/changed")
            for thread_state in tuple(self._threads.values()):
                await self._emitter.emit(
                    thread_state,
                    CodexSessionEventKind.SKILLS_CHANGED,
                    payload={"invalidated": True},
                )
            return
        if method == CODEX_FS_CHANGED_METHOD:
            self._watcher.changed(params)
            return
        if method == "warning" and not params.get("threadId"):
            self._diagnostics.append("warning:global")
            return
        if method in CODEX_BENIGN_NOTIFICATION_METHODS and not params.get("threadId"):
            self._diagnostics.append(f"benign:{method}")
            return
        if method.startswith((MCP_NOTIFICATION_PREFIX, MCP_CONFIG_NOTIFICATION_PREFIX)):
            if await self._handle_mcp_notification(thread_id, method, params):
                return
        state = self._threads.get(thread_id)
        agent_route = None if state is not None else self._router.agent(thread_id)
        if agent_route is not None:
            state = self._threads.get(agent_route.owner_thread_id)
        if state is None:
            self._protocol_errors.append(f"unroutable:{method}")
            return
        if agent_route is not None:
            state.turn.execution_observed = True
            await self._handle_agent_notification(
                state,
                agent_route,
                thread_id,
                method,
                params,
            )
            return
        turn_id = notification_turn_id
        item_id = str(params.get("itemId") or "")
        if method == "thread/status/changed":
            raw_status = params.get("status")
            status = dict(raw_status) if isinstance(raw_status, Mapping) else {}
            if str(status.get("type") or "") not in {"idle", "notLoaded"}:
                state.turn.execution_observed = True
            if str(status.get("type") or "") == "notLoaded":
                state.attachment_state = CodexThreadAttachmentState.DETACHED
                state.attached_generation = 0
                incident = self._attachment_incident(
                    state,
                    message_generation,
                    safe_error="codex_thread_not_loaded",
                )
                await self._emitter.incident(state, incident, turn_id=turn_id)
            await self._emitter.emit(
                state,
                CodexSessionEventKind.RUNTIME_STATUS,
                payload={
                    "status": raw_status,
                    "attachment_state": state.attachment_state.value,
                },
            )
            return
        if method == "thread/closed":
            state.attachment_state = CodexThreadAttachmentState.DETACHED
            state.attached_generation = 0
            incident = self._attachment_incident(
                state,
                message_generation,
                safe_error=THREAD_CLOSED_ERROR,
            )
            await self._emitter.incident(state, incident, turn_id=turn_id)
            return
        if method == THREAD_SETTINGS_UPDATED_METHOD:
            settings = dict(params.get("threadSettings") or {})
            state.model = str(settings.get("model") or state.model)
            self.confirm_permission_settings(state, settings)
            return
        if method == "thread/name/updated":
            title = str(params.get("threadName") or "").strip()
            if title:
                await self._emitter.emit(
                    state,
                    CodexSessionEventKind.TITLE_UPDATED,
                    payload={"title": title},
                )
            return
        if method == "model/rerouted":
            state.model = str(params.get("toModel") or state.model)
            await self._emitter.emit(
                state,
                CodexSessionEventKind.MODEL_REROUTED,
                turn_id=turn_id,
                payload={
                    "from_model": str(params.get("fromModel") or ""),
                    "to_model": state.model,
                    "reason": str(params.get("reason") or ""),
                },
            )
            return
        raw_item = params.get("item")
        if isinstance(raw_item, Mapping):
            self._router.register_agents(
                thread_id,
                turn_id,
                raw_item,
                self._threads.keys(),
            )
        await state.turn.notification(method, params, generation=message_generation)

    async def _handle_agent_notification(
        self,
        state: ThreadAttachment,
        route: AgentRoute,
        agent_thread_id: str,
        method: str,
        params: Mapping[str, Any],
    ) -> None:
        raw_turn = params.get("turn")
        turn = dict(raw_turn) if isinstance(raw_turn, Mapping) else {}
        status = str(turn.get("status") or "")
        if method in SUBAGENT_ITEM_BOUNDARIES or method in SUBAGENT_STREAM_ACTIVITIES:
            raw_item = params.get("item")
            item = dict(raw_item) if isinstance(raw_item, Mapping) else {}
            activity_item_id = str(params.get("itemId") or item.get("id") or "")
            public_summary = ""
            if method == "item/reasoning/summaryTextDelta":
                public_summary = self._router.append_agent_summary(
                    agent_thread_id,
                    activity_item_id,
                    str(params.get("delta") or ""),
                )
            elif method in SUBAGENT_ITEM_BOUNDARIES:
                public_summary = self._router.agent_summary(
                    agent_thread_id, activity_item_id
                ) or subagent_item_summary(item)
            activity = (
                SUBAGENT_ITEM_ACTIVITIES.get(str(item.get("type") or ""), SUBAGENT_GENERIC_ACTIVITY)
                if method in SUBAGENT_ITEM_BOUNDARIES
                else SUBAGENT_STREAM_ACTIVITIES[method]
            )
            if self._router.observe_agent_activity(
                agent_thread_id,
                now=time.monotonic(),
                interval=SUBAGENT_PROGRESS_INTERVAL_SECONDS,
                boundary=method in SUBAGENT_ITEM_BOUNDARIES,
            ):
                await self._emitter.emit(
                    state,
                    CodexSessionEventKind.SUBAGENT_ACTIVITY,
                    turn_id=route.owner_turn_id,
                    item_id=agent_thread_id,
                    payload=subagent_status_payload(
                        agent_thread_id=agent_thread_id,
                        agent_path=route.agent_path,
                        activity=activity,
                        phase=(
                            method.removeprefix("item/")
                            if method in SUBAGENT_ITEM_BOUNDARIES
                            else "progress"
                        ),
                        activity_item_id=activity_item_id,
                        public_summary=public_summary,
                        item=item,
                    ),
                )
            if method == "item/completed":
                self._router.forget_agent_summary(agent_thread_id, activity_item_id)
            return
        if method == "turn/started":
            status = "started"
            completed = False
        elif method == "turn/completed":
            terminal = terminal_turn_status(status)
            if terminal is None:
                self._protocol_errors.append("invalid_agent_terminal_status")
                return
            status = terminal.value
            completed = True
        else:
            return
        if not self._router.update_agent_status(agent_thread_id, status):
            return
        if completed:
            self._router.forget_agent_summaries(agent_thread_id)
        await self._emitter.emit(
            state,
            (
                CodexSessionEventKind.NATIVE_ACTIVITY_COMPLETED
                if completed
                else CodexSessionEventKind.NATIVE_ACTIVITY_STARTED
            ),
            turn_id=route.owner_turn_id,
            item_id=agent_thread_id,
            payload=subagent_lifecycle_payload(
                agent_thread_id=agent_thread_id,
                agent_path=route.agent_path,
                status=status,
                completed=completed,
            ),
        )

    async def _handle_mcp_notification(
        self,
        thread_id: str,
        method: str,
        params: Mapping[str, Any],
    ) -> bool:
        if thread_id:
            state = self._threads.get(thread_id)
            return bool(
                state is not None
                and state.mcp_handler is not None
                and await state.mcp_handler(method, params)
            )
        handled = False
        for state in tuple(self._threads.values()):
            if state.mcp_handler is not None:
                handled = await state.mcp_handler(method, params) or handled
        return handled

    async def _reject_server_request(
        self,
        request_id: Any,
        code: int,
        message: str,
        *,
        reason: str,
        method: str,
        params: Mapping[str, Any],
        generation: int,
    ) -> None:
        self._protocol_errors.append(f"{reason}:{method}")
        logger.warning(
            "rejected Codex App Server request %s (%s): threadId=%s turnId=%s itemId=%s",
            method,
            reason,
            params.get("threadId") or "",
            params.get("turnId") or "",
            params.get("itemId") or "",
        )
        await self._respond_error(request_id, code, message, generation=generation)

    async def _handle_server_request(
        self,
        request_id: Any,
        method: str,
        params: Mapping[str, Any],
        *,
        generation: int | None = None,
    ) -> None:
        request_generation = self._generation if generation is None else generation
        thread_id = self._router.resolve(params)
        if request_generation == self._generation:
            self._record_activity(thread_id)
        state = self._threads.get(thread_id)
        agent_route = None if state is not None else self._router.agent(thread_id)
        if agent_route is not None:
            state = self._threads.get(agent_route.owner_thread_id)
            if state is not None:
                thread_id = agent_route.owner_thread_id
        if state is None:
            await self._reject_server_request(
                request_id,
                RPC_INVALID_PARAMS,
                "unroutable App Server request",
                reason="unroutable_request",
                method=method,
                params=params,
                generation=request_generation,
            )
            return
        state.turn.execution_observed = True
        turn_id = str(params.get("turnId") or "")
        item_id = str(params.get("itemId") or "")
        if method == "item/tool/call":
            call_id = str(params.get("callId") or "")
            if not call_id:
                await self._reject_server_request(
                    request_id,
                    RPC_INVALID_PARAMS,
                    "dynamic tool request is missing callId",
                    reason="malformed_request",
                    method=method,
                    params=params,
                    generation=request_generation,
                )
                return
            public_id = uuid.uuid4().hex
            pending = _PendingRequest(
                request_id,
                method,
                thread_id,
                turn_id,
                call_id,
                dict(params),
                request_generation,
            )
            self._pending_tools[public_id] = pending
            self._request_routes[str(request_id)] = ("tool", public_id)
            self._router.bind_item(call_id, thread_id)
            state.turn.callback_context(turn_id, call_id)
            await self._emitter.emit(
                state,
                CodexSessionEventKind.DYNAMIC_TOOL_REQUESTED,
                turn_id=turn_id,
                item_id=call_id,
                payload={
                    "request_id": public_id,
                    "call_id": call_id,
                    "namespace": str(params.get("namespace") or ""),
                    "tool": str(params.get("tool") or ""),
                    "arguments": params.get("arguments"),
                },
            )
            return
        supported = {
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
            "item/tool/requestUserInput",
            "mcpServer/elicitation/request",
        }
        if method not in supported:
            await self._reject_server_request(
                request_id,
                RPC_METHOD_NOT_FOUND,
                f"unsupported App Server request: {method}",
                reason="unsupported_request",
                method=method,
                params=params,
                generation=request_generation,
            )
            return
        public_id = uuid.uuid4().hex
        pending = _PendingRequest(
            request_id,
            method,
            thread_id,
            turn_id,
            item_id,
            dict(params),
            request_generation,
        )
        self._pending_hil[public_id] = pending
        self._request_routes[str(request_id)] = ("hil", public_id)
        payload = hil_payload(
            public_id,
            method,
            params,
            state.turn.callback_context(turn_id, item_id),
        )
        if agent_route is not None:
            payload = {
                **payload,
                "agent_thread_id": str(params.get("threadId") or ""),
                "agent_path": agent_route.agent_path,
            }
        await self._emitter.emit(
            state,
            CodexSessionEventKind.HIL_REQUESTED,
            turn_id=turn_id,
            item_id=item_id,
            payload=payload,
        )

    async def _server_request_resolved(self, params: Mapping[str, Any]) -> None:
        route = self._request_routes.pop(str(params.get("requestId")), None)
        if route is None:
            return
        kind, public_id = route
        pending = (
            self._pending_hil.pop(public_id, None)
            if kind == "hil"
            else self._pending_tools.pop(public_id, None)
        )
        if pending is None:
            return
        state = self._threads.get(pending.thread_id)
        if state is not None:
            await self._emitter.emit(
                state,
                CodexSessionEventKind.HIL_STALE,
                turn_id=pending.turn_id,
                item_id=pending.item_id,
                payload={"request_id": public_id, "reason": "server_resolved"},
            )

    async def _stale_requests(self, thread_id: str, turn_id: str, reason: str) -> None:
        pending_rows: list[tuple[str, _PendingRequest]] = []
        for collection in (self._pending_hil, self._pending_tools):
            for public_id, pending in tuple(collection.items()):
                if pending.thread_id != thread_id or (turn_id and pending.turn_id != turn_id):
                    continue
                collection.pop(public_id, None)
                self._request_routes.pop(str(pending.rpc_id), None)
                pending_rows.append((public_id, pending))
        state = self._threads.get(thread_id)
        if state is None:
            return
        for public_id, pending in pending_rows:
            await self._emitter.emit(
                state,
                CodexSessionEventKind.HIL_STALE,
                turn_id=pending.turn_id,
                item_id=pending.item_id,
                payload={"request_id": public_id, "reason": reason},
            )

    def attachment(self, thread_id: str) -> ThreadAttachment:
        state = self._threads.get(thread_id)
        if state is None:
            raise AppServerError(f"Codex thread is not attached: {thread_id}")
        return state

    def _attachment_incident(
        self,
        state: ThreadAttachment,
        generation: int,
        *,
        safe_error: str,
    ) -> RuntimeIncident:
        existing = state.attachment_incident
        if (
            existing is not None
            and existing.process_generation == generation
            and existing.state in {RuntimeIncidentState.DETECTED, RuntimeIncidentState.RETRYING}
        ):
            incident = replace(existing, safe_error=safe_error)
            state.attachment_incident = incident
            return incident
        incident = RuntimeIncident(
            incident_id=uuid.uuid4().hex,
            scope=RuntimeIncidentScope.THREAD,
            state=RuntimeIncidentState.DETECTED,
            kind=RuntimeIncidentKind.TRANSPORT_LOST,
            strategy=RuntimeRecoveryStrategy.AUTO_RESUME,
            retryability=RuntimeRetryability.IN_PROGRESS,
            safe_error=safe_error,
            process_generation=generation,
            vendor_thread_id=state.thread_id,
        )
        state.last_incident_id = incident.incident_id
        state.attachment_incident = incident
        return incident

    async def _emit_unknown_write_incident(
        self,
        state: ThreadAttachment,
        *,
        method: str,
        turn_id: str,
        item_id: str,
        error: AppServerError,
    ) -> None:
        await self._emitter.incident(
            state,
            RuntimeIncident(
                incident_id=uuid.uuid4().hex,
                scope=RuntimeIncidentScope.TURN,
                state=RuntimeIncidentState.FAILED,
                kind=RuntimeIncidentKind.TRANSPORT_LOST,
                strategy=RuntimeRecoveryStrategy.MANUAL_RETRY,
                retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                safe_error=error.safe_error,
                process_generation=error.generation,
                vendor_thread_id=state.thread_id,
                vendor_turn_id=turn_id,
                rpc_method=method,
                rpc_latency_ms=error.rpc_latency_ms,
                ambiguous_commit=True,
            ),
            turn_id=turn_id,
            item_id=item_id,
        )

    async def _handle_process_exit(
        self,
        *,
        proc: asyncio.subprocess.Process | None = None,
        generation: int | None = None,
    ) -> None:
        exit_generation = self._generation if generation is None else generation
        if self._closed or self.state == CodexProcessState.CLOSING:
            return
        if exit_generation != self._generation:
            self._diagnostics.append("stale_generation_exit")
            return
        if proc is not None and proc is not self._proc:
            self._diagnostics.append("stale_process_exit")
            return
        self._sandbox.disconnected(exit_generation)
        process_exit_code = proc.returncode if proc is not None else None
        self.state = CodexProcessState.CRASHED
        self._rpc_writer.detach(exit_generation)
        self._watcher.reset()
        error = AppServerError(
            "Codex App Server connection closed",
            safe_error="agent_runtime_exit",
            generation=exit_generation,
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        self._rpc_requests.fail(error, generation=exit_generation)
        for state in self._threads.values():
            confirmation = state.permission_confirmation
            if confirmation is not None and not confirmation.done():
                confirmation.set_exception(error)
        incident = RuntimeIncident(
            incident_id=uuid.uuid4().hex,
            scope=RuntimeIncidentScope.PROCESS,
            state=RuntimeIncidentState.DETECTED,
            kind=RuntimeIncidentKind.PROCESS_EXIT,
            strategy=RuntimeRecoveryStrategy.AUTO_RESTART,
            retryability=RuntimeRetryability.IN_PROGRESS,
            safe_error="agent_runtime_exit",
            process_generation=exit_generation,
            max_attempts=self.max_recovery_attempts,
            process_exit_code=process_exit_code,
        )
        threads = tuple(
            state
            for state in self._threads.values()
            if state.attachment_state != CodexThreadAttachmentState.CLOSED
        )
        for state in threads:
            if state.attachment_state is CodexThreadAttachmentState.ATTACHED:
                state.disconnected_generation = exit_generation
            state.attachment_state = CodexThreadAttachmentState.RECOVERY_PENDING
            state.attached_generation = 0
            state.last_incident_id = incident.incident_id
        projection_error = None
        try:
            for state in threads:
                try:
                    try:
                        if state.mcp_invalidate is not None:
                            state.mcp_invalidate()
                    finally:
                        await state.turn.connection_lost(incident, exit_generation)
                except Exception as error:
                    LOGGER.exception("codex_thread_disconnect_projection_failed")
                    projection_error = projection_error or error
            if projection_error is not None:
                raise projection_error
        finally:
            await self._complete_process_exit(incident, proc, exit_generation)

    async def _complete_process_exit(
        self,
        incident: RuntimeIncident,
        proc: asyncio.subprocess.Process | None,
        exit_generation: int,
    ) -> None:
        process_exit_code = incident.process_exit_code
        if proc is not None:
            # Keep ownership after stdout EOF. Recovery must not overlap a surviving process.
            process_exit_code = await proc.wait()
            if self._closed or exit_generation != self._generation or proc is not self._proc:
                return
            await self._discard_process(proc, exit_generation)
            if self._closed or exit_generation != self._generation:
                return
            incident = replace(incident, process_exit_code=process_exit_code)
        self._record_process_event(
            RuntimeProcessEventKind.EXITED,
            generation=exit_generation,
            incident_id=incident.incident_id,
            process_exit_code=process_exit_code,
        )
        if self._has_recoverable_threads:
            self.state = CodexProcessState.RECOVERY_PENDING
            self._record_process_event(
                RuntimeProcessEventKind.RECOVERY_PENDING,
                generation=exit_generation,
                incident_id=incident.incident_id,
                process_exit_code=process_exit_code,
            )
            self._schedule_recovery(incident)

    def _schedule_recovery(self, incident: RuntimeIncident) -> None:
        if self._closed or not self._has_recoverable_threads or self.admission.failed:
            return
        task = self._recovery_task
        if task is not None and not task.done():
            return
        self._recovery_task = asyncio.create_task(self._recover_process(incident))

    @property
    def _has_recoverable_threads(self) -> bool:
        return bool(self._threads) or any(
            opening.thread_id and opening.remaining_attempts for opening in self._opening_threads
        )

    async def _recover_process(self, incident: RuntimeIncident) -> None:
        current = asyncio.current_task()
        deadline = asyncio.get_running_loop().time() + self.recovery_total_timeout
        startup_failure: AppServerError | None = None
        try:
            for attempt in range(1, self.max_recovery_attempts + 1):
                remaining = deadline - asyncio.get_running_loop().time()
                if self._closed or not self._has_recoverable_threads or self.admission.failed:
                    return
                if remaining <= 0:
                    break
                self._recovery_attempt = attempt
                if self.state != CodexProcessState.CRASHED:
                    self.state = (
                        CodexProcessState.RECOVERING
                        if self._proc is not None and self._proc.returncode is None
                        else CodexProcessState.BACKOFF
                    )
                retrying = replace(
                    incident,
                    state=RuntimeIncidentState.RETRYING,
                    attempt=attempt,
                )
                for thread_state in tuple(self._threads.values()):
                    await self._emitter.incident(thread_state, retrying)
                delay = min(
                    self.recovery_initial_delay
                    * (CODEX_RECOVERY_BACKOFF_MULTIPLIER ** (attempt - 1)),
                    self.recovery_max_delay,
                )
                if delay:
                    jitter = delay * self.recovery_jitter_ratio
                    bounded_delay = min(
                        max(0.0, delay + random.uniform(-jitter, jitter)),
                        remaining,
                    )
                    await asyncio.sleep(bounded_delay)
                remaining = deadline - asyncio.get_running_loop().time()
                if (
                    self._closed
                    or not self._has_recoverable_threads
                    or self.admission.failed
                    or remaining <= 0
                ):
                    break
                try:
                    async with asyncio.timeout(remaining):
                        async with self._start_lock:
                            if self._closed:
                                return
                            if (
                                self.state == CodexProcessState.CRASHED
                                and self._reader_task is not None
                            ):
                                await asyncio.shield(
                                    asyncio.gather(self._reader_task, return_exceptions=True)
                                )
                            if self._proc is None or self._proc.returncode is not None:
                                await self._start_process()
                        generation = self._generation
                        round_process = self._proc
                        self.state = CodexProcessState.RECOVERING
                        restored = await self._resume_registered_threads(generation, retrying)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning(
                        "Codex App Server recovery attempt failed",
                        extra={"attempt": attempt},
                    )
                    startup_error = exc if isinstance(exc, AppServerError) else None
                    if startup_error is None and isinstance(exc, TimeoutError):
                        cancellation = exc.__cause__
                        startup_cause = (
                            cancellation.__cause__
                            if isinstance(cancellation, asyncio.CancelledError)
                            else None
                        )
                        if isinstance(startup_cause, AppServerError):
                            if startup_cause.safe_error in SANDBOX_STARTUP_ERRORS:
                                startup_error = startup_cause
                    if (
                        startup_error is not None
                        and startup_error.safe_error in SANDBOX_STARTUP_ERRORS
                    ):
                        startup_failure = startup_error
                    cleanup_failed = False
                    proc = self._proc
                    if proc is not None and proc.returncode is not None:
                        self.state = CodexProcessState.CRASHED
                        self._unconfirm_attachment(self._generation)
                        try:
                            await self._discard_process(proc, self._generation)
                        except Exception:
                            cleanup_failed = True
                            LOGGER.exception("codex_recovery_cleanup_failed")
                    if (
                        cleanup_failed
                        or (self.state == CodexProcessState.CRASHED and self._proc is not None)
                        or (
                            startup_error is not None
                            and (
                                startup_error.retryability == RuntimeRetryability.TERMINAL
                                or startup_error.safe_error in SANDBOX_STARTUP_ERRORS
                            )
                        )
                    ):
                        break
                    continue
                if (
                    not restored
                    or round_process is None
                    or self._proc is not round_process
                    or generation != self._generation
                    or round_process.returncode is not None
                    or self.state == CodexProcessState.CRASHED
                    or self._closed
                ):
                    continue
                self.state = CodexProcessState.READY
                self._record_process_event(
                    RuntimeProcessEventKind.RECOVERED,
                    generation=generation,
                    incident_id=incident.incident_id,
                )
                recovered = replace(
                    incident,
                    state=RuntimeIncidentState.RECOVERED,
                    retryability=RuntimeRetryability.TERMINAL,
                    process_generation=generation,
                    attempt=attempt,
                )
                for thread_state in tuple(self._threads.values()):
                    if (
                        thread_state.attachment_state == CodexThreadAttachmentState.ATTACHED
                        and thread_state.attached_generation == generation
                    ):
                        await self._emitter.incident(thread_state, recovered)
                if (
                    self._proc is not round_process
                    or generation != self._generation
                    or round_process.returncode is not None
                    or self.state == CodexProcessState.CRASHED
                ):
                    continue
                self._recovery_attempt = 0
                return
            if (
                self._proc is not None
                and self._proc.returncode is None
                and self.state != CodexProcessState.CRASHED
            ):
                self.state = CodexProcessState.READY
                self._record_process_event(
                    RuntimeProcessEventKind.RECOVERED,
                    generation=self._generation,
                    incident_id=incident.incident_id,
                )
                for thread_state in tuple(self._threads.values()):
                    if thread_state.attachment_state == CodexThreadAttachmentState.CLOSED:
                        continue
                    if (
                        thread_state.attachment_state == CodexThreadAttachmentState.ATTACHED
                        and thread_state.attached_generation == self._generation
                    ):
                        await self._emitter.incident(
                            thread_state,
                            replace(
                                incident,
                                state=RuntimeIncidentState.RECOVERED,
                                process_generation=self._generation,
                                attempt=self._recovery_attempt,
                                retryability=RuntimeRetryability.TERMINAL,
                            ),
                        )
                        continue
                    failure = thread_state.attachment_incident
                    if failure is not None and failure.state == RuntimeIncidentState.FAILED:
                        continue
                    failure = replace(
                        failure or incident,
                        incident_id=failure.incident_id if failure else uuid.uuid4().hex,
                        scope=RuntimeIncidentScope.THREAD,
                        kind=RuntimeIncidentKind.RESUME_FAILED,
                        state=RuntimeIncidentState.FAILED,
                        strategy=RuntimeRecoveryStrategy.MANUAL_RETRY,
                        retryability=RuntimeRetryability.USER_RETRYABLE,
                        vendor_thread_id=thread_state.thread_id,
                        process_generation=self._generation,
                        attempt=self._recovery_attempt,
                    )
                    thread_state.attachment_state = CodexThreadAttachmentState.BROKEN
                    thread_state.attachment_incident = failure
                    await self._emitter.incident(thread_state, failure)
                if (
                    self._proc is not None
                    and self._proc.returncode is None
                    and self.state != CodexProcessState.CRASHED
                ):
                    self._recovery_attempt = 0
                    return
            self.state = CodexProcessState.UNAVAILABLE
            self._record_process_event(
                RuntimeProcessEventKind.UNAVAILABLE,
                incident_id=incident.incident_id,
            )
            failed = replace(
                incident,
                state=RuntimeIncidentState.FAILED,
                strategy=RuntimeRecoveryStrategy.MANUAL_RETRY,
                retryability=(
                    startup_failure.retryability
                    if startup_failure is not None
                    else RuntimeRetryability.USER_RETRYABLE
                ),
                safe_error=(
                    startup_failure.safe_error
                    if startup_failure is not None
                    else incident.safe_error
                ),
                process_generation=self._generation,
                attempt=self._recovery_attempt,
                rpc_method=(
                    (startup_failure.method or incident.rpc_method)
                    if startup_failure is not None
                    else incident.rpc_method
                ),
                rpc_code=(
                    startup_failure.rpc_code
                    if startup_failure is not None and startup_failure.rpc_code is not None
                    else incident.rpc_code
                ),
                rpc_latency_ms=(
                    startup_failure.rpc_latency_ms
                    if startup_failure is not None
                    and (startup_failure.method or startup_failure.rpc_code is not None)
                    else incident.rpc_latency_ms
                ),
                ambiguous_commit=incident.ambiguous_commit
                or (
                    startup_failure is not None
                    and startup_failure.retryability == RuntimeRetryability.UNKNOWN_OUTCOME
                ),
            )
            for thread_state in tuple(self._threads.values()):
                await self._emitter.incident(thread_state, failed)
        finally:
            if self._recovery_task is current:
                self._recovery_task = None

    async def _discard_process(self, proc: asyncio.subprocess.Process, generation: int) -> None:
        async with observe_shutdown("discard", proc.pid, generation) as observation:
            await self._discard_observed_process(proc, generation, observation)

    async def _discard_observed_process(
        self,
        proc: asyncio.subprocess.Process,
        generation: int,
        observation: ShutdownObservation,
    ) -> None:
        if proc is not self._proc or generation != self._generation:
            self._diagnostics.append("stale_process_discard")
            return
        observation.process = proc
        self._sandbox.disconnected(generation)
        reader_task = self._reader_task
        stderr_task = self._stderr_task
        self._rpc_writer.detach(generation)
        with observation.phase("stdin_close"):
            if proc.stdin is not None and not proc.stdin.is_closing():
                proc.stdin.close()
        try:
            with observation.phase("process_wait"):
                await asyncio.wait_for(proc.wait(), timeout=AGENT_RUNTIME_STOP_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            observation.emit("process_wait_timeout", returncode=proc.returncode)
            with observation.phase("process_kill_and_wait"):
                if proc.returncode is None:
                    proc.kill()
                await proc.wait()
        observation.emit("process_exited", returncode=proc.returncode)
        self._rpc_requests.retire(generation)
        if proc is self._proc and generation == self._generation:
            self._proc = None
            self._reader_task = None
            self._stderr_task = None
        current = asyncio.current_task()
        tasks = tuple(
            task
            for task in (reader_task, stderr_task)
            if task is not None and task is not current and not task.done()
        )
        for task in tasks:
            task.cancel()
        if tasks:
            with observation.phase("reader_task_join"):
                await asyncio.gather(*tasks, return_exceptions=True)
        self._exited_generations.append(generation)
        self._unconfirmed_attachment_generations.discard(generation)

    async def aclose(self) -> None:
        async with observe_shutdown(
            "host_close", self._proc.pid if self._proc else None, self._generation
        ) as observation:
            with observation.phase("host_close"):
                await self._close_observed_host(observation)

    async def _close_observed_host(self, observation: ShutdownObservation) -> None:
        self._closed = True
        self.admission.close()
        self.state = CodexProcessState.CLOSING
        recovery_task = self._recovery_task
        if (
            recovery_task is not None
            and recovery_task is not asyncio.current_task()
            and not recovery_task.done()
        ):
            recovery_task.cancel()
            with observation.phase("recovery_task_join"):
                await asyncio.gather(recovery_task, return_exceptions=True)
        self._recovery_task = None
        with observation.phase("stale_requests"):
            for thread_id in tuple(self._threads):
                await self._stale_requests(thread_id, "", "process_closed")
        proc = self._proc
        if proc is not None:
            await self._discard_process(proc, self._generation)
        current = asyncio.current_task()
        tasks = tuple(
            task
            for task in (self._reader_task, self._stderr_task)
            if task is not None and task is not current and not task.done()
        )
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        closed_error = AppServerError(
            "Codex App Server host closed",
            safe_error="agent_runtime_closed",
            retryability=RuntimeRetryability.TERMINAL,
        )
        self._rpc_requests.close(closed_error)
        self._reader_task = None
        self._stderr_task = None
        self.state = CodexProcessState.STOPPED
        self._record_process_event(RuntimeProcessEventKind.STOPPED)
