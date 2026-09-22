"""Product runtime process ownership."""

from __future__ import annotations

import asyncio
import os
import random
import shutil
import uuid
from collections import deque
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from scholarseed_codex.activity import NativeActivity, subagent_lifecycle_payload
from scholarseed_codex.attachment import ThreadAttachment
from scholarseed_codex.emitter import CodexEmitter
from scholarseed_codex.executable import _resolve_launch_arguments
from scholarseed_codex.history import (
    history_entries,
    resume_turn_snapshots,
    terminal_turn_status,
)
from scholarseed_codex.interaction import hil_payload, hil_response
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
    CODEX_MAX_THREADS_PER_HOST,
    CODEX_MULTI_AGENT_MODES,
    CODEX_RECOVERY_BACKOFF_MULTIPLIER,
    CODEX_RECOVERY_INITIAL_DELAY_SECONDS,
    CODEX_RECOVERY_JITTER_RATIO,
    CODEX_RECOVERY_MAX_DELAY_SECONDS,
    CODEX_RECOVERY_TOTAL_TIMEOUT_SECONDS,
    CODEX_RPC_TIMEOUT_SECONDS,
    CODEX_RUNTIME_ID,
    CODEX_SKILLS_EXTRA_ROOTS_SET_METHOD,
    CODEX_STDERR_DIAGNOSTIC_CHANNEL,
    CODEX_STREAM_LIMIT_BYTES,
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
    _redacted_diagnostic,
    logger,
    normalized_roots,
)
from scholarseed_codex.router import AgentRoute, ThreadRouter
from scholarseed_codex.rpc import JsonLineWriter, PendingRequests, read_messages
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
from scholarseed_runtime.contract.session import RUNTIME_SUSPEND_BUSY, RUNTIME_SUSPEND_STALE

NATIVE_PROCESS_NOT_READY = "native_process_not_ready"
NATIVE_COMMAND_UNSETTLED = "native_command_unsettled"
NATIVE_CALLBACK_PENDING = "native_callback_pending"
THREAD_UNSUBSCRIBE_METHOD = "thread/unsubscribe"
THREAD_ID_KEY = "threadId"
UNSUBSCRIBE_STATUS_KEY = "status"
THREAD_UNSUBSCRIBE_STATUSES = frozenset({"unsubscribed", "notSubscribed", "notLoaded"})


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
        remove_environment: tuple[str, ...] = (),
        launch_arguments: tuple[CodexRuntimeLaunchArgument, ...] = (),
        rpc_timeout: float = CODEX_RPC_TIMEOUT_SECONDS,
        max_threads: int = CODEX_MAX_THREADS_PER_HOST,
        max_recovery_attempts: int = CODEX_MAX_RECOVERY_ATTEMPTS,
        recovery_initial_delay: float = CODEX_RECOVERY_INITIAL_DELAY_SECONDS,
        recovery_max_delay: float = CODEX_RECOVERY_MAX_DELAY_SECONDS,
        recovery_jitter_ratio: float = CODEX_RECOVERY_JITTER_RATIO,
        recovery_total_timeout: float = CODEX_RECOVERY_TOTAL_TIMEOUT_SECONDS,
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
        self.remove_environment = tuple(sorted(set(remove_environment)))
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
        self._activity_revision = 0
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
        self._skill_lock = asyncio.Lock()
        self._emitter = CodexEmitter()
        self._evidence_seq = 0
        self._started_evidence_seq = 0
        self._rpc_requests = PendingRequests()
        self._threads: dict[str, ThreadAttachment] = {}
        self._known_roots: set[str] = set()
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
        self._skill_roots: set[str] = set()

    @property
    def known_roots(self) -> tuple[str, ...]:
        return tuple(sorted(self._known_roots))

    @property
    def activity_revision(self) -> int:
        return self._activity_revision

    @property
    def stop_committed(self) -> bool:
        return self._stop_committed

    def retain_loaded_roots(self, loaded: tuple[str, ...]) -> None:
        self._known_roots.intersection_update(set(loaded) | self._threads.keys())

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
        if self._pending_hil or self._pending_tools:
            blockers.append(NATIVE_CALLBACK_PENDING)
        return tuple(blockers)

    async def suspend_thread(self, thread_id: str, expected_generation: int) -> None:
        if expected_generation != self._generation:
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        if self.suspend_blockers(thread_id):
            raise AppServerError(RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY)
        state = self.attachment(thread_id)
        result = await self.request(THREAD_UNSUBSCRIBE_METHOD, {THREAD_ID_KEY: thread_id})
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
        if expected_generation != self._generation:
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        if self._threads or self._pending_hil or self._pending_tools:
            raise AppServerError(RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY)
        if self._known_roots:
            activity_revision = self._activity_revision
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
        proc = self._proc
        if proc is not None:
            if proc.stdin is not None and not proc.stdin.is_closing():
                proc.stdin.close()
            await proc.wait()
            # Process.wait is the ownership boundary; do not detach the reader earlier.
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
            authenticated=True if ready else None,
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
        if self._proc is not None:
            # Transport EOF does not prove that the owned OS process has exited.
            raise AppServerError(
                "Codex App Server process exit is still pending",
                safe_error="agent_runtime_unavailable",
                generation=self._generation,
                retryability=RuntimeRetryability.IN_PROGRESS,
            )
        self._generation += 1
        self._stop_committed = False
        generation = self._generation
        self.state = CodexProcessState.STARTING
        self._record_process_event(RuntimeProcessEventKind.STARTING)
        child_environment = None
        if self.process_environment or self.remove_environment:
            child_environment = os.environ.copy()
            for name in self.remove_environment:
                child_environment.pop(name, None)
            child_environment.update(self.process_environment)
        arguments = ["app-server", "--listen", CODEX_APP_SERVER_LISTEN]
        arguments.extend(
            _resolve_launch_arguments(
                self.launch_arguments, self.process_environment, self.remove_environment
            )
        )
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
        except BaseException:
            await self._discard_process(proc, generation)
            if self.state != CodexProcessState.CLOSING:
                self.state = CodexProcessState.CRASHED
                self._record_process_event(
                    RuntimeProcessEventKind.EXITED,
                    generation=generation,
                )
            raise

    async def request(self, method: str, params: Any) -> dict[str, Any]:
        await self.start()
        return await self._request_connected(method, params)

    async def _request_connected(
        self,
        method: str,
        params: Any,
        *,
        generation: int | None = None,
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
        request_id, pending = self._rpc_requests.begin(request_generation, method)
        future = pending.future
        try:
            await self._rpc_writer.write(
                {"id": request_id, "method": method, "params": params},
                generation=request_generation,
            )
            pending.written = True
            result = await asyncio.wait_for(asyncio.shield(future), timeout=self.rpc_timeout)
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
        await self.start()
        generation = self._generation
        if len(self._threads) >= self.max_threads:
            raise AppServerError(f"Codex App Server thread capacity reached: {self.max_threads}")
        await self.ensure_skill_roots(request.skill_roots)
        resumed = bool(request.resume_session_id)
        params = self._thread_params(request, include_dynamic_tools=not resumed)
        if resumed:
            params["threadId"] = request.resume_session_id
            result = await self._request_connected("thread/resume", params, generation=generation)
        else:
            params["serviceName"] = request.identity.service_name or CODEX_DEFAULT_SERVICE_NAME
            result = await self._request_connected("thread/start", params, generation=generation)
        thread = dict(result.get("thread") or {})
        thread_id = str(thread.get("id") or request.resume_session_id)
        if not thread_id:
            raise AppServerError("Codex App Server returned no thread id")
        if resumed and thread_id != request.resume_session_id:
            raise AppServerError(
                "Codex App Server resumed a different thread",
                safe_error="codex_thread_identity_mismatch",
                retryability=RuntimeRetryability.TERMINAL,
            )
        if thread_id in self._threads:
            raise AppServerError(f"Codex thread is already attached: {thread_id}")
        history = history_entries(thread)
        resume_turns = resume_turn_snapshots(thread)
        process_reused = bool(self._threads)
        self._registration_epoch += 1
        state = ThreadAttachment(
            request=request,
            listener=listener,
            thread_id=thread_id,
            writable_roots=normalized_roots(request.writable_roots),
            model=str(result.get("model") or request.model),
            history=history,
            attachment_state=CodexThreadAttachmentState.ATTACHED,
            attached_generation=generation,
            registration_epoch=self._registration_epoch,
        )
        state.turn = CodexTurnRuntime(
            state,
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
        await self._watcher.open(state.turn, generation)
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
        return thread_id, state.model, history

    async def fork_thread(
        self,
        source_thread_id: str,
        request: CodexSessionOpenRequest,
        *,
        portable_history: tuple[HistoryEntry, ...] | None = None,
    ) -> str:
        """Clone an idle thread without carrying provider-private response ids."""

        await self.ensure_attached(source_thread_id)
        state = self.attachment(source_thread_id)
        if state.turn.active_turn_id:
            raise AppServerError(
                "Codex cannot fork a thread while its turn is active",
                safe_error="codex_thread_running",
                retryability=RuntimeRetryability.USER_RETRYABLE,
            )
        params = self._thread_params(request, include_dynamic_tools=False)
        if portable_history is None:
            params["threadId"] = source_thread_id
            result = await self.request("thread/fork", params)
        else:
            params["serviceName"] = request.identity.service_name or CODEX_DEFAULT_SERVICE_NAME
            result = await self.request("thread/start", params)
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

    def thread_writable_roots(self, thread_id: str) -> tuple[str, ...]:
        """该 thread 下一个 turn 会下发的额外可写根。"""

        state = self._threads.get(thread_id)
        return () if state is None else state.writable_roots

    async def ensure_skill_roots(self, roots: tuple[Path, ...]) -> None:
        normalized = {str(path.expanduser().resolve()) for path in roots if str(path).strip()}
        if not normalized:
            return
        async with self._skill_lock:
            merged = self._skill_roots | normalized
            if merged == self._skill_roots:
                return
            await self._set_skill_roots(merged)
            self._skill_roots = merged

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
    ) -> None:
        semaphore = asyncio.Semaphore(CODEX_MAX_CONCURRENT_THREAD_RESUMES)

        async def resume(state: ThreadAttachment, process_reused: bool) -> None:
            async with semaphore:
                await self._resume_thread(
                    state,
                    generation,
                    process_incident,
                    process_reused=process_reused,
                )

        await asyncio.gather(
            *(
                resume(state, process_reused=index > 0)
                for index, state in enumerate(tuple(self._threads.values()))
            )
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
            if self._threads.get(state.thread_id) is not state:
                return False
            if (
                state.attachment_state == CodexThreadAttachmentState.ATTACHED
                and state.attached_generation == generation
            ):
                return True
            epoch = state.registration_epoch
            state.attachment_state = CodexThreadAttachmentState.RESUMING
            attachment_incident = state.attachment_incident
            if attachment_incident is not None:
                await self._emitter.incident(
                    state,
                    replace(
                        attachment_incident,
                        state=RuntimeIncidentState.RETRYING,
                        attempt=1,
                    ),
                )
            params = self._thread_params(state.request, include_dynamic_tools=False)
            params["threadId"] = state.thread_id
            try:
                result = await self._request_connected(
                    "thread/resume", params, generation=generation
                )
                thread = dict(result.get("thread") or {})
                returned_thread_id = str(thread.get("id") or state.thread_id)
                if returned_thread_id != state.thread_id:
                    raise AppServerError(
                        "Codex App Server resumed a different thread",
                        safe_error="codex_thread_identity_mismatch",
                        retryability=RuntimeRetryability.TERMINAL,
                    )
            except Exception as exc:
                if (
                    self._threads.get(state.thread_id) is state
                    and state.registration_epoch == epoch
                    and state.attachment_state != CodexThreadAttachmentState.CLOSED
                ):
                    state.attachment_state = CodexThreadAttachmentState.BROKEN
                    state.attached_generation = 0
                    state.last_resume_failure = type(exc).__name__
                    incident = (
                        replace(
                            attachment_incident,
                            state=RuntimeIncidentState.FAILED,
                            kind=RuntimeIncidentKind.RESUME_FAILED,
                            strategy=RuntimeRecoveryStrategy.MANUAL_RETRY,
                            retryability=RuntimeRetryability.USER_RETRYABLE,
                            safe_error="thread_resume_failed",
                            process_generation=generation,
                            attempt=max(1, self._recovery_attempt),
                            max_attempts=max(1, self.max_recovery_attempts),
                        )
                        if attachment_incident is not None
                        else RuntimeIncident(
                            incident_id=uuid.uuid4().hex,
                            scope=RuntimeIncidentScope.THREAD,
                            state=RuntimeIncidentState.FAILED,
                            kind=RuntimeIncidentKind.RESUME_FAILED,
                            strategy=RuntimeRecoveryStrategy.MANUAL_RETRY,
                            retryability=RuntimeRetryability.USER_RETRYABLE,
                            safe_error="thread_resume_failed",
                            process_generation=generation,
                            attempt=max(1, self._recovery_attempt),
                            max_attempts=max(1, self.max_recovery_attempts),
                            vendor_thread_id=state.thread_id,
                        )
                    )
                    state.last_incident_id = incident.incident_id
                    state.attachment_incident = incident
                    await self._emitter.incident(state, incident)
                return False
            if (
                self._threads.get(state.thread_id) is not state
                or state.registration_epoch != epoch
                or state.attachment_state == CodexThreadAttachmentState.CLOSED
            ):
                return False
            state.model = str(result.get("model") or state.model)
            state.attachment_state = CodexThreadAttachmentState.ATTACHED
            state.attached_generation = generation
            state.last_resume_failure = ""
            await self._watcher.open(state.turn, generation)
            try:
                await state.turn.reconcile(thread, generation)
            except Exception as exc:
                state.attachment_state = CodexThreadAttachmentState.BROKEN
                state.attached_generation = 0
                state.last_resume_failure = type(exc).__name__
                safe_error = (
                    exc.safe_error
                    if isinstance(exc, AppServerError)
                    else "thread_resume_reconciliation_failed"
                )
                incident = (
                    replace(
                        attachment_incident,
                        state=RuntimeIncidentState.FAILED,
                        kind=RuntimeIncidentKind.RESUME_FAILED,
                        strategy=RuntimeRecoveryStrategy.MANUAL_RETRY,
                        retryability=RuntimeRetryability.USER_RETRYABLE,
                        safe_error=safe_error,
                        process_generation=generation,
                    )
                    if attachment_incident is not None
                    else RuntimeIncident(
                        incident_id=uuid.uuid4().hex,
                        scope=RuntimeIncidentScope.THREAD,
                        state=RuntimeIncidentState.FAILED,
                        kind=RuntimeIncidentKind.RESUME_FAILED,
                        strategy=RuntimeRecoveryStrategy.MANUAL_RETRY,
                        retryability=RuntimeRetryability.USER_RETRYABLE,
                        safe_error=safe_error,
                        process_generation=generation,
                        vendor_thread_id=state.thread_id,
                    )
                )
                state.attachment_incident = incident
                state.last_incident_id = incident.incident_id
                await self._emitter.incident(state, incident)
                return False
            if (
                self._threads.get(state.thread_id) is not state
                or state.registration_epoch != epoch
                or state.attachment_state == CodexThreadAttachmentState.CLOSED
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
        await self.start()
        generation = self._generation
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

    async def close_thread(self, thread_id: str) -> None:
        state = self._threads.get(thread_id)
        if state is None:
            return
        await self._watcher.close(
            state.turn, self._generation, self.state == CodexProcessState.READY
        )
        self._registration_epoch += 1
        state.registration_epoch = self._registration_epoch
        state.attachment_state = CodexThreadAttachmentState.CLOSED
        await state.turn.close(self._generation, self.state == CodexProcessState.READY)
        self._threads.pop(thread_id, None)
        self._router.close(thread_id)
        # Release the event subscription for durable threads too. This preserves
        # the rollout; configuration isolation is owned by the host pool.
        if self.state == CodexProcessState.READY:
            await self.request("thread/unsubscribe", {"threadId": thread_id})
        recovery_task = self._recovery_task
        if (
            not self._threads
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

    def set_mcp_handler(self, thread_id: str, handler: McpNotificationHandler) -> None:
        self.attachment(thread_id).mcp_handler = handler

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
        async for raw in proc.stderr:
            if generation != self._generation:
                return
            line = raw.decode("utf-8", errors="replace").rstrip()
            if line:
                diagnostic = _redacted_diagnostic(CODEX_STDERR_DIAGNOSTIC_CHANNEL, line)
                self._stderr_lines.append(diagnostic)
                logger.debug("Codex App Server stderr diagnostic: %s", diagnostic)

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
            self._rpc_requests.resolve(message, message_generation)
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
        self._activity_revision += 1
        if method == "thread/started":
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
        raw_turn = params.get("turn")
        nested_turn = dict(raw_turn) if isinstance(raw_turn, Mapping) else {}
        notification_turn_id = str(params.get("turnId") or nested_turn.get("id") or "")
        thread_id = self._router.resolve(params)
        if not thread_id and notification_turn_id:
            thread_id = self._router.turn_owner(notification_turn_id)
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
                safe_error="codex_thread_closed",
            )
            await self._emitter.incident(state, incident, turn_id=turn_id)
            return
        if method == "thread/settings/updated":
            settings = dict(params.get("threadSettings") or {})
            state.model = str(settings.get("model") or state.model)
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
        if request_generation == self._generation:
            self._activity_revision += 1
        thread_id = self._router.resolve(params)
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
        for state in tuple(self._threads.values()):
            if state.attachment_state == CodexThreadAttachmentState.CLOSED:
                continue
            state.attachment_state = CodexThreadAttachmentState.RECOVERY_PENDING
            state.attached_generation = 0
            state.last_incident_id = incident.incident_id
            await state.turn.connection_lost(incident, exit_generation)
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
        if self._threads:
            self.state = CodexProcessState.RECOVERY_PENDING
            self._record_process_event(
                RuntimeProcessEventKind.RECOVERY_PENDING,
                generation=exit_generation,
                incident_id=incident.incident_id,
                process_exit_code=process_exit_code,
            )
            self._schedule_recovery(incident)

    def _schedule_recovery(self, incident: RuntimeIncident) -> None:
        if self._closed or not self._threads:
            return
        task = self._recovery_task
        if task is not None and not task.done():
            return
        self._recovery_task = asyncio.create_task(self._recover_process(incident))

    async def _recover_process(self, incident: RuntimeIncident) -> None:
        current = asyncio.current_task()
        deadline = asyncio.get_running_loop().time() + self.recovery_total_timeout
        try:
            for attempt in range(1, self.max_recovery_attempts + 1):
                remaining = deadline - asyncio.get_running_loop().time()
                if self._closed or not self._threads:
                    return
                if remaining <= 0:
                    break
                self._recovery_attempt = attempt
                self.state = CodexProcessState.BACKOFF
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
                if self._closed or not self._threads or remaining <= 0:
                    break
                try:
                    async with asyncio.timeout(remaining):
                        async with self._start_lock:
                            if self._closed:
                                return
                            await self._start_process()
                        generation = self._generation
                        self.state = CodexProcessState.RECOVERING
                        await self._resume_registered_threads(generation, incident)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning(
                        "Codex App Server recovery attempt failed",
                        extra={"attempt": attempt},
                    )
                    proc = self._proc
                    if proc is not None:
                        await self._discard_process(proc, self._generation)
                    if (
                        isinstance(exc, AppServerError)
                        # 左侧 isinstance 已收窄到 AppServerError; pylint 在 `and` 短路里
                        # 不做收窄, 故误报没有该成员 (mypy 对同一行无异议)。
                        and exc.retryability  # pylint: disable=no-member
                        == RuntimeRetryability.TERMINAL
                    ):
                        break
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
                    await self._emitter.incident(thread_state, recovered)
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
                retryability=RuntimeRetryability.USER_RETRYABLE,
                process_generation=self._generation,
                attempt=self._recovery_attempt,
            )
            for thread_state in tuple(self._threads.values()):
                await self._emitter.incident(thread_state, failed)
        finally:
            if self._recovery_task is current:
                self._recovery_task = None

    async def _discard_process(
        self,
        proc: asyncio.subprocess.Process,
        generation: int,
    ) -> None:
        if proc is not self._proc or generation != self._generation:
            self._diagnostics.append("stale_process_discard")
            return
        reader_task = self._reader_task
        stderr_task = self._stderr_task
        self._rpc_writer.detach(generation)
        if proc.stdin is not None and not proc.stdin.is_closing():
            proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), timeout=AGENT_RUNTIME_STOP_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()
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
            await asyncio.gather(*tasks, return_exceptions=True)

    async def aclose(self) -> None:
        self._closed = True
        self.state = CodexProcessState.CLOSING
        recovery_task = self._recovery_task
        if (
            recovery_task is not None
            and recovery_task is not asyncio.current_task()
            and not recovery_task.done()
        ):
            recovery_task.cancel()
            await asyncio.gather(recovery_task, return_exceptions=True)
        self._recovery_task = None
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
